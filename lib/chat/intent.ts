import type { ChatMessage } from "@/lib/ai-lab/types";
import { getChatAiConfig } from "./ai-config.ts";

export const CHAT_USER_INTENTS = [
  "sharing_feelings",
  "seeking_comfort",
  "seeking_advice",
  "sharing_experience",
  "expressing_opinion",
  "asking_question",
  "casual_chat",
  "simple_statement",
  "announcement",
  "social_response",
  "no_clear_intent",
  "uncertain",
] as const;

export type ChatUserIntent = (typeof CHAT_USER_INTENTS)[number];
export type ChatInteractionTarget = "group" | "ai_persona" | "human" | "unclear";
export type ChatContextDependency = "low" | "medium" | "high";

export type ChatIntentAnalysis = {
  intent: ChatUserIntent;
  emotion: string;
  interactionTarget: ChatInteractionTarget;
  needsResponse: boolean;
  responseStyles: string[];
  contextDependency: ChatContextDependency;
  reason: string;
  confidence: number;
};

const TARGETS = new Set<ChatInteractionTarget>(["group", "ai_persona", "human", "unclear"]);
const DEPENDENCIES = new Set<ChatContextDependency>(["low", "medium", "high"]);

function cleanJsonEnvelope(content: string) {
  return content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

export function parseChatIntentAnalysis(content: string): ChatIntentAnalysis {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleanJsonEnvelope(content));
  } catch {
    throw new Error("CHAT_INTENT_INVALID_JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("CHAT_INTENT_INVALID_SHAPE");
  const value = parsed as Record<string, unknown>;
  if (!CHAT_USER_INTENTS.includes(value.intent as ChatUserIntent)) {
    throw new Error("CHAT_INTENT_INVALID_INTENT");
  }
  if (!TARGETS.has(value.interaction_target as ChatInteractionTarget)) {
    throw new Error("CHAT_INTENT_INVALID_TARGET");
  }
  if (!DEPENDENCIES.has(value.context_dependency as ChatContextDependency)) {
    throw new Error("CHAT_INTENT_INVALID_DEPENDENCY");
  }
  if (typeof value.needs_response !== "boolean") throw new Error("CHAT_INTENT_INVALID_NEED");
  const styles = Array.isArray(value.response_style)
    ? value.response_style.filter((item): item is string => typeof item === "string").slice(0, 4)
    : [];
  const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence)
    ? Math.max(0, Math.min(1, value.confidence))
    : 0.5;
  return {
    intent: value.intent as ChatUserIntent,
    emotion: typeof value.emotion === "string" && value.emotion.trim()
      ? value.emotion.trim().slice(0, 40)
      : "uncertain",
    interactionTarget: value.interaction_target as ChatInteractionTarget,
    needsResponse: value.needs_response,
    responseStyles: styles,
    contextDependency: value.context_dependency as ChatContextDependency,
    reason: typeof value.reason === "string" ? value.reason.trim().slice(0, 500) : "",
    confidence,
  };
}

export function inferChatIntentFallback(input: {
  trigger: ChatMessage;
  parent: ChatMessage | null;
}): ChatIntentAnalysis {
  const text = input.trigger.content.trim();
  const compact = text.replace(/\s+/g, "");
  const base = {
    emotion: /开心|高兴|爽|太好了|成功/.test(text)
      ? "happy"
      : /难过|伤心|想哭|委屈/.test(text)
        ? "sad"
        : /烦|生气|气死|无语/.test(text)
          ? "frustrated"
          : "uncertain",
    responseStyles: ["casual"],
    confidence: 0.45,
  };
  if (input.parent) {
    return {
      ...base,
      intent: "social_response",
      interactionTarget: input.parent.senderType === "ai" ? "ai_persona" : "human",
      needsResponse: input.parent.senderType === "ai" || /[？?]|吗|呢|怎么|为什么/.test(text),
      contextDependency: "high",
      reason: "本地兜底识别到明确的回复关系。",
    };
  }
  if (/安慰我|陪陪我|理理我|谁能哄|撑不住/.test(text)) {
    return { ...base, intent: "seeking_comfort", interactionTarget: "group", needsResponse: true, contextDependency: "medium", responseStyles: ["empathetic", "casual"], reason: "本地兜底识别到明确寻求陪伴或安慰的表达。" };
  }
  if (/怎么办|给.*建议|建议一下|该不该|怎么选|求建议/.test(text)) {
    return { ...base, intent: "seeking_advice", interactionTarget: "group", needsResponse: true, contextDependency: "medium", responseStyles: ["practical", "casual"], reason: "本地兜底识别到明确建议请求。" };
  }
  if (/[？?]|为什么|怎么回事|谁知道|请问/.test(text)) {
    return { ...base, intent: "asking_question", interactionTarget: "group", needsResponse: true, contextDependency: "medium", reason: "本地兜底识别到直接疑问。" };
  }
  if (/我觉得|我认为|应该|不应该|同意|反对/.test(text)) {
    return { ...base, intent: "expressing_opinion", interactionTarget: "group", needsResponse: false, contextDependency: "low", reason: "本地兜底识别到观点表达。" };
  }
  if (/通知|提醒|公告|停水|停电|改到|取消/.test(text)) {
    return { ...base, intent: "announcement", interactionTarget: "group", needsResponse: false, contextDependency: "low", reason: "本地兜底识别到通知性信息。" };
  }
  if (/今天|昨天|刚才|后来|下班|上班|回家|去了|遇到/.test(text) && compact.length >= 12) {
    return { ...base, intent: "sharing_experience", interactionTarget: "group", needsResponse: false, contextDependency: "medium", reason: "本地兜底识别到生活经历分享。" };
  }
  if (/难过|伤心|开心|高兴|烦|累|焦虑|生气|委屈/.test(text)) {
    return { ...base, intent: "sharing_feelings", interactionTarget: "group", needsResponse: false, contextDependency: "low", reason: "本地兜底识别到感受表达，但没有推断为求安慰。" };
  }
  if (/^(嗯+|哦+|哈哈+|呵呵+|好吧|行吧|收到)[。！!~～]*$/.test(compact)) {
    return { ...base, intent: "no_clear_intent", interactionTarget: "group", needsResponse: false, contextDependency: "low", confidence: 0.7, reason: "本地兜底判断为缺少明确交流诉求的短回应。" };
  }
  if (compact.length <= 8) {
    return { ...base, intent: "simple_statement", interactionTarget: "group", needsResponse: false, contextDependency: "low", reason: "本地兜底判断为简短陈述。" };
  }
  return { ...base, intent: "uncertain", interactionTarget: "unclear", needsResponse: false, contextDependency: "medium", confidence: 0.25, reason: "模型识别失败，本地规则无法可靠判断交流意图。" };
}

