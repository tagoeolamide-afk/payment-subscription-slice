-- Proration for mid-cycle monthly -> yearly switches.
-- New payment kind `plan_change` and checkout purpose `plan_change` are TEXT values (no constraint to change).

-- Payment: the proration breakdown (JSON, lib/proration.ts).
ALTER TABLE "payments" ADD COLUMN "proration" TEXT;

-- Checkout: what it pays for, and for a plan change, which subscription and the breakdown.
ALTER TABLE "checkouts" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'subscribe';
ALTER TABLE "checkouts" ADD COLUMN "subscription_id" INTEGER;
ALTER TABLE "checkouts" ADD COLUMN "proration" TEXT;
