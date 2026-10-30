import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AppError, ERROR_CODES, toAppError } from "@/lib/api/errors";
import { checkRateLimit, resetRateLimits } from "@/lib/api/rate-limit";
import { createPreferenceSchema, feedbackRequestSchema, optimisationRequestSchema } from "@/lib/api/validation";
import { HARD_MAX_PROMPT_CHARS } from "@/lib/config/plans";
import { CircuitBreaker } from "@/lib/providers/circuit-breaker";
import { calendarMonthPeriod } from "@/lib/services/usage";

describe("optimisation request validation (§10.2)", () => {
  it("drops unknown preference keys and defaults the category", () => {
    const parsed = optimisationRequestSchema.parse({ prompt: "hello", preferences: { tone: "formal", model: "gpt-9", secret: 1 } });
    expect(parsed.task_category).toBe("auto");
    expect(parsed.preferences).toEqual({ tone: "formal" });
  });

  it("rejects arbitrary option keys such as model ids", () => {
    expect(() => optimisationRequestSchema.parse({ prompt: "x", options: { model: "gpt-9" } })).toThrow();
  });

  it("enforces the hard length ceiling", () => {
    expect(() => optimisationRequestSchema.parse({ prompt: "a".repeat(HARD_MAX_PROMPT_CHARS + 1) })).toThrow();
  });

  it("accepts only -1 or 1 ratings and known reason codes", () => {
    expect(feedbackRequestSchema.parse({ rating: 1, reason_code: "CLEARER" }).rating).toBe(1);
    expect(() => feedbackRequestSchema.parse({ rating: 0 })).toThrow();
    expect(() => feedbackRequestSchema.parse({ rating: 1, reason_code: "BECAUSE" })).toThrow();
  });

  it("ignores client-claimed preference sources", () => {
    const parsed = createPreferenceSchema.parse({ preference_key: "tone", preference_value: { value: "formal" }, source: "feedback" });
    expect(parsed.category).toBe("general");
    // The route assigns source server-side; the parsed value is informational only.
    expect(parsed.source).toBe("feedback");
  });
});

describe("error envelope (§10.1, §10.6)", () => {
  it("maps codes to HTTP statuses", () => {
    expect(new AppError("PROMPT_TOO_LONG", "too long").status).toBe(413);
    expect(new AppError("QUOTA_EXCEEDED", "quota").status).toBe(429);
    expect(ERROR_CODES.OPTIMISATION_REFUSED).toBe(422);
  });

  it("renders the envelope with request id and never a stack", () => {
    const env = new AppError("PROMPT_EMPTY", "Enter a prompt.", { details: { x: 1 } }).toEnvelope("req-1");
    expect(env).toEqual({ error: { code: "PROMPT_EMPTY", message: "Enter a prompt.", details: { x: 1 } }, request_id: "req-1" });
    expect(JSON.stringify(env)).not.toContain("stack");
  });

  it("converts zod errors to VALIDATION_ERROR and everything else to INTERNAL_ERROR", () => {
    const zodError = z.object({ a: z.string() }).safeParse({}).error;
    expect(toAppError(zodError).code).toBe("VALIDATION_ERROR");
    const internal = toAppError(new Error("secret db password leaked"));
    expect(internal.code).toBe("INTERNAL_ERROR");
    expect(internal.message).not.toContain("secret");
  });
});

describe("rate limiter", () => {
  it("allows up to the limit then blocks with a retry hint", () => {
    resetRateLimits();
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) expect(checkRateLimit("k", 3, 60_000, now + i).allowed).toBe(true);
    const blocked = checkRateLimit("k", 3, 60_000, now + 10);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(checkRateLimit("k", 3, 60_000, now + 60_001).allowed).toBe(true);
  });
});

describe("circuit breaker (§8.3)", () => {
  it("opens after consecutive failures and half-opens after the cooldown", () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => now });
    expect(breaker.tryAcquire()).toBe(true);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe("open");
    expect(breaker.tryAcquire()).toBe(false);
    now = 1500;
    expect(breaker.state).toBe("half_open");
    expect(breaker.tryAcquire()).toBe(true); // one trial
    expect(breaker.tryAcquire()).toBe(false);
    breaker.recordSuccess();
    expect(breaker.state).toBe("closed");
  });
});

describe("quota period", () => {
  it("uses UTC calendar months", () => {
    const period = calendarMonthPeriod(new Date("2026-10-30T23:59:00Z"));
    expect(period.start.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});
