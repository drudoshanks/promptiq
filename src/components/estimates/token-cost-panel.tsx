"use client";

import { useEffect, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, errorMessage } from "@/lib/client/api";
import {
  describeChange,
  fetchComparison,
  fetchEstimate,
  formatMoney,
  type ExpectedOutput,
  type ModelOption,
  type TokenComparisonResult,
  type TokenEstimateResult,
} from "@/lib/client/estimates";
import { COUNT_DEBOUNCE_MS, OUTPUT_LENGTH_PRESETS, type OutputLengthPreset } from "@/lib/config/estimates";
import type { summariseUsage } from "@/lib/services/estimates";
import { cx } from "@/lib/utils";

type ActualUsage = ReturnType<typeof summariseUsage>;

interface TokenCostPanelProps {
  /** Text being written, or the original prompt when `optimised` is given. */
  original: string;
  /** Final (possibly edited) optimised prompt; omit for a single-text estimate. */
  optimised?: string | null;
  models: ModelOption[];
  model: string;
  onModelChange: (model: string) => void;
  outputPreset: OutputLengthPreset;
  onOutputPresetChange: (preset: OutputLengthPreset) => void;
  /** PromptIQ's own optimisation call, as reported by the provider. */
  actualUsage?: ActualUsage | null;
  className?: string;
}

type Data = TokenEstimateResult | TokenComparisonResult;
type Outcome = { kind: "ready"; data: Data } | { kind: "unsupported"; message: string } | { kind: "error"; message: string };
type State = { kind: "idle" } | { kind: "loading"; previous: Data | null } | Outcome;

function requestKey(parts: unknown[]): string {
  return JSON.stringify(parts);
}

function isComparison(data: TokenEstimateResult | TokenComparisonResult): data is TokenComparisonResult {
  return "tokens_saved" in data;
}

const STATUS_LABEL = { current: "pricing verified", stale: "pricing may be out of date", missing: "no pricing" } as const;

/**
 * Token & cost estimation panel (§7). Counts with the server-side tokenizer for
 * the selected model, debounced while the user types; nothing is stored. Every
 * number is labelled as an estimate except PromptIQ's own provider usage.
 */
