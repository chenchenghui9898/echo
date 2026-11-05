export type PromptVersion = {
  id: string;
  version: number;
  name: string;
  body: string;
  notes: string;
  createdAt: string;
};

export type InteractionPromptScope =
  | "content_sensor"
  | "final_comment"
  | "strategy_viewpoint"
  | "strategy_mood"
  | "strategy_diary"
  | "strategy_work";

export type InteractionPromptVersion = PromptVersion & {
  scope: InteractionPromptScope;
};

export type WorkInput = {
  id: string;
  content: string;
  characterCount: number;
  createdAt: string;
};

export type PersonaSnapshot = {
  id: string;
  name: string;
  version: number;
  role?: string;
  activity?: "high" | "medium" | "low";
  interests?: string[];
  styleInstruction?: string;
  background?: string;
  values?: string[];
  topicFamiliarity?: Record<string, number>;
};

export type ModelConfigSnapshot = {
  provider: "deepseek";
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  requestTimeoutMs?: number;
  requestMaxAttempts?: number;
  commentCount: number;
  outputContractVersion: "echo-comments-json-v1";
};

export type TokenUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type GenerationRun = {
  id: string;
  workId: string;
  promptVersionId: string;
  promptSnapshot: PromptVersion | InteractionPromptVersion;
  systemPromptSnapshot: string;
  modelConfig: ModelConfigSnapshot;
  status: "running" | "completed" | "failed";
  errorMessage?: string;
  usage?: TokenUsage;
  createdAt: string;
  completedAt?: string;
  contentAnalysisId?: string;
};

export type ContentAnalysis = {
  contentCategory: PostContentType;
  actualContentType: string[];
  emotions: string[];
  expressionIntent: string[];
  topics: string[];
  primaryInteractionDirection: string;
  secondaryInteractionDirections: string[];
  unsuitableInteractionDirections: string[];
  confidence: number;
};

export type ContentAnalysisRecord = {
  id: string;
  workId: string;
  postId: string;
  analysis: ContentAnalysis;
  promptSnapshot: InteractionPromptVersion;
  modelConfig: ModelConfigSnapshot;
  usage?: TokenUsage;
  source: "model" | "fallback";
  errorMessage?: string;
  createdAt: string;
};

export type CommentTrigger = "initial" | "agreement" | "user_reply";

export type CommentRecord = {
  id: string;
  runId: string;
  position: number;
  content: string;
  persona: PersonaSnapshot;
  trigger: CommentTrigger;
  parentCommentId?: string;
  triggerFeedbackId?: string;
  scheduledTaskId?: string;
  contentAnalysisId?: string;
  strategyPromptSnapshot?: InteractionPromptVersion;
  usage?: TokenUsage;
  createdAt: string;
};

export type PostContentType = "观点" | "作品" | "心情" | "日记";

export type CommunityPost = {
  id: string;
  workId: string;
  runId: string;
  type: PostContentType;
  title?: string;
  author: string;
  publishedAt: string;
  deletedAt?: string;
  plannedCommentCount: number;
};

export type CommentTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type CommentTask = {
  id: string;
  postId: string;
  personaId: string;
  scheduledAt: string;
  status: CommentTaskStatus;
  generatedAt?: string;
  commentId?: string;
  retryCount: number;
  createdAt: string;
  startedAt?: string;
  executionToken?: string;
  lastError?: string;
  contentAnalysisId?: string;
  strategyPromptSnapshot?: InteractionPromptVersion;
};

export type CommentEvaluation = {
  id: string;
  commentId: string;
  humanLikeness: "human" | "not_human" | null;
  value: "valuable" | "not_valuable" | null;
  notes: string;
  updatedAt: string;
};

