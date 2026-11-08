import "server-only";

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  CommentRecord,
  CommentTask,
  CommunityPostDetail,
  ContentAnalysisRecord,
  GenerationRun,
  InteractionPromptVersion,
  ModelConfigSnapshot,
  PostContentType,
  TokenUsage,
  WorkInput,
} from "@/lib/ai-lab/types";
import { buildSystemPrompt } from "@/lib/ai-lab/prompt-default";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getCommunityPersona } from "./personas";

type JsonObject = Record<string, unknown>;
type DatabaseError = { code?: string; message: string } | null;

function throwDatabaseError(operation: string, error: DatabaseError) {
  if (!error) return;
  console.error(`Supabase ${operation} failed`, { code: error.code, message: error.message });
  throw new Error(`SUPABASE_${operation.toUpperCase()}_FAILED`);
}

function contentTypeToDatabase(type: PostContentType) {
  if (type === "观点") return "viewpoint";
  if (type === "作品") return "work";
  if (type === "日记") return "diary";
  throw new Error("UNSUPPORTED_POST_CONTENT_TYPE");
}

function contentTypeFromDatabase(type: string): PostContentType {
  if (type === "viewpoint") return "观点";
  if (type === "work") return "作品";
  return "日记";
}

function mapTask(row: JsonObject): CommentTask {
  return {
    id: String(row.id),
    postId: String(row.post_id),
    personaId: String(row.persona_id),
    scheduledAt: String(row.scheduled_at),
    status: row.status as CommentTask["status"],
    generatedAt: row.generated_at ? String(row.generated_at) : undefined,
    commentId: row.comment_id ? String(row.comment_id) : undefined,
    retryCount: Number(row.retry_count),
    createdAt: String(row.created_at),
    startedAt: row.started_at ? String(row.started_at) : undefined,
    executionToken: row.execution_token ? String(row.execution_token) : undefined,
    lastError: row.last_error ? String(row.last_error) : undefined,
    contentAnalysisId: row.content_analysis_id ? String(row.content_analysis_id) : undefined,
    strategyPromptSnapshot: row.strategy_prompt_snapshot as InteractionPromptVersion | undefined,
  };
}

function mapRun(row: JsonObject): GenerationRun {
  return {
    id: String(row.id),
    workId: String(row.input_id),
    promptVersionId: String(row.prompt_version_id),
    promptSnapshot: row.prompt_snapshot as InteractionPromptVersion,
    systemPromptSnapshot: String(row.system_prompt_snapshot),
    modelConfig: row.model_config_snapshot as ModelConfigSnapshot,
    status: row.status as GenerationRun["status"],
    errorMessage: row.error_message ? String(row.error_message) : undefined,
    usage: row.token_usage as TokenUsage | undefined,
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : undefined,
    contentAnalysisId: row.content_analysis_id ? String(row.content_analysis_id) : undefined,
  };
}

function mapAnalysis(row: JsonObject): ContentAnalysisRecord {
  return {
    id: String(row.id),
    workId: String(row.input_id),
    postId: String(row.post_id),
    analysis: row.analysis as ContentAnalysisRecord["analysis"],
    promptSnapshot: row.prompt_snapshot as InteractionPromptVersion,
    modelConfig: row.model_config_snapshot as ModelConfigSnapshot,
    usage: row.token_usage as TokenUsage | undefined,
    source: row.source as ContentAnalysisRecord["source"],
    errorMessage: row.error_message ? String(row.error_message) : undefined,
    createdAt: String(row.created_at),
  };
}

function mapComment(row: JsonObject): CommentRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    position: Number(row.position),
    content: String(row.content),
    persona: row.persona_snapshot as CommentRecord["persona"],
    trigger: row.trigger as CommentRecord["trigger"],
    parentCommentId: row.parent_comment_id ? String(row.parent_comment_id) : undefined,
    triggerFeedbackId: row.trigger_feedback_id ? String(row.trigger_feedback_id) : undefined,
    scheduledTaskId: row.scheduled_task_id ? String(row.scheduled_task_id) : undefined,
    contentAnalysisId: row.content_analysis_id ? String(row.content_analysis_id) : undefined,
    strategyPromptSnapshot: row.strategy_prompt_snapshot as InteractionPromptVersion | undefined,
    modelConfig: row.model_config_snapshot as ModelConfigSnapshot | undefined,
    usage: row.token_usage as TokenUsage | undefined,
    createdAt: String(row.created_at),
  };
}

