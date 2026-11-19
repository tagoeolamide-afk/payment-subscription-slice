import type { Metadata } from "next";
import Link from "next/link";
import { getBillingState, quoteSwitchNow } from "@/lib/billing";
import { maybeFail } from "@/lib/dev-faults";
import { formatDate, formatMoney, formatShortDate, intervalAdjective, intervalNoun, PLANS } from "@/lib/plans";
import { getCurrentUser, getRecentCancellation, hasPendingPlanChange, listPaymentLogs, listPayments, type Payment, type SubscriptionRecord } from "@/lib/store";
import { keepPlan, renewPlan, resumePlan } from "./actions";
import { CancelControl } from "./CancelControl";
import { CancellationReasonPrompt } from "./CancellationReasonPrompt";
import { InlineAction } from "./InlineAction";
import { PaymentTimeline } from "./PaymentTimeline";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Billing" };

const METHOD_LABELS: Record<string, string> = { bank_transfer: "Bank transfer", ussd: "USSD", account: "Bank account" };

function cardLabel(record: SubscriptionRecord) {
  if (record.card) return `${record.card.brand} ending ${record.card.last4}`;
  if (record.paymentMethod) return METHOD_LABELS[record.paymentMethod] ?? record.paymentMethod.replace(/_/g, " ");
  return record.hasCardToken ? "Card on file" : "No saved card";
}

function PlanHeading({ record, children }: { record: SubscriptionRecord; children: React.ReactNode }) {
  return (
    <div className="panel-head">
      <div>
        <p className="eyebrow">Current plan</p>
        <h2 className="panel-title" id="current-plan">
          Pro <span className="panel-title-sub">{intervalAdjective(PLANS[record.planId].interval!)}</span>
        </h2>
      </div>
      {children}
    </div>
  );
}

