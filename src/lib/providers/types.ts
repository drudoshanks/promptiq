import type { TaskCategory } from "@/lib/categories";
import type { UsageRecordStatus } from "@/lib/db/schema";
import type { GenerationMode, SuggestionKind } from "@/lib/intelligence/categories";
import type { ModelAnalysis, ModelComparison, ModelRevision, IntentRepresentation } from "@/lib/intelligence/schemas";
import type { PromptTemplate } from "@/lib/intelligence/templates";
import type { OptimiserMode } from "@/lib/optimiser/instructions";
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
  mode?: OptimiserMode;
  customObjective?: string | null;
  /** Recommendations the user explicitly accepted, applied by the optimiser. */
  acceptedSuggestions?: string[];
}

/** One prompt to analyse; never the user's whole library (§11). */
export interface IntentAnalysisRequest {
  prompt: string;
  targetModel: string | null;
  /** Only user-approved preference fields. */
  preferences: Record<string, unknown>;
  requestId: string;
  userKey: string;
}

export interface RevisionRequest {
  prompt: string;
  mode: GenerationMode;
  intent: IntentRepresentation;
  template: PromptTemplate;
  acceptedChanges: string[];
  acceptedKinds: SuggestionKind[];
  customObjective: string | null;
  tokenBudget: number | null;
  /** Requirements a previous draft dropped, to put back. */
  restore: string[];
  preferences: Record<string, unknown>;
  questions: Array<{ key: string; question: string }>;
  requestId: string;
  userKey: string;
}

export interface ComparisonRequest {
  items: Array<{ id: string; text: string }>;
  revised: string;
  requestId: string;
  userKey: string;
}

/** Usage metadata exactly as the provider reported it for one API response. */
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number | null;
}

/**
 * One request PromptIQ sent to the provider. A logical optimisation can need
 * several (a transport retry, a repair after malformed output); each is
 * recorded separately so usage is neither double-counted nor lost.
 * `usage` is null when the provider returned none (timeouts, connection errors).
 */
export interface ProviderAttempt {
  attempt: number;
  status: UsageRecordStatus;
  usage: ProviderUsage | null;
  providerRequestId?: string;
  modelId: string;
  errorCode?: string;
}

interface ResultBase {
  modelId: string;
  /** Every attempt made for this logical operation, in order. */
  attempts: ProviderAttempt[];
  /** Provider request ID of the final attempt. */
  providerRequestId?: string;
}

export type OptimiseResult =
  | (ResultBase & { kind: "ok"; output: OptimisationOutput })
  | (ResultBase & { kind: "refused"; reason: string })
  | (ResultBase & { kind: "incomplete"; reason: string })
  | (ResultBase & { kind: "invalid_output"; reason: string });

export type StructuredResult<T> =
  | (ResultBase & { kind: "ok"; output: T })
  | (ResultBase & { kind: "refused"; reason: string })
  | (ResultBase & { kind: "incomplete"; reason: string })
  | (ResultBase & { kind: "invalid_output"; reason: string });

export interface OptimiserProvider {
  readonly name: "openai" | "mock";
  readonly modelId: string;
  optimise(request: OptimiseRequest): Promise<OptimiseResult>;
}

/** Model-assisted operations of the Prompt Intelligence Engine (§11). */
export interface IntelligenceProvider {
  readonly name: "openai" | "mock";
  readonly modelId: string;
  analyseIntent(request: IntentAnalysisRequest): Promise<StructuredResult<ModelAnalysis>>;
  revisePrompt(request: RevisionRequest): Promise<StructuredResult<ModelRevision>>;
  compareRequirements(request: ComparisonRequest): Promise<StructuredResult<ModelComparison>>;
}

export type AiProvider = OptimiserProvider & IntelligenceProvider;

export type ProviderErrorCode = "PROVIDER_TIMEOUT" | "PROVIDER_UNAVAILABLE";

/** Transport-level failure: timeout, outage, upstream rate limit, bad configuration. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly reason: string;
  readonly retryAfterSeconds?: number;
  /** Attempts made before giving up (some may have reported usage). */
  readonly attempts: ProviderAttempt[];

  constructor(
    code: ProviderErrorCode,
    reason: string,
    options: { retryAfterSeconds?: number; cause?: unknown; attempts?: ProviderAttempt[] } = {},
  ) {
    super(`${code}: ${reason}`, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ProviderError";
    this.code = code;
    this.reason = reason;
    this.attempts = options.attempts ?? [];
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
