import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { planFor } from "@/lib/config/plans";
import { appUsers, notificationOutbox, paymentRequests, paymentReviews, paymentScreenshots, subscriptionEvents, subscriptions, type AppUser } from "@/lib/db/schema";
import { dispatchDueNotifications } from "@/lib/services/notifications";
import {
  cancelPaymentRequest,
  createPaymentRequest,
  enforceManualSubscriptionExpiry,
  getAdminPaymentDetail,
  getOwnedPaymentRequest,
  listAdminPayments,
  markUnderReview,
  rejectPayment,
  requestInformation,
  runPaymentMaintenance,
  submitPayment,
  verifyPayment,
  type UpiConfig,
} from "@/lib/services/payments";

import { createTestDb, createUser, type TestDb } from "../helpers/test-db";

let t: TestDb;
let admin: AppUser;
const config: UpiConfig = { vpa: "promptiq@okaxis", payeeName: "PromptIQ", requestTtlHours: 48 };
const actor = () => ({ id: admin.id, isAdmin: true });
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

/** Mocked bank statement the "administrator" checks against. No real money moves in tests. */
const BANK_STATEMENT = new Map<string, number>([
  ["430912345678", 49900],
  ["430900000001", 49900],
  ["430900000002", 499000],
  ["430900000003", 49000],
]);
function bankCheck(utr: string) {
  return BANK_STATEMENT.get(utr.replace(/\D/g, "")) ?? null;
}

let utrSeq = 500000000000;
const nextUtr = () => String(++utrSeq);

beforeAll(async () => {
  t = await createTestDb();
  admin = await createUser(t.db, "pay-admin");
});
afterAll(async () => t.close());

async function paidRequest(label: string, utr: string, amountMinor = 49900, plan = "pro_monthly", screenshot?: Buffer) {
  const user = await createUser(t.db, label);
  const { request } = await createPaymentRequest(t.db, user, { planCode: plan }, config);
  await submitPayment(t.db, user, request.id, { transactionReference: utr, paidAt: new Date(), amountMinor, screenshot });
  return { user, request };
}

async function verifyFromBank(id: string, utr: string, extra: Partial<Parameters<typeof verifyPayment>[3]> = {}) {
  const amount = bankCheck(utr);
  if (amount === null) throw new Error("not in bank statement");
  return verifyPayment(t.db, actor(), id, { confirmedIndependentCheck: true, verificationNotes: `Bank statement credit, UTR ${utr}`, verifiedAmountMinor: amount, ...extra });
}

const reload = async (id: string) => (await t.db.query.appUsers.findFirst({ where: eq(appUsers.id, id) }))!;

