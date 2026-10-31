import { createHash } from "node:crypto";

import { and, asc, count, desc, eq, gte, ilike, inArray, lt, lte, or, sql, type SQL } from "drizzle-orm";

import { AppError, forbidden, notFound } from "@/lib/api/errors";
import { PLANS } from "@/lib/config/plans";
import {
  appUsers,
  billingPlans,
  paymentRequests,
  paymentReviews,
  paymentScreenshots,
  paymentSubmissions,
  subscriptionEvents,
  subscriptions,
  type AppUser,
  type BillingPlan,
  type PaymentRequest,
  type PaymentStatus,
} from "@/lib/db/schema";
import type { Db, DbOrTx } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { validateScreenshot } from "@/lib/payments/screenshot";
import {
  addMonthsUtc,
  buildUpiUri,
  canTransition,
  formatInr,
  generatePaymentReference,
  OPEN_STATUSES,
  validateTransactionReference,
} from "@/lib/payments/upi";

import { enqueueNotification } from "./notifications";

/**
 * UPI payments with manual verification. PromptIQ creates a payment request
 * with a server-side price and reference, records the user's (unverified)
 * claim, and activates a subscription only when an administrator verifies the
 * payment against the business's own records. Entitlement is the existing
 * app_users.plan_code + subscriptions row; nothing new gates features.
 */
export interface UpiConfig {
  vpa: string;
  payeeName: string;
  requestTtlHours: number;
}

export interface AdminActor {
  id: string;
  isAdmin: boolean;
}

const STRIPE_ENTITLED = ["trialing", "active", "past_due"];
const date = (d: Date) => d.toISOString().slice(0, 10);

