function envNumber(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback;
}

export const CHAT_AI_PROMPT_VERSION = "mood-group-chat-v1";
export const CHAT_AI_INTENT_PROMPT_VERSION = "mood-intent-v1";

export const CHAT_AI_INTENT_REPLY_PROBABILITIES = {
  seeking_comfort: 0.85,
  seeking_advice: 0.85,
  sharing_feelings: 0.75,
  expressing_opinion: 0.75,
  asking_question: 0.70,
  sharing_experience: 0.70,
  casual_chat: 0.45,
  simple_statement: 0.15,
  announcement: 0.10,
  no_clear_intent: 0,
  uncertain: 0,
} as const;

export function getChatAiConfig() {
  return {
    intentReplyProbabilities: {
      seeking_comfort: envNumber("ECHO_CHAT_AI_INTENT_SEEKING_COMFORT", CHAT_AI_INTENT_REPLY_PROBABILITIES.seeking_comfort, 0, 1),
      seeking_advice: envNumber("ECHO_CHAT_AI_INTENT_SEEKING_ADVICE", CHAT_AI_INTENT_REPLY_PROBABILITIES.seeking_advice, 0, 1),
      sharing_feelings: envNumber("ECHO_CHAT_AI_INTENT_SHARING_FEELINGS", CHAT_AI_INTENT_REPLY_PROBABILITIES.sharing_feelings, 0, 1),
      expressing_opinion: envNumber("ECHO_CHAT_AI_INTENT_EXPRESSING_OPINION", CHAT_AI_INTENT_REPLY_PROBABILITIES.expressing_opinion, 0, 1),
      asking_question: envNumber("ECHO_CHAT_AI_INTENT_ASKING_QUESTION", CHAT_AI_INTENT_REPLY_PROBABILITIES.asking_question, 0, 1),
      sharing_experience: envNumber("ECHO_CHAT_AI_INTENT_SHARING_EXPERIENCE", CHAT_AI_INTENT_REPLY_PROBABILITIES.sharing_experience, 0, 1),
      casual_chat: envNumber("ECHO_CHAT_AI_INTENT_CASUAL_CHAT", CHAT_AI_INTENT_REPLY_PROBABILITIES.casual_chat, 0, 1),
      simple_statement: envNumber("ECHO_CHAT_AI_INTENT_SIMPLE_STATEMENT", CHAT_AI_INTENT_REPLY_PROBABILITIES.simple_statement, 0, 1),
      announcement: envNumber("ECHO_CHAT_AI_INTENT_ANNOUNCEMENT", CHAT_AI_INTENT_REPLY_PROBABILITIES.announcement, 0, 1),
      no_clear_intent: 0,
      uncertain: 0,
    },
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
    intentDecisionConcurrency: Math.round(envNumber("ECHO_CHAT_AI_INTENT_CONCURRENCY", 2, 1, 5)),
    intentDecisionMaxRetries: Math.round(envNumber("ECHO_CHAT_AI_INTENT_MAX_RETRIES", 2, 0, 5)),
    intentDecisionRetryBaseMs: envNumber("ECHO_CHAT_AI_INTENT_RETRY_BASE_MS", 5_000, 500, 120_000),
    humanConversationFactor: envNumber("ECHO_CHAT_AI_HUMAN_CONVERSATION_FACTOR", 0.55, 0, 1),
    groupQuestionBoost: envNumber("ECHO_CHAT_AI_GROUP_QUESTION_BOOST", 0.10, 0, 0.5),
  };
}
