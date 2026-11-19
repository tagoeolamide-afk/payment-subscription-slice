"use client";

import { useActionState } from "react";
import type { ActionState } from "./actions";

/** One-click server action button with pending state and inline error (resume, keep plan). */
export function InlineAction({
  action,
  label,
  pendingLabel,
  variant = "secondary",
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  label: string;
  pendingLabel: string;
  variant?: "primary" | "secondary";
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, { error: null });
  return (
    <form action={formAction} className="inline-action">
      <button type="submit" className={`btn btn-${variant}`} disabled={pending} aria-busy={pending}>
        {pending ? (
          <>
            <span className="spinner" aria-hidden="true" />
            {pendingLabel}
          </>
        ) : (
          label
        )}
      </button>
      {state.error && (
        <p className="notice notice-error" role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}
