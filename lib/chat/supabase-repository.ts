import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  ChatMessageView,
  ChatReportReason,
  StyleReasonCode,
} from "@/lib/ai-lab/types";
import type { ChatIdentity } from "./identity";

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
  model_config_snapshot: Record<string, unknown> | null;
  prompt_version: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type StyleFeedbackRow = {
  message_id: string;
  feedback_type: "like" | "dislike";
  reasons: StyleReasonCode[];
  note: string;
  updated_at: string;
};

const MESSAGE_COLUMNS = [
  "id", "room_id", "sender_type", "user_id", "persona_id", "legacy_sender_id",
  "sender_name_snapshot", "sender_avatar_snapshot", "content", "reply_to_message_id",
  "status", "persona_version", "model_config_snapshot", "prompt_version", "created_at",
  "updated_at", "deleted_at",
].join(",");

function throwDatabaseError(operation: string, error: { message: string; code?: string } | null) {
  if (!error) return;
  console.error(`Supabase ${operation} failed`, { code: error.code, message: error.message });
  throw new Error(`SUPABASE_${operation.toUpperCase()}_FAILED`);
}

function senderId(row: MessageRow) {
  if (row.sender_type === "human") return row.user_id ?? "unknown-human";
  if (row.sender_type === "ai") return `ai:${row.persona_id ?? "unknown"}`;
  return row.legacy_sender_id ?? "unknown-legacy";
}

function tupleCompare(left: Pick<MessageRow, "created_at" | "id">, right: Pick<MessageRow, "created_at" | "id">) {
  return left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id);
}

async function getBlockedSenderIds(
  supabase: SupabaseClient,
  roomId: string,
) {
  const { data, error } = await supabase
    .from("chat_user_blocks")
    .select("blocked_user_id,blocked_legacy_id")
    .eq("room_id", roomId);
  throwDatabaseError("read_blocks", error);
  const human = new Set<string>();
  const legacy = new Set<string>();
  for (const row of data ?? []) {
    if (row.blocked_user_id) human.add(row.blocked_user_id);
    if (row.blocked_legacy_id) legacy.add(row.blocked_legacy_id);
  }
  return { human, legacy };
}

function isBlocked(
  row: MessageRow,
  blocked: Awaited<ReturnType<typeof getBlockedSenderIds>>,
) {
  return (
    (row.sender_type === "human" && Boolean(row.user_id && blocked.human.has(row.user_id))) ||
    (row.sender_type === "legacy" && Boolean(row.legacy_sender_id && blocked.legacy.has(row.legacy_sender_id)))
  );
}

async function buildViews(
  supabase: SupabaseClient,
  rows: MessageRow[],
  blocked: Awaited<ReturnType<typeof getBlockedSenderIds>>,
) {
  const parentIds = [...new Set(rows.map((row) => row.reply_to_message_id).filter(Boolean))] as string[];
  const parentRows = new Map<string, MessageRow>();
  if (parentIds.length) {
    const { data, error } = await supabase
      .from("chat_messages")
      .select(MESSAGE_COLUMNS)
      .in("id", parentIds);
    throwDatabaseError("read_reply_targets", error);
    for (const row of (data ?? []) as unknown as MessageRow[]) parentRows.set(row.id, row);
  }

  const feedbackByMessage = new Map<string, StyleFeedbackRow>();
  const messageIds = rows.map((row) => row.id);
  if (messageIds.length) {
    const { data, error } = await supabase
      .from("chat_ai_style_feedback")
      .select("message_id,feedback_type,reasons,note,updated_at")
      .in("message_id", messageIds);
    throwDatabaseError("read_style_feedback", error);
    for (const row of (data ?? []) as StyleFeedbackRow[]) feedbackByMessage.set(row.message_id, row);
  }

  return rows.map((row): ChatMessageView => {
    const parent = row.reply_to_message_id ? parentRows.get(row.reply_to_message_id) : undefined;
    const parentBlocked = parent ? isBlocked(parent, blocked) : false;
    const feedback = feedbackByMessage.get(row.id);
    return {
      id: row.id,
      roomId: row.room_id,
      senderId: senderId(row),
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
      replyTo: parent
        ? {
            id: parent.id,
            senderName: parentBlocked ? "已屏蔽用户" : parent.sender_name_snapshot,
            content: parent.status === "deleted" || parentBlocked ? "" : parent.content,
            status: parent.status === "deleted" || parentBlocked ? "deleted" : parent.status,
          }
        : null,
      styleFeedback: feedback
        ? {
            type: feedback.feedback_type,
            reasons: feedback.reasons,
            note: feedback.note,
            updatedAt: feedback.updated_at,
          }
        : null,
    };
  });
}

