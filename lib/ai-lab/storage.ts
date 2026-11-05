import "server-only";

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { getCommunityPersona } from "@/lib/community/personas";
import { INTERACTION_PROMPT_DEFAULTS } from "@/lib/community/prompt-defaults";
import { PUBLIC_MOOD_ROOM_ID, PUBLIC_MOOD_ROOM_NAME } from "@/lib/chat/config";
import { DEFAULT_PERSONA } from "./persona";
import {
  isReplyRateLimited,
  shouldGenerateAgreementFollowUp,
} from "./feedback-rules";
import {
  buildSystemPrompt,
  DEFAULT_PROMPT_BODY,
  DEFAULT_PROMPT_NAME,
} from "./prompt-default";
import type {
  CommentEvaluation,
  ChatAiStyleFeedback,
  ChatMessage,
  ChatMessageReport,
  ChatMessageView,
  ChatAiTask,
  ChatReportReason,
  ChatUserBlock,
  CommentRecord,
  CommentTask,
  CommentTrigger,
  ContentAnalysis,
  ContentAnalysisRecord,
  CommunityPost,
  CommunityPostDetail,
  ContentFeedback,
  GenerationRun,
  LabDatabase,
  ModelConfigSnapshot,
  InteractionPromptScope,
  InteractionPromptVersion,
  PromptVersion,
  RunDetail,
  RunSummary,
  StyleFeedback,
  StyleReasonCode,
  TokenUsage,
  WorkInput,
} from "./types";

const dataFile = process.env.ECHO_DATA_FILE
  ? path.resolve(process.env.ECHO_DATA_FILE)
  : path.join(process.cwd(), ".echo-data", "ai-lab.json");
const dataDirectory = path.dirname(dataFile);
const lockFile = `${dataFile}.lock`;
let operationQueue: Promise<unknown> = Promise.resolve();

function seedInteractionPrompts(createdAt: string): InteractionPromptVersion[] {
  return INTERACTION_PROMPT_DEFAULTS.map((prompt) => ({
    id: randomUUID(),
    version: 1,
    createdAt,
    ...prompt,
  }));
}

function seedDatabase(): LabDatabase {
  const createdAt = new Date().toISOString();
  return {
    schemaVersion: 7,
    promptVersions: [
      {
        id: randomUUID(),
        version: 1,
        name: DEFAULT_PROMPT_NAME,
        body: DEFAULT_PROMPT_BODY,
        notes: "第一版开放式评论基线提示词。",
        createdAt,
      },
    ],
    interactionPromptVersions: seedInteractionPrompts(createdAt),
    contentAnalyses: [],
    works: [],
    runs: [],
    comments: [],
    evaluations: [],
    contentFeedback: [],
    styleFeedback: [],
    posts: [],
    commentTasks: [],
    rooms: [{ id: PUBLIC_MOOD_ROOM_ID, name: PUBLIC_MOOD_ROOM_NAME, createdAt }],
    chatMessages: [],
    chatAiTasks: [],
    chatMessageReports: [],
    chatUserBlocks: [],
    chatAiStyleFeedback: [],
  };
}

function migrateDatabase(raw: Partial<LabDatabase> & { schemaVersion?: number }) {
  const createdAt = new Date().toISOString();
  const interactionPrompts = raw.interactionPromptVersions ?? [];
  for (const defaultPrompt of INTERACTION_PROMPT_DEFAULTS) {
    if (!interactionPrompts.some((prompt) => prompt.scope === defaultPrompt.scope)) {
      interactionPrompts.push({ id: randomUUID(), version: 1, createdAt, ...defaultPrompt });
    }
  }
  const rooms = raw.rooms ?? [];
  if (!rooms.some((room) => room.id === PUBLIC_MOOD_ROOM_ID)) {
    rooms.push({ id: PUBLIC_MOOD_ROOM_ID, name: PUBLIC_MOOD_ROOM_NAME, createdAt });
  }
  const database: LabDatabase = {
    schemaVersion: 7,
    promptVersions: raw.promptVersions ?? [],
    interactionPromptVersions: interactionPrompts,
    contentAnalyses: raw.contentAnalyses ?? [],
    works: raw.works ?? [],
    runs: raw.runs ?? [],
    comments: (raw.comments ?? []).map((comment) => ({
      ...comment,
      persona: comment.persona ?? { ...DEFAULT_PERSONA },
      trigger: comment.trigger ?? "initial",
    })),
    evaluations: raw.evaluations ?? [],
    contentFeedback: raw.contentFeedback ?? [],
    styleFeedback: raw.styleFeedback ?? [],
    posts: raw.posts ?? [],
    commentTasks: raw.commentTasks ?? [],
    rooms,
    chatMessages: raw.chatMessages ?? [],
    chatAiTasks: raw.chatAiTasks ?? [],
    chatMessageReports: raw.chatMessageReports ?? [],
    chatUserBlocks: raw.chatUserBlocks ?? [],
    chatAiStyleFeedback: raw.chatAiStyleFeedback ?? [],
  };
  return database;
}

async function writeDatabase(database: LabDatabase) {
  await mkdir(dataDirectory, { recursive: true });
  const temporaryFile = `${dataFile}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(database, null, 2)}\n`, "utf8");
  await rename(temporaryFile, dataFile);
}

async function readDatabase(): Promise<LabDatabase> {
  try {
    const raw = JSON.parse(await readFile(dataFile, "utf8")) as Partial<LabDatabase> & {
      schemaVersion?: number;
    };
    const migrated = migrateDatabase(raw);
    if (
      raw.schemaVersion !== 7 ||
      (raw.interactionPromptVersions?.length ?? 0) !==
        migrated.interactionPromptVersions.length
    ) {
      await writeDatabase(migrated);
    }
    return migrated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const database = seedDatabase();
    await writeDatabase(database);
    return database;
  }
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withDataFileLock<T>(operation: () => Promise<T>) {
  await mkdir(dataDirectory, { recursive: true });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      const handle = await open(lockFile, "wx");
      try {
        await handle.writeFile(`${process.pid} ${Date.now()}\n`, "utf8");
        return await operation();
      } finally {
        await handle.close();
        await unlink(lockFile).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockFile);
        if (Date.now() - lockStat.mtimeMs > 30_000) await unlink(lockFile);
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") throw lockError;
      }
      await wait(25);
    }
  }
  throw new Error("DATA_FILE_LOCK_TIMEOUT");
}

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const lockedOperation = () => withDataFileLock(operation);
  const result = operationQueue.then(lockedOperation, lockedOperation);
  operationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function findCommentContext(database: LabDatabase, commentId: string) {
  const comment = database.comments.find((item) => item.id === commentId);
  if (!comment) return null;
  const run = database.runs.find((item) => item.id === comment.runId);
  if (!run) return null;
  const work = database.works.find((item) => item.id === run.workId);
  if (!work) return null;
  return { comment, run, work };
}

