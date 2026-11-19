import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getBillingState, quoteSwitchNow } from "@/lib/billing";
import { maybeFail } from "@/lib/dev-faults";
import {
  addInterval,
  formatDate,
  formatMoney,
  intervalAdjective,
  intervalNoun,
  isPaidPlanId,
  PLANS,
  PRODUCT_NAME,
  YEARLY_SAVINGS,
} from "@/lib/plans";
import { getCurrentUser, hasPendingPlanChange } from "@/lib/store";
import { CheckoutForm } from "./CheckoutForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Checkout" };

function BackLink() {
  return (
    <Link href="/plans" className="back-link">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M10 3.5L5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Plans
    </Link>
  );
}

export default async function CheckoutPage({ params }: { params: Promise<{ plan: string }> }) {
  const { plan: planParam } = await params;
  await maybeFail("checkout_page"); // development-only test error
  // Unknown plan in the link: back to Plans with a note, never a 404.
  if (!isPaidPlanId(planParam)) redirect("/plans?notice=unknown_plan");

  const user = getCurrentUser();
  const state = await getBillingState(user.id);
  const plan = PLANS[planParam];
  const interval = plan.interval!;
  const per = intervalNoun(interval);

  // Renewal due with a saved card: it's charged from Billing, not through a new checkout.
  // Manual renewals (no saved card) pay here.
  if (state.status === "renewal_due" && !state.record.renewsManually) redirect("/billing");

  /* ---------- monthly -> yearly: switch now and pay the prorated difference ---------- */
  const quote = quoteSwitchNow(state, planParam);
  if (quote.ok && state.status === "active") {
    const p = quote.proration;
    const current = PLANS[state.planId];
    const newEnd = addInterval(new Date(), interval);
    const scheduled = state.pendingPlanId === planParam;
    const processing = await hasPendingPlanChange(state.record.id);
    const manual = state.record.renewsManually;

    return (
      <div className="checkout">
        <section className="checkout-summary" aria-labelledby="summary-title">
          <BackLink />
          <p className="eyebrow" id="summary-title">
            Switch to {PRODUCT_NAME} Pro · {intervalAdjective(interval)}
          </p>
          <p className="checkout-amount">
            <span className="checkout-amount-value">{formatMoney(p.due)}</span>
            <span className="checkout-amount-per">
              due
              <br />
              today
            </span>
          </p>

          <dl className="ledger">
            <div className="ledger-row">
              <dt>
                <span className="ledger-item">Pro {intervalAdjective(interval).toLowerCase()}</span>
                <span className="ledger-sub">
                  Today to {formatDate(newEnd)}
                </span>
              </dt>
              <dd>{formatMoney(p.newPrice)}</dd>
            </div>
            <div className="ledger-row">
              <dt>
                <span className="ledger-item">Unused {intervalAdjective(current.interval!).toLowerCase()} time</span>
                <span className="ledger-sub">
                  {p.daysLeft} of {p.daysInPeriod} days left, until {formatDate(state.renewsOn)}
                </span>
              </dt>
              <dd className="ledger-credit">−{formatMoney(p.credit)}</dd>
            </div>
            <div className="ledger-row ledger-total">
              <dt>Due today</dt>
              <dd>{formatMoney(p.due)}</dd>
            </div>
          </dl>

          <p className="summary-note">
            Credit = {formatMoney(state.record.amount)} × {p.daysLeft}/{p.daysInPeriod} days, rounded down to the kobo. Days are
            counted in whole days and today counts as used, so this amount holds until midnight.
          </p>
        </section>

        <section className="checkout-pay" aria-labelledby="pay-title">
          <h1 className="checkout-title" id="pay-title">
            Switch to yearly now
          </h1>
          <p className="change-note">
            You get credit for the {p.daysLeft} monthly days you haven&rsquo;t used. Pro switches to yearly as soon as the
            payment is confirmed. If it doesn&rsquo;t go through, nothing changes.
          </p>

          <dl className="facts facts-stacked">
            <div>
              <dt>Payment method</dt>
              <dd className="truncate">
                {state.record.card
                  ? `${state.record.card.brand} ending ${state.record.card.last4}`
                  : manual
                    ? "Pay on Flutterwave’s page"
                    : "Card on file"}
              </dd>
            </div>
            <div>
              <dt>Next payment</dt>
              <dd>
                {formatDate(newEnd)} · {formatMoney(plan.price)}
                {manual ? " · pay manually" : ""}
              </dd>
            </div>
          </dl>

          {processing ? (
            <p className="notice" role="status">
              Your switch to yearly is already being processed. Check Billing for its status.
            </p>
          ) : (
            <CheckoutForm
              planId={planParam}
              mode="switch"
              quotedDue={p.due.minor}
              label={`${manual ? "Continue to pay" : "Pay"} ${formatMoney(p.due)} and switch`}
              fallbackLabel={`Pay ${formatMoney(p.due)} on Flutterwave instead`}
            />
          )}

          {scheduled ? (
            <p className="fine-print">
              Already scheduled for {formatDate(state.renewsOn)}. Paying now switches you today instead.
            </p>
          ) : (
            <CheckoutForm planId={planParam} mode="change" variant="secondary" label={`Switch on ${formatDate(state.renewsOn)} instead · nothing today`} />
          )}

          <p className="fine-print">
            {manual
              ? `You'll finish paying on Flutterwave's secure page. After that, ${formatMoney(plan.price)} is due every ${per}.`
              : `We'll charge your saved card ${formatMoney(p.due)} now, then ${formatMoney(plan.price)} every ${per} until you cancel.`}
          </p>
        </section>
      </div>
    );
  }

  /* ---------- existing subscriber: change at period end, nothing to pay today ---------- */
  if (state.status === "active" || state.status === "cancelling") {
    const isCurrentPlan = state.planId === planParam;
    const pending = state.status === "active" ? state.pendingPlanId : null;
    // Nothing to change: already on this plan with nothing scheduled, or this change is already scheduled.
    if (state.status === "active" && ((isCurrentPlan && !pending) || pending === planParam)) redirect("/billing");

    const effectiveOn = state.status === "active" ? state.renewsOn : state.endsOn;
    const current = PLANS[state.planId];
    const title = isCurrentPlan
      ? state.status === "cancelling"
        ? `Keep Pro ${intervalAdjective(interval).toLowerCase()}`
        : `Stay on ${intervalAdjective(interval).toLowerCase()}`
      : `Switch to ${intervalAdjective(interval).toLowerCase()} billing`;
    const note = isCurrentPlan
      ? state.status === "cancelling"
        ? "Your cancellation is undone. Pro carries on and renews as normal."
        : `Your scheduled switch is cancelled. You stay on ${intervalAdjective(interval).toLowerCase()} billing.`
      : `You keep Pro ${intervalAdjective(current.interval!).toLowerCase()} until ${formatDate(effectiveOn)}. Then ${intervalAdjective(interval).toLowerCase()} billing starts. Same Pro features throughout.`;

    return (
      <div className="checkout">
        <section className="checkout-summary" aria-labelledby="summary-title">
          <BackLink />
          <p className="eyebrow" id="summary-title">
            {PRODUCT_NAME} Pro · {intervalAdjective(interval)}
          </p>
          <p className="checkout-amount">
            <span className="checkout-amount-value">{formatMoney(PLANS.free.price)}</span>
            <span className="checkout-amount-per">
              due
              <br />
              today
            </span>
          </p>

          <dl className="ledger">
            <div className="ledger-row">
              <dt>
                <span className="ledger-item">Now until {formatDate(effectiveOn)}</span>
                <span className="ledger-sub">
                  Pro {intervalAdjective(current.interval!).toLowerCase()}, already paid
                </span>
              </dt>
              <dd>{formatMoney(PLANS.free.price)}</dd>
            </div>
            <div className="ledger-row">
              <dt>
                <span className="ledger-item">From {formatDate(effectiveOn)}</span>
                <span className="ledger-sub">Pro {intervalAdjective(interval).toLowerCase()}, then every {per}</span>
              </dt>
              <dd>{formatMoney(plan.price)}</dd>
            </div>
            {interval === "yearly" && (
              <div className="ledger-row ledger-row-muted">
                <dt>Compared with 12 monthly payments</dt>
                <dd>Save {formatMoney(YEARLY_SAVINGS)}</dd>
              </div>
            )}
            <div className="ledger-row ledger-total">
              <dt>Due today</dt>
              <dd>{formatMoney(PLANS.free.price)}</dd>
            </div>
          </dl>
        </section>

        <section className="checkout-pay" aria-labelledby="pay-title">
          <h1 className="checkout-title" id="pay-title">
            {title}
          </h1>
          <p className="change-note">{note}</p>

          <dl className="facts facts-stacked">
            <div>
              <dt>Payment method</dt>
              <dd className="truncate">
                {state.record.card ? `${state.record.card.brand} ending ${state.record.card.last4}` : "Card on file"}
              </dd>
            </div>
            <div>
              <dt>Next charge</dt>
              <dd>
                {formatDate(effectiveOn)} · {formatMoney(plan.price)}
              </dd>
            </div>
          </dl>

          <CheckoutForm planId={planParam} mode="change" label={isCurrentPlan ? title : "Confirm switch"} />

          <p className="fine-print">
            We&rsquo;ll charge your saved card {formatMoney(plan.price)} on {formatDate(effectiveOn)} and every {per} after,
            until you cancel. You can change or cancel anytime before then from Billing.
          </p>
        </section>
      </div>
    );
  }

  /* ---------- new subscription: pay now through Flutterwave ---------- */
  const firstRenewal = addInterval(new Date(), interval);

  return (
    <div className="checkout">
      <section className="checkout-summary" aria-labelledby="summary-title">
        <BackLink />

        <p className="eyebrow" id="summary-title">
          Subscribe to {PRODUCT_NAME} Pro
        </p>
        <p className="checkout-amount">
          <span className="checkout-amount-value">{formatMoney(plan.price)}</span>
          <span className="checkout-amount-per">
            per
            <br />
            {per}
          </span>
        </p>

        <dl className="ledger">
          <div className="ledger-row">
            <dt>
              <span className="ledger-item">{PRODUCT_NAME} Pro</span>
              <span className="ledger-sub">Billed {interval === "monthly" ? "monthly" : "yearly"}</span>
            </dt>
            <dd>{formatMoney(plan.price)}</dd>
          </div>
          {interval === "yearly" && (
            <div className="ledger-row ledger-row-muted">
              <dt>Compared with 12 monthly payments</dt>
              <dd>Save {formatMoney(YEARLY_SAVINGS)}</dd>
            </div>
          )}
          <div className="ledger-row ledger-total">
            <dt>Due today</dt>
            <dd>{formatMoney(plan.price)}</dd>
          </div>
        </dl>

        {state.status === "past_due" && (
          <p className="summary-note">This restarts Pro today and replaces the renewal that didn&rsquo;t go through.</p>
        )}
        {state.status === "renewal_due" && (
          <p className="summary-note">This renews your Pro plan. Your next period starts when the payment is confirmed.</p>
        )}
      </section>

      <section className="checkout-pay" aria-labelledby="pay-title">
        <h1 className="checkout-title" id="pay-title">
          Confirm and pay
        </h1>

        <dl className="facts facts-stacked">
          <div>
            <dt>Account</dt>
            <dd className="truncate">{user.email}</dd>
          </div>
          <div>
            <dt>First renewal</dt>
            <dd>
              {formatDate(firstRenewal)} · {formatMoney(plan.price)}
            </dd>
          </div>
        </dl>

        <CheckoutForm planId={planParam} label={`Pay ${formatMoney(plan.price)}`} />

        <p className="fine-print">
          You&rsquo;ll finish paying on Flutterwave&rsquo;s secure page. Your card is saved and charged{" "}
          {formatMoney(plan.price)} every {per} until you cancel. You can cancel anytime from Billing.
        </p>

        <p className="secure-line">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path d="M5.5 7V5.5a2.5 2.5 0 015 0V7" fill="none" stroke="currentColor" strokeWidth="1.3" />
          </svg>
          Payments processed by Flutterwave
        </p>
      </section>
    </div>
  );
}