function assertAdmin(actor: AdminActor) {
  if (!actor.isAdmin) throw forbidden("Administrator access required.");
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------
export async function listBillingPlans(db: DbOrTx): Promise<BillingPlan[]> {
  return db.query.billingPlans.findMany({ where: eq(billingPlans.active, true), orderBy: [asc(billingPlans.sortOrder)] });
}

export function serialisePlan(p: BillingPlan) {
  const limits = PLANS[p.entitlement];
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    amount_minor: p.amountMinor,
    amount_display: formatInr(p.amountMinor),
    currency: p.currency,
    billing_period: p.billingPeriod,
    period_months: p.periodMonths,
    entitlement: p.entitlement,
    features: [
      `${limits.optimisationsPerPeriod.toLocaleString("en-IN")} optimisations per month`,
      `${limits.analysesPerPeriod.toLocaleString("en-IN")} prompt analyses per month`,
      `Prompts up to ${limits.maxPromptChars.toLocaleString("en-IN")} characters`,
      `${limits.maxSavedPrompts.toLocaleString("en-IN")} saved prompts, ${limits.maxVersionsPerPrompt} versions each`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Lazy expiry (also run by the maintenance job)
// ---------------------------------------------------------------------------
export async function expireStaleRequests(db: DbOrTx, options: { userId?: string; now?: Date } = {}): Promise<number> {
  const now = options.now ?? new Date();
  const conditions = [eq(paymentRequests.status, "PENDING_PAYMENT"), lte(paymentRequests.expiresAt, now)];
  if (options.userId) conditions.push(eq(paymentRequests.userId, options.userId));
  const rows = await db.update(paymentRequests).set({ status: "EXPIRED", updatedAt: now }).where(and(...conditions)).returning({ id: paymentRequests.id });
  return rows.length;
}

// ---------------------------------------------------------------------------
// User: create, read, submit, cancel
// ---------------------------------------------------------------------------
export async function createPaymentRequest(db: Db, user: AppUser, input: { planCode: string }, config: UpiConfig, now = new Date()) {
  if (!config.vpa) throw new AppError("BILLING_UNAVAILABLE", "UPI payments are not enabled on this deployment.");
  const plan = await db.query.billingPlans.findFirst({ where: and(eq(billingPlans.code, input.planCode), eq(billingPlans.active, true)) });
  if (!plan) throw notFound("Plan");

  const sub = await db.query.subscriptions.findFirst({ where: eq(subscriptions.userId, user.id) });
  if (sub && sub.billingProvider === "stripe" && STRIPE_ENTITLED.includes(sub.status)) {
    throw new AppError("CONFLICT", "You already have an active card subscription. Manage it from Usage and plan instead of paying twice.");
  }

  await expireStaleRequests(db, { userId: user.id, now });
  const open = await db.query.paymentRequests.findFirst({ where: and(eq(paymentRequests.userId, user.id), inArray(paymentRequests.status, [...OPEN_STATUSES])) });
  if (open) {
    // Re-selecting the same plan returns the existing request instead of a duplicate.
    if (open.status === "PENDING_PAYMENT" && open.planId === plan.id) return { request: open, plan, created: false };
    throw new AppError("CONFLICT", open.status === "PENDING_PAYMENT" ? "You already have a payment in progress. Continue it or cancel it first." : "A payment is waiting for verification. You can start another once it is decided.", {
      details: { payment_request_id: open.id, status: open.status },
    });
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const reference = generatePaymentReference(now);
    try {
      const request = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(paymentRequests)
          .values({
            userId: user.id,
            planId: plan.id,
            paymentReference: reference,
            expectedAmountMinor: plan.amountMinor,
            currency: "INR",
            payeeVpa: config.vpa,
            payeeName: config.payeeName,
            expiresAt: new Date(now.getTime() + config.requestTtlHours * 3_600_000),
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!row) throw new Error("Failed to create payment request");
        await enqueueNotification(tx, {
          userId: user.id,
          kind: "payment_request_created",
          payload: { reference, plan: plan.name, amount: formatInr(plan.amountMinor), payee_name: config.payeeName, payee_vpa: config.vpa, expires_at: row.expiresAt.toISOString().replace("T", " ").slice(0, 16) + " UTC" },
        });
        return row;
      });
      return { request, plan, created: true };
    } catch (error) {
      const msg = `${(error as Error).message} ${String((error as { cause?: unknown }).cause ?? "")}`;
      if (/payment_reference/i.test(msg)) continue; // reference collision: try another
      if (/idx_payment_requests_one_open/i.test(msg)) throw new AppError("CONFLICT", "You already have a payment in progress.");
      throw error;
    }
  }
  throw new Error("Could not allocate a unique payment reference");
}

export async function listPaymentRequests(db: DbOrTx, userId: string) {
  await expireStaleRequests(db, { userId });
  const rows = await db
    .select({ r: paymentRequests, plan: billingPlans })
    .from(paymentRequests)
    .innerJoin(billingPlans, eq(billingPlans.id, paymentRequests.planId))
    .where(eq(paymentRequests.userId, userId))
    .orderBy(desc(paymentRequests.createdAt))
    .limit(100);
  return rows;
}

export async function getOwnedPaymentRequest(db: DbOrTx, userId: string, id: string) {
  await expireStaleRequests(db, { userId });
  const [row] = await db
    .select({ r: paymentRequests, plan: billingPlans })
    .from(paymentRequests)
    .innerJoin(billingPlans, eq(billingPlans.id, paymentRequests.planId))
    .where(and(eq(paymentRequests.id, id), eq(paymentRequests.userId, userId)));
  if (!row) throw notFound("Payment request");
  const submissions = await db.query.paymentSubmissions.findMany({ where: eq(paymentSubmissions.paymentRequestId, id), orderBy: [desc(paymentSubmissions.submittedAt)] });
  return { ...row, submissions };
}

export interface SubmitPaymentInput {
  transactionReference: string;
  paidAt: Date;
  amountMinor: number;
  notes?: string | null;
  screenshot?: Uint8Array | null;
}

/**
 * Record the user's claim. Everything here is unverified: it never grants
 * features. A different amount is accepted but flagged for review.
 */
export async function submitPayment(db: Db, user: AppUser, id: string, input: SubmitPaymentInput, now = new Date()) {
  const ref = validateTransactionReference(input.transactionReference);
  if (!ref.ok) throw new AppError("VALIDATION_ERROR", ref.reason, { details: { field: "transaction_reference" } });
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0 || input.amountMinor > 10_000_000) throw new AppError("VALIDATION_ERROR", "Enter the amount you paid.", { details: { field: "amount" } });
  if (Number.isNaN(input.paidAt.getTime())) throw new AppError("VALIDATION_ERROR", "Enter when you paid.", { details: { field: "paid_at" } });
  if (input.paidAt.getTime() > now.getTime() + 10 * 60_000) throw new AppError("VALIDATION_ERROR", "The payment time cannot be in the future.", { details: { field: "paid_at" } });
  const notes = input.notes?.trim() ? input.notes.trim().slice(0, 1000) : null;
  let screenshot: { type: "image/png" | "image/jpeg" | "image/webp"; bytes: Buffer } | null = null;
  if (input.screenshot && input.screenshot.length) {
    const check = validateScreenshot(input.screenshot);
    if (!check.ok) throw new AppError(check.code, check.reason, { details: { field: "screenshot" } });
    screenshot = { type: check.type, bytes: Buffer.from(input.screenshot) };
  }

  await expireStaleRequests(db, { userId: user.id, now });
  try {
    return await db.transaction(async (tx) => {
      const [request] = await tx.select().from(paymentRequests).where(and(eq(paymentRequests.id, id), eq(paymentRequests.userId, user.id))).for("update");
      if (!request) throw notFound("Payment request");
      const resubmission = request.status !== "PENDING_PAYMENT";
      if (resubmission && !request.infoRequested) {
        throw new AppError("INVALID_TRANSITION", request.status === "EXPIRED" ? "This request has expired. If you already paid, contact support with your transaction reference." : `Payment details cannot be submitted while the request is ${request.status.toLowerCase().replace(/_/g, " ")}.`);
      }
      if (!canTransition(request.status, "SUBMITTED_FOR_VERIFICATION", "user")) throw new AppError("INVALID_TRANSITION", "Payment details cannot be submitted for this request.");
      if (input.paidAt.getTime() < request.createdAt.getTime() - 24 * 3_600_000) {
        throw new AppError("VALIDATION_ERROR", "The payment time is before this payment request was created. Use the payment made for this request.", { details: { field: "paid_at" } });
      }

      // Duplicate detection: a reference used by any other request is refused (also enforced by a unique index).
      const clash = await tx.query.paymentRequests.findFirst({ where: and(eq(paymentRequests.transactionReferenceNormalized, ref.normalized), sql`${paymentRequests.id} <> ${request.id}`) });
      if (clash) throw new AppError("DUPLICATE_TRANSACTION", "This transaction reference has already been submitted for another payment.");

      let screenshotId: string | null = null;
      if (screenshot) {
        const [row] = await tx
          .insert(paymentScreenshots)
          .values({ paymentRequestId: request.id, contentType: screenshot.type, byteSize: screenshot.bytes.length, sha256: createHash("sha256").update(screenshot.bytes).digest("hex"), data: screenshot.bytes })
          .returning({ id: paymentScreenshots.id });
        screenshotId = row?.id ?? null;
      }
      const mismatch = input.amountMinor !== request.expectedAmountMinor;
      const [submission] = await tx
        .insert(paymentSubmissions)
        .values({ paymentRequestId: request.id, transactionReference: ref.value, transactionReferenceNormalized: ref.normalized, amountMinor: input.amountMinor, amountMismatch: mismatch, paidAt: input.paidAt, screenshotId, userNotes: notes, submittedAt: now })
        .returning();
      const [updated] = await tx
        .update(paymentRequests)
        .set({ status: "SUBMITTED_FOR_VERIFICATION", transactionReferenceNormalized: ref.normalized, amountMismatch: mismatch, infoRequested: false, submittedAt: now, updatedAt: now })
        .where(eq(paymentRequests.id, request.id))
        .returning();
      await enqueueNotification(tx, { userId: user.id, kind: "payment_submitted", payload: { reference: request.paymentReference, transaction_reference: ref.value } });
      return { request: updated!, submission: submission! };
    });
  } catch (error) {
    if (/idx_payment_requests_txn_ref/i.test(`${(error as Error).message} ${String((error as { cause?: unknown }).cause ?? "")}`)) {
      throw new AppError("DUPLICATE_TRANSACTION", "This transaction reference has already been submitted for another payment.");
    }
    throw error;
  }
}

export async function cancelPaymentRequest(db: Db, user: AppUser, id: string, now = new Date()) {
  return db.transaction(async (tx) => {
    const [request] = await tx.select().from(paymentRequests).where(and(eq(paymentRequests.id, id), eq(paymentRequests.userId, user.id))).for("update");
    if (!request) throw notFound("Payment request");
    if (request.status === "CANCELLED") return request;
    if (!canTransition(request.status, "CANCELLED", "user")) {
      throw new AppError("INVALID_TRANSITION", "Only a payment that has not been submitted can be cancelled. If you already paid, submit the details instead.");
    }
    const [row] = await tx.update(paymentRequests).set({ status: "CANCELLED", cancelledAt: now, updatedAt: now }).where(eq(paymentRequests.id, id)).returning();
    return row!;
  });
}

// ---------------------------------------------------------------------------
// Subscription view and expiry
// ---------------------------------------------------------------------------
export async function getBillingSubscription(db: DbOrTx, user: AppUser) {
  const sub = await db.query.subscriptions.findFirst({ where: eq(subscriptions.userId, user.id) });
  const events = await db.query.subscriptionEvents.findMany({ where: eq(subscriptionEvents.userId, user.id), orderBy: [desc(subscriptionEvents.createdAt)], limit: 20 });
  return {
    plan_code: user.planCode,
    plan_name: PLANS[user.planCode].name,
    subscription: sub
      ? {
          billing_provider: sub.billingProvider,
          status: sub.status,
          current_period_start: sub.currentPeriodStart?.toISOString() ?? null,
          current_period_end: sub.currentPeriodEnd?.toISOString() ?? null,
          renews_automatically: sub.billingProvider === "stripe" && !sub.cancelAtPeriodEnd,
        }
      : null,
    events: events.map((e) => ({ type: e.eventType, created_at: e.createdAt.toISOString(), payment_request_id: e.paymentRequestId, metadata: e.metadata })),
  };
}

/**
 * Downgrade a user whose manually paid period has ended. Called on every
 * authenticated request for Pro users (cheap: one indexed lookup) and by the
 * maintenance job, so access never outlives the paid period.
 */
export async function enforceManualSubscriptionExpiry(db: DbOrTx, userId: string, now = new Date()): Promise<boolean> {
  const sub = await db.query.subscriptions.findFirst({ where: and(eq(subscriptions.userId, userId), eq(subscriptions.billingProvider, "upi"), eq(subscriptions.status, "active"), lt(subscriptions.currentPeriodEnd, now)) });
  if (!sub) return false;
  await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(subscriptions).where(eq(subscriptions.id, sub.id)).for("update");
    if (!locked || locked.status !== "active" || !locked.currentPeriodEnd || locked.currentPeriodEnd >= now) return;
    await tx.update(subscriptions).set({ status: "canceled", updatedAt: now }).where(eq(subscriptions.id, sub.id));
    await tx.update(appUsers).set({ planCode: "free", updatedAt: now }).where(eq(appUsers.id, userId));
    await tx.insert(subscriptionEvents).values({ userId, subscriptionId: sub.id, eventType: "expired", metadata: { ended_at: locked.currentPeriodEnd.toISOString() } });
  });
  return true;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
