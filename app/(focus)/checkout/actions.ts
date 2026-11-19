"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { CHECK_BILLING_FIRST, guard, SOMETHING_WENT_WRONG } from "@/lib/action-guard";
import { getBillingState, schedulePlanChange, switchIntervalNow } from "@/lib/billing";
import { appUrl, ConfigError } from "@/lib/env";
import { createHostedPaymentLink, FlutterwaveError } from "@/lib/flutterwave";
import { intervalAdjective, intervalNoun, isPaidPlanId, PLANS, PRODUCT_NAME } from "@/lib/plans";
import { clientIp, limitCheckout, tooManyMessage } from "@/lib/rate-limit";
import { getCurrentUser, markCheckoutFailed, recordCheckout } from "@/lib/store";

/** fallback: the saved card failed during a switch; offer paying through Flutterwave checkout. */
export type CheckoutState = { error: string | null; fallback?: boolean };

const isDev = process.env.NODE_ENV !== "production";

/**
 * Rate limit for checkout initiation, checked before anything is written or Flutterwave is
 * called (lib/rate-limit.ts). Returns the message to show, or null if the attempt may go ahead.
 */
async function checkoutRateLimit(userId: string): Promise<string | null> {
  const limit = await limitCheckout(userId, clientIp(await headers()));
  return limit.ok ? null : tooManyMessage(limit.retryAfterMs);
}

/**
 * New subscription: validates on the server, records the attempt, asks Flutterwave
 * for a one-time hosted card payment, and redirects the browser to it. The price
 * always comes from the server-side catalog. Renewals are charged later by the
 * billing run using the card token from this payment.
 */
async function startCheckoutImpl(_prev: CheckoutState, formData: FormData): Promise<CheckoutState> {
  const planId = formData.get("planId");
  if (!isPaidPlanId(planId)) {
    return { error: "That plan isn't available. Go back and choose a plan." };
  }

  const user = getCurrentUser();
  const limited = await checkoutRateLimit(user.id);
  if (limited) return { error: limited };

  const state = await getBillingState(user.id);
  if (state.status === "active" || state.status === "cancelling") {
    // Existing subscribers change plans at period end instead of paying again now.
    return { error: "You already have Pro. Change your plan from Billing." };
  }
  if (state.status === "renewal_due" && !state.record.renewsManually) {
    return { error: "Your renewal is due. Renew from Billing with your saved card." };
  }
  // Manual renewal (paid by bank transfer, no saved card): paying here starts the next period.

  const plan = PLANS[planId];
  const interval = plan.interval!;
  const txRef = `fn_${planId}_${randomUUID()}`;

  let link: string;
  let recorded = false;
  try {
    await recordCheckout({
      txRef,
      userId: user.id,
      planId,
      amount: plan.price,
      flutterwavePlanId: 0, // not used: renewals are app-billed
      status: "initiated",
      createdAt: new Date().toISOString(),
    });
    recorded = true;
    link = await createHostedPaymentLink({
      txRef,
      amount: plan.price,
      redirectUrl: `${appUrl()}/checkout/return`,
      customer: { email: user.email, name: user.name },
      title: `${PRODUCT_NAME} Pro`,
      description: `${intervalAdjective(interval)} subscription, renews every ${intervalNoun(interval)}`,
      meta: { userId: user.id, planId },
    });
  } catch (err) {
    console.error("[checkout] couldn't start checkout", err);
    if (recorded) {
      // The attempt was logged as initiated; close it out so the log shows why it ended.
      await markCheckoutFailed(txRef, {
        reason: "link_creation_failed",
        source: "checkout",
        provider: { message: (err as Error).message },
      }).catch((logErr) => console.error("[checkout] couldn't log the failure", logErr));
    }
    if (err instanceof ConfigError && isDev) return { error: err.message };
    if (err instanceof FlutterwaveError || err instanceof ConfigError) {
      return { error: "We couldn't start your payment. Please try again in a moment." };
    }
    return { error: "Something went wrong. Please try again." };
  }

  // redirect() throws, so it must stay outside the try/catch.
  redirect(link);
}

/** Existing subscriber: switch interval (or resume) at the end of the current period. No charge today. */
async function changePlanImpl(_prev: CheckoutState, formData: FormData): Promise<CheckoutState> {
  const planId = formData.get("planId");
  if (!isPaidPlanId(planId)) return { error: "That plan isn't available." };
  const result = await schedulePlanChange(planId);
  if (!result.ok) return { error: result.reason };
  revalidatePath("/billing");
  revalidatePath("/plans");
  redirect("/billing");
}

/**
 * Existing monthly subscriber: switch to yearly today, paying the prorated difference.
 * `quotedDue` is the amount the customer was shown (minor units). The server recalculates it
 * and refuses if it differs; it's never used as the amount to charge.
 */
async function switchNowImpl(_prev: CheckoutState, formData: FormData): Promise<CheckoutState> {
  const planId = formData.get("planId");
  if (!isPaidPlanId(planId)) return { error: "That plan isn't available." };
  const quotedDue = Number(formData.get("quotedDue"));
  if (!Number.isSafeInteger(quotedDue)) return { error: "Reload the page and try again." };

  const limited = await checkoutRateLimit(getCurrentUser().id);
  if (limited) return { error: limited };

  // "Pay on Flutterwave instead" (after the saved card failed) submits via=checkout.
  const via = formData.get("via") === "checkout" ? "checkout" : "saved_card";
  const result = await switchIntervalNow(planId, quotedDue, { via });
  if (result.kind === "error") {
    revalidatePath(`/checkout/${planId}`);
    return { error: result.reason, fallback: result.canPayOnline };
  }
  revalidatePath("/billing");
  revalidatePath("/plans");
  if (result.kind === "redirect") redirect(result.url);
  redirect(result.kind === "switched" ? "/billing?switched=yearly" : "/billing?switched=processing");
}

/* Exported actions: unexpected errors become an inline message (lib/action-guard.ts). */

export async function startCheckout(prev: CheckoutState, formData: FormData): Promise<CheckoutState> {
  return guard("startCheckout", SOMETHING_WENT_WRONG, () => startCheckoutImpl(prev, formData));
}

export async function changePlan(prev: CheckoutState, formData: FormData): Promise<CheckoutState> {
  return guard("changePlan", SOMETHING_WENT_WRONG, () => changePlanImpl(prev, formData));
}

export async function switchNow(prev: CheckoutState, formData: FormData): Promise<CheckoutState> {
  return guard("switchNow", CHECK_BILLING_FIRST, () => switchNowImpl(prev, formData));
}
