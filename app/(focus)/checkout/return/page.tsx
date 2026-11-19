import type { Metadata } from "next";
import Link from "next/link";
import { redirect, unstable_rethrow } from "next/navigation";
import { confirmCheckout, type ConfirmResult } from "@/lib/billing";
import { maybeFail } from "@/lib/dev-faults";
import { formatDate, formatMoney, intervalAdjective, PLANS, PRODUCT_NAME } from "@/lib/plans";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Payment" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

function StatusIcon({ kind }: { kind: "success" | "neutral" | "error" | "pending" }) {
  return (
    <div className={`result-icon result-icon-${kind}`} aria-hidden="true">
      <svg viewBox="0 0 48 48">
        <circle cx="24" cy="24" r="22" className="result-ring" />
        {kind === "success" && <path d="M15 24.5l6 6 12-13" className="result-glyph result-check" />}
        {kind === "error" && <path d="M18 18l12 12M30 18L18 30" className="result-glyph" />}
        {kind === "neutral" && <path d="M16 24h16" className="result-glyph" />}
        {kind === "pending" && <path d="M24 15v9l6 4" className="result-glyph" />}
      </svg>
    </div>
  );
}

function Result({
  kind,
  title,
  body,
  children,
}: {
  kind: "success" | "neutral" | "error" | "pending";
  title: string;
  body: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="result">
      <StatusIcon kind={kind} />
      <h1 className="result-title">{title}</h1>
      <p className="result-body">{body}</p>
      {children}
    </div>
  );
}

export default async function CheckoutReturnPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const txRef = first(sp.tx_ref);
  const status = first(sp.status);
  if (!txRef) redirect("/plans");

  // `status` comes from the redirect URL, so it's only a hint: confirmCheckout still asks
  // Flutterwave, and logs the attempt as failed (customer_cancelled) if nothing was paid.
  const customerCancelled = status === "cancelled";
  // Any unexpected failure while confirming (e.g. the database) shows "We couldn't confirm
  // your payment" with Try again, never an error page. confirmCheckout is safe to repeat.
  let result: ConfirmResult;
  try {
    await maybeFail("return_page"); // development-only test error
    result = await confirmCheckout(txRef, { customerCancelled });
  } catch (err) {
    unstable_rethrow(err);
    console.error("[return] confirming the payment failed", { txRef }, err);
    result = { kind: "error" };
  }

  if (customerCancelled && (result.kind === "failed" || result.kind === "not_found")) {
    return (
      <Result kind="neutral" title="Payment cancelled" body="You left checkout before paying. You haven't been charged.">
        <div className="result-actions">
          <Link href="/plans" className="btn btn-primary">
            Back to plans
          </Link>
        </div>
      </Result>
    );
  }

  switch (result.kind) {
    case "success": {
      const { payment, renewsOn } = result;
      const plan = PLANS[payment.planId];
      if (payment.kind === "plan_change") {
        const p = payment.proration;
        return (
          <Result kind="success" title="You're on yearly billing" body="Your payment went through and Pro is now billed yearly.">
            <dl className="receipt">
              <div>
                <dt>Plan</dt>
                <dd>Pro · {intervalAdjective(plan.interval!)}</dd>
              </div>
              {p && (
                <>
                  <div>
                    <dt>Yearly price</dt>
                    <dd className="num">{formatMoney(p.newPrice)}</dd>
                  </div>
                  <div>
                    <dt>Credit, {p.daysLeft} unused days</dt>
                    <dd className="num">−{formatMoney(p.credit)}</dd>
                  </div>
                </>
              )}
              <div>
                <dt>Amount paid</dt>
                <dd className="num">{formatMoney(payment.amount)}</dd>
              </div>
              <div>
                <dt>Next payment</dt>
                <dd>{formatDate(renewsOn)}</dd>
              </div>
              <div>
                <dt>Reference</dt>
                <dd className="mono truncate" title={payment.txRef}>
                  {payment.transactionId}
                </dd>
              </div>
            </dl>
            <div className="result-actions">
              <Link href="/billing" className="btn btn-primary">
                Go to billing
              </Link>
            </div>
          </Result>
        );
      }
      return (
        <Result
          kind="success"
          title={`Welcome to ${PRODUCT_NAME} Pro`}
          body="Your payment went through and Pro is ready to use. A receipt is below."
        >
          <dl className="receipt">
            <div>
              <dt>Plan</dt>
              <dd>Pro · {intervalAdjective(plan.interval!)}</dd>
            </div>
            <div>
              <dt>Amount paid</dt>
              <dd className="num">{formatMoney(payment.amount)}</dd>
            </div>
            {payment.card && (
              <div>
                <dt>Paid with</dt>
                <dd>
                  {payment.card.brand} ending {payment.card.last4}
                </dd>
              </div>
            )}
            <div>
              <dt>Next payment</dt>
              <dd>{formatDate(renewsOn)}</dd>
            </div>
            <div>
              <dt>Reference</dt>
              <dd className="mono truncate" title={payment.txRef}>
                {payment.transactionId}
              </dd>
            </div>
          </dl>
          <div className="result-actions">
            <Link href="/billing" className="btn btn-primary">
              Go to billing
            </Link>
            <Link href="/plans" className="btn btn-secondary">
              View plans
            </Link>
          </div>
        </Result>
      );
    }
    case "pending":
      return (
        <Result
          kind="pending"
          title="Confirming your payment"
          body="Your bank is still processing this payment. It usually takes a few seconds."
        >
          <div className="result-actions">
            <Link href={`/checkout/return?tx_ref=${encodeURIComponent(txRef)}`} className="btn btn-primary">
              Check again
            </Link>
            <Link href="/billing" className="btn btn-secondary">
              Go to billing
            </Link>
          </div>
        </Result>
      );
    case "failed":
      return (
        <Result kind="error" title="Payment didn't go through" body="Your card wasn't charged. Try again or use a different card.">
          <div className="result-actions">
            <Link href="/plans" className="btn btn-primary">
              Try again
            </Link>
          </div>
        </Result>
      );
    case "not_found":
      return (
        <Result kind="neutral" title="We couldn't find that payment" body="This link doesn't match a checkout on your account.">
          <div className="result-actions">
            <Link href="/billing" className="btn btn-primary">
              Go to billing
            </Link>
          </div>
        </Result>
      );
    default:
      return (
        <Result
          kind="error"
          title="We couldn't confirm your payment"
          body="Something went wrong on our side while checking your payment. If you were charged, your plan will update once we can confirm it."
        >
          <div className="result-actions">
            <Link href={`/checkout/return?tx_ref=${encodeURIComponent(txRef)}`} className="btn btn-primary">
              Try again
            </Link>
            <Link href="/billing" className="btn btn-secondary">
              Go to billing
            </Link>
          </div>
        </Result>
      );
  }
}
