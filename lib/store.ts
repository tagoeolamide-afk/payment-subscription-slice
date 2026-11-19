import "server-only";
import type {
  BillingEventType,
  Checkout as CheckoutRow,
  Payment as PaymentRow,
  Prisma,
  Subscription as SubscriptionRow,
} from "@/generated/prisma/client";
import { prisma } from "./db";
import { money, type Money } from "./money";
import { addInterval, PLANS, type PaidPlanId } from "./plans";
import { parseProration, serializeProration, type Proration } from "./proration";

/**
 * Data access for billing, backed by Prisma + SQLite.
 * Amounts are Money (whole minor units + currency) in the app and in the database
 * (`amount_minor` + `currency` columns), so nothing here converts units.
 * Two append-only logs, each row written in the same transaction as the change it describes:
 *   payment_logs   - every stage of every payment attempt (initiated, verified, fulfilled, failed)
 *   billing_events - subscription lifecycle (started, renewed, plan changes, cancel, resume, expiry)
 */

export type User = { id: string; name: string; email: string };

export type Card = { brand: string; last4: string };

export type SubscriptionRecord = {
  id: number;
  userId: string;
  planId: PaidPlanId;
  status: "active" | "cancelled" | "past_due";
  amount: Money;
  startedAt: string;
  currentPeriodStart: string;
  /** End of the period that has been paid for. */
  currentPeriodEnd: string;
  /** Plan that takes over at currentPeriodEnd, if a change is scheduled. */
  pendingPlanId: PaidPlanId | null;
  cancelledAt: string | null;
  hasCardToken: boolean;
  /** No reusable card (e.g. paid by bank transfer): renewals are paid manually through checkout. */
  renewsManually: boolean;
  /** Flutterwave payment_type of the payment that started it: card, bank_transfer, ... */
  paymentMethod: string | null;
  card: Card | null;
  txRef: string;
};

export type CheckoutAttempt = {
  txRef: string;
  userId: string;
  planId: PaidPlanId;
  amount: Money;
  flutterwavePlanId: number;
  /** subscribe = first payment / paying again; plan_change = prorated switch to yearly. */
  purpose?: "subscribe" | "plan_change";
  /** plan_change: the subscription being switched. */
  subscriptionId?: number | null;
  /** plan_change: the breakdown; `amount` is its `due`. */
  proration?: Proration | null;
  status: "initiated" | "completed" | "failed";
  createdAt: string;
  completedAt?: string;
};

export type PaymentKind = "initial" | "renewal" | "plan_change";

export type Payment = {
  txRef: string;
  transactionId: number | null;
  userId: string;
  planId: PaidPlanId;
  kind: PaymentKind;
  status: "succeeded" | "pending" | "failed";
  amount: Money;
  paidAt: string;
  failureReason: string | null;
  paymentMethod: string | null;
  card: Card | null;
  /** plan_change: credit, new price, due and days. */
  proration: Proration | null;
};

export const DEMO_USER_ID = "user_demo";

export function getCurrentUser(): User {
  return {
    id: DEMO_USER_ID,
    name: process.env.DEMO_USER_NAME?.trim() || "Adaeze Okafor",
    email: process.env.DEMO_USER_EMAIL?.trim() || "adaeze.okafor@example.com",
  };
}

// Make sure the mock user exists (once per process) before anything references it.
let userReady: Promise<unknown> | null = null;
function ensureUser() {
  if (!userReady) {
    const u = getCurrentUser();
    userReady = prisma.user
      .upsert({ where: { id: u.id }, create: u, update: { name: u.name, email: u.email } })
      .catch((err) => {
        userReady = null;
        throw err;
      });
  }
  return userReady;
}

const moneyOf = (r: { amountMinor: number; currency: string }): Money => money(r.amountMinor, r.currency);
const columns = (m: Money) => ({ amountMinor: m.minor, currency: m.currency });

function card(brand: string | null, last4: string | null): Card | null {
  return brand && last4 ? { brand, last4 } : null;
}

function mapSubscription(r: SubscriptionRow): SubscriptionRecord {
  return {
    id: r.id,
    userId: r.userId,
    planId: r.planId,
    status: r.status as SubscriptionRecord["status"],
    amount: moneyOf(r),
    startedAt: r.startedAt.toISOString(),
    currentPeriodStart: r.currentPeriodStart.toISOString(),
    currentPeriodEnd: r.currentPeriodEnd.toISOString(),
    pendingPlanId: r.pendingPlanId,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    hasCardToken: Boolean(r.cardToken),
    renewsManually: !r.cardToken,
    paymentMethod: r.paymentMethod,
    card: card(r.cardBrand, r.cardLast4),
    txRef: r.txRef,
  };
}

function mapCheckout(r: CheckoutRow): CheckoutAttempt {
  return {
    txRef: r.txRef,
    userId: r.userId,
    planId: r.planId,
    amount: moneyOf(r),
    flutterwavePlanId: r.flutterwavePlanId,
    purpose: r.purpose,
    subscriptionId: r.subscriptionId,
    proration: parseProration(r.proration),
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt?.toISOString(),
  };
}

function mapPayment(r: PaymentRow): Payment {
  return {
    txRef: r.txRef,
    transactionId: r.transactionId,
    userId: r.userId,
    planId: r.planId,
    kind: r.kind,
    status: r.status,
    amount: moneyOf(r),
    paidAt: r.paidAt.toISOString(),
    failureReason: r.failureReason,
    paymentMethod: r.paymentMethod,
    card: card(r.cardBrand, r.cardLast4),
    proration: parseProration(r.proration),
  };
}

const CURRENT = { in: ["active", "cancelled", "past_due"] as ("active" | "cancelled" | "past_due")[] };

/* ---------------- events ---------------- */