async function loadDetails(
  supabase: SupabaseClient,
  postId?: string,
): Promise<CommunityPostDetail[]> {
  let postQuery = supabase
    .from("posts")
    .select("id,user_id,content_type,title,body,published_at,deleted_at")
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .order("id", { ascending: false });
  if (postId) postQuery = postQuery.eq("id", postId);
  const { data: postRows, error: postError } = await postQuery;
  throwDatabaseError("read_community_posts", postError);
  if (!postRows?.length) return [];

  const postIds = postRows.map((row) => row.id);
  const userIds = [...new Set(postRows.map((row) => row.user_id))];
  const [profilesResult, inputsResult, runsResult, analysesResult, commentsResult, tasksResult] =
    await Promise.all([
      supabase.from("profiles").select("id,display_name").in("id", userIds),
      supabase.from("post_inputs").select("*").in("post_id", postIds),
      supabase.from("post_generation_runs").select("*").in("post_id", postIds),
      supabase.from("post_content_analyses").select("*").in("post_id", postIds),
      supabase.from("post_comments").select("*").in("post_id", postIds)
        .order("created_at", { ascending: true }).order("id", { ascending: true }),
      supabase.from("post_comment_tasks").select("*").in("post_id", postIds),
    ]);
  throwDatabaseError("read_post_profiles", profilesResult.error);
  throwDatabaseError("read_post_inputs", inputsResult.error);
  throwDatabaseError("read_post_runs", runsResult.error);
  throwDatabaseError("read_post_analyses", analysesResult.error);
  throwDatabaseError("read_post_comments", commentsResult.error);
  throwDatabaseError("read_post_tasks", tasksResult.error);

  const profiles = new Map((profilesResult.data ?? []).map((row) => [row.id, row.display_name]));
  const inputs = new Map((inputsResult.data ?? []).map((row) => [row.post_id, row]));
  const runs = new Map((runsResult.data ?? []).map((row) => [row.post_id, row]));
  const analyses = new Map((analysesResult.data ?? []).map((row) => [row.post_id, row]));
  const commentsByPost = new Map<string, JsonObject[]>();
  for (const row of (commentsResult.data ?? []) as JsonObject[]) {
    const rows = commentsByPost.get(String(row.post_id)) ?? [];
    rows.push(row);
    commentsByPost.set(String(row.post_id), rows);
  }
  const tasksByPost = new Map<string, JsonObject[]>();
  for (const row of (tasksResult.data ?? []) as JsonObject[]) {
    const rows = tasksByPost.get(String(row.post_id)) ?? [];
    rows.push(row);
    tasksByPost.set(String(row.post_id), rows);
  }

  return postRows.flatMap((postRow) => {
    const inputRow = inputs.get(postRow.id) as JsonObject | undefined;
    const runRow = runs.get(postRow.id) as JsonObject | undefined;
    if (!inputRow || !runRow) return [];
    const work: WorkInput = {
      id: String(inputRow.id),
      content: String(inputRow.content),
      characterCount: Number(inputRow.character_count),
      createdAt: String(inputRow.created_at),
    };
    const taskRows = tasksByPost.get(postRow.id) ?? [];
    const comments = (commentsByPost.get(postRow.id) ?? []).map((row) => {
      const comment = mapComment(row);
      return {
        ...comment,
        role: comment.persona.role ?? getCommunityPersona(comment.persona.id)?.role ?? "AI 评论者",
        evaluation: null,
        contentReaction: null,
        userReplies: [],
        styleFeedback: null,
      };
    });
    return [{
      post: {
        id: postRow.id,
        workId: work.id,
        runId: String(runRow.id),
        type: contentTypeFromDatabase(postRow.content_type),
        title: postRow.title ?? undefined,
        author: profiles.get(postRow.user_id) ?? "Echo 用户",
        publishedAt: postRow.published_at,
        plannedCommentCount: taskRows.length,
      },
      work,
      comments,
      pendingCommentCount: taskRows.filter((row) => row.status === "pending" || row.status === "running").length,
      failedCommentCount: taskRows.filter((row) => row.status === "failed").length,
      contentAnalysis: analyses.has(postRow.id)
        ? mapAnalysis(analyses.get(postRow.id) as JsonObject)
        : null,
    } satisfies CommunityPostDetail];
  });
}

export async function listSupabaseCommunityPosts() {
  return loadDetails(createSupabaseAdminClient());
}

export async function getSupabaseCommunityPost(postId: string) {
  return (await loadDetails(createSupabaseAdminClient(), postId))[0] ?? null;
}

