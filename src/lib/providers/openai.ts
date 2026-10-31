import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, RateLimitError } from "openai";
import { zodTextFormat } from "openai/helpers/zod";

import { findSupportedModel } from "@/lib/config/models";
import { logger } from "@/lib/logger";
import {
  buildAnalysisInstructions,
  buildAnalysisPayload,
  buildComparisonInstructions,
  buildComparisonPayload,
  buildRevisionInstructions,
  buildRevisionPayload,
  INTELLIGENCE_TEMPLATE_VERSION,
} from "@/lib/intelligence/instructions";
import {
  modelAnalysisSchema,
  modelComparisonSchema,
  modelRevisionSchema,
  validateModelAnalysis,
  validateModelComparison,
  validateModelRevision,
  type ModelAnalysis,
  type ModelComparison,
  type ModelRevision,
} from "@/lib/intelligence/schemas";
import { buildStableInstructions, buildUserPayload, TEMPLATE_VERSION } from "@/lib/optimiser/instructions";
import { optimisationOutputSchema, validateOptimisationOutput } from "@/lib/optimiser/schema";

import { CircuitBreaker } from "./circuit-breaker";
import {
  ProviderError,
  type AiProvider,
  type ComparisonRequest,
  type IntentAnalysisRequest,
  type OptimiseRequest,
  type OptimiseResult,
  type ProviderAttempt,
  type RevisionRequest,
  type StructuredResult,
} from "./types";
import { parseResponsesUsage } from "./usage";

export interface OpenAIProviderOptions {
  apiKey: string;
  modelId: string;
  timeoutMs: number;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
  breaker?: CircuitBreaker;
  /** Injected for tests; defaults to the official SDK client. */
  client?: Pick<OpenAI, "responses">;
  /** Injected for tests; defaults to a jittered 250–750 ms wait. */
  sleep?: (ms: number) => Promise<void>;
}

type ReasoningEffort = NonNullable<OpenAIProviderOptions["reasoningEffort"]>;

/** At most one transport retry and one repair attempt per logical operation. */
const MAX_TRANSPORT_RETRIES = 1;
const MAX_REPAIR_ATTEMPTS = 1;
/** Honour an upstream Retry-After only when it is short; otherwise fail fast. */
const MAX_RETRY_AFTER_SECONDS = 5;

/**
 * Official OpenAI adapter using the Responses API with Structured Outputs
 * (SRS §10.5). The API key is server-held (A-02) and the model ID comes from
 * server configuration (FR-022). Prompt content is never logged.
 *
 * Retries are done here rather than inside the SDK (`maxRetries: 0`) so every
 * request the provider saw is reported as its own attempt with its own usage.
 */
