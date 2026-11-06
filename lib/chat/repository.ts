import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  blockChatSender as blockJsonChatSender,
  createChatMessage as createJsonChatMessage,
  deleteOwnChatMessage as deleteJsonOwnChatMessage,
  getChatRoomPreview as getJsonChatRoomPreview,
  listChatMessages as listJsonChatMessages,
  upsertChatAiStyleFeedback as upsertJsonChatAiStyleFeedback,
  upsertChatMessageReport as upsertJsonChatMessageReport,
} from "@/lib/ai-lab/storage";
import type { ChatReportReason, StyleReasonCode } from "@/lib/ai-lab/types";
import { getEchoDataBackend, type EchoDataBackend } from "@/lib/supabase/config";
import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";
import {
  blockSupabaseChatSender,
  createSupabaseChatMessage,
  deleteSupabaseOwnChatMessage,
  getSupabasePublicChatRoomPreview,
  listSupabaseChatMessages,
  upsertSupabaseChatAiStyleFeedback,
  upsertSupabaseChatMessageReport,
} from "./supabase-repository";
import {
  buildChatDisplayName,
  getOrCreateLegacyChatIdentity,
  type ChatIdentity,
} from "./identity";

export type ChatRequestContext = {
  backend: EchoDataBackend;
  identity: ChatIdentity;
  supabase?: SupabaseClient;
};

async function getOrCreateSupabaseIdentity(supabase: SupabaseClient): Promise<ChatIdentity> {
  const claimsResult = await supabase.auth.getClaims();
  let userId = typeof claimsResult.data?.claims?.sub === "string"
    ? claimsResult.data.claims.sub
    : null;

  if (!userId) {
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error || !data.user) {
      console.error("Supabase anonymous sign-in failed", {
        code: error?.code,
        message: error?.message,
      });
      throw new Error("SUPABASE_ANONYMOUS_SIGN_IN_FAILED");
    }
    userId = data.user.id;
    const generatedName = buildChatDisplayName(userId);
    const { error: profileError } = await supabase
      .from("profiles")
      .update({ display_name: generatedName })
      .eq("id", userId);
    if (profileError) {
      console.error("Supabase profile initialization failed", {
        code: profileError.code,
        message: profileError.message,
      });
      throw new Error("SUPABASE_PROFILE_INITIALIZATION_FAILED");
    }
    return { id: userId, name: generatedName };
  }

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", userId)
    .single();
  if (error || !profile?.display_name) {
    console.error("Supabase profile lookup failed", { code: error?.code, message: error?.message });
    throw new Error("SUPABASE_PROFILE_LOOKUP_FAILED");
  }
  return { id: userId, name: profile.display_name };
}

export async function getChatRequestContext(): Promise<ChatRequestContext> {
  const backend = getEchoDataBackend();
  if (backend === "json") {
    return { backend, identity: await getOrCreateLegacyChatIdentity() };
  }
  const supabase = await createSupabaseServerClient();
  const identity = await getOrCreateSupabaseIdentity(supabase);
  return { backend, identity, supabase };
}

function requireSupabase(context: ChatRequestContext) {
  if (!context.supabase) throw new Error("SUPABASE_REQUEST_CONTEXT_MISSING");
  return context.supabase;
}

export async function listChatMessages(
  context: ChatRequestContext,
  input: {
    roomId: string;
    limit: number;
    beforeId?: string;
    afterId?: string;
    updatedAfter?: string;
  },
) {
  if (context.backend === "json") {
    return listJsonChatMessages({
      roomId: input.roomId,
      limit: input.limit,
      beforeId: input.beforeId,
      afterId: input.afterId,
      viewerUserId: context.identity.id,
    });
  }
  return listSupabaseChatMessages({
    ...input,
    supabase: requireSupabase(context),
  });
}

export async function createChatMessage(
  context: ChatRequestContext,
  input: {
    roomId: string;
    content: string;
    replyToMessageId?: string;
    clientRequestId?: string;
  },
) {
  if (context.backend === "json") {
    return createJsonChatMessage({
      ...input,
      senderId: context.identity.id,
      senderType: "human",
      senderName: context.identity.name,
    });
  }
  return createSupabaseChatMessage({
    ...input,
    identity: context.identity,
    supabase: requireSupabase(context),
  });
}

export async function getPublicChatRoomPreview(input: { roomId: string; limit: number }) {
  const backend = getEchoDataBackend();
  if (backend === "json") {
    const identity = await getOrCreateLegacyChatIdentity();
    return getJsonChatRoomPreview({ ...input, viewerUserId: identity.id });
  }
  const supabase = await createSupabaseServerClient();
  return getSupabasePublicChatRoomPreview({ ...input, supabase });
}

export async function deleteOwnChatMessage(
  context: ChatRequestContext,
  input: { roomId: string; messageId: string },
) {
  if (context.backend === "json") {
    return deleteJsonOwnChatMessage({ ...input, userId: context.identity.id });
  }
  return deleteSupabaseOwnChatMessage({
    ...input,
    identity: context.identity,
    supabase: requireSupabase(context),
  });
}

export async function upsertChatMessageReport(
  context: ChatRequestContext,
  input: { roomId: string; messageId: string; reason: ChatReportReason; note: string },
) {
  if (context.backend === "json") {
    return upsertJsonChatMessageReport({ ...input, reporterId: context.identity.id });
  }
  return upsertSupabaseChatMessageReport({
    ...input,
    identity: context.identity,
    supabase: requireSupabase(context),
  });
}

export async function blockChatSender(
  context: ChatRequestContext,
  input: { roomId: string; messageId: string },
) {
  if (context.backend === "json") {
    return blockJsonChatSender({ ...input, blockerId: context.identity.id });
  }
  return blockSupabaseChatSender({
    ...input,
    identity: context.identity,
    supabase: requireSupabase(context),
  });
}

export async function upsertChatAiStyleFeedback(
  context: ChatRequestContext,
  input: {
    roomId: string;
    messageId: string;
    type: "like" | "dislike";
    reasons: StyleReasonCode[];
    note: string;
  },
) {
  if (context.backend === "json") {
    return upsertJsonChatAiStyleFeedback({ ...input, userId: context.identity.id });
  }
  return upsertSupabaseChatAiStyleFeedback({
    ...input,
    identity: context.identity,
    supabase: requireSupabase(context),
  });
}
