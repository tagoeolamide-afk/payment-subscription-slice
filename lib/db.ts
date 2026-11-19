import "server-only";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * Prisma client over SQLite (better-sqlite3 driver adapter, required by Prisma 7).
 * Schema: prisma/schema.prisma · migrations: prisma/migrations · browse: `npx prisma studio`.
 */

const url = process.env.DATABASE_URL?.trim() || "file:./data/fieldnote.db";

function createClient() {
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
}

// Reuse one client across dev hot reloads.
const g = globalThis as unknown as { __prisma?: PrismaClient };

export const prisma: PrismaClient = g.__prisma ?? createClient();
if (process.env.NODE_ENV !== "production") g.__prisma = prisma;