export class OpenAIOptimiserProvider implements AiProvider {
  readonly name = "openai" as const;
  readonly modelId: string;
  private readonly client: Pick<OpenAI, "responses">;
  private readonly instructions = buildStableInstructions();
  private readonly format = zodTextFormat(optimisationOutputSchema, "prompt_optimisation");
  private readonly analysisInstructions = buildAnalysisInstructions();
  private readonly analysisFormat = zodTextFormat(modelAnalysisSchema, "prompt_analysis");
  private readonly revisionInstructions = buildRevisionInstructions();
  private readonly revisionFormat = zodTextFormat(modelRevisionSchema, "prompt_revision");
  private readonly comparisonInstructions = buildComparisonInstructions();
  private readonly comparisonFormat = zodTextFormat(modelComparisonSchema, "requirement_comparison");
  private readonly breaker: CircuitBreaker;
  private readonly reasoningEffort: ReasoningEffort | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: OpenAIProviderOptions) {
    this.modelId = options.modelId;
    this.client = options.client ?? new OpenAI({ apiKey: options.apiKey, timeout: options.timeoutMs, maxRetries: 0 });
    this.breaker = options.breaker ?? new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000 });
    this.reasoningEffort = findSupportedModel(options.modelId)?.reasoning ? options.reasoningEffort : undefined;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  optimise(request: OptimiseRequest): Promise<OptimiseResult> {
    return this.callStructured({
      requestId: request.requestId,
      userKey: request.userKey,
      instructions: this.instructions,
      input: buildUserPayload({
        prompt: request.prompt,
        taskCategory: request.taskCategory,
        preferences: request.preferences,
        mode: request.mode,
        customObjective: request.customObjective,
        acceptedSuggestions: request.acceptedSuggestions,
      }),
      format: this.format,
      cacheKey: TEMPLATE_VERSION,
      maxOutputTokens: request.maxOutputTokens,
      validate: validateOptimisationOutput,
    });
  }

  analyseIntent(request: IntentAnalysisRequest): Promise<StructuredResult<ModelAnalysis>> {
    return this.callStructured({
      requestId: request.requestId,
      userKey: request.userKey,
      instructions: this.analysisInstructions,
      input: buildAnalysisPayload(request),
      format: this.analysisFormat,
      cacheKey: `${INTELLIGENCE_TEMPLATE_VERSION}:analyse`,
      maxOutputTokens: 2500,
      validate: validateModelAnalysis,
    });
  }

  revisePrompt(request: RevisionRequest): Promise<StructuredResult<ModelRevision>> {
    return this.callStructured({
      requestId: request.requestId,
      userKey: request.userKey,
      instructions: this.revisionInstructions,
      input: buildRevisionPayload(request),
      format: this.revisionFormat,
      cacheKey: `${INTELLIGENCE_TEMPLATE_VERSION}:revise`,
      maxOutputTokens: 4000,
      validate: validateModelRevision,
    });
  }

  compareRequirements(request: ComparisonRequest): Promise<StructuredResult<ModelComparison>> {
    return this.callStructured({
      requestId: request.requestId,
      userKey: request.userKey,
      instructions: this.comparisonInstructions,
      input: buildComparisonPayload(request.items, request.revised),
      format: this.comparisonFormat,
      cacheKey: `${INTELLIGENCE_TEMPLATE_VERSION}:compare`,
      maxOutputTokens: 1500,
      validate: validateModelComparison,
    });
  }

  /**
   * One logical structured-output operation: bounded transport retry, one
   * repair attempt on malformed output, every attempt reported with its usage.
   */
  private async callStructured<T>(call: {
    requestId: string;
    userKey: string;
    instructions: string;
    input: string;
    format: ReturnType<typeof zodTextFormat>;
    cacheKey: string;
    maxOutputTokens: number;
    validate: (payload: unknown) => { ok: true; value: T } | { ok: false; reason: string };
  }): Promise<
    | { kind: "ok"; output: T; modelId: string; attempts: ProviderAttempt[]; providerRequestId?: string }
    | { kind: "refused" | "incomplete" | "invalid_output"; reason: string; modelId: string; attempts: ProviderAttempt[]; providerRequestId?: string }
  > {
    const log = logger.withRequest(call.requestId);
    const attempts: ProviderAttempt[] = [];
    let transportRetries = 0;
    let repairs = 0;
    let lastInvalidReason = "";

    for (;;) {
      if (!this.breaker.tryAcquire()) {
        throw new ProviderError("PROVIDER_UNAVAILABLE", "circuit_open", { retryAfterSeconds: this.breaker.retryAfterSeconds(), attempts });
      }
      const attemptNumber = attempts.length + 1;

      let response: Awaited<ReturnType<OpenAI["responses"]["create"]>>;
      let providerRequestId: string | undefined;
      try {
        const raw = await this.client.responses
          .create({
            model: this.modelId,
            instructions: call.instructions,
            input: call.input,
            text: { format: call.format },
            max_output_tokens: call.maxOutputTokens,
            store: false,
            stream: false,
            prompt_cache_key: call.cacheKey,
            safety_identifier: call.userKey,
            ...(this.reasoningEffort ? { reasoning: { effort: this.reasoningEffort } } : {}),
          })
          .withResponse();
        response = raw.data;
        providerRequestId = raw.request_id ?? undefined;
        this.breaker.recordSuccess();
      } catch (error) {
        const mapped = this.mapError(error, log);
        attempts.push({ attempt: attemptNumber, status: "error", usage: null, modelId: this.modelId, errorCode: `${mapped.code}:${mapped.reason}` });
        const retryable = mapped.reason !== "configuration_error" && (mapped.retryAfterSeconds ?? 0) <= MAX_RETRY_AFTER_SECONDS;
        if (retryable && transportRetries < MAX_TRANSPORT_RETRIES) {
          transportRetries += 1;
          const wait = mapped.retryAfterSeconds ? mapped.retryAfterSeconds * 1000 : 250 + Math.floor(Math.random() * 500);
          log.info("retrying provider call", { attempt: attemptNumber, reason: mapped.reason, wait_ms: wait });
          await this.sleep(wait);
          continue;
        }
        throw new ProviderError(mapped.code, mapped.reason, {
          ...(mapped.retryAfterSeconds !== undefined ? { retryAfterSeconds: mapped.retryAfterSeconds } : {}),
          cause: error,
          attempts,
        });
      }

      const usage = parseResponsesUsage(response.usage);
      const base = { attempt: attemptNumber, usage, modelId: response.model || this.modelId, ...(providerRequestId ? { providerRequestId } : {}) };
      const finish = (rest: Omit<ProviderAttempt, "attempt" | "usage" | "modelId" | "providerRequestId">) => {
        attempts.push({ ...base, ...rest });
        return { modelId: this.modelId, attempts, ...(providerRequestId ? { providerRequestId } : {}) };
      };

      for (const item of response.output) {
        if (item.type !== "message") continue;
        for (const part of item.content) {
          if (part.type === "refusal") return { ...finish({ status: "refused" }), kind: "refused", reason: part.refusal };
        }
      }

      if (response.status === "incomplete") {
        const reason = response.incomplete_details?.reason ?? "incomplete";
        return { ...finish({ status: "incomplete", errorCode: reason }), kind: "incomplete", reason };
      }

      let parsed: unknown;
      let invalidReason: string | null = null;
      try {
        parsed = JSON.parse(response.output_text);
      } catch {
        invalidReason = "response was not valid JSON";
      }
      if (invalidReason === null) {
        const validation = call.validate(parsed);
        if (validation.ok) return { ...finish({ status: "ok" }), kind: "ok", output: validation.value };
        invalidReason = validation.reason;
      }

      // Malformed output: record the attempt (it was billed) and try one repair.
      lastInvalidReason = invalidReason;
      log.warn("structured output invalid", { attempt: attemptNumber, model_id: this.modelId, template: call.cacheKey });
      if (repairs < MAX_REPAIR_ATTEMPTS) {
        attempts.push({ ...base, status: "invalid_output", errorCode: "INVALID_MODEL_OUTPUT" });
        repairs += 1;
        continue;
      }
      return { ...finish({ status: "invalid_output", errorCode: "INVALID_MODEL_OUTPUT" }), kind: "invalid_output", reason: lastInvalidReason };
    }
  }

  private mapError(error: unknown, log: ReturnType<typeof logger.withRequest>): ProviderError {
    if (error instanceof APIConnectionTimeoutError) {
      this.breaker.recordFailure();
      log.warn("provider timeout", { model_id: this.modelId });
      return new ProviderError("PROVIDER_TIMEOUT", "timeout", { cause: error });
    }
    if (error instanceof RateLimitError) {
      this.breaker.recordFailure();
      const retryAfter = Number(error.headers?.get("retry-after") ?? "0") || undefined;
      log.warn("provider rate limited", { model_id: this.modelId, retry_after: retryAfter });
      return new ProviderError("PROVIDER_UNAVAILABLE", "upstream_rate_limited", {
        ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
        cause: error,
      });
    }
    if (error instanceof APIConnectionError) {
      this.breaker.recordFailure();
      log.warn("provider connection error", { model_id: this.modelId });
      return new ProviderError("PROVIDER_UNAVAILABLE", "connection_error", { cause: error });
    }
    if (error instanceof APIError) {
      const status = error.status ?? 0;
      if (status >= 500) this.breaker.recordFailure();
      // 4xx other than 429 almost always means a configuration problem (unknown
      // model, unsupported parameter). Log the code, never the prompt.
      log.error("provider API error", { model_id: this.modelId, status, code: error.code ?? null });
      return new ProviderError("PROVIDER_UNAVAILABLE", status >= 500 ? "upstream_error" : "configuration_error", { cause: error });
    }
    this.breaker.recordFailure();
    log.error("provider unknown error", { model_id: this.modelId, message: (error as Error)?.message });
    return new ProviderError("PROVIDER_UNAVAILABLE", "unknown_error", { cause: error });
  }
}
