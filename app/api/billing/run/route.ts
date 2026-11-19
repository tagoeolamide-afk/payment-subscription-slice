import { runBillingCycle } from "@/lib/billing";
import { retryWebhookEvents } from "@/lib/webhooks";

/**
 * Billing run endpoint for a scheduler (e.g. a cron job every hour):
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://your-app/api/billing/run
 * Retries webhooks that failed or never got processed, then renews due subscriptions,
 * applies scheduled plan changes and expires cancelled plans.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return Response.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const webhooks = await retryWebhookEvents();
  const results = await runBillingCycle();
  return Response.json({ ranAt: new Date().toISOString(), webhooks, results });
}
