import "server-only";
import { randomUUID } from "node:crypto";
import { appUrl, chargeRedirectUrl } from "./env";
import {
  chargeCardToken,
  createHostedPaymentLink,
  FlutterwaveError,
  transactionAmount,
  verifyByReference,
  type FlwTransaction,
} from "./flutterwave";
import { equals, formatMoney, type Money } from "./money";
import { addInterval, PLANS, PRODUCT_NAME, type PaidPlanId, type PlanId } from "./plans";
import { isProratedSwitch, quoteProration, type Proration } from "./proration";
import { limitCardCharge, tooManyMessage } from "./rate-limit";
import {
  activateSubscription,
  completePlanChangeCheckout,
  hasPendingPlanChange,
  prorationDetails,
  recordCheckout,
  recordPlanChangeCharge,
  applyRenewalFailure,
  applyRenewalSuccess,
  deleteBillingData,
  expireSubscription,
  getChargeContext,
  getCheckout,
  getCurrentUser,
  getPayment,
  getUserEmail,
  getSubscriptionRecord,
  listDueSubscriptions,
  listPendingRenewals,
  logPayment,
  markCheckoutFailed,
  markSubscriptionCancelled,
  setPendingPlan,
  settlePendingRenewal,
  shiftSubscriptionDates,
  type Card,
  type CheckoutAttempt,
  type Payment,
  type PaymentLogSource,
  type PendingRenewal,
  type PaymentLogInput,
  type ProviderInfo,
  type SubscriptionRecord,
  type VerifyResult,
} from "./store";

/*
 * Billing model
 * -------------
 * - First payment: Flutterwave hosted checkout (one-time, card). We keep the card token.
 * - Renewals: the billing run (`runBillingCycle`) charges the token at currentPeriodEnd.
 *   Paid without a reusable card (e.g. bank transfer)? Then renewal is manual: nothing is
 *   charged automatically; at period end it's "renewal_due" and the customer pays again
 *   through checkout.
 * - Plan changes, monthly -> yearly: can switch now. The unused monthly days are credited
 *   and only the difference is charged (lib/proration.ts), to the saved card or, without one,
 *   through hosted checkout. The plan changes only once that payment is verified. It can
 *   also be scheduled for the end of the period instead, with nothing to pay today.
 * - Plan changes, yearly -> monthly: scheduled for the end of the paid year. Not prorated,
 *   so nothing is wasted and nothing needs refunding.
 * - Cancel: no further charges; Pro until currentPeriodEnd, then the run expires it.
 * - Every payment stage writes a payment_logs row (initiated, verified, fulfilled, failed);
 *   every subscription change writes a billing_events row (see lib/store.ts).
 * - A renewal Flutterwave leaves pending still renews Pro (logged as fulfilled with
 *   result pending_settlement). If the charge later fails, the subscription goes past_due.
 *
 * Entitlement rule: Pro is granted only by a payment the server has verified with
 * Flutterwave (our tx_ref, exact amount and currency). The redirect back from Flutterwave
 * and anything the browser sends are never trusted. Pro lasts until currentPeriodEnd and
 * no further: after that the subscription is "renewal_due" (no Pro) until a verified
 * renewal extends the period.
 */

/* ------------------------------------------------------------------ */
/* Effective billing state                                             */
/* ------------------------------------------------------------------ */

export type BillingState =
  | { status: "free"; planId: "free"; record: null }
  | {
      status: "active";
      planId: PaidPlanId;
      record: SubscriptionRecord;
      renewsOn: Date;
      pendingPlanId: PaidPlanId | null;
    }
  | { status: "cancelling"; planId: PaidPlanId; record: SubscriptionRecord; endsOn: Date }
  /** The paid period has ended and no verified renewal has extended it yet. No Pro. */
  | {
      status: "renewal_due";
      planId: PaidPlanId;
      record: SubscriptionRecord;
      dueSince: Date;
      pendingPlanId: PaidPlanId | null;
    }
  | { status: "past_due"; planId: PaidPlanId; record: SubscriptionRecord };

