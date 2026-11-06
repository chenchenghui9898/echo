import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  ChatAiTask,
  ChatMessage,
  ModelConfigSnapshot,
} from "@/lib/ai-lab/types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type MessageRow = {
  id: string;
  room_id: string;
  sender_type: "human" | "ai" | "legacy";
  user_id: string | null;
  persona_id: string | null;
  legacy_sender_id: string | null;
  sender_name_snapshot: string;
  sender_avatar_snapshot: string | null;
  content: string;
  reply_to_message_id: string | null;
  status: "normal" | "deleted";
  persona_version: number | null;
  model_config_snapshot: ModelConfigSnapshot | null;
  prompt_version: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type TaskRow = {
  id: string;
  room_id: string;
  trigger_message_id: string;
  persona_id: string;
  persona_version: number;
  scheduled_at: string;
  status: ChatAiTask["status"];
  retry_count: number;
  chain_depth: number;
  created_at: string;
  started_at: string | null;
  generated_at: string | null;
  generated_message_id: string | null;
  execution_token: string | null;
  last_error: string | null;
  model_config_snapshot: ModelConfigSnapshot;
  prompt_version: string;
};

const MESSAGE_COLUMNS = [
  "id", "room_id", "sender_type", "user_id", "persona_id", "legacy_sender_id",
  "sender_name_snapshot", "sender_avatar_snapshot", "content", "reply_to_message_id",
  "status", "persona_version", "model_config_snapshot", "prompt_version", "created_at",
  "updated_at", "deleted_at",
].join(",");

const TASK_COLUMNS = [
  "id", "room_id", "trigger_message_id", "persona_id", "persona_version", "scheduled_at",
  "status", "retry_count", "chain_depth", "created_at", "started_at", "generated_at",
  "generated_message_id", "execution_token", "last_error", "model_config_snapshot",
  "prompt_version",
].join(",");

function throwDatabaseError(operation: string, error: { message: string; code?: string } | null) {
  if (!error) return;
  console.error(`Supabase AI worker ${operation} failed`, {
    code: error.code,
    message: error.message,
  });
  throw new Error(`SUPABASE_AI_${operation.toUpperCase()}_FAILED`);
}

function toMessage(row: MessageRow): ChatMessage {
  const senderId = row.sender_type === "human"
    ? row.user_id ?? "unknown-human"
    : row.sender_type === "ai"
      ? `ai:${row.persona_id ?? "unknown"}`
      : row.legacy_sender_id ?? "unknown-legacy";
  return {
    id: row.id,
    roomId: row.room_id,
    senderId,
    senderType: row.sender_type,
    senderName: row.sender_name_snapshot,
    senderAvatar: row.sender_avatar_snapshot ?? undefined,
    personaId: row.persona_id ?? undefined,
    personaVersion: row.persona_version ?? undefined,
    content: row.status === "deleted" ? "" : row.content,
    replyToMessageId: row.reply_to_message_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    deletedAt: row.deleted_at ?? undefined,
    modelConfig: row.model_config_snapshot ?? undefined,
    promptVersion: row.prompt_version ?? undefined,
  };
}

function toTask(row: TaskRow): ChatAiTask {
  return {
    id: row.id,
    roomId: row.room_id,
    triggerMessageId: row.trigger_message_id,
    personaId: row.persona_id,
    personaVersion: row.persona_version,
    scheduledAt: row.scheduled_at,
    status: row.status,
    retryCount: row.retry_count,
    chainDepth: row.chain_depth,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    generatedAt: row.generated_at ?? undefined,
    generatedMessageId: row.generated_message_id ?? undefined,
    executionToken: row.execution_token ?? undefined,
    lastError: row.last_error ?? undefined,
    modelConfig: row.model_config_snapshot,
    promptVersion: row.prompt_version,
  };
}

async function getMessage(admin: SupabaseClient, messageId: string) {
  const { data, error } = await admin
    .from("chat_messages")
    .select(MESSAGE_COLUMNS)
    .eq("id", messageId)
    .maybeSingle();
  throwDatabaseError("read_message", error);
  return data ? toMessage(data as unknown as MessageRow) : null;
}

export async function getSupabaseChatAiPlanningContext(messageId: string, recentLimit = 30) {
  const admin = createSupabaseAdminClient();
  const trigger = await getMessage(admin, messageId);
  if (!trigger) return null;

  const [recentResult, pendingResult, activityResult, parent] = await Promise.all([
    admin.from("chat_messages")
      .select(MESSAGE_COLUMNS)
      .eq("room_id", trigger.roomId)
      .eq("status", "normal")
      .lte("created_at", trigger.createdAt)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(recentLimit),
    admin.from("chat_ai_tasks")
      .select("id", { count: "exact", head: true })
      .eq("room_id", trigger.roomId)
      .in("status", ["pending", "processing"]),
    admin.from("chat_messages")
      .select("persona_id,created_at")
      .eq("room_id", trigger.roomId)
      .eq("sender_type", "ai")
      .eq("status", "normal")
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60_000).toISOString())
      .order("created_at", { ascending: true }),
    trigger.replyToMessageId ? getMessage(admin, trigger.replyToMessageId) : Promise.resolve(null),
  ]);
  throwDatabaseError("read_recent_messages", recentResult.error);
  throwDatabaseError("count_pending_tasks", pendingResult.error);
  throwDatabaseError("read_persona_activity", activityResult.error);

  const recentMessages = ((recentResult.data ?? []) as unknown as MessageRow[])
    .map(toMessage)
    .reverse();
  const activityRows = (activityResult.data ?? []) as Array<{
    persona_id: string | null;
    created_at: string;
  }>;
  const now = Date.now();
  const personaIds = [...new Set(activityRows.map((row) => row.persona_id).filter(Boolean))] as string[];
  const personaActivity = Object.fromEntries(personaIds.map((personaId) => {
    const rows = activityRows.filter((row) => row.persona_id === personaId);
    return [personaId, {
      lastMessageAt: rows.at(-1)?.created_at,
      hourlyCount: rows.filter((row) => new Date(row.created_at).getTime() >= now - 60 * 60_000).length,
      dailyCount: rows.length,
    }];
  }));
  const recent10 = recentMessages.slice(-10);
  const recent30 = recentMessages.slice(-30);
  let consecutiveAiCount = 0;
  for (const message of [...recentMessages].reverse()) {
    if (message.senderType !== "ai") break;
    consecutiveAiCount += 1;
  }

  return {
    trigger,
    parent,
    recentMessages,
    pendingTaskCount: pendingResult.count ?? 0,
    activitySnapshot: {
      recent10AiCount: recent10.filter((message) => message.senderType === "ai").length,
      recent30AiShare: recent30.length
        ? recent30.filter((message) => message.senderType === "ai").length / recent30.length
        : 0,
      consecutiveAiCount,
      lastAiMessageAt: activityRows.at(-1)?.created_at,
      personaActivity,
    },
  };
}

