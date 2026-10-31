/**
 * UPI payments maintenance — run every 15–60 minutes from cron or a scheduler:
 *
 *   npm run payments:maintenance
 *
 * Expires stale payment requests and lapsed UPI subscriptions (downgrading to
 * Free), queues expiry reminders, deletes screenshots past the retention
 * window, and delivers or retries queued notification emails.
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

async function main() {
  const [{ db, pool }, { env }, { sendEmail }, { runPaymentMaintenance }, { dispatchDueNotifications }] = await Promise.all([
    import("../src/lib/db/client"),
    import("../src/lib/env"),
    import("../src/lib/email"),
    import("../src/lib/services/payments"),
    import("../src/lib/services/notifications"),
  ]);
  const summary = await runPaymentMaintenance(db, { screenshotRetentionDays: env.PAYMENT_SCREENSHOT_RETENTION_DAYS });
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < 25; i++) {
    const r = await dispatchDueNotifications(db, sendEmail, { appUrl: env.APP_URL, limit: 50 });
    sent += r.sent;
    failed += r.failed;
    if (r.sent + r.failed === 0) break;
  }
  console.log(JSON.stringify({ ...summary, notificationsSent: sent, notificationsFailed: failed }));
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
