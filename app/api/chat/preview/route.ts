import { getPublicChatRoomPreview } from "@/lib/chat/repository";
import { PUBLIC_MOOD_ROOM_ID, PUBLIC_MOOD_ROOM_NAME } from "@/lib/chat/config";
import { connection } from "next/server";

export async function GET() {
  await connection();
  try {
    const messages = await getPublicChatRoomPreview({
      roomId: PUBLIC_MOOD_ROOM_ID,
      limit: 3,
    });
    return Response.json(
      { room: { id: PUBLIC_MOOD_ROOM_ID, name: PUBLIC_MOOD_ROOM_NAME }, messages },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Failed to load chat preview", error);
    return Response.json({ error: "心情群聊暂时无法加载。" }, { status: 503 });
  }
}
