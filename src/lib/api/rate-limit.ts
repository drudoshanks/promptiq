/**
 * In-memory sliding-window rate limiter (SRS §12 Rate limits).
 *
 * Suitable for a single-instance MVP deployment. For horizontal scaling (NFR-007)
 * replace `store` with a shared store (Redis/Upstash) behind the same interface —
 * the quota ledger in the database already protects the provider budget across
 * instances; this layer only smooths bursts and scripted abuse.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  limit: number;
}

interface Bucket {
  timestamps: number[];
}

const store = new Map<string, Bucket>();
let lastSweep = Date.now();

function sweep(now: number, windowMs: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of store) {
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);
    if (bucket.timestamps.length === 0) store.delete(key);
  }
}

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): RateLimitResult {
  sweep(now, windowMs);
  const bucket = store.get(key) ?? { timestamps: [] };
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);

  if (bucket.timestamps.length >= limit) {
    const oldest = bucket.timestamps[0] ?? now;
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    store.set(key, bucket);
    return { allowed: false, remaining: 0, retryAfterSeconds, limit };
  }

  bucket.timestamps.push(now);
  store.set(key, bucket);
  return {
    allowed: true,
    remaining: limit - bucket.timestamps.length,
    retryAfterSeconds: 0,
    limit,
  };
}

/** Test helper. */
export function resetRateLimits() {
  store.clear();
}

export const RATE_LIMITS = {
  /** Mutating/billable calls per authenticated user. */
  userPerMinute: { limit: 20, windowMs: 60_000 },
  /** Optimisation calls per authenticated user (provider budget protection). */
  optimisePerMinute: { limit: 8, windowMs: 60_000 },
  /** Any API call per client IP (sized to allow debounced counting while typing). */
  ipPerMinute: { limit: 240, windowMs: 60_000 },
  /** AI prompt analyses per authenticated user. */
  analysePerMinute: { limit: 6, windowMs: 60_000 },
  /** Prompt Intelligence: analyses, revisions and validation checks. */
  intelligenceAnalysePerMinute: { limit: 10, windowMs: 60_000 },
  revisePerMinute: { limit: 8, windowMs: 60_000 },
  validatePerMinute: { limit: 30, windowMs: 60_000 },
  /** Token counting while typing (debounced client-side, ~300 ms). */
  estimatePerMinute: { limit: 120, windowMs: 60_000 },
  /** Account-wide expensive operations (exports). */
  exportPerHour: { limit: 5, windowMs: 3_600_000 },
} as const;
