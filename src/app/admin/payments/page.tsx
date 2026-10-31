import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PaymentStatusBadge } from "@/components/billing/status-badge";
import { Badge } from "@/components/ui/badge";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { PAYMENT_STATUSES, type PaymentStatus } from "@/lib/db/schema";
import { formatInr, STATUS_LABELS } from "@/lib/payments/upi";
import { listAdminPayments, listBillingPlans } from "@/lib/services/payments";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Payments" };

type Search = { status?: string; plan?: string; customer?: string; from?: string; to?: string; page?: string };

const QUICK: Array<{ label: string; status: string }> = [
  { label: "Needs review", status: "SUBMITTED_FOR_VERIFICATION,UNDER_REVIEW" },
  { label: "Awaiting payment", status: "PENDING_PAYMENT" },
  { label: "Verified", status: "VERIFIED" },
  { label: "Rejected", status: "REJECTED" },
  { label: "All", status: "" },
];

export default async function AdminPaymentsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await getCurrentUser();
  if (!user?.isAdmin) redirect("/app");
  const sp = await searchParams;
  const status = (sp.status ?? "SUBMITTED_FOR_VERIFICATION,UNDER_REVIEW").split(",").filter((s): s is PaymentStatus => (PAYMENT_STATUSES as readonly string[]).includes(s));
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const validDate = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined);
  const [result, plans] = await Promise.all([
    listAdminPayments(db, { id: user.id, isAdmin: true }, {
      status,
      planCode: sp.plan || undefined,
      customer: sp.customer?.slice(0, 200) || undefined,
      from: validDate(sp.from) ? new Date(`${sp.from}T00:00:00Z`) : undefined,
      to: validDate(sp.to) ? new Date(`${sp.to}T23:59:59.999Z`) : undefined,
      page,
      pageSize: 25,
    }),
    listBillingPlans(db),
  ]);
  const qs = (over: Partial<Search>) => {
    const p = new URLSearchParams();
    const merged = { status: status.join(","), plan: sp.plan, customer: sp.customer, from: sp.from, to: sp.to, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, String(v));
    return `/admin/payments?${p.toString()}`;
  };
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));

  return (
    <div className="space-y-6">
      <header>
        <h1>Payments</h1>
        <p className="mt-2 max-w-3xl text-ink-soft">UPI payments awaiting manual verification. Verify a payment only after finding it in the bank statement or UPI merchant app; a screenshot or transaction ID alone is never proof.</p>
      </header>

      <nav aria-label="Status" className="segmented">
        {QUICK.map((q) => (
          <Link key={q.label} href={qs({ status: q.status, page: undefined })} aria-current={status.join(",") === q.status || (!q.status && status.length === 0) ? "page" : undefined} className="rounded-[7px] px-3 py-1.5 text-sm text-ink-soft no-underline aria-[current=page]:bg-panel aria-[current=page]:font-medium aria-[current=page]:text-ink">
            {q.label}
          </Link>
        ))}
      </nav>

      <form className="panel grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto] lg:items-end" action="/admin/payments">
        <input type="hidden" name="status" value={status.join(",")} />
        <label className="block">
          <span className="field-label">Customer, reference or UTR</span>
          <input className="input" name="customer" defaultValue={sp.customer ?? ""} placeholder="email, name, PIQ-… or UTR" />
        </label>
        <label className="block">
          <span className="field-label">Plan</span>
          <select className="select" name="plan" defaultValue={sp.plan ?? ""}>
            <option value="">All plans</option>
            {plans.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="field-label">From</span>
          <input className="input" type="date" name="from" defaultValue={validDate(sp.from) ?? ""} />
        </label>
        <label className="block">
          <span className="field-label">To</span>
          <input className="input" type="date" name="to" defaultValue={validDate(sp.to) ?? ""} />
        </label>
        <button type="submit" className="btn btn-secondary">
          Filter
        </button>
      </form>

      <div className="panel relative overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Reference</th>
              <th scope="col">Customer</th>
              <th scope="col">Plan</th>
              <th scope="col">Expected</th>
              <th scope="col">Submitted</th>
              <th scope="col">UPI reference</th>
              <th scope="col">Submitted at</th>
              <th scope="col">Status</th>
              <th scope="col">Assigned</th>
            </tr>
          </thead>
          <tbody>
            {result.items.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-8 text-center text-ink-soft">
                  No payments match these filters.
                </td>
              </tr>
            ) : (
              result.items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/admin/payments/${r.id}`} className="font-mono text-sm font-medium">
                      {r.payment_reference}
                    </Link>
                  </td>
                  <td className="text-sm">
                    <span className="block">{r.customer_name ?? "—"}</span>
                    <span className="text-ink-soft">{r.customer_email}</span>
                  </td>
                  <td className="text-sm">{r.plan}</td>
                  <td className="tabular-nums">{formatInr(r.expected_amount_minor)}</td>
                  <td className="tabular-nums">
                    {r.submitted_amount_minor !== null ? formatInr(r.submitted_amount_minor) : "—"}
                    {r.amount_mismatch ? (
                      <Badge tone="danger" className="ml-1">
                        differs
                      </Badge>
                    ) : null}
                  </td>
                  <td className="font-mono text-sm">{r.transaction_reference ?? "—"}</td>
                  <td className="text-sm whitespace-nowrap">{r.submitted_at ? formatDateTime(r.submitted_at) : "—"}</td>
                  <td>
                    <PaymentStatusBadge status={r.status} />
                  </td>
                  <td className="text-sm text-ink-soft">{r.assigned_admin ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between text-sm text-ink-soft">
        <span>
          {result.total} payment{result.total === 1 ? "" : "s"} · {status.length ? status.map((s) => STATUS_LABELS[s].label).join(", ") : "all statuses"}
        </span>
        <span className="flex gap-2">
          {page > 1 ? <Link href={qs({ page: String(page - 1) })} className="btn btn-ghost btn-sm">Previous</Link> : null}
          <span className="self-center">
            Page {page} of {pages}
          </span>
          {page < pages ? <Link href={qs({ page: String(page + 1) })} className="btn btn-ghost btn-sm">Next</Link> : null}
        </span>
      </div>
    </div>
  );
}
