import { blockChatSender, getChatRequestContext } from "@/lib/chat/repository";
import { PUBLIC_MOOD_ROOM_ID } from "@/lib/chat/config";

export async function PUT(_request: Request, context: RouteContext<"/api/chat/messages/[id]/block">) {
  const { id } = await context.params;
  try {
    const requestContext = await getChatRequestContext();
    const block = await blockChatSender(requestContext, {
      roomId: PUBLIC_MOOD_ROOM_ID,
      messageId: id,
    });
    return Response.json({ block });
  } catch (error) {
    const code = (error as Error).message;
    if (code === "CHAT_MESSAGE_NOT_FOUND") {
      return Response.json({ error: "这条消息已不存在。" }, { status: 404 });
    }
    if (code === "CHAT_BLOCK_AI_UNSUPPORTED") {
      return Response.json({ error: "第一版暂不支持屏蔽 AI 人格。" }, { status: 400 });
    }
    if (code === "CHAT_BLOCK_SELF") {
      return Response.json({ error: "不能屏蔽自己。" }, { status: 400 });
    }
    if (code.startsWith("SUPABASE_") || code === "INVALID_ECHO_DATA_BACKEND") {
      return Response.json({ error: "群聊服务尚未正确配置。" }, { status: 503 });
    }
    return Response.json({ error: "屏蔽失败，请稍后重试。" }, { status: 500 });
  }
}
