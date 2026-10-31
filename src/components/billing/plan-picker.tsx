"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { api, ApiError, errorMessage } from "@/lib/client/api";
import { cx } from "@/lib/utils";

export interface PlanView {
  code: string;
  name: string;
  description: string;
  amount_display: string;
  billing_period: "month" | "year";
  features: string[];
}

/** Plan cards. Only the plan code is sent; the server sets price, payee and reference. */
export function PlanPicker({ plans, enabled, isPro, renewsUntil }: { plans: PlanView[]; enabled: boolean; isPro: boolean; renewsUntil: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(code: string) {
    setBusy(code);
    setError(null);
    try {
      const r = await api<{ id: string }>("/api/v1/billing/payment-requests", { method: "POST", body: { plan_code: code } });
      router.push(`/app/billing/pay/${r.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONFLICT" && typeof err.details["payment_request_id"] === "string") {
        router.push(`/app/billing/pay/${err.details["payment_request_id"]}`);
        return;
      }
      setError(errorMessage(err));
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="grid gap-4 md:grid-cols-2">
        {plans.map((p, i) => (
          <div key={p.code} className={cx("panel flex flex-col p-5", i === plans.length - 1 && plans.length > 1 && "border-accent/50")}>
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-lg">{p.name}</h3>
              <p className="text-right">
                <span className="text-2xl font-semibold tabular-nums">{p.amount_display}</span>
                <span className="text-sm text-ink-soft"> / {p.billing_period}</span>
              </p>
            </div>
            <p className="mt-2 text-sm text-ink-soft">{p.description}</p>
            <ul className="mt-4 flex-1 space-y-1.5 text-sm">
              {p.features.map((f) => (
                <li key={f} className="flex gap-2">
                  <Check className="mt-0.5 h-4 w-4 flex-none text-accent" aria-hidden="true" />
                  {f}
                </li>
              ))}
            </ul>
            <Button className="mt-5" variant={i === plans.length - 1 ? "primary" : "secondary"} onClick={() => choose(p.code)} loading={busy === p.code} disabled={!enabled || busy !== null}>
              {isPro ? `Renew with ${p.name.toLowerCase().includes("year") ? "a year" : "a month"}` : "Choose plan"}
            </Button>
          </div>
        ))}
      </div>
      {isPro && renewsUntil ? <p className="mt-3 text-sm text-ink-soft">Renewing adds the new period after your current one ends on {renewsUntil}, so you never lose paid days.</p> : null}
      {error ? (
        <Alert tone="error" className="mt-3">
          {error}
        </Alert>
      ) : null}
    </div>
  );
}
