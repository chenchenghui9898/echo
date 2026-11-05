import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { type LabDatabase } from "../lib/ai-lab/types.ts";
import { CHAT_AI_PERSONAS } from "../lib/chat/ai-personas.ts";
import { COMMUNITY_PERSONAS } from "../lib/community/personas.ts";

const projectRoot = resolve(import.meta.dirname, "..");
const sourcePath = resolve(projectRoot, process.argv[2] ?? ".echo-data/ai-lab.json");
const outputPathArgument = process.argv[3];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message: string): never {
  throw new Error(`Migration validation failed: ${message}`);
}

function assertUuid(value: string, label: string) {
  if (!uuidPattern.test(value)) fail(`${label} is not a UUID: ${value}`);
}

function assertReferences<T extends { id: string }>(
  records: T[],
  references: Array<{ label: string; value: (record: T) => string | undefined; ids: Set<string> }>,
) {
  for (const record of records) {
    assertUuid(record.id, `${record.id}.id`);
    for (const reference of references) {
      const value = reference.value(record);
      if (value && !reference.ids.has(value)) {
        fail(`${record.id}.${reference.label} references missing ${value}`);
      }
    }
  }
}

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlNullable(value: string | undefined | null) {
  return value == null ? "null" : sqlString(value);
}

function sqlNumber(value: number | undefined) {
  return value == null ? "null" : String(value);
}

function sqlBoolean(value: boolean) {
  return value ? "true" : "false";
}

function sqlJson(value: unknown) {
  return `${sqlString(JSON.stringify(value))}::jsonb`;
}

function sqlTextArray(values: string[]) {
  if (values.length === 0) return "array[]::text[]";
  return `array[${values.map(sqlString).join(", ")}]::text[]`;
}

function deterministicUuid(seed: string) {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16], 16) % 4];
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function insert(table: string, columns: string[], rows: string[][], conflict = "do nothing") {
  if (rows.length === 0) return `-- ${table}: no source rows`;
  return [
    `insert into public.${table} (${columns.join(", ")})`,
    "values",
    rows.map((row) => `  (${row.join(", ")})`).join(",\n"),
    `on conflict ${conflict};`,
  ].join("\n");
}

const sourceBytes = await readFile(sourcePath);
const sourceChecksum = createHash("sha256").update(sourceBytes).digest("hex");
const database = JSON.parse(sourceBytes.toString("utf8")) as LabDatabase;

if (database.schemaVersion !== 7) fail(`expected schemaVersion 7, received ${database.schemaVersion}`);

const collections = [
  "promptVersions", "interactionPromptVersions", "contentAnalyses", "works", "runs", "comments",
  "evaluations", "contentFeedback", "styleFeedback", "posts", "commentTasks", "rooms", "chatMessages",
  "chatAiTasks", "chatMessageReports", "chatUserBlocks", "chatAiStyleFeedback",
] as const;
for (const collection of collections) {
  if (!Array.isArray(database[collection])) fail(`${collection} is not an array`);
}

const ids = Object.fromEntries(collections.map((name) => [name, new Set(database[name].map((item) => item.id))])) as Record<(typeof collections)[number], Set<string>>;
const allPromptIds = new Set([...ids.promptVersions, ...ids.interactionPromptVersions]);

