import { getModelConfig, hasDeepSeekApiKey } from "@/lib/ai-lab/config";
import { getInteractionPromptVersions, getLabState } from "@/lib/ai-lab/storage";

export async function GET() {
  try {
    const state = await getLabState();
    const interactionPromptVersions = await getInteractionPromptVersions();
    return Response.json({
      ...state,
      interactionPromptVersions,
      modelConfig: getModelConfig("comment"),
      keyConfigured: hasDeepSeekApiKey(),
    });
  } catch (error) {
    console.error("Failed to load AI lab state", error);
    return Response.json(
      { error: "无法读取实验室数据，请检查服务端日志。" },
      { status: 500 },
    );
  }
}
