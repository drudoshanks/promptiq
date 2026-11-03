import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, RateLimitError } from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { ZodType } from "zod";

import { logger } from "@/lib/logger";
import {
  buildAnalysisInstructions,
  buildAnalysisPayload,
  buildComparisonInstructions,
  buildComparisonPayload,
  buildRevisionInstructions,
  buildRevisionPayload,
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
import { buildStableInstructions, buildUserPayload } from "@/lib/optimiser/instructions";
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
  type ProviderUsage,
  type RevisionRequest,
  type StructuredResult,
} from "./types";

export type OpenModelOutputMode = "json_schema" | "json_object";

export interface OpenModelProviderOptions {
  /** OpenAI-compatible base URL, e.g. http://localhost:11434/v1 (Ollama). */
  baseUrl: string;
  /** Local servers ignore it; hosted ones (Groq, OpenRouter, Together) need it. */
  apiKey?: string;
  modelId: string;
  timeoutMs: number;
  outputMode?: OpenModelOutputMode;
  breaker?: CircuitBreaker;
  /** Injected for tests. */
  client?: Pick<OpenAI, "chat">;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_TRANSPORT_RETRIES = 1;
const MAX_REPAIR_ATTEMPTS = 1;
const MAX_RETRY_AFTER_SECONDS = 5;

/** Normalise Chat Completions usage (`prompt_tokens`, `completion_tokens`, ...). */
export function parseChatUsage(raw: unknown): ProviderUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
  const input = int(u["prompt_tokens"]);
  const output = int(u["completion_tokens"]);
  if (input === null || output === null) return null;
  const details = u["prompt_tokens_details"];
  const cached = details && typeof details === "object" ? int((details as Record<string, unknown>)["cached_tokens"]) : null;
  return { inputTokens: input, outputTokens: output, totalTokens: int(u["total_tokens"]) ?? input + output, cachedInputTokens: cached === null ? null : Math.min(cached, input) };
}

/**
 * Pull the JSON object out of a model reply. Open models sometimes wrap it in
 * a ```json fence, prefix a sentence, or emit <think>...</think> reasoning
 * first (Qwen3, DeepSeek-R1). Returns null when no JSON object parses.
 */
