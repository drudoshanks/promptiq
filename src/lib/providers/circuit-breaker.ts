/**
 * Minimal circuit breaker for upstream provider outages (SRS §8.3, §16.3).
 * Opens after `failureThreshold` consecutive transport failures, rejects calls
 * for `cooldownMs`, then lets a single trial call through (half-open).
 */
export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  now?: () => number;
}

export type CircuitState = "closed" | "open" | "half_open";

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private trialInFlight = false;
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  get state(): CircuitState {
    if (this.openedAt === null) return "closed";
    if (this.now() - this.openedAt >= this.options.cooldownMs) return "half_open";
    return "open";
  }

  /** Returns false when the call must be rejected without touching the provider. */
  tryAcquire(): boolean {
    const state = this.state;
    if (state === "closed") return true;
    if (state === "half_open" && !this.trialInFlight) {
      this.trialInFlight = true;
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
    this.trialInFlight = false;
  }

  recordFailure(): void {
    this.trialInFlight = false;
    this.failures += 1;
    if (this.failures >= this.options.failureThreshold) {
      this.openedAt = this.now();
    }
  }

  /** Seconds until the next trial is allowed (0 when closed). */
  retryAfterSeconds(): number {
    if (this.openedAt === null) return 0;
    return Math.max(1, Math.ceil((this.openedAt + this.options.cooldownMs - this.now()) / 1000));
  }

  reset(): void {
    this.failures = 0;
    this.openedAt = null;
    this.trialInFlight = false;
  }
}
