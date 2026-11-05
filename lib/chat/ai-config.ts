function envNumber(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback;
}

export const CHAT_AI_PROMPT_VERSION = "mood-group-chat-v1";

export function getChatAiConfig() {
  return {
    replyProbability: envNumber("ECHO_CHAT_AI_REPLY_PROBABILITY", 0.9, 0, 1),
    secondPersonaProbability: envNumber("ECHO_CHAT_AI_SECOND_REPLY_PROBABILITY", 0.3, 0, 1),
    directReplyProbability: envNumber("ECHO_CHAT_AI_DIRECT_REPLY_PROBABILITY", 0.94, 0, 1),
    aiFollowUpProbability: envNumber("ECHO_CHAT_AI_FOLLOW_UP_PROBABILITY", 0.15, 0, 0.5),
    firstDelayMinMs: envNumber("ECHO_CHAT_AI_FIRST_DELAY_MIN_MS", 5_000, 500, 300_000),
    firstDelayMaxMs: envNumber("ECHO_CHAT_AI_FIRST_DELAY_MAX_MS", 45_000, 500, 600_000),
    secondDelayMinMs: envNumber("ECHO_CHAT_AI_SECOND_DELAY_MIN_MS", 10_000, 1_000, 600_000),
    secondDelayMaxMs: envNumber("ECHO_CHAT_AI_SECOND_DELAY_MAX_MS", 90_000, 1_000, 900_000),
    directDelayMinMs: envNumber("ECHO_CHAT_AI_DIRECT_DELAY_MIN_MS", 3_000, 500, 120_000),
    directDelayMaxMs: envNumber("ECHO_CHAT_AI_DIRECT_DELAY_MAX_MS", 15_000, 500, 300_000),
    timeScale: envNumber("ECHO_CHAT_AI_TIME_SCALE", 1, 0.0001, 10),
    pollIntervalMs: Math.round(envNumber("ECHO_CHAT_AI_POLL_MS", 1_500, 250, 60_000)),
    concurrency: Math.round(envNumber("ECHO_CHAT_AI_CONCURRENCY", 2, 1, 5)),
    maxRetries: Math.round(envNumber("ECHO_CHAT_AI_MAX_RETRIES", 3, 0, 8)),
    retryBaseMs: envNumber("ECHO_CHAT_AI_RETRY_BASE_MS", 15_000, 500, 600_000),
    staleProcessingMs: envNumber("ECHO_CHAT_AI_STALE_MS", 2 * 60_000, 10_000, 30 * 60_000),
    contextMessageCount: Math.round(envNumber("ECHO_CHAT_AI_CONTEXT_MESSAGES", 25, 10, 40)),
    maxChainDepth: Math.round(envNumber("ECHO_CHAT_AI_MAX_CHAIN_DEPTH", 3, 1, 3)),
    maxPendingTasks: Math.round(envNumber("ECHO_CHAT_AI_MAX_PENDING_TASKS", 3, 1, 6)),
    maxAiMessagesInRecent10: Math.round(envNumber("ECHO_CHAT_AI_MAX_RECENT_10", 4, 1, 8)),
    maxAiShareInRecent30: envNumber("ECHO_CHAT_AI_MAX_SHARE_30", 0.4, 0.1, 0.9),
    maxConsecutiveAiMessages: Math.round(envNumber("ECHO_CHAT_AI_MAX_CONSECUTIVE", 2, 1, 3)),
    minimumGlobalAiIntervalMs: envNumber("ECHO_CHAT_AI_MIN_GLOBAL_INTERVAL_MS", 12_000, 0, 300_000),
  };
}
