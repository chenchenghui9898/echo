import "server-only";

import { generateDeepSeekChatMessage, ModelServiceError } from "@/lib/ai-lab/deepseek";
import {
  claimDueChatAiTasks,
  completeChatAiTask,
  failChatAiTask,
  getChatAiTaskContext,
} from "./ai-task-repository";
import { getEchoDataBackend, hasSupabaseAdminConfig } from "@/lib/supabase/config";
import { getChatAiConfig } from "./ai-config";
import { CHAT_AI_PERSONAS, getChatAiPersona } from "./ai-personas";
import { scheduleAiFollowUp } from "./ai-scheduler";
import { processDueChatIntentDecisions } from "./intent-runner";

let processing = false;
let interval: NodeJS.Timeout | undefined;

async function executeTask(task: { id: string; executionToken?: string; retryCount: number }) {
  if (!task.executionToken) return;
  const config = getChatAiConfig();
  const context = await getChatAiTaskContext(task.id, task.executionToken, config.contextMessageCount);
  if (!context) return;
  const persona = getChatAiPersona(context.task.personaId);
  if (!persona || persona.version !== context.task.personaVersion) {
    await failChatAiTask({
      taskId: task.id,
      executionToken: task.executionToken,
      errorMessage: "AI 群友配置不存在或版本不匹配。",
      maxRetries: 0,
      retryAt: new Date().toISOString(),
    });
    return;
  }
  try {
    const generated = await generateDeepSeekChatMessage({
      persona,
      context: context.contextMessages.map((message) => ({
        senderName: message.senderName,
        senderType: message.senderType === "ai" ? "ai" : "human",
        content: message.content,
        createdAt: message.createdAt,
        isTrigger: message.id === context.trigger.id,
        replyToName: message.replyToMessageId
          ? context.contextMessages.find((item) => item.id === message.replyToMessageId)?.senderName
          : undefined,
      })),
      config: context.task.modelConfig,
    });
    const message = await completeChatAiTask({
      taskId: task.id,
      executionToken: task.executionToken,
      content: generated.message,
      persona: {
        id: persona.id,
        name: persona.name,
        avatar: persona.avatar,
        version: persona.version,
      },
    });
    if (message) await scheduleAiFollowUp(message.id, context.task.chainDepth);
  } catch (error) {
    if (!(error instanceof ModelServiceError)) console.error("Unexpected AI chat task error", error);
    const retryDelay = config.retryBaseMs * 2 ** task.retryCount * config.timeScale;
    await failChatAiTask({
      taskId: task.id,
      executionToken: task.executionToken,
      errorMessage: error instanceof ModelServiceError ? error.publicMessage : "AI 群聊消息生成失败。",
      maxRetries: config.maxRetries,
      retryAt: new Date(Date.now() + retryDelay).toISOString(),
    });
  }
}

export async function processDueChatAiTasks() {
  if (processing) return { skipped: true, claimed: 0 };
  processing = true;
  try {
    const config = getChatAiConfig();
    const analyzed = getEchoDataBackend() === "supabase"
      ? await processDueChatIntentDecisions()
      : 0;
    const tasks = await claimDueChatAiTasks({
      limit: config.concurrency,
      staleProcessingMs: config.staleProcessingMs,
      minimumGlobalAiIntervalMs: config.minimumGlobalAiIntervalMs * config.timeScale,
      personaLimits: Object.fromEntries(CHAT_AI_PERSONAS.map((persona) => [persona.id, {
        hourlyMessageLimit: persona.hourlyMessageLimit,
        dailyMessageLimit: persona.dailyMessageLimit,
        minimumIntervalMs: persona.minimumIntervalMs * config.timeScale,
      }])),
    });
    await Promise.all(tasks.map(executeTask));
    return { skipped: false, analyzed, claimed: tasks.length };
  } finally {
    processing = false;
  }
}

export function startChatAiTaskScheduler() {
  if (interval) return;
  if (getEchoDataBackend() === "supabase" && !hasSupabaseAdminConfig()) {
    console.warn(
      "Supabase AI chat worker is disabled: configure SUPABASE_SECRET_KEY on the server.",
    );
    return;
  }
  const config = getChatAiConfig();
  void processDueChatAiTasks();
  interval = setInterval(() => void processDueChatAiTasks(), config.pollIntervalMs);
  interval.unref();
}
