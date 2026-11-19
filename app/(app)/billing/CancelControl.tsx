"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { cancelSubscription, type ActionState } from "./actions";

function ConfirmButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-danger" disabled={pending} aria-busy={pending}>
      {pending ? (
        <>
          <span className="spinner" aria-hidden="true" />
          Cancelling…
        </>
      ) : (
        label
      )}
    </button>
  );
}

/**
 * Two-step cancel: the first click opens an inline confirmation that says exactly what happens.
 * The confirm button sends `confirm=cancel`, and the server refuses to cancel without it.
 *   mode "active": Pro continues until `accessUntil`, then Free.
 *   mode "due":    the paid period already ended (renewal due), so it moves to Free now.
 * `droppedChange` names a scheduled plan change that cancelling also removes.
 * `startOpen` opens the confirmation straight away (Plans -> Downgrade links to /billing?cancel=1).
 */
export function CancelControl({
  accessUntil,
  amount,
  mode = "active",
  droppedChange,
  startOpen = false,
}: {
  accessUntil: string;
  amount: string;
  mode?: "active" | "due";
  droppedChange?: string;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const [state, formAction] = useActionState<ActionState, FormData>(cancelSubscription, { error: null });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const due = mode === "due";

  useEffect(() => {
    if (open) {
      headingRef.current?.focus();
      headingRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [open]);

  if (!open) {
    return (
      <button type="button" className="btn btn-danger-ghost" onClick={() => setOpen(true)} id="cancel">
        {due ? "Don't renew" : "Cancel subscription"}
      </button>
    );
  }

  return (
    <div className="confirm" role="group" aria-labelledby="cancel-heading">
      <h3 className="confirm-title" id="cancel-heading" tabIndex={-1} ref={headingRef}>
        {due ? "End your Pro subscription?" : "Cancel your Pro subscription?"}
      </h3>
      <p className="confirm-body">
        {due ? (
          <>
            Your paid period ended on <strong>{accessUntil}</strong>. You won&rsquo;t be charged {amount}, and your account
            moves to Free now. Notebooks over the Free limit become read-only.
          </>
        ) : (
          <>
            You won&rsquo;t be charged {amount} again. Pro stays on until <strong>{accessUntil}</strong>, then your account
            moves to Free. Notebooks over the Free limit become read-only.
          </>
        )}
        {droppedChange && <> {droppedChange}</>}
      </p>
      {state.error && (
        <p className="notice notice-error" role="alert">
          {state.error}
        </p>
      )}
      <form action={formAction} className="confirm-actions">
        <input type="hidden" name="confirm" value="cancel" />
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            setOpen(false);
            requestAnimationFrame(() => document.getElementById("cancel")?.focus());
          }}
        >
          {due ? "Go back" : "Keep Pro"}
        </button>
        <ConfirmButton label={due ? "Don't renew" : "Cancel subscription"} />
      </form>
    </div>
  );
}
