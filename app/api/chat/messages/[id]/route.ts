import { deleteOwnChatMessage, getChatRequestContext } from "@/lib/chat/repository";
import { PUBLIC_MOOD_ROOM_ID } from "@/lib/chat/config";

export async function DELETE(_request: Request, context: RouteContext<"/api/chat/messages/[id]">) {
  const { id } = await context.params;
  try {
    const requestContext = await getChatRequestContext();
    const message = await deleteOwnChatMessage(requestContext, {
      roomId: PUBLIC_MOOD_ROOM_ID,
      messageId: id,
    });
    return Response.json({ message });
  } catch (error) {
    const code = (error as Error).message;
    if (code === "CHAT_MESSAGE_NOT_FOUND") {
      return Response.json({ error: "消息不存在。" }, { status: 404 });
    }
    if (code === "CHAT_MESSAGE_DELETE_FORBIDDEN") {
      return Response.json({ error: "只能删除自己发送的消息。" }, { status: 403 });
    }
    if (code.startsWith("SUPABASE_") || code === "INVALID_ECHO_DATA_BACKEND") {
      return Response.json({ error: "群聊服务尚未正确配置。" }, { status: 503 });
    }
    return Response.json({ error: "删除失败，请稍后重试。" }, { status: 500 });
  }
}