export async function createSupabaseScheduledPost(input: {
  userId: string;
  type: PostContentType;
  title?: string;
  content: string;
  finalPrompt: InteractionPromptVersion;
  commentModelConfig: ModelConfigSnapshot;
  analysisModelConfig: ModelConfigSnapshot;
  plan: Array<{ personaId: string; scheduledAt: string }>;
  analysis: ContentAnalysisRecord["analysis"];
  analysisPrompt: InteractionPromptVersion;
  analysisUsage?: TokenUsage;
  analysisSource: ContentAnalysisRecord["source"];
  analysisErrorMessage?: string;
  strategyPrompt: InteractionPromptVersion;
}) {
  const postId = randomUUID();
  const inputId = randomUUID();
  const analysisId = randomUUID();
  const runId = randomUUID();
  const tasks = input.plan.map((item) => ({ id: randomUUID(), ...item }));
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.rpc("create_community_post_bundle", {
    p_post_id: postId,
    p_user_id: input.userId,
    p_content_type: contentTypeToDatabase(input.type),
    p_title: input.title ?? "",
    p_body: input.content,
    p_input_id: inputId,
    p_analysis_id: analysisId,
    p_analysis: input.analysis,
    p_analysis_prompt: input.analysisPrompt,
    p_analysis_model_config: { ...input.analysisModelConfig, commentCount: 1 },
    p_analysis_usage: input.analysisUsage ?? null,
    p_analysis_source: input.analysisSource,
    p_analysis_error: input.analysisErrorMessage ?? "",
    p_run_id: runId,
    p_prompt_version_id: input.finalPrompt.id,
    p_prompt_snapshot: input.finalPrompt,
    p_system_prompt: buildSystemPrompt(input.finalPrompt.body),
    p_comment_model_config: { ...input.commentModelConfig, commentCount: 1 },
    p_tasks: tasks,
    p_strategy_prompt: input.strategyPrompt,
  });
  throwDatabaseError("create_community_post", error);
  const detail = await getSupabaseCommunityPost(postId);
  if (!detail) throw new Error("SUPABASE_CREATED_POST_NOT_FOUND");
  return detail;
}

export async function deleteSupabaseCommunityPost(postId: string, userId: string) {
  const { data, error } = await createSupabaseAdminClient().rpc("delete_community_post", {
    p_post_id: postId,
    p_user_id: userId,
  });
  throwDatabaseError("delete_community_post", error);
  return data === true;
}

export async function claimDueSupabaseCommentTasks(input: {
  limit: number;
  staleRunningMs: number;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const { data, error } = await createSupabaseAdminClient().rpc("claim_due_post_comment_tasks", {
    p_limit: input.limit,
    p_stale_before: new Date(now.getTime() - input.staleRunningMs).toISOString(),
    p_now: now.toISOString(),
  });
  throwDatabaseError("claim_post_comment_tasks", error);
  return ((data ?? []) as JsonObject[]).map(mapTask);
}

export async function getSupabaseCommentTaskContext(taskId: string, executionToken: string) {
  const supabase = createSupabaseAdminClient();
  const { data: taskRow, error } = await supabase.from("post_comment_tasks").select("*")
    .eq("id", taskId).eq("status", "running").eq("execution_token", executionToken).maybeSingle();
  throwDatabaseError("read_post_comment_task", error);
  if (!taskRow) return null;
  const detail = await getSupabaseCommunityPost(taskRow.post_id);
  if (!detail) return null;
  const { data: runRow, error: runError } = await supabase.from("post_generation_runs")
    .select("*").eq("post_id", taskRow.post_id).single();
  throwDatabaseError("read_post_generation_run", runError);
  return {
    task: mapTask(taskRow as JsonObject),
    post: detail.post,
    work: detail.work,
    run: mapRun(runRow as JsonObject),
    existingComments: detail.comments,
    contentAnalysis: detail.contentAnalysis ?? undefined,
  };
}

export async function completeSupabaseCommentTask(input: {
  taskId: string;
  executionToken: string;
  content: string;
  persona: CommentRecord["persona"];
  usage?: TokenUsage;
}) {
  const { data, error } = await createSupabaseAdminClient().rpc("complete_post_comment_task", {
    p_task_id: input.taskId,
    p_execution_token: input.executionToken,
    p_content: input.content,
    p_persona_snapshot: input.persona,
    p_token_usage: input.usage ?? null,
  });
  throwDatabaseError("complete_post_comment_task", error);
  const row = (data as JsonObject[] | null)?.[0];
  return row ? mapComment(row) : null;
}

export async function failSupabaseCommentTask(input: {
  taskId: string;
  executionToken: string;
  errorMessage: string;
  maxRetries: number;
  retryAt: string;
}) {
  const { data, error } = await createSupabaseAdminClient().rpc("fail_post_comment_task", {
    p_task_id: input.taskId,
    p_execution_token: input.executionToken,
    p_error_message: input.errorMessage,
    p_max_retries: input.maxRetries,
    p_retry_at: input.retryAt,
  });
  throwDatabaseError("fail_post_comment_task", error);
  const row = (data as JsonObject[] | null)?.[0];
  return row ? mapTask(row) : null;
}

export async function getSupabaseSchedulerDiagnostics(postId?: string) {
  let query = createSupabaseAdminClient().from("post_comment_tasks").select("*")
    .order("scheduled_at", { ascending: true }).order("id", { ascending: true });
  if (postId) query = query.eq("post_id", postId);
  const { data, error } = await query;
  throwDatabaseError("read_post_comment_diagnostics", error);
  return ((data ?? []) as JsonObject[]).map(mapTask);
}
