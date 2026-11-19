# Fieldnote billing slice

A working subscription system on Flutterwave (test keys): one paid plan, **Pro**, sold on two intervals.

| Plan        | Price                          |
| ----------- | ------------------------------ |
| Free        | ₦0                             |
| Pro Monthly | ₦5,000 / month                 |
| Pro Yearly  | ₦50,000 / year (2 months free) |

## Screens

| Route                     | What it is                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `/billing`                | Plan, status, next payment, scheduled switch, cancel / keep Pro, payment history      |
| `/plans`                  | Free, Pro Monthly and Pro Yearly, with the current plan marked                        |
| `/checkout/[plan]`        | New: pay via Flutterwave. Existing: confirm a switch at period end (₦0 today)        |
| `/checkout/return`        | Where Flutterwave sends the customer back: verifies the payment and activates Pro     |

`app/(app)` is the signed-in shell (top bar and settings nav). `app/(focus)` is the distraction-free checkout layout.

## Setup

```bash
npm install                     # also runs `prisma generate`
cp .env.example .env.local      # put your FLWSECK_TEST-… key in .env.local (not .env.example)
npx prisma migrate deploy       # creates data/fieldnote.db with all tables
npm run dev                     # http://localhost:3000
npx prisma studio               # browse the database in your browser
```

## How it works

The app runs its own billing. Flutterwave takes the first payment and saves the card; the app charges that saved card (a token) for renewals.

1. **Subscribe** (`app/(focus)/checkout/actions.ts › startCheckout`): the server prices the plan from `lib/plans.ts`, records a `tx_ref`, and sends the customer to a one-time Flutterwave card checkout.
2. **Return** (`lib/billing.ts › confirmCheckout`): verifies the payment with `verify_by_reference` using our own `tx_ref`, checking status, currency and amount. It then activates Pro once (refreshing is safe) and stores the card token and the email Flutterwave recorded.
3. **Change plan.**
   - **Monthly → yearly, now, prorated** (`lib/proration.ts`, `lib/billing.ts › switchIntervalNow`):
     - **Credit:** what was paid for the month × days left ÷ days in the period, rounded down to the kobo.
     - **Due today:** the yearly price minus the credit.
     - **How days are counted:** in whole calendar days in Lagos time, with today counted as used. The amount therefore stays the same until midnight, and what's shown is what gets charged. The server recalculates it on confirm and refuses if it no longer matches what the customer saw.
     - **Saved card:** charged and verified before the plan changes.
     - **No saved card:** pays through hosted checkout, and the checkout row has `purpose` = `plan_change`.
     - **Pending:** nothing changes until Flutterwave settles it. Settling is done by the billing run or a webhook.
     - **Failed:** nothing changes. The subscription isn't put past due.
     - **On success:** a new yearly period starts at the payment time. The payment has kind `plan_change`, with the breakdown in its `proration` column. A `plan_changed` event is logged with the credit, the amount due and the day counts.
     - **Guard:** the switch is applied only if the subscription is still on the plan and period it was quoted for. Otherwise the payment is kept and logged `needs_review`.
     - **Where it's shown:** on checkout, Billing (both the current plan and payment history) and the return receipt.
   - **Scheduled instead** (`schedulePlanChange`): monthly → yearly can also be scheduled for the end of the period, with nothing to pay today. Yearly → monthly is always scheduled for the end of the paid year and is not prorated, so nothing is wasted or refunded. A scheduled change can be undone with "Keep monthly" or "Keep yearly".