export function applyChatIntentContext(
  analysis: ChatIntentAnalysis,
  parent: ChatMessage | null,
): ChatIntentAnalysis {
  if (!parent) return analysis;
  return {
    ...analysis,
    intent: "social_response",
    interactionTarget: parent.senderType === "ai" ? "ai_persona" : "human",
    contextDependency: "high",
    reason: `存在明确回复关系。${analysis.reason}`.slice(0, 500),
  };
}

export function decideChatAiReply(input: {
  analysis: ChatIntentAnalysis;
  trigger: ChatMessage;
  parent: ChatMessage | null;
  recentMessages: ChatMessage[];
  recent10AiCount: number;
  recent30AiShare: number;
  consecutiveAiCount: number;
  random?: () => number;
}) {
  const config = getChatAiConfig();
  const directAiReply = input.parent?.senderType === "ai";
  let probability: number;
  if (input.analysis.intent === "social_response") {
    probability = directAiReply
      ? input.analysis.needsResponse ? config.directReplyProbability : 0.55
      : input.analysis.needsResponse ? 0.45 : 0.25;
  } else {
    probability = config.intentReplyProbabilities[
      input.analysis.intent as keyof typeof config.intentReplyProbabilities
    ];
  }

  if (input.analysis.intent === "asking_question" && input.analysis.interactionTarget === "group") {
    probability += config.groupQuestionBoost;
  }
  if (!input.analysis.needsResponse && input.analysis.intent === "simple_statement") {
    probability = Math.min(probability, config.intentReplyProbabilities.simple_statement);
  }
  if (!input.analysis.needsResponse && input.analysis.intent === "announcement") {
    probability = Math.min(probability, config.intentReplyProbabilities.announcement);
  }

  const recentBeforeTrigger = input.recentMessages.filter((message) => message.id !== input.trigger.id).slice(-4);
  const humanSenders = new Set(
    recentBeforeTrigger.filter((message) => message.senderType === "human").map((message) => message.senderId),
  );
  const humansAreConversing = recentBeforeTrigger.length >= 3
    && recentBeforeTrigger.every((message) => message.senderType === "human")
    && humanSenders.size >= 2;
  if (
    humansAreConversing && !directAiReply &&
    !["seeking_comfort", "seeking_advice", "asking_question"].includes(input.analysis.intent)
  ) {
    probability *= config.humanConversationFactor;
  }

  const overAiLimit = input.recent10AiCount >= config.maxAiMessagesInRecent10
    || input.recent30AiShare >= config.maxAiShareInRecent30
    || input.consecutiveAiCount >= config.maxConsecutiveAiMessages;
  const highPriorityIntent = ["seeking_comfort", "seeking_advice", "asking_question"]
    .includes(input.analysis.intent);
  if (directAiReply) {
    if (overAiLimit) probability *= 0.65;
  } else if (overAiLimit) {
    probability *= highPriorityIntent ? 0.65 : 0.15;
  } else if (input.recent10AiCount >= 3) {
    probability *= highPriorityIntent ? 0.85 : 0.35;
  } else if (input.recent10AiCount === 2) {
    probability *= highPriorityIntent ? 0.90 : 0.68;
  }

  if (input.analysis.intent === "uncertain" || input.analysis.intent === "no_clear_intent") {
    probability = 0;
  }
  probability = Math.max(0, Math.min(0.98, probability));
  return {
    probability,
    shouldReply: (input.random ?? Math.random)() < probability,
    humansAreConversing,
  };
}
