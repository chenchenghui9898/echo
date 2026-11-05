import { createPromptVersion } from "@/lib/ai-lab/storage";

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "请求内容不是有效的 JSON。" }, { status: 400 });
  }

  const { name, body, notes } = (payload ?? {}) as Record<string, unknown>;
  if (typeof name !== "string" || !name.trim()) {
    return Response.json({ error: "请填写提示词名称。" }, { status: 400 });
  }
  if (typeof body !== "string" || !body.trim()) {
    return Response.json({ error: "提示词正文不能为空。" }, { status: 400 });
  }
  if (name.trim().length > 80 || body.length > 20_000) {
    return Response.json(
      { error: "提示词名称或正文过长，请精简后保存。" },
      { status: 400 },
    );
  }

  try {
    const prompt = await createPromptVersion({
      name,
      body,
      notes: typeof notes === "string" ? notes : "",
    });
    return Response.json({ prompt }, { status: 201 });
  } catch (error) {
    console.error("Failed to save prompt version", error);
    return Response.json(
      { error: "无法保存提示词版本，请检查服务端日志。" },
      { status: 500 },
    );
  }
}
