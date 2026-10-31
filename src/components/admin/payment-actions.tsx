"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/field";
import { api, errorMessage } from "@/lib/client/api";
import type { PaymentStatus } from "@/lib/db/schema";
import { canTransition } from "@/lib/payments/upi";

interface Props {
  id: string;
  status: PaymentStatus;
  reference: string;
  expectedAmount: string;
  expectedAmountMinor: number;
  hasSubmission: boolean;
}

/** Review actions. Every action is re-checked and audited on the server. */
export function PaymentActions({ id, status, reference, expectedAmount, expectedAmountMinor, hasSubmission }: Props) {
  const router = useRouter();
  const [dialog, setDialog] = useState<null | "verify" | "reject" | "info">(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [notes, setNotes] = useState("");
  // Deliberately empty: the administrator types the amount they see in the bank record.
  const [amount, setAmount] = useState("");
  const [resolution, setResolution] = useState("");
  const [recovery, setRecovery] = useState("");
  const [txn, setTxn] = useState("");
  const [reason, setReason] = useState("");
  const recoveryMode = status === "EXPIRED" || status === "CANCELLED";
  const differs = amount.trim() !== "" && Math.round(Number(amount) * 100) !== expectedAmountMinor;

  async function run(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/admin/payments/${id}/${path}`, { method: "POST", body });
      setDialog(null);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const close = () => {
    setDialog(null);
    setError(null);
  };

  return (
    <div className="flex flex-wrap gap-2">
      {canTransition(status, "UNDER_REVIEW", "admin") && status !== "UNDER_REVIEW" ? (
        <Button onClick={() => run("review")} loading={busy && dialog === null}>
          Mark under review
        </Button>
      ) : null}
      {canTransition(status, "VERIFIED", "admin") ? (
        <Button variant="primary" onClick={() => setDialog("verify")}>
          {recoveryMode ? "Recover and verify" : "Verify payment"}
        </Button>
      ) : null}
      {canTransition(status, "UNDER_REVIEW", "admin") ? (
        <Button variant="ghost" onClick={() => setDialog("info")}>
          Request more information
        </Button>
      ) : null}
      {canTransition(status, "REJECTED", "admin") ? (
        <Button variant="danger" onClick={() => setDialog("reject")}>
          Reject payment
        </Button>
      ) : null}
      {error && dialog === null ? <Alert tone="error">{error}</Alert> : null}

      <Dialog
        open={dialog === "verify"}
        onClose={close}
        title={`Verify ${reference}`}
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} disabled={!checked || !amount.trim() || notes.trim().length < 5 || (differs && resolution.trim().length < 10) || (recoveryMode && recovery.trim().length < 10)} onClick={() => run("verify", { confirmed_independent_check: true, verification_notes: notes, verified_amount: amount, discrepancy_resolution: differs ? resolution : null, recovery_reason: recoveryMode ? recovery : null, transaction_reference: recoveryMode && txn.trim() ? txn : null })}>
              Verify and activate
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm">This activates the customer&apos;s subscription. Only continue if you found this exact payment in the bank statement or UPI merchant app.</p>
          {recoveryMode ? <Alert tone="warning">This request is {status.toLowerCase()}. Verifying it is a recovery and will be recorded as such.</Alert> : null}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--color-accent)]" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            <span>I independently checked this transaction against the business bank statement or UPI merchant app.</span>
          </label>
          <Field label="Amount received (₹), as shown in your records" help={`Expected ${expectedAmount}.`}>
            {(p) => <Input id={p.id} inputMode="decimal" placeholder="e.g. 499.00" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} aria-describedby={p.describedBy} />}
          </Field>
          {differs ? <Field label="How was the difference resolved?">{(p) => <Textarea id={p.id} rows={2} value={resolution} onChange={(e) => setResolution(e.target.value)} className="font-sans" />}</Field> : null}
          {recoveryMode ? <Field label="Recovery reason">{(p) => <Textarea id={p.id} rows={2} value={recovery} onChange={(e) => setRecovery(e.target.value)} className="font-sans" />}</Field> : null}
          {recoveryMode && !hasSubmission ? <Field label="UPI transaction reference from the bank records">{(p) => <Input id={p.id} value={txn} onChange={(e) => setTxn(e.target.value)} />}</Field> : null}
          <Field label="Verification evidence" help="For example: HDFC statement 31 Oct, credit ₹499 from ravi@okicici, UTR 430912345678.">
            {(p) => <Textarea id={p.id} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} aria-describedby={p.describedBy} className="font-sans" />}
          </Field>
          {error ? <Alert tone="error">{error}</Alert> : null}
        </div>
      </Dialog>

      <Dialog
        open={dialog === "reject"}
        onClose={close}
        title={`Reject ${reference}`}
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} disabled={reason.trim().length < 10} onClick={() => run("reject", { reason })}>
              Reject payment
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm">The customer sees this reason and can start a new payment.</p>
          <Field label="Reason">{(p) => <Textarea id={p.id} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className="font-sans" placeholder="No credit with this UTR reached our account on the stated date." />}</Field>
          {error ? <Alert tone="error">{error}</Alert> : null}
        </div>
      </Dialog>

      <Dialog
        open={dialog === "info"}
        onClose={close}
        title="Request more information"
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} disabled={reason.trim().length < 10} onClick={() => run("request-information", { message: reason })}>
              Send request
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm">The customer sees this message and can update their payment details.</p>
          <Field label="What do you need?">{(p) => <Textarea id={p.id} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className="font-sans" placeholder="Please upload a screenshot showing the UTR and the payee name." />}</Field>
          {error ? <Alert tone="error">{error}</Alert> : null}
        </div>
      </Dialog>
    </div>
  );
}
