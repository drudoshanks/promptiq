"use client";

import { useEffect, useState } from "react";

import { EstimateBadge } from "@/components/ui/badge";
import { api } from "@/lib/client/api";
import { COUNT_DEBOUNCE_MS } from "@/lib/config/estimates";
import { formatMoney } from "@/lib/money";
import { cx, formatNumber } from "@/lib/utils";

interface Count {
  token_count: number;
  character_count: number;
  model: string;
  cost: { input_cost: number; currency: string } | null;
}

/** Live token and input-cost count while typing (debounced; exact tokenizer, no model call). */
export function LiveTokenCount({ text, model, maxChars }: { text: string; model: string; maxChars?: number }) {
  const [count, setCount] = useState<Count | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!text.trim()) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        setCount(await api<Count>("/api/v1/token-estimates", { method: "POST", body: { model, text }, signal: controller.signal }));
        setFailed(false);
      } catch (error) {
        if ((error as Error).name !== "AbortError") setFailed(true);
      }
    }, COUNT_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text, model]);

  const chars = [...text].length;
  const over = maxChars !== undefined && chars > maxChars;
  if (!text.trim()) return <p className="mt-2 text-sm text-ink-faint">Token count appears as you type.</p>;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-soft" aria-live="polite">
      <span data-testid="live-tokens">{count && typeof count.token_count === "number" ? `${formatNumber(count.token_count)} tokens` : failed ? "Token count unavailable" : "Counting…"}</span>
      {count?.cost ? <span>· about {formatMoney(count.cost.input_cost, count.cost.currency)} input per run</span> : null}
      <span className={cx(over && "font-medium text-danger")}>
        · {formatNumber(chars)}
        {maxChars !== undefined ? ` / ${formatNumber(maxChars)}` : ""} characters
      </span>
      <EstimateBadge method="tokenizer" />
    </p>
  );
}