async function getMessageRow(
  supabase: SupabaseClient,
  roomId: string,
  messageId: string,
) {
  const { data, error } = await supabase
    .from("chat_messages")
    .select(MESSAGE_COLUMNS)
    .eq("room_id", roomId)
    .eq("id", messageId)
    .maybeSingle();
  throwDatabaseError("read_message", error);
  return data as MessageRow | null;
}

export async function listSupabaseChatMessages(input: {
  supabase: SupabaseClient;
  roomId: string;
  limit: number;
  beforeId?: string;
  afterId?: string;
  updatedAfter?: string;
}) {
  const { supabase, roomId } = input;
  const blocked = await getBlockedSenderIds(supabase, roomId);
  const cursor = input.beforeId || input.afterId
    ? await getMessageRow(supabase, roomId, input.beforeId ?? input.afterId!)
    : null;
  const fetchLimit = Math.min(500, Math.max(101, input.limit * 5 + 1));
  let query = supabase.from("chat_messages").select(MESSAGE_COLUMNS).eq("room_id", roomId);

  if (input.beforeId && cursor) {
    query = query.lte("created_at", cursor.created_at);
  } else if (input.afterId && cursor) {
    query = query.gte("created_at", cursor.created_at);
  }

  const ascending = Boolean(input.afterId);
  const { data, error } = await query
    .order("created_at", { ascending })
    .order("id", { ascending })
    .limit(fetchLimit);
  throwDatabaseError("list_messages", error);

  const combinedRows = new Map(
    ((data ?? []) as unknown as MessageRow[]).map((row) => [row.id, row]),
  );
  if (input.afterId && input.updatedAfter && cursor) {
    const { data: changedData, error: changedError } = await supabase
      .from("chat_messages")
      .select(MESSAGE_COLUMNS)
      .eq("room_id", roomId)
      .gt("updated_at", input.updatedAfter)
      .lte("created_at", cursor.created_at)
      .order("updated_at", { ascending: true })
      .limit(fetchLimit);
    throwDatabaseError("list_changed_messages", changedError);
    for (const row of (changedData ?? []) as unknown as MessageRow[]) combinedRows.set(row.id, row);
  }

  let candidates = [...combinedRows.values()]
    .filter((row) => !isBlocked(row, blocked))
    .sort(tupleCompare);
  if (cursor && input.beforeId) candidates = candidates.filter((row) => tupleCompare(row, cursor) < 0);
  if (cursor && input.afterId) {
    candidates = candidates.filter((row) =>
      tupleCompare(row, cursor) > 0 || row.updated_at > (input.updatedAfter ?? row.updated_at),
    );
  }
  const hasMore = candidates.length > input.limit || (data?.length ?? 0) === fetchLimit;
  let page = candidates.slice(0, input.limit);
  if (!input.afterId) page = page.sort((left, right) => tupleCompare(right, left)).slice(0, input.limit).reverse();

  return { messages: await buildViews(supabase, page, blocked), hasMore };
}

