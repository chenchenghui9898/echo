import { saveStyleFeedback } from "@/lib/ai-lab/storage";
import { hasStyleFeedbackContent } from "@/lib/ai-lab/feedback-rules";
import {
  STYLE_REASON_CODES,
  type StyleFeedback,
  type StyleReasonCode,
} from "@/lib/ai-lab/types";

const validReasons = new Set<string>(STYLE_REASON_CODES);

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "请求内容不是有效的 JSON。" }, { status: 400 });
  }

  const type = payload.type;
  const reasons = Array.isArray(payload.reasons) ? payload.reasons : [];
  const note = typeof payload.note === "string" ? payload.note.trim() : "";
  if (type !== "like" && type !== "dislike") {
    return Response.json({ error: "风格反馈类型无效。" }, { status: 400 });
  }
  if (
    reasons.some((reason) => typeof reason !== "string" || !validReasons.has(reason))
  ) {
    return Response.json({ error: "包含无效的风格问题选项。" }, { status: 400 });
  }
  if (type === "dislike" && !hasStyleFeedbackContent(reasons as string[], note)) {
    return Response.json(
      { error: "请至少选择一个原因，或填写具体说明。" },
      { status: 400 },
    );
  }
  if (note.length > 2_000) {
    return Response.json({ error: "补充说明暂时最多支持 2,000 个字符。" }, { status: 400 });
  }

  try {
    const { id } = await context.params;
    const saved = await saveStyleFeedback({
      commentId: id,
      type: type as StyleFeedback["type"],
      reasons: reasons as StyleReasonCode[],
      note,
    });
    if (!saved) {
      return Response.json({ error: "没有找到这条评论。" }, { status: 404 });
    }
    return Response.json({ saved: true, ...saved });
  } catch (error) {
    console.error("Failed to save style feedback", error);
    return Response.json({ error: "无法保存风格反馈，请稍后重试。" }, { status: 500 });
  }
}