export type EventInput = {
  userId: string;
  type: BillingEventType;
  subscriptionId?: number | null;
  planId?: PaidPlanId | null;
  amount?: Money | null;
  txRef?: string | null;
  providerTransactionId?: number | null;
  details?: Record<string, unknown>;
  occurredAt?: Date;
};

function eventData(e: EventInput): Prisma.BillingEventUncheckedCreateInput {
  return {
    userId: e.userId,
    type: e.type,
    subscriptionId: e.subscriptionId ?? null,
    planId: e.planId ?? null,
    amountMinor: e.amount?.minor ?? null,
    currency: e.amount?.currency ?? null,
    txRef: e.txRef ?? null,
    providerTransactionId: e.providerTransactionId ?? null,
    details: e.details ? JSON.stringify(e.details) : null,
    occurredAt: e.occurredAt ?? new Date(),
  };
}

export async function recordEvent(e: EventInput): Promise<void> {
  await ensureUser();
  await prisma.billingEvent.create({ data: eventData(e) });
}

/* ---------------- payment log ---------------- */

export type PaymentStage = "initiated" | "verified" | "fulfilled" | "failed";
export type PaymentLogSource = "checkout" | "return_page" | "billing_run" | "webhook";
/** What Flutterwave told us when we verified an attempt. */
export type VerifyResult =
  | "successful"
  | "pending"
  | "failed"
  | "cancelled"
  | "not_found"
  | "amount_mismatch"
  | "provider_error";

export type ProviderInfo = { transactionId?: number | null; status?: string | null; message?: string | null };

export type PaymentLogInput = {
  txRef: string;
  userId: string;
  subscriptionId?: number | null;
  kind: PaymentKind;
  stage: PaymentStage;
  source: PaymentLogSource;
  /** verified: a VerifyResult · fulfilled: active | pending_settlement · failed: the reason */
  result?: string | null;
  planId: PaidPlanId;
  amount: Money;
  provider?: ProviderInfo;
  details?: Record<string, unknown>;
  occurredAt?: Date;
};

function paymentLogData(e: PaymentLogInput): Prisma.PaymentLogUncheckedCreateInput {
  return {
    txRef: e.txRef,
    userId: e.userId,
    subscriptionId: e.subscriptionId ?? null,
    kind: e.kind,
    stage: e.stage,
    source: e.source,
    result: e.result ?? null,
    planId: e.planId,
    ...columns(e.amount),
    providerTransactionId: e.provider?.transactionId ?? null,
    providerStatus: e.provider?.status ?? null,
    providerMessage: e.provider?.message?.slice(0, 500) ?? null,
    details: e.details ? JSON.stringify(e.details) : null,
    occurredAt: e.occurredAt ?? new Date(),
  };
}

/** Logs a stage that changes no other data (starting a charge, a verification result). */
export async function logPayment(e: PaymentLogInput): Promise<void> {
  await ensureUser();
  await prisma.paymentLog.create({ data: paymentLogData(e) });
}

export type PaymentLogEntry = {
  stage: PaymentStage;
  source: PaymentLogSource;
  result: string | null;
  providerStatus: string | null;
  occurredAt: string;
};

/** A user's payment log, grouped by attempt (tx_ref), oldest stage first. */
export async function listPaymentLogs(userId: string): Promise<Map<string, PaymentLogEntry[]>> {
  const rows = await prisma.paymentLog.findMany({ where: { userId }, orderBy: [{ occurredAt: "asc" }, { id: "asc" }] });
  const byRef = new Map<string, PaymentLogEntry[]>();
  for (const r of rows) {
    const list = byRef.get(r.txRef) ?? [];
    list.push({
      stage: r.stage,
      source: r.source,
      result: r.result,
      providerStatus: r.providerStatus,
      occurredAt: r.occurredAt.toISOString(),
    });
    byRef.set(r.txRef, list);
  }
  return byRef;
}

/* ---------------- reads ---------------- */

export async function getUserEmail(userId: string): Promise<string | null> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  return row?.email ?? null;
}

export async function getSubscriptionRecord(userId: string): Promise<SubscriptionRecord | null> {
  const row = await prisma.subscription.findFirst({ where: { userId, status: CURRENT } });
  return row ? mapSubscription(row) : null;
}

export async function getCheckout(txRef: string): Promise<CheckoutAttempt | null> {
  const row = await prisma.checkout.findUnique({ where: { txRef } });
  return row ? mapCheckout(row) : null;
}

export async function getPayment(txRef: string): Promise<Payment | null> {
  const row = await prisma.payment.findUnique({ where: { txRef } });
  return row ? mapPayment(row) : null;
}

export async function listPayments(userId: string): Promise<Payment[]> {
  const rows = await prisma.payment.findMany({ where: { userId }, orderBy: [{ paidAt: "desc" }, { id: "desc" }] });
  return rows.map(mapPayment);
}

/** Server-only charging details. Never pass the result to a client component. */
export async function getChargeContext(
  subscriptionId: number,
): Promise<{ cardToken: string | null; customerEmail: string | null }> {
  const row = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    select: { cardToken: true, customerEmail: true },
  });
  return { cardToken: row?.cardToken ?? null, customerEmail: row?.customerEmail ?? null };
}

/** Subscriptions whose paid period has ended and need the billing run. */
export async function listDueSubscriptions(now: Date, userId?: string): Promise<SubscriptionRecord[]> {
  const rows = await prisma.subscription.findMany({
    where: {
      status: { in: ["active", "cancelled"] },
      currentPeriodEnd: { lte: now },
      ...(userId ? { userId } : {}),
    },
    orderBy: { currentPeriodEnd: "asc" },
  });
  return rows.map(mapSubscription);
}

/* ---------------- writes: checkout ---------------- */

