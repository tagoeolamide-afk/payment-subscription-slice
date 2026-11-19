-- Optional reason given after cancelling. New billing event type cancellation_reason_given is a TEXT value.
ALTER TABLE "subscriptions" ADD COLUMN "cancellation_reason" TEXT;
ALTER TABLE "subscriptions" ADD COLUMN "cancellation_note" TEXT;
ALTER TABLE "subscriptions" ADD COLUMN "cancellation_reason_at" DATETIME;
