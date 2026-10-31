import type { PaymentStatus } from "@/lib/db/schema";

/**
 * Pure helpers for UPI payments (shared by server and client). Money is always
 * integer paise; formatting happens only at the edges.
 */

/** ₹4,990.00 */
export function formatInr(minor: number): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 }).format(minor / 100);
}

/** "499.00" — the UPI `am` parameter (exactly two decimals, no grouping). */
export function upiAmount(minor: number): string {
  if (!Number.isInteger(minor) || minor <= 0) throw new Error("amount must be a positive integer number of paise");
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}

/** Parse "499", "499.5", "₹ 1,499.00" into paise; null when not a valid amount. */
export function parseInrToMinor(input: string | number): number | null {
  if (typeof input === "number") return Number.isFinite(input) && input > 0 ? Math.round(input * 100) : null;
  const cleaned = input.replace(/[₹,\s]/g, "").replace(/^INR/i, "");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(cleaned)) return null;
  const [rupees, paise = ""] = cleaned.split(".");
  const value = Number(rupees) * 100 + Number(paise.padEnd(2, "0"));
  return value > 0 ? value : null;
}

export const VPA_PATTERN = /^[a-z0-9._-]{2,256}@[a-z][a-z0-9.-]{1,63}$/;
export const PAYEE_NAME_PATTERN = /^[A-Za-z0-9 .&'-]{2,50}$/;

export function isValidVpa(vpa: string): boolean {
  return VPA_PATTERN.test(vpa.trim().toLowerCase());
}

/**
 * Standard UPI deep link. Values are percent-encoded. Only widely supported
 * parameters are used (pa, pn, am, cu, tn); apps may ignore some of them, so
 * the page also shows every value for manual entry.
 */
export function buildUpiUri(input: { vpa: string; payeeName: string; amountMinor: number; reference: string }): string {
  const vpa = input.vpa.trim().toLowerCase();
  if (!isValidVpa(vpa)) throw new Error("Invalid UPI ID");
  if (!PAYEE_NAME_PATTERN.test(input.payeeName)) throw new Error("Invalid payee name");
  if (!PAYMENT_REFERENCE_PATTERN.test(input.reference)) throw new Error("Invalid payment reference");
  const params: Array<[string, string]> = [
    ["pa", vpa],
    ["pn", input.payeeName],
    ["am", upiAmount(input.amountMinor)],
    ["cu", "INR"],
    ["tn", input.reference],
  ];
  return `upi://pay?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
}

/** PIQ-2026-7KQ3M: year plus 5 characters without look-alikes (no 0/O, 1/I/L, U). */
export const PAYMENT_REFERENCE_PATTERN = /^PIQ-\d{4}-[0-9A-Z]{5}$/;
const REFERENCE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generatePaymentReference(now = new Date(), random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = random(5);
  let code = "";
  for (const b of bytes) code += REFERENCE_ALPHABET[b % REFERENCE_ALPHABET.length];
  return `PIQ-${now.getUTCFullYear()}-${code}`;
}

/**
 * UPI transaction references (UTR / RRN / app transaction IDs) differ by
 * provider: commonly 12 digits, sometimes alphanumeric. Accept 6–40 characters
 * of letters, digits, spaces, hyphens and slashes with at least 6 alphanumerics,
 * and compare on the normalised form (upper-case alphanumerics only).
 */
export function normaliseTransactionReference(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export function validateTransactionReference(raw: string): { ok: true; value: string; normalized: string } | { ok: false; reason: string } {
  const value = raw.trim().replace(/\s+/g, " ");
  if (value.length < 6 || value.length > 40) return { ok: false, reason: "Enter the transaction reference exactly as your UPI app shows it (6–40 characters)." };
  if (!/^[0-9A-Za-z \-/]+$/.test(value)) return { ok: false, reason: "The transaction reference can contain only letters, digits, spaces, hyphens and slashes." };
  const normalized = normaliseTransactionReference(value);
  if (normalized.length < 6) return { ok: false, reason: "The transaction reference needs at least 6 letters or digits." };
  if (/^(\d)\1+$/.test(normalized) || /^(0123456789|1234567890|123456123456)$/.test(normalized)) return { ok: false, reason: "That does not look like a real transaction reference." };
  return { ok: true, value, normalized };
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------
export type PaymentActor = "user" | "admin" | "system";

/** Allowed transitions and who may perform them. VERIFIED is admin-only. */
export const TRANSITIONS: Record<PaymentStatus, Partial<Record<PaymentStatus, PaymentActor[]>>> = {
  PENDING_PAYMENT: { SUBMITTED_FOR_VERIFICATION: ["user"], CANCELLED: ["user", "admin"], EXPIRED: ["system"] },
  SUBMITTED_FOR_VERIFICATION: { UNDER_REVIEW: ["admin"], VERIFIED: ["admin"], REJECTED: ["admin"], SUBMITTED_FOR_VERIFICATION: ["user"] },
  UNDER_REVIEW: { VERIFIED: ["admin"], REJECTED: ["admin"], SUBMITTED_FOR_VERIFICATION: ["user"], UNDER_REVIEW: ["admin"] },
  VERIFIED: {},
  REJECTED: {},
  // Only an explicit, audited admin recovery may verify these.
  CANCELLED: { VERIFIED: ["admin"] },
  EXPIRED: { VERIFIED: ["admin"] },
};

export function canTransition(from: PaymentStatus, to: PaymentStatus, actor: PaymentActor): boolean {
  return TRANSITIONS[from][to]?.includes(actor) ?? false;
}

export const OPEN_STATUSES: readonly PaymentStatus[] = ["PENDING_PAYMENT", "SUBMITTED_FOR_VERIFICATION", "UNDER_REVIEW"];

export const STATUS_LABELS: Record<PaymentStatus, { label: string; tone: "neutral" | "accent" | "warn" | "danger" | "estimate"; help: string }> = {
  PENDING_PAYMENT: { label: "Awaiting payment", tone: "estimate", help: "Pay with any UPI app, then tell us the transaction reference." },
  SUBMITTED_FOR_VERIFICATION: { label: "Submitted", tone: "warn", help: "We are checking your payment. Activation is manual and not instant." },
  UNDER_REVIEW: { label: "Under review", tone: "warn", help: "An administrator is checking this payment against our bank records." },
  VERIFIED: { label: "Verified", tone: "accent", help: "Payment confirmed and your subscription is active." },
  REJECTED: { label: "Rejected", tone: "danger", help: "We could not verify this payment. See the reason and try again." },
  CANCELLED: { label: "Cancelled", tone: "neutral", help: "This request was cancelled." },
  EXPIRED: { label: "Expired", tone: "neutral", help: "This request expired before payment details were submitted." },
};

/** Add calendar months in UTC, clamping to the last day of the month (31 Jan + 1 → 28/29 Feb). */
export function addMonthsUtc(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}
