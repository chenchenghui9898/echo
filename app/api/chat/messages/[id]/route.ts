import { deleteOwnChatMessage } from "@/lib/ai-lab/storage";
import { PUBLIC_MOOD_ROOM_ID } from "@/lib/chat/config";
import { getOrCreateChatIdentity } from "@/lib/chat/identity";

export async function DELETE(_request: Request, context: RouteContext<"/api/chat/messages/[id]">) {
  const identity = await getOrCreateChatIdentity();
  const { id } = await context.params;
  try {
    const message = await deleteOwnChatMessage({
      roomId: PUBLIC_MOOD_ROOM_ID,
      messageId: id,
      userId: identity.id,
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
    return Response.json({ error: "删除失败，请稍后重试。" }, { status: 500 });
  }
}
