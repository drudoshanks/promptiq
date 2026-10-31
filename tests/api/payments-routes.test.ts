import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CurrentUser } from "@/lib/auth/session";
import type { AppUser } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

import { createTestDb, createUser, type TestDb } from "../helpers/test-db";

/** Real billing/admin payment routes; only session, DB handle and UPI env are doubles. */
const holder = vi.hoisted(() => ({ db: null as unknown as Db, users: new Map<string, CurrentUser>() }));
vi.mock("@/lib/db/client", () => ({
  db: new Proxy({} as object, {
    get(_t, key) {
      const value = (holder.db as unknown as Record<string | symbol, unknown>)[key];
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(holder.db) : value;
    },
  }),
  pool: {},
}));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUserFromHeaders: async (headers: Headers) => holder.users.get(headers.get("x-test-user") ?? "") ?? null,
  getCurrentUser: async () => null,
}));
vi.mock("@/lib/services/payment-context", () => ({
  upiConfig: () => ({ vpa: "promptiq@okaxis", payeeName: "PromptIQ", requestTtlHours: 48 }),
  dispatchNotificationsSoon: () => undefined,
}));

const plansRoute = await import("@/app/api/v1/billing/plans/route");
const requestsRoute = await import("@/app/api/v1/billing/payment-requests/route");
const requestRoute = await import("@/app/api/v1/billing/payment-requests/[id]/route");
const submitRoute = await import("@/app/api/v1/billing/payment-requests/[id]/submit/route");
const cancelRoute = await import("@/app/api/v1/billing/payment-requests/[id]/cancel/route");
const subscriptionRoute = await import("@/app/api/v1/billing/subscription/route");
const adminList = await import("@/app/api/v1/admin/payments/route");
const adminDetail = await import("@/app/api/v1/admin/payments/[id]/route");
const adminVerify = await import("@/app/api/v1/admin/payments/[id]/verify/route");
const adminReject = await import("@/app/api/v1/admin/payments/[id]/reject/route");
const adminReview = await import("@/app/api/v1/admin/payments/[id]/review/route");
const adminScreenshot = await import("@/app/api/v1/admin/payments/[id]/screenshots/[screenshotId]/route");
const { resetRateLimits } = await import("@/lib/api/rate-limit");

