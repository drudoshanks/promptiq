import Anthropic, { APIConnectionError, APIConnectionTimeoutError, APIError, AuthenticationError, RateLimitError } from "@anthropic-ai/sdk";
import { zodResponseFormat } from "openai/helpers/zod";
import type { ZodType } from "zod";

import {
  buildAnalysisInstructions,
  buildAnalysisPayload,
  buildBreakdownInstructions,
  buildBreakdownPayload,
  buildComparisonInstructions,
  buildComparisonPayload,
  buildRevisionInstructions,
  buildRevisionPayload,
} from "@/lib/intelligence/instructions";
import {
  modelAnalysisSchema,
  modelBreakdownSchema,
  modelComparisonSchema,
  modelRevisionSchema,
  validateModelAnalysis,
  validateModelBreakdown,
  validateModelComparison,
  validateModelRevision,
  type ModelAnalysis,
  type ModelBreakdown,
  type ModelComparison,
  type ModelRevision,
} from "@/lib/intelligence/schemas";
import { logger } from "@/lib/logger";
import { buildStableInstructions, buildUserPayload } from "@/lib/optimiser/instructions";
import { optimisationOutputSchema, validateOptimisationOutput } from "@/lib/optimiser/schema";

import { CircuitBreaker } from "./circuit-breaker";
import { extractJsonObject } from "./open-model";
import {
  ProviderError,
  type AiProvider,
  type BreakdownRequest,
  type ComparisonRequest,
  type IntentAnalysisRequest,
  type OptimiseRequest,
  type OptimiseResult,
  type ProviderAttempt,
  type ProviderUsage,
  type RevisionRequest,
  type StructuredResult,
} from "./types";

export type ClaudeEffort = "low" | "medium" | "high";

export interface AnthropicProviderOptions {
  apiKey: string;
  /** Override the API endpoint (tests, or a gateway in front of the Claude API). */
  baseUrl?: string;
  /** e.g. claude-sonnet-5-5, claude-haiku-5-5, claude-opus-5-5 */
  modelId: string;
  timeoutMs: number;
  /** How much work Claude puts in, thinking included. "low" is plenty for prompt editing. */
  effort?: ClaudeEffort;
  breaker?: CircuitBreaker;
  /** Injected for tests. */
  client?: Pick<Anthropic, "messages">;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_TRANSPORT_RETRIES = 1;
const MAX_REPAIR_ATTEMPTS = 1;
const MAX_RETRY_AFTER_SECONDS = 5;
/** Thinking counts toward max_tokens, so each call gets headroom on top of its answer budget. */
const THINKING_HEADROOM = 8000;

/**
 * Claude usage → PromptIQ usage. Claude reports cache reads and writes
 * separately from `input_tokens`; PromptIQ's input total includes them, with
 * cache reads also reported as cached input.
 */
export function parseClaudeUsage(raw: unknown): ProviderUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
  const uncached = int(u["input_tokens"]);
  const output = int(u["output_tokens"]);
  if (uncached === null || output === null) return null;
  const read = int(u["cache_read_input_tokens"]) ?? 0;
  const written = int(u["cache_creation_input_tokens"]) ?? 0;
  const input = uncached + read + written;
  return { inputTokens: input, outputTokens: output, totalTokens: input + output, cachedInputTokens: read || null };
}

const ALLOWED_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);
const UNSUPPORTED_KEYS = new Set(["$schema", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems", "uniqueItems", "pattern", "minProperties", "maxProperties"]);

/**
 * Make a JSON Schema acceptable to Claude structured outputs: objects closed
 * with additionalProperties: false, and constraints Claude doesn't support
 * (numeric ranges, string lengths, array sizes above 1, patterns) removed.
 * PromptIQ validates every reply on the server anyway.
 */
export function toClaudeSchema(schema: unknown): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (UNSUPPORTED_KEYS.has(k)) continue;
      if (k === "minItems" && typeof v === "number" && v > 1) {
        out[k] = 1;
        continue;
      }
      if (k === "format" && typeof v === "string" && !ALLOWED_FORMATS.has(v)) continue;
      out[k] = k === "properties" && v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([p, s]) => [p, walk(s)])) : walk(v);
    }
    if (out["type"] === "object" || (Array.isArray(out["type"]) && (out["type"] as unknown[]).includes("object")) || "properties" in out) out["additionalProperties"] = false;
    return out;
  };
  return walk(schema) as Record<string, unknown>;
}

