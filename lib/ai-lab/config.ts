import "server-only";

import type { ModelConfigSnapshot } from "./types";

const DEFAULT_BASE_URL = "https://api.deepseek.com";

function numberFromEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

export function getModelConfig(): ModelConfigSnapshot {
  const baseUrl = process.env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_BASE_URL;
  return {
    provider: "deepseek",
    baseUrl: baseUrl.replace(/\/+$/, ""),
    model: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-flash",
    temperature: numberFromEnv("DEEPSEEK_TEMPERATURE", 0.8, 0, 2),
    maxTokens: Math.round(
      numberFromEnv("DEEPSEEK_MAX_TOKENS", 2400, 256, 8192),
    ),
    requestTimeoutMs: Math.round(
      numberFromEnv("DEEPSEEK_TIMEOUT_MS", 60_000, 5_000, 180_000),
    ),
    requestMaxAttempts: Math.round(
      numberFromEnv("DEEPSEEK_REQUEST_MAX_ATTEMPTS", 2, 1, 5),
    ),
    commentCount: Math.round(
      numberFromEnv("DEEPSEEK_COMMENT_COUNT", 5, 1, 10),
    ),
    outputContractVersion: "echo-comments-json-v1",
  };
}

export function hasDeepSeekApiKey() {
  return Boolean(process.env.DEEPSEEK_API_KEY?.trim());
}
