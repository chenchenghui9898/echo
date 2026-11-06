import type { ChatMessage } from "@/lib/ai-lab/types";
import { CHAT_AI_PERSONAS, type ChatAiPersona } from "./ai-personas.ts";
import type { getChatAiConfig } from "./ai-config.ts";

type ChatAiConfig = ReturnType<typeof getChatAiConfig>;
type PersonaActivitySnapshot = Record<string, {
  lastMessageAt?: string;
  hourlyCount: number;
  dailyCount: number;
}>;

const TOPIC_RULES: Array<{ topic: string; words: string[] }> = [
  { topic: "工作", words: ["上班", "下班", "加班", "同事", "老板", "工作", "会议", "通勤"] },
  { topic: "食物", words: ["吃", "饭", "外卖", "冰棍", "咖啡", "奶茶", "做饭", "饿"] },
  { topic: "开心", words: ["开心", "太好了", "成功", "拿到", "通过", "中了", "庆祝"] },
  { topic: "烦躁", words: ["烦", "累", "崩溃", "倒霉", "气死", "吐槽", "无语"] },
  { topic: "科技", words: ["AI", "人工智能", "代码", "软件", "手机", "电脑", "产品"] },
  { topic: "作品", words: ["诗", "小说", "画", "写了", "创作", "电影", "音乐"] },
  { topic: "关系", words: ["朋友", "对象", "家人", "同学", "室友", "吵架", "分手"] },
  { topic: "天气", words: ["下雨", "天气", "风", "太阳", "降温", "热死", "冷"] },
  { topic: "旅行", words: ["旅行", "出发", "高铁", "飞机", "酒店", "爬山", "海边"] },
  { topic: "观点", words: ["我认为", "应该", "不应该", "凭什么", "同意", "反对"] },
];

const ACTIVITY_WEIGHT = { high: 1.35, medium: 1, low: 0.62 } as const;

export function inferChatTopics(content: string) {
  const topics = TOPIC_RULES.filter((rule) => rule.words.some((word) => content.includes(word)))
    .map((rule) => rule.topic);
  return topics.length ? topics : ["生活"];
}

function personaWeight(persona: ChatAiPersona, topics: string[]) {
  const matches = topics.filter((topic) => persona.topics.includes(topic) || persona.interests.includes(topic)).length;
  return ACTIVITY_WEIGHT[persona.activity] * (1 + matches * 0.85);
}

function weightedPick(
  candidates: ChatAiPersona[],
  topics: string[],
  random: () => number,
) {
  const weights = candidates.map((persona) => personaWeight(persona, topics));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = random() * total;
  for (let index = 0; index < candidates.length; index += 1) {
    cursor -= weights[index];
    if (cursor <= 0) return candidates[index];
  }
  return candidates.at(-1)!;
}

function randomDelay(minimum: number, maximum: number, random: () => number) {
  return minimum + (maximum - minimum) * random();
}

function canPersonaParticipate(
  persona: ChatAiPersona,
  activity: PersonaActivitySnapshot | undefined,
  now: Date,
  ignoreMinimumInterval = false,
) {
  const usage = activity?.[persona.id];
  if (!usage) return true;
  if (usage.hourlyCount >= persona.hourlyMessageLimit || usage.dailyCount >= persona.dailyMessageLimit) {
    return false;
  }
  if (!ignoreMinimumInterval && usage.lastMessageAt) {
    return now.getTime() - new Date(usage.lastMessageAt).getTime() >= persona.minimumIntervalMs;
  }
  return true;
}

export type ChatAiPlanItem = {
  persona: ChatAiPersona;
  scheduledAt: string;
  chainDepth: number;
};

