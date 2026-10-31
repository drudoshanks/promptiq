import { ok, parseQuery, withApi } from "@/lib/api/handler";
import { adminPaymentsQuerySchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { listAdminPayments } from "@/lib/services/payments";

/** GET /api/v1/admin/payments — searchable, filterable list of payment requests (administrators only). */
export const GET = withApi({ auth: "admin", rateLimit: "adminPaymentsPerMinute" }, async ({ request, user }) => {
  const q = parseQuery(request, adminPaymentsQuerySchema);
  return ok(
    await listAdminPayments(db, { id: user.id, isAdmin: user.isAdmin }, {
      status: q.status,
      planCode: q.plan,
      customer: q.customer,
      from: q.from ? new Date(`${q.from}T00:00:00Z`) : undefined,
      to: q.to ? new Date(`${q.to}T23:59:59.999Z`) : undefined,
      page: q.page,
      pageSize: q.page_size,
    }),
  );
});
