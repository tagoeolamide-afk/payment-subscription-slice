-- CreateTable
CREATE TABLE "billing_events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" TEXT NOT NULL,
    "subscription_id" INTEGER,
    "type" TEXT NOT NULL,
    "plan_id" TEXT,
    "amount_minor" INTEGER,
    "currency" TEXT,
    "tx_ref" TEXT,
    "provider_transaction_id" INTEGER,
    "details" TEXT,
    "occurred_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "billing_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_payments" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tx_ref" TEXT NOT NULL,
    "checkout_tx_ref" TEXT,
    "transaction_id" INTEGER,
    "user_id" TEXT NOT NULL,
    "subscription_id" INTEGER,
    "kind" TEXT NOT NULL DEFAULT 'initial',
    "status" TEXT NOT NULL DEFAULT 'succeeded',
    "plan_id" TEXT NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "paid_at" DATETIME NOT NULL,
    "failure_reason" TEXT,
    "card_brand" TEXT,
    "card_last4" TEXT,
    CONSTRAINT "payments_checkout_tx_ref_fkey" FOREIGN KEY ("checkout_tx_ref") REFERENCES "checkouts" ("tx_ref") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payments_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
-- Existing rows are first payments that succeeded through a checkout with the same tx_ref.
INSERT INTO "new_payments" ("amount_minor", "card_brand", "card_last4", "currency", "id", "paid_at", "plan_id", "subscription_id", "transaction_id", "tx_ref", "user_id", "checkout_tx_ref", "kind", "status") SELECT "amount_minor", "card_brand", "card_last4", "currency", "id", "paid_at", "plan_id", "subscription_id", "transaction_id", "tx_ref", "user_id", "tx_ref", 'initial', 'succeeded' FROM "payments";
DROP TABLE "payments";
ALTER TABLE "new_payments" RENAME TO "payments";
CREATE UNIQUE INDEX "payments_tx_ref_key" ON "payments"("tx_ref");
CREATE UNIQUE INDEX "payments_checkout_tx_ref_key" ON "payments"("checkout_tx_ref");
CREATE UNIQUE INDEX "payments_transaction_id_key" ON "payments"("transaction_id");
CREATE INDEX "payments_user_id_paid_at_idx" ON "payments"("user_id", "paid_at");
CREATE TABLE "new_subscriptions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "billing_mode" TEXT NOT NULL DEFAULT 'app',
    "amount_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "started_at" DATETIME NOT NULL,
    "current_period_start" DATETIME NOT NULL,
    "current_period_end" DATETIME NOT NULL,
    "pending_plan_id" TEXT,
    "cancelled_at" DATETIME,
    "flw_subscription_id" INTEGER,
    "card_token" TEXT,
    "customer_email" TEXT,
    "card_brand" TEXT,
    "card_last4" TEXT,
    "tx_ref" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "subscriptions_tx_ref_fkey" FOREIGN KEY ("tx_ref") REFERENCES "checkouts" ("tx_ref") ON DELETE RESTRICT ON UPDATE CASCADE
);
-- Existing rows were created on Flutterwave payment plans; their period started when they did.
INSERT INTO "new_subscriptions" ("amount_minor", "cancelled_at", "card_brand", "card_last4", "created_at", "currency", "current_period_end", "flw_subscription_id", "id", "plan_id", "started_at", "status", "tx_ref", "updated_at", "user_id", "current_period_start", "billing_mode") SELECT "amount_minor", "cancelled_at", "card_brand", "card_last4", "created_at", "currency", "current_period_end", "flw_subscription_id", "id", "plan_id", "started_at", "status", "tx_ref", "updated_at", "user_id", "started_at", 'provider_plan' FROM "subscriptions";
DROP TABLE "subscriptions";
ALTER TABLE "new_subscriptions" RENAME TO "subscriptions";
CREATE UNIQUE INDEX "subscriptions_tx_ref_key" ON "subscriptions"("tx_ref");
CREATE INDEX "subscriptions_user_id_status_idx" ON "subscriptions"("user_id", "status");
-- Hand-written (Prisma can't express partial indexes): at most one current subscription per user.
CREATE UNIQUE INDEX "subscriptions_one_current" ON "subscriptions"("user_id") WHERE "status" IN ('active', 'cancelled', 'past_due');
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "billing_events_user_id_occurred_at_idx" ON "billing_events"("user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "billing_events_type_idx" ON "billing_events"("type");
