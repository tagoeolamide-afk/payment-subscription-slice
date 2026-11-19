"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { CHECK_BILLING_FIRST, guard, SOMETHING_WENT_WRONG } from "@/lib/action-guard";
import { advanceToPeriodEnd, isDemoResetEnabled, resetDemoAccount } from "@/lib/billing";

/** Development-only actions behind the top bar's Test tools menu. */

export type DevState = { error: string | null };

/** Wipes the user's billing data and sends them back to the start of the flow. */
async function resetFlowImpl(_prev: DevState, _formData: FormData): Promise<DevState> {
  if (!isDemoResetEnabled()) return { error: "Reset isn't available here." };
  try {
    await resetDemoAccount();
  } catch (err) {
    console.error("[reset] failed", err);
    return { error: "Couldn't reset. Check the server log and try again." };
  }
  revalidatePath("/", "layout");
  redirect("/plans");
}

/** Test clock: ends the current period now and runs the billing run (renewal, scheduled change or expiry). */
async function skipToPeriodEndImpl(_prev: DevState, _formData: FormData): Promise<DevState> {
  if (!isDemoResetEnabled()) return { error: "Not available here." };
  const result = await advanceToPeriodEnd();
  if (!result.ok) return { error: result.reason };
  revalidatePath("/", "layout");
  redirect("/billing");
}

/* Exported actions: unexpected errors become an inline message (lib/action-guard.ts). */

export async function resetFlow(prev: DevState, formData: FormData): Promise<DevState> {
  return guard("resetFlow", SOMETHING_WENT_WRONG, () => resetFlowImpl(prev, formData), { testFault: false });
}

export async function skipToPeriodEnd(prev: DevState, formData: FormData): Promise<DevState> {
  return guard("skipToPeriodEnd", CHECK_BILLING_FIRST, () => skipToPeriodEndImpl(prev, formData), { testFault: false });
}
