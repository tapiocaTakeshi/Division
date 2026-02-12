import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";

function getDatabaseUrl(): string {
  // On Vercel: copy bundled DB to writable /tmp
  if (process.env.VERCEL) {
    const tmpDb = "/tmp/dev.db";
    if (!fs.existsSync(tmpDb)) {
      // Try multiple candidate paths:
      // - ncc bundles includeFiles relative to function root (__dirname)
      // - fallback to ../prisma/dev.db for non-bundled layouts
      const candidates = [
        path.join(__dirname, "prisma/dev.db"),
        path.join(__dirname, "../prisma/dev.db"),
        path.join(process.cwd(), "prisma/dev.db"),
      ];
      for (const src of candidates) {
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, tmpDb);
          break;
        }
      }
    }
    return `file:${tmpDb}`;
  }
  // Local: use DATABASE_URL from .env
  return process.env.DATABASE_URL || "file:./prisma/dev.db";
}

export const prisma = new PrismaClient({
  datasources: {
    db: {
      url: getDatabaseUrl(),
    },
  },
});