export function extractJsonObject(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const candidates = [cleaned];
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(cleaned.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const parsed: unknown = JSON.parse(c);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

interface Format {
  name: string;
  schema: Record<string, unknown>;
}

function formatFor(schema: ZodType, name: string): Format {
  const rf = zodResponseFormat(schema as never, name) as unknown as { json_schema: { schema: Record<string, unknown> } };
  return { name, schema: rf.json_schema.schema };
}

/**
 * Open-source models (Llama, Qwen, Gemma, Mistral, gpt-oss, DeepSeek ...)
 * through any OpenAI-compatible Chat Completions endpoint: Ollama, LM Studio,
 * vLLM, llama.cpp, Groq, OpenRouter, Together. Same instructions, schemas,
 * validation, retry and usage accounting as the OpenAI adapter; prompt content
 * is never logged.
 */
export class OpenModelProvider implements AiProvider {
  readonly name = "open" as const;
  readonly modelId: string;
  private readonly client: Pick<OpenAI, "chat">;
  private readonly breaker: CircuitBreaker;
  private readonly sleep: (ms: number) => Promise<void>;
  private outputMode: OpenModelOutputMode;
  private readonly instructions = buildStableInstructions();
  private readonly analysisInstructions = buildAnalysisInstructions();
  private readonly revisionInstructions = buildRevisionInstructions();
  private readonly comparisonInstructions = buildComparisonInstructions();
  private readonly formats = {
    optimise: formatFor(optimisationOutputSchema, "prompt_optimisation"),
    analyse: formatFor(modelAnalysisSchema, "prompt_analysis"),
    revise: formatFor(modelRevisionSchema, "prompt_revision"),
    compare: formatFor(modelComparisonSchema, "requirement_comparison"),
  };

  constructor(options: OpenModelProviderOptions) {
    this.modelId = options.modelId;
    this.outputMode = options.outputMode ?? "json_schema";
    this.client =
      options.client ??
      new OpenAI({ baseURL: options.baseUrl, apiKey: options.apiKey || "not-needed", timeout: options.timeoutMs, maxRetries: 0 });
    this.breaker = options.breaker ?? new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000 });
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  optimise(request: OptimiseRequest): Promise<OptimiseResult> {
    return this.call({
      requestId: request.requestId,
      instructions: this.instructions,
      input: buildUserPayload({
        prompt: request.prompt,
        taskCategory: request.taskCategory,
        preferences: request.preferences,
        mode: request.mode,
        customObjective: request.customObjective,
        acceptedSuggestions: request.acceptedSuggestions,
      }),
      format: this.formats.optimise,
      maxOutputTokens: request.maxOutputTokens,
      validate: validateOptimisationOutput,
    });
  }

  analyseIntent(request: IntentAnalysisRequest): Promise<StructuredResult<ModelAnalysis>> {
    return this.call({ requestId: request.requestId, instructions: this.analysisInstructions, input: buildAnalysisPayload(request), format: this.formats.analyse, maxOutputTokens: 2500, validate: validateModelAnalysis });
  }

  revisePrompt(request: RevisionRequest): Promise<StructuredResult<ModelRevision>> {
    return this.call({ requestId: request.requestId, instructions: this.revisionInstructions, input: buildRevisionPayload(request), format: this.formats.revise, maxOutputTokens: 4000, validate: validateModelRevision });
  }

  compareRequirements(request: ComparisonRequest): Promise<StructuredResult<ModelComparison>> {
    return this.call({
      requestId: request.requestId,
      instructions: this.comparisonInstructions,
      input: buildComparisonPayload(request.items, request.revised),
      format: this.formats.compare,
      maxOutputTokens: 1500,
      validate: validateModelComparison,
    });
  }

  private systemPrompt(instructions: string, format: Format): string {
    // Constrained decoding already enforces the shape; in json_object mode the
    // model only sees the schema here, so spell it out.
    const shape = this.outputMode === "json_object" ? `\n\nRespond with one JSON object only, no other text, matching this JSON Schema:\n${JSON.stringify(format.schema)}` : "\n\nRespond with one JSON object only.";
    return instructions + shape;
  }

  private async call<T>(call: {
    requestId: string;
    instructions: string;
    input: string;
    format: Format;
    maxOutputTokens: number;
    validate: (payload: unknown) => { ok: true; value: T } | { ok: false; reason: string };
  }): Promise<StructuredResult<T>> {
    const log = logger.withRequest(call.requestId);
    const attempts: ProviderAttempt[] = [];
    let transportRetries = 0;
    let repairs = 0;
    let downgraded = false;

    for (;;) {
      if (!this.breaker.tryAcquire()) {
        throw new ProviderError("PROVIDER_UNAVAILABLE", "circuit_open", { retryAfterSeconds: this.breaker.retryAfterSeconds(), attempts });
      }
      const attemptNumber = attempts.length + 1;
      let completion: { choices: unknown[]; usage?: unknown; model?: string };
      let providerRequestId: string | undefined;
      try {
        const raw = await this.client.chat.completions
          .create({
            model: this.modelId,
            messages: [
              { role: "system", content: this.systemPrompt(call.instructions, call.format) },
              { role: "user", content: call.input },
            ],
            max_tokens: call.maxOutputTokens,
            temperature: 0.2,
            stream: false,
            response_format:
              this.outputMode === "json_schema"
                ? { type: "json_schema", json_schema: { name: call.format.name, schema: call.format.schema, strict: true } }
                : { type: "json_object" },
          })
          .withResponse();
        completion = raw.data as typeof completion;
        providerRequestId = raw.request_id ?? undefined;
        this.breaker.recordSuccess();
      } catch (error) {
        // Some hosts reject json_schema; fall back to json_object once, for good.
        if (!downgraded && this.outputMode === "json_schema" && error instanceof APIError && error.status === 400 && /response_format|json_schema|schema/i.test(error.message)) {
          log.warn("open model rejected json_schema; using json_object", { model_id: this.modelId });
          this.outputMode = "json_object";
          downgraded = true;
          continue;
        }
        const mapped = this.mapError(error, log);
        attempts.push({ attempt: attemptNumber, status: "error", usage: null, modelId: this.modelId, errorCode: `${mapped.code}:${mapped.reason}` });
        const retryable = mapped.reason !== "configuration_error" && mapped.reason !== "model_not_found" && (mapped.retryAfterSeconds ?? 0) <= MAX_RETRY_AFTER_SECONDS;
        if (retryable && transportRetries < MAX_TRANSPORT_RETRIES) {
          transportRetries += 1;
          await this.sleep(mapped.retryAfterSeconds ? mapped.retryAfterSeconds * 1000 : 250 + Math.floor(Math.random() * 500));
          continue;
        }
        throw new ProviderError(mapped.code, mapped.reason, { ...(mapped.retryAfterSeconds !== undefined ? { retryAfterSeconds: mapped.retryAfterSeconds } : {}), cause: error, attempts });
      }

      const choice = (completion.choices[0] ?? null) as { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string } | null;
      const base = { attempt: attemptNumber, usage: parseChatUsage(completion.usage), modelId: completion.model || this.modelId, ...(providerRequestId ? { providerRequestId } : {}) };
      const finish = (rest: Omit<ProviderAttempt, "attempt" | "usage" | "modelId" | "providerRequestId">) => {
        attempts.push({ ...base, ...rest });
        return { modelId: this.modelId, attempts, ...(providerRequestId ? { providerRequestId } : {}) };
      };

      if (choice?.message?.refusal) return { ...finish({ status: "refused" }), kind: "refused", reason: choice.message.refusal };
      if (choice?.finish_reason === "length") return { ...finish({ status: "incomplete", errorCode: "max_output_tokens" }), kind: "incomplete", reason: "max_output_tokens" };

      const parsed = extractJsonObject(choice?.message?.content ?? "");
      let invalidReason = "response was not valid JSON";
      if (parsed !== null) {
        const validation = call.validate(parsed);
        if (validation.ok) return { ...finish({ status: "ok" }), kind: "ok", output: validation.value };
        invalidReason = validation.reason;
      }
      log.warn("structured output invalid", { attempt: attemptNumber, model_id: this.modelId, template: call.format.name });
      if (repairs < MAX_REPAIR_ATTEMPTS) {
        attempts.push({ ...base, status: "invalid_output", errorCode: "INVALID_MODEL_OUTPUT" });
        repairs += 1;
        continue;
      }
      return { ...finish({ status: "invalid_output", errorCode: "INVALID_MODEL_OUTPUT" }), kind: "invalid_output", reason: invalidReason };
    }
  }

  private mapError(error: unknown, log: ReturnType<typeof logger.withRequest>): ProviderError {
    if (error instanceof APIConnectionTimeoutError) {
      this.breaker.recordFailure();
      log.warn("provider timeout", { model_id: this.modelId, provider: "open" });
      return new ProviderError("PROVIDER_TIMEOUT", "timeout", { cause: error });
    }
    if (error instanceof RateLimitError) {
      this.breaker.recordFailure();
      const retryAfter = Number(error.headers?.get("retry-after") ?? "0") || undefined;
      log.warn("provider rate limited", { model_id: this.modelId, provider: "open", retry_after: retryAfter });
      return new ProviderError("PROVIDER_UNAVAILABLE", "upstream_rate_limited", { ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}), cause: error });
    }
    if (error instanceof APIConnectionError) {
      this.breaker.recordFailure();
      log.warn("provider connection error: is the model server running?", { model_id: this.modelId, provider: "open" });
      return new ProviderError("PROVIDER_UNAVAILABLE", "connection_error", { cause: error });
    }
    if (error instanceof APIError) {
      const status = error.status ?? 0;
      if (status >= 500) this.breaker.recordFailure();
      if (status === 404) {
        log.error("open model not found: pull it first (e.g. `ollama pull <model>`) or fix OPEN_MODEL", { model_id: this.modelId });
        return new ProviderError("PROVIDER_UNAVAILABLE", "model_not_found", { cause: error });
      }
      log.error("provider API error", { model_id: this.modelId, provider: "open", status });
      return new ProviderError("PROVIDER_UNAVAILABLE", status >= 500 ? "upstream_error" : "configuration_error", { cause: error });
    }
    this.breaker.recordFailure();
    log.error("provider unknown error", { model_id: this.modelId, provider: "open", message: (error as Error)?.message });
    return new ProviderError("PROVIDER_UNAVAILABLE", "unknown_error", { cause: error });
  }
}
