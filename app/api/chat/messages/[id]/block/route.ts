import { blockChatSender } from "@/lib/ai-lab/storage";
import { PUBLIC_MOOD_ROOM_ID } from "@/lib/chat/config";
import { getOrCreateChatIdentity } from "@/lib/chat/identity";

export async function PUT(_request: Request, context: RouteContext<"/api/chat/messages/[id]/block">) {
  const identity = await getOrCreateChatIdentity();
  const { id } = await context.params;
  try {
    const block = await blockChatSender({
      roomId: PUBLIC_MOOD_ROOM_ID,
      messageId: id,
      blockerId: identity.id,
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
    return Response.json({ error: "屏蔽失败，请稍后重试。" }, { status: 500 });
  }
}
