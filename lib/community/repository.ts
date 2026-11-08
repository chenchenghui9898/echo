import "server-only";

import {
  claimDueCommentTasks as claimJsonTasks,
  completeCommentTask as completeJsonTask,
  createScheduledPost as createJsonPost,
  deleteCommunityPost as deleteJsonPost,
  failCommentTask as failJsonTask,
  getCommentTaskContext as getJsonTaskContext,
  getCommunityPost as getJsonPost,
  getSchedulerDiagnostics as getJsonDiagnostics,
  listCommunityPosts as listJsonPosts,
} from "@/lib/ai-lab/storage";
import { getChatRequestContext } from "@/lib/chat/repository";
import { getEchoDataBackend } from "@/lib/supabase/config";
import {
  claimDueSupabaseCommentTasks,
  completeSupabaseCommentTask,
  createSupabaseScheduledPost,
  deleteSupabaseCommunityPost,
  failSupabaseCommentTask,
  getSupabaseCommentTaskContext,
  getSupabaseCommunityPost,
  getSupabaseSchedulerDiagnostics,
  listSupabaseCommunityPosts,
} from "./supabase-repository";

export async function getCommunityRequestContext() {
  return getChatRequestContext();
}

export async function listCommunityPosts() {
  return getEchoDataBackend() === "supabase"
    ? listSupabaseCommunityPosts()
    : listJsonPosts();
}

export async function getCommunityPost(postId: string) {
  return getEchoDataBackend() === "supabase"
    ? getSupabaseCommunityPost(postId)
    : getJsonPost(postId);
}

export async function createScheduledPost(
  context: Awaited<ReturnType<typeof getCommunityRequestContext>>,
  input: Parameters<typeof createJsonPost>[0],
) {
  if (context.backend === "json") return createJsonPost(input);
  return createSupabaseScheduledPost({
    ...input,
    userId: context.identity.id,
  });
}

export async function deleteCommunityPost(
  context: Awaited<ReturnType<typeof getCommunityRequestContext>>,
  postId: string,
) {
  return context.backend === "supabase"
    ? deleteSupabaseCommunityPost(postId, context.identity.id)
    : deleteJsonPost(postId);
}

export async function claimDueCommentTasks(input: Parameters<typeof claimJsonTasks>[0]) {
  return getEchoDataBackend() === "supabase"
    ? claimDueSupabaseCommentTasks(input)
    : claimJsonTasks(input);
}

export async function getCommentTaskContext(taskId: string, executionToken: string) {
  return getEchoDataBackend() === "supabase"
    ? getSupabaseCommentTaskContext(taskId, executionToken)
    : getJsonTaskContext(taskId, executionToken);
}

export async function completeCommentTask(input: Parameters<typeof completeJsonTask>[0]) {
  return getEchoDataBackend() === "supabase"
    ? completeSupabaseCommentTask(input)
    : completeJsonTask(input);
}

export async function failCommentTask(input: Parameters<typeof failJsonTask>[0]) {
  return getEchoDataBackend() === "supabase"
    ? failSupabaseCommentTask(input)
    : failJsonTask(input);
}

export async function getSchedulerDiagnostics(postId?: string) {
  return getEchoDataBackend() === "supabase"
    ? getSupabaseSchedulerDiagnostics(postId)
    : getJsonDiagnostics(postId);
}
