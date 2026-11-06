import "server-only";

import type { ModelConfigSnapshot } from "@/lib/ai-lab/types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { ChatIntentAnalysis } from "./intent";

export type ChatIntentDecisionTask = {
  id: string;
  roomId: string;
  messageId: string;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  retryCount: number;
  scheduledAt: string;
  executionToken?: string;
  modelConfig: ModelConfigSnapshot;
  classifierPromptVersion: string;
  replyPromptVersion: string;
};

type DecisionRow = {
  id: string;
  room_id: string;
  message_id: string;
  status: ChatIntentDecisionTask["status"];
  retry_count: number;
  scheduled_at: string;
  execution_token: string | null;
  model_config_snapshot: ModelConfigSnapshot;
  classifier_prompt_version: string;
  reply_prompt_version: string;
};

function toTask(row: DecisionRow): ChatIntentDecisionTask {
  return {
    id: row.id,
    roomId: row.room_id,
    messageId: row.message_id,
    status: row.status,
    retryCount: row.retry_count,
    scheduledAt: row.scheduled_at,
    executionToken: row.execution_token ?? undefined,
    modelConfig: row.model_config_snapshot,
    classifierPromptVersion: row.classifier_prompt_version,
    replyPromptVersion: row.reply_prompt_version,
  };
}

function ensure(operation: string, error: { message: string; code?: string } | null) {
  if (!error) return;
  console.error(`Supabase chat intent ${operation} failed`, { code: error.code, message: error.message });
  throw new Error(`SUPABASE_CHAT_INTENT_${operation.toUpperCase()}_FAILED`);
}

export async function enqueueChatIntentDecision(input: {
  roomId: string;
  messageId: string;
  modelConfig: ModelConfigSnapshot;
  classifierPromptVersion: string;
  replyPromptVersion: string;
}) {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("enqueue_chat_ai_intent_decision", {
    p_room_id: input.roomId,
    p_message_id: input.messageId,
    p_model_config: input.modelConfig,
    p_classifier_prompt_version: input.classifierPromptVersion,
    p_reply_prompt_version: input.replyPromptVersion,
  });
  ensure("enqueue", error);
  const row = (data as DecisionRow[] | null)?.[0];
  return row ? toTask(row) : null;
}

export async function claimChatIntentDecisions(input: {
  limit: number;
  staleBefore: string;
  now?: string;
}) {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("claim_chat_ai_intent_decisions", {
    p_limit: input.limit,
    p_stale_before: input.staleBefore,
    p_now: input.now ?? new Date().toISOString(),
  });
  ensure("claim", error);
  return ((data ?? []) as DecisionRow[]).map(toTask);
}

export async function completeChatIntentDecision(input: {
  decisionId: string;
  executionToken: string;
  analysis: ChatIntentAnalysis;
  responseProbability: number;
  decisionResult: boolean;
  selectedPersonaIds: string[];
  classifierSource: "model" | "fallback";
}) {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("complete_chat_ai_intent_decision", {
    p_decision_id: input.decisionId,
    p_execution_token: input.executionToken,
    p_analysis: input.analysis,
    p_response_probability: input.responseProbability,
    p_decision_result: input.decisionResult,
    p_selected_persona_ids: input.selectedPersonaIds,
    p_classifier_source: input.classifierSource,
  });
  ensure("complete", error);
  return Boolean((data as DecisionRow[] | null)?.[0]);
}

export async function failChatIntentDecision(input: {
  decisionId: string;
  executionToken: string;
  errorMessage: string;
  maxRetries: number;
  retryAt: string;
}) {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("fail_chat_ai_intent_decision", {
    p_decision_id: input.decisionId,
    p_execution_token: input.executionToken,
    p_error_message: input.errorMessage,
    p_max_retries: input.maxRetries,
    p_retry_at: input.retryAt,
  });
  ensure("fail", error);
  const row = (data as DecisionRow[] | null)?.[0];
  return row ? toTask(row) : null;
}
