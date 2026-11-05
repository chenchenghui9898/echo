import { getChatRoomPreview } from "@/lib/ai-lab/storage";
import { PUBLIC_MOOD_ROOM_ID, PUBLIC_MOOD_ROOM_NAME } from "@/lib/chat/config";
import { getOrCreateChatIdentity } from "@/lib/chat/identity";

export async function GET() {
  const identity = await getOrCreateChatIdentity();
  const messages = await getChatRoomPreview({
    roomId: PUBLIC_MOOD_ROOM_ID,
    viewerUserId: identity.id,
    limit: 3,
  });
  return Response.json(
    { room: { id: PUBLIC_MOOD_ROOM_ID, name: PUBLIC_MOOD_ROOM_NAME }, messages },
    { headers: { "Cache-Control": "no-store" } },
  );
}
