import "server-only";
import { flutterwaveSecretKey } from "./env";
import { fromMajorUnits, MoneyError, toMajorUnits, type Money } from "./money";

// Flutterwave v3 takes and returns amounts in major units (naira). This file is the only
// place that converts: callers pass Money in, and read Money back via transactionAmount().

const BASE_URL = "https://api.flutterwave.com/v3";

/** Raw provider failure. `message` is for logs; show users a friendly message instead. */
export class FlutterwaveError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}

type Envelope<T> = { status: string; message: string; data: T };

async function request<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  const key = flutterwaveSecretKey(); // may throw ConfigError; keep it outside the network try
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new FlutterwaveError(`Network error calling ${method} ${path}: ${(err as Error).message}`);
  }

  let json: Envelope<T> | null = null;
  try {
    json = (await res.json()) as Envelope<T>;
  } catch {
    // non-JSON body; handled below
  }
  if (!res.ok || json?.status !== "success") {
    throw new FlutterwaveError(`${method} ${path} failed: ${json?.message ?? `HTTP ${res.status}`}`, res.status);
  }
  return json.data;
}

type CreatePaymentInput = {
  txRef: string;
  amount: Money;
  redirectUrl: string;
  customer: { email: string; name: string };
  title: string;
  description: string;
  meta?: Record<string, string>;
};

/**
 * Flutterwave Standard: creates a one-time hosted checkout link. Card-only, so the verified
 * transaction carries a reusable card token; the app charges renewals with it.
 */
export async function createHostedPaymentLink(input: CreatePaymentInput): Promise<string> {
  const data = await request<{ link?: string }>("POST", "/payments", {
    tx_ref: input.txRef,
    amount: toMajorUnits(input.amount),
    currency: input.amount.currency,
    redirect_url: input.redirectUrl,
    payment_options: "card",
    customer: input.customer,
    customizations: { title: input.title, description: input.description },
    meta: input.meta,
  });
  if (!data?.link) throw new FlutterwaveError("POST /payments returned no link");
  return data.link;
}

export type FlwTransaction = {
  id: number;
  tx_ref: string;
  /** Major units, as Flutterwave sends it. Read it with transactionAmount(). */
  amount: number | string;
  currency: string;
  status: string; // "successful" | "failed" | "pending" | ...
  created_at: string;
  card?: { last_4digits?: string; type?: string; token?: string } | null;
  processor_response?: string;
  /** card, bank_transfer, ussd, ... Only card payments carry a reusable token. */
  payment_type?: string;
  customer?: { email?: string } | null;
};

/** The transaction's amount as Money, or null if Flutterwave sent something unusable. */
export function transactionAmount(tx: Pick<FlwTransaction, "amount" | "currency">): Money | null {
  try {
    return fromMajorUnits(tx.amount, tx.currency?.toUpperCase());
  } catch (err) {
    if (err instanceof MoneyError) return null;
    throw err;
  }
}

/** Looks the transaction up by OUR reference, so nothing from the redirect URL is trusted. */
export function verifyByReference(txRef: string): Promise<FlwTransaction> {
  return request<FlwTransaction>("GET", `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`);
}

/**
 * Charges a saved card token (no customer interaction). Used by the billing run for
 * renewals and scheduled plan changes. Resolves with Flutterwave's transaction; callers
 * should still confirm it with `verifyByReference`.
 */
export function chargeCardToken(input: {
  token: string;
  email: string;
  amount: Money;
  txRef: string;
  narration: string;
  /** Required by Flutterwave, used only if the bank asks the customer to authenticate. */
  redirectUrl: string;
}): Promise<FlwTransaction> {
  return request<FlwTransaction>("POST", "/tokenized-charges", {
    token: input.token,
    email: input.email,
    amount: toMajorUnits(input.amount),
    currency: input.amount.currency,
    country: "NG",
    tx_ref: input.txRef,
    narration: input.narration,
    redirect_url: input.redirectUrl,
  });
}
