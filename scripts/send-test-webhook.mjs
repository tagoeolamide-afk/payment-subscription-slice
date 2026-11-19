// Sends a test Flutterwave webhook to the local server, signed with FLW_WEBHOOK_SECRET_HASH.
//
//   npm run webhook:test -- --tx-ref <tx_ref> [--sign hmac|verif-hash|bad|none] [--status successful]
//                           [--amount 5000] [--id 123] [--event charge.completed] [--url http://localhost:3000] [--with-card]
//
// The payload's status and amount are deliberately NOT trusted by the app: it re-verifies the
// tx_ref with Flutterwave. So sending "successful" for an unpaid tx_ref must not grant anything.
import { createHmac } from "node:crypto";
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(" ")
    .split(/\s*--/)
    .filter(Boolean)
    .map((pair) => {
      const [k, ...v] = pair.trim().split(/\s+/);
      return [k, v.join(" ") || "true"];
    }),
);

const secret = process.env.FLW_WEBHOOK_SECRET_HASH?.trim();
if (!secret) {
  console.error("FLW_WEBHOOK_SECRET_HASH is not set in .env.local");
  process.exit(1);
}
const url = `${(args.url ?? process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "")}/api/webhooks/flutterwave`;
const sign = args.sign ?? "hmac";

const body = JSON.stringify({
  event: args.event ?? "charge.completed",
  data: {
    id: Number(args.id ?? Date.now()),
    tx_ref: args["tx-ref"] ?? `fn_test_${Date.now()}`,
    amount: Number(args.amount ?? 5000),
    currency: "NGN",
    status: args.status ?? "successful",
    // --with-card: what a real charge webhook carries (Flutterwave's published test card).
    // The app must store none of it (lib/webhooks.ts › redactWebhookPayload).
    ...(args["with-card"]
      ? {
          card: { first_6digits: "553188", last_4digits: "2950", issuer: "MASTERCARD  CREDIT", country: "NG", type: "MASTERCARD", expiry: "09/32" },
          customer: { id: 1, name: "Test Customer", phone_number: "08000000000", email: "test@example.com" },
        }
      : {}),
  },
});

const headers = { "content-type": "application/json" };
if (sign === "hmac") headers["flutterwave-signature"] = createHmac("sha256", secret).update(body).digest("base64");
if (sign === "verif-hash") headers["verif-hash"] = secret;
if (sign === "bad") headers["flutterwave-signature"] = createHmac("sha256", "not-the-secret").update(body).digest("base64");

const res = await fetch(url, { method: "POST", headers, body });
console.log(`${sign.padEnd(10)} -> ${res.status} ${await res.text()}`);