let t: TestDb;
let ip = 0;
const users: Record<string, AppUser> = {};
const current = (u: AppUser, isAdmin = false): CurrentUser => ({ ...u, isAdmin, session: { id: "s", createdAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000), isFresh: true } });
function req(url: string, user: string | null, body?: unknown, method = body === undefined ? "GET" : "POST", extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": `10.40.${Math.floor(ip / 200)}.${ip++ % 200}`, origin: "http://localhost:3000", ...extraHeaders };
  if (user) headers["x-test-user"] = user;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  return new NextRequest(`http://localhost:3000${url}`, { method, headers, body: payload });
}
const none = { params: Promise.resolve({}) };
const id = (v: string) => ({ params: Promise.resolve({ id: v }) });
async function json(res: Response) {
  return (await res.json()) as { data: Record<string, any>; error?: { code: string; message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

beforeAll(async () => {
  t = await createTestDb();
  holder.db = t.db;
  for (const name of ["buyer", "other", "admin"]) {
    users[name] = await createUser(t.db, `route-${name}`);
    holder.users.set(name, current(users[name]!, name === "admin"));
  }
});
afterAll(async () => t.close());
beforeEach(() => resetRateLimits());

describe("billing routes", () => {
  it("lists plans with server-side INR prices", async () => {
    const res = await plansRoute.GET(req("/api/v1/billing/plans", null), none);
    const data = (await json(res)).data;
    expect(data.items.map((p: { code: string; amount_minor: number }) => [p.code, p.amount_minor])).toEqual([["pro_monthly", 49900], ["pro_yearly", 499000]]);
  });

  it("requires sign-in and accepts only the plan code", async () => {
    expect((await requestsRoute.POST(req("/api/v1/billing/payment-requests", null, { plan_code: "pro_monthly" }), none)).status).toBe(401);
    const tampered = await requestsRoute.POST(req("/api/v1/billing/payment-requests", "buyer", { plan_code: "pro_monthly", amount: 1, payee_vpa: "evil@upi" }), none);
    expect(tampered.status).toBe(400);
  });

  it("creates a request with the QR, submits multipart details, and keeps the plan free until verified", async () => {
    const created = await requestsRoute.POST(req("/api/v1/billing/payment-requests", "buyer", { plan_code: "pro_monthly" }), none);
    expect(created.status).toBe(201);
    const pr = (await json(created)).data;
    expect(pr.upi_uri).toBe(`upi://pay?pa=promptiq%40okaxis&pn=PromptIQ&am=499.00&cu=INR&tn=${pr.payment_reference}`);
    const detail = (await json(await requestRoute.GET(req(`/api/v1/billing/payment-requests/${pr.id}`, "buyer"), id(pr.id)))).data;
    expect(detail.qr_svg).toMatch(/^<svg/);

    // Another user can't see it.
    expect((await requestRoute.GET(req(`/api/v1/billing/payment-requests/${pr.id}`, "other"), id(pr.id))).status).toBe(404);

    const bad = new FormData();
    bad.set("transaction_reference", "430955555555");
    bad.set("paid_at", new Date().toISOString());
    bad.set("amount", "499.00");
    bad.set("screenshot", new Blob([Buffer.from("<html>not an image</html>")], { type: "image/png" }), "x.png");
    const rejected = await submitRoute.POST(req(`/api/v1/billing/payment-requests/${pr.id}/submit`, "buyer", bad), id(pr.id));
    expect(rejected.status).toBe(415);

    const form = new FormData();
    form.set("transaction_reference", "4309 5555 5555");
    form.set("paid_at", new Date().toISOString());
    form.set("amount", "499.00");
    form.set("screenshot", new Blob([PNG], { type: "image/png" }), "upi.png");
    const ok = await submitRoute.POST(req(`/api/v1/billing/payment-requests/${pr.id}/submit`, "buyer", form), id(pr.id));
    expect(ok.status).toBe(200);
    const body = (await json(ok)).data;
    expect(body.status).toBe("SUBMITTED_FOR_VERIFICATION");
    expect(body.message).toBe("Payment details submitted. Your subscription will be activated after verification.");
    expect((await json(await subscriptionRoute.GET(req("/api/v1/billing/subscription", "buyer"), none))).data.plan_code).toBe("free");
    expect((await cancelRoute.POST(req(`/api/v1/billing/payment-requests/${pr.id}/cancel`, "buyer", {}), id(pr.id))).status).toBe(409);
  });

  it("rate-limits payment creation", async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await requestsRoute.POST(req("/api/v1/billing/payment-requests", "other", { plan_code: "pro_monthly" }), none)).status;
    expect(last).toBe(429);
  });
});

describe("admin payment routes", () => {
  it("are closed to non-administrators", async () => {
    expect((await adminList.GET(req("/api/v1/admin/payments", "buyer"), none)).status).toBe(403);
    expect((await adminList.GET(req("/api/v1/admin/payments", null), none)).status).toBe(401);
    const list = (await json(await adminList.GET(req("/api/v1/admin/payments?status=SUBMITTED_FOR_VERIFICATION", "admin"), none))).data;
    const target = list.items[0].id as string;
    expect((await adminVerify.POST(req(`/api/v1/admin/payments/${target}/verify`, "buyer", { confirmed_independent_check: true, verification_notes: "self-verified", verified_amount: "499.00" }), id(target))).status).toBe(403);
    expect((await adminScreenshot.GET(req(`/api/v1/admin/payments/${target}/screenshots/${crypto.randomUUID()}`, "buyer"), { params: Promise.resolve({ id: target, screenshotId: crypto.randomUUID() }) })).status).toBe(403);
  });

  it("reviews, serves the private screenshot, verifies once and activates", async () => {
    const list = (await json(await adminList.GET(req("/api/v1/admin/payments?customer=route-buyer", "admin"), none))).data;
    const target = list.items[0].id as string;
    expect((await adminReview.POST(req(`/api/v1/admin/payments/${target}/review`, "admin", {}), id(target))).status).toBe(200);
    const detail = (await json(await adminDetail.GET(req(`/api/v1/admin/payments/${target}`, "admin"), id(target)))).data;
    expect(detail.status).toBe("UNDER_REVIEW");
    const shotId = detail.submissions[0].screenshot_id as string;
    const shot = await adminScreenshot.GET(req(`/api/v1/admin/payments/${target}/screenshots/${shotId}`, "admin"), { params: Promise.resolve({ id: target, screenshotId: shotId }) });
    expect(shot.headers.get("content-type")).toBe("image/png");
    expect(shot.headers.get("cache-control")).toBe("private, no-store");

    const missingConfirm = await adminVerify.POST(req(`/api/v1/admin/payments/${target}/verify`, "admin", { verification_notes: "Statement 31 Oct", verified_amount: "499.00" }), id(target));
    expect(missingConfirm.status).toBe(400);
    const verified = await adminVerify.POST(req(`/api/v1/admin/payments/${target}/verify`, "admin", { confirmed_independent_check: true, verification_notes: "HDFC statement 31 Oct, UTR 430955555555", verified_amount: "499.00" }), id(target));
    expect(verified.status).toBe(200);
    expect((await json(verified)).data).toMatchObject({ status: "VERIFIED", already_verified: false });
    const again = await adminVerify.POST(req(`/api/v1/admin/payments/${target}/verify`, "admin", { confirmed_independent_check: true, verification_notes: "HDFC statement 31 Oct, UTR 430955555555", verified_amount: "499.00" }), id(target));
    expect((await json(again)).data.already_verified).toBe(true);
    // The real session reloads the user each request; mirror that for the double.
    const fresh = await t.db.query.appUsers.findFirst({ where: (u, { eq }) => eq(u.id, users.buyer!.id) });
    holder.users.set("buyer", current(fresh!));
    const sub = (await json(await subscriptionRoute.GET(req("/api/v1/billing/subscription", "buyer"), none))).data;
    expect(sub).toMatchObject({ plan_code: "pro", subscription: { billing_provider: "upi", status: "active", renews_automatically: false } });
    expect((await adminReject.POST(req(`/api/v1/admin/payments/${target}/reject`, "admin", { reason: "Too late to reject now." }), id(target))).status).toBe(409);
  });
});