export async function recordCheckout(a: CheckoutAttempt): Promise<void> {
  await ensureUser();
  await prisma.$transaction([
    prisma.checkout.create({
      data: {
        txRef: a.txRef,
        userId: a.userId,
        planId: a.planId,
        ...columns(a.amount),
        flutterwavePlanId: a.flutterwavePlanId,
        purpose: a.purpose ?? "subscribe",
        subscriptionId: a.subscriptionId ?? null,
        proration: a.proration ? serializeProration(a.proration) : null,
        status: a.status,
        createdAt: new Date(a.createdAt),
      },
    }),
    prisma.paymentLog.create({
      data: paymentLogData({
        txRef: a.txRef,
        userId: a.userId,
        subscriptionId: a.subscriptionId ?? null,
        kind: a.purpose === "plan_change" ? "plan_change" : "initial",
        stage: "initiated",
        source: "checkout",
        planId: a.planId,
        amount: a.amount,
        details: a.proration ? prorationDetails(a.proration) : undefined,
      }),
    }),
  ]);
}

/** Marks a checkout failed (once) and logs the `failed` stage. */
export async function markCheckoutFailed(
  txRef: string,
  info: { reason: string; source: PaymentLogSource; provider?: ProviderInfo },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const checkout = await tx.checkout.findUnique({ where: { txRef } });
    if (!checkout) return;
    const flipped = await tx.checkout.updateMany({ where: { txRef, status: "initiated" }, data: { status: "failed" } });
    if (flipped.count === 0) return; // already recorded
    await tx.paymentLog.create({
      data: paymentLogData({
        txRef,
        userId: checkout.userId,
        subscriptionId: checkout.subscriptionId,
        kind: checkout.purpose === "plan_change" ? "plan_change" : "initial",
        stage: "failed",
        source: info.source,
        result: info.reason,
        planId: checkout.planId,
        amount: moneyOf(checkout),
        provider: info.provider,
      }),
    });
  });
}

export type ActivationInput = {
  userId: string;
  txRef: string;
  planId: PaidPlanId;
  amount: Money;
  startedAt: string;
  currentPeriodEnd: string;
  cardToken: string | null;
  customerEmail: string | null;
  card: Card | null;
  paymentMethod: string | null;
  payment: { transactionId: number; amount: Money; paidAt: string };
  /** What prompted the verification that led here (return page or webhook). */
  source: PaymentLogSource;
};

/**
 * Atomically: claim the checkout, retire any current subscription, create the new
 * (app-billed) one, record the payment and its events. Returns the retired subscription
 * (so a legacy provider plan can be stopped) or `already: true` if a concurrent
 * request completed this checkout first.
 */
export async function activateSubscription(
  input: ActivationInput,
): Promise<{ already: true } | { already: false; replaced: SubscriptionRecord | null }> {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.checkout.updateMany({
      where: { txRef: input.txRef, status: { not: "completed" } },
      data: { status: "completed", completedAt: new Date() },
    });
    if (claimed.count === 0) return { already: true as const };

    const prev = await tx.subscription.findFirst({ where: { userId: input.userId, status: CURRENT } });
    if (prev) await tx.subscription.update({ where: { id: prev.id }, data: { status: "replaced", pendingPlanId: null } });

    const sub = await tx.subscription.create({
      data: {
        userId: input.userId,
        planId: input.planId,
        status: "active",
        billingMode: "app",
        ...columns(input.amount),
        startedAt: new Date(input.startedAt),
        currentPeriodStart: new Date(input.startedAt),
        currentPeriodEnd: new Date(input.currentPeriodEnd),
        cardToken: input.cardToken,
        customerEmail: input.customerEmail,
        cardBrand: input.card?.brand ?? null,
        cardLast4: input.card?.last4 ?? null,
        paymentMethod: input.paymentMethod,
        txRef: input.txRef,
      },
    });

    await tx.payment.create({
      data: {
        txRef: input.txRef,
        checkoutTxRef: input.txRef,
        transactionId: input.payment.transactionId,
        userId: input.userId,
        subscriptionId: sub.id,
        kind: "initial",
        status: "succeeded",
        planId: input.planId,
        ...columns(input.payment.amount),
        paidAt: new Date(input.payment.paidAt),
        cardBrand: input.card?.brand ?? null,
        cardLast4: input.card?.last4 ?? null,
        paymentMethod: input.paymentMethod,
      },
    });

    await tx.paymentLog.create({
      data: paymentLogData({
        txRef: input.txRef,
        userId: input.userId,
        subscriptionId: sub.id,
        kind: "initial",
        stage: "fulfilled",
        source: input.source,
        result: "active",
        planId: input.planId,
        amount: input.payment.amount,
        provider: { transactionId: input.payment.transactionId },
        details: { periodEnd: input.currentPeriodEnd },
      }),
    });
    await tx.billingEvent.create({
      data: eventData({
        userId: input.userId,
        subscriptionId: sub.id,
        planId: input.planId,
        type: "subscription_started",
        amount: input.amount,
        txRef: input.txRef,
        details: { periodEnd: input.currentPeriodEnd, replacedSubscriptionId: prev?.id ?? null },
      }),
    });

    return { already: false as const, replaced: prev ? mapSubscription(prev) : null };
  });
}

/* ---------------- writes: plan changes, cancel, resume ---------------- */

/**
 * Schedules (or clears, with `null`) a plan change at the end of the current period.
 * If the subscription was cancelled, this also resumes it: choosing a plan means
 * the customer wants to keep paying.
 */
