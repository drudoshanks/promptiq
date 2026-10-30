import type { TaskCategory } from "@/lib/categories";
import type { OptimisationOutput } from "@/lib/optimiser/schema";

/**
 * Narrow provider adapter interface (NFR-010, §10.5). The MVP guarantees only the
 * official OpenAI API; the mock adapter exists for local development, tests and
 * the evaluation harness.
 */
export interface OptimiseRequest {
  prompt: string;
  taskCategory: TaskCategory | "auto";
  preferences: Record<string, string>;
  maxOutputTokens: number;
  /** Correlation ID for logs (never the prompt). */
  requestId: string;
  /** Opaque, hashed per-user identifier for provider abuse tooling. */
  userKey: string;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

export type OptimiseResult =
  | {
      kind: "ok";
      output: OptimisationOutput;
      usage: ProviderUsage;
      providerRequestId?: string;
      modelId: string;
    }
  | { kind: "refused"; reason: string; usage: ProviderUsage; providerRequestId?: string; modelId: string }
  | { kind: "incomplete"; reason: string; usage: ProviderUsage; providerRequestId?: string; modelId: string }
  | { kind: "invalid_output"; reason: string; usage: ProviderUsage; providerRequestId?: string; modelId: string };

export interface OptimiserProvider {
  readonly name: "openai" | "mock";
  readonly modelId: string;
  optimise(request: OptimiseRequest): Promise<OptimiseResult>;
}

export type ProviderErrorCode = "PROVIDER_TIMEOUT" | "PROVIDER_UNAVAILABLE";

/** Transport-level failure: timeout, outage, upstream rate limit, bad configuration. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly reason: string;
  readonly retryAfterSeconds?: number;

  constructor(code: ProviderErrorCode, reason: string, options: { retryAfterSeconds?: number; cause?: unknown } = {}) {
    super(`${code}: ${reason}`, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ProviderError";
    this.code = code;
    this.reason = reason;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