function Status({ tone, label }: { tone: "active" | "ending" | "failed"; label: string }) {
  return (
    <span className={`status status-${tone}`}>
      <span className="status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

function describe(p: Payment): string {
  if (p.kind === "renewal") return "Renewal";
  if (p.kind === "plan_change") return "Switch from monthly";
  return "First payment";
}

const NOTICES: Record<string, { tone: "success" | "info"; text: string }> = {
  yearly: { tone: "success", text: "You're on yearly billing. Your prorated payment went through." },
  processing: {
    tone: "info",
    text: "Flutterwave is still processing your payment. You'll switch to yearly as soon as it's confirmed; until then nothing changes.",
  },
};

export default async function BillingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  await maybeFail("billing_page"); // development-only test error
  const switched = sp.switched;
  const openCancel = sp.cancel === "1";
  const justCancelled = sp.cancelled === "1";
  const thanked = sp.reason === "thanks";
  const notice = typeof switched === "string" ? NOTICES[switched] : undefined;
  const user = getCurrentUser();
  const [state, payments, logs] = await Promise.all([
    getBillingState(user.id),
    listPayments(user.id),
    listPaymentLogs(user.id),
  ]);

  // Optional "why did you cancel?" prompt: once, right after cancelling, if not answered yet.
  const recent = justCancelled ? await getRecentCancellation(user.id) : null;
  const showReasonPrompt = Boolean(recent && !recent.answered);
  const cancelledHeadline =
    state.status === "cancelling"
      ? `You've cancelled. Pro stays on until ${formatDate(state.endsOn)}.`
      : "You've cancelled. Your account is now on Free.";

  let panel: React.ReactNode;

  if (state.status === "free") {
    panel = (
      <>
        <div className="panel-head">
          <div>
            <p className="eyebrow">Current plan</p>
            <h2 className="panel-title" id="current-plan">
              Free
            </h2>
          </div>
        </div>
        <p className="panel-copy">
          Up to 3 notebooks and 1 GB of storage. Pro removes the limits from {formatMoney(PLANS.pro_monthly.price)} a
          month.
        </p>
        <div className="panel-foot">
          <Link href="/plans" className="btn btn-primary">
            Upgrade to Pro
          </Link>
        </div>
      </>
    );
  } else if (state.status === "past_due") {
    const plan = PLANS[state.planId];
    panel = (
      <>
        <PlanHeading record={state.record}>
          <Status tone="failed" label="Payment failed" />
        </PlanHeading>
        <p className="panel-copy">
          We couldn&rsquo;t charge your {cardLabel(state.record)} for the renewal on{" "}
          {formatDate(state.record.currentPeriodEnd)}. Pro is paused until the payment goes through.
        </p>
        <div className="panel-foot">
          <Link href={`/checkout/${state.planId}`} className="btn btn-primary">
            Pay {formatMoney(plan.price)}
          </Link>
          <Link href="/plans" className="btn btn-secondary">
            Choose a different plan
          </Link>
        </div>
      </>
    );
  } else if (state.status === "renewal_due") {
    const next = PLANS[state.pendingPlanId ?? state.planId];
    panel = (
      <>
        <PlanHeading record={state.record}>
          <Status tone="ending" label="Renewal due" />
        </PlanHeading>
        {state.record.renewsManually ? (
          <p className="panel-copy">
            Your paid period ended on {formatDate(state.dueSince)}. You paid by {cardLabel(state.record).toLowerCase()}, so
            renewals aren&rsquo;t automatic. Pay {formatMoney(next.price)} for the next {intervalNoun(next.interval!)} to
            continue Pro.
          </p>
        ) : (
          <p className="panel-copy">
            Your paid period ended on {formatDate(state.dueSince)}. Pro is paused until the renewal payment is confirmed.
            Renewing charges your {cardLabel(state.record)} {formatMoney(next.price)} for the next{" "}
            {intervalNoun(next.interval!)}
            {state.pendingPlanId ? `, on ${intervalAdjective(next.interval!).toLowerCase()} billing as you scheduled` : ""}.
          </p>
        )}
        <div className="panel-foot">
          {state.record.renewsManually ? (
            <Link href={`/checkout/${next.id}`} className="btn btn-primary">
              Renew · {formatMoney(next.price)}
            </Link>
          ) : (
            <InlineAction
              action={renewPlan}
              label={`Renew now · ${formatMoney(next.price)}`}
              pendingLabel="Confirming payment…"
              variant="primary"
            />
          )}
          <CancelControl
            mode="due"
            accessUntil={formatDate(state.dueSince)}
            amount={formatMoney(next.price)}
            droppedChange={
              state.pendingPlanId
                ? `Your scheduled switch to ${intervalAdjective(next.interval!).toLowerCase()} billing is cancelled too.`
                : undefined
            }
            startOpen={openCancel}
          />
        </div>
      </>
    );
  } else {
    const { record } = state;
    const plan = PLANS[record.planId];
    const interval = plan.interval!;
    const cancelling = state.status === "cancelling";
    const date = cancelling ? state.endsOn : state.renewsOn;
    const pending = state.status === "active" && state.pendingPlanId ? PLANS[state.pendingPlanId] : null;
    const nextAmount = pending ? pending.price : record.amount;
    // Monthly -> yearly can switch now for the prorated difference.
    const quote = quoteSwitchNow(state, "pro_yearly");
    const switchProcessing = quote.ok && (await hasPendingPlanChange(record.id));

    panel = (
      <>
        <PlanHeading record={record}>
          {cancelling ? <Status tone="ending" label="Cancelled" /> : <Status tone="active" label="Active" />}
        </PlanHeading>

        <dl className="facts">
          <div>
            <dt>Price</dt>
            <dd className="num">
              {formatMoney(record.amount)} / {intervalNoun(interval)}
            </dd>
          </div>
          <div>
            <dt>{cancelling ? "Pro ends on" : record.renewsManually ? "Renewal due" : "Next payment"}</dt>
            <dd>
              {formatDate(date)}
              {!cancelling && (
                <span className="dd-sub num">
                  {formatMoney(nextAmount)}
                  {record.renewsManually ? " · pay manually" : ""}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Payment method</dt>
            <dd>{cardLabel(record)}</dd>
          </div>
          <div>
            <dt>Pro since</dt>
            <dd>{formatDate(record.startedAt)}</dd>
          </div>
        </dl>

        {pending && (
          <div className="scheduled">
            <p className="scheduled-copy">
              <strong>
                Switching to {intervalAdjective(pending.interval!).toLowerCase()} on {formatDate(date)}.
              </strong>{" "}
              You&rsquo;ll be charged {formatMoney(pending.price)} then, and every {intervalNoun(pending.interval!)}{" "}
              after. Pro stays exactly the same until then.
            </p>
            <InlineAction
              action={keepPlan}
              label={`Keep ${intervalAdjective(interval).toLowerCase()}`}
              pendingLabel="Saving…"
            />
          </div>
        )}

        {quote.ok && (
          <div className="scheduled">
            {switchProcessing ? (
              <p className="scheduled-copy">
                <strong>Switch to yearly processing.</strong> You&rsquo;ll move to yearly billing once Flutterwave confirms
                the payment.
              </p>
            ) : (
              <>
                <p className="scheduled-copy">
                  <strong>Switch to yearly now for {formatMoney(quote.proration.due)}.</strong>{" "}
                  {formatMoney(quote.proration.newPrice)} for a year, less {formatMoney(quote.proration.credit)} for the{" "}
                  {quote.proration.daysLeft} days of this month you haven&rsquo;t used.
                </p>
                <Link href="/checkout/pro_yearly" className="btn btn-secondary">
                  Review and switch
                </Link>
              </>
            )}
          </div>
        )}

        {cancelling ? (
          <div className="panel-foot">
            <p className="panel-foot-note">
              You won&rsquo;t be charged again. After {formatDate(date)} your account moves to Free.
            </p>
            <InlineAction action={resumePlan} label="Keep Pro" pendingLabel="Resuming…" variant="primary" />
          </div>
        ) : (
          <div className="panel-foot">
            <Link href="/plans" className="btn btn-secondary">
              Change plan
            </Link>
            <CancelControl
              accessUntil={formatDate(date)}
              amount={formatMoney(nextAmount)}
              droppedChange={
                pending
                  ? `Your switch to ${intervalAdjective(pending.interval!).toLowerCase()} billing on ${formatDate(date)} is cancelled too.`
                  : undefined
              }
              startOpen={openCancel}
            />
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <header className="page-head">
        <h1 className="page-title">Billing</h1>
        <p className="page-lede">Your plan, payment details and receipts.</p>
      </header>

      {thanked && (
        <p className="notice notice-success" role="status">
          Thanks, that helps.
        </p>
      )}

      {showReasonPrompt && <CancellationReasonPrompt headline={cancelledHeadline} />}

      {notice && (
        <p className={`notice notice-${notice.tone}`} role="status">
          {notice.text}
        </p>
      )}

      <section className="panel" aria-labelledby="current-plan">
        {panel}
      </section>

      <section className="history" aria-labelledby="history-title">
        <h2 className="section-title" id="history-title">
          Payment history
        </h2>
        {payments.length === 0 ? (
          <p className="empty">No payments yet. Receipts will show up here after your first payment.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Description</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="col-ref">
                    Reference
                  </th>
                  <th scope="col" className="col-amount">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.txRef} className={p.status === "failed" ? "row-failed" : undefined}>
                    <td className="nowrap">{formatShortDate(p.paidAt)}</td>
                    <td>
                      Pro · {intervalAdjective(PLANS[p.planId].interval!)}
                      <span className="td-sub">{describe(p)}</span>
                      {p.proration && (
                        <span className="td-sub num">
                          {formatMoney(p.proration.newPrice)} − {formatMoney(p.proration.credit)} unused monthly (
                          {p.proration.daysLeft} of {p.proration.daysInPeriod} days)
                        </span>
                      )}
                      <PaymentTimeline entries={logs.get(p.txRef) ?? []} kind={p.kind} />
                    </td>
                    <td>
                      {p.status === "succeeded" ? (
                        <span className="tag tag-paid">Paid</span>
                      ) : p.status === "pending" ? (
                        <span className="tag tag-ending">Processing</span>
                      ) : (
                        <span className="tag tag-failed" title={p.failureReason ?? undefined}>
                          Failed
                        </span>
                      )}
                    </td>
                    <td className="col-ref mono">{p.transactionId ?? "—"}</td>
                    <td className="col-amount num">{formatMoney(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