4. **Cancel** (`cancelCurrentSubscription`): no further charges, and Pro stays until the paid period ends. "Keep Pro" resumes it before then. Downgrading to Free is the same thing.
   - **Confirmation:** both "Cancel subscription" and "Don't renew" open a confirm box first, and the server refuses without `confirm=cancel`.
   - **Reason (optional):** after cancelling, Billing (`/billing?cancelled=1`) asks "Mind telling us why?", with the reasons listed in `lib/cancellation.ts` and an optional note of up to 500 characters.
     - Where it's saved: `subscriptions.cancellation_reason`, `cancellation_note` and `cancellation_reason_at`, plus a `cancellation_reason_given` event.
     - Skipping stores nothing, so the column stays empty.
     - One answer per cancellation: the first one is kept.
     - The prompt is only offered within an hour of cancelling.
     - "Keep Pro" clears the columns, and the event history keeps the earlier answer.
5. **Billing run** (`runBillingCycle`): for each subscription whose period has ended:
   - **Cancelled:** it's marked expired.
   - **Active:** the saved card is charged for the next period, on the scheduled plan if there is one.
   - **Failed charge:** the subscription goes `past_due` and the customer pays again through checkout.
   - **Pending charge:** Flutterwave accepted it but hasn't settled it. It's recorded as processing, and later runs re-check it.

   Charge references are worked out from the subscription and period, so a period can't be charged twice.
6. **Running it:** in production, call `POST /api/billing/run` with `Authorization: Bearer $CRON_SECRET` on a schedule, e.g. hourly. In development, use **Test tools → Skip to period end** in the top bar.
7. **Bank transfer = manual renewal:** only card payments give Flutterwave a reusable token. A subscription paid another way (`payment_method` = `bank_transfer`, `ussd`, ...) is never charged automatically: the billing run skips it with no failure. At period end it's `renewal_due`, and Billing shows **Renew**, which opens checkout to pay again. That payment is verified like any checkout and starts a new period.
8. **Renewal due:** Pro ends exactly at the end of the paid period. If the billing run hasn't renewed it by then, the subscription is `renewal_due` (no Pro). Billing shows **Renew now**, which charges the saved card and verifies it like the run does, and **Don't renew**.

