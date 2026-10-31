import { and, asc, eq, lte, sql } from "drizzle-orm";

import { appUsers, notificationOutbox } from "@/lib/db/schema";
import type { DbOrTx } from "@/lib/db/types";
import { logger } from "@/lib/logger";

/**
 * Transactional notification outbox. Rows are written inside the same database
 * transaction as the state change they describe, so nothing is sent for a
 * change that rolled back. Delivery happens after commit (dispatchDue) and is
 * retried with exponential backoff; a failed email never undoes the change.
 */
export const NOTIFICATION_KINDS = [
  "payment_request_created",
  "payment_submitted",
  "verification_started",
  "payment_verified",
  "payment_rejected",
  "information_requested",
  "subscription_expiring",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface EmailSender {
  (message: { to: string; subject: string; text: string }): Promise<void>;
}

export const MAX_ATTEMPTS = 8;

export async function enqueueNotification(db: DbOrTx, input: { userId: string; kind: NotificationKind; payload: Record<string, unknown> }): Promise<void> {
  await db.insert(notificationOutbox).values({ userId: input.userId, kind: input.kind, payload: input.payload });
}

const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

export function renderNotification(kind: string, p: Record<string, unknown>, appUrl: string): { subject: string; text: string } {
  const link = `${appUrl}/app/billing`;
  const ref = s(p.reference);
  switch (kind) {
    case "payment_request_created":
      return { subject: `Payment request ${ref} created`, text: `You started a payment of ${s(p.amount)} for ${s(p.plan)}.\n\nPay ${s(p.payee_name)} (${s(p.payee_vpa)}) with any UPI app and use ${ref} as the note. Then open ${link} and choose "I have paid".\n\nThe request expires on ${s(p.expires_at)}. PromptIQ will never ask for your UPI PIN or OTP.` };
    case "payment_submitted":
      return { subject: `We received your payment details for ${ref}`, text: `Thanks. We will check transaction ${s(p.transaction_reference)} against our bank records. Your subscription will be activated after verification; this is a manual check and is not instant.\n\nTrack it at ${link}.` };
    case "verification_started":
      return { subject: `Payment ${ref} is being verified`, text: `An administrator has started checking your payment ${ref}. You will get another email when it is done.\n\n${link}` };
    case "payment_verified":
      return { subject: `Payment verified: ${s(p.plan)} is active`, text: `Your payment ${ref} of ${s(p.amount)} was verified.\n\n${s(p.plan)} is active from ${s(p.starts_at)} until ${s(p.ends_at)}. Nothing renews automatically; you can renew from ${link}.` };
    case "payment_rejected":
      return { subject: `We could not verify payment ${ref}`, text: `We could not verify your payment ${ref}.\n\nReason: ${s(p.reason)}\n\nIf money left your account, reply with your bank statement line and we will look again. You can also start a new payment at ${link}.` };
    case "information_requested":
      return { subject: `More information needed for payment ${ref}`, text: `To verify payment ${ref} we need a little more information:\n\n${s(p.message)}\n\nOpen ${link}, choose the payment and update your details.` };
    case "subscription_expiring":
      return { subject: `Your PromptIQ Pro access ends on ${s(p.ends_at)}`, text: `Your Pro access ends on ${s(p.ends_at)}. Nothing renews automatically. Renew with UPI at ${link} to keep your limits.` };
    default:
      return { subject: "PromptIQ notification", text: link };
  }
}

/**
 * Deliver due notifications. Safe to call concurrently (rows are claimed with
 * SKIP LOCKED) and repeatedly; call it after commits and from the maintenance job.
 */
export async function dispatchDueNotifications(db: DbOrTx, send: EmailSender, options: { appUrl: string; limit?: number; now?: Date } = { appUrl: "" }): Promise<{ sent: number; failed: number }> {
  const now = options.now ?? new Date();
  const due = await db
    .select({ n: notificationOutbox, email: appUsers.email })
    .from(notificationOutbox)
    .leftJoin(appUsers, eq(appUsers.id, notificationOutbox.userId))
    .where(and(eq(notificationOutbox.status, "pending"), lte(notificationOutbox.nextAttemptAt, now)))
    .orderBy(asc(notificationOutbox.createdAt))
    .limit(options.limit ?? 20)
    .for("update", { of: notificationOutbox, skipLocked: true });
  let sent = 0;
  let failed = 0;
  for (const { n, email } of due) {
    if (!email) {
      await db.update(notificationOutbox).set({ status: "failed", lastError: "no email address", attempts: n.attempts + 1 }).where(eq(notificationOutbox.id, n.id));
      failed++;
      continue;
    }
    const message = renderNotification(n.kind, n.payload, options.appUrl);
    try {
      await send({ to: email, ...message });
      await db.update(notificationOutbox).set({ status: "sent", sentAt: new Date(), attempts: n.attempts + 1, lastError: null }).where(eq(notificationOutbox.id, n.id));
      sent++;
    } catch (error) {
      const attempts = n.attempts + 1;
      const backoffMinutes = Math.min(2 ** attempts, 360);
      await db
        .update(notificationOutbox)
        .set({
          attempts,
          status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          nextAttemptAt: sql`now() + make_interval(mins => ${backoffMinutes})`,
          lastError: (error as Error).message.slice(0, 200),
        })
        .where(eq(notificationOutbox.id, n.id));
      logger.warn("notification delivery failed", { kind: n.kind, attempts });
      failed++;
    }
  }
  return { sent, failed };
}