/** Whether the state includes Pro access right now. */
export function hasPro(state: BillingState): boolean {
  return state.status === "active" || state.status === "cancelling";
}

export async function getBillingState(userId: string): Promise<BillingState> {
  const record = await getSubscriptionRecord(userId);
  if (!record) return { status: "free", planId: "free", record: null };

  if (record.status === "past_due") return { status: "past_due", planId: record.planId, record };

  const end = new Date(record.currentPeriodEnd);
  if (record.status === "cancelled") {
    // The billing run marks it expired; until then, treat an ended period as Free.
    if (end.getTime() <= Date.now()) return { status: "free", planId: "free", record: null };
    return { status: "cancelling", planId: record.planId, record, endsOn: end };
  }

  // Access ends exactly at the end of the period paid for. Only a renewal verified with
  // Flutterwave moves currentPeriodEnd forward; until then there's no Pro.
  if (end.getTime() <= Date.now()) {
    return { status: "renewal_due", planId: record.planId, record, dueSince: end, pendingPlanId: record.pendingPlanId };
  }

  return { status: "active", planId: record.planId, record, renewsOn: end, pendingPlanId: record.pendingPlanId };
}

export function currentPlanId(state: BillingState): PlanId {
  return hasPro(state) ? state.planId : "free";
}

/** When a scheduled change would take effect. */
export function periodEndOf(state: BillingState): Date | null {
  if (state.status === "active") return state.renewsOn;
  if (state.status === "cancelling") return state.endsOn;
  return null;
}

/* ------------------------------------------------------------------ */
/* Confirming a checkout when the customer returns                     */
/* ------------------------------------------------------------------ */

export type ConfirmResult =
  | { kind: "success"; payment: Payment; renewsOn: Date }
  | { kind: "pending" }
  | { kind: "failed" }
  | { kind: "not_found" }
  | { kind: "error" };

function cardFrom(tx: FlwTransaction): Card | null {
  const last4 = tx.card?.last_4digits;
  if (!last4) return null;
  const raw = (tx.card?.type ?? "Card").toLowerCase();
  const brand = raw === "mastercard" ? "Mastercard" : raw.charAt(0).toUpperCase() + raw.slice(1);
  return { brand, last4 };
}

/* Verification: every call to Flutterwave is logged as its own `verified` row. */

type Verification = { tx: FlwTransaction | null; attempts: number; notFound: boolean; error: string | null };

/** Our reference, and exactly the expected amount in the expected currency (compared in minor units). */
function matches(tx: FlwTransaction | null, txRef: string, expected: Money): tx is FlwTransaction {
  if (!tx || tx.tx_ref !== txRef) return false;
  const got = transactionAmount(tx);
  return got !== null && equals(got, expected);
}

