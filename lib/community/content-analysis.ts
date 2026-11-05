import type { ContentAnalysis, PostContentType } from "@/lib/ai-lab/types";

import { inferTopics } from "./planner.ts";

const DEFAULT_DIRECTIONS: Record<PostContentType, { primary: string; secondary: string[]; unsuitable: string[] }> = {
  观点: { primary: "讨论观点与理由", secondary: ["补充不同角度"], unsuitable: ["无依据的文学赏析", "把个人情绪强行哲学化"] },
  心情: { primary: "自然接话并回应当下感受", secondary: ["回应具体生活细节"], unsuitable: ["心理诊断", "默认给建议", "强行总结升华"] },
  日记: { primary: "关注实际经历与具体事件", secondary: ["根据情境共情或祝贺"], unsuitable: ["机械安慰", "忽略事件只分析情绪"] },
  作品: { primary: "回应创作中的具体表达", secondary: ["形成有依据的审美判断"], unsuitable: ["泛泛赞美", "无依据推测作者经历"] },
};

function strings(value: unknown, maximum = 8) {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean).slice(0, maximum)
    : typeof value === "string" && value.trim()
      ? [value.trim()]
      : [];
}

function text(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function fallbackContentAnalysis(input: {
  category: PostContentType;
  content: string;
}): ContentAnalysis {
  const defaults = DEFAULT_DIRECTIONS[input.category];
  return {
    contentCategory: input.category,
    actualContentType: [input.category],
    emotions: [],
    expressionIntent: input.category === "观点" ? ["交流看法"] : input.category === "作品" ? ["展示创作"] : ["分享"],
    topics: inferTopics(input.content, input.category),
    primaryInteractionDirection: defaults.primary,
    secondaryInteractionDirections: defaults.secondary,
    unsuitableInteractionDirections: defaults.unsuitable,
    confidence: 0.35,
  };
}

export function parseContentAnalysis(input: {
  raw: string;
  category: PostContentType;
  content: string;
}): ContentAnalysis {
  const normalized = input.raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(normalized) as Record<string, unknown>;
  const fallback = fallbackContentAnalysis(input);
  const confidence = Number(parsed.confidence);
  return {
    contentCategory: input.category,
    actualContentType: strings(parsed.actual_content_type).length ? strings(parsed.actual_content_type) : fallback.actualContentType,
    emotions: strings(parsed.emotions),
    expressionIntent: strings(parsed.expression_intent).length ? strings(parsed.expression_intent) : fallback.expressionIntent,
    topics: strings(parsed.topics).length ? strings(parsed.topics) : fallback.topics,
    primaryInteractionDirection: text(parsed.primary_interaction_direction, fallback.primaryInteractionDirection),
    secondaryInteractionDirections: strings(parsed.secondary_interaction_directions),
    unsuitableInteractionDirections: strings(parsed.unsuitable_interaction_directions).length
      ? strings(parsed.unsuitable_interaction_directions)
      : fallback.unsuitableInteractionDirections,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : fallback.confidence,
  };
}
