import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";

function getDatabaseUrl(): string {
  // On Vercel: copy bundled DB to writable /tmp
  if (process.env.VERCEL) {
    const tmpDb = "/tmp/dev.db";
    if (!fs.existsSync(tmpDb)) {
      const sourceDb = path.join(__dirname, "../prisma/dev.db");
      if (fs.existsSync(sourceDb)) {
        fs.copyFileSync(sourceDb, tmpDb);
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
