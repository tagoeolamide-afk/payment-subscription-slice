"use client";

import { useActionState, useState } from "react";
import { changePlan, startCheckout, switchNow, type CheckoutState } from "../actions";
import type { PaidPlanId } from "@/lib/plans";

const ACTIONS = { pay: startCheckout, change: changePlan, switch: switchNow };
const PENDING = { pay: "Redirecting to payment…", change: "Saving…", switch: "Confirming payment…" };

/**
 * pay: new subscription (hands off to Flutterwave) · change: schedule a switch at period end ·
 * switch: switch to yearly now, paying the prorated `quotedDue` (minor units) shown on the page.
 *   If the saved card fails, a second button pays the same amount on Flutterwave (via=checkout).
 */
export function CheckoutForm({
  planId,
  label,
  mode = "pay",
  quotedDue,
  fallbackLabel,
  variant = "primary",
}: {
  planId: PaidPlanId;
  label: string;
  mode?: "pay" | "change" | "switch";
  quotedDue?: number;
  /** switch mode: label for "pay on Flutterwave instead", shown after the saved card fails. */
  fallbackLabel?: string;
  variant?: "primary" | "secondary";
}) {
  const [state, formAction, pending] = useActionState<CheckoutState, FormData>(ACTIONS[mode], { error: null });
  const [via, setVia] = useState<"saved_card" | "checkout">("saved_card");
  const showFallback = mode === "switch" && state.fallback && fallbackLabel;

  return (
    <form action={formAction} className="checkout-form">
      <input type="hidden" name="planId" value={planId} />
      {quotedDue !== undefined && <input type="hidden" name="quotedDue" value={quotedDue} />}
      {state.error && (
        <p className="notice notice-error" role="alert">
          {state.error}
        </p>
      )}
      {showFallback && (
        <button
          type="submit"
          name="via"
          value="checkout"
          className="btn btn-primary btn-block btn-lg"
          disabled={pending}
          aria-busy={pending && via === "checkout"}
          onClick={() => setVia("checkout")}
        >
          {pending && via === "checkout" ? (
            <>
              <span className="spinner" aria-hidden="true" />
              Redirecting to payment…
            </>
          ) : (
            fallbackLabel
          )}
        </button>
      )}
      <button
        type="submit"
        className={`btn btn-${showFallback ? "secondary" : variant} btn-block${variant === "primary" && !showFallback ? " btn-lg" : ""}`}
        disabled={pending}
        aria-busy={pending && via === "saved_card"}
        onClick={() => setVia("saved_card")}
      >
        {pending && via === "saved_card" ? (
          <>
            <span className="spinner" aria-hidden="true" />
            {PENDING[mode]}
          </>
        ) : showFallback ? (
          "Try the saved card again"
        ) : (
          label
        )}
      </button>
    </form>
  );
}
