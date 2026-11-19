# Fieldnote Billing Slice

## 1. What This Is

This is a working subscription billing system for a note-taking app called Fieldnote. It sells one paid plan, Pro, at ₦5,000 a month or ₦50,000 a year, and takes payments through Flutterwave in test mode. A customer can subscribe by card or bank transfer. They can switch from monthly to yearly mid-cycle and pay only the difference, or cancel and keep Pro until the end of the period they paid for. Card subscriptions renew automatically, and bank-transfer subscriptions renew by paying again. Pro is only granted after the server has confirmed the payment with Flutterwave, never on the strength of a redirect or a webhook alone. Every stage of every payment is recorded. Webhooks are signature-checked and acted on only once, money is held in whole kobo, starting a checkout is rate limited, and no card details are kept. It is a Next.js app with a local SQLite database, and has five screens: Plans, Checkout, the payment return page, Billing, and the app shell around them.

Several things are deliberately left out, because the slice is about getting the payment path right rather than building a whole product.
- **Sign-in:** there is a single built-in user, because accounts are a separate problem.
- **The product itself:** the notebooks Pro unlocks are described, not built.
- **Refunds and tax.**
- **Customer emails.**
- **Other currencies:** prices are in naira only.
- **An admin screen:** records are read straight from the database.
- **Prorated yearly-to-monthly switches:** that switch waits for the paid year to end, so nothing ever has to be refunded.
- **Flutterwave's own recurring plans:** the app charges the saved card itself, so that renewal timing and plan changes stay under its control.
- **Live keys and production hosting:** the scheduled billing run is triggered by hand from Test tools, or by calling an endpoint.

## 2. How To Run It

Setup takes about ten minutes from a fresh clone. A free Flutterwave account in test mode is needed. Nothing real is charged.

