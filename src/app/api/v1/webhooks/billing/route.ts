import { ok, withApi } from "@/lib/api/handler";
import { db } from "@/lib/db/client";
import { processBillingEvent, verifyWebhook } from "@/lib/services/billing";

/**
 * POST /api/v1/webhooks/billing — signed Stripe events (§12 Billing webhooks).
 * No session, no CSRF check: authenticity comes from the signature; replays are
 * de-duplicated by provider event ID.
 */
export const POST = withApi({ auth: "none", csrf: false }, async ({ request, log }) => {
  const rawBody = await request.text();
  const event = verifyWebhook(rawBody, request.headers.get("stripe-signature"));
  const outcome = await processBillingEvent(db, event);
  log.info("billing webhook", { event_type: event.type, outcome });
  return ok({ received: true, outcome });
});
