import { getModelConfig } from "@/lib/ai-lab/config";
import { createScheduledPost, getInteractionPromptVersions, listCommunityPosts } from "@/lib/ai-lab/storage";
import type { PostContentType } from "@/lib/ai-lab/types";
import { createCommentPlan } from "@/lib/community/planner";
import { analyzeContent } from "@/lib/community/content-sensor";
import { CATEGORY_PROMPT_SCOPE } from "@/lib/community/prompt-defaults";

const TYPES: PostContentType[] = ["观点", "作品", "日记"];

export async function GET() {
  return Response.json({ posts: await listCommunityPosts() });
}

export async function POST(request: Request) {
  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "请求内容不是有效的 JSON。" }, { status: 400 });
  }
  const content = typeof payload.content === "string" ? payload.content.trim() : "";
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const type = payload.type as PostContentType;
  if (!TYPES.includes(type) || !content) {
    return Response.json({ error: "请选择内容类型并填写正文。" }, { status: 400 });
  }
  if (content.length > 30_000 || title.length > 100) {
    return Response.json({ error: "标题或正文超过当前长度限制。" }, { status: 400 });
  }
  try {
    const interactionPrompts = await getInteractionPromptVersions();
    const sensorPrompt = interactionPrompts.find((item) => item.scope === "content_sensor");
    const finalPrompt = interactionPrompts.find((item) => item.scope === "final_comment");
    const strategyPrompt = interactionPrompts.find(
      (item) => item.scope === CATEGORY_PROMPT_SCOPE[type],
    );
    if (!sensorPrompt || !finalPrompt || !strategyPrompt) throw new Error("INTERACTION_PROMPT_NOT_FOUND");
    const modelConfig = getModelConfig();
    const analyzed = await analyzeContent({
      content,
      category: type,
      prompt: sensorPrompt,
      modelConfig,
    });
    const publishedAt = new Date();
    const plan = createCommentPlan({
      content,
      type,
      publishedAt,
      analyzedTopics: analyzed.analysis.topics,
    });
    const post = await createScheduledPost({
      type,
      title,
      content,
      author: "你",
      finalPrompt,
      modelConfig,
      plan: plan.map((item) => ({ personaId: item.persona.id, scheduledAt: item.scheduledAt })),
      analysis: analyzed.analysis,
      analysisPrompt: sensorPrompt,
      analysisUsage: analyzed.usage,
      analysisSource: analyzed.source,
      analysisErrorMessage: analyzed.errorMessage,
      strategyPrompt,
    });
    return Response.json({ post }, { status: 201 });
  } catch (error) {
    console.error("Failed to publish scheduled post", error);
    return Response.json({ error: "发布失败，请稍后重试。" }, { status: 500 });
  }
}
