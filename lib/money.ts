/**
 * Money is a whole number of minor units (kobo for NGN) plus its ISO 4217 currency code.
 * The app passes Money around unconverted. Major units (naira) appear only at the
 * Flutterwave boundary (lib/flutterwave.ts), because its API expects them, and in
 * formatted display strings.
 */

export type Money = { readonly minor: number; readonly currency: string };

export class MoneyError extends Error {}

function assertCurrency(currency: string): void {
  if (!/^[A-Z]{3}$/.test(currency)) throw new MoneyError(`Invalid currency code: ${JSON.stringify(currency)}`);
}

function assertMinor(minor: number): void {
  if (!Number.isSafeInteger(minor)) throw new MoneyError(`Money must be a whole number of minor units, got ${minor}`);
}

export function money(minor: number, currency: string): Money {
  assertMinor(minor);
  assertCurrency(currency);
  return { minor, currency };
}

/** Minor-unit digits for a currency (NGN: 2, JPY: 0), from the ICU currency data. */
export function minorDigits(currency: string): number {
  assertCurrency(currency);
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

const factor = (currency: string) => 10 ** minorDigits(currency);

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new MoneyError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.minor + b.minor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.minor - b.minor, a.currency);
}

/** Multiplies by a whole number (e.g. 12 months). */
export function times(a: Money, n: number): Money {
  if (!Number.isInteger(n)) throw new MoneyError(`times() needs a whole number, got ${n}`);
  return money(a.minor * n, a.currency);
}

/** Splits into `n` parts, rounded to the nearest whole major unit. For display only, never for charging. */
export function approxPerPart(a: Money, n: number): Money {
  const f = factor(a.currency);
  return money(Math.round(a.minor / n / f) * f, a.currency);
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minor === b.minor;
}

/** Major units for a provider API that wants them (5_000_00 kobo -> 5000). */
export function toMajorUnits(a: Money): number {
  return a.minor / factor(a.currency);
}

/**
 * Reads a provider's major-unit amount back into Money. Rounds once to absorb float
 * noise (e.g. 49.99 * 100 = 4998.999…); anything that isn't a finite number is rejected.
 */
export function fromMajorUnits(amount: number | string, currency: string): Money {
  const value = typeof amount === "string" ? Number(amount.trim()) : amount;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MoneyError(`Not a money amount: ${JSON.stringify(amount)}`);
  }
  return money(Math.round(value * factor(currency)), currency);
}

const formatters = new Map<string, Intl.NumberFormat>();

/** "₦5,000", or "₦4,999.50" when there are minor units to show. */
export function formatMoney(a: Money): string {
  const f = factor(a.currency);
  const whole = a.minor % f === 0;
  const key = `${a.currency}:${whole}`;
  let fmt = formatters.get(key);
  if (!fmt) {
    const digits = minorDigits(a.currency);
    fmt = new Intl.NumberFormat("en-NG", {
      style: "currency",
      currency: a.currency,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: whole ? 0 : digits,
      maximumFractionDigits: digits,
    });
    formatters.set(key, fmt);
  }
  return fmt.format(a.minor / f);
}
