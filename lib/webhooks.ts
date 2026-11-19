import "server-only";
import { settlePending, verifyCheckout } from "./billing";
import {
  claimWebhookEvent,
  finishWebhookEvent,
  getCheckout,
  getPayment,
  getPendingRenewal,
  listRetryableWebhookEvents,
  type WebhookEventRecord,
} from "./store";

/*
 * Flutterwave webhooks: what happens after the signature has been verified (that check is
 * in app/api/webhooks/flutterwave/route.ts and lib/webhook-signature.ts).
 *
 * A webhook is only a prompt to look again. Nothing in its payload (status, amount,
 * customer) is trusted. Its tx_ref is used only to find our own checkout or renewal, which
 * is then verified with Flutterwave by the same code as the return page and the billing run:
 * our tx_ref, status, and the exact amount and currency.
 */

export const HANDLED_EVENTS = new Set(["charge.completed"]);

export type ParsedWebhook = { eventKey: string; eventType: string; providerRef: string; txRef: string | null };

/**
 * Pulls the routing fields out of a (signature-verified) payload.
 * Idempotency key = the provider reference: flutterwave:<event type>:<transaction id, else flw_ref>.
 * Status and other fields are deliberately not part of it, so any repeat for the same
 * transaction is the same event. Returns an error if there's no event type or no reference.
 */
export function parseWebhook(body: unknown): ParsedWebhook | { error: "not_a_webhook" | "no_provider_reference" } {
  if (!body || typeof body !== "object") return { error: "not_a_webhook" };
  const b = body as Record<string, unknown>;
  const eventType = typeof b.event === "string" ? b.event : typeof b["event.type"] === "string" ? (b["event.type"] as string) : null;
  if (!eventType) return { error: "not_a_webhook" };
  const data = (b.data && typeof b.data === "object" ? b.data : {}) as Record<string, unknown>;
  const txRef = typeof data.tx_ref === "string" && data.tx_ref.trim() ? data.tx_ref.trim().slice(0, 200) : null;
  const id = typeof data.id === "number" || (typeof data.id === "string" && data.id.trim()) ? String(data.id).trim() : null;
  const flwRef = typeof data.flw_ref === "string" && data.flw_ref.trim() ? data.flw_ref.trim() : null;
  const providerRef = (id ?? flwRef)?.slice(0, 200);
  if (!providerRef) return { error: "no_provider_reference" };
  return { eventKey: `flutterwave:${eventType}:${providerRef}`, eventType, providerRef, txRef };
}

/*
 * No card details are stored. A Flutterwave charge webhook carries `data.card` (first 6 and
 * last 4 digits, expiry, issuer) and customer details; none of it is needed, because every
 * webhook is re-verified with Flutterwave. Only these fields are kept in webhook_events.payload.
 * The signature is checked on the original body before this runs.
 */
const KEPT_DATA_FIELDS = ["id", "tx_ref", "flw_ref", "status", "amount", "currency", "payment_type", "created_at"] as const;

export function redactWebhookPayload(body: unknown): string {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const data = (b.data && typeof b.data === "object" ? b.data : {}) as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const k of KEPT_DATA_FIELDS) {
    const v = data[k];
    if (typeof v === "string" || typeof v === "number") kept[k] = v;
  }
  const out: Record<string, unknown> = { data: kept };
  if (typeof b.event === "string") out.event = b.event;
  if (typeof b["event.type"] === "string") out["event.type"] = b["event.type"];
  out.redacted = true;
  return JSON.stringify(out);
}

type Handled = { status: "processed" | "ignored"; result: string };

async function handle(ev: WebhookEventRecord): Promise<Handled> {
  if (!HANDLED_EVENTS.has(ev.eventType)) return { status: "ignored", result: `unhandled_event:${ev.eventType}` };
  if (!ev.txRef) return { status: "ignored", result: "no_tx_ref" };

  // First payment: verify and activate exactly like the return page does.
  const checkout = await getCheckout(ev.txRef);
  if (checkout) {
    if (checkout.status === "completed") return { status: "ignored", result: "already_fulfilled" };
    const r = await verifyCheckout(checkout, { source: "webhook" });
    if (r.kind === "error") throw new Error("Couldn't reach Flutterwave to verify; will retry");
    return { status: "processed", result: `checkout_${r.kind}` };
  }

  // Renewal Flutterwave left pending: re-verify and settle it.
  const pending = await getPendingRenewal(ev.txRef);
  if (pending) {
    const outcome = await settlePending(pending, "webhook");
    return { status: "processed", result: outcome ? outcome.outcome : "still_pending" };
  }

  const payment = await getPayment(ev.txRef);
  if (payment) return { status: "ignored", result: `already_${payment.status}` };
  return { status: "ignored", result: "unknown_tx_ref" };
}

const inFlight = new Set<number>();

/**
 * Processes one stored webhook event at most once at a time, across workers: the database
 * claim decides who runs it (lib/store.ts › claimWebhookEvent). Anyone else gets "skipped".
 * Failures are recorded and retried by the billing run.
 */
export async function processWebhookEvent(id: number): Promise<WebhookEventRecord["status"] | "skipped"> {
  if (inFlight.has(id)) return "skipped"; // cheap in-process short-cut; the DB claim is the real guard
  inFlight.add(id);
  try {
    const claim = await claimWebhookEvent(id);
    if (!claim) return "skipped";
    try {
      const { status, result } = await handle(claim);
      const kept = await finishWebhookEvent(claim, status, result);
      if (!kept) console.warn("[webhook] claim was taken over before finishing; result not recorded", { id });
      return status;
    } catch (err) {
      console.error("[webhook] processing failed", { id, eventKey: claim.eventKey }, err);
      await finishWebhookEvent(claim, "failed", (err as Error).message || "error");
      return "failed";
    }
  } finally {
    inFlight.delete(id);
  }
}

/** Retries failed events and any whose after-response processing never ran. Called by the billing run endpoint. */
export async function retryWebhookEvents(now = new Date()): Promise<{ id: number; status: string }[]> {
  const out: { id: number; status: string }[] = [];
  for (const ev of await listRetryableWebhookEvents(now)) out.push({ id: ev.id, status: await processWebhookEvent(ev.id) });
  return out;
}
