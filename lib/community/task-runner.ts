import "server-only";

import { generateDeepSeekScheduledComment, ModelServiceError } from "@/lib/ai-lab/deepseek";
import {
  claimDueCommentTasks,
  completeCommentTask,
  failCommentTask,
  getCommentTaskContext,
} from "@/lib/ai-lab/storage";

import { getCommunityPersona } from "./personas";
import { getSchedulerConfig } from "./scheduler-config";

let processing = false;
let interval: NodeJS.Timeout | undefined;

async function executeTask(task: { id: string; executionToken?: string; retryCount: number }) {
  if (!task.executionToken) return;
  const config = getSchedulerConfig();
  const context = await getCommentTaskContext(task.id, task.executionToken);
  if (!context) return;
  const persona = getCommunityPersona(context.task.personaId);
  if (!persona) {
    await failCommentTask({
      taskId: task.id,
      executionToken: task.executionToken,
      errorMessage: "人格配置不存在。",
      maxRetries: 0,
      retryAt: new Date().toISOString(),
    });
    return;
  }
  if (!context.contentAnalysis || !context.task.strategyPromptSnapshot) {
    await failCommentTask({
      taskId: task.id,
      executionToken: task.executionToken,
      errorMessage: "评论任务缺少内容分析或互动策略快照。",
      maxRetries: 0,
      retryAt: new Date().toISOString(),
    });
    return;
  }
  try {
    const generated = await generateDeepSeekScheduledComment({
      work: context.work.content,
      persona: { id: persona.id, name: persona.name, version: persona.version },
      personaRole: persona.role,
      personaInstruction: persona.styleInstruction,
      personaBackground: persona.background,
      personaValues: persona.values,
      personaTopicFamiliarity: persona.topicFamiliarity,
      existingComments: context.existingComments.map((comment) => comment.content),
      contentAnalysis: context.contentAnalysis.analysis,
      strategyPrompt: context.task.strategyPromptSnapshot.body,
      systemPrompt: context.run.systemPromptSnapshot,
      config: context.run.modelConfig,
    });
    await completeCommentTask({
      taskId: task.id,
      executionToken: task.executionToken,
      content: generated.comments[0],
      persona: {
        id: persona.id,
        name: persona.name,
        version: persona.version,
        role: persona.role,
        activity: persona.activity,
        interests: [...persona.interests],
        styleInstruction: persona.styleInstruction,
        background: persona.background,
        values: [...persona.values],
        topicFamiliarity: { ...persona.topicFamiliarity },
      },
      usage: generated.usage,
    });
  } catch (error) {
    if (!(error instanceof ModelServiceError)) console.error("Unexpected scheduled comment error", error);
    const retryDelay = config.retryBaseMs * 2 ** task.retryCount * config.timeScale;
    await failCommentTask({
      taskId: task.id,
      executionToken: task.executionToken,
      errorMessage: error instanceof ModelServiceError ? error.publicMessage : "评论生成失败。",
      maxRetries: config.maxRetries,
      retryAt: new Date(Date.now() + retryDelay).toISOString(),
    });
  }
}

export async function processDueCommentTasks() {
  if (processing) return { skipped: true, claimed: 0 };
  processing = true;
  try {
    const config = getSchedulerConfig();
    const tasks = await claimDueCommentTasks({
      limit: config.concurrency,
      staleRunningMs: config.staleRunningMs,
    });
    await Promise.all(tasks.map(executeTask));
    return { skipped: false, claimed: tasks.length };
  } finally {
    processing = false;
  }
}

export function startCommentTaskScheduler() {
  if (interval) return;
  const config = getSchedulerConfig();
  void processDueCommentTasks();
  interval = setInterval(() => void processDueCommentTasks(), config.pollIntervalMs);
  interval.unref();
}