export async function createSupabaseChatMessage(input: {
  supabase: SupabaseClient;
  identity: ChatIdentity;
  roomId: string;
  content: string;
  replyToMessageId?: string;
}) {
  if (input.replyToMessageId) {
    const parent = await getMessageRow(input.supabase, input.roomId, input.replyToMessageId);
    if (!parent) throw new Error("REPLY_MESSAGE_NOT_FOUND");
    if (parent.status === "deleted") throw new Error("REPLY_MESSAGE_DELETED");
  }
  const { data, error } = await input.supabase
    .from("chat_messages")
    .insert({
      room_id: input.roomId,
      sender_type: "human",
      user_id: input.identity.id,
      sender_name_snapshot: input.identity.name,
      content: input.content,
      reply_to_message_id: input.replyToMessageId ?? null,
    })
    .select(MESSAGE_COLUMNS)
    .single();
  throwDatabaseError("create_message", error);
  if (!data) throw new Error("SUPABASE_CREATE_MESSAGE_EMPTY");
  const row = data as unknown as MessageRow;
  return (await buildViews(input.supabase, [row], { human: new Set(), legacy: new Set() }))[0];
}

export async function getSupabasePublicChatRoomPreview(input: {
  supabase: SupabaseClient;
  roomId: string;
  limit: number;
}) {
  const limit = Math.max(1, Math.min(input.limit, 10));
  const { data, error } = await input.supabase
    .from("chat_messages")
    .select(MESSAGE_COLUMNS)
    .eq("room_id", input.roomId)
    .eq("status", "normal")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  throwDatabaseError("read_public_preview", error);
  const rows = ((data ?? []) as unknown as MessageRow[]).reverse();
  return rows.map((row): ChatMessageView => ({
    id: row.id,
    roomId: row.room_id,
    senderId: senderId(row),
    senderType: row.sender_type,
    senderName: row.sender_name_snapshot,
    senderAvatar: row.sender_avatar_snapshot ?? undefined,
    personaId: row.persona_id ?? undefined,
    personaVersion: row.persona_version ?? undefined,
    content: row.content,
    replyToMessageId: row.reply_to_message_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    replyTo: null,
    styleFeedback: null,
  }));
}

export async function deleteSupabaseOwnChatMessage(input: {
  supabase: SupabaseClient;
  identity: ChatIdentity;
  roomId: string;
  messageId: string;
}) {
  const existing = await getMessageRow(input.supabase, input.roomId, input.messageId);
  if (!existing) throw new Error("CHAT_MESSAGE_NOT_FOUND");
  if (existing.sender_type !== "human" || existing.user_id !== input.identity.id) {
    throw new Error("CHAT_MESSAGE_DELETE_FORBIDDEN");
  }
  if (existing.status === "deleted") {
    return (await buildViews(input.supabase, [existing], { human: new Set(), legacy: new Set() }))[0];
  }
  const { data, error } = await input.supabase.rpc("delete_own_chat_message", {
    p_room_id: input.roomId,
    p_message_id: input.messageId,
  });
  throwDatabaseError("delete_message", error);
  if (!data) throw new Error("SUPABASE_DELETE_MESSAGE_EMPTY");
  const row = (Array.isArray(data) ? data[0] : data) as unknown as MessageRow;
  return (await buildViews(input.supabase, [row], { human: new Set(), legacy: new Set() }))[0];
}

export async function upsertSupabaseChatMessageReport(input: {
  supabase: SupabaseClient;
  identity: ChatIdentity;
  roomId: string;
  messageId: string;
  reason: ChatReportReason;
  note: string;
}) {
  const message = await getMessageRow(input.supabase, input.roomId, input.messageId);
  if (!message || message.status !== "normal") throw new Error("CHAT_MESSAGE_NOT_FOUND");
  if (message.sender_type === "human" && message.user_id === input.identity.id) {
    throw new Error("CHAT_REPORT_OWN_MESSAGE");
  }
  const { data: existing, error: readError } = await input.supabase
    .from("chat_message_reports")
    .select("id")
    .eq("message_id", message.id)
    .eq("reporter_user_id", input.identity.id)
    .maybeSingle();
  throwDatabaseError("read_report", readError);
  const values = {
    room_id: input.roomId,
    message_id: message.id,
    reporter_user_id: input.identity.id,
    reporter_legacy_id: null,
    reported_user_id: message.sender_type === "human" ? message.user_id : null,
    reported_persona_id: message.sender_type === "ai" ? message.persona_id : null,
    reported_legacy_id: message.sender_type === "legacy" ? message.legacy_sender_id : null,
    reason: input.reason,
    note: input.note.trim(),
    status: "pending",
  };
  const query = existing
    ? input.supabase.from("chat_message_reports").update(values).eq("id", existing.id)
    : input.supabase.from("chat_message_reports").insert(values);
  const { data, error } = await query.select("*").single();
  throwDatabaseError("save_report", error);
  return data;
}

