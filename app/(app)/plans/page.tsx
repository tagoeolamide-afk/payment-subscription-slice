import type { Metadata } from "next";
import Link from "next/link";
import { getBillingState, type BillingState } from "@/lib/billing";
import {
  formatDate,
  formatMoney,
  formatShortDate,
  FREE_FEATURES,
  intervalAdjective,
  intervalNoun,
  PLANS,
  PRO_FEATURES,
  YEARLY_PER_MONTH,
  YEARLY_SAVINGS,
  type PaidPlanId,
} from "@/lib/plans";
import { getCurrentUser } from "@/lib/store";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Plans" };

const shortDay = (d: Date) => formatShortDate(d).replace(/ \d{4}$/, "");

function Lede({ state }: { state: BillingState }) {
  if (state.status === "free") {
    return <>You&rsquo;re on Free. Upgrade to Pro for unlimited notebooks and room to grow.</>;
  }
  if (state.status === "past_due") {
    return <>Your last Pro payment didn&rsquo;t go through, so you&rsquo;re on Free features. Pay to pick up where you left off.</>;
  }
  if (state.status === "renewal_due") {
    return <>Your Pro renewal was due on {formatDate(state.dueSince)}. Renew from Billing to pick up where you left off.</>;
  }
  if (state.status === "cancelling") {
    return <>Your Pro plan ends on {formatDate(state.endsOn)}. Keep it, or switch billing, at any time before then.</>;
  }
  const interval = PLANS[state.planId].interval!;
  if (state.pendingPlanId) {
    const next = PLANS[state.pendingPlanId];
    return (
      <>
        You&rsquo;re on Pro, billed {interval === "monthly" ? "monthly" : "yearly"}. On {formatDate(state.renewsOn)} you
        switch to {next.interval === "monthly" ? "monthly" : "yearly"} billing at {formatMoney(next.price)}.
      </>
    );
  }
  return (
    <>
      You&rsquo;re on Pro, billed {interval === "monthly" ? "monthly" : "yearly"}. Next payment on{" "}
      {formatDate(state.renewsOn)}.
    </>
  );
}

function FeatureList({ items, columns = 1 }: { items: string[]; columns?: 1 | 2 }) {
  return (
    <ul className={`features${columns === 2 ? " features-2" : ""}`}>
      {items.map((f) => (
        <li key={f}>
          <svg viewBox="0 0 16 16" aria-hidden="true" className="tick">
            <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {f}
        </li>
      ))}
    </ul>
  );
}

