"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { resetFlow, skipToPeriodEnd, type DevState } from "@/app/dev-actions";
import { FAULT_CLEAR_URL, FAULT_POINTS, faultUrl, type FaultPoint } from "@/lib/dev-fault-points";

/**
 * Development-only "Test tools" menu in the top bar:
 * - Skip to end of period: runs the billing run as if the paid period just ended.
 * - Reset flow: deletes the user's billing data (with a confirm step).
 * - Trigger an error: switches on a test error so each error screen can be seen.
 */
export function ResetFlowButton({ canSkip, activeFault = null }: { canSkip: boolean; activeFault?: FaultPoint | null }) {
  const [open, setOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetState, resetAction, resetting] = useActionState<DevState, FormData>(resetFlow, { error: null });
  const [skipState, skipAction, skipping] = useActionState<DevState, FormData>(skipToPeriodEnd, { error: null });
  const busy = resetting || skipping;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const close = () => {
    setOpen(false);
    setConfirmReset(false);
  };

  useEffect(() => {
    if (!open) return;
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        close();
        triggerRef.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (!busy && rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, busy]);

  return (
    <div className="reset" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-secondary btn-sm"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" className="btn-icon">
          <path
            d="M2.75 8a5.25 5.25 0 1 0 1.6-3.78M2.75 2.75v2.5h2.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Test tools
        {activeFault && <span className="tool-dot" aria-label="(test error on)" />}
      </button>

      {open && (
        <div className="reset-panel" id={panelId} role="dialog" aria-label="Test tools">
          {!confirmReset ? (
            <>
              <div className="tool">
                <p className="reset-title">Skip to end of period</p>
                <p className="reset-body">
                  Ends the current billing period now and runs the billing run: renews, applies a scheduled switch, or
                  ends a cancelled plan.
                </p>
                {skipState.error && (
                  <p className="notice notice-error" role="alert">
                    {skipState.error}
                  </p>
                )}
                <form action={skipAction}>
                  <button
                    ref={firstRef}
                    type="submit"
                    className="btn btn-secondary btn-sm"
                    disabled={busy || !canSkip}
                    aria-busy={skipping}
                    title={canSkip ? undefined : "Subscribe first"}
                  >
                    {skipping ? (
                      <>
                        <span className="spinner" aria-hidden="true" />
                        Running billing…
                      </>
                    ) : (
                      "Skip to period end"
                    )}
                  </button>
                </form>
              </div>

              <div className="tool tool-divider">
                <p className="reset-title">Reset flow</p>
                <p className="reset-body">Start over on Free with no payments, subscriptions or history.</p>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmReset(true)} disabled={busy}>
                  Reset…
                </button>
              </div>

              <div className="tool tool-divider">
                <p className="reset-title">Trigger an error</p>
                <p className="reset-body">
                  {activeFault ? (
                    <>
                      On: <strong>{FAULT_POINTS[activeFault].label}</strong>. Turns itself off after 10 minutes.
                    </>
                  ) : (
                    "Throws a test error at one point so you can see its error screen. Nothing is charged or changed."
                  )}
                </p>
                {/* Plain links (full page loads): the route handler sets the cookie, then opens the page. */}
                <ul className="fault-list">
                  {(Object.keys(FAULT_POINTS) as FaultPoint[]).map((p) => (
                    <li key={p}>
                      <a href={faultUrl(p)} className={`fault-link${p === activeFault ? " is-on" : ""}`} aria-current={p === activeFault ? "true" : undefined}>
                        <span>{FAULT_POINTS[p].label}</span>
                        <span className="fault-shows">{FAULT_POINTS[p].shows}</span>
                      </a>
                    </li>
                  ))}
                </ul>
                {activeFault && (
                  <a href={FAULT_CLEAR_URL} className="btn btn-secondary btn-sm">
                    Turn off test error
                  </a>
                )}
              </div>
            </>
          ) : (
            <>
              <p className="reset-title">Start over from the beginning?</p>
              <p className="reset-body">
                Deletes your payments, subscriptions, checkouts and billing events, and stops any Flutterwave plan
                subscriptions from earlier tests. You&rsquo;ll be back on Free.
              </p>
              {resetState.error && (
                <p className="notice notice-error" role="alert">
                  {resetState.error}
                </p>
              )}
              <form action={resetAction} className="reset-actions">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmReset(false)} disabled={busy}>
                  Back
                </button>
                <button type="submit" className="btn btn-danger btn-sm" disabled={busy} aria-busy={resetting}>
                  {resetting ? (
                    <>
                      <span className="spinner" aria-hidden="true" />
                      Resetting…
                    </>
                  ) : (
                    "Reset"
                  )}
                </button>
              </form>
            </>
          )}
        </div>
      )}
    </div>
  );
}
