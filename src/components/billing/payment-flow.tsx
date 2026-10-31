"use client";

import { ShieldCheck, Smartphone } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button, LinkButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/field";
import { ApiError, errorMessage } from "@/lib/client/api";
import type { PaymentStatus } from "@/lib/db/schema";
import { STATUS_LABELS } from "@/lib/payments/upi";
import { formatDateTime } from "@/lib/utils";

import { CopyButton } from "./copy-button";
import { PaymentStatusBadge } from "./status-badge";

export interface PaymentView {
  id: string;
  payment_reference: string;
  plan: { name: string };
  expected_amount_minor: number;
  expected_amount_display: string;
  payee_vpa: string;
  payee_name: string;
  status: PaymentStatus;
  amount_mismatch: boolean;
  info_requested: boolean;
  info_request_message: string | null;
  rejection_reason: string | null;
  expires_at: string;
  submitted_at: string | null;
  verified_at: string | null;
  verified_amount_minor: number | null;
  upi_uri: string | null;
  submissions: Array<{ transaction_reference: string; amount_display: string; amount_mismatch: boolean; paid_at: string; has_screenshot: boolean; submitted_at: string }>;
}

const localNow = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

export function PaymentFlow({ payment, qrSvg, subscriptionEnds }: { payment: PaymentView; qrSvg: string | null; subscriptionEnds: string | null }) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(payment.info_requested);
  const [txn, setTxn] = useState("");
  const [paidAt, setPaidAt] = useState(localNow);
  const [amount, setAmount] = useState((payment.expected_amount_minor / 100).toFixed(2));
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fieldError, setFieldError] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"submit" | "cancel" | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const latest = payment.submissions[0];
  const amountDiffers = Number(amount) * 100 !== payment.expected_amount_minor;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy("submit");
    setError(null);
    setFieldError({});
    const form = new FormData();
    form.set("transaction_reference", txn);
    form.set("paid_at", new Date(paidAt).toISOString());
    form.set("amount", amount);
    if (notes.trim()) form.set("notes", notes.trim());
    if (file) form.set("screenshot", file);
    try {
      const res = await fetch(`/api/v1/billing/payment-requests/${payment.id}/submit`, { method: "POST", body: form, credentials: "same-origin" });
      const json = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string; details?: Record<string, unknown> } };
      if (!res.ok) throw new ApiError(json.error?.code ?? "INTERNAL_ERROR", json.error?.message ?? "Something went wrong.", res.status, json.error?.details ?? {});
      router.refresh();
      setShowForm(false);
    } catch (err) {
      const field = err instanceof ApiError ? (err.details["field"] as string | undefined) : undefined;
      if (field) setFieldError({ [field]: errorMessage(err) });
      else setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    setBusy("cancel");
    setError(null);
    try {
      const res = await fetch(`/api/v1/billing/payment-requests/${payment.id}/cancel`, { method: "POST", credentials: "same-origin" });
      if (!res.ok) throw new ApiError("ERROR", ((await res.json()) as { error?: { message: string } }).error?.message ?? "Could not cancel.", res.status);
      setConfirmCancel(false);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-sm text-ink-soft">
          <Link href="/app/billing" className="underline">
            Billing and payments
          </Link>{" "}
          / {payment.payment_reference}
        </p>
        <h1 className="mt-1">{payment.status === "PENDING_PAYMENT" ? "Pay with UPI" : payment.status === "VERIFIED" ? "Payment receipt" : "Payment status"}</h1>
      </div>
      <PaymentStatusBadge status={payment.status} />
    </div>
  );

  const form = (
    <form onSubmit={submit} className="panel space-y-4 p-5" aria-labelledby="paid-heading" noValidate>
      <div>
        <h2 id="paid-heading" className="text-lg">
          {payment.info_requested ? "Update your payment details" : "Tell us about your payment"}
        </h2>
        <p className="mt-1 text-sm text-ink-soft">Find these in your UPI app&apos;s transaction history. We check them against our bank records before activating anything.</p>
      </div>
      <Field label="UPI transaction ID / UTR / reference number" help="Usually 12 digits; some apps show letters too. Enter it exactly as shown." error={fieldError.transaction_reference}>
        {(p) => <Input id={p.id} value={txn} onChange={(e) => setTxn(e.target.value)} required minLength={6} maxLength={40} autoComplete="off" inputMode="text" aria-describedby={p.describedBy} aria-invalid={p.invalid} />}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Date and time of payment" error={fieldError.paid_at}>
          {(p) => <Input id={p.id} type="datetime-local" value={paidAt} max={localNow()} onChange={(e) => setPaidAt(e.target.value)} required aria-describedby={p.describedBy} aria-invalid={p.invalid} />}
        </Field>
        <Field label="Amount paid (₹)" help={amountDiffers ? "Different from the amount due: we will review the difference with you." : "Change only if you paid a different amount."} error={fieldError.amount}>
          {(p) => <Input id={p.id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} required aria-describedby={p.describedBy} aria-invalid={p.invalid} />}
        </Field>
      </div>
      <Field label="Payment screenshot (optional)" help="PNG, JPEG or WebP, up to 2 MB. Seen only by administrators." error={fieldError.screenshot}>
        {(p) => <input id={p.id} type="file" accept="image/png,image/jpeg,image/webp" className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-line-strong file:bg-panel file:px-3 file:py-1.5" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-describedby={p.describedBy} />}
      </Field>
      <Field label="Notes (optional)">{(p) => <Textarea id={p.id} value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={1000} className="font-sans" />}</Field>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={busy === "submit"} disabled={!txn.trim()}>
          Submit payment details
        </Button>
        {!payment.info_requested ? (
          <Button variant="ghost" onClick={() => setShowForm(false)}>
            Back
          </Button>
        ) : null}
      </div>
      <p className="text-[0.8125rem] text-ink-faint">PromptIQ never asks for your UPI PIN, OTP or bank password. Submitting details does not activate Pro; an administrator verifies the payment first.</p>
    </form>
  );

  // Pending: QR, payee and reference.
  if (payment.status === "PENDING_PAYMENT") {
    return (
      <div className="space-y-6">
        {header}
        {showForm ? (
          form
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            <section className="panel p-5" aria-labelledby="scan-heading">
              <h2 id="scan-heading" className="text-lg">
                Scan to pay
              </h2>
              <p className="mt-1 text-sm text-ink-soft">Open any UPI app (Google Pay, PhonePe, Paytm, BHIM or your bank) and scan.</p>
              {qrSvg ? (
                <div className="mx-auto mt-4 w-full max-w-[280px] rounded-xl border border-line bg-white p-2 [&_svg]:h-auto [&_svg]:w-full" role="img" aria-label={`UPI QR code to pay ${payment.expected_amount_display} to ${payment.payee_name}`} dangerouslySetInnerHTML={{ __html: qrSvg }} />
              ) : null}
              {payment.upi_uri ? (
                <a href={payment.upi_uri} className="btn btn-secondary mt-4 w-full lg:hidden">
                  <Smartphone className="h-4 w-4" aria-hidden="true" />
                  Open in a UPI app
                </a>
              ) : null}
              <p className="mt-3 text-[0.8125rem] text-ink-faint">The QR code starts a payment; it does not prove one. Some apps ignore the amount or note in a QR code, so check both before you pay.</p>
            </section>

            <section className="panel p-5" aria-labelledby="details-heading">
              <h2 id="details-heading" className="text-lg">
                Payment details
              </h2>
              <dl className="mt-4 divide-y divide-line">
                <div className="flex items-center justify-between gap-3 py-3">
                  <dt className="text-sm text-ink-soft">Amount</dt>
                  <dd className="text-2xl font-semibold tabular-nums">{payment.expected_amount_display}</dd>
                </div>
                <div className="flex items-center justify-between gap-3 py-3">
                  <dt className="text-sm text-ink-soft">Plan</dt>
                  <dd className="text-right">{payment.plan.name}</dd>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <dt className="text-sm text-ink-soft">Pay to</dt>
                  <dd className="flex items-center gap-1 text-right">
                    <span>
                      <span className="block font-medium">{payment.payee_name}</span>
                      <span className="font-mono text-sm break-all">{payment.payee_vpa}</span>
                    </span>
                    <CopyButton value={payment.payee_vpa} label="UPI ID" />
                  </dd>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <dt className="text-sm text-ink-soft">Payment reference (add as the note)</dt>
                  <dd className="flex items-center gap-1">
                    <span className="font-mono font-medium">{payment.payment_reference}</span>
                    <CopyButton value={payment.payment_reference} label="payment reference" />
                  </dd>
                </div>
              </dl>
              <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm">
                <li>Check the payee name and UPI ID above match what your app shows.</li>
                <li>Pay exactly {payment.expected_amount_display}. Add {payment.payment_reference} as the note if your app allows.</li>
                <li>Note the transaction ID (UTR) from your app, then choose &ldquo;I have paid&rdquo;.</li>
              </ol>
              <div className="mt-4 flex items-start gap-2 rounded-lg bg-info-soft px-3 py-2 text-sm text-info-ink">
                <ShieldCheck className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
                <p>Payments are checked by hand against our bank records, usually within one working day. Pro is activated after that check, not instantly.</p>
              </div>
              {error ? (
                <Alert tone="error" className="mt-3">
                  {error}
                </Alert>
              ) : null}
              <div className="mt-5 flex flex-wrap gap-2">
                <Button variant="primary" onClick={() => setShowForm(true)}>
                  I have paid
                </Button>
                <Button variant="ghost" onClick={() => setConfirmCancel(true)}>
                  Cancel payment
                </Button>
              </div>
              <p className="mt-3 text-[0.8125rem] text-ink-faint">This request expires on {formatDateTime(payment.expires_at)}.</p>
            </section>
          </div>
        )}
        <Dialog
          open={confirmCancel}
          onClose={() => setConfirmCancel(false)}
          title="Cancel this payment?"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmCancel(false)}>
                Keep it
              </Button>
              <Button variant="danger" loading={busy === "cancel"} onClick={cancel}>
                Cancel payment
              </Button>
            </>
          }
        >
          <p>Only cancel if you have not paid. If money has already left your account, choose &ldquo;I have paid&rdquo; instead so we can match it.</p>
        </Dialog>
      </div>
    );
  }

  // Submitted, under review, verified, rejected, cancelled, expired.
  return (
    <div className="space-y-6">
      {header}
      {payment.status === "SUBMITTED_FOR_VERIFICATION" || payment.status === "UNDER_REVIEW" ? (
        <Alert tone={payment.info_requested ? "warning" : "info"} title={payment.info_requested ? "We need more information" : "Payment details submitted"}>
          {payment.info_requested ? payment.info_request_message : "Payment details submitted. Your subscription will be activated after verification."}
        </Alert>
      ) : null}
      {payment.status === "VERIFIED" ? <Alert tone="success" title="Payment verified">Pro is active{subscriptionEnds ? ` until ${subscriptionEnds}` : ""}.</Alert> : null}
      {payment.status === "REJECTED" ? (
        <Alert tone="error" title="We could not verify this payment" action={<LinkButton href="/app/billing#plans" size="sm">Retry payment</LinkButton>}>
          {payment.rejection_reason}
        </Alert>
      ) : null}
      {payment.status === "CANCELLED" || payment.status === "EXPIRED" ? (
        <Alert tone="info" action={<LinkButton href="/app/billing#plans" size="sm">Create a new payment request</LinkButton>}>
          {STATUS_LABELS[payment.status].help} If you already paid, contact support with your transaction reference.
        </Alert>
      ) : null}

      {showForm && payment.info_requested ? form : null}

      <section className="panel p-5" aria-labelledby="summary-heading">
        <h2 id="summary-heading" className="text-lg">
          Summary
        </h2>
        <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Row label="Payment reference" value={payment.payment_reference} mono />
          <Row label="Plan" value={payment.plan.name} />
          <Row label="Amount due" value={payment.expected_amount_display} />
          <Row label="Paid to" value={`${payment.payee_name} (${payment.payee_vpa})`} />
          {latest ? <Row label="Your transaction reference" value={latest.transaction_reference} mono /> : null}
          {latest ? <Row label="Amount you reported" value={`${latest.amount_display}${latest.amount_mismatch ? " (differs; under review)" : ""}`} /> : null}
          {latest ? <Row label="Paid at" value={formatDateTime(latest.paid_at)} /> : null}
          {payment.submitted_at ? <Row label="Submitted" value={formatDateTime(payment.submitted_at)} /> : null}
          {payment.verified_at ? <Row label="Verified" value={formatDateTime(payment.verified_at)} /> : null}
        </dl>
      </section>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-ink-soft">{label}</dt>
      <dd className={mono ? "font-mono" : ""}>{value}</dd>
    </div>
  );
}
