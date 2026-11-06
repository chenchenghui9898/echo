import type { DeepSeekModelScenario } from "./types.ts";

export const DEEPSEEK_MODEL_ENV_BY_SCENARIO: Record<DeepSeekModelScenario, string> = {
  default: "DEEPSEEK_MODEL_DEFAULT",
  chat_intent: "DEEPSEEK_MODEL_CHAT_INTENT",
  chat_reply: "DEEPSEEK_MODEL_CHAT_REPLY",
  content_analysis: "DEEPSEEK_MODEL_CONTENT_ANALYSIS",
  comment: "DEEPSEEK_MODEL_COMMENT",
  persona_dialogue: "DEEPSEEK_MODEL_PERSONA_DIALOGUE",
};

export class DeepSeekModelConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeepSeekModelConfigurationError";
  }
}

export function selectDeepSeekModel(
  scenario: DeepSeekModelScenario,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const configuredDefault = environment.DEEPSEEK_MODEL_DEFAULT?.trim();
  const legacyDefault = environment.DEEPSEEK_MODEL?.trim();
  const defaultModel = configuredDefault || legacyDefault;
  if (!defaultModel) {
    throw new DeepSeekModelConfigurationError(
      "DEEPSEEK_MODEL_DEFAULT_MISSING: 请在服务端配置 DEEPSEEK_MODEL_DEFAULT。",
    );
  }
  const scenarioKey = DEEPSEEK_MODEL_ENV_BY_SCENARIO[scenario];
  const scenarioModel = scenario === "default"
    ? configuredDefault
    : environment[scenarioKey]?.trim();
  return {
    model: scenarioModel || defaultModel,
    source: scenarioModel ? scenarioKey : configuredDefault
      ? "DEEPSEEK_MODEL_DEFAULT"
      : "DEEPSEEK_MODEL",
    usedLegacyDefault: !configuredDefault && Boolean(legacyDefault),
  };
}