export async function createSupabaseChatAiTasks(input: {
  roomId: string;
  triggerMessageId: string;
  tasks: Array<{ personaId: string; personaVersion: number; scheduledAt: string; chainDepth: number }>;
  modelConfig: ModelConfigSnapshot;
  promptVersion: string;
  maxPendingTasks: number;
}) {
  if (!input.tasks.length) return [];
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("create_chat_ai_tasks", {
    p_room_id: input.roomId,
    p_trigger_message_id: input.triggerMessageId,
    p_tasks: input.tasks,
    p_model_config: input.modelConfig,
    p_prompt_version: input.promptVersion,
    p_max_pending_tasks: input.maxPendingTasks,
  });
  throwDatabaseError("create_tasks", error);
  return ((data ?? []) as TaskRow[]).map(toTask);
}

export async function claimSupabaseDueChatAiTasks(input: {
  limit: number;
  staleProcessingMs: number;
  minimumGlobalAiIntervalMs: number;
  personaLimits: Record<string, {
    hourlyMessageLimit: number;
    dailyMessageLimit: number;
    minimumIntervalMs: number;
  }>;
  now?: Date;
}) {
  const admin = createSupabaseAdminClient();
  const now = input.now ?? new Date();
  const { data, error } = await admin.rpc("claim_due_chat_ai_tasks", {
    p_limit: input.limit,
    p_stale_before: new Date(now.getTime() - input.staleProcessingMs).toISOString(),
    p_minimum_global_interval_ms: Math.round(input.minimumGlobalAiIntervalMs),
    p_persona_limits: input.personaLimits,
    p_now: now.toISOString(),
  });
  throwDatabaseError("claim_tasks", error);
  return ((data ?? []) as TaskRow[]).map(toTask);
}

export async function getSupabaseChatAiTaskContext(
  taskId: string,
  executionToken: string,
  contextLimit: number,
) {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("chat_ai_tasks")
    .select(TASK_COLUMNS)
    .eq("id", taskId)
    .eq("status", "processing")
    .eq("execution_token", executionToken)
    .maybeSingle();
  throwDatabaseError("read_task", error);
  if (!data) return null;
  const task = toTask(data as unknown as TaskRow);
  const trigger = await getMessage(admin, task.triggerMessageId);
  if (!trigger || trigger.status !== "normal") return null;

  const { data: recentData, error: recentError } = await admin
    .from("chat_messages")
    .select(MESSAGE_COLUMNS)
    .eq("room_id", task.roomId)
    .eq("status", "normal")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(contextLimit);
  throwDatabaseError("read_task_context", recentError);
  const messages = new Map(
    ((recentData ?? []) as unknown as MessageRow[]).map((row) => [row.id, toMessage(row)]),
  );
  let cursor: ChatMessage | null = trigger;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.id)) {
    messages.set(cursor.id, cursor);
    visited.add(cursor.id);
    cursor = cursor.replyToMessageId ? await getMessage(admin, cursor.replyToMessageId) : null;
  }
  const contextMessages = [...messages.values()].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  return { task, trigger, contextMessages };
}

export async function completeSupabaseChatAiTask(input: {
  taskId: string;
  executionToken: string;
  content: string;
}) {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("complete_chat_ai_task", {
    p_task_id: input.taskId,
    p_execution_token: input.executionToken,
    p_content: input.content,
  });
  throwDatabaseError("complete_task", error);
  const row = (data as MessageRow[] | null)?.[0];
  return row ? toMessage(row) : null;
}

export async function failSupabaseChatAiTask(input: {
  taskId: string;
  executionToken: string;
  errorMessage: string;
  maxRetries: number;
  retryAt: string;
}) {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("fail_chat_ai_task", {
    p_task_id: input.taskId,
    p_execution_token: input.executionToken,
    p_error_message: input.errorMessage,
    p_max_retries: input.maxRetries,
    p_retry_at: input.retryAt,
  });
  throwDatabaseError("fail_task", error);
  const row = (data as TaskRow[] | null)?.[0];
  return row ? toTask(row) : null;
}

export async function getSupabaseChatAiTaskDiagnostics() {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("chat_ai_tasks")
    .select(TASK_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(200);
  throwDatabaseError("task_diagnostics", error);
  return ((data ?? []) as unknown as TaskRow[]).map(toTask);
}
