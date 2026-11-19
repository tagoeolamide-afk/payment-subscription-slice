-- Payment log: every stage of every payment attempt as its own row.
-- billing_events keeps subscription lifecycle only; its payment rows are copied here, then removed.

-- CreateTable
CREATE TABLE "payment_logs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tx_ref" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "subscription_id" INTEGER,
    "kind" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "result" TEXT,
    "plan_id" TEXT NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "provider_transaction_id" INTEGER,
    "provider_status" TEXT,
    "provider_message" TEXT,
    "details" TEXT,
    "occurred_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "payment_logs_tx_ref_occurred_at_idx" ON "payment_logs"("tx_ref", "occurred_at");

-- CreateIndex
CREATE INDEX "payment_logs_user_id_occurred_at_idx" ON "payment_logs"("user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "payment_logs_stage_idx" ON "payment_logs"("stage");

-- Hand-written: a payment attempt is fulfilled at most once.
CREATE UNIQUE INDEX "payment_logs_one_fulfilment" ON "payment_logs"("tx_ref") WHERE "stage" = 'fulfilled';

-- Backfill from the old payment event types. Old rows didn't record verification separately,
-- so a success becomes a `verified` row followed by a `fulfilled` row at the same time.
-- details.migrated marks rows reconstructed this way.

-- checkout_started -> initiated
INSERT INTO "payment_logs" ("tx_ref","user_id","subscription_id","kind","stage","source","result","plan_id","amount_minor","currency","details","occurred_at")
SELECT "tx_ref","user_id","subscription_id",'initial','initiated','checkout',NULL,"plan_id","amount_minor","currency",
       '{"migrated":"checkout_started"}',"occurred_at"
FROM "billing_events" WHERE "type" = 'checkout_started' AND "tx_ref" IS NOT NULL;

-- payment_succeeded -> verified (successful) + fulfilled (active)
INSERT INTO "payment_logs" ("tx_ref","user_id","subscription_id","kind","stage","source","result","plan_id","amount_minor","currency","provider_transaction_id","provider_status","details","occurred_at")
SELECT "tx_ref","user_id","subscription_id",'initial','verified','return_page','successful',"plan_id","amount_minor","currency","provider_transaction_id",'successful',
       '{"migrated":"payment_succeeded"}',"occurred_at"
FROM "billing_events" WHERE "type" = 'payment_succeeded' AND "tx_ref" IS NOT NULL;
INSERT INTO "payment_logs" ("tx_ref","user_id","subscription_id","kind","stage","source","result","plan_id","amount_minor","currency","provider_transaction_id","details","occurred_at")
SELECT "tx_ref","user_id","subscription_id",'initial','fulfilled','return_page','active',"plan_id","amount_minor","currency","provider_transaction_id",
       '{"migrated":"payment_succeeded"}',"occurred_at"
FROM "billing_events" WHERE "type" = 'payment_succeeded' AND "tx_ref" IS NOT NULL;

-- payment_failed -> failed
INSERT INTO "payment_logs" ("tx_ref","user_id","subscription_id","kind","stage","source","result","plan_id","amount_minor","currency","provider_transaction_id","provider_status","details","occurred_at")
SELECT "tx_ref","user_id","subscription_id",'initial','failed','return_page',COALESCE(json_extract("details",'$.reason'),'unknown'),
       "plan_id","amount_minor","currency","provider_transaction_id",json_extract("details",'$.providerStatus'),
       '{"migrated":"payment_failed"}',"occurred_at"
FROM "billing_events" WHERE "type" = 'payment_failed' AND "tx_ref" IS NOT NULL;

-- renewal_pending -> verified (pending) + fulfilled (pending_settlement)
INSERT INTO "payment_logs" ("tx_ref","user_id","subscription_id","kind","stage","source","result","plan_id","amount_minor","currency","provider_transaction_id","provider_status","details","occurred_at")
SELECT "tx_ref","user_id","subscription_id",'renewal','verified','billing_run','pending',"plan_id","amount_minor","currency","provider_transaction_id",'pending',
       '{"migrated":"renewal_pending"}',"occurred_at"
FROM "billing_events" WHERE "type" = 'renewal_pending' AND "tx_ref" IS NOT NULL;
INSERT INTO "payment_logs" ("tx_ref","user_id","subscription_id","kind","stage","source","result","plan_id","amount_minor","currency","provider_transaction_id","details","occurred_at")
SELECT "tx_ref","user_id","subscription_id",'renewal','fulfilled','billing_run','pending_settlement',"plan_id","amount_minor","currency","provider_transaction_id",
       '{"migrated":"renewal_pending"}',"occurred_at"
FROM "billing_events" WHERE "type" = 'renewal_pending' AND "tx_ref" IS NOT NULL;

-- renewal_succeeded -> verified (successful); plus fulfilled unless it settled an earlier pending renewal
INSERT INTO "payment_logs" ("tx_ref","user_id","subscription_id","kind","stage","source","result","plan_id","amount_minor","currency","provider_transaction_id","provider_status","details","occurred_at")
SELECT "tx_ref","user_id","subscription_id",'renewal','verified','billing_run','successful',"plan_id","amount_minor","currency","provider_transaction_id",'successful',
       '{"migrated":"renewal_succeeded"}',"occurred_at"
FROM "billing_events" WHERE "type" = 'renewal_succeeded' AND "tx_ref" IS NOT NULL;
INSERT INTO "payment_logs" ("tx_ref","user_id","subscription_id","kind","stage","source","result","plan_id","amount_minor","currency","provider_transaction_id","details","occurred_at")
SELECT "tx_ref","user_id","subscription_id",'renewal','fulfilled','billing_run','active',"plan_id","amount_minor","currency","provider_transaction_id",
       '{"migrated":"renewal_succeeded"}',"occurred_at"
FROM "billing_events" WHERE "type" = 'renewal_succeeded' AND "tx_ref" IS NOT NULL
  AND json_extract("details",'$.settledFrom') IS NULL;

-- renewal_failed -> failed
INSERT INTO "payment_logs" ("tx_ref","user_id","subscription_id","kind","stage","source","result","plan_id","amount_minor","currency","provider_transaction_id","details","occurred_at")
SELECT "tx_ref","user_id","subscription_id",'renewal','failed','billing_run',COALESCE(json_extract("details",'$.reason'),'unknown'),
       "plan_id","amount_minor","currency","provider_transaction_id",
       '{"migrated":"renewal_failed"}',"occurred_at"
FROM "billing_events" WHERE "type" = 'renewal_failed' AND "tx_ref" IS NOT NULL;

-- Subscription lifecycle equivalents for renewals, so billing_events stays complete.
UPDATE "billing_events" SET "type" = 'subscription_renewed'
WHERE "type" IN ('renewal_pending', 'renewal_succeeded') AND json_extract("details",'$.settledFrom') IS NULL;
UPDATE "billing_events" SET "type" = 'subscription_past_due' WHERE "type" = 'renewal_failed';

-- Payment rows now live in payment_logs.
DELETE FROM "billing_events"
WHERE "type" IN ('checkout_started', 'payment_succeeded', 'payment_failed', 'renewal_succeeded', 'renewal_pending', 'renewal_failed');