export async function blockSupabaseChatSender(input: {
  supabase: SupabaseClient;
  identity: ChatIdentity;
  roomId: string;
  messageId: string;
}) {
  const message = await getMessageRow(input.supabase, input.roomId, input.messageId);
  if (!message || message.status !== "normal") throw new Error("CHAT_MESSAGE_NOT_FOUND");
  if (message.sender_type === "ai") throw new Error("CHAT_BLOCK_AI_UNSUPPORTED");
  if (message.sender_type === "human" && message.user_id === input.identity.id) {
    throw new Error("CHAT_BLOCK_SELF");
  }
  let existingQuery = input.supabase
    .from("chat_user_blocks")
    .select("*")
    .eq("room_id", input.roomId)
    .eq("blocker_user_id", input.identity.id);
  existingQuery = message.sender_type === "human"
    ? existingQuery.eq("blocked_user_id", message.user_id!)
    : existingQuery.eq("blocked_legacy_id", message.legacy_sender_id!);
  const { data: existing, error: readError } = await existingQuery.maybeSingle();
  throwDatabaseError("read_block", readError);
  if (existing) return existing;
  const { data, error } = await input.supabase
    .from("chat_user_blocks")
    .insert({
      room_id: input.roomId,
      blocker_user_id: input.identity.id,
      blocker_legacy_id: null,
      blocked_user_id: message.sender_type === "human" ? message.user_id : null,
      blocked_legacy_id: message.sender_type === "legacy" ? message.legacy_sender_id : null,
    })
    .select("*")
    .single();
  throwDatabaseError("save_block", error);
  return data;
}

export async function upsertSupabaseChatAiStyleFeedback(input: {
  supabase: SupabaseClient;
  identity: ChatIdentity;
  roomId: string;
  messageId: string;
  type: "like" | "dislike";
  reasons: StyleReasonCode[];
  note: string;
}) {
  const message = await getMessageRow(input.supabase, input.roomId, input.messageId);
  if (!message || message.status !== "normal") throw new Error("CHAT_MESSAGE_NOT_FOUND");
  if (message.sender_type !== "ai" || !message.persona_id || !message.model_config_snapshot) {
    throw new Error("CHAT_STYLE_FEEDBACK_AI_ONLY");
  }
  const model = typeof message.model_config_snapshot.model === "string"
    ? message.model_config_snapshot.model
    : "unknown";
  const values = {
    room_id: input.roomId,
    message_id: message.id,
    persona_id: message.persona_id,
    model,
    prompt_version: message.prompt_version ?? "unknown",
    user_id: input.identity.id,
    legacy_user_id: null,
    feedback_type: input.type,
    reasons: input.type === "dislike" ? input.reasons : [],
    note: input.note.trim(),
  };
  const { data: existing, error: readError } = await input.supabase
    .from("chat_ai_style_feedback")
    .select("id")
    .eq("message_id", message.id)
    .eq("user_id", input.identity.id)
    .maybeSingle();
  throwDatabaseError("read_style_feedback", readError);
  const query = existing
    ? input.supabase.from("chat_ai_style_feedback").update(values).eq("id", existing.id)
    : input.supabase.from("chat_ai_style_feedback").insert(values);
  const { data, error } = await query
    .select("feedback_type,reasons,note,updated_at")
    .single();
  throwDatabaseError("save_style_feedback", error);
  if (!data) throw new Error("SUPABASE_STYLE_FEEDBACK_EMPTY");
  return {
    type: data.feedback_type as "like" | "dislike",
    reasons: data.reasons as StyleReasonCode[],
    note: data.note as string,
    updatedAt: data.updated_at as string,
  };
}
