import { money, subtract, type Money } from "./money";
import { PLANS, type PaidPlanId } from "./plans";

/*
 * Proration for a mid-cycle switch from monthly to yearly billing.
 *
 *   credit = what was paid for the current period x days left / days in the period (rounded down)
 *   due    = yearly price - credit
 *
 * Counted in whole calendar days in Lagos time (UTC+1, no daylight saving). Today counts as
 * used, so the figure is the same all day: what the customer is shown is what gets charged.
 * The credit is rounded down to the kobo, so it never gives back more than was paid.
 * All arithmetic is on whole minor units (lib/money.ts).
 *
 * Yearly -> monthly is not prorated: it's scheduled for the end of the paid year instead.
 */

const DAY_MS = 86_400_000;
const LAGOS_OFFSET_MS = 3_600_000;

/** Calendar day number in Lagos time. */
function lagosDay(t: Date): number {
  return Math.floor((t.getTime() + LAGOS_OFFSET_MS) / DAY_MS);
}

export type Proration = {
  fromPlanId: PaidPlanId;
  toPlanId: PaidPlanId;
  /** Unused part of the current period, given back. */
  credit: Money;
  /** Full price of the new plan for its first period. */
  newPrice: Money;
  /** newPrice - credit: what's charged today. */
  due: Money;
  daysInPeriod: number;
  daysUsed: number;
  daysLeft: number;
  /** The period being replaced. Used to check nothing changed before the switch is applied. */
  replacedPeriodStart: string;
  replacedPeriodEnd: string;
  quotedAt: string;
};

export function quoteProration(
  sub: { planId: PaidPlanId; amount: Money; currentPeriodStart: string; currentPeriodEnd: string },
  toPlanId: PaidPlanId,
  now: Date = new Date(),
): Proration {
  const start = new Date(sub.currentPeriodStart);
  const end = new Date(sub.currentPeriodEnd);
  const daysInPeriod = Math.max(1, lagosDay(end) - lagosDay(start));
  const daysUsed = Math.min(daysInPeriod, Math.max(1, lagosDay(now) - lagosDay(start) + 1));
  const daysLeft = daysInPeriod - daysUsed;

  // Integer maths in minor units; Math.floor rounds the credit down.
  const credit = money(Math.floor((sub.amount.minor * daysLeft) / daysInPeriod), sub.amount.currency);
  const newPrice = PLANS[toPlanId].price;
  const due = subtract(newPrice, credit);

  return {
    fromPlanId: sub.planId,
    toPlanId,
    credit,
    newPrice,
    due,
    daysInPeriod,
    daysUsed,
    daysLeft,
    replacedPeriodStart: start.toISOString(),
    replacedPeriodEnd: end.toISOString(),
    quotedAt: now.toISOString(),
  };
}

/** Only monthly -> yearly is switched now (and prorated). */
export function isProratedSwitch(fromPlanId: PaidPlanId, toPlanId: PaidPlanId): boolean {
  return PLANS[fromPlanId].interval === "monthly" && PLANS[toPlanId].interval === "yearly";
}

/* Stored as JSON text on checkouts and payments. */

export function serializeProration(p: Proration): string {
  return JSON.stringify(p);
}

export function parseProration(text: string | null | undefined): Proration | null {
  if (!text) return null;
  try {
    const p = JSON.parse(text) as Proration;
    const m = (x: Money) => money(x.minor, x.currency);
    return { ...p, credit: m(p.credit), newPrice: m(p.newPrice), due: m(p.due) };
  } catch {
    return null;
  }
}
