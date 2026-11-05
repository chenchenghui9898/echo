import "server-only";

import { generateDeepSeekContentAnalysis } from "@/lib/ai-lab/deepseek";
import type {
  ContentAnalysis,
  InteractionPromptVersion,
  ModelConfigSnapshot,
  PostContentType,
  TokenUsage,
} from "@/lib/ai-lab/types";

import { fallbackContentAnalysis, parseContentAnalysis } from "./content-analysis";

export async function analyzeContent(input: {
  content: string;
  category: PostContentType;
  prompt: InteractionPromptVersion;
  modelConfig: ModelConfigSnapshot;
}): Promise<{
  analysis: ContentAnalysis;
  usage?: TokenUsage;
  source: "model" | "fallback";
  errorMessage?: string;
}> {
  try {
    const result = await generateDeepSeekContentAnalysis({
      work: input.content,
      selectedCategory: input.category,
      sensorPrompt: input.prompt.body,
      config: input.modelConfig,
    });
    return {
      analysis: parseContentAnalysis({ raw: result.content, category: input.category, content: input.content }),
      usage: result.usage,
      source: "model",
    };
  } catch {
    return {
      analysis: fallbackContentAnalysis({ category: input.category, content: input.content }),
      source: "fallback",
      errorMessage: "内容分析未成功，已使用低置信度默认策略。",
    };
  }
}