export async function setPendingPlan(
  sub: SubscriptionRecord,
  pendingPlanId: PaidPlanId | null,
  effectiveAt: Date,
): Promise<void> {
  const resume = sub.status === "cancelled";
  await prisma.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        pendingPlanId,
        // Resuming clears the reason, so a later cancellation asks again (the event history keeps it).
        ...(resume
          ? { status: "active", cancelledAt: null, cancellationReason: null, cancellationNote: null, cancellationReasonAt: null }
          : {}),
      },
    });
    const events: EventInput[] = [];
    if (resume) {
      events.push({ userId: sub.userId, subscriptionId: sub.id, planId: sub.planId, type: "subscription_resumed" });
    }
    if (pendingPlanId) {
      events.push({
        userId: sub.userId,
        subscriptionId: sub.id,
        planId: pendingPlanId,
        type: "plan_change_scheduled",
        details: { from: sub.planId, to: pendingPlanId, effectiveAt: effectiveAt.toISOString() },
      });
    } else if (sub.pendingPlanId) {
      events.push({
        userId: sub.userId,
        subscriptionId: sub.id,
        planId: sub.planId,
        type: "plan_change_cancelled",
        details: { kept: sub.planId, dropped: sub.pendingPlanId },
      });
    }
    if (events.length) await tx.billingEvent.createMany({ data: events.map(eventData) });
  });
}

export async function markSubscriptionCancelled(sub: SubscriptionRecord, endsOn: Date): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const res = await tx.subscription.updateMany({
      where: { id: sub.id, status: "active" },
      data: {
        status: "cancelled",
        cancelledAt: new Date(),
        currentPeriodEnd: endsOn,
        pendingPlanId: null,
      },
    });
    if (res.count === 0) return;
    await tx.billingEvent.create({
      data: eventData({
        userId: sub.userId,
        subscriptionId: sub.id,
        planId: sub.planId,
        type: "subscription_cancelled",
        details: { accessUntil: endsOn.toISOString(), droppedPendingPlan: sub.pendingPlanId },
      }),
    });
  });
}

/* ---------------- cancellation reason ---------------- */

/** How long after cancelling the optional "why did you cancel?" prompt is offered. */
export const CANCELLATION_PROMPT_WINDOW_MS = 60 * 60_000;

export type RecentCancellation = { subscriptionId: number; cancelledAt: string; answered: boolean };

/** The user's most recent cancellation, if it happened within the prompt window. */
export async function getRecentCancellation(userId: string, now = new Date()): Promise<RecentCancellation | null> {
  const row = await prisma.subscription.findFirst({
    where: {
      userId,
      status: { in: ["cancelled", "expired"] },
      cancelledAt: { gte: new Date(now.getTime() - CANCELLATION_PROMPT_WINDOW_MS) },
    },
    orderBy: { cancelledAt: "desc" },
    select: { id: true, cancelledAt: true, cancellationReason: true },
  });
  if (!row?.cancelledAt) return null;
  return { subscriptionId: row.id, cancelledAt: row.cancelledAt.toISOString(), answered: row.cancellationReason !== null };
}

/**
 * Stores the answer to the post-cancellation prompt on the user's most recent cancellation
 * (within the prompt window). One answer per cancellation: the first one is kept.
 * The subscription is found from the user, never from an id the browser sends.
 */
export async function saveCancellationReason(
  userId: string,
  reason: string,
  note: string | null,
  now = new Date(),
): Promise<"saved" | "already_answered" | "no_cancellation"> {
  return prisma.$transaction(async (tx) => {
    const sub = await tx.subscription.findFirst({
      where: {
        userId,
        status: { in: ["cancelled", "expired"] },
        cancelledAt: { gte: new Date(now.getTime() - CANCELLATION_PROMPT_WINDOW_MS) },
      },
      orderBy: { cancelledAt: "desc" },
    });
    if (!sub) return "no_cancellation";
    const res = await tx.subscription.updateMany({
      where: { id: sub.id, cancellationReason: null, cancelledAt: { not: null } },
      data: { cancellationReason: reason, cancellationNote: note, cancellationReasonAt: now },
    });
    if (res.count === 0) return "already_answered";
    await tx.billingEvent.create({
      data: eventData({
        userId,
        subscriptionId: sub.id,
        planId: sub.planId,
        type: "cancellation_reason_given",
        details: { reason, note, cancelledAt: sub.cancelledAt?.toISOString() ?? null },
        occurredAt: now,
      }),
    });
    return "saved";
  });
}

/* ---------------- writes: billing run ---------------- */

/**
 * The renewal charge was accepted: start the next period (on the pending plan, if any).
 * `pending` means Flutterwave accepted it but hasn't settled it; the billing run re-checks
 * it later and settles it with `settlePendingRenewal`.
 */
