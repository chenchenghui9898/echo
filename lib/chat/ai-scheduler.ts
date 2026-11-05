import "server-only";

import { getModelConfig } from "@/lib/ai-lab/config";
import {
  createChatAiTasks,
  getChatAiPlanningContext,
} from "@/lib/ai-lab/storage";
import { CHAT_AI_PROMPT_VERSION, getChatAiConfig } from "./ai-config";
import { planAiToAiFollowUp, planChatAiParticipation } from "./ai-planner";

function enforceGlobalSpacing<T extends { scheduledAt: string }>(
  plan: T[],
  lastAiMessageAt: string | undefined,
  minimumIntervalMs: number,
) {
  let earliest = lastAiMessageAt ? new Date(lastAiMessageAt).getTime() + minimumIntervalMs : 0;
  return plan.map((item) => {
    const scheduled = Math.max(new Date(item.scheduledAt).getTime(), earliest);
    earliest = scheduled + minimumIntervalMs;
    return { ...item, scheduledAt: new Date(scheduled).toISOString() };
  });
}

export async function scheduleAiForHumanMessage(messageId: string) {
  const context = await getChatAiPlanningContext(messageId);
  if (!context || context.trigger.senderType !== "human") return [];
  const config = getChatAiConfig();
  const isDirectAiReply = context.parent?.senderType === "ai";
  if (!isDirectAiReply && context.pendingTaskCount >= config.maxPendingTasks) return [];
  const adjustedConfig = !isDirectAiReply && context.pendingTaskCount >= 2
    ? { ...config, replyProbability: config.replyProbability * 0.4, secondPersonaProbability: 0 }
    : config;
  const plan = enforceGlobalSpacing(planChatAiParticipation({
    trigger: context.trigger,
    parent: context.parent,
    recentMessages: context.recentMessages,
    config: adjustedConfig,
    activitySnapshot: context.activitySnapshot,
  }), context.activitySnapshot.lastAiMessageAt, config.minimumGlobalAiIntervalMs * config.timeScale);
  return createChatAiTasks({
    roomId: context.trigger.roomId,
    triggerMessageId: context.trigger.id,
    tasks: plan.map((item) => ({
      personaId: item.persona.id,
      personaVersion: item.persona.version,
      scheduledAt: item.scheduledAt,
      chainDepth: item.chainDepth,
    })),
    modelConfig: getModelConfig(),
    promptVersion: CHAT_AI_PROMPT_VERSION,
    maxPendingTasks: config.maxPendingTasks,
  });
}

export async function scheduleAiFollowUp(messageId: string, chainDepth: number) {
  const context = await getChatAiPlanningContext(messageId);
  if (!context || context.trigger.senderType !== "ai") return [];
  const config = getChatAiConfig();
  const plan = enforceGlobalSpacing(planAiToAiFollowUp({
    trigger: context.trigger,
    recentMessages: context.recentMessages,
    config,
    chainDepth,
    activitySnapshot: context.activitySnapshot,
  }), context.activitySnapshot.lastAiMessageAt, config.minimumGlobalAiIntervalMs * config.timeScale);
  return createChatAiTasks({
    roomId: context.trigger.roomId,
    triggerMessageId: context.trigger.id,
    tasks: plan.map((item) => ({
      personaId: item.persona.id,
      personaVersion: item.persona.version,
      scheduledAt: item.scheduledAt,
      chainDepth: item.chainDepth,
    })),
    modelConfig: getModelConfig(),
    promptVersion: CHAT_AI_PROMPT_VERSION,
    maxPendingTasks: config.maxPendingTasks,
  });
}