export type ContentFeedback = {
  id: string;
  workId: string;
  commentId: string;
  personaId: string;
  type: "agree" | "disagree" | "reply";
  replyText?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export const STYLE_REASON_CODES = [
  "ai_heavy",
  "formulaic",
  "vague",
  "over_analysis",
  "unnatural",
  "over_interpretation",
  "moralizing",
  "verbose",
  "other",
] as const;

export type StyleReasonCode = (typeof STYLE_REASON_CODES)[number];

export type StyleFeedback = {
  id: string;
  workId: string;
  commentId: string;
  personaId: string;
  type: "like" | "dislike";
  reasons: StyleReasonCode[];
  note: string;
  createdAt: string;
  updatedAt: string;
};

export type ChatSenderType = "human" | "ai";
export type ChatMessageStatus = "normal" | "deleted";

export const CHAT_REPORT_REASONS = [
  "spam",
  "sexual",
  "attack",
  "harassment",
  "illegal",
  "other",
] as const;

export type ChatReportReason = (typeof CHAT_REPORT_REASONS)[number];
export type ChatReportStatus = "pending" | "reviewed" | "dismissed" | "actioned";

export type ChatRoom = {
  id: string;
  name: string;
  createdAt: string;
};

export type ChatMessage = {
  id: string;
  roomId: string;
  senderId: string;
  senderType: ChatSenderType;
  senderName: string;
  senderAvatar?: string;
  personaId?: string;
  personaVersion?: number;
  content: string;
  replyToMessageId?: string;
  createdAt: string;
  updatedAt: string;
  status: ChatMessageStatus;
  deletedAt?: string;
  modelConfig?: ModelConfigSnapshot;
  promptVersion?: string;
};

export type ChatMessageView = Omit<ChatMessage, "modelConfig" | "promptVersion"> & {
  replyTo: Pick<ChatMessage, "id" | "senderName" | "content" | "status"> | null;
  styleFeedback: Pick<ChatAiStyleFeedback, "type" | "reasons" | "note" | "updatedAt"> | null;
};

export type ChatMessageReport = {
  id: string;
  roomId: string;
  messageId: string;
  reporterId: string;
  reportedSenderId: string;
  reportedPersonaId?: string;
  reason: ChatReportReason;
  note: string;
  status: ChatReportStatus;
  createdAt: string;
  updatedAt: string;
};

export type ChatUserBlock = {
  id: string;
  roomId: string;
  blockerId: string;
  blockedSenderId: string;
  createdAt: string;
};

export type ChatAiStyleFeedback = {
  id: string;
  roomId: string;
  messageId: string;
  personaId: string;
  model: string;
  promptVersion: string;
  userId: string;
  type: "like" | "dislike";
  reasons: StyleReasonCode[];
  note: string;
  createdAt: string;
  updatedAt: string;
};

export type ChatAiTaskStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export type ChatAiTask = {
  id: string;
  roomId: string;
  triggerMessageId: string;
  personaId: string;
  personaVersion: number;
  scheduledAt: string;
  status: ChatAiTaskStatus;
  retryCount: number;
  chainDepth: number;
  createdAt: string;
  startedAt?: string;
  generatedAt?: string;
  generatedMessageId?: string;
  executionToken?: string;
  lastError?: string;
  modelConfig: ModelConfigSnapshot;
  promptVersion: string;
};

export type LabDatabase = {
  schemaVersion: 7;
  promptVersions: PromptVersion[];
  interactionPromptVersions: InteractionPromptVersion[];
  contentAnalyses: ContentAnalysisRecord[];
  works: WorkInput[];
  runs: GenerationRun[];
  comments: CommentRecord[];
  evaluations: CommentEvaluation[];
  contentFeedback: ContentFeedback[];
  styleFeedback: StyleFeedback[];
  posts: CommunityPost[];
  commentTasks: CommentTask[];
  rooms: ChatRoom[];
  chatMessages: ChatMessage[];
  chatAiTasks: ChatAiTask[];
  chatMessageReports: ChatMessageReport[];
  chatUserBlocks: ChatUserBlock[];
  chatAiStyleFeedback: ChatAiStyleFeedback[];
};

export type CommunityComment = CommentWithFeedback & {
  role: string;
};

export type CommunityPostDetail = {
  post: CommunityPost;
  work: WorkInput;
  comments: CommunityComment[];
  pendingCommentCount: number;
  failedCommentCount: number;
  contentAnalysis: ContentAnalysisRecord | null;
};

export type CommentWithFeedback = CommentRecord & {
  evaluation: CommentEvaluation | null;
  contentReaction: ContentFeedback | null;
  userReplies: ContentFeedback[];
  styleFeedback: StyleFeedback | null;
};

export type RunDetail = {
  run: GenerationRun;
  work: WorkInput;
  comments: CommentWithFeedback[];
  contentAnalysis: ContentAnalysisRecord | null;
};

export type RunSummary = {
  id: string;
  status: GenerationRun["status"];
  createdAt: string;
  completedAt?: string;
  promptVersion: number;
  promptName: string;
  model: string;
  workPreview: string;
  characterCount: number;
  commentCount: number;
  errorMessage?: string;
};
