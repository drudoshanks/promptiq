import { ok, withApi } from "@/lib/api/handler";
import { db } from "@/lib/db/client";
import { features } from "@/lib/env";
import { listBillingPlans, serialisePlan } from "@/lib/services/payments";

/** GET /api/v1/billing/plans — plans and INR prices from the database (the only source of prices). */
export const GET = withApi({ auth: "optional" }, async ({ user }) => {
  const plans = await listBillingPlans(db);
  return ok({ items: plans.map(serialisePlan), upi_enabled: features.upiPayments, current_plan: user?.planCode ?? null });
});