export async function applyRenewalSuccess(input: {
  sub: SubscriptionRecord;
  planId: PaidPlanId;
  amount: Money;
  periodStart: Date;
  periodEnd: Date;
  txRef: string;
  transactionId: number;
  paidAt: Date;
  status?: "succeeded" | "pending";
}): Promise<void> {
  const paymentStatus = input.status ?? "succeeded";
  const { sub } = input;
  await prisma.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        planId: input.planId,
        ...columns(input.amount),
        currentPeriodStart: input.periodStart,
        currentPeriodEnd: input.periodEnd,
        pendingPlanId: null,
      },
    });
    await tx.payment.create({
      data: {
        txRef: input.txRef,
        transactionId: input.transactionId,
        userId: sub.userId,
        subscriptionId: sub.id,
        kind: "renewal",
        status: paymentStatus,
        planId: input.planId,
        ...columns(input.amount),
        paidAt: input.paidAt,
        cardBrand: sub.card?.brand ?? null,
        cardLast4: sub.card?.last4 ?? null,
        paymentMethod: "card", // renewals are only ever charged to the saved card
      },
    });
    const events: EventInput[] = [];
    if (input.planId !== sub.planId) {
      events.push({
        userId: sub.userId,
        subscriptionId: sub.id,
        planId: input.planId,
        type: "plan_changed",
        details: { from: sub.planId, to: input.planId, effectiveAt: input.periodStart.toISOString() },
      });
    }
    events.push({
      userId: sub.userId,
      subscriptionId: sub.id,
      planId: input.planId,
      type: "subscription_renewed",
      amount: input.amount,
      txRef: input.txRef,
      details: {
        periodStart: input.periodStart.toISOString(),
        periodEnd: input.periodEnd.toISOString(),
        paymentSettled: paymentStatus === "succeeded",
      },
    });
    await tx.billingEvent.createMany({ data: events.map(eventData) });
    // Option A: Pro is renewed while Flutterwave settles a pending charge. If the charge
    // later fails, settlePendingRenewal moves the subscription to past_due.
    await tx.paymentLog.create({
      data: paymentLogData({
        txRef: input.txRef,
        userId: sub.userId,
        subscriptionId: sub.id,
        kind: "renewal",
        stage: "fulfilled",
        source: "billing_run",
        result: paymentStatus === "pending" ? "pending_settlement" : "active",
        planId: input.planId,
        amount: input.amount,
        provider: { transactionId: input.transactionId },
        details: { periodStart: input.periodStart.toISOString(), periodEnd: input.periodEnd.toISOString() },
      }),
    });
  });
}

/** A saved-card charge Flutterwave left pending: a renewal, or a prorated plan change. */
export type PendingRenewal = {
  paymentId: number;
  txRef: string;
  userId: string;
  subscriptionId: number | null;
  kind: "renewal" | "plan_change";
  planId: PaidPlanId;
  amount: Money;
  proration: Proration | null;
};

function mapPendingRenewal(r: PaymentRow): PendingRenewal {
  return {
    paymentId: r.id,
    txRef: r.txRef,
    userId: r.userId,
    subscriptionId: r.subscriptionId,
    kind: r.kind === "plan_change" ? "plan_change" : "renewal",
    planId: r.planId,
    amount: moneyOf(r),
    proration: parseProration(r.proration),
  };
}

const PENDING_CHARGE = { kind: { in: ["renewal", "plan_change"] as ("renewal" | "plan_change")[] }, status: "pending" as const };

export async function listPendingRenewals(userId?: string): Promise<PendingRenewal[]> {
  const rows = await prisma.payment.findMany({
    where: { ...PENDING_CHARGE, ...(userId ? { userId } : {}) },
    orderBy: { paidAt: "asc" },
  });
  return rows.map(mapPendingRenewal);
}

export async function getPendingRenewal(txRef: string): Promise<PendingRenewal | null> {
  const row = await prisma.payment.findFirst({ where: { txRef, ...PENDING_CHARGE } });
  return row ? mapPendingRenewal(row) : null;
}

/**
 * Final outcome of a pending renewal: mark it paid, or failed (which suspends the subscription).
 * Logs the verification that settled it, plus `failed` if it failed.
 */
export async function settlePendingRenewal(
  p: PendingRenewal,
  outcome: { status: "succeeded" } | { status: "failed"; reason: string },
  verification: { result: VerifyResult; provider: ProviderInfo; source: PaymentLogSource },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const res = await tx.payment.updateMany({
      where: { id: p.paymentId, status: "pending" },
      data: outcome.status === "succeeded" ? { status: "succeeded" } : { status: "failed", failureReason: outcome.reason },
    });
    if (res.count === 0) return;
    if (p.kind === "plan_change") {
      await settlePlanChangeIn(tx, p, outcome, verification);
      return;
    }
    const base = {
      txRef: p.txRef,
      userId: p.userId,
      subscriptionId: p.subscriptionId,
      kind: "renewal" as const,
      source: verification.source,
      planId: p.planId,
      amount: p.amount,
      provider: verification.provider,
    };
    await tx.paymentLog.create({
      data: paymentLogData({ ...base, stage: "verified", result: verification.result, details: { settledFrom: "pending" } }),
    });
    if (outcome.status === "failed") {
      await tx.paymentLog.create({ data: paymentLogData({ ...base, stage: "failed", result: outcome.reason }) });
      const suspended = p.subscriptionId
        ? await tx.subscription.updateMany({
            where: { id: p.subscriptionId, status: { in: ["active", "cancelled"] } },
            data: { status: "past_due" },
          })
        : { count: 0 };
      if (suspended.count > 0) {
        await tx.billingEvent.create({
          data: eventData({
            userId: p.userId,
            subscriptionId: p.subscriptionId,
            planId: p.planId,
            type: "subscription_past_due",
            txRef: p.txRef,
            details: { reason: outcome.reason, settledFrom: "pending" },
          }),
        });
      }
    }
  });
}

export async function applyRenewalFailure(input: {
  sub: SubscriptionRecord;
  planId: PaidPlanId;
  amount: Money;
  txRef: string;
  transactionId: number | null;
  reason: string;
  provider?: ProviderInfo;
}): Promise<void> {
  const { sub } = input;
  await prisma.$transaction(async (tx) => {
    await tx.subscription.update({ where: { id: sub.id }, data: { status: "past_due" } });
    await tx.payment.create({
      data: {
        txRef: input.txRef,
        transactionId: input.transactionId,
        userId: sub.userId,
        subscriptionId: sub.id,
        kind: "renewal",
        status: "failed",
        planId: input.planId,
        ...columns(input.amount),
        paidAt: new Date(),
        failureReason: input.reason,
        cardBrand: sub.card?.brand ?? null,
        cardLast4: sub.card?.last4 ?? null,
        paymentMethod: "card", // renewals are only ever charged to the saved card
      },
    });
    await tx.paymentLog.create({
      data: paymentLogData({
        txRef: input.txRef,
        userId: sub.userId,
        subscriptionId: sub.id,
        kind: "renewal",
        stage: "failed",
        source: "billing_run",
        result: input.reason,
        planId: input.planId,
        amount: input.amount,
        provider: { ...input.provider, transactionId: input.transactionId },
      }),
    });
    await tx.billingEvent.create({
      data: eventData({
        userId: sub.userId,
        subscriptionId: sub.id,
        planId: input.planId,
        type: "subscription_past_due",
        txRef: input.txRef,
        details: { reason: input.reason },
      }),
    });
  });
}

