import { ok, withApi } from "@/lib/api/handler";
import { db } from "@/lib/db/client";
import { getBillingSubscription } from "@/lib/services/payments";

/** GET /api/v1/billing/subscription — current plan, subscription period and audit events. */
export const GET = withApi({ auth: "required" }, async ({ user }) => ok(await getBillingSubscription(db, user)));
