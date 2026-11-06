import "server-only";

import {
  claimDueChatAiTasks as claimJsonDueChatAiTasks,
  completeChatAiTask as completeJsonChatAiTask,
  createChatAiTasks as createJsonChatAiTasks,
  failChatAiTask as failJsonChatAiTask,
  getChatAiPlanningContext as getJsonChatAiPlanningContext,
  getChatAiTaskContext as getJsonChatAiTaskContext,
  getChatAiTaskDiagnostics as getJsonChatAiTaskDiagnostics,
} from "@/lib/ai-lab/storage";
import { getEchoDataBackend } from "@/lib/supabase/config";
import {
  claimSupabaseDueChatAiTasks,
  completeSupabaseChatAiTask,
  createSupabaseChatAiTasks,
  failSupabaseChatAiTask,
  getSupabaseChatAiPlanningContext,
  getSupabaseChatAiTaskContext,
  getSupabaseChatAiTaskDiagnostics,
} from "./supabase-ai-task-repository";

export async function getChatAiPlanningContext(messageId: string, recentLimit = 30) {
  return getEchoDataBackend() === "supabase"
    ? getSupabaseChatAiPlanningContext(messageId, recentLimit)
    : getJsonChatAiPlanningContext(messageId, recentLimit);
}

export async function createChatAiTasks(input: Parameters<typeof createJsonChatAiTasks>[0]) {
  return getEchoDataBackend() === "supabase"
    ? createSupabaseChatAiTasks(input)
    : createJsonChatAiTasks(input);
}

export async function claimDueChatAiTasks(input: Parameters<typeof claimJsonDueChatAiTasks>[0]) {
  return getEchoDataBackend() === "supabase"
    ? claimSupabaseDueChatAiTasks(input)
    : claimJsonDueChatAiTasks(input);
}

export async function getChatAiTaskContext(
  ...input: Parameters<typeof getJsonChatAiTaskContext>
) {
  return getEchoDataBackend() === "supabase"
    ? getSupabaseChatAiTaskContext(...input)
    : getJsonChatAiTaskContext(...input);
}

export async function completeChatAiTask(input: Parameters<typeof completeJsonChatAiTask>[0]) {
  return getEchoDataBackend() === "supabase"
    ? completeSupabaseChatAiTask(input)
    : completeJsonChatAiTask(input);
}

export async function failChatAiTask(input: Parameters<typeof failJsonChatAiTask>[0]) {
  return getEchoDataBackend() === "supabase"
    ? failSupabaseChatAiTask(input)
    : failJsonChatAiTask(input);
}

export async function getChatAiTaskDiagnostics() {
  return getEchoDataBackend() === "supabase"
    ? getSupabaseChatAiTaskDiagnostics()
    : getJsonChatAiTaskDiagnostics();
}
