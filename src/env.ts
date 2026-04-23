/**
 * Map Supabase–Vercel integration environment variables to the names
 * expected by Prisma and the application code.
 *
 * The Vercel Supabase integration prefixes all variables with the project
 * name (e.g. "division_POSTGRES_URL" instead of "DATABASE_URL").
 * This module bridges the gap so the rest of the codebase can use the
 * standard names.
 *
 * Must be imported before any database or Supabase client usage.
 */

import { config as loadEnvFile } from "dotenv";
import { resolve } from "path";

// Local / non-Vercel: load .env then .env.local so provider API keys resolve (ANTHROPIC_API_KEY, etc.)
if (!process.env.VERCEL) {
  const root = resolve(__dirname, "..");
  loadEnvFile({ path: resolve(root, ".env") });
  loadEnvFile({ path: resolve(root, ".env.local"), override: true });
}

function setIfMissing(target: string, ...sources: string[]) {
  if (process.env[target]) return;
  for (const source of sources) {
    if (process.env[source]) {
      process.env[target] = process.env[source];
      return;
    }
  }
}

// Prisma database URLs
setIfMissing("DATABASE_URL", "division_POSTGRES_PRISMA_URL", "division_POSTGRES_URL");
setIfMissing("DIRECT_URL", "division_POSTGRES_URL_NON_POOLING", "division_POSTGRES_URL");

// Supabase client
setIfMissing("SUPABASE_URL", "division_SUPABASE_URL");
setIfMissing("SUPABASE_SERVICE_ROLE_KEY", "division_SUPABASE_SERVICE_ROLE_KEY");
setIfMissing("SUPABASE_ANON_KEY", "division_SUPABASE_ANON_KEY");
