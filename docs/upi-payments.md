# UPI payments with manual verification

Indian users can buy Pro by paying the business UPI ID (scan a QR code or copy
the UPI ID). They then submit their transaction reference. An administrator
checks the payment against the business's bank statement or UPI merchant app
and verifies it, and only that verification activates the subscription.

No payment gateway is involved. PromptIQ never sees UPI PINs, OTPs or bank
credentials.

> **Principle:** no payment counts as successful until an authorised
> administrator has independently verified it. Screenshots, transaction IDs,
> redirects and anything the browser sends are claims, not proof.

## How it fits the existing billing

- **Entitlements:** unchanged. `app_users.plan_code` (`free`/`pro`) and the
  one-per-user `subscriptions` row drive every limit through `planFor()`.
  Verification sets `plan_code = 'pro'` and a `subscriptions` row with
  `billing_provider = 'upi'`, `status = 'active'` and the paid period.
- **Stripe:** card checkout stays as it was, enabled only when `STRIPE_*` is
  configured. A user with an active card subscription cannot start a UPI
  payment. Card checkout is refused while a UPI period is active, and an
  administrator cannot verify a UPI payment for a user who has an active card
  subscription. Nobody is charged twice.
- **Expiry:** UPI periods do not renew automatically. When the period ends the
  user is moved to Free. This happens on their next request (checked in
  `getCurrentUserFromHeaders`) and in the maintenance job.

## User flow

1. **Billing and payments** (`/app/billing`) shows:
   - the current plan, subscription status and period;
   - amounts paid and pending;
   - plans with INR prices from the `billing_plans` table;
   - the payment history, with an action that fits each status.

   It is linked from the sidebar, from Usage and plan, and from the landing
   page pricing section.
2. **Choose plan** sends only the plan code. The server loads the price, creates
   a request with a reference like `PIQ-2026-7KQ3M`, snapshots the amount and
   payee, and sets `PENDING_PAYMENT` with an expiry (48 hours by default).
   - Choosing the same plan again returns the open request.
   - A different plan has to wait until the open request is cancelled or
     decided (at most one open request per user, enforced by a unique index).
3. **The payment page** (`/app/billing/pay/{id}`) shows:
   - the exact amount;
   - the payee name and UPI ID, with a copy button;
   - the payment reference, with a copy button;
   - a QR code of the `upi://pay` link, rendered locally to SVG with the
     `qrcode` package;
   - an "Open in a UPI app" link on phones;
   - instructions, and a clear notice that activation is manual and not
     instant.
4. **I have paid** opens a form for:
   - the transaction ID / UTR (required);
   - the date and time of payment (required);
   - the amount, pre-filled (a different amount is accepted but flagged for
     review);
   - an optional screenshot (PNG, JPEG or WebP, up to 2 MB, checked by its
     content);
   - optional notes.

   Status becomes `SUBMITTED_FOR_VERIFICATION`, and the user sees "Payment
   details submitted. Your subscription will be activated after verification."
   Nothing is granted.
5. If the administrator asks for more information, the message appears on the
   payment page and the user can resubmit.

## Statuses

| Status | Meaning | Who can move it |
| --- | --- | --- |
| `PENDING_PAYMENT` | Created, nothing submitted | User submits or cancels; the system expires it |
| `SUBMITTED_FOR_VERIFICATION` | Details submitted | Admin reviews, verifies or rejects |
| `UNDER_REVIEW` | Admin checking, or waiting for more information | Admin verifies or rejects; user resubmits if information was requested |
| `VERIFIED` | Admin confirmed the payment; subscription active | Final |
| `REJECTED` | Could not be verified; reason shown to the user | Final (user starts a new request) |
| `CANCELLED` / `EXPIRED` | Abandoned | Admin only, via an explicit, audited **recovery** verification |

Transitions are validated on the server (`src/lib/payments/upi.ts#TRANSITIONS`)
under a row lock.

## Administrator flow

Administrators are the accounts listed in `ADMIN_EMAILS`. They see **Operator →
Payments** in the sidebar. Every page and API call re-checks admin rights on the
server.

- **List** (`/admin/payments`):
  - defaults to payments that need review;
  - quick filters for awaiting payment, verified, rejected and all;
  - search by customer, email, payment reference or UTR;
  - filters for plan and date range;
  - pagination;
  - columns for expected and submitted amounts (with a mismatch flag) and the
    assigned administrator.
- **Detail** (`/admin/payments/{id}`):
  - the customer's claim, including the screenshot (served privately with
    `no-store`);
  - account and current subscription;
  - review history;
  - the customer's other payments.
- **Actions:**
  - **Mark under review**: assigns you.
  - **Verify payment**: a dialog where you must:
    - tick "I independently checked this transaction against the business bank
      statement or UPI merchant app";
    - type the amount you see in the bank record (it is not pre-filled);
    - write the verification evidence;
    - explain any amount difference;
    - for expired or cancelled requests, give a recovery reason and the UTR from
      the bank record.
  - **Reject payment**: a reason (shown to the customer) is required.
  - **Request more information**: a message the customer sees.

