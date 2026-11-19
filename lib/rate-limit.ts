import "server-only";
import { prisma } from "./db";

/*
 * Rate limiting, stored in SQLite (table rate_limit_hits), so it survives restarts and holds
 * across server processes.
 *
 * Each `hit` is a single SQL statement: insert a row only if the number of rows for that key in
 * every window is under its limit. Counting and recording can't be split by concurrent requests,
 * so 10 simultaneous attempts against a limit of 5 let exactly 5 through.
 * Only allowed attempts are recorded; a refused one doesn't extend the wait.
 */

export type Window = { max: number; ms: number };

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Checkout initiation: starting a Flutterwave checkout or a prorated switch. */
export const CHECKOUT_USER: Window[] = [
  { max: 5, ms: 10 * MINUTE },
  { max: 20, ms: DAY },
];
export const CHECKOUT_IP: Window[] = [{ max: 10, ms: 10 * MINUTE }];
/** Charging a saved card without the customer present (switch to yearly now). */
export const CARD_CHARGE_USER: Window[] = [{ max: 3, ms: 10 * MINUTE }];

const LONGEST_MS = DAY;

export type RateResult = { ok: true; id: number } | { ok: false; key: string; retryAfterMs: number };

/** Records one attempt for `key` if it's within every window; otherwise says how long to wait. */
export async function hit(key: string, windows: Window[], now: number = Date.now()): Promise<RateResult> {
  const conditions = windows.map(
    (w) => `(SELECT COUNT(*) FROM rate_limit_hits WHERE key = ? AND created_at_ms > ?) < ?`,
  );
  const params: (string | number)[] = [key, now];
  for (const w of windows) params.push(key, now - w.ms, w.max);
  const rows = await prisma.$queryRawUnsafe<{ id: number | bigint }[]>(
    `INSERT INTO rate_limit_hits (key, created_at_ms) SELECT ?, ? WHERE ${conditions.join(" AND ")} RETURNING id`,
    ...params,
  );

  // Housekeeping: nothing older than the longest window is ever counted.
  await prisma.$executeRawUnsafe(`DELETE FROM rate_limit_hits WHERE key = ? AND created_at_ms <= ?`, key, now - LONGEST_MS);

  if (rows.length > 0) return { ok: true, id: Number(rows[0].id) };
  return { ok: false, key, retryAfterMs: await retryAfter(key, windows, now) };
}

/** When the next attempt would be allowed: the latest moment any full window frees a slot. */
async function retryAfter(key: string, windows: Window[], now: number): Promise<number> {
  let wait = 0;
  for (const w of windows) {
    // The max-th most recent hit in the window is the one that has to expire.
    const rows = await prisma.$queryRawUnsafe<{ t: number | bigint }[]>(
      `SELECT created_at_ms AS t FROM rate_limit_hits WHERE key = ? AND created_at_ms > ? ORDER BY created_at_ms DESC LIMIT 1 OFFSET ?`,
      key,
      now - w.ms,
      w.max - 1,
    );
    if (rows.length > 0) wait = Math.max(wait, Number(rows[0].t) + w.ms - now);
  }
  return Math.max(wait, 1000);
}

/** Takes back an allowed attempt (used when a later check in the same request refuses it). */
async function release(id: number): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM rate_limit_hits WHERE id = ?`, id);
}

/**
 * Checks several keys for one request, all or nothing: if any is over its limit, the others
 * recorded for this request are released, so a refused attempt never counts against anything.
 */
export async function hitAll(checks: { key: string; windows: Window[] }[], now: number = Date.now()): Promise<RateResult> {
  const taken: number[] = [];
  for (const c of checks) {
    const r = await hit(c.key, c.windows, now);
    if (!r.ok) {
      for (const id of taken) await release(id);
      console.warn("[rate-limit] refused", { key: r.key, retryAfterMs: r.retryAfterMs });
      return r;
    }
    taken.push(r.id);
  }
  return { ok: true, id: taken[0] ?? 0 };
}

/** "Too many payment attempts. Try again in 7 minutes." */
export function tooManyMessage(retryAfterMs: number): string {
  const minutes = Math.ceil(retryAfterMs / MINUTE);
  const wait =
    minutes >= 90 ? `${Math.ceil(minutes / 60)} hours` : minutes <= 1 ? "a minute" : `${minutes} minutes`;
  return `Too many payment attempts. Try again in ${wait}.`;
}

/** Checkout initiation limits for this user and IP address. */
export function limitCheckout(userId: string, ip: string | null, now?: number): Promise<RateResult> {
  return hitAll(
    [
      { key: `checkout:user:${userId}`, windows: CHECKOUT_USER },
      ...(ip ? [{ key: `checkout:ip:${ip}`, windows: CHECKOUT_IP }] : []),
    ],
    now,
  );
}

/** Saved-card charges started by the customer (prorated switch). */
export function limitCardCharge(userId: string, now?: number): Promise<RateResult> {
  return hitAll([{ key: `card_charge:user:${userId}`, windows: CARD_CHARGE_USER }], now);
}

/** The client's IP from the proxy headers: Cloudflare's first, then the first X-Forwarded-For entry. */
export function clientIp(h: Headers): string | null {
  const cf = h.get("cf-connecting-ip")?.trim();
  if (cf) return cf.slice(0, 64);
  const xff = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (xff) return xff.slice(0, 64);
  return h.get("x-real-ip")?.trim().slice(0, 64) || null;
}
