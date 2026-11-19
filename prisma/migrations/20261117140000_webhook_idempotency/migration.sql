-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_webhook_events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "event_key" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "provider_ref" TEXT,
    "tx_ref" TEXT,
    "signature_method" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "result" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "deliveries" INTEGER NOT NULL DEFAULT 1,
    "received_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_delivered_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" DATETIME,
    "processed_at" DATETIME
);
INSERT INTO "new_webhook_events" ("attempts", "event_key", "event_type", "id", "payload", "processed_at", "received_at", "result", "signature_method", "status", "tx_ref") SELECT "attempts", "event_key", "event_type", "id", "payload", "processed_at", "received_at", "result", "signature_method", "status", "tx_ref" FROM "webhook_events";
DROP TABLE "webhook_events";
ALTER TABLE "new_webhook_events" RENAME TO "webhook_events";
CREATE UNIQUE INDEX "webhook_events_event_key_key" ON "webhook_events"("event_key");
CREATE INDEX "webhook_events_status_received_at_idx" ON "webhook_events"("status", "received_at");
CREATE INDEX "webhook_events_tx_ref_idx" ON "webhook_events"("tx_ref");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;


-- Backfill: key existing rows on the provider reference (Flutterwave transaction id, else flw_ref).
UPDATE "webhook_events" SET
  "provider_ref" = COALESCE(CAST(json_extract("payload", '$.data.id') AS TEXT), json_extract("payload", '$.data.flw_ref')),
  "last_delivered_at" = "received_at";

-- Rows that are now the same event for the same transaction: keep the first, count the rest as deliveries.
UPDATE "webhook_events" SET "deliveries" = (
  SELECT COUNT(*) FROM "webhook_events" w2
  WHERE w2."event_type" = "webhook_events"."event_type" AND w2."provider_ref" = "webhook_events"."provider_ref"
) WHERE "provider_ref" IS NOT NULL;
DELETE FROM "webhook_events" WHERE "provider_ref" IS NOT NULL AND "id" NOT IN (
  SELECT MIN("id") FROM "webhook_events" WHERE "provider_ref" IS NOT NULL GROUP BY "event_type", "provider_ref"
);

UPDATE "webhook_events" SET "event_key" = 'flutterwave:' || "event_type" || ':' || "provider_ref" WHERE "provider_ref" IS NOT NULL;