/* ---------------- writes: prorated plan change ---------------- */

/*
 * A prorated mid-cycle switch (monthly -> yearly). The subscription only changes once the
 * prorated payment is verified as successful. Pending or failed: it stays as it was.
 * The switch is applied with a guarded UPDATE: only if the subscription is still active, on
 * the plan and in the period the quote was made for. If anything changed in between (the
 * monthly renewal ran first, say), the payment is kept and logged as `needs_review`.
 */

type Tx = Prisma.TransactionClient;

export function prorationDetails(p: Proration): Record<string, unknown> {
  return {
    from: p.fromPlanId,
    to: p.toPlanId,
    creditMinor: p.credit.minor,
    newPriceMinor: p.newPrice.minor,
    dueMinor: p.due.minor,
    daysInPeriod: p.daysInPeriod,
    daysUsed: p.daysUsed,
    daysLeft: p.daysLeft,
  };
}

/** Switches the subscription to the new plan from `paidAt`. Returns false if the guard didn't match. */
async function applyPlanChangeIn(
  tx: Tx,
  input: {
    subscriptionId: number;
    userId: string;
    proration: Proration;
    txRef: string;
    transactionId: number | null;
    paidAt: Date;
    source: PaymentLogSource;
    amount: Money;
    newCard?: { cardToken: string; customerEmail: string | null; card: Card | null } | null;
  },
): Promise<{ applied: boolean; periodEnd: Date }> {
  const p = input.proration;
  const periodEnd = addInterval(input.paidAt, PLANS[p.toPlanId].interval!);
  const res = await tx.subscription.updateMany({
    where: {
      id: input.subscriptionId,
      status: "active",
      planId: p.fromPlanId,
      currentPeriodEnd: new Date(p.replacedPeriodEnd),
    },
    data: {
      planId: p.toPlanId,
      ...columns(p.newPrice),
      currentPeriodStart: input.paidAt,
      currentPeriodEnd: periodEnd,
      pendingPlanId: null,
      // Paid by card through checkout: keep the card, so the next renewal is automatic.
      ...(input.newCard
        ? {
            cardToken: input.newCard.cardToken,
            customerEmail: input.newCard.customerEmail,
            cardBrand: input.newCard.card?.brand ?? null,
            cardLast4: input.newCard.card?.last4 ?? null,
            paymentMethod: "card",
          }
        : {}),
    },
  });
  const applied = res.count === 1;
  if (!applied) console.error("[billing] prorated payment received but the subscription changed first", input.txRef);

  await tx.paymentLog.create({
    data: paymentLogData({
      txRef: input.txRef,
      userId: input.userId,
      subscriptionId: input.subscriptionId,
      kind: "plan_change",
      stage: "fulfilled",
      source: input.source,
      result: applied ? "active" : "needs_review",
      planId: p.toPlanId,
      amount: input.amount,
      provider: { transactionId: input.transactionId },
      details: { ...prorationDetails(p), periodStart: input.paidAt.toISOString(), periodEnd: periodEnd.toISOString() },
    }),
  });
  if (applied) {
    await tx.billingEvent.create({
      data: eventData({
        userId: input.userId,
        subscriptionId: input.subscriptionId,
        planId: p.toPlanId,
        type: "plan_changed",
        amount: input.amount,
        txRef: input.txRef,
        providerTransactionId: input.transactionId,
        details: {
          ...prorationDetails(p),
          immediate: true,
          effectiveAt: input.paidAt.toISOString(),
          periodEnd: periodEnd.toISOString(),
        },
      }),
    });
  }
  return { applied, periodEnd };
}

/** Is a prorated switch for this subscription already waiting on Flutterwave? */
export async function hasPendingPlanChange(subscriptionId: number): Promise<boolean> {
  const row = await prisma.payment.findFirst({
    where: { subscriptionId, kind: "plan_change", status: "pending" },
    select: { id: true },
  });
  return Boolean(row);
}

/**
 * Records the saved-card charge for a prorated switch, after verifying it:
 *   succeeded -> payment + switch the plan now
 *   pending   -> payment only; the switch happens when it settles (settlePendingRenewal)
 *   failed    -> failed payment; nothing changes
 */
export async function recordPlanChangeCharge(input: {
  sub: SubscriptionRecord;
  proration: Proration;
  txRef: string;
  transactionId: number | null;
  paidAt: Date;
  status: "succeeded" | "pending" | "failed";
  failureReason?: string;
  provider?: ProviderInfo;
}): Promise<{ applied: boolean; periodEnd: Date | null }> {
  const { sub, proration: p } = input;
  return prisma.$transaction(async (tx) => {
    await tx.payment.create({
      data: {
        txRef: input.txRef,
        transactionId: input.transactionId,
        userId: sub.userId,
        subscriptionId: sub.id,
        kind: "plan_change",
        status: input.status,
        planId: p.toPlanId,
        ...columns(p.due),
        paidAt: input.paidAt,
        failureReason: input.failureReason ?? null,
        cardBrand: sub.card?.brand ?? null,
        cardLast4: sub.card?.last4 ?? null,
        paymentMethod: "card",
        proration: serializeProration(p),
      },
    });
    if (input.status === "failed") {
      await tx.paymentLog.create({
        data: paymentLogData({
          txRef: input.txRef,
          userId: sub.userId,
          subscriptionId: sub.id,
          kind: "plan_change",
          stage: "failed",
          source: "checkout",
          result: input.failureReason ?? "failed",
          planId: p.toPlanId,
          amount: p.due,
          provider: { ...input.provider, transactionId: input.transactionId },
        }),
      });
      return { applied: false, periodEnd: null };
    }
    if (input.status === "pending") return { applied: false, periodEnd: null };
    return applyPlanChangeIn(tx, {
      subscriptionId: sub.id,
      userId: sub.userId,
      proration: p,
      txRef: input.txRef,
      transactionId: input.transactionId,
      paidAt: input.paidAt,
      source: "checkout",
      amount: p.due,
    });
  });
}

