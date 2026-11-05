import { CHAT_CONFIG, PUBLIC_MOOD_ROOM_ID } from "@/lib/chat/config";
import { getOrCreateChatIdentity } from "@/lib/chat/identity";
import { validateChatContent } from "@/lib/chat/rules";
import { createChatMessage, listChatMessages } from "@/lib/ai-lab/storage";
import { scheduleAiForHumanMessage } from "@/lib/chat/ai-scheduler";

export async function GET(request: Request) {
  const identity = await getOrCreateChatIdentity();
  const searchParams = new URL(request.url).searchParams;
  const beforeId = searchParams.get("beforeId")?.trim() || undefined;
  const afterId = searchParams.get("afterId")?.trim() || undefined;
  if (beforeId && afterId) {
    return Response.json({ error: "不能同时使用两个消息游标。" }, { status: 400 });
  }
  const limitValue = searchParams.get("limit");
  const requestedLimit = limitValue === null ? Number.NaN : Number(limitValue);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(
        Math.max(1, Math.floor(requestedLimit)),
        afterId ? CHAT_CONFIG.maxPollBatchSize : CHAT_CONFIG.pageSize,
      )
    : CHAT_CONFIG.pageSize;
  const page = await listChatMessages({
    roomId: PUBLIC_MOOD_ROOM_ID,
    limit,
    beforeId,
    afterId,
    viewerUserId: identity.id,
  });
  return Response.json(
    {
      ...page,
      currentUser: identity,
      room: { id: PUBLIC_MOOD_ROOM_ID, name: "此刻" },
      config: {
        maxMessageLength: CHAT_CONFIG.maxMessageLength,
        pollIntervalMs: CHAT_CONFIG.pollIntervalMs,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const identity = await getOrCreateChatIdentity();
  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "请求内容不是有效的 JSON。" }, { status: 400 });
  }
  const validation = validateChatContent(payload.content, CHAT_CONFIG.maxMessageLength);
  const content = validation.content;
  const replyToMessageId =
    typeof payload.replyToMessageId === "string" && payload.replyToMessageId.trim()
      ? payload.replyToMessageId.trim()
      : undefined;
  if (validation.error) return Response.json({ error: validation.error }, { status: 400 });
  try {
    const message = await createChatMessage({
      roomId: PUBLIC_MOOD_ROOM_ID,
      senderId: identity.id,
      senderType: "human",
      senderName: identity.name,
      content,
      replyToMessageId,
    });
    try {
      await scheduleAiForHumanMessage(message.id);
    } catch (schedulingError) {
      console.error("Failed to schedule AI chat participation", schedulingError);
    }
    return Response.json({ message, currentUser: identity }, { status: 201 });
  } catch (error) {
    if (
      (error as Error).message === "REPLY_MESSAGE_NOT_FOUND" ||
      (error as Error).message === "REPLY_MESSAGE_DELETED"
    ) {
      return Response.json({ error: "被回复的消息已不存在，请取消引用后重试。" }, { status: 409 });
    }
    console.error("Failed to create chat message", error);
    return Response.json({ error: "消息发送失败，请保留内容后重试。" }, { status: 500 });
  }
}
