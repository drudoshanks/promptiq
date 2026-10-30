"use client";

import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/client/api";

interface PlanActionsProps {
  planCode: string;
  billingEnabled: boolean;
  hasBillingAccount: boolean;
}

/** Upgrade / manage billing through hosted Stripe pages (FR-015). */
export function PlanActions({ planCode, billingEnabled, hasBillingAccount }: PlanActionsProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!billingEnabled) {
    return <p className="text-sm text-ink-soft">Billing is not enabled on this deployment.</p>;
  }

  async function go(path: string) {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api<{ url: string }>(path, { method: "POST" });
      window.location.assign(url);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {planCode === "free" ? (
          <Button variant="primary" loading={busy} onClick={() => go("/api/v1/billing/checkout")}>
            Upgrade to Pro
          </Button>
        ) : null}
        {hasBillingAccount ? (
          <Button loading={busy} onClick={() => go("/api/v1/billing/portal")}>
            Manage billing
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-ink-soft">Checkout and billing changes happen on Stripe&apos;s hosted pages. Cancel any time; Pro stays active until the end of the paid period.</p>
      {error ? <Alert tone="error">{error}</Alert> : null}
    </div>
  );
}