function IntervalOption({ planId, state }: { planId: PaidPlanId; state: BillingState }) {
  const plan = PLANS[planId];
  const interval = plan.interval!;
  const adj = intervalAdjective(interval).toLowerCase();
  const subscribed = state.status === "active" || state.status === "cancelling";
  const isThisPlan = subscribed && state.planId === planId;
  const pending = state.status === "active" ? state.pendingPlanId : null;
  const href = `/checkout/${planId}`;

  let tag: React.ReactNode = interval === "yearly" ? <span className="tag tag-save">2 months free</span> : null;
  let action: React.ReactNode;
  let highlighted = false;

  if (state.status === "renewal_due") {
    action = (
      <Link href="/billing" className={`btn btn-block ${state.planId === planId ? "btn-primary" : "btn-secondary"}`}>
        {state.planId === planId ? "Renew on Billing" : "Go to Billing"}
      </Link>
    );
  } else if (!subscribed) {
    action = (
      <Link href={href} className="btn btn-primary btn-block">
        Choose {adj}
      </Link>
    );
  } else if (state.status === "cancelling") {
    if (isThisPlan) {
      highlighted = true;
      tag = <span className="tag tag-ending">Ends {shortDay(state.endsOn)}</span>;
      action = (
        <Link href={href} className="btn btn-primary btn-block">
          Keep Pro {adj}
        </Link>
      );
    } else {
      action = (
        <Link href={href} className="btn btn-secondary btn-block">
          Switch to {adj}
        </Link>
      );
    }
  } else if (isThisPlan) {
    highlighted = true;
    if (pending) {
      tag = <span className="tag tag-ending">Until {shortDay(state.renewsOn)}</span>;
      action = (
        <Link href={href} className="btn btn-secondary btn-block">
          Stay on {adj}
        </Link>
      );
    } else {
      tag = <span className="tag tag-current">Current</span>;
      action = (
        <span className="btn btn-quiet btn-block" aria-disabled="true">
          Current plan
        </span>
      );
    }
  } else if (pending === planId) {
    tag = <span className="tag tag-current">Starts {shortDay(state.renewsOn)}</span>;
    // Monthly -> yearly can still switch now, prorated.
    action =
      interval === "yearly" ? (
        <Link href={href} className="btn btn-secondary btn-block">
          Switch now instead
        </Link>
      ) : (
        <span className="btn btn-quiet btn-block" aria-disabled="true">
          Scheduled
        </span>
      );
  } else {
    action = (
      <Link href={href} className="btn btn-primary btn-block">
        Switch to {adj}
      </Link>
    );
  }

  return (
    <div className={`interval${highlighted ? " is-current" : ""}`} aria-current={highlighted ? "true" : undefined}>
      <div className="interval-head">
        <span className="interval-name">{intervalAdjective(interval)}</span>
        {tag}
      </div>
      <p className="price">
        <span className="price-amount">{formatMoney(plan.price)}</span>
        <span className="price-per">/ {intervalNoun(interval)}</span>
      </p>
      <p className="price-note">
        {interval === "yearly"
          ? `${formatMoney(YEARLY_PER_MONTH)} a month, billed once a year. Save ${formatMoney(YEARLY_SAVINGS)}.`
          : "Billed every month. Cancel anytime."}
      </p>
      {action}
    </div>
  );
}

export default async function PlansPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { notice } = await searchParams;
  const user = getCurrentUser();
  const state = await getBillingState(user.id);
  const onFree = state.status === "free" || state.status === "past_due" || state.status === "renewal_due";

  return (
    <>
      <header className="page-head">
        <h1 className="page-title">Plans</h1>
        <p className="page-lede">
          <Lede state={state} />
        </p>
      </header>

      {notice === "unknown_plan" && (
        <p className="notice notice-info" role="status">
          That plan isn&rsquo;t available. Choose one below.
        </p>
      )}

      <div className="plans">
        <section className={`plan plan-free${onFree ? " is-current" : ""}`} aria-labelledby="plan-free">
          <div className="plan-head">
            <h2 id="plan-free" className="plan-name">
              Free
            </h2>
            {onFree && <span className="tag tag-current">Current</span>}
          </div>
          <p className="plan-desc">For keeping a few notebooks in order.</p>
          <p className="price">
            <span className="price-amount">{formatMoney(PLANS.free.price)}</span>
          </p>
          <p className="price-note">No card needed.</p>
          {onFree ? (
            <span className="btn btn-quiet btn-block" aria-disabled="true">
              Current plan
            </span>
          ) : state.status === "active" ? (
            <Link href="/billing?cancel=1" className="btn btn-secondary btn-block">
              Downgrade
            </Link>
          ) : (
            <span className="btn btn-quiet btn-block" aria-disabled="true">
              From {formatDate(state.endsOn)}
            </span>
          )}
          <FeatureList items={FREE_FEATURES} />
        </section>

        <section className="plan plan-pro" aria-labelledby="plan-pro">
          <div className="plan-head">
            <h2 id="plan-pro" className="plan-name">
              Pro
            </h2>
          </div>
          <p className="plan-desc">
            The same plan on either schedule. Switch to yearly now and pay only the difference: unused monthly days are
            credited. Switching to monthly starts when your paid year ends.
          </p>

          <div className="intervals">
            <IntervalOption planId="pro_monthly" state={state} />
            <IntervalOption planId="pro_yearly" state={state} />
          </div>

          <p className="features-heading">Everything in Free, plus</p>
          <FeatureList items={PRO_FEATURES} columns={2} />
        </section>
      </div>
    </>
  );
}
