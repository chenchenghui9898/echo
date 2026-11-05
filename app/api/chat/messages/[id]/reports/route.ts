import { getChatRequestContext, upsertChatMessageReport } from "@/lib/chat/repository";
import { PUBLIC_MOOD_ROOM_ID } from "@/lib/chat/config";
import { validateChatReport } from "@/lib/chat/rules";

export async function PUT(request: Request, context: RouteContext<"/api/chat/messages/[id]/reports">) {
  const { id } = await context.params;
  let payload: Record<string, unknown>;
  try {
    payload = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: "请求内容不是有效的 JSON。" }, { status: 400 });
  }
  const validation = validateChatReport(payload.reason, payload.note);
  if (validation.error || !validation.reason) {
    return Response.json({ error: validation.error }, { status: 400 });
  }
  try {
    const requestContext = await getChatRequestContext();
    const report = await upsertChatMessageReport(requestContext, {
      roomId: PUBLIC_MOOD_ROOM_ID,
      messageId: id,
      reason: validation.reason,
      note: validation.note,
    });
    return Response.json({ report });
  } catch (error) {
    const code = (error as Error).message;
    if (code === "CHAT_MESSAGE_NOT_FOUND") {
      return Response.json({ error: "这条消息已不存在。" }, { status: 404 });
    }
    if (code === "CHAT_REPORT_OWN_MESSAGE") {
      return Response.json({ error: "不能举报自己的消息。" }, { status: 400 });
    }
    if (code.startsWith("SUPABASE_") || code === "INVALID_ECHO_DATA_BACKEND") {
      return Response.json({ error: "群聊服务尚未正确配置。" }, { status: 503 });
    }
    return Response.json({ error: "举报提交失败，请稍后重试。" }, { status: 500 });
  }
}
