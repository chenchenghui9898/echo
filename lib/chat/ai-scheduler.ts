import "server-only";

import { getModelConfig } from "@/lib/ai-lab/config";
import { createChatAiTasks, getChatAiPlanningContext } from "./ai-task-repository";
import { getEchoDataBackend } from "@/lib/supabase/config";
import {
  CHAT_AI_INTENT_PROMPT_VERSION,
  CHAT_AI_PROMPT_VERSION,
  getChatAiConfig,
} from "./ai-config";
import { enqueueChatIntentDecision } from "./intent-repository";
import { planAiToAiFollowUp, planChatAiParticipation } from "./ai-planner";
import { PUBLIC_MOOD_ROOM_ID } from "./config";

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

export async function enqueueAiDecisionForHumanMessage(messageId: string) {
  if (getEchoDataBackend() !== "supabase") {
    return scheduleAiForHumanMessage(messageId);
  }
  return enqueueChatIntentDecision({
    roomId: PUBLIC_MOOD_ROOM_ID,
    messageId,
    modelConfig: getModelConfig(),
    classifierPromptVersion: CHAT_AI_INTENT_PROMPT_VERSION,
    replyPromptVersion: CHAT_AI_PROMPT_VERSION,
  });
}

export async function scheduleAiForHumanMessage(
  messageId: string,
  options: { replyDecisionPassed?: boolean } = {},
) {
  const context = await getChatAiPlanningContext(messageId);
  if (!context || context.trigger.senderType !== "human") {
    return { tasks: [], plannedPersonaIds: [] as string[] };
  }
  const config = getChatAiConfig();
  const isDirectAiReply = context.parent?.senderType === "ai";
  if (!isDirectAiReply && context.pendingTaskCount >= config.maxPendingTasks) {
    return { tasks: [], plannedPersonaIds: [] as string[] };
  }
  const adjustedConfig = !isDirectAiReply && context.pendingTaskCount >= 2
    ? { ...config, replyProbability: config.replyProbability * 0.4, secondPersonaProbability: 0 }
    : config;
  const plan = enforceGlobalSpacing(planChatAiParticipation({
    trigger: context.trigger,
    parent: context.parent,
    recentMessages: context.recentMessages,
    config: adjustedConfig,
    activitySnapshot: context.activitySnapshot,
    replyDecisionPassed: options.replyDecisionPassed,
  }), context.activitySnapshot.lastAiMessageAt, config.minimumGlobalAiIntervalMs * config.timeScale);
  const tasks = await createChatAiTasks({
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
  return { tasks, plannedPersonaIds: plan.map((item) => item.persona.id) };
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
