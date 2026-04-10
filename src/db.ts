import { PrismaClient } from "@prisma/client";

/**
 * Prisma client singleton.
 *
 * Connects to Supabase PostgreSQL via DATABASE_URL (pooled connection string).
 * DIRECT_URL is used by Prisma for migrations (non-pooled).
 */
export const prisma = new PrismaClient();