function classify(v: Verification, txRef: string, expected: Money): VerifyResult {
  if (!v.tx) return v.notFound ? "not_found" : "provider_error";
  const status = v.tx.status?.toLowerCase();
  const inFlight = status === "pending" || status === "processing";
  if ((status === "successful" || inFlight) && !matches(v.tx, txRef, expected)) return "amount_mismatch";
  if (status === "successful") return "successful";
  if (inFlight) return "pending";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

function providerInfo(v: Verification): ProviderInfo {
  if (!v.tx) return { message: v.error };
  return { transactionId: v.tx.id, status: v.tx.status ?? null, message: v.tx.processor_response ?? null };
}

/** Why an attempt failed, from its verification result. */
function failureReason(result: VerifyResult, v: Verification): string {
  if (result === "cancelled") return "customer_cancelled";
  if (result === "amount_mismatch") return "amount_mismatch";
  if (result === "not_found") return "no_transaction";
  return `provider_status_${v.tx?.status?.toLowerCase() ?? "unknown"}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Verify by our reference, retrying while Flutterwave still reports it pending. */
async function verify(txRef: string, attempts = 1): Promise<Verification> {
  const v: Verification = { tx: null, attempts: 0, notFound: false, error: null };
  for (let i = 0; i < attempts; i++) {
    v.attempts = i + 1;
    try {
      v.tx = await verifyByReference(txRef);
      v.notFound = false;
      v.error = null;
      if (v.tx.status?.toLowerCase() !== "pending") return v;
    } catch (err) {
      v.notFound = err instanceof FlutterwaveError && (err.httpStatus === 400 || err.httpStatus === 404);
      v.error = (err as Error).message;
      // "No transaction" is an expected answer (e.g. the customer left checkout), not an error.
      if (i === attempts - 1 && !v.notFound) console.error("[billing] verify failed", txRef, v.error);
    }
    if (i < attempts - 1) await sleep(2000);
  }
  return v;
}

/**
 * Idempotent: safe to call on every load of the return page. Verifies the
 * transaction with Flutterwave using our own tx_ref and the server-side price,
 * then activates the subscription exactly once.
 */
export async function confirmCheckout(
  txRef: string,
  opts: { customerCancelled?: boolean } = {},
): Promise<ConfirmResult> {
  const user = getCurrentUser();
  const attempt = await getCheckout(txRef);
  if (!attempt || attempt.userId !== user.id) return { kind: "not_found" };

  if (attempt.status === "completed") {
    const payment = await getPayment(txRef);
    if (payment) {
      const state = await getBillingState(user.id);
      const renewsOn =
        state.status === "active" ? state.renewsOn : addInterval(new Date(payment.paidAt), PLANS[payment.planId].interval!);
      return { kind: "success", payment, renewsOn };
    }
  }

  return verifyCheckout(attempt, { source: "return_page", customerCancelled: opts.customerCancelled });
}

/**
 * Verifies a first-payment checkout with Flutterwave by our own tx_ref and activates Pro
 * only if it's successful for exactly the recorded amount and currency. Shared by the
 * return page and webhooks, so neither the redirect nor a webhook payload is ever trusted.
 */
export async function verifyCheckout(
  attempt: CheckoutAttempt,
  opts: { source: PaymentLogSource; customerCancelled?: boolean },
): Promise<ConfirmResult> {
  const txRef = attempt.txRef;
  const v = await verify(txRef);
  const result = classify(v, txRef, attempt.amount);
  const provider = providerInfo(v);
  const isPlanChange = attempt.purpose === "plan_change";
  await logPayment({
    txRef,
    userId: attempt.userId,
    subscriptionId: attempt.subscriptionId ?? null,
    kind: isPlanChange ? "plan_change" : "initial",
    stage: "verified",
    source: opts.source,
    result,
    planId: attempt.planId,
    amount: attempt.amount,
    provider,
    details: opts.customerCancelled ? { redirectStatus: "cancelled" } : undefined,
  });

  if (result === "provider_error") return { kind: "error" };
  if (result === "pending") return { kind: "pending" };
  if (result !== "successful") {
    if (result === "amount_mismatch") {
      const got = transactionAmount(v.tx!);
      console.error("[billing] verification mismatch", {
        txRef,
        expected: formatMoney(attempt.amount),
        got: got ? formatMoney(got) : { amount: v.tx!.amount, currency: v.tx!.currency },
      });
    }
    // Leaving Flutterwave's page without paying leaves no transaction behind.
    const reason = result === "not_found" && opts.customerCancelled ? "customer_cancelled" : failureReason(result, v);
    await markCheckoutFailed(txRef, { reason, source: opts.source, provider });
    return { kind: "failed" };
  }

  // Exact match in minor units and currency was checked by classify().
  const tx = v.tx!;
  const paid = transactionAmount(tx)!;

  const paidAt = new Date(tx.created_at || Date.now());
  const plan = PLANS[attempt.planId];
  const card = cardFrom(tx);
  const periodEnd = addInterval(paidAt, plan.interval!);
  const paymentMethod = tx.payment_type?.toLowerCase() ?? (tx.card ? "card" : null);

  // Prorated switch to yearly, paid through checkout: switch the existing subscription.
  if (isPlanChange) {
    if (!attempt.proration || !attempt.subscriptionId) {
      console.error("[billing] plan change checkout has no proration", txRef);
      return { kind: "error" };
    }
    const r = await completePlanChangeCheckout({
      checkout: attempt,
      transactionId: tx.id,
      paid,
      paidAt,
      card,
      cardToken: tx.card?.token ?? null,
      customerEmail: tx.customer?.email || null,
      paymentMethod,
      source: opts.source,
    });
    const payment = (await getPayment(txRef))!;
    return { kind: "success", payment, renewsOn: r.already ? periodEnd : r.periodEnd };
  }

  await activateSubscription({
    userId: attempt.userId,
    txRef,
    planId: attempt.planId,
    amount: plan.price,
    startedAt: paidAt.toISOString(),
    currentPeriodEnd: periodEnd.toISOString(),
    cardToken: tx.card?.token ?? null,
    customerEmail: tx.customer?.email || (await getUserEmail(attempt.userId)),
    card,
    paymentMethod,
    payment: { transactionId: tx.id, amount: paid, paidAt: paidAt.toISOString() },
    source: opts.source,
  });

  const payment = (await getPayment(txRef))!;
  return { kind: "success", payment, renewsOn: periodEnd };
}

/* ------------------------------------------------------------------ */
/* Plan changes, cancel, resume                                        */
/* ------------------------------------------------------------------ */

type Outcome = { ok: true; effectiveOn: Date } | { ok: false; reason: string };

/**
 * Switch between monthly and yearly at the end of the current period (both ways).
 * Choosing the current plan clears a scheduled change; on a cancelled plan, choosing
 * any plan resumes it.
 */
export async function schedulePlanChange(target: PaidPlanId): Promise<Outcome> {
  const user = getCurrentUser();
  const state = await getBillingState(user.id);
  if (state.status === "renewal_due") {
    return { ok: false, reason: "Your renewal is due. Renew from Billing first, then change your plan." };
  }
  if (state.status !== "active" && state.status !== "cancelling") {
    return { ok: false, reason: "There's no current plan to change. Choose a plan to subscribe." };
  }

  const record = state.record;
  const effectiveOn = new Date(record.currentPeriodEnd);

  if (target === record.planId) {
    if (record.status === "active" && !record.pendingPlanId) {
      return { ok: false, reason: "You're already on this plan." };
    }
    await setPendingPlan(record, null, effectiveOn); // clears the change and/or resumes
  } else {
    if (record.status === "active" && record.pendingPlanId === target) return { ok: true, effectiveOn };
    await setPendingPlan(record, target, effectiveOn);
  }
  return { ok: true, effectiveOn };
}

/** Keep the current plan: drop a scheduled change. */
export async function keepCurrentPlan(): Promise<Outcome> {
  const user = getCurrentUser();
  const state = await getBillingState(user.id);
  if (state.status !== "active" || !state.pendingPlanId) return { ok: false, reason: "There's no scheduled change." };
  await setPendingPlan(state.record, null, state.renewsOn);
  return { ok: true, effectiveOn: state.renewsOn };
}

/** Undo a cancellation before the period ends. No charge until the normal renewal. */
export async function resumeSubscription(): Promise<Outcome> {
  const user = getCurrentUser();
  const state = await getBillingState(user.id);
  if (state.status !== "cancelling") return { ok: false, reason: "Your plan isn't cancelled." };
  return schedulePlanChange(state.planId);
}

/* ------------------------------------------------------------------ */
/* Switching to yearly now, prorated                                   */
/* ------------------------------------------------------------------ */

/**
 * What switching to `target` today would cost: the unused monthly days are credited and the
 * rest is due now. Only for an active monthly subscription switching to yearly.
 */
export function quoteSwitchNow(
  state: BillingState,
  target: PaidPlanId,
  now: Date = new Date(),
): { ok: true; proration: Proration } | { ok: false; reason: string } {
  if (state.status !== "active") return { ok: false, reason: "Only an active plan can switch now." };
  if (!isProratedSwitch(state.planId, target)) {
    return { ok: false, reason: "Only monthly billing can switch to yearly straight away." };
  }
  return { ok: true, proration: quoteProration(state.record, target, now) };
}

export type SwitchNowResult =
  | { kind: "switched"; renewsOn: Date }
  | { kind: "pending" }
  | { kind: "redirect"; url: string }
  /** canPayOnline: the saved card failed; the customer can pay the same amount through checkout instead. */
  | { kind: "error"; reason: string; canPayOnline?: boolean };

const switching = new Set<number>();

/**
 * Switch from monthly to yearly today, paying the prorated difference.
 * The amount is recalculated here; `quotedDueMinor` is what the customer was shown, and a
 * different figure (a day has passed) is refused so they never pay something they didn't see.
 * Saved card: charged now and verified before the plan changes. If that fails, the result says
 * so (canPayOnline) and the customer can retry with `via: "checkout"`.
 * No saved card, or `via: "checkout"`: returns a Flutterwave checkout link for the prorated amount.
 */
export async function switchIntervalNow(
  target: PaidPlanId,
  quotedDueMinor: number,
  opts: { via?: "saved_card" | "checkout" } = {},
): Promise<SwitchNowResult> {
  const user = getCurrentUser();
  const state = await getBillingState(user.id);
  const quote = quoteSwitchNow(state, target);
  if (!quote.ok) return { kind: "error", reason: quote.reason };
  const p = quote.proration;
  const sub = (state as Extract<BillingState, { status: "active" }>).record;

  if (quotedDueMinor !== p.due.minor) {
    return {
      kind: "error",
      reason: `The amount due is now ${formatMoney(p.due)}, because a day has passed since this page opened. Check it and confirm again.`,
    };
  }
  if (switching.has(sub.id) || (await hasPendingPlanChange(sub.id))) {
    return { kind: "error", reason: "Your switch to yearly is already being processed." };
  }

  const viaCheckout = sub.renewsManually || opts.via === "checkout";
  // Charging a saved card has its own, lower limit (on top of the checkout limit in the action).
  if (!viaCheckout) {
    const limit = await limitCardCharge(user.id);
    if (!limit.ok) return { kind: "error", reason: tooManyMessage(limit.retryAfterMs), canPayOnline: true };
  }

  switching.add(sub.id);
  try {
    const txRef = `fn_change_${sub.id}_${randomUUID()}`;
    return viaCheckout ? await switchThroughCheckout(sub, p, txRef) : await switchWithSavedCard(sub, p, txRef);
  } finally {
    switching.delete(sub.id);
  }
}

async function switchThroughCheckout(sub: SubscriptionRecord, p: Proration, txRef: string): Promise<SwitchNowResult> {
  const user = getCurrentUser();
  await recordCheckout({
    txRef,
    userId: sub.userId,
    planId: p.toPlanId,
    amount: p.due,
    flutterwavePlanId: 0,
    purpose: "plan_change",
    subscriptionId: sub.id,
    proration: p,
    status: "initiated",
    createdAt: new Date().toISOString(),
  });
  try {
    const url = await createHostedPaymentLink({
      txRef,
      amount: p.due,
      redirectUrl: `${appUrl()}/checkout/return`,
      customer: { email: user.email, name: user.name },
      title: `${PRODUCT_NAME} Pro`,
      description: `Switch to yearly: ${formatMoney(p.newPrice)} less ${formatMoney(p.credit)} for ${p.daysLeft} unused days`,
      meta: { userId: sub.userId, planId: p.toPlanId, purpose: "plan_change" },
    });
    return { kind: "redirect", url };
  } catch (err) {
    console.error("[billing] couldn't start the plan change checkout", err);
    await markCheckoutFailed(txRef, {
      reason: "link_creation_failed",
      source: "checkout",
      provider: { message: (err as Error).message },
    }).catch((logErr) => console.error("[billing] couldn't log the failure", logErr));
    return { kind: "error", reason: "We couldn't start your payment. Please try again in a moment." };
  }
}

async function switchWithSavedCard(sub: SubscriptionRecord, p: Proration, txRef: string): Promise<SwitchNowResult> {
  const log = {
    txRef,
    userId: sub.userId,
    subscriptionId: sub.id,
    kind: "plan_change",
    source: "checkout",
    planId: p.toPlanId,
    amount: p.due,
  } satisfies Omit<PaymentLogInput, "stage">;
  await logPayment({ ...log, stage: "initiated", details: prorationDetails(p) });

  const declined = {
    kind: "error",
    reason: `Your saved card couldn't be charged, so nothing changed and you're still on monthly billing. You can pay ${formatMoney(p.due)} on Flutterwave instead, by card or bank transfer.`,
    canPayOnline: true,
  } as const;
  const { cardToken, customerEmail } = await getChargeContext(sub.id);
  if (!cardToken || !customerEmail) {
    await recordPlanChangeCharge({ sub, proration: p, txRef, transactionId: null, paidAt: new Date(), status: "failed", failureReason: "no_saved_card" });
    return declined;
  }

  let chargeError: string | null = null;
  try {
    await chargeCardToken({
      token: cardToken,
      email: customerEmail,
      amount: p.due,
      txRef,
      narration: `Fieldnote Pro: switch to yearly`,
      redirectUrl: chargeRedirectUrl(),
    });
  } catch (err) {
    chargeError = (err as Error).message;
    console.warn("[billing] plan change charge returned an error", sub.id, chargeError);
  }

  const v = await verify(txRef, 3);
  const result = classify(v, txRef, p.due);
  const provider = providerInfo(v);
  if (!v.tx && chargeError) provider.message = chargeError;
  await logPayment({ ...log, stage: "verified", result, provider, details: { attempts: v.attempts } });
  const paidAt = new Date(v.tx?.created_at || Date.now());

  if (result === "successful" || result === "pending") {
    const r = await recordPlanChangeCharge({
      sub,
      proration: p,
      txRef,
      transactionId: v.tx!.id,
      paidAt,
      status: result === "successful" ? "succeeded" : "pending",
    });
    if (result === "pending") return { kind: "pending" };
    if (!r.applied) return { kind: "error", reason: "Your plan changed while we were taking payment. We'll review the payment." };
    return { kind: "switched", renewsOn: r.periodEnd! };
  }

  const reason = v.tx
    ? failureReason(result, v)
    : (chargeError?.replace(/^POST \S+ failed: /, "") ?? (result === "not_found" ? "charge_not_found" : "provider_unreachable"));
  await recordPlanChangeCharge({ sub, proration: p, txRef, transactionId: v.tx?.id ?? null, paidAt, status: "failed", failureReason: reason, provider });
  return declined;
}

export async function cancelCurrentSubscription(): Promise<{ ok: true; endsOn: Date } | { ok: false; reason: string }> {
  const user = getCurrentUser();
  const state = await getBillingState(user.id);
  // A due renewal can be declined too: the period has already ended, so this ends it now.
  if (state.status !== "active" && state.status !== "renewal_due") {
    return { ok: false, reason: "There's no active subscription to cancel." };
  }

  const endsOn = state.status === "active" ? state.renewsOn : state.dueSince;
  await markSubscriptionCancelled(state.record, endsOn);
  return { ok: true, endsOn };
}

/**
 * "Renew now" on Billing when the renewal is due: charges the saved card for this user's
 * subscription and verifies it server-side, exactly like the scheduled billing run.
 */
export async function renewNow(): Promise<{ ok: true; result: CycleResult } | { ok: false; reason: string }> {
  const user = getCurrentUser();
  const state = await getBillingState(user.id);
  if (state.status !== "renewal_due") return { ok: false, reason: "There's no renewal due." };
  if (state.record.renewsManually) {
    return { ok: false, reason: "There's no saved card for this plan. Renew by paying through checkout." };
  }
  const results = await runBillingCycle({ userId: user.id });
  const result = results.find((r) => r.subscriptionId === state.record.id);
  if (!result) return { ok: false, reason: "We couldn't renew just now. Please try again." };
  if (result.outcome === "skipped") return { ok: false, reason: "This renewal is already being processed." };
  return { ok: true, result };
}

/* ------------------------------------------------------------------ */
/* Billing run: renewals, scheduled changes, expiries                  */
/* ------------------------------------------------------------------ */

export type CycleResult = {
  subscriptionId: number | null;
  outcome: "renewed" | "changed_plan" | "pending" | "failed" | "expired" | "settled_paid" | "settled_failed" | "skipped";
  detail?: string;
};

const inFlight = new Set<number>();

/**
 * Re-verifies one pending renewal with Flutterwave and settles it if Flutterwave has a final
 * answer. Shared by the billing run and webhooks. Returns null while it's still pending.
 */
export async function settlePending(p: PendingRenewal, source: PaymentLogSource): Promise<CycleResult | null> {
  const v = await verify(p.txRef);
  const result = classify(v, p.txRef, p.amount);
  const verification = { result, provider: providerInfo(v), source };
  if (result === "successful") {
    await settlePendingRenewal(p, { status: "succeeded" }, verification);
    return { subscriptionId: p.subscriptionId, outcome: "settled_paid" };
  }
  if (result === "failed" || result === "cancelled" || result === "amount_mismatch") {
    const reason = failureReason(result, v);
    await settlePendingRenewal(p, { status: "failed", reason }, verification);
    return { subscriptionId: p.subscriptionId, outcome: "settled_failed", detail: reason };
  }
  // Still pending (or Flutterwave unreachable): log the check and try again later.
  await logPayment({
    txRef: p.txRef,
    userId: p.userId,
    subscriptionId: p.subscriptionId,
    kind: p.kind,
    stage: "verified",
    source,
    result,
    planId: p.planId,
    amount: p.amount,
    provider: verification.provider,
    details: { settledFrom: "pending" },
  });
  return null;
}

/**
 * The billing run. First re-checks renewals Flutterwave left pending, then processes
 * every subscription whose period has ended:
 *   cancelled -> expired
 *   active    -> charge the saved card for the next period, on the scheduled plan if any
 * Idempotent per period: the charge reference is derived from the subscription and the
 * period start, and payments are unique on it. Run it on a schedule in production
 * (see app/api/billing/run).
 */
export async function runBillingCycle(opts: { now?: Date; userId?: string } = {}): Promise<CycleResult[]> {
  const now = opts.now ?? new Date();
  const results: CycleResult[] = [];

  for (const p of await listPendingRenewals(opts.userId)) {
    const outcome = await settlePending(p, "billing_run");
    if (outcome) results.push(outcome);
  }

  for (const sub of await listDueSubscriptions(now, opts.userId)) {
    if (inFlight.has(sub.id)) {
      results.push({ subscriptionId: sub.id, outcome: "skipped", detail: "in progress" });
      continue;
    }
    inFlight.add(sub.id);
    try {
      results.push(await processDueSubscription(sub));
    } catch (err) {
      console.error("[billing-run] unexpected error", sub.id, err);
      results.push({ subscriptionId: sub.id, outcome: "skipped", detail: "error" });
    } finally {
      inFlight.delete(sub.id);
    }
  }
  if (results.length) console.info("[billing-run]", results);
  return results;
}

async function processDueSubscription(sub: SubscriptionRecord): Promise<CycleResult> {
  if (sub.status === "cancelled") {
    await expireSubscription(sub);
    return { subscriptionId: sub.id, outcome: "expired" };
  }

  const planId = sub.pendingPlanId ?? sub.planId;
  const plan = PLANS[planId];
  const periodStart = new Date(sub.currentPeriodEnd);
  const txRef = `fn_renew_${sub.id}_${periodStart.getTime()}`;

  if (await getPayment(txRef)) return { subscriptionId: sub.id, outcome: "skipped", detail: "already charged" };

  // Manual renewal (no reusable card, e.g. paid by bank transfer): nothing to charge.
  // The subscription is now "renewal_due" and the customer renews through checkout.
  const { cardToken, customerEmail } = await getChargeContext(sub.id);
  if (!cardToken) return { subscriptionId: sub.id, outcome: "skipped", detail: "manual_renewal" };

  const log = { txRef, userId: sub.userId, subscriptionId: sub.id, kind: "renewal", source: "billing_run", planId, amount: plan.price } satisfies Omit<PaymentLogInput, "stage">;
  await logPayment({
    ...log,
    stage: "initiated",
    details: { periodStart: periodStart.toISOString(), changingFrom: planId === sub.planId ? null : sub.planId },
  });

  if (!customerEmail) {
    await applyRenewalFailure({ sub, planId, amount: plan.price, txRef, transactionId: null, reason: "no_customer_email" });
    return { subscriptionId: sub.id, outcome: "failed", detail: "no customer email" };
  }

  let chargeError: string | null = null;
  try {
    await chargeCardToken({
      token: cardToken,
      email: customerEmail,
      amount: plan.price,
      txRef,
      narration: `Fieldnote Pro (${plan.interval})`,
      redirectUrl: chargeRedirectUrl(),
    });
  } catch (err) {
    // Declines come back as errors; verify below decides what actually happened.
    chargeError = (err as Error).message;
    console.warn("[billing-run] token charge returned an error", sub.id, chargeError);
  }

  // Give Flutterwave a few seconds to settle it; log the final answer as one `verified` row.
  const v = await verify(txRef, 3);
  const result = classify(v, txRef, plan.price);
  const provider = providerInfo(v);
  if (!v.tx && chargeError) provider.message = chargeError;
  await logPayment({ ...log, stage: "verified", result, provider, details: { attempts: v.attempts } });

  if (result !== "successful" && result !== "pending") {
    // No transaction at all: the charge itself was rejected, so its error is the reason.
    const reason = v.tx
      ? failureReason(result, v)
      : (chargeError?.replace(/^POST \S+ failed: /, "") ?? (result === "not_found" ? "charge_not_found" : "provider_unreachable"));
    await applyRenewalFailure({ sub, planId, amount: plan.price, txRef, transactionId: v.tx?.id ?? null, reason, provider });
    return { subscriptionId: sub.id, outcome: "failed", detail: reason };
  }
  const tx = v.tx!;

  await applyRenewalSuccess({
    sub,
    planId,
    amount: plan.price,
    periodStart,
    periodEnd: addInterval(periodStart, plan.interval!),
    txRef,
    transactionId: tx.id,
    paidAt: new Date(tx.created_at || Date.now()),
    status: result === "successful" ? "succeeded" : "pending",
  });
  if (result === "pending") return { subscriptionId: sub.id, outcome: "pending", detail: planId };
  return { subscriptionId: sub.id, outcome: planId === sub.planId ? "renewed" : "changed_plan" };
}

/* ------------------------------------------------------------------ */
/* Development tools: test clock and reset                             */
/* ------------------------------------------------------------------ */

export function isDemoResetEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.ENABLE_DEMO_RESET === "true";
}

/**
 * Test clock: jumps the current subscription to the end of its period, then runs the
 * billing run for this user, so renewals, scheduled plan changes and expiries can be
 * tested without waiting a month.
 */
export async function advanceToPeriodEnd(): Promise<{ ok: true; results: CycleResult[] } | { ok: false; reason: string }> {
  if (!isDemoResetEnabled()) return { ok: false, reason: "Not available here." };
  const user = getCurrentUser();
  const state = await getBillingState(user.id);
  if (state.status !== "active" && state.status !== "cancelling" && state.status !== "renewal_due") {
    return { ok: false, reason: "There's no active or cancelled plan to move forward." };
  }

  const record = state.record;
  const byMs = new Date(record.currentPeriodEnd).getTime() - Date.now() + 1000;
  if (byMs > 0) await shiftSubscriptionDates(record, byMs);
  const results = await runBillingCycle({ userId: user.id });
  return { ok: true, results };
}

/** Puts the current user back at the start: deletes their payments, subscriptions, checkouts and logs. */
export async function resetDemoAccount(): Promise<{ deleted: Awaited<ReturnType<typeof deleteBillingData>> }> {
  if (!isDemoResetEnabled()) throw new Error("Demo reset is disabled in production.");
  const user = getCurrentUser();
  const deleted = await deleteBillingData(user.id);
  console.info("[reset] demo account reset", { deleted });
  return { deleted };
}
