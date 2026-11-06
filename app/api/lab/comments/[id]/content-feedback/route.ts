import {
  generateDeepSeekFollowUp,
  ModelServiceError,
} from "@/lib/ai-lab/deepseek";
import { getModelConfig } from "@/lib/ai-lab/config";
import {
  appendFollowUpComment,
  saveContentReaction,
  saveUserReply,
} from "@/lib/ai-lab/storage";
import type {
  CommentRecord,
  GenerationRun,
  RunDetail,
  WorkInput,
} from "@/lib/ai-lab/types";

async function readPayload(request: Request) {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function generateFollowUp(input: {
  sourceCommentId: string;
  feedbackId: string;
  trigger: "agreement" | "user_reply";
  replyText?: string;
  context: {
    work: WorkInput;
    comment: CommentRecord;
    run: GenerationRun;
    detail: RunDetail | null;
  };
}) {
  try {
    const modelConfig = getModelConfig("persona_dialogue");
    const generated = await generateDeepSeekFollowUp({
      work: input.context.work.content,
      originalComment: input.context.comment.content,
      userReply: input.replyText,
      trigger: input.trigger,
      persona: input.context.comment.persona,
      systemPrompt: input.context.run.systemPromptSnapshot,
      config: modelConfig,
    });
    const detail = await appendFollowUpComment({
      sourceCommentId: input.sourceCommentId,
      triggerFeedbackId: input.feedbackId,
      trigger: input.trigger,
      content: generated.comments[0],
      usage: generated.usage,
      modelConfig,
    });
    return { detail, generationError: null };
  } catch (error) {
    if (!(error instanceof ModelServiceError)) {
      console.error("Unexpected follow-up generation error", error);
    }
    return {
      detail: input.context.detail,
      generationError:
        error instanceof ModelServiceError
          ? error.publicMessage
          : "反馈已保存，但 AI 追加回复生成失败。",
    };
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const payload = await readPayload(request);
  if (!payload) {
    return Response.json({ error: "请求内容不是有效的 JSON。" }, { status: 400 });
  }
  const reaction = payload.reaction;
  if (reaction !== "agree" && reaction !== "disagree" && reaction !== null) {
    return Response.json({ error: "内容反馈类型无效。" }, { status: 400 });
  }

  try {
    const { id } = await context.params;
    const saved = await saveContentReaction({ commentId: id, reaction });
    if (!saved) {
      return Response.json({ error: "没有找到这条评论。" }, { status: 404 });
    }
    if (
      reaction === "agree" &&
      saved.shouldGenerateFollowUp &&
      saved.feedback
    ) {
      const generated = await generateFollowUp({
        sourceCommentId: id,
        feedbackId: saved.feedback.id,
        trigger: "agreement",
        context: saved,
      });
      return Response.json({ saved: true, ...generated });
    }
    return Response.json({ saved: true, detail: saved.detail });
  } catch (error) {
    console.error("Failed to save content reaction", error);
    return Response.json({ error: "无法保存内容反馈，请稍后重试。" }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const payload = await readPayload(request);
  if (!payload) {
    return Response.json({ error: "请求内容不是有效的 JSON。" }, { status: 400 });
  }
  const replyText = typeof payload.replyText === "string" ? payload.replyText.trim() : "";
  if (!replyText) {
    return Response.json({ error: "回复内容不能为空。" }, { status: 400 });
  }
  if (replyText.length > 2_000) {
    return Response.json({ error: "回复暂时最多支持 2,000 个字符。" }, { status: 400 });
  }

  try {
    const { id } = await context.params;
    const saved = await saveUserReply({ commentId: id, replyText });
    if (!saved) {
      return Response.json({ error: "没有找到这条评论。" }, { status: 404 });
    }
    const generated = await generateFollowUp({
      sourceCommentId: id,
      feedbackId: saved.feedback.id,
      trigger: "user_reply",
      replyText,
      context: saved,
    });
    return Response.json({ saved: true, ...generated });
  } catch (error) {
    if ((error as Error).message === "REPLY_RATE_LIMIT") {
      return Response.json(
        { error: "回复过于频繁，请等待几秒后再发送。" },
        { status: 429 },
      );
    }
    if ((error as Error).message === "RUN_REPLY_LIMIT") {
      return Response.json(
        { error: "本次实验已达到 20 次回复上限，请新建一次生成任务继续测试。" },
        { status: 429 },
      );
    }
    console.error("Failed to save comment reply", error);
    return Response.json({ error: "无法保存回复，请稍后重试。" }, { status: 500 });
  }
}