/**
 * A prorated switch paid through hosted checkout (no saved card), verified as successful.
 * Claims the checkout once, records the payment and switches the plan.
 */
export async function completePlanChangeCheckout(input: {
  checkout: CheckoutAttempt;
  transactionId: number;
  paid: Money;
  paidAt: Date;
  card: Card | null;
  cardToken: string | null;
  customerEmail: string | null;
  paymentMethod: string | null;
  source: PaymentLogSource;
}): Promise<{ already: true } | { already: false; applied: boolean; periodEnd: Date }> {
  const { checkout } = input;
  const p = checkout.proration!;
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.checkout.updateMany({
      where: { txRef: checkout.txRef, status: { not: "completed" } },
      data: { status: "completed", completedAt: new Date() },
    });
    if (claimed.count === 0) return { already: true as const };

    await tx.payment.create({
      data: {
        txRef: checkout.txRef,
        checkoutTxRef: checkout.txRef,
        transactionId: input.transactionId,
        userId: checkout.userId,
        subscriptionId: checkout.subscriptionId ?? null,
        kind: "plan_change",
        status: "succeeded",
        planId: p.toPlanId,
        ...columns(input.paid),
        paidAt: input.paidAt,
        cardBrand: input.card?.brand ?? null,
        cardLast4: input.card?.last4 ?? null,
        paymentMethod: input.paymentMethod,
        proration: serializeProration(p),
      },
    });
    const result = await applyPlanChangeIn(tx, {
      subscriptionId: checkout.subscriptionId!,
      userId: checkout.userId,
      proration: p,
      txRef: checkout.txRef,
      transactionId: input.transactionId,
      paidAt: input.paidAt,
      source: input.source,
      amount: input.paid,
      newCard: input.cardToken ? { cardToken: input.cardToken, customerEmail: input.customerEmail, card: input.card } : null,
    });
    return { already: false as const, ...result };
  });
}

/** Final answer for a pending prorated switch: switch now, or leave the plan as it was. */
async function settlePlanChangeIn(
  tx: Tx,
  p: PendingRenewal,
  outcome: { status: "succeeded" } | { status: "failed"; reason: string },
  verification: { result: VerifyResult; provider: ProviderInfo; source: PaymentLogSource },
): Promise<void> {
  const base = {
    txRef: p.txRef,
    userId: p.userId,
    subscriptionId: p.subscriptionId,
    kind: "plan_change" as const,
    source: verification.source,
    planId: p.planId,
    amount: p.amount,
    provider: verification.provider,
  };
  await tx.paymentLog.create({
    data: paymentLogData({ ...base, stage: "verified", result: verification.result, details: { settledFrom: "pending" } }),
  });
  if (outcome.status === "failed") {
    await tx.paymentLog.create({ data: paymentLogData({ ...base, stage: "failed", result: outcome.reason }) });
    return;
  }
  if (!p.proration || !p.subscriptionId) return;
  const row = await tx.payment.findUniqueOrThrow({ where: { id: p.paymentId }, select: { paidAt: true, transactionId: true } });
  await applyPlanChangeIn(tx, {
    subscriptionId: p.subscriptionId,
    userId: p.userId,
    proration: p.proration,
    txRef: p.txRef,
    transactionId: row.transactionId,
    paidAt: row.paidAt,
    source: verification.source,
    amount: p.amount,
  });
}

export async function expireSubscription(sub: SubscriptionRecord): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const res = await tx.subscription.updateMany({
      where: { id: sub.id, status: "cancelled" },
      data: { status: "expired" },
    });
    if (res.count === 0) return;
    await tx.billingEvent.create({
      data: eventData({
        userId: sub.userId,
        subscriptionId: sub.id,
        planId: sub.planId,
        type: "subscription_expired",
        details: { endedAt: sub.currentPeriodEnd },
      }),
    });
  });
}

/** Test clock: moves a subscription's dates back so its period ends now. */
export async function shiftSubscriptionDates(sub: SubscriptionRecord, byMs: number): Promise<void> {
  const back = (iso: string) => new Date(new Date(iso).getTime() - byMs);
  await prisma.$transaction([
    prisma.subscription.update({
      where: { id: sub.id },
      data: {
        startedAt: back(sub.startedAt),
        currentPeriodStart: back(sub.currentPeriodStart),
        currentPeriodEnd: back(sub.currentPeriodEnd),
      },
    }),
    prisma.billingEvent.create({
      data: eventData({
        userId: sub.userId,
        subscriptionId: sub.id,
        planId: sub.planId,
        type: "test_clock_advanced",
        details: { byMs, periodEndWas: sub.currentPeriodEnd },
      }),
    }),
  ]);
}

/* ---------------- webhooks ---------------- */