9. **Webhooks** (`POST /api/webhooks/flutterwave`): see [Webhooks](#webhooks) below. They speed things up, e.g. settling a pending renewal, or activating Pro when the customer closes the tab before returning. They grant nothing by themselves.

**Entitlement rule:** Pro is only ever granted by a payment the server has verified with Flutterwave: our own `tx_ref`, status, and the exact amount and currency.
- **First payments:** the redirect back from Flutterwave is only a hint. Its `tx_ref` is a lookup key for our own checkout record, which must belong to the signed-in user, and its `status` only picks the message shown. Flutterwave's `transaction_id` in the URL is ignored.
- **The browser:** sends only a plan id. Prices come from the server's catalog.
- **Renewals:** extend the period only after the server-side check. A charge Flutterwave reports as still processing renews Pro (option A, logged as `pending_settlement`). If it later fails, the subscription goes `past_due`.
- **Plan switches and resuming:** never add time beyond what's been paid for.

**Two logs, both append-only:**

- **`payment_logs`**: every stage of every payment attempt as its own row, linked by `tx_ref`:

  | Stage       | When                                                         | `result`                                                                                      |
  | ----------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
  | `initiated` | Checkout created, or the billing run is about to charge the card | —                                                                                         |
  | `verified`  | Every check with Flutterwave, including "still processing" and errors | `successful`, `pending`, `failed`, `cancelled`, `not_found`, `amount_mismatch`, `provider_error` |
  | `fulfilled` | Pro activated or renewed (at most once per `tx_ref`, enforced by a partial unique index) | `active`, or `pending_settlement` for a renewal Flutterwave hasn't settled yet       |
  | `failed`    | The attempt ended without payment                             | The reason, e.g. `customer_cancelled`, `amount_mismatch`, `no_saved_card`, `link_creation_failed` |

  Each row also stores the amount and currency, where it happened (`checkout`, `return_page` or `billing_run`), and Flutterwave's transaction id, status and message. Each payment under **Billing** has an expandable timeline of these steps.
- **`billing_events`**: subscription changes only: started, renewed, past due, plan change scheduled, cancelled or applied, subscription cancelled, resumed or expired, test clock.

Each row is written in the same database transaction as the change it describes. Every charge attempt, including failures, is also a row in `payments`.

**Pending renewals:** a renewal that Flutterwave reports as still processing renews Pro straight away (logged as `fulfilled` / `pending_settlement`). Later billing runs re-check it; if it fails, the subscription goes `past_due`.

## No card details stored

- **Card entry:** card numbers, expiry dates and CVVs are typed only on Flutterwave's hosted page. They never reach this app.
- **What is stored, on purpose:**
  - `subscriptions.card_token`: Flutterwave's reference for the saved card. It only works with our secret key, and renewals need it.
  - `card_brand` and `card_last4`: used for "Visa ending 4242".
- **Webhooks are stripped before saving** (`redactWebhookPayload` in `lib/webhooks.ts`). A charge webhook includes the card's first 6 and last 4 digits, expiry and issuer, plus customer details. `webhook_events.payload` keeps only the event type and `data.id`, `tx_ref`, `flw_ref`, status, amount, currency, payment type and created_at. The signature is still checked on the original body first.
- **Checking:** `npm run check:card-data` scans `data/fieldnote.db` and every backup in `data/`. It looks for:
  - card numbers: 13–19 digits starting 2–6 that pass the Luhn checksum;
  - card fields such as `first_6digits`, `expiry` or `cvv`;
  - column names that look like card data.

  It exits 1 if it finds any. `-- --fix` also strips stored webhook payloads.
- **Testing a webhook:** `npm run webhook:test -- --with-card` sends a webhook carrying Flutterwave's test card details, to check none of it is stored.

## Error handling

The user never ends up on a blank page or a 404 anywhere in the payment path.

- **Bad links redirect:**
  - an unknown plan (`/checkout/pro_weekly`) goes to `/plans` with the notice "That plan isn't available";
  - `/checkout` on its own goes to `/plans`;
  - anything deeper than a checkout or return URL goes back to the real page, keeping the query.
- **Error pages:**
  - `app/(app)/error.tsx` covers Billing and Plans and keeps the app's navigation around the error;
  - `app/(focus)/error.tsx` covers checkout and the return page;
  - `app/error.tsx` covers a failure in those layouts themselves;
  - `app/global-error.tsx` covers a failure in the root layout.
  
  Each one offers Try again, Go to Billing, View plans and a reference code. The reference is `error.digest`, which matches the server log.
- **Actions never throw:** every server action runs through `guard` (`lib/action-guard.ts`), which logs `[action] <name> failed` and returns an inline message. Redirects pass through `unstable_rethrow`. Actions that may have charged a card (switch now, renew now, skip to period end) say "Check Billing before trying again".
- **Return page:** an unexpected failure while confirming shows "We couldn't confirm your payment" with Try again. Repeating the confirmation is safe. `loading.tsx` shows "Confirming your payment…" straight away.
- **Other unknown URLs:** `app/not-found.tsx`, with links to Billing and Plans.
- **Seeing the error screens (development only):** open **Test tools → Trigger an error** and pick a point:
  - Billing page
  - Checkout page
  - Confirming a payment
  - Buttons (actions)
  - App layout (top bar)
  - Root layout

  Choosing one sets a 10-minute cookie (`fn_dev_fault`) through `GET /api/dev/fault?point=…` and opens the page where it shows. `?clear=1`, the **Turn off test error** button, or the link on any error screen switches it off. It does nothing in production builds, and the route returns 403 there. The code is in `lib/dev-fault-points.ts` and `lib/dev-faults.ts`.

## Rate limiting

Starting a checkout is rate limited (`lib/rate-limit.ts`). This covers `startCheckout` and the prorated `switchNow`. The check runs first, before anything is written and before Flutterwave is called:

| Key | Limit |
|---|---|
| Per user (`checkout:user:<id>`) | 5 per 10 minutes and 20 per 24 hours |
| Per IP (`checkout:ip:<address>`) | 10 per 10 minutes. The IP comes from `cf-connecting-ip`, otherwise the first `x-forwarded-for` entry |
| Saved-card charges when switching now (`card_charge:user:<id>`) | 3 per 10 minutes |

- **When refused:** the customer sees "Too many payment attempts. Try again in N minutes." The server logs `[rate-limit] refused`.
- **Atomic:** each check is one SQL statement that inserts a row only while under every limit. Simultaneous requests can't get past the limit.
- **What counts:** only attempts that were allowed. If one limit refuses a request, the rows its other limits recorded are removed.
- **Where it's stored:** in the database, so limits survive restarts and hold across server processes.

## Webhooks

`app/api/webhooks/flutterwave/route.ts` runs these steps in order:

1. **Raw body.** It's read as text before anything is parsed (max 256 KB).
2. **Signature, before any processing.** Checked by `lib/webhook-signature.ts` against `FLW_WEBHOOK_SECRET_HASH`, using constant-time comparisons:
   - `flutterwave-signature` (base64 HMAC-SHA256 of the raw body) must match if Flutterwave sends it. A valid `verif-hash` doesn't excuse a bad HMAC.
   - Otherwise `verif-hash` must equal the secret hash.
   - A missing, wrong or tampered signature gets a **401**. Nothing is parsed or stored.
   - If `FLW_WEBHOOK_SECRET_HASH` isn't set, every request gets a **503**.
3. **Store once, keyed on the provider reference.** `event_key` = `flutterwave:<event type>:<Flutterwave transaction id>` (falling back to `flw_ref`), and it's unique.
   - Any repeat for the same transaction, with any status or body, is recorded once: it only increments `deliveries` and sets `last_delivered_at`.
   - An event without a reference gets a **400** and isn't stored.
   - The reply is a 200 with `duplicate: true|false`.
4. **Process after the response** (`lib/webhooks.ts`, via `after()`):
   - The payload's `tx_ref` is used only to find our own checkout or pending renewal. Its status and amount are ignored.
   - The payment is then re-verified with Flutterwave by the same code as the return page and billing run (`verifyCheckout`, `settlePending`).
   - Each check is logged in `payment_logs` with source `webhook`.
   - Only `charge.completed` is handled. Unknown references and other events are stored as `ignored`.
5. **Acted on once.** Processing is claimed with a single conditional update (`received`/`failed` → `processing`, stamped with `claimed_at`), so when deliveries or workers race, exactly one runs it and the rest are skipped. The result is written only by the worker that still holds the claim.
   - The database rules on payments and Pro are the second guard: a unique `transaction_id`, a once-only checkout claim, one `fulfilled` row per `tx_ref`, and a pending renewal settled only once.
6. **Retries.** `POST /api/billing/run` picks up failed events, events whose processing never ran, and claims stuck for over 5 minutes, up to 5 attempts.

**Setup:**
1. `.env.local` has a generated `FLW_WEBHOOK_SECRET_HASH`. In the Flutterwave dashboard (test mode) go to **Settings → Webhooks** and paste the **same value** as the secret hash.
2. Flutterwave can't reach `localhost`. To receive real webhooks locally, run a tunnel (e.g. `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`). Set `https://<tunnel-host>/api/webhooks/flutterwave` as the webhook URL.
3. Without a tunnel, send signed test events with:
   ```bash
   npm run webhook:test -- --tx-ref <tx_ref>              # valid HMAC signature
   npm run webhook:test -- --sign verif-hash --tx-ref <tx_ref>
   npm run webhook:test -- --sign bad                     # expect 401
   npm run webhook:test -- --sign none                    # expect 401
   ```
   Sending `--status successful` for an unpaid `tx_ref` grants nothing, because the app re-verifies with Flutterwave.

**Flutterwave sandbox quirks:**
- Saved-card charges stay `pending` (processor response "Approved") and only settle later, so renewals show as *Processing* locally. With a tunnel and the webhook URL set, Flutterwave's webhook prompts the app to re-check and settle them. The billing run also re-checks them.
- Saved-card charges require a public `https` `redirect_url` and reject `localhost`. Locally the app uses the reserved `example.com` domain; set `FLW_CHARGE_REDIRECT_URL` or a public `https` `APP_URL` in production.

Flutterwave payment plans (`billing_mode = provider_plan`, from an earlier version) are no longer supported. Such a row is never rolled forward: it ends at its stored period end and can't renew, because it has no saved card. Subscribe again to get one.

## Database

Prisma 7 + SQLite (better-sqlite3 driver adapter), at `data/fieldnote.db` (git-ignored; set by `DATABASE_URL`).
Schema: `prisma/schema.prisma` · migrations: `prisma/migrations` · client: `lib/db.ts` · queries: `lib/store.ts`.

| Table           | Holds                                                                                   |
| --------------- | --------------------------------------------------------------------------------------- |
| `users`         | The signed-in user (seeded from `DEMO_USER_NAME` / `DEMO_USER_EMAIL`)                   |
| `checkouts`     | Every checkout attempt: `tx_ref` → plan, amount, `initiated` / `completed` / `failed`   |
| `subscriptions` | `active`, `cancelled` (runs to period end) or `replaced`; at most one current per user |
| `payments`      | Every charge (paid, pending or failed), unique on `tx_ref` and Flutterwave `transaction_id` |
| `payment_logs`  | Every stage of every payment attempt: initiated, verified, fulfilled, failed            |
| `billing_events`| Subscription lifecycle: started, renewed, plan changes, cancel, resume, expiry          |
| `webhook_events`| Signature-verified Flutterwave webhooks, stored once, with processing status and result |
| `rate_limit_hits`| One row per allowed checkout attempt or saved-card charge, for rate limiting (kept 24 hours) |

- **Money** is a whole number of minor units plus its currency code, everywhere: `Money = { minor, currency }` in code (`lib/money.ts`), and `amount_minor` (integer) + `currency` columns in every table. Plan prices are kobo (`money(5_000_00, "NGN")`).
  - Naira appears in only two places: the Flutterwave client (`lib/flutterwave.ts`, whose API takes major units; `toMajorUnits` going out, `transactionAmount` coming back) and display (`formatMoney`).
  - A payment counts only if Flutterwave's amount, converted to minor units, **exactly** equals what we expected, in the same currency.
  - The helpers reject fractional minor units and mixed-currency arithmetic.
- **Changing the schema:** edit `prisma/schema.prisma`, then run `npm run db:migrate -- --name what_changed`.
  - Known issue: `prisma migrate dev` reports that the init migration file "was modified after it was applied" and offers to wipe the database. Don't accept. The file still produces the same schema. Instead write the migration (`npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`), then apply it with `npx prisma migrate deploy` and run `npx prisma generate`.
- The rule "at most one current subscription per user" is a partial unique index. Prisma can't express it in the schema, so it's hand-written at the bottom of the init migration.
- Activation (new subscription + payment + completed checkout + replacing the old plan) runs in one `prisma.$transaction`.
- **Prisma Studio:** `npx prisma studio` (or `npm run db:studio`). `prisma.config.ts` rewrites the SQLite URL to `file://…` for Studio only, working around a Studio 7.10 URL-parsing bug.
- **Reset the flow:** the **Reset flow** button in the top bar deletes the user's payments, subscriptions, checkouts and logs, and sends them to Plans on Free. It shows only in development, or when `ENABLE_DEMO_RESET=true` (logic in `lib/billing.ts › resetDemoAccount`).
- **Wipe the whole database:** `npx prisma migrate reset` (drops all data and reapplies migrations).
