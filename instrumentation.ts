export async function register() {
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    const { startCommentTaskScheduler } = await import("./lib/community/task-runner");
    const { startChatAiTaskScheduler } = await import("./lib/chat/ai-task-runner");
    startCommentTaskScheduler();
    startChatAiTaskScheduler();
  }
}
