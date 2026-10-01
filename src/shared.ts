export const DEFAULT_MAX_RETRY_WAIT_MS = 300_000;
export const RETRY_MIN_REMAINING_MS = 30_000;
export const MAX_AUTOMATIC_BOUNCES = 3;

export function parseMaxRetryWaitMs(options?: unknown): number | null {
  if (options === null || options === undefined || typeof options !== "object") {
    return DEFAULT_MAX_RETRY_WAIT_MS;
  }

  const value = (options as Record<string, unknown>).maxRetryWaitMs;

  if (value === false) {
    return null;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_RETRY_WAIT_MS;
  }

  if (value > 0) {
    return value;
  }

  return null;
}

export function armMargin(cap: number | null): number {
  if (cap === null) {
    return 0;
  }
  return Math.min(RETRY_MIN_REMAINING_MS, Math.max(1, cap / 2));
}

export function isUsageLimitMessage(message: unknown): boolean {
  return typeof message === "string" && /usage limit|free limit/i.test(message);
}

export type AgentModel = { providerID: string; modelID: string };

export function shouldCapDelay(delayMs: number, cap: number | null): boolean {
  return cap !== null && delayMs > cap;
}
