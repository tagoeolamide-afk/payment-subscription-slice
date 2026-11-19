-- AlterTable
ALTER TABLE "payments" ADD COLUMN "payment_method" TEXT;

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN "payment_method" TEXT;


-- Backfill: rows with card details were paid by card.
UPDATE "subscriptions" SET "payment_method" = 'card' WHERE "card_last4" IS NOT NULL;
UPDATE "payments" SET "payment_method" = 'card' WHERE "card_last4" IS NOT NULL;
