-- Rate limiting for checkout initiation (lib/rate-limit.ts).
CREATE TABLE "rate_limit_hits" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "created_at_ms" BIGINT NOT NULL
);
CREATE INDEX "rate_limit_hits_key_created_at_ms_idx" ON "rate_limit_hits"("key", "created_at_ms");
