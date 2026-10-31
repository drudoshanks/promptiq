import { ok, withApi } from "@/lib/api/handler";
import { idParamSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { getAdminPaymentDetail, serialisePaymentRequest, serialiseSubmission } from "@/lib/services/payments";

/** GET /api/v1/admin/payments/{id} — full detail for verification (administrators only). */
export const GET = withApi<"admin", { id: string }>({ auth: "admin", rateLimit: "adminPaymentsPerMinute" }, async ({ user, params }) => {
  const { id } = idParamSchema.parse(params);
  const d = await getAdminPaymentDetail(db, { id: user.id, isAdmin: user.isAdmin }, id);
  return ok({
    ...serialisePaymentRequest(d.request, d.plan),
    customer: { id: d.user.id, email: d.user.email, name: d.user.displayName, plan_code: d.user.planCode, created_at: d.user.createdAt.toISOString() },
    submissions: d.submissions.map(serialiseSubmission),
    reviews: d.reviews.map((r) => ({ action: r.review.action, admin_email: r.adminEmail, from_status: r.review.fromStatus, to_status: r.review.toStatus, reason: r.review.reason, verification_notes: r.review.verificationNotes, created_at: r.review.createdAt.toISOString() })),
    subscription: d.subscription ? { billing_provider: d.subscription.billingProvider, status: d.subscription.status, current_period_end: d.subscription.currentPeriodEnd?.toISOString() ?? null } : null,
    history: d.history.map((h) => serialisePaymentRequest(h.r, h.plan)),
  });
});
