import { after } from "next/server";
import { webhookSecretHash } from "@/lib/env";
import { recordWebhookEvent } from "@/lib/store";
import { verifyFlutterwaveSignature } from "@/lib/webhook-signature";
import { parseWebhook, processWebhookEvent, redactWebhookPayload } from "@/lib/webhooks";

/**
 * Flutterwave webhook endpoint. Set this URL in the Flutterwave dashboard
 * (Settings -> Webhooks) along with the secret hash in FLW_WEBHOOK_SECRET_HASH.
 *
 * Order matters:
 *   1. read the raw body (nothing parsed yet)
 *   2. verify the signature against the raw body -> 401 and stop if it fails
 *   3. only then parse, store once per provider reference (repeats only count), reply 200.
 *      What's stored is redacted: no card or customer details (redactWebhookPayload).
 *   4. process after the response: re-verify the payment with Flutterwave (lib/webhooks.ts)
 */

const MAX_BODY_BYTES = 256 * 1024;

export async function POST(request: Request) {
  const secret = webhookSecretHash();
  if (!secret) {
    // Fail closed: without a secret nothing can be verified, so nothing is accepted.
    return Response.json({ error: "Webhooks are not configured" }, { status: 503 });
  }

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return Response.json({ error: "Payload too large" }, { status: 413 });

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return Response.json({ error: "Payload too large" }, { status: 413 });
  }

  const signature = verifyFlutterwaveSignature(rawBody, request.headers, secret);
  if (!signature.ok) {
    // Rejected before any processing: not parsed, not stored.
    console.warn("[webhook] rejected: signature", signature.reason);
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = parseWebhook(body);
  if ("error" in parsed) {
    const message = parsed.error === "no_provider_reference" ? "No transaction reference" : "Not a webhook event";
    return Response.json({ error: message }, { status: 400 });
  }

  const stored = await recordWebhookEvent({ ...parsed, signatureMethod: signature.method, payload: redactWebhookPayload(body) });
  const { status } = stored.event;
  // Run it once. A repeat only re-prompts processing if it never finished (received or failed);
  // the exclusive claim makes a concurrent attempt a no-op either way.
  if (status === "received" || status === "failed") after(() => processWebhookEvent(stored.event.id));
  return Response.json({ received: true, duplicate: stored.duplicate });
}
