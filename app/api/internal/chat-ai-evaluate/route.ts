import { getModelConfig } from "@/lib/ai-lab/config";
import { generateDeepSeekChatMessage, ModelServiceError } from "@/lib/ai-lab/deepseek";
import { getChatAiPersona } from "@/lib/chat/ai-personas";

function authorized(request: Request) {
  const token = process.env.ECHO_WORKER_TOKEN?.trim();
  if (process.env.NODE_ENV === "production" && !token) return false;
  return !token || request.headers.get("authorization") === `Bearer ${token}`;
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "未授权。" }, { status: 401 });
  const payload = (await request.json().catch(() => null)) as { content?: unknown; personaId?: unknown } | null;
  const content = typeof payload?.content === "string" ? payload.content.trim() : "";
  const persona = typeof payload?.personaId === "string" ? getChatAiPersona(payload.personaId) : null;
  if (!content || !persona) return Response.json({ error: "测试内容或人格无效。" }, { status: 400 });
  try {
    const result = await generateDeepSeekChatMessage({
      persona,
      context: [{
        senderName: "测试用户",
        senderType: "human",
        content,
        createdAt: new Date().toISOString(),
        isTrigger: true,
      }],
      config: getModelConfig(),
    });
    return Response.json({ message: result.message, persona: persona.name });
  } catch (error) {
    const message = error instanceof ModelServiceError ? error.publicMessage : "测试生成失败。";
    return Response.json({ error: message }, { status: 502 });
  }
}