export interface AdminPaymentFilters {
  status?: PaymentStatus[];
  planCode?: string;
  customer?: string;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
}

export async function listAdminPayments(db: DbOrTx, actor: AdminActor, filters: AdminPaymentFilters = {}) {
  assertAdmin(actor);
  await expireStaleRequests(db);
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 25));
  const conditions: SQL[] = [];
  if (filters.status?.length) conditions.push(inArray(paymentRequests.status, filters.status));
  if (filters.planCode) conditions.push(eq(billingPlans.code, filters.planCode));
  if (filters.from) conditions.push(gte(paymentRequests.createdAt, filters.from));
  if (filters.to) conditions.push(lte(paymentRequests.createdAt, filters.to));
  if (filters.customer?.trim()) {
    const q = `%${filters.customer.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conditions.push(or(ilike(appUsers.email, q), ilike(appUsers.displayName, q), ilike(paymentRequests.paymentReference, q), ilike(paymentRequests.transactionReferenceNormalized, q.toUpperCase()))!);
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const latestSubmission = db
    .select({ requestId: paymentSubmissions.paymentRequestId, amount: sql<number>`(array_agg(${paymentSubmissions.amountMinor} order by ${paymentSubmissions.submittedAt} desc))[1]`.as("amount"), txn: sql<string>`(array_agg(${paymentSubmissions.transactionReference} order by ${paymentSubmissions.submittedAt} desc))[1]`.as("txn") })
    .from(paymentSubmissions)
    .groupBy(paymentSubmissions.paymentRequestId)
    .as("latest");
  const admin = sql`(select email from app_users a where a.id = ${paymentRequests.assignedAdminId})`;
  const [rows, [total]] = await Promise.all([
    db
      .select({ r: paymentRequests, plan: billingPlans, email: appUsers.email, name: appUsers.displayName, submittedAmount: latestSubmission.amount, txn: latestSubmission.txn, assigned: sql<string | null>`${admin}` })
      .from(paymentRequests)
      .innerJoin(billingPlans, eq(billingPlans.id, paymentRequests.planId))
      .innerJoin(appUsers, eq(appUsers.id, paymentRequests.userId))
      .leftJoin(latestSubmission, eq(latestSubmission.requestId, paymentRequests.id))
      .where(where)
      .orderBy(sql`case when ${paymentRequests.status} in ('SUBMITTED_FOR_VERIFICATION','UNDER_REVIEW') then 0 else 1 end`, desc(paymentRequests.submittedAt), desc(paymentRequests.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: count() }).from(paymentRequests).innerJoin(billingPlans, eq(billingPlans.id, paymentRequests.planId)).innerJoin(appUsers, eq(appUsers.id, paymentRequests.userId)).where(where),
  ]);
  return {
    items: rows.map((x) => ({
      id: x.r.id,
      payment_reference: x.r.paymentReference,
      customer_name: x.name,
      customer_email: x.email,
      plan: x.plan.name,
      plan_code: x.plan.code,
      expected_amount_minor: x.r.expectedAmountMinor,
      submitted_amount_minor: x.submittedAmount === null || x.submittedAmount === undefined ? null : Number(x.submittedAmount),
      transaction_reference: x.txn ?? null,
      amount_mismatch: x.r.amountMismatch,
      submitted_at: x.r.submittedAt?.toISOString() ?? null,
      created_at: x.r.createdAt.toISOString(),
      status: x.r.status,
      assigned_admin: x.assigned,
    })),
    total: Number(total?.n ?? 0),
    page,
    pageSize,
  };
}

export async function getAdminPaymentDetail(db: DbOrTx, actor: AdminActor, id: string) {
  assertAdmin(actor);
  const [row] = await db
    .select({ r: paymentRequests, plan: billingPlans, user: appUsers })
    .from(paymentRequests)
    .innerJoin(billingPlans, eq(billingPlans.id, paymentRequests.planId))
    .innerJoin(appUsers, eq(appUsers.id, paymentRequests.userId))
    .where(eq(paymentRequests.id, id));
  if (!row) throw notFound("Payment request");
  const [submissions, reviews, sub, history] = await Promise.all([
    db.query.paymentSubmissions.findMany({ where: eq(paymentSubmissions.paymentRequestId, id), orderBy: [desc(paymentSubmissions.submittedAt)] }),
    db
      .select({ review: paymentReviews, adminEmail: appUsers.email })
      .from(paymentReviews)
      .leftJoin(appUsers, eq(appUsers.id, paymentReviews.adminUserId))
      .where(eq(paymentReviews.paymentRequestId, id))
      .orderBy(asc(paymentReviews.createdAt)),
    db.query.subscriptions.findFirst({ where: eq(subscriptions.userId, row.user.id) }),
    db
      .select({ r: paymentRequests, plan: billingPlans })
      .from(paymentRequests)
      .innerJoin(billingPlans, eq(billingPlans.id, paymentRequests.planId))
      .where(eq(paymentRequests.userId, row.user.id))
      .orderBy(desc(paymentRequests.createdAt))
      .limit(50),
  ]);
  return { request: row.r, plan: row.plan, user: row.user, submissions, reviews, subscription: sub ?? null, history };
}

async function lockForAdmin(tx: DbOrTx, id: string, now = new Date()): Promise<PaymentRequest> {
  const [request] = await tx.select().from(paymentRequests).where(eq(paymentRequests.id, id)).for("update");
  if (!request) throw notFound("Payment request");
  // Lazy expiry: an unpaid request past its expiry is EXPIRED for every decision.
  if (request.status === "PENDING_PAYMENT" && request.expiresAt <= now) {
    const [expired] = await tx.update(paymentRequests).set({ status: "EXPIRED", updatedAt: now }).where(eq(paymentRequests.id, id)).returning();
    return expired!;
  }
  return request;
}

export async function markUnderReview(db: Db, actor: AdminActor, id: string, now = new Date()) {
  assertAdmin(actor);
  return db.transaction(async (tx) => {
    const request = await lockForAdmin(tx, id, now);
    if (request.status === "UNDER_REVIEW") return request;
    if (!canTransition(request.status, "UNDER_REVIEW", "admin")) throw new AppError("INVALID_TRANSITION", `A ${request.status.toLowerCase().replace(/_/g, " ")} payment cannot be put under review.`);
    const [row] = await tx.update(paymentRequests).set({ status: "UNDER_REVIEW", assignedAdminId: actor.id, reviewedAt: now, updatedAt: now }).where(eq(paymentRequests.id, id)).returning();
    await tx.insert(paymentReviews).values({ paymentRequestId: id, adminUserId: actor.id, action: "marked_under_review", fromStatus: request.status, toStatus: "UNDER_REVIEW", createdAt: now });
    await enqueueNotification(tx, { userId: request.userId, kind: "verification_started", payload: { reference: request.paymentReference } });
    return row!;
  });
}

export async function requestInformation(db: Db, actor: AdminActor, id: string, message: string, now = new Date()) {
  assertAdmin(actor);
  const text = message.trim();
  if (text.length < 10 || text.length > 1000) throw new AppError("VALIDATION_ERROR", "Explain what you need from the customer (10–1,000 characters).");
  return db.transaction(async (tx) => {
    const request = await lockForAdmin(tx, id, now);
    if (!canTransition(request.status, "UNDER_REVIEW", "admin")) throw new AppError("INVALID_TRANSITION", "Information can only be requested for a submitted payment.");
    const [row] = await tx
      .update(paymentRequests)
      .set({ status: "UNDER_REVIEW", infoRequested: true, infoRequestMessage: text, assignedAdminId: request.assignedAdminId ?? actor.id, reviewedAt: now, updatedAt: now })
      .where(eq(paymentRequests.id, id))
      .returning();
    await tx.insert(paymentReviews).values({ paymentRequestId: id, adminUserId: actor.id, action: "information_requested", fromStatus: request.status, toStatus: "UNDER_REVIEW", reason: text, createdAt: now });
    await enqueueNotification(tx, { userId: request.userId, kind: "information_requested", payload: { reference: request.paymentReference, message: text } });
    return row!;
  });
}

export async function rejectPayment(db: Db, actor: AdminActor, id: string, reason: string, now = new Date()) {
  assertAdmin(actor);
  const text = reason.trim();
  if (text.length < 10 || text.length > 1000) throw new AppError("VALIDATION_ERROR", "Give the customer a clear rejection reason (10–1,000 characters).");
  return db.transaction(async (tx) => {
    const request = await lockForAdmin(tx, id, now);
    if (request.status === "REJECTED") return request;
    if (!canTransition(request.status, "REJECTED", "admin")) throw new AppError("INVALID_TRANSITION", `A ${request.status.toLowerCase().replace(/_/g, " ")} payment cannot be rejected.`);
    const [row] = await tx
      .update(paymentRequests)
      .set({ status: "REJECTED", rejectionReason: text, rejectedAt: now, infoRequested: false, assignedAdminId: request.assignedAdminId ?? actor.id, reviewedAt: now, updatedAt: now })
      .where(eq(paymentRequests.id, id))
      .returning();
    await tx.insert(paymentReviews).values({ paymentRequestId: id, adminUserId: actor.id, action: "rejected", fromStatus: request.status, toStatus: "REJECTED", reason: text, createdAt: now });
    await enqueueNotification(tx, { userId: request.userId, kind: "payment_rejected", payload: { reference: request.paymentReference, reason: text } });
    return row!;
  });
}

export interface VerifyPaymentInput {
  /** The administrator confirms they checked the bank statement or UPI merchant app. */
  confirmedIndependentCheck: boolean;
  verificationNotes: string;
  /** Amount the administrator saw in the business's records, in paise. */
  verifiedAmountMinor: number;
  /** Required when the verified amount differs from the expected amount. */
  discrepancyResolution?: string | null;
  /** Required to verify an EXPIRED or CANCELLED request (explicit recovery). */
  recoveryReason?: string | null;
  /** For recovery without a user submission: the reference seen in the bank records. */
  transactionReference?: string | null;
}

export interface VerifyResult {
  request: PaymentRequest;
  alreadyVerified: boolean;
  subscription: { starts_at: string; ends_at: string; event: "activated" | "renewed" } | null;
}

/**
 * Verify a payment and activate the subscription, all in one transaction with
 * the payment and subscription rows locked. Idempotent: verifying an already
 * verified request changes nothing, and the database allows only one
 * activation event per payment request.
 */
export async function verifyPayment(db: Db, actor: AdminActor, id: string, input: VerifyPaymentInput, now = new Date()): Promise<VerifyResult> {
  assertAdmin(actor);
  if (input.confirmedIndependentCheck !== true) throw new AppError("VALIDATION_ERROR", "Confirm that you checked this transaction in the bank statement or UPI merchant app.");
  const notes = input.verificationNotes?.trim() ?? "";
  if (notes.length < 5 || notes.length > 2000) throw new AppError("VALIDATION_ERROR", "Record how the payment was verified (for example the statement line or merchant app entry).");
  if (!Number.isInteger(input.verifiedAmountMinor) || input.verifiedAmountMinor <= 0) throw new AppError("VALIDATION_ERROR", "Enter the amount shown in your bank or merchant records.");

  try {
    const result = await db.transaction(async (tx) => {
      const request = await lockForAdmin(tx, id, now);
      if (request.status === "VERIFIED") return { request, alreadyVerified: true, subscription: null } satisfies VerifyResult;

      const recovery = request.status === "EXPIRED" || request.status === "CANCELLED";
      if (!canTransition(request.status, "VERIFIED", "admin")) throw new AppError("INVALID_TRANSITION", `A ${request.status.toLowerCase().replace(/_/g, " ")} payment cannot be verified.`);
      if (recovery && (input.recoveryReason?.trim().length ?? 0) < 10) {
        throw new AppError("INVALID_TRANSITION", "This request is expired or cancelled. Verifying it is a recovery: give a recovery reason (at least 10 characters).");
      }

      // Transaction reference: the latest user submission, or (recovery only) the one from the bank records.
      const latest = await tx.query.paymentSubmissions.findFirst({ where: eq(paymentSubmissions.paymentRequestId, id), orderBy: [desc(paymentSubmissions.submittedAt)] });
      let normalized = latest?.transactionReferenceNormalized ?? request.transactionReferenceNormalized;
      if (recovery && input.transactionReference) {
        const ref = validateTransactionReference(input.transactionReference);
        if (!ref.ok) throw new AppError("VALIDATION_ERROR", ref.reason);
        normalized = ref.normalized;
      }
      if (!normalized) throw new AppError("VALIDATION_ERROR", "There is no transaction reference to verify. Ask the customer for it, or enter it from the bank records for a recovery.");
      const clash = await tx.query.paymentRequests.findFirst({ where: and(eq(paymentRequests.transactionReferenceNormalized, normalized), sql`${paymentRequests.id} <> ${id}`) });
      if (clash) throw new AppError("DUPLICATE_TRANSACTION", `This transaction reference is already attached to payment ${clash.paymentReference}.`);

      // Amount: must match, or carry a documented resolution.
      const discrepancy = input.verifiedAmountMinor !== request.expectedAmountMinor;
      if (discrepancy && (input.discrepancyResolution?.trim().length ?? 0) < 10) {
        throw new AppError("UNPROCESSABLE", `The verified amount (${formatInr(input.verifiedAmountMinor)}) differs from the expected ${formatInr(request.expectedAmountMinor)}. Document how the difference was resolved, or reject the payment.`);
      }

      const plan = await tx.query.billingPlans.findFirst({ where: eq(billingPlans.id, request.planId) });
      if (!plan) throw new Error("Plan missing for payment request");

      // Subscription: lock, apply renewal policy, never replace a recurring card subscription.
      const [existing] = await tx.select().from(subscriptions).where(eq(subscriptions.userId, request.userId)).for("update");
      if (existing && existing.billingProvider === "stripe" && STRIPE_ENTITLED.includes(existing.status)) {
        throw new AppError("CONFLICT", "This customer has an active card subscription. Resolve that before activating a UPI payment (refund or cancel one of them).");
      }
      const activeManual = existing && existing.billingProvider === "upi" && existing.status === "active" && existing.currentPeriodEnd && existing.currentPeriodEnd > now;
      const startsAt = activeManual ? existing.currentPeriodEnd! : now;
      const endsAt = addMonthsUtc(startsAt, plan.periodMonths);
      const event: "activated" | "renewed" = activeManual ? "renewed" : "activated";

      const [sub] = await tx
        .insert(subscriptions)
        .values({ userId: request.userId, billingProvider: "upi", providerCustomerId: null, providerSubscriptionId: null, status: "active", currentPeriodStart: now, currentPeriodEnd: endsAt, cancelAtPeriodEnd: true, updatedAt: now })
        .onConflictDoUpdate({
          target: subscriptions.userId,
          set: { billingProvider: "upi", providerSubscriptionId: null, status: "active", currentPeriodStart: activeManual ? existing.currentPeriodStart : now, currentPeriodEnd: endsAt, cancelAtPeriodEnd: true, updatedAt: now },
        })
        .returning();
      await tx.update(appUsers).set({ planCode: plan.entitlement, updatedAt: now }).where(eq(appUsers.id, request.userId));

      const [verified] = await tx
        .update(paymentRequests)
        .set({ status: "VERIFIED", verifiedAt: now, verifiedAmountMinor: input.verifiedAmountMinor, transactionReferenceNormalized: normalized, infoRequested: false, assignedAdminId: request.assignedAdminId ?? actor.id, reviewedAt: now, updatedAt: now })
        .where(eq(paymentRequests.id, id))
        .returning();
      await tx.insert(paymentReviews).values({
        paymentRequestId: id,
        adminUserId: actor.id,
        action: recovery ? "recovered" : "verified",
        fromStatus: request.status,
        toStatus: "VERIFIED",
        reason: [recovery ? `Recovery: ${input.recoveryReason!.trim()}` : null, discrepancy ? `Amount discrepancy resolved: ${input.discrepancyResolution!.trim()}` : null].filter(Boolean).join("\n") || null,
        verificationNotes: notes,
        createdAt: now,
      });
      await tx.insert(subscriptionEvents).values({
        userId: request.userId,
        subscriptionId: sub!.id,
        paymentRequestId: id,
        eventType: event,
        metadata: { plan: plan.code, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), amount_minor: input.verifiedAmountMinor, verified_by: actor.id },
        createdAt: now,
      });
      await enqueueNotification(tx, { userId: request.userId, kind: "payment_verified", payload: { reference: request.paymentReference, plan: plan.name, amount: formatInr(input.verifiedAmountMinor), starts_at: date(startsAt), ends_at: date(endsAt) } });
      return { request: verified!, alreadyVerified: false, subscription: { starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), event } } satisfies VerifyResult;
    });
    logger.info("payment verified", { payment_request_id: id, admin_id: actor.id, already: result.alreadyVerified });
    return result;
  } catch (error) {
    const msg = `${(error as Error).message} ${String((error as { cause?: unknown }).cause ?? "")}`;
    // A concurrent verification won the race: report the committed state, change nothing.
    if (/idx_subscription_events_one_activation/i.test(msg)) {
      const request = await db.query.paymentRequests.findFirst({ where: eq(paymentRequests.id, id) });
      return { request: request!, alreadyVerified: true, subscription: null };
    }
    if (/idx_payment_requests_txn_ref/i.test(msg)) throw new AppError("DUPLICATE_TRANSACTION", "This transaction reference is already attached to another payment.");
    throw error;
  }
}

export async function getScreenshot(db: DbOrTx, actor: AdminActor, requestId: string, screenshotId: string) {
  assertAdmin(actor);
  const row = await db.query.paymentScreenshots.findFirst({ where: and(eq(paymentScreenshots.id, screenshotId), eq(paymentScreenshots.paymentRequestId, requestId)) });
  if (!row) throw notFound("Screenshot");
  return row;
}

// ---------------------------------------------------------------------------
// Maintenance: expiry, reminders, retention
// ---------------------------------------------------------------------------
export async function runPaymentMaintenance(db: Db, options: { now?: Date; screenshotRetentionDays: number; reminderDays?: number }) {
  const now = options.now ?? new Date();
  const expiredRequests = await expireStaleRequests(db, { now });

  const lapsed = await db.query.subscriptions.findMany({ where: and(eq(subscriptions.billingProvider, "upi"), eq(subscriptions.status, "active"), lt(subscriptions.currentPeriodEnd, now)) });
  let expiredSubscriptions = 0;
  for (const s of lapsed) if (await enforceManualSubscriptionExpiry(db, s.userId, now)) expiredSubscriptions++;

  // One reminder per paid period, a few days before it ends.
  const soon = new Date(now.getTime() + (options.reminderDays ?? 5) * 86_400_000);
  const ending = await db.query.subscriptions.findMany({ where: and(eq(subscriptions.billingProvider, "upi"), eq(subscriptions.status, "active"), gte(subscriptions.currentPeriodEnd, now), lte(subscriptions.currentPeriodEnd, soon)) });
  let reminders = 0;
  for (const s of ending) {
    const endIso = s.currentPeriodEnd!.toISOString();
    const already = await db.query.subscriptionEvents.findFirst({ where: and(eq(subscriptionEvents.userId, s.userId), eq(subscriptionEvents.eventType, "expiry_reminder_sent"), sql`${subscriptionEvents.metadata}->>'ends_at' = ${endIso}`) });
    if (already) continue;
    await db.transaction(async (tx) => {
      await tx.insert(subscriptionEvents).values({ userId: s.userId, subscriptionId: s.id, eventType: "expiry_reminder_sent", metadata: { ends_at: endIso } });
      await enqueueNotification(tx, { userId: s.userId, kind: "subscription_expiring", payload: { ends_at: date(s.currentPeriodEnd!) } });
    });
    reminders++;
  }

  // Screenshot retention: delete images of decided requests older than the retention window.
  const cutoff = new Date(now.getTime() - options.screenshotRetentionDays * 86_400_000);
  const purged = await db
    .delete(paymentScreenshots)
    .where(
      and(
        lt(paymentScreenshots.createdAt, cutoff),
        inArray(paymentScreenshots.paymentRequestId, db.select({ id: paymentRequests.id }).from(paymentRequests).where(inArray(paymentRequests.status, ["VERIFIED", "REJECTED", "CANCELLED", "EXPIRED"]))),
      ),
    )
    .returning({ id: paymentScreenshots.id });

  return { expiredRequests, expiredSubscriptions, reminders, screenshotsPurged: purged.length };
}

export function paymentUri(r: Pick<PaymentRequest, "payeeVpa" | "payeeName" | "expectedAmountMinor" | "paymentReference">): string {
  return buildUpiUri({ vpa: r.payeeVpa, payeeName: r.payeeName, amountMinor: r.expectedAmountMinor, reference: r.paymentReference });
}

export function serialisePaymentRequest(r: PaymentRequest, plan: BillingPlan) {
  return {
    id: r.id,
    payment_reference: r.paymentReference,
    plan: { code: plan.code, name: plan.name, billing_period: plan.billingPeriod, period_months: plan.periodMonths },
    expected_amount_minor: r.expectedAmountMinor,
    expected_amount_display: formatInr(r.expectedAmountMinor),
    currency: r.currency,
    payee_vpa: r.payeeVpa,
    payee_name: r.payeeName,
    status: r.status,
    amount_mismatch: r.amountMismatch,
    info_requested: r.infoRequested,
    info_request_message: r.infoRequested ? r.infoRequestMessage : null,
    rejection_reason: r.rejectionReason,
    expires_at: r.expiresAt.toISOString(),
    submitted_at: r.submittedAt?.toISOString() ?? null,
    verified_at: r.verifiedAt?.toISOString() ?? null,
    verified_amount_minor: r.verifiedAmountMinor,
    rejected_at: r.rejectedAt?.toISOString() ?? null,
    cancelled_at: r.cancelledAt?.toISOString() ?? null,
    created_at: r.createdAt.toISOString(),
    upi_uri: r.status === "PENDING_PAYMENT" ? paymentUri(r) : null,
  };
}

export function serialiseSubmission(s: { id: string; transactionReference: string; amountMinor: number; amountMismatch: boolean; paidAt: Date; screenshotId: string | null; userNotes: string | null; submittedAt: Date }) {
  return {
    id: s.id,
    transaction_reference: s.transactionReference,
    amount_minor: s.amountMinor,
    amount_display: formatInr(s.amountMinor),
    amount_mismatch: s.amountMismatch,
    paid_at: s.paidAt.toISOString(),
    has_screenshot: Boolean(s.screenshotId),
    screenshot_id: s.screenshotId,
    notes: s.userNotes,
    submitted_at: s.submittedAt.toISOString(),
  };
}


