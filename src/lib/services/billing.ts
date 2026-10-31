import "server-only";

import { eq } from "drizzle-orm";
import Stripe from "stripe";

import { AppError } from "@/lib/api/errors";
import { appUsers, subscriptions, webhookEvents, type AppUser, type SubscriptionStatus } from "@/lib/db/schema";
import type { Db, DbOrTx } from "@/lib/db/types";
import { env, features } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Billing adapter (FR-015, §8.2). Stripe-hosted Checkout and Customer Portal;
 * subscription state is written only from verified, idempotently processed
 * webhook events — never from the browser.
 */
let stripeClient: Stripe | null = null;

export function getStripe(): Stripe {
  if (!features.billing || !env.STRIPE_SECRET_KEY) {
    throw new AppError("BILLING_UNAVAILABLE", "Billing is not configured for this deployment.");
  }
  if (!stripeClient) stripeClient = new Stripe(env.STRIPE_SECRET_KEY);
  return stripeClient;
}

export async function createCheckoutSession(db: DbOrTx, user: AppUser): Promise<{ url: string }> {
  const current = await db.query.subscriptions.findFirst({ where: eq(subscriptions.userId, user.id) });
  if (current?.billingProvider === "upi" && current.status === "active" && current.currentPeriodEnd && current.currentPeriodEnd > new Date()) {
    throw new AppError("CONFLICT", "You already have Pro until the end of your UPI-paid period. Renew with UPI, or switch to a card subscription after it ends.");
  }
  const stripe = getStripe();
  if (user.planCode === "pro") {
    throw new AppError("CONFLICT", "You already have an active Pro subscription.");
  }
  const existing = await db.query.subscriptions.findFirst({ where: eq(subscriptions.userId, user.id) });

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: env.STRIPE_PRICE_PRO_MONTHLY as string, quantity: 1 }],
    client_reference_id: user.id,
    ...(existing?.providerCustomerId ? { customer: existing.providerCustomerId } : user.email ? { customer_email: user.email } : {}),
    success_url: `${env.APP_URL}/app/usage?checkout=success`,
    cancel_url: `${env.APP_URL}/app/usage?checkout=cancelled`,
    allow_promotion_codes: true,
    metadata: { app_user_id: user.id },
    subscription_data: { metadata: { app_user_id: user.id } },
  });
  if (!session.url) throw new AppError("BILLING_UNAVAILABLE", "Could not start checkout. Please try again.");
  return { url: session.url };
}

export async function createPortalSession(db: DbOrTx, user: AppUser): Promise<{ url: string }> {
  const stripe = getStripe();
  const sub = await db.query.subscriptions.findFirst({ where: eq(subscriptions.userId, user.id) });
  if (!sub?.providerCustomerId) {
    throw new AppError("NOT_FOUND", "No billing account found for this user.");
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: sub.providerCustomerId,
    return_url: `${env.APP_URL}/app/usage`,
  });
  return { url: session.url };
}

export function verifyWebhook(rawBody: string, signature: string | null): Stripe.Event {
  const stripe = getStripe();
  if (!signature || !env.STRIPE_WEBHOOK_SECRET) {
    throw new AppError("VALIDATION_ERROR", "Missing webhook signature.");
  }
  try {
    return stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    throw new AppError("VALIDATION_ERROR", "Invalid webhook signature.", { cause: error });
  }
}

function mapStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  switch (status) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "incomplete":
      return "incomplete";
    case "canceled":
    case "incomplete_expired":
    case "paused":
      return "canceled";
    default:
      return "none";
  }
}

const ENTITLED: SubscriptionStatus[] = ["active", "trialing", "past_due"];

function periodFromSubscription(sub: Stripe.Subscription): { start: Date | null; end: Date | null } {
  const item = sub.items.data[0];
  const start = item?.current_period_start;
  const end = item?.current_period_end;
  return {
    start: typeof start === "number" ? new Date(start * 1000) : null,
    end: typeof end === "number" ? new Date(end * 1000) : null,
  };
}

/** Apply a Stripe subscription object to our subscription + plan state. */
export async function applySubscription(db: DbOrTx, appUserId: string, sub: Stripe.Subscription): Promise<void> {
  const status = mapStatus(sub.status);
  const period = periodFromSubscription(sub);
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;

  await db
    .insert(subscriptions)
    .values({
      userId: appUserId,
      billingProvider: "stripe",
      providerCustomerId: customerId,
      providerSubscriptionId: sub.id,
      status,
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: subscriptions.userId,
      set: {
        providerCustomerId: customerId,
        providerSubscriptionId: sub.id,
        status,
        currentPeriodStart: period.start,
        currentPeriodEnd: period.end,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        updatedAt: new Date(),
      },
    });

  await db
    .update(appUsers)
    .set({ planCode: ENTITLED.includes(status) ? "pro" : "free", updatedAt: new Date() })
    .where(eq(appUsers.id, appUserId));
}

async function resolveAppUserId(db: DbOrTx, sub: Stripe.Subscription, fallback?: string | null): Promise<string | null> {
  const fromMetadata = sub.metadata?.["app_user_id"];
  if (fromMetadata) return fromMetadata;
  if (fallback) return fallback;
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const row = await db.query.subscriptions.findFirst({ where: eq(subscriptions.providerCustomerId, customerId) });
  return row?.userId ?? null;
}

/**
 * Idempotent webhook processing (§12 Billing webhooks): each provider event ID
 * is stored once; replays are acknowledged without re-applying.
 */
export async function processBillingEvent(db: Db, event: Stripe.Event): Promise<"processed" | "duplicate" | "ignored"> {
  const inserted = await db
    .insert(webhookEvents)
    .values({ provider: "stripe", providerEventId: event.id, eventType: event.type })
    .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.providerEventId] })
    .returning({ id: webhookEvents.id });
  const record = inserted[0];
  if (!record) return "duplicate";

  try {
    let outcome: "processed" | "ignored" = "ignored";
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.mode === "subscription" && session.subscription) {
          const stripe = getStripe();
          const subId = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
          const sub = await stripe.subscriptions.retrieve(subId);
          const appUserId = await resolveAppUserId(db, sub, session.client_reference_id ?? session.metadata?.["app_user_id"]);
          if (appUserId) {
            await applySubscription(db, appUserId, sub);
            outcome = "processed";
          }
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const appUserId = await resolveAppUserId(db, sub);
        if (appUserId) {
          await applySubscription(db, appUserId, sub);
          outcome = "processed";
        }
        break;
      }
      default:
        outcome = "ignored";
    }
    await db
      .update(webhookEvents)
      .set({ processingStatus: "processed", processedAt: new Date() })
      .where(eq(webhookEvents.id, record.id));
    return outcome;
  } catch (error) {
    logger.error("billing webhook processing failed", { event_type: event.type, message: (error as Error).message });
    await db
      .update(webhookEvents)
      .set({ processingStatus: "failed", errorCode: (error as Error).message.slice(0, 120) })
      .where(eq(webhookEvents.id, record.id));
    throw error;
  }
}

export async function getSubscription(db: DbOrTx, userId: string) {
  return (await db.query.subscriptions.findFirst({ where: eq(subscriptions.userId, userId) })) ?? null;
}