/*
 * Idempotency is keyed on the provider reference: event_key is unique and built from
 * Flutterwave's transaction id (see lib/webhooks.ts). A repeat delivery never creates a row,
 * it only counts. Processing is claimed with one conditional UPDATE, so exactly one worker
 * runs it; the claim time doubles as a token so a worker whose claim was taken over (it got
 * stuck) can't overwrite the result.
 */

export type WebhookEventRecord = {
  id: number;
  eventKey: string;
  eventType: string;
  providerRef: string | null;
  txRef: string | null;
  status: "received" | "processing" | "processed" | "ignored" | "failed";
  attempts: number;
  deliveries: number;
  claimedAt: Date | null;
};

type WebhookRow = {
  id: number;
  eventKey: string;
  eventType: string;
  providerRef: string | null;
  txRef: string | null;
  status: WebhookEventRecord["status"];
  attempts: number;
  deliveries: number;
  claimedAt: Date | null;
};

const mapWebhook = (r: WebhookRow): WebhookEventRecord => ({
  id: r.id,
  eventKey: r.eventKey,
  eventType: r.eventType,
  providerRef: r.providerRef,
  txRef: r.txRef,
  status: r.status,
  attempts: r.attempts,
  deliveries: r.deliveries,
  claimedAt: r.claimedAt,
});

/** A claim older than this is treated as abandoned (e.g. the server stopped mid-way). */
export const WEBHOOK_CLAIM_TIMEOUT_MS = 5 * 60_000;
export const WEBHOOK_MAX_ATTEMPTS = 5;

/**
 * Stores a signature-verified webhook once per provider reference. A repeat (same event key,
 * whatever its status or payload) only increments `deliveries`; the first payload is kept.
 */
export async function recordWebhookEvent(input: {
  eventKey: string;
  eventType: string;
  providerRef: string;
  txRef: string | null;
  signatureMethod: "hmac" | "verif_hash";
  payload: string;
}): Promise<{ duplicate: boolean; event: WebhookEventRecord }> {
  try {
    const row = await prisma.webhookEvent.create({ data: input });
    return { duplicate: false, event: mapWebhook(row) };
  } catch (err) {
    if ((err as { code?: string }).code !== "P2002") throw err; // unique violation = already recorded
    const row = await prisma.webhookEvent.update({
      where: { eventKey: input.eventKey },
      data: { deliveries: { increment: 1 }, lastDeliveredAt: new Date() },
    });
    return { duplicate: true, event: mapWebhook(row) };
  }
}

/**
 * Claims an event for processing. One conditional UPDATE, so if several workers race only
 * one gets a row back. Claimable: received, failed (under the attempt limit), or processing
 * with a claim older than WEBHOOK_CLAIM_TIMEOUT_MS.
 */
export async function claimWebhookEvent(id: number, now = new Date()): Promise<WebhookEventRecord | null> {
  const stale = new Date(now.getTime() - WEBHOOK_CLAIM_TIMEOUT_MS);
  const res = await prisma.webhookEvent.updateMany({
    where: {
      id,
      attempts: { lt: WEBHOOK_MAX_ATTEMPTS },
      OR: [{ status: { in: ["received", "failed"] } }, { status: "processing", claimedAt: { lt: stale } }],
    },
    data: { status: "processing", claimedAt: now, attempts: { increment: 1 } },
  });
  if (res.count === 0) return null;
  return mapWebhook(await prisma.webhookEvent.findUniqueOrThrow({ where: { id } }));
}

/** Records the outcome, but only for the worker still holding the claim (claimedAt matches). */
export async function finishWebhookEvent(
  claim: WebhookEventRecord,
  status: "processed" | "ignored" | "failed",
  result: string,
): Promise<boolean> {
  const res = await prisma.webhookEvent.updateMany({
    where: { id: claim.id, status: "processing", claimedAt: claim.claimedAt },
    data: { status, result: result.slice(0, 500), claimedAt: null, processedAt: status === "failed" ? null : new Date() },
  });
  return res.count === 1;
}

/** Events to (re)process: failed, received but never processed, or stuck in processing. */
export async function listRetryableWebhookEvents(now: Date): Promise<WebhookEventRecord[]> {
  const rows = await prisma.webhookEvent.findMany({
    where: {
      attempts: { lt: WEBHOOK_MAX_ATTEMPTS },
      OR: [
        { status: "failed" },
        { status: "received", receivedAt: { lte: new Date(now.getTime() - 60_000) } },
        { status: "processing", claimedAt: { lt: new Date(now.getTime() - WEBHOOK_CLAIM_TIMEOUT_MS) } },
      ],
    },
    orderBy: { receivedAt: "asc" },
    take: 100,
  });
  return rows.map(mapWebhook);
}

/** Deletes all of a user's billing data so the flow can be tested from scratch. The user row stays. */
export async function deleteBillingData(
  userId: string,
): Promise<{ payments: number; subscriptions: number; checkouts: number; events: number; paymentLogs: number }> {
  return prisma.$transaction(async (tx) => {
    const refs = [
      ...(await tx.checkout.findMany({ where: { userId }, select: { txRef: true } })),
      ...(await tx.payment.findMany({ where: { userId }, select: { txRef: true } })),
    ].map((r) => r.txRef);
    await tx.webhookEvent.deleteMany({ where: { txRef: { in: refs } } });
    const events = await tx.billingEvent.deleteMany({ where: { userId } });
    const paymentLogs = await tx.paymentLog.deleteMany({ where: { userId } });
    const payments = await tx.payment.deleteMany({ where: { userId } });
    const subscriptions = await tx.subscription.deleteMany({ where: { userId } });
    const checkouts = await tx.checkout.deleteMany({ where: { userId } });
    return {
      payments: payments.count,
      subscriptions: subscriptions.count,
      checkouts: checkouts.count,
      events: events.count,
      paymentLogs: paymentLogs.count,
    };
  });
}