assertReferences(database.works, []);
assertReferences(database.runs, [
  { label: "workId", value: (item) => item.workId, ids: ids.works },
  { label: "promptVersionId", value: (item) => item.promptVersionId, ids: allPromptIds },
  { label: "contentAnalysisId", value: (item) => item.contentAnalysisId, ids: ids.contentAnalyses },
]);
assertReferences(database.posts, [
  { label: "workId", value: (item) => item.workId, ids: ids.works },
  { label: "runId", value: (item) => item.runId, ids: ids.runs },
]);
assertReferences(database.contentAnalyses, [
  { label: "workId", value: (item) => item.workId, ids: ids.works },
  { label: "postId", value: (item) => item.postId, ids: ids.posts },
  { label: "promptVersionId", value: (item) => item.promptSnapshot.id, ids: allPromptIds },
]);
assertReferences(database.commentTasks, [
  { label: "postId", value: (item) => item.postId, ids: ids.posts },
  { label: "commentId", value: (item) => item.commentId, ids: ids.comments },
  { label: "contentAnalysisId", value: (item) => item.contentAnalysisId, ids: ids.contentAnalyses },
]);
assertReferences(database.comments, [
  { label: "runId", value: (item) => item.runId, ids: ids.runs },
  { label: "parentCommentId", value: (item) => item.parentCommentId, ids: ids.comments },
  { label: "scheduledTaskId", value: (item) => item.scheduledTaskId, ids: ids.commentTasks },
  { label: "contentAnalysisId", value: (item) => item.contentAnalysisId, ids: ids.contentAnalyses },
]);
assertReferences(database.chatMessages, [
  { label: "roomId", value: (item) => item.roomId, ids: ids.rooms },
  { label: "replyToMessageId", value: (item) => item.replyToMessageId, ids: ids.chatMessages },
]);
assertReferences(database.chatAiTasks, [
  { label: "roomId", value: (item) => item.roomId, ids: ids.rooms },
  { label: "triggerMessageId", value: (item) => item.triggerMessageId, ids: ids.chatMessages },
  { label: "generatedMessageId", value: (item) => item.generatedMessageId, ids: ids.chatMessages },
]);

const personaIds = new Set([...COMMUNITY_PERSONAS, ...CHAT_AI_PERSONAS].map((persona) => persona.id));
if (personaIds.size !== COMMUNITY_PERSONAS.length + CHAT_AI_PERSONAS.length) {
  fail("community and chat persona IDs overlap");
}
for (const message of database.chatMessages.filter((item) => item.senderType === "ai")) {
  if (!message.personaId || !personaIds.has(message.personaId)) fail(`${message.id} has unknown AI persona`);
  if (!message.personaVersion || !message.modelConfig || !message.promptVersion) fail(`${message.id} lacks AI provenance`);
}
for (const task of database.chatAiTasks) {
  if (!personaIds.has(task.personaId)) fail(`${task.id} has unknown AI persona`);
}

const importBatchId = deterministicUuid(`echo-json:${sourceChecksum}`);
const sourceCounts = Object.fromEntries(collections.map((name) => [name, database[name].length]));
const outputPath = outputPathArgument
  ? resolve(projectRoot, outputPathArgument)
  : resolve(projectRoot, `.echo-data/migration/echo-import-${sourceChecksum.slice(0, 12)}.sql`);

const promptRows = [
  ...database.promptVersions.map((prompt) => [
    sqlString(prompt.id), sqlString("base_comment"), String(prompt.version), sqlString(prompt.name),
    sqlString(prompt.body), sqlString(prompt.notes), sqlString(prompt.createdAt), sqlString(importBatchId),
  ]),
  ...database.interactionPromptVersions.map((prompt) => [
    sqlString(prompt.id), sqlString(prompt.scope), String(prompt.version), sqlString(prompt.name),
    sqlString(prompt.body), sqlString(prompt.notes), sqlString(prompt.createdAt), sqlString(importBatchId),
  ]),
];

const personaRows = [
  ...COMMUNITY_PERSONAS.map((persona) => [
    sqlString(persona.id), sqlString(persona.name), "null", sqlString(persona.background), "true",
  ]),
  ...CHAT_AI_PERSONAS.map((persona) => [
    sqlString(persona.id), sqlString(persona.name), "null", sqlString(persona.background), sqlBoolean(persona.enabled),
  ]),
];
const personaVersionRows: string[][] = [];
for (const persona of COMMUNITY_PERSONAS) {
  personaVersionRows.push([
    sqlString(deterministicUuid(`persona:${persona.id}:v${persona.version}`)), sqlString(persona.id), String(persona.version),
    sqlJson({ surface: "community", ...persona }), "true", "null", sqlString("2026-11-05T00:00:00.000Z"),
  ]);
}
for (const persona of CHAT_AI_PERSONAS) {
  const historicalVersions = new Set([
    persona.version,
    ...database.chatMessages.filter((message) => message.personaId === persona.id).map((message) => message.personaVersion ?? persona.version),
    ...database.chatAiTasks.filter((task) => task.personaId === persona.id).map((task) => task.personaVersion),
  ]);
  for (const version of [...historicalVersions].sort()) {
    const exact = version === persona.version;
    personaVersionRows.push([
      sqlString(deterministicUuid(`persona:${persona.id}:v${version}`)), sqlString(persona.id), String(version),
      sqlJson(exact
        ? { surface: "chat", ...persona }
        : { surface: "chat", legacyPlaceholder: true, note: "原 JSON 只保留版本号，未保留该版本完整配置。", currentKnownConfiguration: persona }),
      sqlBoolean(exact), "null", sqlString("2026-11-05T00:00:00.000Z"),
    ]);
  }
}

