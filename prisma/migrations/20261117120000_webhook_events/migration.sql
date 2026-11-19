-- CreateTable
CREATE TABLE "webhook_events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "event_key" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "tx_ref" TEXT,
    "signature_method" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "result" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "received_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_event_key_key" ON "webhook_events"("event_key");

-- CreateIndex
CREATE INDEX "webhook_events_status_received_at_idx" ON "webhook_events"("status", "received_at");

-- CreateIndex
CREATE INDEX "webhook_events_tx_ref_idx" ON "webhook_events"("tx_ref");

