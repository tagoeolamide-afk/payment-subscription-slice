-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "checkouts" (  
    "tx_ref" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "flutterwave_plan_id" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'initiated',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" DATETIME,
    CONSTRAINT "checkouts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "started_at" DATETIME NOT NULL,
    "current_period_end" DATETIME NOT NULL,
    "cancelled_at" DATETIME,
    "flw_subscription_id" INTEGER,
    "card_brand" TEXT,
    "card_last4" TEXT,
    "tx_ref" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "subscriptions_tx_ref_fkey" FOREIGN KEY ("tx_ref") REFERENCES "checkouts" ("tx_ref") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "payments" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tx_ref" TEXT NOT NULL,
    "transaction_id" INTEGER NOT NULL,
    "user_id" TEXT NOT NULL,
    "subscription_id" INTEGER,
    "plan_id" TEXT NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "paid_at" DATETIME NOT NULL,
    "card_brand" TEXT,
    "card_last4" TEXT,
    CONSTRAINT "payments_tx_ref_fkey" FOREIGN KEY ("tx_ref") REFERENCES "checkouts" ("tx_ref") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payments_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "checkouts_user_id_created_at_idx" ON "checkouts"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_tx_ref_key" ON "subscriptions"("tx_ref");

-- CreateIndex
CREATE INDEX "subscriptions_user_id_status_idx" ON "subscriptions"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tx_ref_key" ON "payments"("tx_ref");

-- CreateIndex
CREATE UNIQUE INDEX "payments_transaction_id_key" ON "payments"("transaction_id");

-- CreateIndex
CREATE INDEX "payments_user_id_paid_at_idx" ON "payments"("user_id", "paid_at");

-- Hand-written: at most one current (active or cancelled-but-running) subscription per user.
-- Prisma schema syntax cannot express a partial unique index.
CREATE UNIQUE INDEX "subscriptions_one_current" ON "subscriptions"("user_id") WHERE "status" IN ('active', 'cancelled');