describe("creating payment requests (1, 2)", () => {
  it("uses the server-side price, a unique reference and a snapshot of the payee", async () => {
    const user = await createUser(t.db, "pay-create");
    const { request, created } = await createPaymentRequest(t.db, user, { planCode: "pro_yearly" }, config);
    expect(created).toBe(true);
    expect(request).toMatchObject({ status: "PENDING_PAYMENT", expectedAmountMinor: 499000, currency: "INR", payeeVpa: "promptiq@okaxis", payeeName: "PromptIQ" });
    expect(request.paymentReference).toMatch(/^PIQ-\d{4}-[0-9A-Z]{5}$/);
    expect(request.expiresAt.getTime() - request.createdAt.getTime()).toBe(48 * 3_600_000);
    const owned = await getOwnedPaymentRequest(t.db, user.id, request.id);
    expect(owned.plan.code).toBe("pro_yearly");
    // Re-selecting the same plan returns the open request; a different plan must wait.
    expect((await createPaymentRequest(t.db, user, { planCode: "pro_yearly" }, config)).created).toBe(false);
    await expect(createPaymentRequest(t.db, user, { planCode: "pro_monthly" }, config)).rejects.toMatchObject({ code: "CONFLICT" });
    // After cancelling, a new request is allowed.
    await cancelPaymentRequest(t.db, user, request.id);
    expect((await createPaymentRequest(t.db, user, { planCode: "pro_monthly" }, config)).created).toBe(true);
  });

  it("is disabled without a configured UPI ID and rejects unknown plans", async () => {
    const user = await createUser(t.db, "pay-disabled");
    await expect(createPaymentRequest(t.db, user, { planCode: "pro_monthly" }, { ...config, vpa: "" })).rejects.toMatchObject({ code: "BILLING_UNAVAILABLE" });
    await expect(createPaymentRequest(t.db, user, { planCode: "gold" }, config)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a UPI request while a card subscription is active", async () => {
    const user = await createUser(t.db, "pay-stripe");
    await t.db.insert(subscriptions).values({ userId: user.id, billingProvider: "stripe", status: "active", providerSubscriptionId: "sub_1" });
    await expect(createPaymentRequest(t.db, user, { planCode: "pro_monthly" }, config)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("submitting payment details (3, 4, 10, 15)", () => {
  it("records an unverified claim and grants nothing", async () => {
    const { user, request } = await paidRequest("pay-submit", "4309 1234 5678");
    const after = await getOwnedPaymentRequest(t.db, user.id, request.id);
    expect(after.r.status).toBe("SUBMITTED_FOR_VERIFICATION");
    expect(after.r.transactionReferenceNormalized).toBe("430912345678");
    expect(after.submissions).toHaveLength(1);
    expect((await reload(user.id)).planCode).toBe("free");
    expect(await t.db.query.subscriptions.findFirst({ where: eq(subscriptions.userId, user.id) })).toBeUndefined();
  });

  it("flags a different amount for review instead of rejecting it", async () => {
    const { request } = await paidRequest("pay-mismatch", nextUtr(), 49000);
    const row = await t.db.query.paymentRequests.findFirst({ where: eq(paymentRequests.id, request.id) });
    expect(row?.amountMismatch).toBe(true);
    expect(row?.status).toBe("SUBMITTED_FOR_VERIFICATION");
  });

  it("validates the reference, time and screenshot content", async () => {
    const user = await createUser(t.db, "pay-validate");
    const { request } = await createPaymentRequest(t.db, user, { planCode: "pro_monthly" }, config);
    await expect(submitPayment(t.db, user, request.id, { transactionReference: "123", paidAt: new Date(), amountMinor: 49900 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(submitPayment(t.db, user, request.id, { transactionReference: nextUtr(), paidAt: new Date(Date.now() + 86_400_000), amountMinor: 49900 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(submitPayment(t.db, user, request.id, { transactionReference: nextUtr(), paidAt: new Date(), amountMinor: 49900, screenshot: Buffer.from("GIF89a fake") })).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
    await expect(submitPayment(t.db, user, request.id, { transactionReference: nextUtr(), paidAt: new Date(), amountMinor: 49900, screenshot: Buffer.alloc(3 * 1024 * 1024, 0x89) })).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(await t.db.query.paymentScreenshots.findMany({ where: eq(paymentScreenshots.paymentRequestId, request.id) })).toHaveLength(0);
    const ok = await submitPayment(t.db, user, request.id, { transactionReference: nextUtr(), paidAt: new Date(), amountMinor: 49900, screenshot: PNG, notes: "Paid from SBI" });
    expect(ok.submission.screenshotId).toBeTruthy();
    // A second submission without an information request is refused.
    await expect(submitPayment(t.db, user, request.id, { transactionReference: nextUtr(), paidAt: new Date(), amountMinor: 49900 })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });
});

describe("duplicate transaction references (9)", () => {
  it("rejects a reference already used by another request, including rejected ones", async () => {
    const utr = nextUtr();
    const first = await paidRequest("pay-dup-a", utr);
    const other = await createUser(t.db, "pay-dup-b");
    const { request } = await createPaymentRequest(t.db, other, { planCode: "pro_monthly" }, config);
    await expect(submitPayment(t.db, other, request.id, { transactionReference: utr.replace(/(\d{4})/g, "$1 ").trim(), paidAt: new Date(), amountMinor: 49900 })).rejects.toMatchObject({ code: "DUPLICATE_TRANSACTION" });
    await rejectPayment(t.db, actor(), first.request.id, "No matching credit in the bank statement.");
    await expect(submitPayment(t.db, other, request.id, { transactionReference: utr, paidAt: new Date(), amountMinor: 49900 })).rejects.toMatchObject({ code: "DUPLICATE_TRANSACTION" });
  });
});

describe("authorisation and ownership (5, 6)", () => {
  it("non-administrators cannot review, verify or reject", async () => {
    const { user, request } = await paidRequest("pay-authz", nextUtr());
    const notAdmin = { id: user.id, isAdmin: false };
    await expect(verifyPayment(t.db, notAdmin, request.id, { confirmedIndependentCheck: true, verificationNotes: "trust me", verifiedAmountMinor: 49900 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(markUnderReview(t.db, notAdmin, request.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(rejectPayment(t.db, notAdmin, request.id, "Not allowed to do this")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listAdminPayments(t.db, notAdmin)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await reload(user.id)).planCode).toBe("free");
  });

  it("users cannot read, submit or cancel another user's request", async () => {
    const owner = await createUser(t.db, "pay-owner");
    const intruder = await createUser(t.db, "pay-intruder");
    const { request } = await createPaymentRequest(t.db, owner, { planCode: "pro_monthly" }, config);
    await expect(getOwnedPaymentRequest(t.db, intruder.id, request.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(submitPayment(t.db, intruder, request.id, { transactionReference: nextUtr(), paidAt: new Date(), amountMinor: 49900 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(cancelPaymentRequest(t.db, intruder, request.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("verification and activation (7, 8, 13, 16)", () => {
  it("verifies against the bank record and activates exactly once, transactionally", async () => {
    const { user, request } = await paidRequest("pay-verify", "430900000001");
    await markUnderReview(t.db, actor(), request.id);
    const result = await verifyFromBank(request.id, "430900000001");
    expect(result.alreadyVerified).toBe(false);
    expect(result.subscription?.event).toBe("activated");
    const u = await reload(user.id);
    expect(u.planCode).toBe("pro");
    expect(planFor(u.planCode).optimisationsPerPeriod).toBe(500); // existing entitlements apply
    const sub = await t.db.query.subscriptions.findFirst({ where: eq(subscriptions.userId, user.id) });
    expect(sub).toMatchObject({ billingProvider: "upi", status: "active" });
    const days = (sub!.currentPeriodEnd!.getTime() - sub!.currentPeriodStart!.getTime()) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(28);
    expect(days).toBeLessThanOrEqual(31);
    // Repeat: no change, no second event, no extension.
    const again = await verifyFromBank(request.id, "430900000001");
    expect(again.alreadyVerified).toBe(true);
    const sub2 = await t.db.query.subscriptions.findFirst({ where: eq(subscriptions.userId, user.id) });
    expect(sub2!.currentPeriodEnd!.getTime()).toBe(sub!.currentPeriodEnd!.getTime());
    const events = await t.db.query.subscriptionEvents.findMany({ where: eq(subscriptionEvents.paymentRequestId, request.id) });
    expect(events.map((e) => e.eventType)).toEqual(["activated"]);
    const detail = await getAdminPaymentDetail(t.db, actor(), request.id);
    expect(detail.reviews.map((r) => r.review.action)).toEqual(["marked_under_review", "verified"]);
    expect(detail.reviews[1]!.review.verificationNotes).toContain("430900000001");
  });

  it("concurrent verifications produce one activation and one period", async () => {
    const utr = nextUtr();
    BANK_STATEMENT.set(utr, 49900);
    const { user, request } = await paidRequest("pay-race", utr);
    const results = await Promise.all([verifyFromBank(request.id, utr), verifyFromBank(request.id, utr), verifyFromBank(request.id, utr)]);
    expect(results.filter((r) => !r.alreadyVerified)).toHaveLength(1);
    expect(await t.db.query.subscriptionEvents.findMany({ where: eq(subscriptionEvents.paymentRequestId, request.id) })).toHaveLength(1);
    expect((await reload(user.id)).planCode).toBe("pro");
  });

  it("renewal extends from the current end; it never shortens or double-extends", async () => {
    const utr1 = nextUtr();
    const utr2 = nextUtr();
    BANK_STATEMENT.set(utr1, 49900);
    BANK_STATEMENT.set(utr2, 499000);
    const { user, request } = await paidRequest("pay-renew", utr1);
    await verifyFromBank(request.id, utr1);
    const firstEnd = (await t.db.query.subscriptions.findFirst({ where: eq(subscriptions.userId, user.id) }))!.currentPeriodEnd!;
    const { request: second } = await createPaymentRequest(t.db, user, { planCode: "pro_yearly" }, config);
    await submitPayment(t.db, user, second.id, { transactionReference: utr2, paidAt: new Date(), amountMinor: 499000 });
    const r = await verifyFromBank(second.id, utr2);
    expect(r.subscription?.event).toBe("renewed");
    expect(new Date(r.subscription!.starts_at).getTime()).toBe(firstEnd.getTime());
    const end = (await t.db.query.subscriptions.findFirst({ where: eq(subscriptions.userId, user.id) }))!.currentPeriodEnd!;
    expect(Math.round((end.getTime() - firstEnd.getTime()) / 86_400_000)).toBeGreaterThanOrEqual(365);
  });

  it("requires the independent-check confirmation, evidence, and a documented resolution for amount differences", async () => {
    const { request } = await paidRequest("pay-evidence", "430900000003", 49000);
    await expect(verifyPayment(t.db, actor(), request.id, { confirmedIndependentCheck: false, verificationNotes: "Bank statement", verifiedAmountMinor: 49900 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(verifyPayment(t.db, actor(), request.id, { confirmedIndependentCheck: true, verificationNotes: "", verifiedAmountMinor: 49900 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(verifyFromBank(request.id, "430900000003")).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    const r = await verifyFromBank(request.id, "430900000003", { discrepancyResolution: "Customer paid ₹490 after a ₹9 coupon agreed by support." });
    expect(r.request.verifiedAmountMinor).toBe(49000);
  });

  it("will not verify a reference already attached to another request", async () => {
    const utr = nextUtr();
    const { request } = await paidRequest("pay-verify-dup", utr);
    const other = await createUser(t.db, "pay-verify-dup-2");
    const { request: expired } = await createPaymentRequest(t.db, other, { planCode: "pro_monthly" }, config, new Date(Date.now() - 72 * 3_600_000));
    await expect(verifyPayment(t.db, actor(), expired.id, { confirmedIndependentCheck: true, verificationNotes: "From statement", verifiedAmountMinor: 49900, recoveryReason: "Customer paid before the request expired.", transactionReference: utr })).rejects.toMatchObject({ code: "DUPLICATE_TRANSACTION" });
    expect((await t.db.query.paymentRequests.findFirst({ where: eq(paymentRequests.id, request.id) }))?.status).toBe("SUBMITTED_FOR_VERIFICATION");
  });
});

describe("rejection, information requests, expiry and recovery (11, 12)", () => {
  it("rejected payments activate nothing and allow a new request", async () => {
    const { user, request } = await paidRequest("pay-reject", nextUtr());
    await expect(rejectPayment(t.db, actor(), request.id, "short")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const r = await rejectPayment(t.db, actor(), request.id, "No credit with this UTR reached our account.");
    expect(r.status).toBe("REJECTED");
    await expect(verifyPayment(t.db, actor(), request.id, { confirmedIndependentCheck: true, verificationNotes: "x x x x", verifiedAmountMinor: 49900 })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect((await reload(user.id)).planCode).toBe("free");
    expect((await createPaymentRequest(t.db, user, { planCode: "pro_monthly" }, config)).created).toBe(true);
  });

  it("an information request lets the user resubmit", async () => {
    const { user, request } = await paidRequest("pay-info", nextUtr());
    await requestInformation(t.db, actor(), request.id, "Please upload a screenshot showing the UTR.");
    const mid = await getOwnedPaymentRequest(t.db, user.id, request.id);
    expect(mid.r).toMatchObject({ status: "UNDER_REVIEW", infoRequested: true });
    await submitPayment(t.db, user, request.id, { transactionReference: nextUtr(), paidAt: new Date(), amountMinor: 49900, screenshot: PNG });
    const after = await getOwnedPaymentRequest(t.db, user.id, request.id);
    expect(after.r).toMatchObject({ status: "SUBMITTED_FOR_VERIFICATION", infoRequested: false });
    expect(after.submissions).toHaveLength(2);
  });

  it("expired and cancelled requests cannot be verified without an explicit recovery", async () => {
    const user = await createUser(t.db, "pay-expired");
    const { request } = await createPaymentRequest(t.db, user, { planCode: "pro_monthly" }, config, new Date(Date.now() - 49 * 3_600_000));
    const got = await getOwnedPaymentRequest(t.db, user.id, request.id);
    expect(got.r.status).toBe("EXPIRED");
    await expect(submitPayment(t.db, user, request.id, { transactionReference: nextUtr(), paidAt: new Date(), amountMinor: 49900 })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    const utr = nextUtr();
    await expect(verifyPayment(t.db, actor(), request.id, { confirmedIndependentCheck: true, verificationNotes: "Statement line found", verifiedAmountMinor: 49900, transactionReference: utr })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    const r = await verifyPayment(t.db, actor(), request.id, { confirmedIndependentCheck: true, verificationNotes: "Statement line found", verifiedAmountMinor: 49900, transactionReference: utr, recoveryReason: "Customer paid within the window but submitted late." });
    expect(r.request.status).toBe("VERIFIED");
    const reviews = await t.db.query.paymentReviews.findMany({ where: eq(paymentReviews.paymentRequestId, request.id) });
    expect(reviews[0]).toMatchObject({ action: "recovered", fromStatus: "EXPIRED" });

    const user2 = await createUser(t.db, "pay-cancelled");
    const { request: c } = await createPaymentRequest(t.db, user2, { planCode: "pro_monthly" }, config);
    await cancelPaymentRequest(t.db, user2, c.id);
    await expect(verifyPayment(t.db, actor(), c.id, { confirmedIndependentCheck: true, verificationNotes: "Statement", verifiedAmountMinor: 49900, transactionReference: nextUtr() })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("the audit trail is append-only", async () => {
    const review = await t.db.query.paymentReviews.findFirst();
    await expect(t.db.update(paymentReviews).set({ reason: "edited" }).where(eq(paymentReviews.id, review!.id))).rejects.toThrow();
    await expect(t.db.delete(subscriptionEvents)).rejects.toThrow();
  });
});

describe("notifications (14)", () => {
  it("are sent only after commit, and a failed email never rolls back activation", async () => {
    const utr = nextUtr();
    BANK_STATEMENT.set(utr, 49900);
    const { user, request } = await paidRequest("pay-mail", utr);
    await verifyFromBank(request.id, utr);
    const pending = await t.db.query.notificationOutbox.findMany({ where: and(eq(notificationOutbox.userId, user.id), eq(notificationOutbox.status, "pending")) });
    expect(pending.map((n) => n.kind).sort()).toEqual(["payment_request_created", "payment_submitted", "payment_verified"]);

    const failing = async () => {
      throw new Error("SMTP down");
    };
    const first = await dispatchDueNotifications(t.db, failing, { appUrl: "https://x", limit: 100 });
    expect(first.failed).toBeGreaterThan(0);
    expect((await reload(user.id)).planCode).toBe("pro"); // activation stands
    const retry = await t.db.query.notificationOutbox.findFirst({ where: and(eq(notificationOutbox.userId, user.id), eq(notificationOutbox.kind, "payment_verified")) });
    expect(retry).toMatchObject({ status: "pending", attempts: 1, lastError: "SMTP down" });

    const sent: string[] = [];
    const later = new Date(Date.now() + 3_600_000);
    await dispatchDueNotifications(t.db, async (m) => void sent.push(m.subject), { appUrl: "https://x", limit: 100, now: later });
    expect(sent.some((s) => s.startsWith("Payment verified"))).toBe(true);
    // A rolled-back change leaves no notification behind.
    const noisy = await createUser(t.db, "pay-rollback");
    await expect(createPaymentRequest(t.db, noisy, { planCode: "missing" }, config)).rejects.toThrow();
    expect(await t.db.query.notificationOutbox.findMany({ where: eq(notificationOutbox.userId, noisy.id) })).toHaveLength(0);
  });
});

describe("expiry, reminders and retention", () => {
  it("downgrades when the paid period ends and runs maintenance idempotently", async () => {
    const utr = nextUtr();
    BANK_STATEMENT.set(utr, 49900);
    const { user, request } = await paidRequest("pay-lapse", utr, 49900, "pro_monthly", PNG);
    await verifyFromBank(request.id, utr);
    const end = (await t.db.query.subscriptions.findFirst({ where: eq(subscriptions.userId, user.id) }))!.currentPeriodEnd!;

    const near = new Date(end.getTime() - 2 * 86_400_000);
    const r1 = await runPaymentMaintenance(t.db, { now: near, screenshotRetentionDays: 180 });
    expect(r1.reminders).toBeGreaterThanOrEqual(1);
    const r2 = await runPaymentMaintenance(t.db, { now: near, screenshotRetentionDays: 180 });
    expect(r2.reminders).toBe(0);

    expect(await enforceManualSubscriptionExpiry(t.db, user.id, new Date(end.getTime() - 1000))).toBe(false);
    expect(await enforceManualSubscriptionExpiry(t.db, user.id, new Date(end.getTime() + 1000))).toBe(true);
    expect((await reload(user.id)).planCode).toBe("free");
    const events = await t.db.query.subscriptionEvents.findMany({ where: eq(subscriptionEvents.userId, user.id) });
    expect(events.map((e) => e.eventType)).toEqual(expect.arrayContaining(["activated", "expiry_reminder_sent", "expired"]));

    const purge = await runPaymentMaintenance(t.db, { now: new Date(Date.now() + 400 * 86_400_000), screenshotRetentionDays: 180 });
    expect(purge.screenshotsPurged).toBeGreaterThanOrEqual(1);
  });

  it("admin list filters by status and customer", async () => {
    const list = await listAdminPayments(t.db, actor(), { status: ["VERIFIED"], customer: "pay-verify@" });
    expect(list.items.length).toBe(1);
    expect(list.items[0]!.status).toBe("VERIFIED");
    const mismatch = await listAdminPayments(t.db, actor(), { customer: "pay-mismatch" });
    expect(mismatch.items[0]).toMatchObject({ amount_mismatch: true, submitted_amount_minor: 49000 });
  });
});
