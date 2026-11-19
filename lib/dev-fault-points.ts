/**
 * Development-only test errors (Test tools → Trigger an error). Each point throws on purpose
 * so the error screens can be seen. Shared by the server (lib/dev-faults.ts) and the menu.
 */
export const FAULT_POINTS = {
  billing_page: { label: "Billing page", shows: "Billing error page, inside the app layout", next: "/billing" },
  checkout_page: { label: "Checkout page", shows: "Checkout error page", next: "/checkout/pro_monthly" },
  return_page: {
    label: "Confirming a payment",
    shows: "“We couldn’t confirm your payment” on the return page",
    next: "/checkout/return?tx_ref=fn_test_fault",
  },
  actions: { label: "Buttons (actions)", shows: "Inline error when you click Pay, Cancel, Switch…", next: "/billing" },
  layout: { label: "App layout (top bar)", shows: "Error page with a minimal header", next: "/billing" },
  root_layout: { label: "Root layout", shows: "Last-resort global error page", next: "/billing" },
} as const;

export type FaultPoint = keyof typeof FAULT_POINTS;

export const FAULT_COOKIE = "fn_dev_fault";
export const FAULT_CLEAR_URL = "/api/dev/fault?clear=1";

export function isFaultPoint(value: unknown): value is FaultPoint {
  return typeof value === "string" && Object.hasOwn(FAULT_POINTS, value);
}

export function faultUrl(point: FaultPoint): string {
  return `/api/dev/fault?point=${point}`;
}

/** Only in development. Never in a production build. */
export function faultsEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}
