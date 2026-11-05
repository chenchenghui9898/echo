import { getModelConfig } from "@/lib/ai-lab/config";
import {
  generateDeepSeekComments,
  ModelServiceError,
} from "@/lib/ai-lab/deepseek";
import {
  completeGeneration,
  failGeneration,
  startGeneration,
} from "@/lib/ai-lab/storage";

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "请求内容不是有效的 JSON。" }, { status: 400 });
  }

  const { content, promptVersionId } = (payload ?? {}) as Record<string, unknown>;
  if (typeof content !== "string" || !content.trim()) {
    return Response.json({ error: "请先输入需要评论的作品。" }, { status: 400 });
  }
  if (content.trim().length > 30_000) {
    return Response.json(
      { error: "作品暂时最多支持 30,000 个字符。" },
      { status: 400 },
    );
  }
  if (typeof promptVersionId !== "string" || !promptVersionId) {
    return Response.json({ error: "请选择提示词版本。" }, { status: 400 });
  }

  const modelConfig = getModelConfig();
  let runId: string | undefined;
  try {
    const started = await startGeneration({
      content: content.trim(),
      promptVersionId,
      modelConfig,
    });
    runId = started.run.id;

    const generated = await generateDeepSeekComments({
      work: started.work.content,
      systemPrompt: started.run.systemPromptSnapshot,
      config: modelConfig,
    });
    const detail = await completeGeneration(
      started.run.id,
      generated.comments,
      generated.usage,
    );
    return Response.json({ detail });
  } catch (error) {
    if ((error as Error).message === "PROMPT_NOT_FOUND") {
      return Response.json(
        { error: "所选提示词版本不存在，请刷新后重试。" },
        { status: 404 },
      );
    }

    const publicError =
      error instanceof ModelServiceError
        ? error
        : new ModelServiceError("生成评论失败，请稍后重试。", 500);
    if (!(error instanceof ModelServiceError)) {
      console.error("Unexpected comment generation error", error);
    }
    if (runId) await failGeneration(runId, publicError.publicMessage);
    return Response.json(
      { error: publicError.publicMessage, runId },
      { status: publicError.status },
    );
  }
}
