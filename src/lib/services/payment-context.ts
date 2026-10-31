import "server-only";

import { db } from "@/lib/db/client";
import { sendEmail } from "@/lib/email";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

import { dispatchDueNotifications } from "./notifications";
import type { UpiConfig } from "./payments";

/** Server-side UPI configuration (never sent to the client except the payee shown on the payment page). */
export function upiConfig(): UpiConfig {
  return { vpa: env.UPI_VPA, payeeName: env.UPI_PAYEE_NAME, requestTtlHours: env.UPI_REQUEST_TTL_HOURS };
}

/**
 * Deliver queued notifications after the state change has committed. Failures
 * stay in the outbox for the maintenance job to retry; they never affect the
 * request that triggered them.
 */
export function dispatchNotificationsSoon(): void {
  void dispatchDueNotifications(db, sendEmail, { appUrl: env.APP_URL }).catch((error) => logger.warn("notification dispatch failed", { message: (error as Error).message }));
}