export function planChatAiParticipation(input: {
  trigger: ChatMessage;
  parent: ChatMessage | null;
  recentMessages: ChatMessage[];
  config: ChatAiConfig;
  random?: () => number;
  now?: Date;
  chainDepth?: number;
  replyDecisionPassed?: boolean;
  activitySnapshot?: {
    recent10AiCount: number;
    recent30AiShare: number;
    consecutiveAiCount: number;
    lastAiMessageAt?: string;
    personaActivity: PersonaActivitySnapshot;
  };
}): ChatAiPlanItem[] {
  const random = input.random ?? Math.random;
  const now = input.now ?? new Date();
  const enabled = CHAT_AI_PERSONAS.filter((persona) => persona.enabled);
  const parentPersona = input.parent?.senderType === "ai" && input.parent.personaId
    ? enabled.find((persona) => persona.id === input.parent!.personaId)
    : undefined;
  const recent = input.recentMessages.slice(-10);
  const recentAiCount = recent.filter((message) => message.senderType === "ai").length;
  const snapshot = input.activitySnapshot;
  const overRecentLimit = snapshot
    ? snapshot.recent10AiCount >= input.config.maxAiMessagesInRecent10 ||
      snapshot.recent30AiShare >= input.config.maxAiShareInRecent30
    : recentAiCount >= 4;
  const densityFactor = overRecentLimit ? 0.15 : recentAiCount >= 3 ? 0.35 : recentAiCount === 2 ? 0.68 : 1;
  const replyProbability = parentPersona
    ? input.config.directReplyProbability * densityFactor
    : input.config.replyProbability * densityFactor;
  if (!input.replyDecisionPassed && random() >= replyProbability) return [];

  const topics = inferChatTopics(input.trigger.content);
  const candidates = enabled.filter((persona) =>
    canPersonaParticipate(persona, snapshot?.personaActivity, now, Boolean(parentPersona)),
  );
  const firstPersona = parentPersona && candidates.some((persona) => persona.id === parentPersona.id)
    ? parentPersona
    : parentPersona
      ? undefined
      : candidates.length
        ? weightedPick(candidates, topics, random)
        : undefined;
  if (!firstPersona) return [];
  const plan: ChatAiPlanItem[] = [];
  const firstDelay = parentPersona
    ? randomDelay(input.config.directDelayMinMs, input.config.directDelayMaxMs, random)
    : randomDelay(input.config.firstDelayMinMs, input.config.firstDelayMaxMs, random);
  plan.push({
    persona: firstPersona,
    scheduledAt: new Date(now.getTime() + firstDelay * input.config.timeScale).toISOString(),
    chainDepth: input.chainDepth ?? 1,
  });

  if (
    !parentPersona && !overRecentLimit &&
    random() < input.config.secondPersonaProbability && recentAiCount < 2
  ) {
    const remaining = candidates.filter((persona) => persona.id !== firstPersona.id);
    if (!remaining.length) return plan;
    const secondPersona = weightedPick(remaining, topics, random);
    const secondDelay = randomDelay(
      input.config.secondDelayMinMs,
      input.config.secondDelayMaxMs,
      random,
    );
    plan.push({
      persona: secondPersona,
      scheduledAt: new Date(now.getTime() + secondDelay * input.config.timeScale).toISOString(),
      chainDepth: input.chainDepth ?? 1,
    });
  }
  return plan.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

export function planAiToAiFollowUp(input: {
  trigger: ChatMessage;
  recentMessages: ChatMessage[];
  config: ChatAiConfig;
  chainDepth: number;
  activitySnapshot?: {
    recent10AiCount: number;
    recent30AiShare: number;
    consecutiveAiCount: number;
    personaActivity: PersonaActivitySnapshot;
  };
  random?: () => number;
  now?: Date;
}) {
  const random = input.random ?? Math.random;
  if (
    input.activitySnapshot?.consecutiveAiCount &&
    input.activitySnapshot.consecutiveAiCount >= input.config.maxConsecutiveAiMessages
  ) return [];
  if (input.recentMessages.slice(-6).filter((message) => message.senderType === "ai").length >= 3) return [];
  if (input.chainDepth >= input.config.maxChainDepth || random() >= input.config.aiFollowUpProbability) return [];
  const now = input.now ?? new Date();
  const candidates = CHAT_AI_PERSONAS.filter(
    (persona) =>
      persona.enabled &&
      persona.id !== input.trigger.personaId &&
      canPersonaParticipate(persona, input.activitySnapshot?.personaActivity, now),
  );
  if (!candidates.length) return [];
  const persona = weightedPick(candidates, inferChatTopics(input.trigger.content), random);
  const delay = randomDelay(input.config.secondDelayMinMs, input.config.secondDelayMaxMs, random);
  return [{
    persona,
    scheduledAt: new Date(now.getTime() + delay * input.config.timeScale).toISOString(),
    chainDepth: input.chainDepth + 1,
  } satisfies ChatAiPlanItem];
}
