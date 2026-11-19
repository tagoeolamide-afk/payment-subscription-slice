#!/usr/bin/env node
/**
 * Scans the database and every backup in data/ for card details.
 *
 *   npm run check:card-data            report, exit 1 if anything is found
 *   npm run check:card-data -- --fix   also redact stored webhook payloads (the one place card
 *                                      details can arrive from Flutterwave), then scan again
 *
 * Looks for: card numbers (13-19 digits starting 2-6 that pass the Luhn check), Flutterwave
 * card fields (first_6digits, last_4digits, expiry, cvv, card_number, pan), and columns whose
 * name suggests card data. Allowed by design: subscriptions.card_token (a Flutterwave
 * reference, useless without our secret key) and card_brand / card_last4 (display only).
 */
import Database from "better-sqlite3";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = "data";
const FIX = process.argv.includes("--fix");

const ALLOWED_COLUMNS = new Set(["card_token", "card_brand", "card_last4"]);
const SUSPECT_COLUMN = /card|pan$|^pan|expiry|cvv|cvc/i;
const FIELD_PATTERN = /"(first_6digits|last_4digits|expiry|cvv|cvc|card_number|pan|card)"\s*:/i;
const DIGIT_RUN = /(?<!\d)[2-6]\d{12,18}(?!\d)/g;

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Same whitelist as lib/webhooks.ts › redactWebhookPayload. */
const KEPT_DATA_FIELDS = ["id", "tx_ref", "flw_ref", "status", "amount", "currency", "payment_type", "created_at"];
function redact(payload) {
  let b;
  try {
    b = JSON.parse(payload);
  } catch {
    return JSON.stringify({ redacted: true, unparseable: true });
  }
  const data = b && typeof b.data === "object" && b.data ? b.data : {};
  const kept = {};
  for (const k of KEPT_DATA_FIELDS) if (typeof data[k] === "string" || typeof data[k] === "number") kept[k] = data[k];
  const out = { data: kept };
  if (typeof b.event === "string") out.event = b.event;
  if (typeof b["event.type"] === "string") out["event.type"] = b["event.type"];
  out.redacted = true;
  return JSON.stringify(out);
}

function scan(file) {
  const db = new Database(file, { readonly: !FIX });
  const findings = [];
  let fixed = 0;
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'")
      .all()
      .map((r) => r.name);

    if (FIX && tables.includes("webhook_events")) {
      const update = db.prepare("UPDATE webhook_events SET payload = ? WHERE id = ?");
      db.transaction(() => {
        for (const r of db.prepare("SELECT id, payload FROM webhook_events").all()) {
          const clean = redact(r.payload);
          if (clean !== r.payload) {
            update.run(clean, r.id);
            fixed++;
          }
        }
      })();
    }

    for (const t of tables) {
      for (const c of db.prepare(`PRAGMA table_info("${t}")`).all()) {
        if (SUSPECT_COLUMN.test(c.name) && !ALLOWED_COLUMNS.has(c.name)) findings.push(`${t}.${c.name}: column name looks like card data`);
      }
      for (const row of db.prepare(`SELECT * FROM "${t}"`).all()) {
        for (const [col, v] of Object.entries(row)) {
          if (typeof v !== "string" || ALLOWED_COLUMNS.has(col)) continue;
          const field = v.match(FIELD_PATTERN);
          if (field) findings.push(`${t}.${col}: contains "${field[1]}"`);
          for (const m of v.matchAll(DIGIT_RUN)) {
            if (luhn(m[0])) findings.push(`${t}.${col}: card-number-like digits ${m[0].slice(0, 6)}…${m[0].slice(-4)}`);
          }
        }
      }
    }
  } finally {
    db.close();
  }
  return { findings, fixed };
}

const files = readdirSync(DATA_DIR)
  .filter((f) => f.endsWith(".db"))
  .map((f) => join(DATA_DIR, f));
let total = 0;
for (const f of files) {
  const { findings, fixed } = scan(f);
  const unique = [...new Set(findings)];
  total += unique.length;
  const note = FIX && fixed ? ` (redacted ${fixed} webhook payload${fixed === 1 ? "" : "s"})` : "";
  console.log(`${unique.length ? "FOUND" : "clean"}  ${f}${note}`);
  for (const x of unique) console.log(`       - ${x}`);
}
console.log(total ? `\n${total} finding(s). Run with --fix to redact webhook payloads.` : `\nNo card details found in ${files.length} database file(s).`);
process.exit(total ? 1 : 0);