export function TokenCostPanel({
  original,
  optimised = null,
  models,
  model,
  onModelChange,
  outputPreset,
  onOutputPresetChange,
  actualUsage = null,
  className,
}: TokenCostPanelProps) {
  const [settled, setSettled] = useState<{ key: string; outcome: Outcome } | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const comparing = optimised !== null;
  const empty = !original.trim() && !(optimised ?? "").trim();
  const key = requestKey([original, optimised, model, outputPreset, retryToken]);

  useEffect(() => {
    if (empty) return;
    const thisKey = requestKey([original, optimised, model, outputPreset, retryToken]);
    const controller = new AbortController();
    const expectedOutput: ExpectedOutput = outputPreset;
    const timer = setTimeout(() => {
      const request = comparing
        ? fetchComparison({ model, original, optimised: optimised ?? "", expectedOutput, signal: controller.signal })
        : fetchEstimate({ model, text: original, expectedOutput, signal: controller.signal });
      request
        .then((data) => setSettled({ key: thisKey, outcome: { kind: "ready", data } }))
        .catch((error: unknown) => {
          if ((error as Error).name === "AbortError") return;
          let outcome: Outcome;
          if (error instanceof ApiError && error.code === "UNSUPPORTED_MODEL") outcome = { kind: "unsupported", message: error.message };
          else if (error instanceof ApiError && error.code === "RATE_LIMITED")
            outcome = { kind: "error", message: "Counting paused for a moment because of rapid changes. It resumes automatically." };
          else outcome = { kind: "error", message: errorMessage(error) };
          setSettled({ key: thisKey, outcome });
        });
    }, COUNT_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [empty, original, optimised, comparing, model, outputPreset, retryToken]);

  // Derived, never stored: idle when empty, the settled outcome when it matches
  // the current inputs, otherwise loading (keeping the last numbers visible).
  const state: State = empty
    ? { kind: "idle" }
    : settled && settled.key === key
      ? settled.outcome
      : { kind: "loading", previous: settled?.outcome.kind === "ready" ? settled.outcome.data : null };

  const data = state.kind === "ready" ? state.data : state.kind === "loading" ? state.previous : null;
  const pricingStatus = data ? (isComparison(data) ? data.cost?.pricing_status : data.cost?.pricing_status) ?? "missing" : null;

  return (
    <section aria-labelledby="token-cost-heading" className={cx("panel p-5", className)} aria-busy={state.kind === "loading"}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="token-cost-heading" className="text-base">
          Tokens and cost
        </h3>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {state.kind === "loading" ? <Spinner label="Counting tokens" /> : null}
          <Badge tone="estimate" title="Counted from the text with the model's tokenizer; not measured usage.">
            estimate
          </Badge>
          {pricingStatus ? <Badge tone={pricingStatus === "current" ? "neutral" : "estimate"}>{STATUS_LABEL[pricingStatus]}</Badge> : null}
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="estimate-model" className="field-label">
            Model you will use
          </label>
          <Select id="estimate-model" value={model} onChange={(e) => onModelChange(e.target.value)}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.pricing ? "" : " (no pricing)"}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label htmlFor="estimate-output" className="field-label">
            Expected answer length
          </label>
          <Select id="estimate-output" value={outputPreset} onChange={(e) => onOutputPresetChange(e.target.value as OutputLengthPreset)}>
            {(Object.keys(OUTPUT_LENGTH_PRESETS) as OutputLengthPreset[]).map((key) => (
              <option key={key} value={key}>
                {OUTPUT_LENGTH_PRESETS[key].label}: about {OUTPUT_LENGTH_PRESETS[key].tokens.toLocaleString("en")} tokens ({OUTPUT_LENGTH_PRESETS[key].hint})
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className={cx("mt-4", state.kind === "loading" && "opacity-60")} aria-live="polite">
        {state.kind === "idle" ? <p className="text-sm text-ink-soft">Enter a prompt to see its token count.</p> : null}
        {state.kind === "unsupported" ? (
          <Alert tone="warning" title="This model is not supported for counting">
            {state.message} Choose another model; PromptIQ never substitutes a different tokenizer.
          </Alert>
        ) : null}
        {state.kind === "error" ? (
          <Alert
            tone="error"
            action={
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRetryToken((n) => n + 1)}>
                Count again
              </button>
            }
          >
            {state.message}
          </Alert>
        ) : null}
        {data ? (isComparison(data) ? <ComparisonTable data={data} /> : <SingleTable data={data} />) : null}
        {data?.pricing_warning ? (
          <Alert tone="warning" className="mt-3">
            {data.pricing_warning}
          </Alert>
        ) : null}
      </div>

      {actualUsage && actualUsage.attempt_count > 0 ? (
        <div className="mt-4 border-t border-line pt-4 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone="accent">actual</Badge>
            <span>
              PromptIQ&apos;s optimisation call used {actualUsage.total_input_tokens.toLocaleString("en")} input and{" "}
              {actualUsage.total_output_tokens.toLocaleString("en")} output tokens
              {actualUsage.actual_cost !== null ? `, ${formatMoney(actualUsage.actual_cost, actualUsage.currency)}` : ""}
              {actualUsage.attempt_count > 1 ? ` across ${actualUsage.attempt_count} provider attempts` : ""}.
            </span>
          </p>
          <p className="mt-1 text-ink-faint">
            Reported by the provider for PromptIQ&apos;s own request, which includes its instructions. This is not the usage of running your prompt.
            {actualUsage.unreported_attempts > 0 ? ` ${actualUsage.unreported_attempts} attempt(s) returned no usage data.` : ""}
          </p>
        </div>
      ) : null}

      <p className="mt-4 text-sm text-ink-faint">
        Counts cover only this text. Message formatting, system instructions, conversation history, tools and files add tokens. The answer length is an assumption.
        PromptIQ cannot see your actual usage when you run the prompt in ChatGPT or another app.
      </p>
    </section>
  );
}

function Row({ label, children, emphasis }: { label: string; children: React.ReactNode; emphasis?: boolean }) {
  return (
    <>
      <dt className="text-ink-soft">{label}</dt>
      <dd className={cx(emphasis && "font-medium")}>{children}</dd>
    </>
  );
}

function SingleTable({ data }: { data: TokenEstimateResult }) {
  return (
    <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-2 text-[0.9375rem]">
      <Row label="Tokens" emphasis>
        <span data-testid="tokens-single">{data.token_count.toLocaleString("en")}</span>
      </Row>
      <Row label="Characters">{data.character_count.toLocaleString("en")}</Row>
      {data.cost ? (
        <>
          <Row label="Input cost">{formatMoney(data.cost.input_cost, data.cost.currency)}</Row>
          <Row label={`Answer (assumed ${data.cost.expected_output_tokens.toLocaleString("en")} tokens)`}>{formatMoney(data.cost.output_cost, data.cost.currency)}</Row>
          <Row label="Estimated cost per request" emphasis>
            {formatMoney(data.cost.total_cost, data.cost.currency)}
          </Row>
        </>
      ) : (
        <Row label="Cost">Not available for this model</Row>
      )}
      <Row label="Tokenizer">{data.encoding}</Row>
    </dl>
  );
}

function ComparisonTable({ data }: { data: TokenComparisonResult }) {
  const cost = data.cost;
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Measure</span>
            </th>
            <th scope="col">Original</th>
            <th scope="col">Optimised</th>
            <th scope="col">Change</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row" className="font-normal text-ink-soft">
              Tokens
            </th>
            <td data-testid="tokens-original">{data.original.token_count.toLocaleString("en")}</td>
            <td data-testid="tokens-optimised">{data.optimised.token_count.toLocaleString("en")}</td>
            <td data-testid="tokens-change" className={cx(data.tokens_saved < 0 && "text-estimate")}>
              {describeChange(data.tokens_saved, data.reduction_percent)}
            </td>
          </tr>
          {cost ? (
            <>
              <tr>
                <th scope="row" className="font-normal text-ink-soft">
                  Input cost
                </th>
                <td>{formatMoney(cost.input_cost_before, cost.currency)}</td>
                <td>{formatMoney(cost.input_cost_after, cost.currency)}</td>
                <td>{cost.input_cost_difference === 0 ? "No change" : `${formatMoney(Math.abs(cost.input_cost_difference), cost.currency)} ${cost.input_cost_difference > 0 ? "less" : "more"}`}</td>
              </tr>
              <tr>
                <th scope="row" className="font-normal text-ink-soft">
                  Answer, assumed {cost.expected_output_tokens.toLocaleString("en")} tokens
                </th>
                <td>{formatMoney(cost.output_cost, cost.currency)}</td>
                <td>{formatMoney(cost.output_cost, cost.currency)}</td>
                <td>Same assumption</td>
              </tr>
              <tr>
                <th scope="row" className="font-normal text-ink-soft">
                  Estimated cost per request
                </th>
                <td className="font-medium">{formatMoney(cost.total_cost_before, cost.currency)}</td>
                <td className="font-medium">{formatMoney(cost.total_cost_after, cost.currency)}</td>
                <td />
              </tr>
            </>
          ) : (
            <tr>
              <th scope="row" className="font-normal text-ink-soft">
                Cost
              </th>
              <td colSpan={3}>Not available for this model</td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="mt-2 text-sm text-ink-soft">
        Both counted with {data.encoding}. A shorter prompt is not automatically better: fewer tokens do not guarantee a better answer or a lower total bill.
      </p>
    </div>
  );
}
