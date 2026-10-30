import { ok, withApi } from "@/lib/api/handler";
import { db } from "@/lib/db/client";
import { getDashboardSummary } from "@/lib/services/dashboard";

/** GET /api/v1/dashboard/summary — library summary cards (cached ~30 s, invalidated on change). */
export const GET = withApi({ auth: "required" }, async ({ user }) => ok(await getDashboardSummary(db, user.id)));
