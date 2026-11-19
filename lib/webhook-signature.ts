import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Flutterwave webhook signatures. Checked against the raw request body before anything
 * else happens to the request.
 *
 * - `flutterwave-signature`: base64 HMAC-SHA256 of the raw body, keyed with the secret hash.
 *   If this header is present it must match. A valid `verif-hash` alongside it doesn't excuse
 *   a bad HMAC.
 * - `verif-hash`: the secret hash itself (Flutterwave v3). Accepted when no HMAC header is sent.
 *
 * Both comparisons are constant-time.
 */

export type SignatureCheck = { ok: true; method: "hmac" | "verif_hash" } | { ok: false; reason: "missing" | "mismatch" };

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    timingSafeEqual(left, left); // keep timing independent of where the strings differ
    return false;
  }
  return timingSafeEqual(left, right);
}

export function signBody(rawBody: string, secretHash: string): string {
  return createHmac("sha256", secretHash).update(rawBody, "utf8").digest("base64");
}

export function verifyFlutterwaveSignature(rawBody: string, headers: Headers, secretHash: string): SignatureCheck {
  if (!secretHash) return { ok: false, reason: "mismatch" };

  const hmac = headers.get("flutterwave-signature")?.trim();
  if (hmac) return safeEqual(hmac, signBody(rawBody, secretHash)) ? { ok: true, method: "hmac" } : { ok: false, reason: "mismatch" };

  const hash = headers.get("verif-hash")?.trim();
  if (hash) return safeEqual(hash, secretHash) ? { ok: true, method: "verif_hash" } : { ok: false, reason: "mismatch" };

  return { ok: false, reason: "missing" };
}