const sql = [
  "-- Generated by scripts/prepare-supabase-data-migration.ts",
  `-- Source: ${sourcePath}`,
  `-- SHA-256: ${sourceChecksum}`,
  "-- Idempotent, transactional import. Formal public.posts intentionally remains untouched.",
  "-- A single DO statement is used so Supabase hosted db query can execute it atomically.",
  "do $echo_import$",
  "begin",
  insert("legacy_import_batches", ["id", "source_name", "source_checksum", "source_schema_version", "source_counts", "raw_document"], [[
    sqlString(importBatchId), sqlString(".echo-data/ai-lab.json"), sqlString(sourceChecksum), String(database.schemaVersion),
    sqlJson(sourceCounts), sqlJson(database),
  ]]),
  insert("lab_prompt_versions", ["id", "scope", "version", "name", "body", "notes", "created_at", "import_batch_id"], promptRows),
  insert("lab_inputs", ["id", "content", "character_count", "created_at", "import_batch_id"], database.works.map((work) => [
    sqlString(work.id), sqlString(work.content), String(work.characterCount), sqlString(work.createdAt), sqlString(importBatchId),
  ])),
  insert("lab_generation_runs", ["id", "input_id", "prompt_version_id", "prompt_snapshot", "system_prompt_snapshot", "model_config_snapshot", "status", "error_message", "token_usage", "created_at", "completed_at", "content_analysis_id", "import_batch_id"], database.runs.map((run) => [
    sqlString(run.id), sqlString(run.workId), sqlString(run.promptVersionId), sqlJson(run.promptSnapshot),
    sqlString(run.systemPromptSnapshot), sqlJson(run.modelConfig), sqlString(run.status), sqlNullable(run.errorMessage),
    run.usage ? sqlJson(run.usage) : "null", sqlString(run.createdAt), sqlNullable(run.completedAt), "null", sqlString(importBatchId),
  ])),
  insert("legacy_posts", ["id", "input_id", "run_id", "legacy_type", "title", "author_snapshot", "published_at", "deleted_at", "planned_comment_count", "import_batch_id"], database.posts.map((post) => [
    sqlString(post.id), sqlString(post.workId), sqlString(post.runId), sqlString(post.type), sqlNullable(post.title),
    sqlString(post.author), sqlString(post.publishedAt), sqlNullable(post.deletedAt), String(post.plannedCommentCount), sqlString(importBatchId),
  ])),
  insert("lab_content_analyses", ["id", "input_id", "legacy_post_id", "analysis", "prompt_version_id", "prompt_snapshot", "model_config_snapshot", "token_usage", "source", "error_message", "created_at", "import_batch_id"], database.contentAnalyses.map((analysis) => [
    sqlString(analysis.id), sqlString(analysis.workId), sqlString(analysis.postId), sqlJson(analysis.analysis),
    sqlString(analysis.promptSnapshot.id), sqlJson(analysis.promptSnapshot), sqlJson(analysis.modelConfig),
    analysis.usage ? sqlJson(analysis.usage) : "null", sqlString(analysis.source), sqlNullable(analysis.errorMessage),
    sqlString(analysis.createdAt), sqlString(importBatchId),
  ])),
  ...database.runs.filter((run) => run.contentAnalysisId).map((run) =>
    `update public.lab_generation_runs set content_analysis_id = ${sqlString(run.contentAnalysisId!)} where id = ${sqlString(run.id)};`),
  insert("lab_comment_tasks", ["id", "legacy_post_id", "persona_id", "scheduled_at", "status", "generated_at", "comment_id", "retry_count", "created_at", "started_at", "execution_token", "last_error", "content_analysis_id", "strategy_prompt_snapshot", "import_batch_id"], database.commentTasks.map((task) => [
    sqlString(task.id), sqlString(task.postId), sqlString(task.personaId), sqlString(task.scheduledAt), sqlString(task.status),
    sqlNullable(task.generatedAt), "null", String(task.retryCount), sqlString(task.createdAt), sqlNullable(task.startedAt),
    sqlNullable(task.executionToken), sqlNullable(task.lastError), sqlNullable(task.contentAnalysisId),
    task.strategyPromptSnapshot ? sqlJson(task.strategyPromptSnapshot) : "null", sqlString(importBatchId),
  ])),
  insert("lab_comments", ["id", "run_id", "position", "content", "persona_snapshot", "trigger", "parent_comment_id", "trigger_feedback_id", "scheduled_task_id", "content_analysis_id", "strategy_prompt_snapshot", "token_usage", "created_at", "import_batch_id"], database.comments.map((comment) => [
    sqlString(comment.id), sqlString(comment.runId), String(comment.position), sqlString(comment.content), sqlJson(comment.persona),
    sqlString(comment.trigger), sqlNullable(comment.parentCommentId), sqlNullable(comment.triggerFeedbackId), sqlNullable(comment.scheduledTaskId),
    sqlNullable(comment.contentAnalysisId), comment.strategyPromptSnapshot ? sqlJson(comment.strategyPromptSnapshot) : "null",
    comment.usage ? sqlJson(comment.usage) : "null", sqlString(comment.createdAt), sqlString(importBatchId),
  ])),
  ...database.commentTasks.filter((task) => task.commentId).map((task) =>
    `update public.lab_comment_tasks set comment_id = ${sqlString(task.commentId!)} where id = ${sqlString(task.id)};`),
  insert("lab_comment_evaluations", ["id", "comment_id", "human_likeness", "value_rating", "notes", "updated_at", "import_batch_id"], database.evaluations.map((evaluation) => [
    sqlString(evaluation.id), sqlString(evaluation.commentId), sqlNullable(evaluation.humanLikeness), sqlNullable(evaluation.value),
    sqlString(evaluation.notes), sqlString(evaluation.updatedAt), sqlString(importBatchId),
  ])),
  insert("lab_content_feedback", ["id", "input_id", "comment_id", "persona_id", "feedback_type", "reply_text", "active", "created_at", "updated_at", "import_batch_id"], database.contentFeedback.map((feedback) => [
    sqlString(feedback.id), sqlString(feedback.workId), sqlString(feedback.commentId), sqlString(feedback.personaId),
    sqlString(feedback.type), sqlNullable(feedback.replyText), sqlBoolean(feedback.active), sqlString(feedback.createdAt),
    sqlString(feedback.updatedAt), sqlString(importBatchId),
  ])),
  insert("lab_style_feedback", ["id", "input_id", "comment_id", "persona_id", "feedback_type", "reasons", "note", "created_at", "updated_at", "import_batch_id"], database.styleFeedback.map((feedback) => [
    sqlString(feedback.id), sqlString(feedback.workId), sqlString(feedback.commentId), sqlString(feedback.personaId),
    sqlString(feedback.type), sqlTextArray(feedback.reasons), sqlString(feedback.note), sqlString(feedback.createdAt),
    sqlString(feedback.updatedAt), sqlString(importBatchId),
  ])),
  insert("ai_personas", ["id", "display_name", "avatar_path", "bio", "enabled"], personaRows),
  insert("ai_persona_versions", ["id", "persona_id", "version", "configuration", "is_current", "created_by", "created_at"], personaVersionRows),
  insert("chat_messages", ["id", "room_id", "sender_type", "user_id", "persona_id", "legacy_sender_id", "sender_name_snapshot", "sender_avatar_snapshot", "content", "reply_to_message_id", "status", "persona_version", "model_config_snapshot", "prompt_version", "created_at", "updated_at", "deleted_at"], database.chatMessages.map((message) => [
    sqlString(message.id), sqlString(message.roomId), sqlString(message.senderType === "ai" ? "ai" : "legacy"), "null",
    message.senderType === "ai" ? sqlString(message.personaId!) : "null",
    message.senderType === "human" ? sqlString(message.senderId) : "null", sqlString(message.senderName),
    sqlNullable(message.senderAvatar), sqlString(message.content), sqlNullable(message.replyToMessageId), sqlString(message.status),
    sqlNumber(message.personaVersion), message.modelConfig ? sqlJson(message.modelConfig) : "null", sqlNullable(message.promptVersion),
    sqlString(message.createdAt), sqlString(message.updatedAt), sqlNullable(message.deletedAt),
  ])),
  insert("chat_ai_tasks", ["id", "room_id", "trigger_message_id", "persona_id", "persona_version", "scheduled_at", "status", "retry_count", "chain_depth", "created_at", "started_at", "generated_at", "generated_message_id", "execution_token", "last_error", "model_config_snapshot", "prompt_version"], database.chatAiTasks.map((task) => [
    sqlString(task.id), sqlString(task.roomId), sqlString(task.triggerMessageId), sqlString(task.personaId), String(task.personaVersion),
    sqlString(task.scheduledAt), sqlString(task.status), String(task.retryCount), String(task.chainDepth), sqlString(task.createdAt),
    sqlNullable(task.startedAt), sqlNullable(task.generatedAt), sqlNullable(task.generatedMessageId), sqlNullable(task.executionToken),
    sqlNullable(task.lastError), sqlJson(task.modelConfig), sqlString(task.promptVersion),
  ])),
  insert("chat_message_reports", ["id", "room_id", "message_id", "reporter_user_id", "reporter_legacy_id", "reported_user_id", "reported_persona_id", "reported_legacy_id", "reason", "note", "status", "created_at", "updated_at"], database.chatMessageReports.map((report) => [
    sqlString(report.id), sqlString(report.roomId), sqlString(report.messageId), "null", sqlString(report.reporterId), "null",
    report.reportedPersonaId ? sqlString(report.reportedPersonaId) : "null",
    report.reportedPersonaId ? "null" : sqlString(report.reportedSenderId), sqlString(report.reason), sqlString(report.note),
    sqlString(report.status), sqlString(report.createdAt), sqlString(report.updatedAt),
  ])),
  insert("chat_user_blocks", ["id", "room_id", "blocker_user_id", "blocker_legacy_id", "blocked_user_id", "blocked_legacy_id", "created_at"], database.chatUserBlocks.map((block) => [
    sqlString(block.id), sqlString(block.roomId), "null", sqlString(block.blockerId), "null", sqlString(block.blockedSenderId), sqlString(block.createdAt),
  ])),
  insert("chat_ai_style_feedback", ["id", "room_id", "message_id", "persona_id", "model", "prompt_version", "user_id", "legacy_user_id", "feedback_type", "reasons", "note", "created_at", "updated_at"], database.chatAiStyleFeedback.map((feedback) => [
    sqlString(feedback.id), sqlString(feedback.roomId), sqlString(feedback.messageId), sqlString(feedback.personaId),
    sqlString(feedback.model), sqlString(feedback.promptVersion), "null", sqlString(feedback.userId), sqlString(feedback.type),
    sqlTextArray(feedback.reasons), sqlString(feedback.note), sqlString(feedback.createdAt), sqlString(feedback.updatedAt),
  ])),
  "end",
  "$echo_import$;",
  "",
].join("\n\n");

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, sql, { encoding: "utf8", flag: "w" });

console.log(JSON.stringify({
  sourcePath,
  sourceChecksum,
  importBatchId,
  outputPath,
  sourceCounts,
  personas: personaRows.length,
  personaVersions: personaVersionRows.length,
  formalPostsImported: 0,
}, null, 2));