1. **Install the tools.**
   - [Node.js](https://nodejs.org) 20.19+, 22.12+ or 24+, which includes npm. That's the minimum Prisma 7 accepts. The slice was built and tested on Node 24.
   - Git.
   - Nothing else: the database is SQLite, a single file the app creates itself.
   - Optional: numbers are designed to render in Neue Haas Grotesk Text. The font files aren't in the repository because they're licensed. With a licence, place `NeueHaasGrotText-55Roman-Trial.otf`, `-65Medium-Trial.otf` and `-75Bold-Trial.otf` in `public/fonts/`, or rename the paths in `app/globals.css`. Without them, numbers render in Geist.

2. **Clone the repository and install the dependencies.**
   ```bash
   git clone <repository-url> fieldnote-billing
   cd fieldnote-billing
   npm install
   ```
   `npm install` also generates the database client (`prisma generate` runs automatically after it).

3. **Create the environment file.**
   ```bash
   cp .env.example .env.local
   ```
   `.env.local` is git-ignored. Fill it in using the table below. Only `FLW_SECRET_KEY` has to be changed. Everything else works as it is for a local run.

   | Variable | Needed? | Where it comes from |
   |---|---|---|
   | `FLW_SECRET_KEY` | **Required** | Flutterwave dashboard, with the **Test mode** toggle on, then **Settings → API Keys → Secret key**. It starts with `FLWSECK_TEST-`, and the app refuses live keys. |
   | `DATABASE_URL` | Required (preset) | Already set in `.env.example` to `file:./data/fieldnote.db`. Leave it. |
   | `APP_URL` | Preset | Where Flutterwave sends the customer back after paying. Leave it as `http://localhost:3000`, or the tunnel URL when webhooks are set up (step 7). |
   | `DEMO_USER_NAME`, `DEMO_USER_EMAIL` | Preset | The single built-in user. Any name and email will do. |
   | `FLW_WEBHOOK_SECRET_HASH` | Optional | Any long random string (for example from `openssl rand -base64 32`). Paste the same value into **Flutterwave → Settings → Webhooks → Secret hash**. Without it, the webhook endpoint refuses everything. Payments still confirm on the return page. |
   | `CRON_SECRET` | Optional | Any long random string. It protects `POST /api/billing/run`, the scheduled billing run. Without it that endpoint is off, and **Test tools → Skip to period end** still works. |
   | `FLW_CHARGE_REDIRECT_URL` | Optional | A public https URL used if a bank asks the customer to authenticate a saved-card charge. Leave it unset locally. |
   | `ENABLE_DEMO_RESET` | Optional | Set to `true` to keep Test tools in a production build. It's on automatically in development. |

4. **Create the database.**
   ```bash
   npm run db:deploy
   ```
   This applies every migration in `prisma/migrations` and creates `data/fieldnote.db`. It's safe to run again later. The built-in user is added the first time a page loads.

5. **Start the app.**
   ```bash
   npm run dev
   ```

6. **Open it.**
   - Go to **<http://localhost:3000>**. It opens on Billing.
   - Go to **Plans → Choose monthly → Pay**. This opens Flutterwave's test checkout.
   - Pay with one of Flutterwave's test cards, from their *Testing* docs. A commonly used one:
     - card `5531 8866 5214 2950`
     - expiry `09/32`
     - CVV `564`
     - PIN `3310`
     - OTP `12345`
   - Or choose bank transfer.
   - The browser returns to a receipt, and Billing shows Pro as active.

   The **Test tools** menu in the top bar can:
   - jump to the end of the billing period, to see renewals, scheduled switches and expiry;
   - trigger each error screen;
   - reset the account to start again.

7. **Optional: receive webhooks.** Flutterwave can't reach `localhost`, so open a tunnel:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
   Then:
   1. Copy the `https://….trycloudflare.com` address it prints.
   2. In **Flutterwave (test mode) → Settings → Webhooks**, set:
      - the URL to `https://<that-address>/api/webhooks/flutterwave`;
      - the secret hash to the value of `FLW_WEBHOOK_SECRET_HASH`.
   3. Set `APP_URL` to the tunnel address and restart `npm run dev`.
   4. Check it end to end with `npm run webhook:test`, which sends a signed test webhook.

   The tunnel address changes every time cloudflared restarts.

**If something goes wrong**
- **"FLW_SECRET_KEY is not set"** when Pay is clicked: `.env.local` is missing the key, or the dev server was started before it was added. Restart `npm run dev` after editing `.env.local`.
- **Port 3000 is taken:** Next picks the next free port and prints it. Use that URL and set `APP_URL` to match. If instead it says another Next server for this folder is already running, stop that one (or use it).
- **Pages fail right after a pull that changed `prisma/schema.prisma`:** run `npm run db:deploy`, then restart `npm run dev`.

## 3. The Flow, Step By Step

This follows one customer from choosing a plan to cancelling, in the order it happens. There are three kinds of code to know about before starting:

- **Pages** are server components under `app/`. They read the database while rendering, so "opening a page" never calls a separate API.
- **Buttons** submit forms to **server actions** in an `actions.ts` file next to the page. Each action runs on the server with only the form fields the browser sent.
- **The rules** live in `lib/billing.ts`. Database reads and writes live in `lib/store.ts`. Calls to Flutterwave live in `lib/flutterwave.ts`.

Each step below covers what the customer does, what the browser sends, and what the server does with it.

### 1. Looking at the plans

The customer opens **Plans**. The browser makes a plain page request for `/plans`. `app/(app)/plans/page.tsx` asks `getBillingState` in `lib/billing.ts` where this customer stands:

- **Free:** no current subscription.
- **Active, cancelling, renewal due or past due:** worked out from the subscription row and today's date. The clock decides when Pro ends: `currentPeriodEnd` passing is enough for the state to become "renewal due", and nothing has to run.

The page draws monthly and yearly with the right button for that state: Choose, Switch, Keep Pro, or Renew on Billing. Prices come from the catalogue in `lib/plans.ts`. They're stored as whole kobo (`lib/money.ts`) and only formatted as naira for display.

### 2. Opening checkout

The customer clicks **Choose monthly**. The browser requests `/checkout/pro_monthly`, and `app/(focus)/checkout/[plan]/page.tsx` handles it.

- An unknown plan in the URL redirects to `/plans` with a notice rather than a 404.
- For someone new, the page shows the price, the first renewal date and a **Pay ₦5,000** button.
- For an existing subscriber, the same URL shows a different screen: switching or keeping a plan (step 7).

Nothing is written to the database yet.

### 3. Pressing Pay

The customer clicks **Pay**. `CheckoutForm.tsx` submits one hidden field, `planId`, to the `startCheckout` action in `app/(focus)/checkout/actions.ts`. The browser sends no price. The server then:

1. Checks that `planId` is a real plan, then the rate limit (`lib/rate-limit.ts`): 5 attempts per user per 10 minutes and 10 per IP address. Both happen before anything is written or Flutterwave is called.
2. Re-reads the billing state, and refuses if the customer already has Pro.
3. Takes the price from `lib/plans.ts`.
4. Makes a fresh reference, `fn_pro_monthly_<uuid>`, called the `tx_ref`.
5. Calls `recordCheckout` in `lib/store.ts`. That writes a `checkouts` row and the first `payment_logs` row, stage `initiated`.
6. Asks Flutterwave for a hosted payment link: `createHostedPaymentLink`, which calls `POST /v3/payments`. Naira only appear here: `toMajorUnits` converts the kobo.
7. Redirects the browser to that link.

If any of this fails, the button shows an inline error instead. The action runs inside `guard` (`lib/action-guard.ts`), so an unexpected crash becomes a message too.

### 4. Paying on Flutterwave

The customer enters a card or chooses bank transfer on Flutterwave's own page. That page is outside this codebase, and no card details ever reach the app. When the payment completes, two things happen independently, in either order: Flutterwave redirects the browser back (step 5) and sends a webhook (step 5a).

### 5. Coming back: the payment is confirmed

The browser arrives at `/checkout/return?status=successful&tx_ref=…&transaction_id=…`.

1. `app/(focus)/checkout/return/loading.tsx` shows "Confirming your payment…" straight away.
2. `app/(focus)/checkout/return/page.tsx` calls `confirmCheckout(tx_ref)` in `lib/billing.ts`.
3. **Nothing in the URL is trusted.** `status` is used only to word a cancellation. `confirmCheckout` checks that the checkout belongs to this customer, then hands over to `verifyCheckout`.
4. `verifyCheckout` asks Flutterwave about the payment using the app's own reference: `verifyByReference`, which calls `GET /v3/transactions/verify_by_reference`. It then decides the result with `classify`. It's only a success if the status is successful **and** the amount and currency exactly match what was recorded at checkout, compared in kobo. Every check is logged as a `verified` row.
5. On success, `activateSubscription` in `lib/store.ts` does everything in one database transaction:
   - claims the checkout so it can only complete once;
   - creates the subscription;
   - saves the card token, brand and last 4 digits, and the payment method;
   - records the payment;
   - writes a `fulfilled` log row and a `subscription_started` event.
6. The page shows the receipt.

Refreshing the page is safe: an already completed checkout goes straight to the receipt. A pending, failed or cancelled payment, or one that can't be checked, gets its own screen with a way forward.

### 5a. The webhook arrives

Flutterwave posts to `/api/webhooks/flutterwave`, handled in `app/api/webhooks/flutterwave/route.ts`.

1. The route reads the body as raw text.
2. It checks the signature before anything else, in `lib/webhook-signature.ts`. It accepts either an HMAC of the body or the `verif-hash` header, compared in constant time. A bad signature gets a 401 and is never stored.
3. It parses the body and builds an idempotency key from Flutterwave's transaction ID (`parseWebhook` in `lib/webhooks.ts`).
4. It removes card and customer details (`redactWebhookPayload`).
5. It stores the event once (`recordWebhookEvent`). A repeat delivery only adds 1 to `deliveries`.
6. It replies 200, then processes the event after the response.

Processing first claims the event, so only one worker handles it. It then runs the **same** `verifyCheckout` as step 5, so a webhook can't grant anything the return page wouldn't. Whichever of the two arrives second finds the checkout already completed and does nothing.

### 6. Seeing it on Billing

The customer opens **Billing**, and `app/(app)/billing/page.tsx` reads three things:

- the billing state;
- the payments (`listPayments`);
- the payment log (`listPaymentLogs`).

It draws the current plan, the next payment and the payment method. The payment history has a step-by-step timeline per payment (`PaymentTimeline.tsx`) built from `payment_logs`.

### 7. Switching from monthly to yearly

**Now, prorated.**
- **The quote.** The Billing panel shows "Switch to yearly now for ₦X". Clicking **Review and switch** opens `/checkout/pro_yearly`. The checkout page calls `quoteSwitchNow`, which uses `quoteProration` in `lib/proration.ts`: the credit is the monthly price × days left ÷ days in the period, rounded down to the kobo, and the amount due is ₦50,000 minus that credit. The page shows the breakdown.
- **Confirming.** The customer clicks **Pay ₦X and switch**. The form sends `planId`, `quotedDue` (the amount they were shown, in kobo) and sometimes `via`, to the `switchNow` action.
- **The checks.** `switchIntervalNow` in `lib/billing.ts`:
  - **recalculates** the amount and refuses if it no longer matches `quotedDue`, so nobody pays an amount they didn't see;
  - refuses if a switch is already in progress;
  - applies a stricter limit to saved-card charges (3 per 10 minutes).
- **Paying.** There are two ways:
  - **Saved card:** `chargeCardToken` calls `POST /v3/tokenized-charges`, the payment is verified, and `recordPlanChangeCharge` switches the plan, but only if Flutterwave confirms the payment.
  - **No saved card, or the card failed and they chose "Pay on Flutterwave instead"** (`via=checkout`): a checkout is recorded with `purpose = plan_change` and the flow repeats steps 4–5. This time `verifyCheckout` calls `completePlanChangeCheckout` instead of starting a new subscription.

**At the end of the period.** The secondary button sends `planId` to `changePlan`. `schedulePlanChange` stores `pendingPlanId`, and nothing is charged until the period ends. Yearly → monthly always works this way.

### 8. Renewal

Nobody clicks anything for this. The **billing run**, `runBillingCycle` in `lib/billing.ts`, is started in one of two ways:
- by a scheduler calling `POST /api/billing/run` with `Authorization: Bearer <CRON_SECRET>` (`app/api/billing/run/route.ts`), which also retries any failed webhooks;
- locally, by **Test tools → Skip to period end** (`app/dev-actions.ts` → `advanceToPeriodEnd`).

For each subscription whose period has ended:
1. It builds a reference from the subscription and period, `fn_renew_<id>_<periodStart>`, so a period can't be charged twice.
2. It skips manual-renewal subscriptions: those paid by bank transfer, with no card token.
3. It charges the saved card and verifies the charge, retrying while Flutterwave reports it pending.
4. It records the result:
   - `applyRenewalSuccess` extends the period, on the scheduled plan if there is one;
   - `applyRenewalFailure` sets the subscription to `past_due`.

A charge Flutterwave leaves pending still renews Pro. Later runs, or a webhook, settle it (`settlePending`).

From the customer's side, once the period ends without a renewal, Billing shows **Renewal due**:
- **Card subscriptions** get **Renew now**, which sends no fields to `renewPlan` → `renewNow`, the same charge as the billing run.
- **Bank-transfer subscriptions** get **Renew**, which goes through checkout again (steps 3–5).

### 9. Cancelling

**Confirming.** **Cancel subscription** first opens a confirm box (`CancelControl.tsx`). Only the confirm button sends `confirm=cancel` to the `cancelSubscription` action in `app/(app)/billing/actions.ts`, and the server refuses without it. `markSubscriptionCancelled` in `lib/store.ts` sets the status to `cancelled` and leaves `currentPeriodEnd` alone, so Pro lasts to the end of the paid period. No more charges are made.

**The reason.** The action redirects to `/billing?cancelled=1`, which shows the optional "Mind telling us why?" prompt (`CancellationReasonPrompt.tsx`). Sending it posts `reason` and an optional `note` to `submitCancellationReason`. `saveCancellationReason` stores them on the subscription and logs an event. Skipping stores nothing.

**After cancelling.**
- **Keep Pro** (`resumePlan`) undoes the cancellation before the period ends.
- At the end of the period, the next billing run marks the subscription `expired` and the account is Free again.

### Following any behaviour into the code

| Looking for | Where it is |
|---|---|
| **What the customer sees** | the page under `app/` for that URL |
| **What a button does** | the `actions.ts` file next to that page, which calls into `lib/billing.ts` |
| **Why something is allowed or refused** | `lib/billing.ts` |
| **What gets written, and in which transaction** | `lib/store.ts` (each write also writes its log rows) |
| **What the app asks Flutterwave** | `lib/flutterwave.ts` |
| **Money arithmetic** | `lib/money.ts` |
| **Proration** | `lib/proration.ts` |
| **Webhooks** | `app/api/webhooks/flutterwave/route.ts`, `lib/webhook-signature.ts`, `lib/webhooks.ts` |
| **Limits** | `lib/rate-limit.ts` |
| **Error screens** | the `error.tsx` files and `lib/action-guard.ts` |

## 4. The Data Model

The schema is defined in `prisma/schema.prisma` and created by the migrations in `prisma/migrations/`. The DDL below is what's in the database (`data/fieldnote.db`), taken from `sqlite_master`. Four conventions run through every table:

- **Money** is always two columns: `amount_minor INTEGER` (whole kobo) and `currency TEXT` (an ISO code such as `NGN`). Integers can't round. A price of ₦4,999.50 is stored as `499950`, never `4999.5`. The currency travels with the amount, so two amounts can't be added or compared across currencies by mistake (`lib/money.ts` refuses to). Naira exist only at the Flutterwave boundary and in display.
- **Status columns are enums in `schema.prisma`.** SQLite has no enum type, so they are stored as `TEXT`. The Prisma client rejects any value outside the enum on write. The database itself doesn't, as covered at the end of this section.
- **Dates** are `DATETIME`, stored by Prisma as ISO-8601 text in UTC, for example `2026-11-19T08:01:24.000+00:00`. The one exception is `rate_limit_hits`, explained there.
- **Foreign keys are enforced.** The `better-sqlite3` driver turns SQLite's `foreign_keys` on for every connection.

How the tables relate: a **user** starts **checkouts**. A completed checkout creates exactly one **subscription**. Every charge, whether the first payment, a renewal or a plan change, is a **payment**. Every stage of every attempt is a row in **payment_logs**. Every change to a subscription is a row in **billing_events**. **webhook_events** and **rate_limit_hits** stand on their own.

---

### `users`: who is paying

```sql
CREATE TABLE "users" (
  "id"         TEXT     NOT NULL PRIMARY KEY,
  "name"       TEXT     NOT NULL,
  "email"      TEXT     NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
```

- **`id TEXT`**: the app's own ID, `user_demo` for the single built-in user. It's text rather than an auto-number, so a real sign-in system's IDs can drop in later.
- **`email` unique**: one account per address. This is the email the first checkout is opened with.

---

### `checkouts`: every attempt to pay through Flutterwave's hosted page

```sql
CREATE TABLE "checkouts" (
  "tx_ref"              TEXT     NOT NULL PRIMARY KEY,
  "user_id"             TEXT     NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "plan_id"             TEXT     NOT NULL,                       -- pro_monthly | pro_yearly
  "amount_minor"        INTEGER  NOT NULL,
  "currency"            TEXT     NOT NULL,
  "flutterwave_plan_id" INTEGER  NOT NULL,                       -- legacy, always 0
  "purpose"             TEXT     NOT NULL DEFAULT 'subscribe',   -- subscribe | plan_change
  "subscription_id"     INTEGER,
  "proration"           TEXT,
  "status"              TEXT     NOT NULL DEFAULT 'initiated',   -- initiated | completed | failed
  "created_at"          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at"        DATETIME
);
CREATE INDEX "checkouts_user_id_created_at_idx" ON "checkouts"("user_id", "created_at");
```

- **`tx_ref` as the primary key.** This is the reference sent to Flutterwave and later used to look the payment up. Making it the key means one reference can only ever mean one checkout. It's generated on the server (`fn_<plan>_<uuid>`), never taken from the browser.
- **`amount_minor` + `currency`, not null**: the exact amount this checkout must be paid for. Verification compares Flutterwave's answer against these columns, not against today's catalogue price. A checkout started before a price change is therefore still checked against the price the customer saw.
- **`status`, with an atomic claim.** Going from `initiated` to `completed` is an `UPDATE … WHERE status <> 'completed'`. Only one of the return page and the webhook can win it.
- **`completed_at`, nullable**: empty until it completes.
- **`purpose`, defaulting to `subscribe`.** The default meant the column could be added without touching existing rows. `plan_change` marks a prorated switch paid by checkout.
- **`subscription_id` and `proration`, nullable.** They only apply to `plan_change` checkouts. `proration` is the breakdown as JSON (credit, new price, due, days), kept as one value because it's always read and written whole.
- **`flutterwave_plan_id`, not null.** This is legacy from an earlier design that used Flutterwave's recurring plans. It's always `0` now. It's kept rather than dropped so old rows still load.

---

### `subscriptions`: the customer's plan and the period they've paid for

```sql
CREATE TABLE "subscriptions" (
  "id"                     INTEGER  NOT NULL PRIMARY KEY AUTOINCREMENT,
  "user_id"                TEXT     NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "plan_id"                TEXT     NOT NULL,
  "status"                 TEXT     NOT NULL,       -- active | cancelled | past_due | expired | replaced
  "billing_mode"           TEXT     NOT NULL DEFAULT 'app',   -- legacy, always app
  "amount_minor"           INTEGER  NOT NULL,
  "currency"               TEXT     NOT NULL,
  "started_at"             DATETIME NOT NULL,
  "current_period_start"   DATETIME NOT NULL,
  "current_period_end"     DATETIME NOT NULL,
  "pending_plan_id"        TEXT,
  "cancelled_at"           DATETIME,
  "flw_subscription_id"    INTEGER,                   -- legacy, unused
  "card_token"             TEXT,
  "customer_email"         TEXT,
  "card_brand"             TEXT,
  "card_last4"             TEXT,
  "payment_method"         TEXT,
  "tx_ref"                 TEXT     NOT NULL REFERENCES "checkouts"("tx_ref") ON DELETE RESTRICT,
  "cancellation_reason"    TEXT,
  "cancellation_note"      TEXT,
  "cancellation_reason_at" DATETIME,
  "created_at"             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             DATETIME NOT NULL
);
CREATE UNIQUE INDEX "subscriptions_tx_ref_key" ON "subscriptions"("tx_ref");
CREATE UNIQUE INDEX "subscriptions_one_current" ON "subscriptions"("user_id")
  WHERE "status" IN ('active', 'cancelled', 'past_due');
CREATE INDEX "subscriptions_user_id_status_idx" ON "subscriptions"("user_id", "status");
```

- **`status`** has five values.
  - `cancelled` means "no more charges, but Pro until the period ends". That's why it still counts as current.
  - `expired` is a cancelled subscription whose period has passed.
  - `replaced` is a subscription superseded by a new one, for example someone who lapsed and paid again.

  Old subscriptions are never deleted. Their status moves them out of "current".
- **`current_period_end`, not null.** It's the single fact that decides access. Pro lasts until exactly this moment. Only a payment Flutterwave has confirmed moves it forward. If it passes without one, the customer is "renewal due". That's worked out by comparing it with the clock, not stored, so nothing has to run for access to end on time.
- **`amount_minor` + `currency`**: what the next renewal on the current plan charges. This is the full plan price even after a prorated switch, because the discounted first charge lives on the payment.
- **`pending_plan_id`, nullable**: a switch scheduled for the end of the period. Empty means nothing is scheduled.
- **`cancelled_at`, nullable**: set when cancelled, cleared on resume. It's a timestamp rather than a flag because the cancellation-reason prompt is only offered within an hour of it.
- **`card_token`, nullable.** Flutterwave's reference to the saved card, which renewals charge. It's empty when the customer paid by bank transfer. That emptiness is the rule: no token means the subscription renews manually through checkout.
- **`customer_email`, nullable**: the email Flutterwave recorded on the payment. Token charges must use exactly that email, which can differ from ours in test mode.
- **`card_brand`, `card_last4`, `payment_method`, nullable**: for showing "Visa ending 4242" or "Bank transfer". There are no other card fields on purpose: see "No card details stored" in the README.
- **`tx_ref`, not null, unique, foreign key to `checkouts`.** Every subscription started from exactly one real checkout, and a checkout can start at most one subscription.
- **`cancellation_reason`, `cancellation_note`, `cancellation_reason_at`, nullable.** Empty means "didn't answer", which is an honest answer to an optional question. The reason is a code from a fixed list (`lib/cancellation.ts`). The note is free text capped at 500 characters.
- **`billing_mode`, `flw_subscription_id`**: legacy, from the earlier Flutterwave-plans design. They're always `app` and empty now, and kept so old rows still load.

---

### `payments`: every charge, paid or not

```sql
CREATE TABLE "payments" (
  "id"              INTEGER  NOT NULL PRIMARY KEY AUTOINCREMENT,
  "tx_ref"          TEXT     NOT NULL,
  "checkout_tx_ref" TEXT     REFERENCES "checkouts"("tx_ref") ON DELETE SET NULL,
  "transaction_id"  INTEGER,
  "user_id"         TEXT     NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "subscription_id" INTEGER  REFERENCES "subscriptions"("id") ON DELETE SET NULL,
  "kind"            TEXT     NOT NULL DEFAULT 'initial',    -- initial | renewal | plan_change
  "status"          TEXT     NOT NULL DEFAULT 'succeeded',  -- succeeded | pending | failed
  "plan_id"         TEXT     NOT NULL,
  "amount_minor"    INTEGER  NOT NULL,
  "currency"        TEXT     NOT NULL,
  "paid_at"         DATETIME NOT NULL,
  "failure_reason"  TEXT,
  "card_brand"      TEXT,
  "card_last4"      TEXT,
  "payment_method"  TEXT,
  "proration"       TEXT
);
CREATE UNIQUE INDEX "payments_tx_ref_key"          ON "payments"("tx_ref");
CREATE UNIQUE INDEX "payments_checkout_tx_ref_key" ON "payments"("checkout_tx_ref");
CREATE UNIQUE INDEX "payments_transaction_id_key"  ON "payments"("transaction_id");
CREATE INDEX "payments_user_id_paid_at_idx" ON "payments"("user_id", "paid_at");
```

- **`tx_ref` unique.** One reference, one charge. A renewal's reference is built from the subscription and its period (`fn_renew_<id>_<periodStart>`). That makes the unique index the thing that stops a period being charged twice, even if two billing runs overlap.
- **`checkout_tx_ref`, nullable, unique, foreign key.** It's set for payments made through checkout and empty for saved-card charges, which have no checkout. Unique means a checkout produces at most one payment.
- **`transaction_id`, nullable, unique.** This is Flutterwave's ID. It's nullable because a charge Flutterwave rejected outright never got one. Unique means one Flutterwave transaction can't be counted as paying for two things.
- **`subscription_id`, nullable, `ON DELETE SET NULL`.** A payment is a financial record, so it outlives the subscription it paid for.
- **`status`**: `pending` exists because Flutterwave can accept a charge without settling it. Those rows are re-checked by the billing run and by webhooks.
- **`paid_at`, not null**: when the charge was attempted, including declined ones, so the history can be ordered.
- **`failure_reason`, nullable**: set only when `status = failed`.
- **`proration`, nullable**: the breakdown for `plan_change` payments, so the history can show "₦50,000 − ₦4,833.33 unused monthly (29 of 30 days)".

---

### `payment_logs`: every stage of every payment attempt, append-only

```sql
CREATE TABLE "payment_logs" (
  "id"                      INTEGER  NOT NULL PRIMARY KEY AUTOINCREMENT,
  "tx_ref"                  TEXT     NOT NULL,
  "user_id"                 TEXT     NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "subscription_id"         INTEGER,
  "kind"                    TEXT     NOT NULL,   -- initial | renewal | plan_change
  "stage"                   TEXT     NOT NULL,   -- initiated | verified | fulfilled | failed
  "source"                  TEXT     NOT NULL,   -- checkout | return_page | billing_run | webhook
  "result"                  TEXT,
  "plan_id"                 TEXT     NOT NULL,
  "amount_minor"            INTEGER  NOT NULL,
  "currency"                TEXT     NOT NULL,
  "provider_transaction_id" INTEGER,
  "provider_status"         TEXT,
  "provider_message"        TEXT,
  "details"                 TEXT,
  "occurred_at"             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "payment_logs_one_fulfilment" ON "payment_logs"("tx_ref") WHERE "stage" = 'fulfilled';
CREATE INDEX "payment_logs_tx_ref_occurred_at_idx"  ON "payment_logs"("tx_ref", "occurred_at");
CREATE INDEX "payment_logs_user_id_occurred_at_idx" ON "payment_logs"("user_id", "occurred_at");
CREATE INDEX "payment_logs_stage_idx"               ON "payment_logs"("stage");
```

- **One row per stage, never updated.** A payment that was checked three times while pending has three `verified` rows, which is the point.
- **`tx_ref` with no foreign key.** Renewal and saved-card references never had a checkout row, so a key to `checkouts` would reject them. Rows for one attempt are grouped by matching references.
- **`stage` + `result`**: what happened, and Flutterwave's answer or the app's reason. For example `verified` / `amount_mismatch`, or `failed` / `customer_cancelled`. `result` is nullable because `initiated` has no outcome yet.
- **`source`**: which path did it. This shows whether the return page or the webhook activated a payment.
- **`provider_*`, nullable**: present only when Flutterwave answered.
- **`details`, nullable JSON**: context that differs by stage, such as proration figures or the number of verification attempts. Nothing in it is queried.

---

### `billing_events`: every change to a subscription, append-only

```sql
CREATE TABLE "billing_events" (
  "id"                      INTEGER  NOT NULL PRIMARY KEY AUTOINCREMENT,
  "user_id"                 TEXT     NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "subscription_id"         INTEGER,
  "type"                    TEXT     NOT NULL,
  "plan_id"                 TEXT,
  "amount_minor"            INTEGER,
  "currency"                TEXT,
  "tx_ref"                  TEXT,
  "provider_transaction_id" INTEGER,
  "details"                 TEXT,
  "occurred_at"             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "billing_events_user_id_occurred_at_idx" ON "billing_events"("user_id", "occurred_at");
CREATE INDEX "billing_events_type_idx" ON "billing_events"("type");
```

- **`type`** is one of:
  - `subscription_started`
  - `subscription_renewed`
  - `subscription_past_due`
  - `plan_change_scheduled`
  - `plan_change_cancelled`
  - `plan_changed`
  - `subscription_cancelled`
  - `cancellation_reason_given`
  - `subscription_resumed`
  - `subscription_expired`
  - `test_clock_advanced`

  These are kept apart from `payment_logs` so "what happened to the money" and "what happened to the plan" each read as one clean timeline.
- **Most columns are nullable** because not every event involves money or a payment. A cancellation has no amount. It's written in the same database transaction as the change it describes, so the log can't disagree with the data.

---

### `webhook_events`: each Flutterwave webhook, stored once

```sql
CREATE TABLE "webhook_events" (
  "id"                INTEGER  NOT NULL PRIMARY KEY AUTOINCREMENT,
  "event_key"         TEXT     NOT NULL,
  "event_type"        TEXT     NOT NULL,
  "provider_ref"      TEXT,
  "tx_ref"            TEXT,
  "signature_method"  TEXT     NOT NULL,                     -- hmac | verif_hash
  "payload"           TEXT     NOT NULL,                     -- redacted
  "status"            TEXT     NOT NULL DEFAULT 'received',  -- received | processing | processed | ignored | failed
  "result"            TEXT,
  "attempts"          INTEGER  NOT NULL DEFAULT 0,
  "deliveries"        INTEGER  NOT NULL DEFAULT 1,
  "received_at"       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_delivered_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimed_at"        DATETIME,
  "processed_at"      DATETIME
);
CREATE UNIQUE INDEX "webhook_events_event_key_key" ON "webhook_events"("event_key");
CREATE INDEX "webhook_events_status_received_at_idx" ON "webhook_events"("status", "received_at");
CREATE INDEX "webhook_events_tx_ref_idx" ON "webhook_events"("tx_ref");
```

- **`event_key` unique.** The key is `flutterwave:<event type>:<Flutterwave transaction ID>`, so idempotency rests on the provider's reference. The status isn't part of the key, so any repeat of the same transaction is the same event. A repeat delivery hits the unique index, and the app only adds 1 to `deliveries`.
- **`tx_ref`, nullable, no foreign key.** A correctly signed webhook can be about a payment the app has never seen. It's stored and marked `ignored`, not rejected.
- **`signature_method`, not null**: rows only exist for webhooks whose signature checked out, so there's always a method to record.
- **`payload`, not null, redacted**: only routing and amount fields. The card and customer details Flutterwave sends are stripped before saving.
- **`claimed_at`, nullable.** It's set while a worker holds the event and doubles as the claim token: a worker can only record a result if `claimed_at` still matches. A claim older than 5 minutes can be taken over.
- **`attempts`**: processing gives up at 5, so a broken event can't retry forever.

---

### `rate_limit_hits`: one row per allowed attempt to start a payment

```sql
CREATE TABLE "rate_limit_hits" (
  "id"            INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "key"           TEXT    NOT NULL,   -- checkout:user:<id> | checkout:ip:<address> | card_charge:user:<id>
  "created_at_ms" BIGINT  NOT NULL
);
CREATE INDEX "rate_limit_hits_key_created_at_ms_idx" ON "rate_limit_hits"("key", "created_at_ms");
```

- **`created_at_ms BIGINT`, not `DATETIME`.** The limiter counts and inserts in one raw SQL statement: `INSERT … SELECT … WHERE (SELECT COUNT(*) … created_at_ms > ?) < ?`. Whole milliseconds compare exactly as numbers, with no date parsing in SQL. Doing it in one statement is what makes concurrent requests unable to slip past the limit.
- **No foreign keys.** Keys can name an IP address, not just a user. Rows older than 24 hours are deleted as new ones arrive.

---

### Which constraints make an invalid state impossible

Each of these was tested by inserting the invalid row into a copy of the database. SQLite rejected every one. Each guards a state that application code is also meant to prevent. This is the layer that holds when that code has a bug.

| Constraint | Invalid state it makes impossible | The bug it would catch |
|---|---|---|
| `subscriptions_one_current`: partial unique on `user_id` where status is active, cancelled or past_due | A customer with two live subscriptions, billed twice and with two answers to "do they have Pro?" | Two checkouts completing at once, or a new subscription created without retiring the old one |
| `subscriptions.tx_ref` unique + foreign key to `checkouts` | One checkout starting two subscriptions, or a subscription that no payment ever started | The return page and the webhook both activating the same payment, or code creating a subscription directly |
| `payments.tx_ref` unique | The same charge recorded twice. With per-period renewal references, **a billing period charged twice** | Two billing runs overlapping, or a retry after a timeout |
| `payments.transaction_id` unique | One Flutterwave transaction counted as paying for two things | Verification matching the wrong payment to a reference |
| `payments.checkout_tx_ref` unique | One checkout producing two payments | The same activation race, caught at the payment row |
| `payment_logs_one_fulfilment`: partial unique on `tx_ref` where stage = fulfilled | Pro granted twice for one payment, for example two renewals of the period from one charge | Any code path fulfilling without checking it's already been done |
| `webhook_events.event_key` unique | The same webhook stored and acted on twice | Flutterwave retrying, or several deliveries arriving at once. This is how a repeat is recognised. |
| `users.email` unique | Two accounts for one email, with payments split between them | Creating the user again on every visit |
| Foreign keys to `users` (`ON DELETE RESTRICT`) on checkouts, subscriptions, payments, payment_logs, billing_events | Payment or subscription records belonging to nobody, and deleting a customer who has billing history | A cleanup or deletion that forgets the dependent rows |
| `payments.subscription_id` / `checkout_tx_ref` (`ON DELETE SET NULL`) | A payment pointing at a subscription or checkout that doesn't exist, without the payment record itself being lost | Deleting a subscription, which keeps the money record |
| `NOT NULL` on every `amount_minor`, `currency`, `plan_id`, `status`, `current_period_end` and `tx_ref` | A charge with no amount or currency, a subscription with no end to its access, or a payment with no reference to verify | A write path that forgets a field |

### What the schema does not prevent

There are **no `CHECK` constraints** in this schema. Prisma doesn't generate them for SQLite. The following are therefore enforced only in application code, and the database would accept them if that code were wrong. All five were confirmed accepted in the same test.

- **A negative or zero amount.** Prevented in code by `lib/money.ts` and prices coming only from `lib/plans.ts`.
- **A status, plan, stage or source outside its enum.** The Prisma client rejects these on every write, but raw SQL or another client would not be stopped.
- **A malformed currency** such as `ngn`. `money()` checks for three capital letters.
- **`current_period_end` before `current_period_start`.** Periods are only made by `addInterval`.
- **`checkouts.subscription_id`, `payment_logs.subscription_id` and `billing_events.subscription_id` pointing at nothing.** These have no foreign key. The logs deliberately outlive what they describe, and the checkout link was added later as a plain column.

Adding these in a migration would make the database the last line of defence for them too:
- `CHECK (amount_minor > 0)`;
- `CHECK (currency GLOB '[A-Z][A-Z][A-Z]')`;
- `CHECK (status IN (…))` for each enum;
- `CHECK (current_period_end > current_period_start)`.

In SQLite they need a table rebuild per table.

## 5. The Concepts

### Minor units, and why money is never a decimal

**What it is.** Money is stored and calculated as a whole number of the currency's smallest unit. For naira that's the kobo, so ₦5,000 is the integer `500000`. The currency code always travels with the number. The amount only becomes "₦5,000" at the moment it's shown to a person or sent to an API that wants naira.

**Why it is needed.** Computers store decimal fractions approximately. In JavaScript, `0.1 + 0.2` is `0.30000000000000004`, and `49.99 * 100` is `4998.999999999999`.

- **Payments fail.** Verification compares what Flutterwave says was paid with what was asked for. With floats, a genuine ₦4,999.50 payment can fail an exact comparison and be refused. The customer is charged and gets nothing.
- **Kobo appear or vanish.** Rounding errors on credits and prorations create or lose kobo. Across thousands of payments the books stop balancing, and nobody can say where the difference went.
- **Currencies mix silently.** Without the currency attached, ₦5,000 and $5,000 are the same number, and adding them would raise no error.

**How it was implemented.** `lib/money.ts` defines `Money = { minor, currency }` and is the only way amounts are created. `money()` refuses anything that isn't a whole number or isn't a three-letter currency code. `add`, `subtract` and `equals` refuse to mix currencies. The database stores every amount as `amount_minor INTEGER` plus `currency TEXT`. Naira exist in only one place: the Flutterwave boundary in `lib/flutterwave.ts`.
- **Outgoing:** `toMajorUnits` converts kobo to naira.
- **Incoming:** `transactionAmount` turns Flutterwave's naira back into kobo, and rounds exactly once to absorb float noise:

```ts
export function fromMajorUnits(amount: number | string, currency: string): Money {
  const value = typeof amount === "string" ? Number(amount.trim()) : amount;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MoneyError(`Not a money amount: ${JSON.stringify(amount)}`);
  }
  return money(Math.round(value * factor(currency)), currency);
}
```

The number of minor digits per currency (2 for NGN, 0 for JPY) comes from the runtime's currency data via `Intl`, so this works for currencies the slice doesn't sell in.

**What was chosen against, and why.**
- **Storing naira as a `REAL` or a JavaScript number.** That's the bug above.
- **A `DECIMAL(12,2)` column with a decimal library such as decimal.js.** SQLite has no true decimal type, so it would store it as a float or as text anyway. A library would also add a dependency to every arithmetic call site, for a problem integers already solve, because every amount the slice handles is a whole number of kobo.
- **Storing kobo without a currency column.** That would have been simpler today, since everything is NGN. But it would make "add a second currency" a data migration instead of a feature, and nothing would stop a mixed sum.

---

### The payment lifecycle: initiation, verification, fulfilment

**What it is.** Every payment goes through three separate steps, and each is recorded on its own:
1. **Initiation:** the app decides to take a payment. It records the reference and the exact amount, then sends the customer to Flutterwave or charges their saved card.
2. **Verification:** the app asks Flutterwave directly, using its own reference, what actually happened.
3. **Fulfilment:** the customer gets what they paid for. Pro starts or is extended.

A payment can stop after any step. Started but abandoned is one outcome. Checked and found declined is another.

**Why it is needed.** If the three are treated as one event, the app has to trust whatever arrives first, and that is usually the browser.
- **Free Pro from a typed URL.** The return URL reads `?status=successful&tx_ref=…`. Anyone can type that URL. If arriving at it granted Pro, anyone could get Pro without paying.
- **The right status, the wrong amount.** A tampered checkout could pay ₦50 for a ₦50,000 plan. Without a separate verification step that checks the amount, it would still be granted.
- **Fulfilling twice.** If fulfilment isn't its own step that can only happen once, the return page and the webhook arriving together would extend the period twice for one payment.

**How it was implemented.**

1. **Initiation.** `startCheckout` and `recordCheckout` store the `tx_ref`, plan and amount, all priced on the server.
2. **Verification.** `verifyCheckout` in `lib/billing.ts` calls `verifyByReference` and passes the result through `classify`. A payment only counts as successful if Flutterwave's reference, status, amount and currency all match:

   ```ts
   function matches(tx: FlwTransaction | null, txRef: string, expected: Money): tx is FlwTransaction {
     if (!tx || tx.tx_ref !== txRef) return false;
     const got = transactionAmount(tx);
     return got !== null && equals(got, expected);
   }
   ```

3. **Fulfilment.** `activateSubscription`, `applyRenewalSuccess` and `completePlanChangeCheckout` in `lib/store.ts` run only after a `successful` verification. Each runs in one database transaction that starts by claiming the attempt, so it can complete only once.

The return page, the webhook, the billing run and "Renew now" all use the same verification code. The redirect and the webhook are only prompts to check again. Neither can grant anything by itself.

**What was chosen against, and why.**
- **Trusting the webhook payload as the verification.** It's signed, so it's authentic, but it's a notification, and its shape and status meanings vary between Flutterwave's API versions. Asking `verify_by_reference` gives one consistent answer for every path.
- **Fulfilling only from webhooks.** That's a common pattern, but webhooks can be late or lost. The tunnel URL changing during this build lost several. The customer would then sit on a "processing" page after paying. Verifying on the return page as well means the customer sees the result immediately. The webhook covers the case where they close the tab.

---

### The payment log, and what it would prove in a dispute

**What it is.** `payment_logs` is an append-only table with a row for every stage of every payment attempt: initiated, each verification, fulfilled, failed. Each row records:
- when it happened;
- which path did it (checkout, return page, billing run, webhook);
- the amount and currency;
- Flutterwave's transaction ID, status and message.

Rows are never updated. A payment checked three times while pending has three `verified` rows.

**Why it is needed.** When a customer disputes a charge, the question is never just "is there a payment row?" It's whether they were charged, how much, whether the charge was confirmed with the processor, and whether they got what they paid for. A `payments` table only shows the final state. Without the log, the order of events can't be shown.
- **"I was charged twice."** There would be no proof that one was a declined attempt and the other a success.
- **"I paid but never got Pro."** There would be no record of the exact second Flutterwave confirmed it, the second Pro was granted, and which path did it.

A chargeback is decided on evidence, and an overwritten status column isn't evidence.

**How it was implemented.** `logPayment` and `paymentLogData` live in `lib/store.ts`. Each stage that changes data is written **in the same transaction** as the change. The `fulfilled` row is written inside `activateSubscription`, so the log can't claim Pro was granted when it wasn't, or the reverse. A partial unique index means a `tx_ref` can have at most one `fulfilled` row:

```sql
CREATE UNIQUE INDEX "payment_logs_one_fulfilment" ON "payment_logs"("tx_ref") WHERE "stage" = 'fulfilled';
```

For a disputed card payment, the log would show, in order:
1. checkout started for ₦5,000, from `checkout`;
2. verified `successful` for ₦5,000 NGN, with Flutterwave transaction 10621289, from `return_page`;
3. fulfilled `active`, with the new period end in its details, from `return_page`.

It would also show the webhook arriving later and finding the payment already fulfilled. Billing displays the same rows as a timeline under each payment (`PaymentTimeline.tsx`). Subscription changes such as a cancellation or a plan switch are a separate append-only log, `billing_events`. Together they also prove things the customer *did*, such as cancelling, and the date they cancelled.

**What was chosen against, and why.**
- **A `status` column updated in place** (`initiated → verified → completed`). That's simpler, but every update destroys the previous state, so the history a dispute needs is gone.
- **Logging to text files or the console.** Logs rotate, aren't transactional with the data, and can't be queried per customer.
- **One combined log of payments and subscription events.** They are kept apart so "what happened to the money" reads cleanly without plan changes mixed in.

---

### Idempotency in payments

**What it is.** An operation is idempotent if doing it twice has the same effect as doing it once. In payments it means:
- a repeated request, a refreshed page, a retried job or a duplicate webhook can never charge twice;
- they can never record the same payment twice;
- they can never give the customer twice what they paid for once.

**Why it is needed.** Duplicates aren't rare in payments. They're normal.
- Flutterwave retries webhooks that don't get a 200 response.
- Customers refresh the return page, or double-click Pay.
- A billing run can be triggered twice.
- In this slice, the return page and the webhook always both arrive for the same payment.

Without idempotency, each of these becomes a double charge or a doubled subscription period, and the double charge is the kind a customer disputes with their bank.

**How it was implemented.** Each layer has its own guard, and each guard is backed by a database constraint rather than just a check in code. The `tx_ref` is the key throughout.

| Where | Guard |
|---|---|
| **Activation** (`activateSubscription`) | One conditional update claims the checkout. If someone else already completed it, nothing else in the transaction runs (code below). |
| **Renewals** | The reference is derived from the subscription and period, `fn_renew_<id>_<periodStart>`. `payments.tx_ref` is unique, so the same period can't be charged twice even if two runs overlap. |
| **Fulfilment** | The partial unique index above allows only one `fulfilled` row per `tx_ref`. |
| **Webhooks** | Keyed on Flutterwave's transaction ID. See the next section for how a repeat is recorded once and acted on once. |
| **Payments** | `payments.transaction_id` is unique, so one Flutterwave transaction can't pay for two things. |

```ts
const claimed = await tx.checkout.updateMany({
  where: { txRef: input.txRef, status: { not: "completed" } },
  data: { status: "completed", completedAt: new Date() },
});
if (claimed.count === 0) return { already: true as const };
```

**What was chosen against, and why.**
- **An `Idempotency-Key` header sent by the client**, as Stripe's API uses. That's the right pattern for a public API with many clients. Here the server makes every reference itself, so the reference already is the idempotency key. A client-supplied key would add a way for the browser to influence payment identity, for no gain.
- **Check-then-insert in code** ("does this payment exist? if not, create it"). Two requests can both check before either inserts. Only a unique constraint or a conditional update holds under concurrency, so those are used everywhere.

---

### Webhook signature verification

**What it is.** A webhook is Flutterwave calling a URL on the app's server to say something happened. Because that URL is public, anyone can call it. Signature verification is how a real Flutterwave request is told apart from a forged one. Flutterwave and the app share a secret. Each request carries proof derived from that secret, which a forger can't produce.

**Why it is needed.** Without it, anyone who finds `/api/webhooks/flutterwave` can post `{"event":"charge.completed","data":{"status":"successful",…}}`. If the app acted on that, it could mark payments as paid that never happened. Even with verification behind it, every forged request would cost a database write and a call to Flutterwave, so a flood of them would use up the app's Flutterwave API rate limit.

**How it was implemented.** The route in `app/api/webhooks/flutterwave/route.ts` reads the raw body as text and checks the signature **before parsing or storing anything**. A failure returns 401 and leaves no trace in the database. The check lives in `lib/webhook-signature.ts` and accepts either of Flutterwave's two schemes:
- **`flutterwave-signature`:** a base64 HMAC-SHA256 of the raw body with the secret.
- **`verif-hash`:** the secret itself in a header. This is what this account actually sends.

```ts
const hmac = headers.get("flutterwave-signature")?.trim();
if (hmac) return safeEqual(hmac, signBody(rawBody, secretHash)) ? { ok: true, method: "hmac" } : { ok: false, reason: "mismatch" };

const hash = headers.get("verif-hash")?.trim();
if (hash) return safeEqual(hash, secretHash) ? { ok: true, method: "verif_hash" } : { ok: false, reason: "mismatch" };

return { ok: false, reason: "missing" };
```

`safeEqual` uses Node's `timingSafeEqual`, so an attacker can't learn the secret one character at a time by timing how long the comparison takes. The route also fails closed in two cases. With no secret configured it refuses everything with a 503, and bodies over 256 KB are refused before they're read. Even a correctly signed webhook is never trusted for the payment's outcome: it only triggers the same check with Flutterwave as the return page.

**Repeats.** A verified webhook is stored once, under a key built from Flutterwave's transaction ID, and a repeat only adds 1 to `deliveries`. Processing first claims the event, so only one worker runs it.

**What was chosen against, and why.**
- **Checking the HMAC only.** Flutterwave's dashboard sends `verif-hash` for this account, so HMAC-only would have rejected every real webhook. Supporting both, and preferring HMAC when it's present, works with either setting.
- **Allow-listing Flutterwave's IP addresses.** Those change, break behind tunnels and proxies, and prove less than a secret does.
- **Parsing the JSON first and verifying afterwards.** An HMAC is over exact bytes. Re-serialising parsed JSON can change whitespace or key order and break a valid signature. It also means doing work on unauthenticated input.

The `verif-hash` scheme is weaker than an HMAC, because the secret itself travels in every request. That makes using HTTPS mandatory and the secret's strength important. That trade-off is Flutterwave's, not one that could be chosen here.

---

### Proration

**What it is.** Proration means charging for part of a billing period. When a monthly customer switches to yearly partway through a month, they've already paid for days they won't use as a monthly customer. Proration credits those unused days against the yearly price, so they pay only the difference today.

**Why it is needed.** Without it there are only two bad options.
- **Charge the full ₦50,000 now.** A customer who paid ₦5,000 a day ago pays for the same 29 days twice. That's overcharging, and it's the kind of thing that produces refund requests and chargebacks.
- **Make them wait until the month ends to switch.** That puts off a customer who wants to pay more today.

Getting proration wrong is just as costly. Floating-point credits leak kobo, and a figure that changes between the screen and the charge means charging an amount the customer never agreed to.

**How it was implemented.** `quoteProration` in `lib/proration.ts`:
- **Days** are whole calendar days in Lagos time (UTC+1). Today counts as used.
- **Credit** = what was paid for the month × days left ÷ days in the period, rounded **down** to the kobo.
- **Due today** = the yearly price minus the credit.

```ts
const daysInPeriod = Math.max(1, lagosDay(end) - lagosDay(start));
const daysUsed = Math.min(daysInPeriod, Math.max(1, lagosDay(now) - lagosDay(start) + 1));
const daysLeft = daysInPeriod - daysUsed;
// Integer maths in minor units; Math.floor rounds the credit down.
const credit = money(Math.floor((sub.amount.minor * daysLeft) / daysInPeriod), sub.amount.currency);
const newPrice = PLANS[toPlanId].price;
const due = subtract(newPrice, credit);
```

**The real switch tested during this build.** The customer subscribed monthly on 18 November and switched the same day:

| | Value |
|---|---|
| Period | 18 November to 18 December, **30 days** |
| Used | 1 (today counts), so **29 days left** |
| Credit | 500,000 kobo × 29 ÷ 30 = 483,333.33 → rounded down to **483,333 kobo = ₦4,833.33** |
| Due today | 5,000,000 − 483,333 = **4,516,667 kobo = ₦45,166.67** |
| Afterwards | A new yearly period starts on the payment date. The next charge is the full ₦50,000. |

The rest of the process:
- **The breakdown is shown before confirming,** on checkout and on Billing.
- **The amount shown is checked again.** The form sends it as `quotedDue`. `switchIntervalNow` recalculates it on the server and refuses if it differs. It can only differ if midnight passed while the page was open.
- **The plan changes only after Flutterwave confirms** a payment of exactly that amount. The breakdown is stored on the payment for the history and for disputes.

**What was chosen against, and why.**
- **Prorating by the second.** That's more precise, but the amount would change between showing the page and clicking Pay. Whole days mean the figure holds until midnight, so what's shown is what's charged.
- **Rounding the credit to the nearest kobo.** That could credit more than was paid. Rounding down never gives away money that wasn't received.
- **Prorating yearly → monthly.** The unused yearly credit, up to ₦50,000, is bigger than a monthly payment. It would need a stored credit balance or a refund. The slice schedules that switch for the end of the paid year instead, so nothing is ever owed back.
- **Flutterwave's payment plans doing it.** They don't prorate, which is one reason renewals are charged by the app.

---

### Cancellation and period-end access

**What it is.** When a customer cancels, they're stopping future renewals, not taking back the period they've paid for. They keep Pro until the end of that period, they aren't charged again, and the account moves to Free on the day the paid period ends. Until then they can change their mind with one click.

**Why it is needed.** The customer paid for a full period of service. Ending access the moment they cancel means taking money for service that is then withheld.

- **The commercial and legal reasoning.** That's the core of the legal argument. This is reasoning, not legal advice.
  - **Contract law:** the payment bought a defined period. Cutting it short without a refund fails to deliver what was paid for.
  - **Consumer law:** in Nigeria, the Federal Competition and Consumer Protection Act 2018 protects consumers against unfair and deceptive practices, and taking payment for service then withholding it is hard to defend under it.
  - **Other markets:** the UK and EU consumer rules, and US state auto-renewal laws such as California's, are strict about subscriptions. They require clear terms before purchase and a cancellation path that's as easy as signing up. Some give a cooling-off right to cancel for a refund. This slice doesn't offer refunds, so it doesn't implement that.
- **Hard to cancel is the other failure.** A cancel button buried behind phone calls or retention screens is the practice those laws target. It also turns customers who want to leave into chargebacks instead.

**How it was implemented.**
- **Ending future charges.** `cancelCurrentSubscription` calls `markSubscriptionCancelled` in `lib/store.ts`, which sets `status = 'cancelled'` and `cancelled_at`, keeps `current_period_end` as it is, and clears any scheduled plan change.
- **Keeping access.** `getBillingState` in `lib/billing.ts` treats a cancelled subscription whose period hasn't ended as `cancelling`, and `hasPro()` stays true for it.
- **The day it ends.** The billing run marks it `expired`, but access doesn't wait for that. Once `current_period_end` passes, the state reads Free even if the run never comes.

**Asking first, and keeping it easy.**
- Cancelling takes one click on Billing and then one confirm box. The box says exactly what happens: "You won't be charged ₦5,000 again. Pro stays on until 18 December, then your account moves to Free."
- The server refuses a cancel request without the confirm box's `confirm=cancel` field, so nothing cancels by accident.
- **Keep Pro** undoes it before the period ends.
- The optional reason prompt only appears *after* the cancellation is saved, and it can be skipped. It isn't a hurdle.
- Every cancellation is a `subscription_cancelled` event with its access end date, so the date can be proven later.

**What was chosen against, and why.**
- **Ending access immediately and refunding the unused days.** That's legitimate, but it needs refunds, which this slice deliberately leaves out. Customers also generally prefer keeping what they paid for.
- **Ending access immediately without a refund.** That's the unfair option described above.
- **A retention flow before cancelling,** such as "Are you sure? Here's 50% off". It's commonly done, but it makes cancelling harder than subscribing. That's exactly what consumer rules push against.

---

### Why cards are not stored (PCI scope)

**What it is.** PCI DSS is the security standard the card networks require from anyone who handles card data. "PCI scope" is how much of a system that standard applies to. It covers every server, database, log and person that can touch a card number, plus everything connected to them. The fewer places card data passes through, the smaller the scope.

**Why it is needed.** If this app received card numbers, even for a moment on the way to Flutterwave, the app's servers, database, backups and logs would all be in scope.
- **The paperwork grows.** That means the full self-assessment (SAQ D, around 300 requirements), with network segmentation, quarterly vulnerability scans, penetration tests and key management.
- **A breach becomes a card breach.** A breach of the database would leak customers' cards, with fines from the card networks and every affected customer needing a new card.
- **CVV can't be kept at all.** Storing it after authorisation is forbidden outright.

None of that is needed to sell a ₦5,000 subscription.

**How it was implemented.** The card itself never reaches this app:

1. **Entry.** Customers type their card on Flutterwave's hosted page (`createHostedPaymentLink` in `lib/flutterwave.ts`). That keeps the slice in the smallest scope, SAQ A, the self-assessment for merchants who fully outsource card entry.
2. **What's kept.** Only Flutterwave's **token** (`subscriptions.card_token`). It's a reference that only works with the app's secret key, and renewals are charged with it. The **brand and last 4 digits** are kept for display. PCI DSS allows those because they can't be used to pay.
3. **Webhooks.** Flutterwave's charge webhook does include the card's first 6 and last 4 digits, expiry and issuer. `redactWebhookPayload` in `lib/webhooks.ts` strips that before the event is stored. It keeps only the event type, IDs, status, amount, currency, payment type and date.
4. **Proof.** `npm run check:card-data` (`scripts/check-card-data.mjs`) scans the database and every backup. It looks for card-number-shaped digits that pass the Luhn checksum, card fields such as `first_6digits`, `expiry` or `cvv`, and column names that suggest card data. It fails if it finds any.

**What was chosen against, and why.**
- **An embedded card form, or collecting cards and sending them on.** Some processors offer this for a smoother checkout. It would put the app in scope and make every server change a compliance question.
- **Storing the full webhook payload for debugging.** It was the original behaviour. It's useful, but it quietly stored first 6 + last 4 + expiry, which is exactly the kind of creep the scan exists to catch.
- **Not storing brand and last 4 either.** That's the strictest reading, but the customer then couldn't tell which card will be charged. Keeping only what PCI DSS explicitly allows was the better balance.

---

### Rate limiting on payment endpoints

**What it is.** Rate limiting caps how many times something can happen in a window of time: here, how often a user or an IP address can start a payment. Past the cap, the request is refused with "try again in N minutes" before any work is done.

**Why it is needed.** Every click of **Pay** writes a checkout row and calls Flutterwave's API, and every **Switch now** charges a saved card.
- **Card testing.** This is the main abuse of payment endpoints. Someone with a list of stolen card numbers uses a merchant's checkout to find out which ones work, by making hundreds of small attempts. Each attempt costs an API call. A flood of declines can get a merchant account flagged or closed by the processor.
- **Plain repetition.** A script, or a frustrated double-clicker, can create thousands of checkout rows and Flutterwave links. It could also charge a saved card repeatedly.
- **The app's own API quota.** Flutterwave rate-limits the app, so an attacker could use up that quota and block real customers from paying.

**How it was implemented.** `lib/rate-limit.ts` stores attempts in the `rate_limit_hits` table. The limits:
- **5 attempts per user per 10 minutes, and 20 per day.**
- **10 per IP address per 10 minutes.** The IP comes from `cf-connecting-ip`, otherwise `x-forwarded-for`.
- **3 saved-card charges per user per 10 minutes.**

Both `startCheckout` and `switchNow` check before writing anything or calling Flutterwave. The key detail is that counting and recording are one SQL statement, so ten simultaneous clicks can't all see "4 so far" and all get through:

```ts
const rows = await prisma.$queryRawUnsafe<{ id: number | bigint }[]>(
  `INSERT INTO rate_limit_hits (key, created_at_ms) SELECT ?, ? WHERE ${conditions.join(" AND ")} RETURNING id`,
  ...params,
);
```

Each condition is `(SELECT COUNT(*) … WHERE key = ? AND created_at_ms > ?) < ?`, one per window. Only allowed attempts are recorded, so retrying while blocked doesn't extend the wait. If the IP limit refuses a request, the user's count for it is removed too. A test of 10 simultaneous attempts against a limit of 5 let exactly 5 through.

**What was chosen against, and why.**
- **An in-memory counter.** That's the usual first approach, and it's faster. But it resets on every restart, and with more than one server process each one has its own count, so the real limit becomes the limit × the number of processes. The database is already there and is shared.
- **Redis.** That's the standard production choice. It would mean another service to run for a slice that has none.
- **Limiting only by IP.** Many real customers share an IP behind mobile carriers' address-sharing, which would block them together. Attackers rotate IPs cheaply. Limiting by user catches a single account hammering Pay, and the IP limit catches one machine working through many accounts.
- **A fixed window** ("5 per clock 10 minutes"). It allows 10 in a burst across a window boundary. Counting rows within the last 10 minutes from now doesn't have that gap.

## 6. What Went Wrong

These are in the order they happened. Several of them changed the design, not just the code.

### Problem 1: "We cannot find the subscription with our payment provider"

**The symptom.** On 16 November, clicking **Cancel** on a monthly subscription that had just been paid for failed with *"We cannot find the subscription with our payment provider."* At that point the app used Flutterwave's own recurring **payment plans**. Flutterwave created and charged the subscription, and cancelling meant asking Flutterwave to cancel it.

**The investigation.** The Flutterwave test account was queried directly for its subscriptions, read-only. Three things came out of it:
- **Searching by email found nothing.** The app looked the subscription up by the customer's email, `adaeze.okafor@example.com`. In test mode Flutterwave doesn't keep the email it is sent. It rewrites the customer to a sandbox address built from the merchant account, `ravesb_…_<account email>`. That same mismatch meant the Flutterwave subscription ID had never been saved at payment time, so Cancel had nothing to fall back on.
- **Filtering by transaction ID didn't filter.** It was tried as an alternative, and it returned every subscription on the account, so it was useless as a lookup.
- **One payment had produced two subscriptions.** Flutterwave had created two active ₦5,000 monthly subscriptions, IDs 54315 and 54316, about one and three minutes after the payment. The reason was never found. If only one had been cancelled, the other would have kept charging the customer.

**The cause.** The app didn't own the subscription. Flutterwave did, and the only link between the two was an email address that the sandbox rewrites.

**The fix.**
1. **First, a patch.** The lookup was changed to search with the email Flutterwave actually recorded on the payment, and to match on plan and creation time. Cancel stopped every matching subscription, and only showed "Cancelled" in the app if all of them had stopped at Flutterwave.
2. **Then the design changed** (Problem 2), and Flutterwave plans were removed entirely. The app now owns the subscription. Flutterwave takes the first payment and returns a card token, and the app charges that token for renewals. Cancelling is now a database update with nothing at Flutterwave to find. `listSubscriptions`, `cancelProviderSubscription` and the plan-setup script were deleted.

---

### Problem 2: Proration was not done right

This took two attempts.

**The symptom, first time (16 November).** A monthly subscriber switching to yearly was charged the **full ₦50,000** a minute after paying ₦5,000 for the month (transactions 10616732, then 10616736). A new year started that day and the monthly subscription was cancelled. The 29 unused monthly days were simply lost.

**The investigation, first time.**
- **Could a Flutterwave plan charge a smaller first amount?** An attempt was made to find out by opening a test checkout link. The Chrome extension wasn't responding, so it was never confirmed either way. That was a dead end.
- **Card tokens.** It was confirmed that Flutterwave returns a reusable card token on card payments.
- **The conclusion.** Flutterwave's fixed plans control both the amount and the billing dates. Proration needs a custom amount charged now, and a deferred switch needs a charge on a future date, so neither fits a fixed plan.
- **The decision.** The billing design was put to a decision, and the choice made was *"no refunds… start yearly charge at the end of the month"*, because the features are identical.

So the switch was rebuilt as **scheduled**: ₦0 today, and yearly starts when the month ends. That removed the overcharge, but it was not proration. The credit method chosen, "by exact time", never applied, because nothing was credited.

**The symptom, second time (18 November).** The requirement came back as "Proration on a mid-cycle interval change, calculated and shown." Checked against the code, the honest answer was "No": interval changes were only ever scheduled, and nothing was calculated or shown.

**The fix, second time.** Real proration was built in `lib/proration.ts`:
- **Days** are whole Lagos-time days, not "exact time". If proration is calculated to the second, the amount changes between the page and the charge.
- **The credit is rounded down,** so it never credits more than was paid.
- **The amount is checked again.** The amount shown is sent back as `quotedDue` and recalculated on the server.
- **The plan changes only after a verified payment** of exactly that amount.

Writing it uncovered two more problems.

1. **The test was wrong, not the code.** One of the 43 tests failed. It said a period from 31 January to 28 February, quoted on 10 February, should have 18 days left. The code said 17. Counting by hand, 31 January through 10 February is 11 days used, so 17 left is correct. The test's expectation was fixed.
2. **The first real switch failed twice.** A card subscription was created and **Switch to yearly now** was clicked twice (₦45,166.67 each time). Flutterwave rejected both saved-card charges with *"Card token expired, please re-tokenize the card"*, for a token created two minutes earlier.
   - **What worked correctly:** each attempt was verified, recorded as failed, and left the subscription on monthly with nothing charged.
   - **What was missing:** the only way forward was to wait until the period ended. "Switch at period end instead" was then used, which is why a yearly switch was left scheduled.
   - **The fix:** when the saved card fails, checkout now offers **Pay ₦X on Flutterwave instead**. That opens hosted checkout for the same prorated amount, recorded as a `plan_change` checkout. It was tested with bank transfer and confirmed working.

---

### Problem 3: Saved-card payments not working for renewals

This was several separate failures that all looked like "renewals don't work".

**Symptom A: every renewal charge rejected (16 November).** The first test of the billing run failed with *"Please enter a valid redirect url"* from `POST /tokenized-charges`. That was followed by *"No transaction was found for this id"* when the run tried to verify a charge that had never been created.
- **Investigation.** Hosted checkout had accepted `http://localhost:3000/checkout/return` as a redirect without complaint, so localhost was assumed to be fine. It wasn't. A probe script was written that made ₦100 test charges with different `redirect_url` values. `http://localhost:3000/billing` and `https://localhost:3000/billing` were both rejected. A public https URL was accepted. One of the two test tokens also came back *"Card token expired"*. That was the first sign of the problem that resurfaced on 18 November.
- **Cause.** The token-charge endpoint requires a public https redirect URL, unlike hosted checkout. It's only used if a bank asks the customer to authenticate.
- **Fix.** `chargeRedirectUrl()` in `lib/env.ts` uses `FLW_CHARGE_REDIRECT_URL`, or `APP_URL` when that's public https. Otherwise it falls back to `https://example.com/billing`.

**Symptom B: renewals stuck on "Processing" (16–17 November).** With the redirect fixed, Flutterwave answered *"Charge initiated"* with status `pending`, and the charge never settled. It showed Processing in the UI and the database, with no webhook.
- **Investigation.** The charge was re-verified, and it was still `pending`. In the dashboard it was "Approved". Flutterwave was asked to resend its webhook, and it replied *"no hook data found"*: it had never created one.
- **Cause.** In Flutterwave's sandbox, saved-card charges stay pending indefinitely, so no final webhook is ever sent. This is a sandbox limitation, not something the app can fix.
- **The decision.** **Option A** was chosen: a renewal Flutterwave reports as pending still extends Pro, logged as `fulfilled / pending_settlement`. The billing run and webhooks keep re-checking it. If it later fails, the subscription goes `past_due`.

**Symptom C: "Payment failed because there was no saved card" (17 November).** After **Skip to period end**, the renewal failed with `no_saved_card`, and the subscription went to Payment failed.
- **Investigation.** The webhooks were checked first. That turned out to be irrelevant: no charge was ever sent, so none was due. The payment record showed `payment_type: bank_transfer`.
- **Cause.** The app asks for a card-only checkout (`payment_options: "card"`), but Flutterwave's hosted page offered bank transfer anyway. A bank transfer returns no card token, so there was nothing to charge.
- **Fix.** Bank-transfer subscriptions were set to renew **manually**. The payment method is recorded. With no token, the billing run skips the subscription rather than failing it. At period end Billing shows **Renewal due** with a **Renew** button that goes through checkout.

**Symptom D: "Wrong token or email passed" (17 November, in the test scripts).** A test that seeded a card subscription failed with this error.
- **Cause.** The test seed charged the token with the app's demo email. As in Problem 1, Flutterwave had rewritten the customer's email, and token charges must use the rewritten one.
- **Fix.** The seed now uses the email from the verified transaction. The app already did this: `subscriptions.customer_email` stores the email Flutterwave recorded on the payment, for exactly this reason.

---

### Problem 4: Webhooks failing to arrive

**The symptom.** On 17 November, after a card payment, no webhook reached the server. Flutterwave's resend replied *"hook sent successfully"*. The server's request log showed only local test requests.

**The investigation, including the mistakes made along the way.**
1. **Wrong advice was given.** The setup instructions said to tick an "on charges" option in Flutterwave's webhook settings. It doesn't exist: charge webhooks are sent by default once a URL and secret hash are saved. The instructions were corrected when the option couldn't be found.
2. **The endpoint was checked first.** It was signature-verified, worked with the test script, and was reachable through the tunnel. The app wasn't the problem.
3. **The likely suspect was the dashboard settings:** test mode versus live mode (they have separate webhook settings), the exact URL, and whether Save had actually been clicked.
4. **Then a "validation error" appeared on the URL field.** The secret hash's `-` and `_` characters were suspected first, then pasted spaces. Both were irrelevant, since the error was on the URL. The server log was checked at the moment Save was clicked. No request had arrived, so Flutterwave was rejecting the URL inside the form itself, without contacting the app. Testing the bare tunnel domain was suggested, in case `trycloudflare.com` was refused.
5. **It started working.** The URL was re-entered and it saved. Which character or format the form had objected to was never pinned down.

**The cause.** The webhook URL was never saved in Flutterwave's test-mode settings, because the form refused it. So "hook sent successfully" meant sent to nowhere.

**The fix.** Once the URL was saved, a resend arrived. It was verified by `verif-hash` (this account sends no HMAC header), and was correctly ignored as "already fulfilled", because the return page had activated Pro first. The next real card payment's webhook arrived on its own and activated Pro before the browser got back.

**The lasting lesson came on 18 November.** That day no webhook arrived for any payment. The cause: the tunnel had been shut down because the machine was low on memory, and a restarted tunnel gets a new address that Flutterwave didn't know about.
- **Why it didn't hurt.** The app never depended on webhooks. The return page verifies every payment itself, and the billing run re-checks pending ones. That's why lost webhooks cost nothing here.
- **What came out of it:** a test script for webhooks (`npm run webhook:test`), and a retry path for failed webhook events through the billing run.

---

### Problem 5: The database and the dev server after schema changes

**Symptom A: `prisma migrate dev` wanted to wipe the database (17 November).** Adding the money columns, `prisma migrate dev` said the init migration had been *modified after it was applied*, and offered to **reset the database**.
- **Investigation.** The init migration file's checksum no longer matched the one recorded in the database. Its modified time was 06:46 that morning. It wasn't from any edit made during the build, and what touched it was never established.
- **Fix.** The database was not reset. Every migration since has been written with `prisma migrate diff` and applied with `prisma migrate deploy`, which doesn't re-check old checksums. The database is backed up to `data/fieldnote.backup-<time>.db` before each one. The README documents this.

**Symptom B: a migration refused to run (16 November).** Moving to app-run billing added a required `current_period_start` column. Prisma refused: *"Added the required column … without a default value. There are 2 rows in this table."*
- **Fix.** The generated migration SQL was edited by hand (`20261116110630_app_billing_and_events`). It rebuilds the table and fills each existing row's `current_period_start` from its `started_at`. It also marks the old rows `billing_mode = 'provider_plan'`, so they were known to belong to the Flutterwave-plans design.

**Symptom C: Billing returned a 500 after a migration (18 November).** After adding the cancellation-reason columns, `/billing?cancelled=1` returned a 500. The server log showed a `PrismaClientValidationError` on `cancellationReason`.
- **Investigation.** The migration had applied, and a script against the database worked.
- **Cause.** The running dev server keeps one Prisma client on `globalThis` across hot reloads, so it was still using the client from before the new columns existed.
- **Fix.** Restart the dev server after every schema change. That turned into its own problem:
  - The server's shell was stopped, but the Node process underneath kept running. It held port 3000 without answering.
  - The new server started on 3001, then exited, saying another server for this folder was already running.
  - The orphan (PID 24516) was found, confirmed from its command line to be this project's Next server, ended, and replaced with a fresh one.

  The same orphan pattern showed up again on 19 November after a low-memory shutdown.

**Also, throughout:** the browser automation used for checking screens often couldn't read the app's pages. Several screens were therefore verified from server responses and logs rather than visually.

## 7. What This Slice Does Not Handle

The limits of this build, grouped by why they exist.

### What breaks at scale

- **SQLite allows one writer at a time.** The database is a single file. Every checkout, payment log row, webhook and rate-limit hit is a write, and writes queue behind each other. The app can't run on more than one machine, because each machine would have its own file. It holds up for one person testing. It wouldn't for a few hundred people paying in the same minute.
- **The billing run is one long request.** `runBillingCycle` works through every due subscription one after another, inside a single `POST /api/billing/run`. Each charge waits for Flutterwave, then re-verifies up to three times, two seconds apart. A few hundred renewals due on the same day would run past any request timeout. A crash halfway through would leave the rest until the next run. The database guards stop a period being charged twice, but nothing spreads the work out or resumes it.
- **Webhook processing lives in the web process.** Verified webhooks are processed with `after()`, after the response is sent. If the process stops in between, the event is stored but only retried when the billing run next calls `retryWebhookEvents`. A real system would use a queue with its own workers.
- **Some safeguards are per process.** The `inFlight` and `switching` sets in `lib/billing.ts` and `lib/webhooks.ts` exist only in that process's memory. The database claims and unique constraints are the real guard. The in-memory sets are a shortcut that stops working with more than one process.
- **Nothing is paginated.** Billing loads every payment and every payment-log row for the user on each visit (`listPayments`, `listPaymentLogs`). The webhook retry pass takes 100 events at a time. A customer with years of history, or a backlog of failed webhooks, would make these slow.
- **The billing state is read twice per page.** The top bar and the page each call `getBillingState`, so every page view runs the same queries twice.
- **One time zone.** Proration counts days in Lagos time. Customers elsewhere would see a day boundary that doesn't match their own midnight.

### What must be added before real users touch it

- **Real sign-in and per-user authorisation.** Every action acts on one built-in user (`getCurrentUser` in `lib/store.ts`). Sign-in, sessions, and checking that each request belongs to the account it changes are all missing.
- **Live keys, tested end to end.** `lib/env.ts` refuses any key that isn't a test key, on purpose. Saved-card renewals have never been seen to settle in the sandbox: they stay pending. Live mode would need its own full test of first payments, renewals, failed renewals, prorated switches and webhooks.
- **A scheduler for the billing run.** Nothing calls `POST /api/billing/run` on a timer, and `CRON_SECRET` isn't set in the development environment, so the endpoint is off there. Without a scheduler, renewals happen only from Test tools, and failed webhooks are never retried.
- **Somewhere to host it.** That means a public https address in place of the cloudflared quick tunnel, whose URL changes on every restart, plus a proper `FLW_CHARGE_REDIRECT_URL` and a strong `FLW_WEBHOOK_SECRET_HASH`. The secret in the development environment is short and easy to guess.
- **A way to update the card.** Tokens can stop working: Flutterwave returned "Card token expired" for a two-minute-old token during testing. Today the only recovery is paying through checkout again. Customers need to replace a saved card before a renewal fails.
- **Retries for failed renewals.** A failed renewal goes straight to `past_due`. Real billing retries on a schedule over several days and tells the customer, before giving up.
- **Emails.** Customers need receipts, a warning before a yearly renewal, cancellation confirmations and failed-payment notices. Auto-renewal rules in several markets require some of these.
- **Refunds and disputes.** There's no refund path, and no handling of Flutterwave's refund or chargeback events. Only `charge.completed` is processed. The payment log has the evidence a dispute needs, but nothing acts on a dispute.
- **Monitoring.** Errors go to the console. Nothing alerts on a webhook that has used all 5 attempts, a spike in failed renewals, or a billing run that didn't complete.
- **An automated test suite.** Each feature was tested with scripts against a copy of the database, 10 to 43 checks each, and those scripts were deleted afterwards. There are no committed tests and no CI, so nothing re-checks any of it when the code changes. One leftover script remains in `.e2e-tmp/`. It refuses to run against anything but a scratch database.
- **Database-level checks.** There are no `CHECK` constraints (Section 4). A negative amount or an unknown status would be accepted by the database if the app code were wrong.
- **Licences, terms and privacy.**
  - **The fonts:** numbers are designed to render in Neue Haas Grotesk Text. Only trial files were used, which need a licence before shipping, so they aren't in the repository. Without them, numbers fall back to Geist.
  - **The terms:** terms of service and pricing disclosures don't exist yet.
  - **The data:** storing customer data needs a privacy notice and a retention policy under Nigeria's data protection rules.
- **Proper sign-off of the screens.**
  - **The error screens:** some screens were only checked through server responses, because browser automation couldn't read them.
  - **Accessibility:** no accessibility audit was done.
  - **A fresh clone:** a full run from a clean clone, including `npm install`, wasn't done. Only the database step was tested from empty.

### Left out because it was outside the brief

These were never part of the job. The brief was one paid plan on two intervals, in test mode, with one user.

- **Accounts and sign-in.** There's a single built-in user.
- **More plans, trials, coupons and discounts.**
- **Tax.** Nigerian VAT at 7.5% isn't calculated or shown. Prices are treated as final.
- **Currencies other than naira.** The money code supports others, but prices, display and proration assume NGN.
- **Invoices as documents.** Payment history exists, but there are no numbered invoices or PDFs.
- **An admin or support screen.** Records are read straight from the database, for example with `npm run db:studio`.
- **Live payments and production hosting.**

### Left out for time

These were identified during the build and deliberately put off, not overlooked.

- **CHECK constraints in the database.** They were written up in Section 4, along with the exact constraints that would close the gap. Adding them needs a table rebuild per table in SQLite, and wasn't done.
- **Showing webhooks that have stopped retrying.** An event that fails 5 times is left in `failed` with no indicator anywhere. Showing these on a developer screen was proposed and not built.
- **Reusing the open Flutterwave link.** Pressing Pay again within a few minutes creates a new checkout and a new link rather than reusing the first. The rate limit caps it, but duplicate `initiated` checkouts still pile up.
- **A committed test suite.** The per-feature scripts weren't turned into permanent tests.
- **Confirming the error screens and the HMAC signature path for real.**
  - **The error screens** were checked through server responses, not in a browser.
  - **The `flutterwave-signature` HMAC check** has only been exercised by the test script, because this Flutterwave account sends `verif-hash`.
- **Cleanup.**
  - **Three legacy columns are still in the schema:** `checkouts.flutterwave_plan_id`, `subscriptions.billing_mode` and `subscriptions.flw_subscription_id`.
  - **The changed init migration** that blocks `prisma migrate dev` was worked around with `migrate diff` plus `migrate deploy`, not fixed.
- **Prorated yearly → monthly switches.** That would need a stored credit balance or refunds. It was scheduled for the end of the paid year instead. That's a defensible design, but it was also chosen because a credit ledger wouldn't fit in the time.
