import {
  createInteractionPromptVersion,
  getInteractionPromptVersions,
} from "@/lib/ai-lab/storage";
import type { InteractionPromptScope } from "@/lib/ai-lab/types";

const SCOPES: InteractionPromptScope[] = [
  "content_sensor",
  "final_comment",
  "strategy_viewpoint",
  "strategy_mood",
  "strategy_diary",
  "strategy_work",
];

export async function GET(request: Request) {
  const scope = new URL(request.url).searchParams.get("scope") as InteractionPromptScope | null;
  if (scope && !SCOPES.includes(scope)) {
    return Response.json({ error: "提示词类型无效。" }, { status: 400 });
  }
  return Response.json({ prompts: await getInteractionPromptVersions(scope ?? undefined) });
}

export async function POST(request: Request) {
  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "请求内容不是有效的 JSON。" }, { status: 400 });
  }
  const scope = payload.scope as InteractionPromptScope;
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  const notes = typeof payload.notes === "string" ? payload.notes.trim() : "";
  if (!SCOPES.includes(scope) || !name || !body) {
    return Response.json({ error: "请填写有效的提示词类型、名称和正文。" }, { status: 400 });
  }
  if (name.length > 80 || body.length > 20_000) {
    return Response.json({ error: "提示词名称或正文过长。" }, { status: 400 });
  }
  const prompt = await createInteractionPromptVersion({ scope, name, body, notes });
  return Response.json({ prompt }, { status: 201 });
}
