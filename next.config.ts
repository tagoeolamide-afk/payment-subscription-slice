import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Native SQLite driver used by Prisma's adapter: load it from node_modules, don't bundle it.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
