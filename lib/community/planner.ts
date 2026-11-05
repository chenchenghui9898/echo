import { ACTIVITY_WEIGHTS, COMMENT_COUNT_BUCKETS, getSchedulerConfig } from "./scheduler-config.ts";
import { COMMUNITY_PERSONAS, type CommunityPersona } from "./personas.ts";

export type RandomSource = () => number;

const TOPIC_KEYWORDS: Record<string, string[]> = {
  文学: ["诗", "小说", "写作", "句子", "意象", "故事", "作品"],
  职场: ["工作", "同事", "公司", "加班", "面试", "领导", "职业"],
  情感: ["喜欢", "爱", "关系", "朋友", "家人", "告别", "想念"],
  生活: ["今天", "吃", "走", "房间", "街", "雨", "风", "日常"],
  科技: ["AI", "人工智能", "技术", "软件", "模型", "互联网", "算法"],
  观点: ["认为", "应该", "问题", "原因", "效率", "选择", "社会"],
  心情: ["难过", "开心", "疲惫", "平静", "焦虑", "情绪", "心情"],
  日记: ["早上", "晚上", "昨天", "后来", "回家", "记得", "那天"],
};

export function inferTopics(content: string, type: string) {
  const topics = new Set<string>([type]);
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    if (keywords.some((keyword) => content.includes(keyword))) topics.add(topic);
  }
  if (topics.size === 1) topics.add("生活");
  return [...topics];
}

export function drawCommentCount(random: RandomSource = Math.random) {
  const roll = random();
  let cursor = 0;
  for (const bucket of COMMENT_COUNT_BUCKETS) {
    cursor += bucket.probability;
    if (roll < cursor) {
      return bucket.min + Math.floor(random() * (bucket.max - bucket.min + 1));
    }
  }
  return 0;
}

function weightedPick<T>(items: Array<{ item: T; weight: number }>, random: RandomSource) {
  const total = items.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = random() * total;
  for (const entry of items) {
    roll -= entry.weight;
    if (roll <= 0) return entry.item;
  }
  return items.at(-1)?.item;
}

export function selectPersonas(input: {
  topics: string[];
  count: number;
  random?: RandomSource;
  personas?: CommunityPersona[];
}) {
  const random = input.random ?? Math.random;
  const available = [...(input.personas ?? COMMUNITY_PERSONAS)];
  const selected: CommunityPersona[] = [];
  while (selected.length < input.count && available.length) {
    const weighted = available.map((persona) => {
      const matches = persona.interests.filter((tag) => input.topics.includes(tag)).length;
      const familiarity = input.topics.reduce(
        (sum, topic) => sum + (persona.topicFamiliarity[topic] ?? 0),
        0,
      );
      return {
        item: persona,
        weight: ACTIVITY_WEIGHTS[persona.activity] * persona.participationWeight * (1 + matches * 0.55 + familiarity * 0.25),
      };
    });
    const picked = weightedPick(weighted, random);
    if (!picked) break;
    selected.push(picked);
    available.splice(available.findIndex((persona) => persona.id === picked.id), 1);
  }
  return selected;
}

function chooseStage(remainingCapacity: Map<string, number>, random: RandomSource) {
  const config = getSchedulerConfig();
  const candidates = config.stages
    .filter((stage) => (remainingCapacity.get(stage.id) ?? 0) > 0)
    .map((stage) => ({ item: stage, weight: stage.weight * (remainingCapacity.get(stage.id) ?? 0) }));
  return weightedPick(candidates, random);
}

export function planSchedule(input: {
  publishedAt: Date;
  count: number;
  random?: RandomSource;
}) {
  const random = input.random ?? Math.random;
  const config = getSchedulerConfig();
  const capacity = new Map(config.stages.map((stage) => [stage.id, stage.suggestedMax]));
  const offsets: number[] = [];
  for (let index = 0; index < input.count; index += 1) {
    const stage = chooseStage(capacity, random);
    if (!stage) break;
    capacity.set(stage.id, (capacity.get(stage.id) ?? 1) - 1);
    const fraction = Math.pow(random(), stage.frontBiasExponent);
    offsets.push(stage.startMs + (stage.endMs - stage.startMs) * fraction);
  }
  offsets.sort((a, b) => a - b);
  for (let index = 1; index < offsets.length; index += 1) {
    const shortGap = random() < config.shortGapProbability;
    const gap = shortGap
      ? 8_000 + random() * 7_000
      : config.minGapMs + random() * Math.max(0, config.maxGapMs - config.minGapMs);
    offsets[index] = Math.max(offsets[index], offsets[index - 1] + gap);
  }
  const maximum = config.maxCycleMs;
  return offsets.map((offset) =>
    new Date(input.publishedAt.getTime() + Math.min(offset, maximum) * config.timeScale).toISOString(),
  );
}

export function createCommentPlan(input: {
  content: string;
  type: string;
  publishedAt: Date;
  analyzedTopics?: string[];
  random?: RandomSource;
}) {
  const random = input.random ?? Math.random;
  const config = getSchedulerConfig();
  const requested = Math.min(drawCommentCount(random), config.maxCommentsPerPost, COMMUNITY_PERSONAS.length);
  const topics = [...new Set([
    ...inferTopics(input.content, input.type),
    ...(input.analyzedTopics ?? []),
  ])];
  const personas = selectPersonas({ topics, count: requested, random });
  const times = planSchedule({ publishedAt: input.publishedAt, count: personas.length, random });
  return personas.map((persona, index) => ({ persona, scheduledAt: times[index] }));
}
