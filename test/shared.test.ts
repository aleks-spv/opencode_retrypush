import { describe, it, expect } from "vitest";
import { parseMaxRetryWaitMs, armMargin, isUsageLimitMessage, shouldCapDelay, DEFAULT_MAX_RETRY_WAIT_MS, RETRY_MIN_REMAINING_MS, MAX_AUTOMATIC_BOUNCES } from "../src/shared";

describe("parseMaxRetryWaitMs", () => {
  it("returns null when options.maxRetryWaitMs is false", () => {
    expect(parseMaxRetryWaitMs({ maxRetryWaitMs: false })).toBe(null);
  });

  it("returns default when options is undefined", () => {
    expect(parseMaxRetryWaitMs(undefined)).toBe(DEFAULT_MAX_RETRY_WAIT_MS);
  });

  it("returns default when options is null", () => {
    expect(parseMaxRetryWaitMs(null)).toBe(DEFAULT_MAX_RETRY_WAIT_MS);
  });

  it("returns default when options is not an object", () => {
    expect(parseMaxRetryWaitMs("string")).toBe(DEFAULT_MAX_RETRY_WAIT_MS);
    expect(parseMaxRetryWaitMs(123)).toBe(DEFAULT_MAX_RETRY_WAIT_MS);
  });

  it("returns default when maxRetryWaitMs is not a number", () => {
    expect(parseMaxRetryWaitMs({ maxRetryWaitMs: "abc" })).toBe(DEFAULT_MAX_RETRY_WAIT_MS);
  });

  it("returns default when maxRetryWaitMs is NaN", () => {
    expect(parseMaxRetryWaitMs({ maxRetryWaitMs: NaN })).toBe(DEFAULT_MAX_RETRY_WAIT_MS);
  });

  it("returns default when maxRetryWaitMs is Infinity", () => {
    expect(parseMaxRetryWaitMs({ maxRetryWaitMs: Infinity })).toBe(DEFAULT_MAX_RETRY_WAIT_MS);
  });

  it("returns null when maxRetryWaitMs is 0", () => {
    expect(parseMaxRetryWaitMs({ maxRetryWaitMs: 0 })).toBe(null);
  });

  it("returns null when maxRetryWaitMs is negative", () => {
    expect(parseMaxRetryWaitMs({ maxRetryWaitMs: -5 })).toBe(null);
  });

  it("returns the value when maxRetryWaitMs is positive", () => {
    expect(parseMaxRetryWaitMs({ maxRetryWaitMs: 10_000 })).toBe(10_000);
    expect(parseMaxRetryWaitMs({ maxRetryWaitMs: 1 })).toBe(1);
  });
});

describe("armMargin", () => {
  it("returns 0 when cap is null", () => {
    expect(armMargin(null)).toBe(0);
  });

  it("returns cap/2 when cap is positive and result exceeds min", () => {
    expect(armMargin(300_000)).toBe(30_000);
  });

  it("returns min when cap/2 is larger than min", () => {
    expect(armMargin(60_000)).toBe(30_000);
  });

  it("returns cap/2 when cap is small", () => {
    expect(armMargin(10_000)).toBe(5_000);
  });

  it("returns 1 (Math.max minimum) when cap is very small", () => {
    expect(armMargin(2)).toBe(1);
    expect(armMargin(1)).toBe(1);
  });
});

describe("isUsageLimitMessage", () => {
  it("returns true for 'Usage limit' message", () => {
    expect(isUsageLimitMessage("Usage limit reached")).toBe(true);
  });

  it("returns true for 'free limit' message case-insensitive", () => {
    expect(isUsageLimitMessage("free LIMIT")).toBe(true);
  });

  it("returns false for rate limit message", () => {
    expect(isUsageLimitMessage("rate limited")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isUsageLimitMessage(undefined)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isUsageLimitMessage(null)).toBe(false);
  });

  it("returns false for non-string types", () => {
    expect(isUsageLimitMessage(123)).toBe(false);
    expect(isUsageLimitMessage({})).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isUsageLimitMessage("")).toBe(false);
  });
});

describe("shouldCapDelay", () => {
  it("returns true when delay exceeds cap", () => {
    expect(shouldCapDelay(600_000, 300_000)).toBe(true);
  });

  it("returns false when delay equals cap (no capping at boundary)", () => {
    expect(shouldCapDelay(300_000, 300_000)).toBe(false);
  });

  it("returns false when delay is less than cap", () => {
    expect(shouldCapDelay(100_000, 300_000)).toBe(false);
  });

  it("returns false when cap is null", () => {
    expect(shouldCapDelay(600_000, null)).toBe(false);
  });
});

describe("constants", () => {
  it("DEFAULT_MAX_RETRY_WAIT_MS equals 300_000", () => {
    expect(DEFAULT_MAX_RETRY_WAIT_MS).toBe(300_000);
  });

  it("RETRY_MIN_REMAINING_MS equals 30_000", () => {
    expect(RETRY_MIN_REMAINING_MS).toBe(30_000);
  });

  it("MAX_AUTOMATIC_BOUNCES equals 3", () => {
    expect(MAX_AUTOMATIC_BOUNCES).toBe(3);
  });
});
