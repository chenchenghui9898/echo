import "server-only";

import type { DeepSeekModelScenario, ModelConfigSnapshot } from "./types";
import { selectDeepSeekModel } from "./model-selection";

const DEFAULT_BASE_URL = "https://api.deepseek.com";

function numberFromEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const value = Number(environment[name]);
  return Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

let warnedAboutLegacyModel = false;

export function getModelConfig(
  scenario: DeepSeekModelScenario = "default",
  environment: NodeJS.ProcessEnv = process.env,
): ModelConfigSnapshot {
  const selected = selectDeepSeekModel(scenario, environment);
  if (selected.usedLegacyDefault && !warnedAboutLegacyModel) {
    console.warn(
      "DEEPSEEK_MODEL is deprecated; configure DEEPSEEK_MODEL_DEFAULT before deployment.",
    );
    warnedAboutLegacyModel = true;
  }
  const baseUrl = environment.DEEPSEEK_BASE_URL?.trim() || DEFAULT_BASE_URL;
  return {
    provider: "deepseek",
    baseUrl: baseUrl.replace(/\/+$/, ""),
    model: selected.model,
    modelScenario: scenario,
    temperature: numberFromEnv("DEEPSEEK_TEMPERATURE", 0.8, 0, 2, environment),
    maxTokens: Math.round(
      numberFromEnv("DEEPSEEK_MAX_TOKENS", 2400, 256, 8192, environment),
    ),
    requestTimeoutMs: Math.round(
      numberFromEnv("DEEPSEEK_TIMEOUT_MS", 60_000, 5_000, 180_000, environment),
    ),
    requestMaxAttempts: Math.round(
      numberFromEnv("DEEPSEEK_REQUEST_MAX_ATTEMPTS", 2, 1, 5, environment),
    ),
    commentCount: Math.round(
      numberFromEnv("DEEPSEEK_COMMENT_COUNT", 5, 1, 10, environment),
    ),
    outputContractVersion: "echo-comments-json-v1",
  };
}

export function hasDeepSeekApiKey() {
  return Boolean(process.env.DEEPSEEK_API_KEY?.trim());
}
