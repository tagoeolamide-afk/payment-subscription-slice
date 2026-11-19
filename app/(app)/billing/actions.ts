"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { CHECK_BILLING_FIRST, guard, SOMETHING_WENT_WRONG } from "@/lib/action-guard";
import { cleanNote, isCancellationReason } from "@/lib/cancellation";
import { getCurrentUser, saveCancellationReason } from "@/lib/store";
import { cancelCurrentSubscription, keepCurrentPlan, renewNow, resumeSubscription } from "@/lib/billing";

export type ActionState = { error: string | null };

function refreshBilling() {
  revalidatePath("/billing");
  revalidatePath("/plans");
}

/** Cancels only with the confirmation step's `confirm=cancel`; anything else changes nothing. */
async function cancelSubscriptionImpl(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (formData.get("confirm") !== "cancel") {
    return { error: "Confirm the cancellation to continue. Nothing has changed." };
  }
  const result = await cancelCurrentSubscription();
  if (!result.ok) return { error: result.reason };
  refreshBilling();
  // Billing then shows the optional "why did you cancel?" prompt.
  redirect("/billing?cancelled=1");
}

/** Answer to the optional prompt after cancelling. Skipping never calls this. */
async function submitCancellationReasonImpl(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const reason = formData.get("reason");
  if (!isCancellationReason(reason)) return { error: "Choose a reason, or skip this." };
  const outcome = await saveCancellationReason(getCurrentUser().id, reason, cleanNote(formData.get("note")));
  if (outcome === "no_cancellation") return { error: "There's no recent cancellation to add a reason to." };
  redirect("/billing?reason=thanks");
}

async function resumePlanImpl(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const result = await resumeSubscription();
  if (!result.ok) return { error: result.reason };
  refreshBilling();
  return { error: null };
}

async function keepPlanImpl(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const result = await keepCurrentPlan();
  if (!result.ok) return { error: result.reason };
  refreshBilling();
  return { error: null };
}

/** Renewal due: charge the saved card now. The server verifies it with Flutterwave before Pro returns. */
async function renewPlanImpl(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const result = await renewNow();
  refreshBilling();
  if (!result.ok) return { error: result.reason };
  return { error: null };
}

/* Exported actions: unexpected errors become an inline message (lib/action-guard.ts). */

export async function cancelSubscription(prev: ActionState, formData: FormData): Promise<ActionState> {
  return guard("cancelSubscription", SOMETHING_WENT_WRONG, () => cancelSubscriptionImpl(prev, formData));
}

export async function submitCancellationReason(prev: ActionState, formData: FormData): Promise<ActionState> {
  return guard("submitCancellationReason", SOMETHING_WENT_WRONG, () => submitCancellationReasonImpl(prev, formData));
}

export async function resumePlan(prev: ActionState, formData: FormData): Promise<ActionState> {
  return guard("resumePlan", SOMETHING_WENT_WRONG, () => resumePlanImpl(prev, formData));
}

export async function keepPlan(prev: ActionState, formData: FormData): Promise<ActionState> {
  return guard("keepPlan", SOMETHING_WENT_WRONG, () => keepPlanImpl(prev, formData));
}

export async function renewPlan(prev: ActionState, formData: FormData): Promise<ActionState> {
  return guard("renewPlan", CHECK_BILLING_FIRST, () => renewPlanImpl(prev, formData));
}