### What verification does (one transaction)

`verifyPayment` in `src/lib/services/payments.ts` runs these steps inside one
transaction:

1. Lock the payment request (`SELECT … FOR UPDATE`) and expire it if it is
   stale.
2. Re-check administrator rights, the independent-check confirmation and the
   evidence.
3. Check the status is eligible. If it is already `VERIFIED`, return without
   changing anything (idempotent).
4. Check the transaction reference is not attached to any other request.
5. Check the verified amount equals the expected amount, or that a documented
   resolution was given.
6. Lock the subscription row and apply the renewal policy:
   - **Active UPI period:** the new period starts when the current one ends
     (renewal; no paid days are lost and nothing is replaced).
   - **Otherwise:** it starts now.
   - **Active card subscription:** refused.
7. Write the subscription (`billing_provider = 'upi'`), set `plan_code`, mark
   the request `VERIFIED`, append a `payment_reviews` row and a
   `subscription_events` row, and queue the notification.
8. Commit. Any failure rolls everything back.

A unique index allows only one `activated` or `renewed` event per payment
request. A concurrent second verification therefore fails inside its own
transaction and is reported as "already verified", so no duplicate subscription
or double extension is possible.

## Data model (migration `0006_upi_payments.sql`)

| Table | Purpose |
| --- | --- |
| `billing_plans` | Plan catalogue. Code, entitlement (`pro`), name, `amount_minor` (paise), INR, billing period, months, active flag. Seeded with `pro_monthly` ₹499 and `pro_yearly` ₹4,990. |
| `payment_requests` | The request: reference (unique), expected amount and payee snapshot, status, normalised transaction reference, mismatch and information flags, rejection reason, assigned admin, verified amount, timestamps. |
| `payment_submissions` | Every claim the user made: raw and normalised reference, amount, paid time, screenshot, notes. |
| `payment_screenshots` | Private image storage (`bytea`, content-sniffed type, size, SHA-256). Never in a public directory. |
| `payment_reviews` | Administrator actions. Append-only (a trigger blocks UPDATE and DELETE). |
| `subscription_events` | `activated`, `renewed`, `expired`, `expiry_reminder_sent`. Append-only; one activation per request. |
| `notification_outbox` | Emails written in the same transaction as the change, delivered after commit, retried with backoff. |
| `api_usage_records`, `subscriptions`, `app_users` | Unchanged apart from the values above. |

Constraints:

- **Money:** always integer paise.
- **Transaction references:** normalised (upper-case letters and digits only)
  and unique across all requests, including rejected ones, so a UTR can never be
  reused.
- **Row-level security:** policies follow the existing pattern.

To change prices, run SQL like the example below. Open requests keep the price
they were created with.

```sql
UPDATE billing_plans SET amount_minor = 59900, updated_at = now() WHERE code = 'pro_monthly';
UPDATE billing_plans SET active = false WHERE code = 'pro_yearly';   -- hide a plan
```

## API

All routes use the standard envelope, validation and CSRF origin checks. Rate
limits are listed with each route.