interface Format {
  name: string;
  schema: Record<string, unknown>;
}

function formatFor(schema: ZodType, name: string): Format {
  const rf = zodResponseFormat(schema as never, name) as unknown as { json_schema: { schema: Record<string, unknown> } };
  return { name, schema: toClaudeSchema(rf.json_schema.schema) };
}

/**
 * Claude (Anthropic Messages API). Same instructions, schemas, validation,
 * repair, retry, circuit breaker and usage accounting as the other adapters.
 * Output is constrained with structured outputs (`output_config.format`); the
 * fixed instructions are marked for prompt caching. Prompt text is never logged.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic" as const;
  readonly modelId: string;
  private readonly client: Pick<Anthropic, "messages">;
  private readonly breaker: CircuitBreaker;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly effort: ClaudeEffort;
  /** Set if the API rejects a schema; replies are then parsed from plain JSON text. */
  private constrained = true;
  private readonly instructions = buildStableInstructions();
  private readonly analysisInstructions = buildAnalysisInstructions();
  private readonly revisionInstructions = buildRevisionInstructions();
  private readonly comparisonInstructions = buildComparisonInstructions();
  private readonly breakdownInstructions = buildBreakdownInstructions();
  private readonly formats = {
    optimise: formatFor(optimisationOutputSchema, "prompt_optimisation"),
    analyse: formatFor(modelAnalysisSchema, "prompt_analysis"),
    revise: formatFor(modelRevisionSchema, "prompt_revision"),
    compare: formatFor(modelComparisonSchema, "requirement_comparison"),
    breakdown: formatFor(modelBreakdownSchema, "prompt_breakdown"),
  };

  constructor(options: AnthropicProviderOptions) {
    this.modelId = options.modelId;
    this.effort = options.effort ?? "low";
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey, timeout: options.timeoutMs, maxRetries: 0, ...(options.baseUrl ? { baseURL: options.baseUrl } : {}) });
    this.breaker = options.breaker ?? new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000 });
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Schemas as sent to Claude, for tests. */
  get schemas(): Record<string, Record<string, unknown>> {
    return Object.fromEntries(Object.entries(this.formats).map(([k, f]) => [k, f.schema]));
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

  breakdownPrompt(request: BreakdownRequest): Promise<StructuredResult<ModelBreakdown>> {
    return this.call({ requestId: request.requestId, instructions: this.breakdownInstructions, input: buildBreakdownPayload(request), format: this.formats.breakdown, maxOutputTokens: 6000, validate: validateModelBreakdown });
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
      const system = this.constrained ? call.instructions : `${call.instructions}\n\nRespond with one JSON object only, no other text, matching this JSON Schema:\n${JSON.stringify(call.format.schema)}`;
      let message: Anthropic.Message;
      let providerRequestId: string | undefined;
      try {
        const raw = await this.client.messages
          .create({
            model: this.modelId,
            max_tokens: call.maxOutputTokens + THINKING_HEADROOM,
            // The instructions are identical for every request of a kind, so cache them.
            system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: call.input }],
            output_config: { effort: this.effort, ...(this.constrained ? { format: { type: "json_schema", schema: call.format.schema } } : {}) },
          })
          .withResponse();
        message = raw.data;
        providerRequestId = raw.request_id ?? undefined;
        this.breaker.recordSuccess();
      } catch (error) {
        // A schema Claude can't compile: fall back to plain JSON text for the rest of the process.
        if (!downgraded && this.constrained && error instanceof APIError && error.status === 400 && /schema|output_config|format/i.test(error.message)) {
          log.warn("claude rejected the output schema; using plain JSON", { model_id: this.modelId, template: call.format.name });
          this.constrained = false;
          downgraded = true;
          continue;
        }
        const mapped = this.mapError(error, log);
        attempts.push({ attempt: attemptNumber, status: "error", usage: null, modelId: this.modelId, errorCode: `${mapped.code}:${mapped.reason}` });
        const retryable = !["configuration_error", "auth_error", "model_not_found", "insufficient_credit"].includes(mapped.reason) && (mapped.retryAfterSeconds ?? 0) <= MAX_RETRY_AFTER_SECONDS;
        if (retryable && transportRetries < MAX_TRANSPORT_RETRIES) {
          transportRetries += 1;
          await this.sleep(mapped.retryAfterSeconds ? mapped.retryAfterSeconds * 1000 : 250 + Math.floor(Math.random() * 500));
          continue;
        }
        throw new ProviderError(mapped.code, mapped.reason, { ...(mapped.retryAfterSeconds !== undefined ? { retryAfterSeconds: mapped.retryAfterSeconds } : {}), cause: error, attempts });
      }

      const base = { attempt: attemptNumber, usage: parseClaudeUsage(message.usage), modelId: message.model || this.modelId, ...(providerRequestId ? { providerRequestId } : {}) };
      const finish = (rest: Omit<ProviderAttempt, "attempt" | "usage" | "modelId" | "providerRequestId">) => {
        attempts.push({ ...base, ...rest });
        return { modelId: this.modelId, attempts, ...(providerRequestId ? { providerRequestId } : {}) };
      };
      // Thinking blocks may precede the answer; the answer is in the text blocks.
      const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");

      if (message.stop_reason === "refusal") return { ...finish({ status: "refused" }), kind: "refused", reason: text.trim() || "Claude declined this request." };
      if (message.stop_reason === "max_tokens" || message.stop_reason === "model_context_window_exceeded") {
        return { ...finish({ status: "incomplete", errorCode: "max_output_tokens" }), kind: "incomplete", reason: "max_output_tokens" };
      }

      const parsed = extractJsonObject(text);
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
    const provider = "anthropic";
    if (error instanceof APIConnectionTimeoutError) {
      this.breaker.recordFailure();
      log.warn("provider timeout", { model_id: this.modelId, provider });
      return new ProviderError("PROVIDER_TIMEOUT", "timeout", { cause: error });
    }
    if (error instanceof RateLimitError) {
      this.breaker.recordFailure();
      const retryAfter = Number(error.headers?.get("retry-after") ?? "0") || undefined;
      log.warn("provider rate limited", { model_id: this.modelId, provider, retry_after: retryAfter });
      return new ProviderError("PROVIDER_UNAVAILABLE", "upstream_rate_limited", { ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}), cause: error });
    }
    if (error instanceof APIConnectionError) {
      this.breaker.recordFailure();
      log.warn("provider connection error", { model_id: this.modelId, provider });
      return new ProviderError("PROVIDER_UNAVAILABLE", "connection_error", { cause: error });
    }
    if (error instanceof AuthenticationError) {
      log.error("Claude rejected the API key: check ANTHROPIC_API_KEY", { model_id: this.modelId });
      return new ProviderError("PROVIDER_UNAVAILABLE", "auth_error", { cause: error });
    }
    if (error instanceof APIError) {
      const status = error.status ?? 0;
      if (status === 529 || status >= 500) {
        this.breaker.recordFailure();
        log.warn(status === 529 ? "Claude is overloaded" : "provider API error", { model_id: this.modelId, provider, status });
        return new ProviderError("PROVIDER_UNAVAILABLE", status === 529 ? "upstream_overloaded" : "upstream_error", { cause: error });
      }
      if (status === 404) {
        log.error("Claude model not found: check ANTHROPIC_MODEL", { model_id: this.modelId });
        return new ProviderError("PROVIDER_UNAVAILABLE", "model_not_found", { cause: error });
      }
      if (/credit balance/i.test(error.message)) {
        log.error("Anthropic account has no credit: add credit in the Claude Console (Billing)", { model_id: this.modelId });
        return new ProviderError("PROVIDER_UNAVAILABLE", "insufficient_credit", { cause: error });
      }
      log.error("provider API error", { model_id: this.modelId, provider, status });
      return new ProviderError("PROVIDER_UNAVAILABLE", "configuration_error", { cause: error });
    }
    this.breaker.recordFailure();
    log.error("provider unknown error", { model_id: this.modelId, provider, message: (error as Error)?.message });
    return new ProviderError("PROVIDER_UNAVAILABLE", "unknown_error", { cause: error });
  }
}
