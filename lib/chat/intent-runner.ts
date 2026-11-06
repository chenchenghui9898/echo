import "server-only";

import { generateDeepSeekChatIntentAnalysis } from "@/lib/ai-lab/deepseek";
import { getChatAiPlanningContext } from "./ai-task-repository";
import { getChatAiConfig } from "./ai-config";
import {
  claimChatIntentDecisions,
  completeChatIntentDecision,
  failChatIntentDecision,
  type ChatIntentDecisionTask,
} from "./intent-repository";
import {
  applyChatIntentContext,
  decideChatAiReply,
  inferChatIntentFallback,
  parseChatIntentAnalysis,
  type ChatIntentAnalysis,
} from "./intent";
import { scheduleAiForHumanMessage } from "./ai-scheduler";

function buildConversation(context: Awaited<ReturnType<typeof getChatAiPlanningContext>>) {
  if (!context) return "";
  return context.recentMessages.map((message) => {
    const identity = message.senderType === "ai"
      ? `${message.senderName}（AI）`
      : message.senderName;
    const relation = message.replyToMessageId
      ? ` [回复 ${context.recentMessages.find((item) => item.id === message.replyToMessageId)?.senderName ?? "前文消息"}]`
      : "";
    const marker = message.id === context.trigger.id ? " ← 待分析消息" : "";
    return `[${message.createdAt}] ${identity}${relation}：${message.content}${marker}`;
  }).join("\n");
}

async function finishDecision(
  task: ChatIntentDecisionTask,
  analysis: ChatIntentAnalysis,
  classifierSource: "model" | "fallback",
) {
  if (!task.executionToken) return;
  const context = await getChatAiPlanningContext(task.messageId);
  if (!context || context.trigger.senderType !== "human") {
    await failChatIntentDecision({
      decisionId: task.id,
      executionToken: task.executionToken,
      errorMessage: "触发消息不存在或不再可分析。",
      maxRetries: 0,
      retryAt: new Date().toISOString(),
    });
    return;
  }
  const decision = decideChatAiReply({
    analysis,
    trigger: context.trigger,
    parent: context.parent,
    recentMessages: context.recentMessages,
    recent10AiCount: context.activitySnapshot.recent10AiCount,
    recent30AiShare: context.activitySnapshot.recent30AiShare,
    consecutiveAiCount: context.activitySnapshot.consecutiveAiCount,
  });
  const scheduled = decision.shouldReply
    ? await scheduleAiForHumanMessage(task.messageId, { replyDecisionPassed: true })
    : { tasks: [], plannedPersonaIds: [] };
  await completeChatIntentDecision({
    decisionId: task.id,
    executionToken: task.executionToken,
    analysis,
    responseProbability: decision.probability,
    decisionResult: decision.shouldReply && scheduled.plannedPersonaIds.length > 0,
    selectedPersonaIds: scheduled.plannedPersonaIds,
    classifierSource,
  });
}

async function executeIntentDecision(task: ChatIntentDecisionTask) {
  if (!task.executionToken) return;
  const context = await getChatAiPlanningContext(task.messageId);
  if (!context || context.trigger.senderType !== "human") {
    await failChatIntentDecision({
      decisionId: task.id,
      executionToken: task.executionToken,
      errorMessage: "触发消息不存在或不再可分析。",
      maxRetries: 0,
      retryAt: new Date().toISOString(),
    });
    return;
  }
  const config = getChatAiConfig();
  try {
    const result = await generateDeepSeekChatIntentAnalysis({
      conversation: buildConversation(context),
      config: task.modelConfig,
    });
    await finishDecision(
      task,
      applyChatIntentContext(parseChatIntentAnalysis(result.content), context.parent),
      "model",
    );
  } catch (error) {
    if (task.retryCount >= config.intentDecisionMaxRetries) {
      const fallback = inferChatIntentFallback({ trigger: context.trigger, parent: context.parent });
      await finishDecision(task, fallback, "fallback");
      return;
    }
    const retryDelay = config.intentDecisionRetryBaseMs * 2 ** task.retryCount * config.timeScale;
    await failChatIntentDecision({
      decisionId: task.id,
      executionToken: task.executionToken,
      errorMessage: error instanceof Error ? error.message : "意图识别失败。",
      maxRetries: config.intentDecisionMaxRetries,
      retryAt: new Date(Date.now() + retryDelay).toISOString(),
    });
  }
}

export async function processDueChatIntentDecisions() {
  const config = getChatAiConfig();
  const now = new Date();
  const tasks = await claimChatIntentDecisions({
    limit: config.intentDecisionConcurrency,
    staleBefore: new Date(now.getTime() - config.staleProcessingMs).toISOString(),
    now: now.toISOString(),
  });
  await Promise.all(tasks.map(executeIntentDecision));
  return tasks.length;
}
