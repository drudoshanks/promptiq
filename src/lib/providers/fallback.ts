import type { ModelAnalysis, ModelBreakdown, ModelComparison, ModelRevision } from "@/lib/intelligence/schemas";
import { logger } from "@/lib/logger";

import {
  ProviderError,
  type AiProvider,
  type BreakdownRequest,
  type ComparisonRequest,
  type IntentAnalysisRequest,
  type OptimiseRequest,
  type OptimiseResult,
  type ProviderName,
  type RevisionRequest,
  type StructuredResult,
} from "./types";

type AnyResult = { kind: string; attempts: OptimiseResult["attempts"]; modelId: string };

/**
 * Uses the primary (model) provider and, when it is unreachable or keeps
 * returning unusable output, answers with the rule-based engine instead so the
 * user still gets a result. Refusals are passed through, never overridden.
 * The fallback result keeps its own model ID ("mock-optimiser"), so usage
 * records and the admin page show which engine actually answered.
 */
export class FallbackProvider implements AiProvider {
  readonly name: ProviderName;
  readonly modelId: string;

  constructor(
    private readonly primary: AiProvider,
    private readonly fallback: AiProvider,
  ) {
    this.name = primary.name;
    this.modelId = primary.modelId;
  }

  private async run<R extends AnyResult>(op: string, requestId: string, first: () => Promise<R>, second: () => Promise<R>): Promise<R> {
    const log = logger.withRequest(requestId);
    try {
      const result = await first();
      if (result.kind === "ok" || result.kind === "refused") return result;
      log.warn("primary provider output unusable; using rule-based engine", { op, kind: result.kind, model_id: this.modelId });
      const fb = await second();
      return { ...fb, attempts: [...result.attempts, ...fb.attempts.map((a, i) => ({ ...a, attempt: result.attempts.length + i + 1 }))] };
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      log.warn("primary provider unavailable; using rule-based engine", { op, reason: error.reason, model_id: this.modelId });
      const fb = await second();
      return { ...fb, attempts: [...error.attempts, ...fb.attempts.map((a, i) => ({ ...a, attempt: error.attempts.length + i + 1 }))] };
    }
  }

  optimise(request: OptimiseRequest): Promise<OptimiseResult> {
    return this.run("optimise", request.requestId, () => this.primary.optimise(request), () => this.fallback.optimise(request));
  }

  analyseIntent(request: IntentAnalysisRequest): Promise<StructuredResult<ModelAnalysis>> {
    return this.run("analyse", request.requestId, () => this.primary.analyseIntent(request), () => this.fallback.analyseIntent(request));
  }

  revisePrompt(request: RevisionRequest): Promise<StructuredResult<ModelRevision>> {
    return this.run("revise", request.requestId, () => this.primary.revisePrompt(request), () => this.fallback.revisePrompt(request));
  }

  compareRequirements(request: ComparisonRequest): Promise<StructuredResult<ModelComparison>> {
    return this.run("compare", request.requestId, () => this.primary.compareRequirements(request), () => this.fallback.compareRequirements(request));
  }

  breakdownPrompt(request: BreakdownRequest): Promise<StructuredResult<ModelBreakdown>> {
    return this.run("breakdown", request.requestId, () => this.primary.breakdownPrompt(request), () => this.fallback.breakdownPrompt(request));
  }
}
