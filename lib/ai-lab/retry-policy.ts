export const DEEPSEEK_MAX_ATTEMPTS = 2;

const RETRYABLE_STATUS_CODES = new Set([
  408,
  425,
  429,
  500,
  502,
  503,
  504,
]);

export function isRetryableDeepSeekStatus(status: number) {
  return RETRYABLE_STATUS_CODES.has(status);
}

export function getDeepSeekRetryDelayMs(
  attempt: number,
  retryAfter: string | null = null,
  nowMs = Date.now(),
) {
  const baseDelay = Math.min(2_000, 600 * 2 ** Math.max(0, attempt - 1));
  if (!retryAfter) return baseDelay;

  const seconds = Number(retryAfter);
  const retryAfterMs = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(retryAfter) - nowMs;

  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return baseDelay;
  return Math.min(2_000, Math.max(250, Math.round(retryAfterMs)));
}
