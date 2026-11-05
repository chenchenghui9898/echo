export type ActivityLevel = "high" | "medium" | "low";

export type SchedulerStage = {
  id: "initial" | "natural" | "sustained" | "later";
  startMs: number;
  endMs: number;
  suggestedMin: number;
  suggestedMax: number;
  weight: number;
  frontBiasExponent: number;
};

function envNumber(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

export const COMMENT_COUNT_BUCKETS = [
  { min: 0, max: 0, probability: 0.05 },
  { min: 1, max: 2, probability: 0.15 },
  { min: 3, max: 4, probability: 0.35 },
  { min: 5, max: 6, probability: 0.3 },
  { min: 7, max: 9, probability: 0.15 },
] as const;

export const SCHEDULER_STAGES: SchedulerStage[] = [
  { id: "initial", startMs: 30_000, endMs: 5 * 60_000, suggestedMin: 1, suggestedMax: 2, weight: 3.4, frontBiasExponent: 2.2 },
  { id: "natural", startMs: 5 * 60_000, endMs: 30 * 60_000, suggestedMin: 1, suggestedMax: 3, weight: 3, frontBiasExponent: 2 },
  { id: "sustained", startMs: 30 * 60_000, endMs: 3 * 60 * 60_000, suggestedMin: 0, suggestedMax: 3, weight: 1.8, frontBiasExponent: 2.3 },
  { id: "later", startMs: 3 * 60 * 60_000, endMs: 12 * 60 * 60_000, suggestedMin: 0, suggestedMax: 1, weight: 0.7, frontBiasExponent: 2.6 },
];

export function getSchedulerConfig() {
  return {
    timeScale: envNumber("ECHO_SCHEDULER_TIME_SCALE", 1, 0.0001, 10),
    pollIntervalMs: Math.round(envNumber("ECHO_SCHEDULER_POLL_MS", 5_000, 500, 60_000)),
    minGapMs: Math.round(envNumber("ECHO_SCHEDULER_MIN_GAP_MS", 20_000, 1_000, 120_000)),
    maxGapMs: Math.round(envNumber("ECHO_SCHEDULER_MAX_GAP_MS", 40_000, 1_000, 180_000)),
    shortGapProbability: envNumber("ECHO_SCHEDULER_SHORT_GAP_PROBABILITY", 0.1, 0, 0.5),
    maxCommentsPerPost: Math.round(envNumber("ECHO_SCHEDULER_MAX_COMMENTS", 9, 0, 20)),
    concurrency: Math.round(envNumber("ECHO_SCHEDULER_CONCURRENCY", 2, 1, 8)),
    maxRetries: Math.round(envNumber("ECHO_SCHEDULER_MAX_RETRIES", 3, 0, 10)),
    retryBaseMs: Math.round(envNumber("ECHO_SCHEDULER_RETRY_BASE_MS", 30_000, 1_000, 3_600_000)),
    staleRunningMs: Math.round(envNumber("ECHO_SCHEDULER_STALE_RUNNING_MS", 5 * 60_000, 30_000, 3_600_000)),
    maxCycleMs: Math.round(envNumber("ECHO_SCHEDULER_MAX_CYCLE_MS", 12 * 60 * 60_000, 60_000, 48 * 60 * 60_000)),
    stages: SCHEDULER_STAGES,
  };
}

export const ACTIVITY_WEIGHTS: Record<ActivityLevel, number> = {
  high: 1.35,
  medium: 1,
  low: 0.62,
};