function buildRunDetail(database: LabDatabase, runId: string): RunDetail | null {
  const run = database.runs.find((item) => item.id === runId);
  if (!run) return null;
  const work = database.works.find((item) => item.id === run.workId);
  if (!work) return null;

  const comments = database.comments
    .filter((comment) => comment.runId === run.id)
    .sort((a, b) => a.position - b.position)
    .map((comment) => ({
      ...comment,
      evaluation:
        database.evaluations.find(
          (evaluation) => evaluation.commentId === comment.id,
        ) ?? null,
      contentReaction:
        database.contentFeedback.find(
          (feedback) =>
            feedback.commentId === comment.id &&
            feedback.type !== "reply" &&
            feedback.active,
        ) ?? null,
      userReplies: database.contentFeedback
        .filter(
          (feedback) =>
            feedback.commentId === comment.id &&
            feedback.type === "reply" &&
            feedback.active,
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      styleFeedback:
        database.styleFeedback.find(
          (feedback) => feedback.commentId === comment.id,
        ) ?? null,
    }));

  return {
    run,
    work,
    comments,
    contentAnalysis:
      database.contentAnalyses.find((analysis) => analysis.id === run.contentAnalysisId) ?? null,
  };
}

export async function getLabState(): Promise<{
  promptVersions: PromptVersion[];
  runs: RunSummary[];
}> {
  return serialized(async () => {
    const database = await readDatabase();
    const summaries = [...database.runs]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((run) => {
        const work = database.works.find((item) => item.id === run.workId);
        return {
          id: run.id,
          status: run.status,
          createdAt: run.createdAt,
          completedAt: run.completedAt,
          promptVersion: run.promptSnapshot.version,
          promptName: run.promptSnapshot.name,
          model: run.modelConfig.model,
          workPreview: work?.content.replace(/\s+/g, " ").slice(0, 88) ?? "",
          characterCount: work?.characterCount ?? 0,
          commentCount: database.comments.filter(
            (comment) => comment.runId === run.id,
          ).length,
          errorMessage: run.errorMessage,
        } satisfies RunSummary;
      });

    return {
      promptVersions: [...database.promptVersions].sort(
        (a, b) => b.version - a.version,
      ),
      runs: summaries,
    };
  });
}

export async function createPromptVersion(input: {
  name: string;
  body: string;
  notes: string;
}) {
  return serialized(async () => {
    const database = await readDatabase();
    const version =
      Math.max(0, ...database.promptVersions.map((item) => item.version)) + 1;
    const prompt: PromptVersion = {
      id: randomUUID(),
      version,
      name: input.name.trim(),
      body: input.body.trim(),
      notes: input.notes.trim(),
      createdAt: new Date().toISOString(),
    };
    database.promptVersions.push(prompt);
    await writeDatabase(database);
    return prompt;
  });
}

export async function getInteractionPromptVersions(scope?: InteractionPromptScope) {
  return serialized(async () => {
    const database = await readDatabase();
    return database.interactionPromptVersions
      .filter((prompt) => !scope || prompt.scope === scope)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
}

export async function createInteractionPromptVersion(input: {
  scope: InteractionPromptScope;
  name: string;
  body: string;
  notes: string;
}) {
  return serialized(async () => {
    const database = await readDatabase();
    const version = Math.max(0, ...database.interactionPromptVersions
      .filter((prompt) => prompt.scope === input.scope)
      .map((prompt) => prompt.version)) + 1;
    const prompt: InteractionPromptVersion = {
      id: randomUUID(),
      scope: input.scope,
      version,
      name: input.name.trim(),
      body: input.body.trim(),
      notes: input.notes.trim(),
      createdAt: new Date().toISOString(),
    };
    database.interactionPromptVersions.push(prompt);
    await writeDatabase(database);
    return prompt;
  });
}

export async function startGeneration(input: {
  content: string;
  promptVersionId: string;
  modelConfig: ModelConfigSnapshot;
}) {
  return serialized(async () => {
    const database = await readDatabase();
    const prompt = database.promptVersions.find(
      (item) => item.id === input.promptVersionId,
    );
    if (!prompt) throw new Error("PROMPT_NOT_FOUND");

    const createdAt = new Date().toISOString();
    const work: WorkInput = {
      id: randomUUID(),
      content: input.content,
      characterCount: input.content.length,
      createdAt,
    };
    const run: GenerationRun = {
      id: randomUUID(),
      workId: work.id,
      promptVersionId: prompt.id,
      promptSnapshot: { ...prompt },
      systemPromptSnapshot: buildSystemPrompt(prompt.body),
      modelConfig: { ...input.modelConfig },
      status: "running",
      createdAt,
    };
    database.works.push(work);
    database.runs.push(run);
    await writeDatabase(database);
    return { run, work, prompt };
  });
}

export async function completeGeneration(
  runId: string,
  comments: string[],
  usage?: TokenUsage,
) {
  return serialized(async () => {
    const database = await readDatabase();
    const run = database.runs.find((item) => item.id === runId);
    if (!run) throw new Error("RUN_NOT_FOUND");
    const completedAt = new Date().toISOString();
    run.status = "completed";
    run.completedAt = completedAt;
    run.usage = usage;
    database.comments.push(
      ...comments.map((content, position) => ({
        id: randomUUID(),
        runId,
        position,
        content,
        persona: { ...DEFAULT_PERSONA },
        trigger: "initial" as const,
        createdAt: completedAt,
      })),
    );
    await writeDatabase(database);
    return buildRunDetail(database, runId);
  });
}

export async function failGeneration(runId: string, errorMessage: string) {
  return serialized(async () => {
    const database = await readDatabase();
    const run = database.runs.find((item) => item.id === runId);
    if (!run) return null;
    run.status = "failed";
    run.errorMessage = errorMessage;
    run.completedAt = new Date().toISOString();
    await writeDatabase(database);
    return buildRunDetail(database, runId);
  });
}

export async function getRunDetail(runId: string) {
  return serialized(async () => buildRunDetail(await readDatabase(), runId));
}

export async function saveEvaluation(input: {
  commentId: string;
  humanLikeness: CommentEvaluation["humanLikeness"];
  value: CommentEvaluation["value"];
  notes: string;
}) {
  return serialized(async () => {
    const database = await readDatabase();
    if (!database.comments.some((comment) => comment.id === input.commentId)) {
      return null;
    }
    const existing = database.evaluations.find(
      (evaluation) => evaluation.commentId === input.commentId,
    );
    const evaluation: CommentEvaluation = {
      id: existing?.id ?? randomUUID(),
      commentId: input.commentId,
      humanLikeness: input.humanLikeness,
      value: input.value,
      notes: input.notes.trim(),
      updatedAt: new Date().toISOString(),
    };
    if (existing) Object.assign(existing, evaluation);
    else database.evaluations.push(evaluation);
    await writeDatabase(database);
    return evaluation;
  });
}

export async function saveContentReaction(input: {
  commentId: string;
  reaction: "agree" | "disagree" | null;
}) {
  return serialized(async () => {
    const database = await readDatabase();
    const context = findCommentContext(database, input.commentId);
    if (!context) return null;
    const existing = database.contentFeedback.find(
      (feedback) =>
        feedback.commentId === input.commentId && feedback.type !== "reply",
    );
    const previousReaction =
      existing?.active && existing.type !== "reply" ? existing.type : null;
    const now = new Date().toISOString();
    let feedback: ContentFeedback | null = existing ?? null;

    if (input.reaction === null) {
      if (existing) {
        existing.active = false;
        existing.updatedAt = now;
      }
    } else if (existing) {
      existing.type = input.reaction;
      existing.active = true;
      existing.updatedAt = now;
      feedback = existing;
    } else {
      feedback = {
        id: randomUUID(),
        workId: context.work.id,
        commentId: context.comment.id,
        personaId: context.comment.persona.id,
        type: input.reaction,
        active: true,
        createdAt: now,
        updatedAt: now,
      };
      database.contentFeedback.push(feedback);
    }

    const hasAgreementFollowUp = database.comments.some(
      (comment) =>
        comment.parentCommentId === input.commentId &&
        comment.trigger === "agreement",
    );
    const shouldGenerateFollowUp = shouldGenerateAgreementFollowUp({
      previousReaction,
      nextReaction: input.reaction,
      hasExistingFollowUp: hasAgreementFollowUp,
    });

    await writeDatabase(database);
    return {
      feedback,
      shouldGenerateFollowUp,
      comment: { ...context.comment },
      run: { ...context.run },
      work: { ...context.work },
      detail: buildRunDetail(database, context.run.id),
    };
  });
}

export async function saveUserReply(input: {
  commentId: string;
  replyText: string;
}) {
  return serialized(async () => {
    const database = await readDatabase();
    const context = findCommentContext(database, input.commentId);
    if (!context) return null;
    const runCommentIds = new Set(
      database.comments
        .filter((comment) => comment.runId === context.run.id)
        .map((comment) => comment.id),
    );
    const runReplies = database.contentFeedback.filter(
      (feedback) =>
        feedback.type === "reply" && runCommentIds.has(feedback.commentId),
    );
    if (runReplies.length >= 20) throw new Error("RUN_REPLY_LIMIT");

    const latestForComment = runReplies
      .filter((feedback) => feedback.commentId === input.commentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (isReplyRateLimited(latestForComment?.createdAt)) {
      throw new Error("REPLY_RATE_LIMIT");
    }

    const now = new Date().toISOString();
    const feedback: ContentFeedback = {
      id: randomUUID(),
      workId: context.work.id,
      commentId: context.comment.id,
      personaId: context.comment.persona.id,
      type: "reply",
      replyText: input.replyText.trim(),
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    database.contentFeedback.push(feedback);
    const post = database.posts.find((item) => item.runId === context.run.id);
    if (post) {
      for (const task of database.commentTasks) {
        if (
          task.postId === post.id &&
          task.personaId === context.comment.persona.id &&
          (task.status === "pending" || task.status === "running")
        ) {
          task.status = "cancelled";
          task.executionToken = undefined;
          task.lastError = "用户已主动与该人格交流，取消尚未发生的普通评论。";
        }
      }
    }
    await writeDatabase(database);
    return {
      feedback,
      comment: { ...context.comment },
      run: { ...context.run },
      work: { ...context.work },
      detail: buildRunDetail(database, context.run.id),
    };
  });
}

export async function appendFollowUpComment(input: {
  sourceCommentId: string;
  triggerFeedbackId: string;
  trigger: Exclude<CommentTrigger, "initial">;
  content: string;
  usage?: TokenUsage;
}) {
  return serialized(async () => {
    const database = await readDatabase();
    const context = findCommentContext(database, input.sourceCommentId);
    if (!context) return null;
    if (
      input.trigger === "agreement" &&
      database.comments.some(
        (comment) =>
          comment.parentCommentId === input.sourceCommentId &&
          comment.trigger === "agreement",
      )
    ) {
      return buildRunDetail(database, context.run.id);
    }
    const position =
      Math.max(
        -1,
        ...database.comments
          .filter((comment) => comment.runId === context.run.id)
          .map((comment) => comment.position),
      ) + 1;
    const comment: CommentRecord = {
      id: randomUUID(),
      runId: context.run.id,
      position,
      content: input.content.trim(),
      persona: { ...context.comment.persona },
      trigger: input.trigger,
      parentCommentId: context.comment.id,
      triggerFeedbackId: input.triggerFeedbackId,
      usage: input.usage,
      createdAt: new Date().toISOString(),
    };
    database.comments.push(comment);
    await writeDatabase(database);
    return buildRunDetail(database, context.run.id);
  });
}

export async function saveStyleFeedback(input: {
  commentId: string;
  type: StyleFeedback["type"];
  reasons: StyleReasonCode[];
  note: string;
}) {
  return serialized(async () => {
    const database = await readDatabase();
    const context = findCommentContext(database, input.commentId);
    if (!context) return null;
    const existing = database.styleFeedback.find(
      (feedback) => feedback.commentId === input.commentId,
    );
    const now = new Date().toISOString();
    const feedback: StyleFeedback = {
      id: existing?.id ?? randomUUID(),
      workId: context.work.id,
      commentId: context.comment.id,
      personaId: context.comment.persona.id,
      type: input.type,
      reasons: input.type === "like" ? [] : input.reasons,
      note: input.note.trim(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing) Object.assign(existing, feedback);
    else database.styleFeedback.push(feedback);
    await writeDatabase(database);
    return { feedback, detail: buildRunDetail(database, context.run.id) };
  });
}

export async function getFeedbackExport() {
  return serialized(async () => {
    const database = await readDatabase();
    return {
      schemaVersion: database.schemaVersion,
      exportedAt: new Date().toISOString(),
      records: database.comments.map((comment) => {
        const context = findCommentContext(database, comment.id);
        return {
          work: context?.work,
          comment,
          generation: context
            ? {
                runId: context.run.id,
                model: context.run.modelConfig.model,
                modelConfig: context.run.modelConfig,
                promptVersionId: context.run.promptVersionId,
                promptVersion: context.run.promptSnapshot.version,
                promptName: context.run.promptSnapshot.name,
                generatedAt: comment.createdAt,
                trigger: comment.trigger,
                contentAnalysis:
                  database.contentAnalyses.find(
                    (analysis) => analysis.id === comment.contentAnalysisId,
                  ) ?? null,
                strategyPrompt: comment.strategyPromptSnapshot ?? null,
              }
            : null,
          contentFeedback: database.contentFeedback.filter(
            (feedback) => feedback.commentId === comment.id,
          ),
          styleFeedback:
            database.styleFeedback.find(
              (feedback) => feedback.commentId === comment.id,
            ) ?? null,
          evaluation:
            database.evaluations.find(
              (evaluation) => evaluation.commentId === comment.id,
            ) ?? null,
        };
      }),
      chatRecords: database.chatMessages
        .filter((message) => message.senderType === "ai")
        .map((message) => ({
          message: { ...message },
          generationTask:
            database.chatAiTasks.find((task) => task.generatedMessageId === message.id) ?? null,
          styleFeedback: database.chatAiStyleFeedback.filter(
            (feedback) => feedback.messageId === message.id,
          ),
          reports: database.chatMessageReports.filter(
            (report) => report.messageId === message.id,
          ),
        })),
      chatReports: database.chatMessageReports.map((report) => ({ ...report })),
    };
  });
}

function buildCommunityPostDetail(
  database: LabDatabase,
  post: CommunityPost,
): CommunityPostDetail | null {
  const work = database.works.find((item) => item.id === post.workId);
  const runDetail = buildRunDetail(database, post.runId);
  if (!work || !runDetail) return null;
  const tasks = database.commentTasks.filter((task) => task.postId === post.id);
  return {
    post: { ...post },
    work: { ...work },
    comments: runDetail.comments
      .map((comment) => ({
        ...comment,
        role: comment.persona.role ?? getCommunityPersona(comment.persona.id)?.role ?? "AI 评论者",
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    pendingCommentCount: tasks.filter(
      (task) => task.status === "pending" || task.status === "running",
    ).length,
    failedCommentCount: tasks.filter((task) => task.status === "failed").length,
    contentAnalysis:
      database.contentAnalyses.find((analysis) => analysis.postId === post.id) ?? null,
  };
}

export async function createScheduledPost(input: {
  type: CommunityPost["type"];
  title?: string;
  content: string;
  author: string;
  finalPrompt: InteractionPromptVersion;
  modelConfig: ModelConfigSnapshot;
  plan: Array<{ personaId: string; scheduledAt: string }>;
  analysis: ContentAnalysis;
  analysisPrompt: InteractionPromptVersion;
  analysisUsage?: TokenUsage;
  analysisSource: ContentAnalysisRecord["source"];
  analysisErrorMessage?: string;
  strategyPrompt: InteractionPromptVersion;
}) {
  return serialized(async () => {
    const database = await readDatabase();
    const createdAt = new Date().toISOString();
    const workId = randomUUID();
    const postId = randomUUID();
    const analysisId = randomUUID();
    const work: WorkInput = {
      id: workId,
      content: input.content.trim(),
      characterCount: input.content.trim().length,
      createdAt,
    };
    const run: GenerationRun = {
      id: randomUUID(),
      workId: work.id,
      promptVersionId: input.finalPrompt.id,
      promptSnapshot: { ...input.finalPrompt },
      systemPromptSnapshot: buildSystemPrompt(input.finalPrompt.body),
      modelConfig: { ...input.modelConfig, commentCount: 1 },
      status: input.plan.length ? "running" : "completed",
      createdAt,
      completedAt: input.plan.length ? undefined : createdAt,
      contentAnalysisId: analysisId,
    };
    const post: CommunityPost = {
      id: postId,
      workId: work.id,
      runId: run.id,
      type: input.type,
      title: input.title?.trim() || undefined,
      author: input.author,
      publishedAt: createdAt,
      plannedCommentCount: input.plan.length,
    };
    const tasks: CommentTask[] = input.plan.map((item) => ({
      id: randomUUID(),
      postId: post.id,
      personaId: item.personaId,
      scheduledAt: item.scheduledAt,
      status: "pending",
      retryCount: 0,
      createdAt,
      contentAnalysisId: analysisId,
      strategyPromptSnapshot: { ...input.strategyPrompt },
    }));
    const analysisRecord: ContentAnalysisRecord = {
      id: analysisId,
      workId,
      postId,
      analysis: input.analysis,
      promptSnapshot: { ...input.analysisPrompt },
      modelConfig: { ...input.modelConfig, commentCount: 1 },
      usage: input.analysisUsage,
      source: input.analysisSource,
      errorMessage: input.analysisErrorMessage,
      createdAt,
    };
    database.works.push(work);
    database.runs.push(run);
    database.posts.push(post);
    database.commentTasks.push(...tasks);
    database.contentAnalyses.push(analysisRecord);
    await writeDatabase(database);
    return buildCommunityPostDetail(database, post);
  });
}

export async function listCommunityPosts() {
  return serialized(async () => {
    const database = await readDatabase();
    return database.posts
      .filter((post) => !post.deletedAt && post.type !== "心情")
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .map((post) => buildCommunityPostDetail(database, post))
      .filter((post): post is CommunityPostDetail => Boolean(post));
  });
}

export async function getCommunityPost(postId: string) {
  return serialized(async () => {
    const database = await readDatabase();
    const post = database.posts.find((item) => item.id === postId && !item.deletedAt);
    return post ? buildCommunityPostDetail(database, post) : null;
  });
}

export async function deleteCommunityPost(postId: string) {
  return serialized(async () => {
    const database = await readDatabase();
    const post = database.posts.find((item) => item.id === postId && !item.deletedAt);
    if (!post) return false;
    post.deletedAt = new Date().toISOString();
    for (const task of database.commentTasks) {
      if (task.postId === postId && (task.status === "pending" || task.status === "running")) {
        task.status = "cancelled";
        task.executionToken = undefined;
        task.lastError = "作品已删除。";
      }
    }
    await writeDatabase(database);
    return true;
  });
}

export async function claimDueCommentTasks(input: {
  limit: number;
  staleRunningMs: number;
  now?: Date;
}) {
  return serialized(async () => {
    const database = await readDatabase();
    const now = input.now ?? new Date();
    const staleBefore = now.getTime() - input.staleRunningMs;
    for (const task of database.commentTasks) {
      if (
        task.status === "running" &&
        task.startedAt &&
        new Date(task.startedAt).getTime() < staleBefore
      ) {
        task.status = "pending";
        task.executionToken = undefined;
        task.startedAt = undefined;
      }
    }
    const claimed: CommentTask[] = [];
    for (const task of database.commentTasks
      .filter((item) => item.status === "pending" && new Date(item.scheduledAt) <= now)
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))) {
      if (claimed.length >= input.limit) break;
      const post = database.posts.find((item) => item.id === task.postId);
      if (!post || post.deletedAt) {
        task.status = "cancelled";
        continue;
      }
      task.status = "running";
      task.startedAt = now.toISOString();
      task.executionToken = randomUUID();
      claimed.push({ ...task });
    }
    await writeDatabase(database);
    return claimed;
  });
}

export async function getCommentTaskContext(taskId: string, executionToken: string) {
  return serialized(async () => {
    const database = await readDatabase();
    const task = database.commentTasks.find(
      (item) => item.id === taskId && item.status === "running" && item.executionToken === executionToken,
    );
    if (!task) return null;
    const post = database.posts.find((item) => item.id === task.postId && !item.deletedAt);
    if (!post) return null;
    const work = database.works.find((item) => item.id === post.workId);
    const run = database.runs.find((item) => item.id === post.runId);
    if (!work || !run) return null;
    const existingComments = database.comments
      .filter((comment) => comment.runId === run.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const contentAnalysis = task.contentAnalysisId
      ? database.contentAnalyses.find((analysis) => analysis.id === task.contentAnalysisId)
      : undefined;
    return { task: { ...task }, post: { ...post }, work: { ...work }, run: { ...run }, existingComments, contentAnalysis };
  });
}

function completeRunIfSettled(database: LabDatabase, postId: string) {
  const post = database.posts.find((item) => item.id === postId);
  if (!post) return;
  const unsettled = database.commentTasks.some(
    (task) => task.postId === postId && (task.status === "pending" || task.status === "running"),
  );
  if (!unsettled) {
    const run = database.runs.find((item) => item.id === post.runId);
    if (run) {
      run.status = "completed";
      run.completedAt = new Date().toISOString();
    }
  }
}

export async function completeCommentTask(input: {
  taskId: string;
  executionToken: string;
  content: string;
  persona: CommentRecord["persona"];
  usage?: TokenUsage;
}) {
  return serialized(async () => {
    const database = await readDatabase();
    const task = database.commentTasks.find((item) => item.id === input.taskId);
    if (!task || task.status !== "running" || task.executionToken !== input.executionToken) return null;
    const post = database.posts.find((item) => item.id === task.postId);
    if (!post || post.deletedAt) {
      task.status = "cancelled";
      task.executionToken = undefined;
      await writeDatabase(database);
      return null;
    }
    const prior = database.comments.find((comment) => comment.scheduledTaskId === task.id);
    if (prior) {
      task.status = "completed";
      task.commentId = prior.id;
      task.generatedAt = prior.createdAt;
      await writeDatabase(database);
      return prior;
    }
    const position = Math.max(-1, ...database.comments.filter((comment) => comment.runId === post.runId).map((comment) => comment.position)) + 1;
    const generatedAt = new Date().toISOString();
    const comment: CommentRecord = {
      id: randomUUID(),
      runId: post.runId,
      position,
      content: input.content.trim(),
      persona: input.persona,
      trigger: "initial",
      scheduledTaskId: task.id,
      contentAnalysisId: task.contentAnalysisId,
      strategyPromptSnapshot: task.strategyPromptSnapshot,
      usage: input.usage,
      createdAt: generatedAt,
    };
    database.comments.push(comment);
    task.status = "completed";
    task.commentId = comment.id;
    task.generatedAt = generatedAt;
    task.executionToken = undefined;
    completeRunIfSettled(database, post.id);
    await writeDatabase(database);
    return comment;
  });
}

export async function failCommentTask(input: {
  taskId: string;
  executionToken: string;
  errorMessage: string;
  maxRetries: number;
  retryAt: string;
}) {
  return serialized(async () => {
    const database = await readDatabase();
    const task = database.commentTasks.find((item) => item.id === input.taskId);
    if (!task || task.status !== "running" || task.executionToken !== input.executionToken) return null;
    task.retryCount += 1;
    task.lastError = input.errorMessage;
    task.executionToken = undefined;
    task.startedAt = undefined;
    if (task.retryCount <= input.maxRetries) {
      task.status = "pending";
      task.scheduledAt = input.retryAt;
    } else {
      task.status = "failed";
      completeRunIfSettled(database, task.postId);
    }
    await writeDatabase(database);
    return { ...task };
  });
}

export async function getSchedulerDiagnostics(postId?: string) {
  return serialized(async () => {
    const database = await readDatabase();
    return database.commentTasks.filter((task) => !postId || task.postId === postId);
  });
}

function sortChatMessages(messages: ChatMessage[]) {
  return [...messages].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

function buildChatMessageView(
  database: LabDatabase,
  message: ChatMessage,
  viewerUserId?: string,
  blockedSenderIds = new Set<string>(),
): ChatMessageView {
  const publicMessage = { ...message };
  delete publicMessage.modelConfig;
  delete publicMessage.promptVersion;
  if (publicMessage.status === "deleted") publicMessage.content = "";
  const parent = message.replyToMessageId
    ? database.chatMessages.find((item) => item.id === message.replyToMessageId)
    : undefined;
  const parentIsBlocked = parent ? blockedSenderIds.has(parent.senderId) : false;
  const styleFeedback = viewerUserId
    ? database.chatAiStyleFeedback.find(
        (feedback) => feedback.messageId === message.id && feedback.userId === viewerUserId,
      ) ?? null
    : null;
  return {
    ...publicMessage,
    replyTo: parent
      ? {
          id: parent.id,
          senderName: parentIsBlocked ? "已屏蔽用户" : parent.senderName,
          content: parent.status === "deleted" || parentIsBlocked ? "" : parent.content,
          status: parent.status === "deleted" || parentIsBlocked ? "deleted" : parent.status,
        }
      : null,
    styleFeedback: styleFeedback
      ? {
          type: styleFeedback.type,
          reasons: [...styleFeedback.reasons],
          note: styleFeedback.note,
          updatedAt: styleFeedback.updatedAt,
        }
      : null,
  };
}

export async function listChatMessages(input: {
  roomId: string;
  limit: number;
  beforeId?: string;
  afterId?: string;
  viewerUserId?: string;
}) {
  return serialized(async () => {
    const database = await readDatabase();
    const blockedSenderIds = new Set(
      database.chatUserBlocks
        .filter(
          (block) =>
            block.roomId === input.roomId && block.blockerId === input.viewerUserId,
        )
        .map((block) => block.blockedSenderId),
    );
    const messages = sortChatMessages(
      database.chatMessages.filter(
        (message) =>
          message.roomId === input.roomId && !blockedSenderIds.has(message.senderId),
      ),
    );
    const limit = Math.max(1, input.limit);

    if (input.afterId) {
      const cursorIndex = messages.findIndex((message) => message.id === input.afterId);
      const start = cursorIndex >= 0 ? cursorIndex + 1 : messages.length;
      const cursor = cursorIndex >= 0 ? messages[cursorIndex] : undefined;
      const changedEarlier = cursor
        ? messages.slice(0, cursorIndex).filter((message) => message.updatedAt > cursor.createdAt)
        : [];
      const page = [...changedEarlier, ...messages.slice(start, start + limit)];
      return {
        messages: page.slice(0, limit).map((message) =>
          buildChatMessageView(database, message, input.viewerUserId, blockedSenderIds),
        ),
        hasMore: start + limit < messages.length,
      };
    }

    const endIndex = input.beforeId
      ? messages.findIndex((message) => message.id === input.beforeId)
      : messages.length;
    const safeEnd = endIndex >= 0 ? endIndex : messages.length;
    const start = Math.max(0, safeEnd - limit);
    return {
      messages: messages.slice(start, safeEnd).map((message) =>
        buildChatMessageView(database, message, input.viewerUserId, blockedSenderIds),
      ),
      hasMore: start > 0,
    };
  });
}

export async function createChatMessage(input: {
  roomId: string;
  senderId: string;
  senderType: ChatMessage["senderType"];
  senderName: string;
  content: string;
  replyToMessageId?: string;
}) {
  return serialized(async () => {
    const database = await readDatabase();
    const room = database.rooms.find((item) => item.id === input.roomId);
    if (!room) throw new Error("CHAT_ROOM_NOT_FOUND");
    const replyTo = input.replyToMessageId
      ? database.chatMessages.find(
          (item) => item.id === input.replyToMessageId && item.roomId === input.roomId,
        )
      : undefined;
    if (input.replyToMessageId && !replyTo) throw new Error("REPLY_MESSAGE_NOT_FOUND");
    if (replyTo?.status === "deleted") throw new Error("REPLY_MESSAGE_DELETED");

    const createdAt = new Date().toISOString();
    const message: ChatMessage = {
      id: randomUUID(),
      roomId: input.roomId,
      senderId: input.senderId,
      senderType: input.senderType,
      senderName: input.senderName,
      content: input.content,
      replyToMessageId: replyTo?.id,
      createdAt,
      updatedAt: createdAt,
      status: "normal",
    };
    database.chatMessages.push(message);
    await writeDatabase(database);
    return buildChatMessageView(database, message, input.senderId);
  });
}

export async function getChatRoomPreview(input: {
  roomId: string;
  viewerUserId?: string;
  limit?: number;
}) {
  return serialized(async () => {
    const database = await readDatabase();
    const blockedSenderIds = new Set(
      database.chatUserBlocks
        .filter(
          (block) =>
            block.roomId === input.roomId && block.blockerId === input.viewerUserId,
        )
        .map((block) => block.blockedSenderId),
    );
    const messages = sortChatMessages(
      database.chatMessages.filter(
        (message) =>
          message.roomId === input.roomId &&
          message.status === "normal" &&
          !blockedSenderIds.has(message.senderId),
      ),
    ).slice(-Math.max(1, Math.min(input.limit ?? 3, 10)));
    return messages.map((message) =>
      buildChatMessageView(database, message, input.viewerUserId, blockedSenderIds),
    );
  });
}

export async function deleteOwnChatMessage(input: {
  roomId: string;
  messageId: string;
  userId: string;
}) {
  return serialized(async () => {
    const database = await readDatabase();
    const message = database.chatMessages.find(
      (item) => item.id === input.messageId && item.roomId === input.roomId,
    );
    if (!message) throw new Error("CHAT_MESSAGE_NOT_FOUND");
    if (message.senderType !== "human" || message.senderId !== input.userId) {
      throw new Error("CHAT_MESSAGE_DELETE_FORBIDDEN");
    }
    if (message.status === "deleted") {
      return buildChatMessageView(database, message, input.userId);
    }
    const deletedAt = new Date().toISOString();
    message.status = "deleted";
    message.deletedAt = deletedAt;
    message.updatedAt = deletedAt;
    for (const task of database.chatAiTasks) {
      if (
        task.triggerMessageId === message.id &&
        (task.status === "pending" || task.status === "processing")
      ) {
        task.status = "cancelled";
        task.executionToken = undefined;
        task.startedAt = undefined;
        task.lastError = "触发消息已被用户删除。";
      }
    }
    await writeDatabase(database);
    return buildChatMessageView(database, message, input.userId);
  });
}

export async function upsertChatMessageReport(input: {
  roomId: string;
  messageId: string;
  reporterId: string;
  reason: ChatReportReason;
  note: string;
}) {
  return serialized(async () => {
    const database = await readDatabase();
    const message = database.chatMessages.find(
      (item) => item.id === input.messageId && item.roomId === input.roomId,
    );
    if (!message || message.status !== "normal") throw new Error("CHAT_MESSAGE_NOT_FOUND");
    if (message.senderId === input.reporterId) throw new Error("CHAT_REPORT_OWN_MESSAGE");
    const now = new Date().toISOString();
    let report = database.chatMessageReports.find(
      (item) => item.messageId === message.id && item.reporterId === input.reporterId,
    );
    if (report) {
      report.reason = input.reason;
      report.note = input.note.trim();
      report.status = "pending";
      report.updatedAt = now;
    } else {
      report = {
        id: randomUUID(),
        roomId: input.roomId,
        messageId: message.id,
        reporterId: input.reporterId,
        reportedSenderId: message.senderId,
        reportedPersonaId: message.personaId,
        reason: input.reason,
        note: input.note.trim(),
        status: "pending",
        createdAt: now,
        updatedAt: now,
      } satisfies ChatMessageReport;
      database.chatMessageReports.push(report);
    }
    await writeDatabase(database);
    return { ...report };
  });
}

export async function blockChatSender(input: {
  roomId: string;
  messageId: string;
  blockerId: string;
}) {
  return serialized(async () => {
    const database = await readDatabase();
    const message = database.chatMessages.find(
      (item) => item.id === input.messageId && item.roomId === input.roomId,
    );
    if (!message || message.status !== "normal") throw new Error("CHAT_MESSAGE_NOT_FOUND");
    if (message.senderType !== "human") throw new Error("CHAT_BLOCK_AI_UNSUPPORTED");
    if (message.senderId === input.blockerId) throw new Error("CHAT_BLOCK_SELF");
    const existing = database.chatUserBlocks.find(
      (item) =>
        item.roomId === input.roomId &&
        item.blockerId === input.blockerId &&
        item.blockedSenderId === message.senderId,
    );
    if (existing) return { ...existing };
    const block: ChatUserBlock = {
      id: randomUUID(),
      roomId: input.roomId,
      blockerId: input.blockerId,
      blockedSenderId: message.senderId,
      createdAt: new Date().toISOString(),
    };
    database.chatUserBlocks.push(block);
    await writeDatabase(database);
    return { ...block };
  });
}

export async function upsertChatAiStyleFeedback(input: {
  roomId: string;
  messageId: string;
  userId: string;
  type: "like" | "dislike";
  reasons: StyleReasonCode[];
  note: string;
}) {
  return serialized(async () => {
    const database = await readDatabase();
    const message = database.chatMessages.find(
      (item) => item.id === input.messageId && item.roomId === input.roomId,
    );
    if (!message || message.status !== "normal") throw new Error("CHAT_MESSAGE_NOT_FOUND");
    if (message.senderType !== "ai" || !message.personaId || !message.modelConfig) {
      throw new Error("CHAT_STYLE_FEEDBACK_AI_ONLY");
    }
    const now = new Date().toISOString();
    let feedback = database.chatAiStyleFeedback.find(
      (item) => item.messageId === message.id && item.userId === input.userId,
    );
    if (feedback) {
      feedback.type = input.type;
      feedback.reasons = input.type === "dislike" ? [...input.reasons] : [];
      feedback.note = input.note.trim();
      feedback.updatedAt = now;
    } else {
      feedback = {
        id: randomUUID(),
        roomId: input.roomId,
        messageId: message.id,
        personaId: message.personaId,
        model: message.modelConfig.model,
        promptVersion: message.promptVersion ?? "unknown",
        userId: input.userId,
        type: input.type,
        reasons: input.type === "dislike" ? [...input.reasons] : [],
        note: input.note.trim(),
        createdAt: now,
        updatedAt: now,
      } satisfies ChatAiStyleFeedback;
      database.chatAiStyleFeedback.push(feedback);
    }
    await writeDatabase(database);
    return { ...feedback, reasons: [...feedback.reasons] };
  });
}

export async function getChatModerationRecords() {
  return serialized(async () => {
    const database = await readDatabase();
    return {
      reports: database.chatMessageReports.map((item) => ({ ...item })),
      styleFeedback: database.chatAiStyleFeedback.map((item) => ({
        ...item,
        reasons: [...item.reasons],
      })),
    };
  });
}

export async function updateChatReportStatus(input: {
  reportId: string;
  status: ChatMessageReport["status"];
}) {
  return serialized(async () => {
    const database = await readDatabase();
    const report = database.chatMessageReports.find((item) => item.id === input.reportId);
    if (!report) return null;
    report.status = input.status;
    report.updatedAt = new Date().toISOString();
    await writeDatabase(database);
    return { ...report };
  });
}

export async function getChatAiPlanningContext(messageId: string, recentLimit = 30) {
  return serialized(async () => {
    const database = await readDatabase();
    const trigger = database.chatMessages.find((message) => message.id === messageId);
    if (!trigger) return null;
    const messages = sortChatMessages(
      database.chatMessages.filter((message) => message.roomId === trigger.roomId),
    );
    const triggerIndex = messages.findIndex((message) => message.id === trigger.id);
    const recentMessages = messages
      .slice(Math.max(0, triggerIndex - recentLimit + 1), triggerIndex + 1)
      .filter((message) => message.status === "normal");
    const parent = trigger.replyToMessageId
      ? database.chatMessages.find((message) => message.id === trigger.replyToMessageId) ?? null
      : null;
    const pendingTaskCount = database.chatAiTasks.filter(
      (task) => task.roomId === trigger.roomId && (task.status === "pending" || task.status === "processing"),
    ).length;
    const now = Date.now();
    const hourAgo = now - 60 * 60_000;
    const dayAgo = now - 24 * 60 * 60_000;
    const roomAiMessages = messages.filter(
      (message) => message.status === "normal" && message.senderType === "ai" && message.personaId,
    );
    const personaActivity = Object.fromEntries(
      [...new Set(roomAiMessages.map((message) => message.personaId!))].map((personaId) => {
        const personaMessages = roomAiMessages.filter((message) => message.personaId === personaId);
        return [personaId, {
          lastMessageAt: personaMessages.at(-1)?.createdAt,
          hourlyCount: personaMessages.filter(
            (message) => new Date(message.createdAt).getTime() >= hourAgo,
          ).length,
          dailyCount: personaMessages.filter(
            (message) => new Date(message.createdAt).getTime() >= dayAgo,
          ).length,
        }];
      }),
    );
    const recent10 = recentMessages.slice(-10);
    const recent30 = recentMessages.slice(-30);
    let consecutiveAiCount = 0;
    for (const message of [...recentMessages].reverse()) {
      if (message.senderType !== "ai") break;
      consecutiveAiCount += 1;
    }
    return {
      trigger: { ...trigger },
      parent: parent ? { ...parent } : null,
      recentMessages,
      pendingTaskCount,
      activitySnapshot: {
        recent10AiCount: recent10.filter((message) => message.senderType === "ai").length,
        recent30AiShare: recent30.length
          ? recent30.filter((message) => message.senderType === "ai").length / recent30.length
          : 0,
        consecutiveAiCount,
        lastAiMessageAt: roomAiMessages.at(-1)?.createdAt,
        personaActivity,
      },
    };
  });
}

export async function createChatAiTasks(input: {
  roomId: string;
  triggerMessageId: string;
  tasks: Array<{ personaId: string; personaVersion: number; scheduledAt: string; chainDepth: number }>;
  modelConfig: ModelConfigSnapshot;
  promptVersion: string;
  maxPendingTasks: number;
}) {
  return serialized(async () => {
    const database = await readDatabase();
    const trigger = database.chatMessages.find(
      (message) => message.id === input.triggerMessageId && message.roomId === input.roomId,
    );
    if (!trigger || trigger.status !== "normal") return [];
    const createdAt = new Date().toISOString();
    const created: ChatAiTask[] = [];
    const parent = trigger.replyToMessageId
      ? database.chatMessages.find((message) => message.id === trigger.replyToMessageId)
      : undefined;
    const isDirectAiReply = trigger.senderType === "human" && parent?.senderType === "ai";
    for (const planned of input.tasks) {
      if (!isDirectAiReply) {
        const activeTaskCount = database.chatAiTasks.filter(
          (task) => task.roomId === input.roomId && (task.status === "pending" || task.status === "processing"),
        ).length;
        if (activeTaskCount >= input.maxPendingTasks) break;
      }
      // Direct replies get a shorter delay and may bypass the ordinary pending-task cap,
      // but they must not replace replies already promised to other messages. Every
      // accepted task remains tied to its own trigger until it completes, fails, or
      // that trigger is deleted.
      const duplicate = database.chatAiTasks.some(
        (task) =>
          task.triggerMessageId === input.triggerMessageId &&
          task.personaId === planned.personaId &&
          task.status !== "cancelled" &&
          task.status !== "failed",
      );
      if (duplicate) continue;
      const task: ChatAiTask = {
        id: randomUUID(),
        roomId: input.roomId,
        triggerMessageId: input.triggerMessageId,
        personaId: planned.personaId,
        personaVersion: planned.personaVersion,
        scheduledAt: planned.scheduledAt,
        status: "pending",
        retryCount: 0,
        chainDepth: planned.chainDepth,
        createdAt,
        modelConfig: { ...input.modelConfig, commentCount: 1 },
        promptVersion: input.promptVersion,
      };
      database.chatAiTasks.push(task);
      created.push({ ...task });
    }
    if (created.length) await writeDatabase(database);
    return created;
  });
}

export async function claimDueChatAiTasks(input: {
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
  return serialized(async () => {
    const database = await readDatabase();
    const now = input.now ?? new Date();
    const staleBefore = now.getTime() - input.staleProcessingMs;
    for (const task of database.chatAiTasks) {
      if (
        task.status === "processing" && task.startedAt &&
        new Date(task.startedAt).getTime() < staleBefore
      ) {
        task.status = "pending";
        task.startedAt = undefined;
        task.executionToken = undefined;
      }
    }
    const claimed: ChatAiTask[] = [];
    const roomAiMessages = sortChatMessages(
      database.chatMessages.filter(
        (message) =>
          message.status === "normal" &&
          message.senderType === "ai" &&
          message.roomId === PUBLIC_MOOD_ROOM_ID,
      ),
    );
    let nextGlobalAiAt = roomAiMessages.at(-1)
      ? new Date(roomAiMessages.at(-1)!.createdAt).getTime() + input.minimumGlobalAiIntervalMs
      : 0;
    for (const task of database.chatAiTasks
      .filter((item) => item.status === "pending" && new Date(item.scheduledAt) <= now)
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))) {
      if (claimed.length >= input.limit) break;
      const trigger = database.chatMessages.find((message) => message.id === task.triggerMessageId);
      if (!trigger || trigger.status !== "normal") {
        task.status = "cancelled";
        task.lastError = "触发消息已删除。";
        continue;
      }
      const parent = trigger.replyToMessageId
        ? database.chatMessages.find((message) => message.id === trigger.replyToMessageId)
        : undefined;
      const isDirectAiReply = trigger.senderType === "human" && parent?.personaId === task.personaId;
      const limits = input.personaLimits[task.personaId];
      if (limits) {
        const personaMessages = roomAiMessages.filter(
          (message) => message.personaId === task.personaId,
        );
        const hourAgo = now.getTime() - 60 * 60_000;
        const dayAgo = now.getTime() - 24 * 60 * 60_000;
        if (
          personaMessages.filter((message) => new Date(message.createdAt).getTime() >= hourAgo).length >= limits.hourlyMessageLimit ||
          personaMessages.filter((message) => new Date(message.createdAt).getTime() >= dayAgo).length >= limits.dailyMessageLimit
        ) {
          task.status = "cancelled";
          task.lastError = "该 AI 人格已达到当前发言频率上限。";
          continue;
        }
        const lastPersonaMessage = personaMessages.at(-1);
        const nextPersonaAt = lastPersonaMessage && !isDirectAiReply
          ? new Date(lastPersonaMessage.createdAt).getTime() + limits.minimumIntervalMs
          : 0;
        const deferredUntil = Math.max(nextGlobalAiAt, nextPersonaAt);
        if (deferredUntil > now.getTime()) {
          task.scheduledAt = new Date(deferredUntil).toISOString();
          continue;
        }
      } else if (nextGlobalAiAt > now.getTime()) {
        task.scheduledAt = new Date(nextGlobalAiAt).toISOString();
        continue;
      }
      task.status = "processing";
      task.startedAt = now.toISOString();
      task.executionToken = randomUUID();
      claimed.push({ ...task });
      nextGlobalAiAt = now.getTime() + input.minimumGlobalAiIntervalMs;
    }
    await writeDatabase(database);
    return claimed;
  });
}

export async function getChatAiTaskContext(
  taskId: string,
  executionToken: string,
  contextLimit: number,
) {
  return serialized(async () => {
    const database = await readDatabase();
    const task = database.chatAiTasks.find(
      (item) => item.id === taskId && item.status === "processing" && item.executionToken === executionToken,
    );
    if (!task) return null;
    const trigger = database.chatMessages.find((message) => message.id === task.triggerMessageId);
    if (!trigger || trigger.status !== "normal") return null;
    const roomMessages = sortChatMessages(
      database.chatMessages.filter((message) => message.roomId === task.roomId && message.status === "normal"),
    );
    const recent = roomMessages.slice(-contextLimit);
    const chain: ChatMessage[] = [];
    let cursor: ChatMessage | undefined = trigger;
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor.id)) {
      chain.push(cursor);
      visited.add(cursor.id);
      cursor = cursor.replyToMessageId
        ? database.chatMessages.find((message) => message.id === cursor!.replyToMessageId)
        : undefined;
    }
    const contextMessages = sortChatMessages(
      [...new Map([...recent, ...chain].map((message) => [message.id, message])).values()],
    );
    return { task: { ...task }, trigger: { ...trigger }, contextMessages };
  });
}

export async function completeChatAiTask(input: {
  taskId: string;
  executionToken: string;
  content: string;
  persona: { id: string; name: string; avatar: string; version: number };
}) {
  return serialized(async () => {
    const database = await readDatabase();
    const task = database.chatAiTasks.find((item) => item.id === input.taskId);
    if (!task || task.status !== "processing" || task.executionToken !== input.executionToken) return null;
    if (task.generatedMessageId) {
      return database.chatMessages.find((message) => message.id === task.generatedMessageId) ?? null;
    }
    const trigger = database.chatMessages.find((message) => message.id === task.triggerMessageId);
    if (!trigger || trigger.status !== "normal") {
      task.status = "cancelled";
      task.executionToken = undefined;
      await writeDatabase(database);
      return null;
    }
    const createdAt = new Date().toISOString();
    const message: ChatMessage = {
      id: randomUUID(),
      roomId: task.roomId,
      senderId: `ai:${input.persona.id}`,
      senderType: "ai",
      senderName: input.persona.name,
      senderAvatar: input.persona.avatar,
      personaId: input.persona.id,
      personaVersion: input.persona.version,
      content: input.content.trim(),
      replyToMessageId: trigger.id,
      createdAt,
      updatedAt: createdAt,
      status: "normal",
      modelConfig: { ...task.modelConfig },
      promptVersion: task.promptVersion,
    };
    database.chatMessages.push(message);
    task.status = "completed";
    task.generatedAt = createdAt;
    task.generatedMessageId = message.id;
    task.executionToken = undefined;
    await writeDatabase(database);
    return message;
  });
}

export async function failChatAiTask(input: {
  taskId: string;
  executionToken: string;
  errorMessage: string;
  maxRetries: number;
  retryAt: string;
}) {
  return serialized(async () => {
    const database = await readDatabase();
    const task = database.chatAiTasks.find((item) => item.id === input.taskId);
    if (!task || task.status !== "processing" || task.executionToken !== input.executionToken) return null;
    task.retryCount += 1;
    task.lastError = input.errorMessage;
    task.executionToken = undefined;
    task.startedAt = undefined;
    if (task.retryCount <= input.maxRetries) {
      task.status = "pending";
      task.scheduledAt = input.retryAt;
    } else {
      task.status = "failed";
    }
    await writeDatabase(database);
    return { ...task };
  });
}

export async function getChatAiTaskDiagnostics() {
  return serialized(async () => {
    const database = await readDatabase();
    return database.chatAiTasks.map((task) => ({ ...task }));
  });
}