User endpoints, which require a session and are scoped to the owner (another
user's request returns `404`):

| Endpoint | Notes |
| --- | --- |
| `GET /api/v1/billing/plans` | Public. Prices come from the database. |
| `POST /api/v1/billing/payment-requests` | Body `{ "plan_code": "pro_monthly" }` only; unknown keys → `400`. Returns `201`, or `200` for the existing open request. 10/hour. |
| `GET /api/v1/billing/payment-requests` | The caller's requests. |
| `GET /api/v1/billing/payment-requests/{id}` | Includes `upi_uri` and `qr_svg` while payable. |
| `POST /api/v1/billing/payment-requests/{id}/submit` | Multipart (`transaction_reference`, `paid_at`, `amount`, `notes`, `screenshot`) or JSON. 10/hour. Errors: `409 DUPLICATE_TRANSACTION`, `409 INVALID_TRANSITION`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`. |
| `POST /api/v1/billing/payment-requests/{id}/cancel` | Only before submission. |
| `GET /api/v1/billing/subscription` | Plan, period, provider and audit events. |

Admin endpoints (`401` when not signed in, `403` when not an administrator; 60
per minute):

| Endpoint | Body |
| --- | --- |
| `GET /api/v1/admin/payments` | `?status=A,B&plan=&customer=&from=YYYY-MM-DD&to=&page=&page_size=` |
| `GET /api/v1/admin/payments/{id}` | |
| `GET /api/v1/admin/payments/{id}/screenshots/{screenshotId}` | Image, `Cache-Control: private, no-store` |
| `POST /api/v1/admin/payments/{id}/review` | `{}` |
| `POST /api/v1/admin/payments/{id}/verify` | `confirmed_independent_check: true`, `verification_notes`, `verified_amount`, `discrepancy_resolution?`, `recovery_reason?`, `transaction_reference?` (recovery only) |
| `POST /api/v1/admin/payments/{id}/reject` | `reason` (10–1,000 characters) |
| `POST /api/v1/admin/payments/{id}/request-information` | `message` (10–1,000 characters) |

## Notifications

The existing email service sends these, through the outbox:

- request created;
- details submitted;
- verification started;
- payment verified and Pro active (with dates);
- payment rejected (with the reason);
- more information requested;
- Pro ending soon (one reminder per period, 5 days before the end, sent by the
  maintenance job).

Emails are queued in the same transaction and sent after commit. A failed send
is retried with exponential backoff, up to 8 attempts, and never affects the
payment or subscription. Without `RESEND_API_KEY`, development prints messages
to the server log.

## Maintenance job

Run every 15–60 minutes from cron or a platform scheduler:

```bash
npm run payments:maintenance
```

It does the following:

- expires unpaid requests past their expiry;
- downgrades lapsed UPI subscriptions;
- queues expiry reminders;
- deletes screenshots of decided requests older than
  `PAYMENT_SCREENSHOT_RETENTION_DAYS`;
- delivers and retries queued emails;
- prints a JSON summary.

The job is safe to run concurrently and repeatedly.

## Configuration

```
UPI_VPA=yourbusiness@okaxis      # required to enable UPI payments; validated as name@bank
UPI_PAYEE_NAME=PromptIQ          # shown to users and in the QR; letters, digits, spaces, . & ' -
UPI_REQUEST_TTL_HOURS=48         # unpaid requests expire after this
PAYMENT_SCREENSHOT_RETENTION_DAYS=180
ADMIN_EMAILS=you@company.com     # who can verify payments
RESEND_API_KEY=… / EMAIL_FROM=…  # notification email (existing settings)
```

Invalid values stop the app at start-up with a clear message. With `UPI_VPA`
blank, plans are shown with "UPI payments are not enabled" and request creation
returns `503 BILLING_UNAVAILABLE`.

## Deployment

1. Set the variables above. Use the UPI ID of an account whose statements your
   administrators can see.
2. Run `npm run db:migrate` to apply `0006_upi_payments.sql`.
3. Run `npm run build` and deploy as before.
4. Schedule `npm run payments:maintenance`.
5. Check the seeded prices and adjust them with SQL if needed.
6. Write down your verification procedure: which account and which app to
   check, and what evidence to record.

## Security notes

- **Prices and payee:** the server takes only the plan code. Price, UPI ID and
  reference are set on the server and snapshotted on the request. The client
  never sends a status.
- **Admin rights:** checked on the server for every page and action. Every
  administrative action is written to the append-only `payment_reviews`.
- **Uploads:**
  - limited by size (checked by `Content-Length` and again after reading);
  - checked by magic bytes;
  - stored in the database, never on disk;
  - served only to administrators, with `nosniff`, a strict CSP and `no-store`;
  - deleted after the retention window.
- **Replay and duplicates:**
  - verification is idempotent and serialised by row locks;
  - one activation per request is enforced by a unique index;
  - each UTR can be used only once;
  - at most one open request per user.
- **Logging:** logs carry only IDs and actions, never screenshots or full
  payment details.

## Tests

- **Unit** (`tests/unit/payments.test.ts`, 11):
  - paise formatting and parsing;
  - UPI link encoding and validation;
  - references and transaction-reference validation;
  - the state machine;
  - month arithmetic;
  - screenshot sniffing;
  - email templates.
- **Database** (`tests/db/payments.test.ts`, 21, PGlite with the real
  migrations), covering all 17 cases in the spec. Verification uses a mocked
  bank statement; no real payments are made.
- **API** (`tests/api/payments-routes.test.ts`, 6):
  - authentication;
  - server-side price (tampered fields rejected);
  - ownership;
  - admin-only routes;
  - multipart upload, including a fake image rejected with 415;
  - rate limiting;
  - idempotent verification.
- **Component** (`tests/components/payment-flow.test.tsx`, 3).
- **End-to-end:** the full customer-and-administrator flow, on desktop and
  mobile. Set `E2E_ADMIN_EMAIL` and `E2E_ADMIN_PASSWORD` to an account listed in
  `ADMIN_EMAILS`; without them the test is skipped.

## Limitations

- **Manual verification:** activation speed depends on how often administrators
  check payments. There is no bank-statement import or reconciliation yet.
- **UPI app behaviour:** some apps ignore the amount or note in a QR code, which
  is why the page shows every value for manual entry and the admin compares
  amounts.
- **Refunds:** these happen outside PromptIQ. Record them in the review notes
  and reject or adjust as needed.
- **Mid-period upgrades:** there is only one paid plan (Pro), so there is no
  proration. Renewals extend from the current end date.
