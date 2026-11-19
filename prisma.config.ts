import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// Prisma 7 doesn't load env files itself. Match Next.js: .env.local wins over .env.
config({ path: [".env.local", ".env"], quiet: true });

const databaseUrl = process.env.DATABASE_URL?.trim() || "file:./data/fieldnote.db";

// Prisma Studio 7.10 only recognises SQLite URLs written as `file://…` (it detects the
// protocol by splitting on "://"), while migrate and the app's driver use `file:./…`.
// Hand Studio the form it understands so plain `npx prisma studio` works.
const isStudio = process.argv.slice(2).includes("studio");
const url =
  isStudio && databaseUrl.startsWith("file:") && !databaseUrl.startsWith("file://")
    ? databaseUrl.replace(/^file:/, "file://")
    : databaseUrl;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: { url },
});
