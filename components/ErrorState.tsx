import Link from "next/link";
import { FAULT_CLEAR_URL, faultsEnabled } from "@/lib/dev-fault-points";

/**
 * Full-page fallback for errors and unknown pages: the same look as the payment result
 * screens, always with a way forward. Used by error.tsx, global-error.tsx and not-found.tsx.
 */
export function ErrorState({
  title,
  body,
  reference,
  onRetry,
  kind = "error",
}: {
  title: string;
  body: React.ReactNode;
  /** error.digest: matches the server log entry. */
  reference?: string;
  onRetry?: () => void;
  kind?: "error" | "neutral";
}) {
  return (
    <div className="result" role={kind === "error" ? "alert" : undefined}>
      <div className={`result-icon result-icon-${kind}`} aria-hidden="true">
        <svg viewBox="0 0 48 48">
          <circle cx="24" cy="24" r="22" className="result-ring" />
          {kind === "error" ? (
            <path d="M24 14v13M24 33.5v.5" className="result-glyph" />
          ) : (
            <path d="M16 24h16" className="result-glyph" />
          )}
        </svg>
      </div>
      <h1 className="result-title">{title}</h1>
      <p className="result-body">{body}</p>
      <div className="result-actions">
        {onRetry && (
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            Try again
          </button>
        )}
        <Link href="/billing" className={`btn ${onRetry ? "btn-secondary" : "btn-primary"}`}>
          Go to Billing
        </Link>
        <Link href="/plans" className="btn btn-secondary">
          View plans
        </Link>
      </div>
      {reference && (
        <p className="error-ref">
          Reference <span className="mono">{reference}</span>
        </p>
      )}
      {faultsEnabled() && (
        <p className="error-ref">
          {/* A plain link: the route handler works even when the layout is what's failing. */}
          Development: <a href={FAULT_CLEAR_URL}>turn off test errors</a>
        </p>
      )}
    </div>
  );
}

export const PAYMENT_SAFE_COPY =
  "If you just paid, your payment isn't lost: Billing shows it as soon as it's confirmed.";

export function digestOf(error: unknown): string | undefined {
  const d = error && typeof error === "object" && "digest" in error ? (error as { digest?: unknown }).digest : undefined;
  return typeof d === "string" ? d : undefined;
}
