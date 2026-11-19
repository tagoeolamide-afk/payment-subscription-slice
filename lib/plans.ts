import { approxPerPart, formatMoney, money, subtract, times, type Money } from "./money";

/**
 * The plan catalog: one free tier and one paid plan ("Pro") sold on two intervals.
 * Prices are Money: whole kobo plus the currency code (see lib/money.ts).
 */

export const PRODUCT_NAME = "Fieldnote";

export type PlanId = "free" | "pro_monthly" | "pro_yearly";
export type PaidPlanId = Exclude<PlanId, "free">;
export type Interval = "monthly" | "yearly";

export type Plan = {
  id: PlanId;
  name: string;
  interval: Interval | null;
  price: Money;
};

export const FREE_FEATURES = ["Up to 3 notebooks", "1 GB of storage", "Sync across 2 devices"];

export const PRO_FEATURES = [
  "Unlimited notebooks",
  "50 GB of storage",
  "Sync on every device",
  "A full year of version history",
  "PDF and Markdown export",
  "Priority support",
];

export const PLANS: Record<PlanId, Plan> = {
  free: { id: "free", name: "Free", interval: null, price: money(0, "NGN") },
  pro_monthly: { id: "pro_monthly", name: "Pro", interval: "monthly", price: money(5_000_00, "NGN") }, // ₦5,000
  pro_yearly: { id: "pro_yearly", name: "Pro", interval: "yearly", price: money(50_000_00, "NGN") }, // ₦50,000
};

export function isPaidPlanId(value: unknown): value is PaidPlanId {
  return value === "pro_monthly" || value === "pro_yearly";
}

/** What a year of monthly billing would cost minus the yearly price. */
export const YEARLY_SAVINGS: Money = subtract(times(PLANS.pro_monthly.price, 12), PLANS.pro_yearly.price);

/** The yearly price spread over 12 months, rounded to whole naira. Display only. */
export const YEARLY_PER_MONTH: Money = approxPerPart(PLANS.pro_yearly.price, 12);

export { formatMoney };

export function intervalNoun(interval: Interval): string {
  return interval === "monthly" ? "month" : "year";
}

export function intervalAdjective(interval: Interval): string {
  return interval === "monthly" ? "Monthly" : "Yearly";
}

/** Adds one billing interval, clamping to month end (31 Jan + 1 month = 28/29 Feb). */
export function addInterval(from: Date, interval: Interval): Date {
  const day = from.getUTCDate();
  const next = new Date(from);
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + (interval === "monthly" ? 1 : 12));
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

const longDate = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Africa/Lagos",
});
const shortDate = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Africa/Lagos",
});

export function formatDate(date: Date | string): string {
  return longDate.format(typeof date === "string" ? new Date(date) : date);
}

export function formatShortDate(date: Date | string): string {
  return shortDate.format(typeof date === "string" ? new Date(date) : date);
}
