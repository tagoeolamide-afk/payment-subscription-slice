"use client";

import Link from "next/link";
import { useActionState } from "react";
import { CANCELLATION_NOTE_MAX, CANCELLATION_REASONS } from "@/lib/cancellation";
import { submitCancellationReason, type ActionState } from "./actions";

/**
 * Optional prompt shown once, right after cancelling. The cancellation is already saved;
 * Skip (or leaving the page) stores nothing.
 */
export function CancellationReasonPrompt({ headline }: { headline: string }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(submitCancellationReason, { error: null });

  return (
    <section className="panel reason-prompt" aria-labelledby="reason-title">
      <p className="reason-done">{headline}</p>
      <h2 className="panel-title reason-title" id="reason-title">
        Mind telling us why? <span className="panel-title-sub">Optional</span>
      </h2>
      <form action={formAction} className="reason-form">
        <fieldset className="reason-options">
          <legend className="sr-only">Why did you cancel?</legend>
          {CANCELLATION_REASONS.map((r) => (
            <label key={r.code} className="reason-option">
              <input type="radio" name="reason" value={r.code} />
              <span>{r.label}</span>
            </label>
          ))}
        </fieldset>
        <label className="reason-note">
          <span>Anything else? (optional)</span>
          <textarea name="note" rows={3} maxLength={CANCELLATION_NOTE_MAX} />
        </label>
        {state.error && (
          <p className="notice notice-error" role="alert">
            {state.error}
          </p>
        )}
        <div className="panel-foot">
          <button type="submit" className="btn btn-primary" disabled={pending} aria-busy={pending}>
            {pending ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Sending…
              </>
            ) : (
              "Send"
            )}
          </button>
          <Link href="/billing" className="btn btn-secondary">
            Skip
          </Link>
        </div>
      </form>
    </section>
  );
}
