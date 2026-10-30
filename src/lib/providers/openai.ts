import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, RateLimitError } from "openai";
import { zodTextFormat } from "openai/helpers/zod";

import { priceForModel } from "@/lib/config/models";
import { logger } from "@/lib/logger";
import { buildStableInstructions, buildUserPayload, TEMPLATE_VERSION } from "@/lib/optimiser/instructions";
import { optimisationOutputSchema, validateOptimisationOutput } from "@/lib/optimiser/schema";

import { CircuitBreaker } from "./circuit-breaker";
import { ProviderError, type OptimiseRequest, type OptimiseResult, type OptimiserProvider, type ProviderUsage } from "./types";

export interface OpenAIProviderOptions {
  apiKey: string;
  modelId: string;
  timeoutMs: number;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
  breaker?: CircuitBreaker;
}

type ReasoningEffort = NonNullable<OpenAIProviderOptions["reasoningEffort"]>;

/**
 * Official OpenAI adapter using the Responses API with Structured Outputs
 * (SRS §10.5). The API key is server-held (A-02) and the model ID comes from
 * server configuration (FR-022). Prompt content is never logged.
 */
export class OpenAIOptimiserProvider implements OptimiserProvider {
  readonly name = "openai" as const;
  readonly modelId: string;
  private readonly client: OpenAI;
  private readonly instructions = buildStableInstructions();
  private readonly format = zodTextFormat(optimisationOutputSchema, "prompt_optimisation");
  private readonly breaker: CircuitBreaker;
  private readonly reasoningEffort: ReasoningEffort | undefined;

  constructor(options: OpenAIProviderOptions) {
    this.modelId = options.modelId;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      timeout: options.timeoutMs,
      maxRetries: 1, // bounded retries with the SDK's jittered backoff
    });
    this.breaker = options.breaker ?? new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000 });
    const { price } = priceForModel(options.modelId);
    this.reasoningEffort = price.reasoning ? options.reasoningEffort : undefined;
  }

  async optimise(request: OptimiseRequest): Promise<OptimiseResult> {
    if (!this.breaker.tryAcquire()) {
      throw new ProviderError("PROVIDER_UNAVAILABLE", "circuit_open", {
        retryAfterSeconds: this.breaker.retryAfterSeconds(),
      });
    }

    const log = logger.withRequest(request.requestId);
    let attempt = 0;
    let lastInvalidReason = "";
    let usage: ProviderUsage = {};
    let providerRequestId: string | undefined;

    // One bounded repair attempt on malformed output (SRS §10.6 INVALID_MODEL_OUTPUT).
    while (attempt < 2) {
      attempt += 1;
      let response: Awaited<ReturnType<typeof this.client.responses.create>>;
      try {
        const raw = await this.client.responses
          .create({
            model: this.modelId,
            instructions: this.instructions,
            input: buildUserPayload({
              prompt: request.prompt,
              taskCategory: request.taskCategory,
              preferences: request.preferences,
            }),
            text: { format: this.format },
            max_output_tokens: request.maxOutputTokens,
            store: false,
            prompt_cache_key: TEMPLATE_VERSION,
            safety_identifier: request.userKey,
            ...(this.reasoningEffort ? { reasoning: { effort: this.reasoningEffort } } : {}),
          })
          .withResponse();
        response = raw.data;
        providerRequestId = raw.request_id ?? undefined;
        this.breaker.recordSuccess();
      } catch (error) {
        throw this.mapError(error, log);
      }

      usage = {
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
        cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens,
      };

      // Refusal: the model declined to produce the structured output.
      for (const item of response.output) {
        if (item.type === "message") {
          for (const part of item.content) {
            if (part.type === "refusal") {
              return { kind: "refused", reason: part.refusal, usage, providerRequestId, modelId: this.modelId };
            }
          }
        }
      }

      if (response.status === "incomplete") {
        const reason = response.incomplete_details?.reason ?? "incomplete";
        return { kind: "incomplete", reason, usage, providerRequestId, modelId: this.modelId };
      }

      const text = response.output_text;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        lastInvalidReason = "response was not valid JSON";
        log.warn("optimiser output was not JSON", { attempt, model_id: this.modelId });
        continue;
      }
      const validation = validateOptimisationOutput(parsed);
      if (!validation.ok) {
        lastInvalidReason = validation.reason;
        log.warn("optimiser output failed schema validation", { attempt, model_id: this.modelId });
        continue;
      }
      return { kind: "ok", output: validation.value, usage, providerRequestId, modelId: this.modelId };
    }

    return { kind: "invalid_output", reason: lastInvalidReason, usage, providerRequestId, modelId: this.modelId };
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
      return new ProviderError("PROVIDER_UNAVAILABLE", "upstream_rate_limited", { retryAfterSeconds: retryAfter, cause: error });
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
