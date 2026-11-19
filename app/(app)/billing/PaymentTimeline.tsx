import type { PaymentKind, PaymentLogEntry } from "@/lib/store";

const time = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Africa/Lagos",
});

const VERIFIED: Record<string, string> = {
  successful: "Confirmed by Flutterwave",
  pending: "Flutterwave: still processing",
  failed: "Declined",
  cancelled: "Cancelled at checkout",
  not_found: "No payment found",
  amount_mismatch: "Amount didn't match",
  provider_error: "Couldn't reach Flutterwave",
};

const REASONS: Record<string, string> = {
  customer_cancelled: "left checkout",
  no_transaction: "no payment made",
  amount_mismatch: "amount didn't match",
  no_saved_card: "no saved card",
  no_customer_email: "no customer email",
  provider_status_failed: "declined",
  link_creation_failed: "couldn't open checkout",
};

function label(e: PaymentLogEntry, kind: PaymentKind): string {
  switch (e.stage) {
    case "initiated":
      if (kind === "plan_change") return "Switch to yearly started";
      return kind === "renewal" ? "Charge started" : "Checkout started";
    case "verified":
      return VERIFIED[e.result ?? ""] ?? "Checked with Flutterwave";
    case "fulfilled":
      if (e.result === "pending_settlement") return "Pro renewed while payment processes";
      if (kind === "plan_change") return e.result === "needs_review" ? "Paid, but the plan had already changed: under review" : "Switched to yearly";
      return kind === "renewal" ? "Pro renewed" : "Pro activated";
    case "failed": {
      const reason = e.result ? (REASONS[e.result] ?? e.result.replace(/^provider_status_/, "").replace(/_/g, " ")) : null;
      return reason ? `Failed: ${reason}` : "Failed";
    }
  }
}

/** Every logged stage of one payment attempt. Uses <details>, so it needs no client JS. */
export function PaymentTimeline({ entries, kind }: { entries: PaymentLogEntry[]; kind: PaymentKind }) {
  if (entries.length === 0) return null;
  return (
    <details className="timeline">
      <summary>
        {entries.length} {entries.length === 1 ? "step" : "steps"}
      </summary>
      <ol>
        {entries.map((e, i) => (
          <li key={i} className={`timeline-${e.stage}`}>
            <span className="timeline-dot" aria-hidden="true" />
            <span className="timeline-label">{label(e, kind)}</span>
            <time className="timeline-time num" dateTime={e.occurredAt}>
              {time.format(new Date(e.occurredAt))}
            </time>
          </li>
        ))}
      </ol>
    </details>
  );
}
