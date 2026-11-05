import { upsertChatAiStyleFeedback } from "@/lib/ai-lab/storage";
import { PUBLIC_MOOD_ROOM_ID } from "@/lib/chat/config";
import { getOrCreateChatIdentity } from "@/lib/chat/identity";
import { validateChatStyleFeedback } from "@/lib/chat/rules";

export async function PUT(request: Request, context: RouteContext<"/api/chat/messages/[id]/style-feedback">) {
  const identity = await getOrCreateChatIdentity();
  const { id } = await context.params;
  let payload: Record<string, unknown>;
  try {
    payload = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: "请求内容不是有效的 JSON。" }, { status: 400 });
  }
  const validation = validateChatStyleFeedback({
    type: payload.type,
    reasons: payload.reasons,
    note: payload.note,
  });
  if (validation.error || !validation.type) {
    return Response.json({ error: validation.error }, { status: 400 });
  }
  try {
    const feedback = await upsertChatAiStyleFeedback({
      roomId: PUBLIC_MOOD_ROOM_ID,
      messageId: id,
      userId: identity.id,
      type: validation.type,
      reasons: validation.reasons,
      note: validation.note,
    });
    return Response.json({ feedback });
  } catch (error) {
    const code = (error as Error).message;
    if (code === "CHAT_MESSAGE_NOT_FOUND") {
      return Response.json({ error: "这条消息已不存在。" }, { status: 404 });
    }
    if (code === "CHAT_STYLE_FEEDBACK_AI_ONLY") {
      return Response.json({ error: "语言风格反馈只适用于 AI 消息。" }, { status: 400 });
    }
    return Response.json({ error: "反馈保存失败，请稍后重试。" }, { status: 500 });
  }
}
