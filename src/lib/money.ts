/** Pure formatting helpers shared by server and client components. */

/**
 * Money with enough precision for prompt-sized costs: amounts under a cent are
 * shown to three significant digits ("$0.00000035"), never rounded to zero.
 */
export function formatMoney(value: number, currency = "USD"): string {
  const abs = Math.abs(value);
  const symbol = currency === "USD" ? "$" : `${currency} `;
  const body =
    abs === 0
      ? "0.00"
      : abs < 0.01
        ? abs.toLocaleString("en", { maximumSignificantDigits: 3, maximumFractionDigits: 12, useGrouping: false })
        : abs.toFixed(abs < 1 ? 4 : 2);
  return `${value < 0 ? "−" : ""}${symbol}${body}`;
}

/** "120 fewer (25% smaller)", "30 more (12.5% larger)" or "No change". */
export function describeChange(tokensSaved: number, reductionPercent: number): string {
  if (tokensSaved === 0) return "No change";
  const n = Math.abs(tokensSaved).toLocaleString("en");
  const pct = Math.abs(reductionPercent).toLocaleString("en", { maximumFractionDigits: 1 });
  return tokensSaved > 0 ? `${n} fewer (${pct}% smaller)` : `${n} more (${pct}% larger)`;
}
