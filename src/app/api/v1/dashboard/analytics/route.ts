import { ok, withApi } from "@/lib/api/handler";
import { db } from "@/lib/db/client";
import { getDashboardAnalytics } from "@/lib/services/dashboard";

/** GET /api/v1/dashboard/analytics — suggestion, optimisation and token analytics. */
export const GET = withApi({ auth: "required" }, async ({ user }) => ok(await getDashboardAnalytics(db, user.id)));
