import "server-only";

export class ConfigError extends Error {}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ConfigError(`${name} is not set. Add it to .env.local (see .env.example).`);
  }
  return value;
}

export function flutterwaveSecretKey(): string {
  const key = required("FLW_SECRET_KEY");
  // Guard rail: this slice is test-mode only.
  if (!key.startsWith("FLWSECK_TEST-")) {
    throw new ConfigError("FLW_SECRET_KEY must be a test-mode key (starts with FLWSECK_TEST-).");
  }
  return key;
}

export function appUrl(): string {
  return (process.env.APP_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "");
}

/**
 * Secret hash for verifying Flutterwave webhooks (dashboard -> Settings -> Webhooks).
 * Returns null when unset; the webhook endpoint then refuses every request.
 */
export function webhookSecretHash(): string | null {
  return process.env.FLW_WEBHOOK_SECRET_HASH?.trim() || null;
}

/**
 * redirect_url sent with saved-card (token) charges. Flutterwave requires a public
 * https URL there and rejects localhost; it's only used if the bank asks the customer
 * to authenticate. Set FLW_CHARGE_REDIRECT_URL explicitly, or use APP_URL when it's
 * public https. For local development we fall back to the reserved example.com domain.
 */
export function chargeRedirectUrl(): string {
  const explicit = process.env.FLW_CHARGE_REDIRECT_URL?.trim();
  if (explicit) return explicit;
  const app = appUrl();
  const isPublicHttps = app.startsWith("https://") && !/^https:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(app);
  return isPublicHttps ? `${app}/billing` : "https://example.com/billing";
}
