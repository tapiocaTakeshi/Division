/**
 * Authentication Middleware
 *
 * Supports two authentication methods:
 *
 * 1. **Supabase Authentication** (frontend / OAuth users)
 *    Validates JWTs issued by Supabase.
 *
 * 2. **Division API Key** (MCP servers / external clients / Vercel)
 *    Validates `Authorization: Bearer ak_xxx` against:
 *      a) Database-stored API keys (created by users)
 *      b) The DIVISION_API_KEY environment variable (legacy fallback)
 *    Used by MCP servers, curl, and programmatic access.
 *
 * When either method succeeds, sets res.locals.authenticated = true,
 * which allows downstream routes to use server-side provider API keys
 * from environment variables.
 */

import { Request, Response, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";
import { prisma } from "../db";

/** Lazy Supabase client — only created when env vars are present */
function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Verify a Supabase JWT by calling the Supabase Auth API.
 * Returns the Supabase user UUID on success, null otherwise.
 */
export async function validateSupabaseToken(token: string): Promise<string | null> {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) return null;
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return null;
    return data.user.id;
  } catch {
    return null;
  }
}

/**
 * Extract a Bearer token from the Authorization header.
 * Returns undefined when the header is missing or malformed.
 */
function extractBearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const parts = header.split(" ");
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
    return parts[1];
  }
  return undefined;
}

/**
 * Validate a Division API key (ak_xxx format) against the env var (legacy).
 * Uses timing-safe comparison to prevent timing attacks.
 */
function validateEnvApiKey(token: string): boolean {
  const serverKey = process.env.DIVISION_API_KEY;
  if (!serverKey) return false;
  if (token.length !== serverKey.length) return false;

  // Constant-time comparison
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) {
    mismatch |= token.charCodeAt(i) ^ serverKey.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Validate a Division API key against the database.
 * Returns true if the key exists and is not revoked.
 */
async function validateDbApiKey(token: string): Promise<{ valid: boolean; userId?: string }> {
  try {
    const apiKey = await prisma.apiKey.findUnique({
      where: { key: token },
      select: { revoked: true, userId: true },
    });
    if (apiKey && !apiKey.revoked) {
      return { valid: true, userId: apiKey.userId };
    }
    return { valid: false };
  } catch {
    // DB unavailable — fall through to env var check
    return { valid: false };
  }
}

/**
 * Unified authentication middleware.
 *
 * Authentication priority:
 *   1. Division API Key — `Authorization: Bearer ak_xxx`
 *      a) Check database first
 *      b) Fall back to DIVISION_API_KEY env var (legacy)
 *   2. Supabase JWT — validated via Supabase Auth API
 *
 * Does NOT block unauthenticated requests — they can still proceed
 * but must supply their own provider API keys in the request body.
 */
export function divisionAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractBearerToken(req);

  // 1. Check Division API key (ak_ prefix)
  if (token && token.startsWith("ak_")) {
    validateDbApiKey(token)
      .then((dbResult) => {
        const envValid = validateEnvApiKey(token);
        res.locals.authenticated = dbResult.valid || envValid;
        if (dbResult.valid && dbResult.userId) {
          res.locals.userId = dbResult.userId;
        }
        console.log(`[divisionAuth] ak_ key: db=${dbResult.valid}, env=${envValid}, userId=${res.locals.userId || 'env'}, authenticated=${res.locals.authenticated}`);
        next();
      })
      .catch((err) => {
        const envValid = validateEnvApiKey(token);
        res.locals.authenticated = envValid;
        console.error(`[divisionAuth] DB check failed:`, err);
        next();
      });
    return;
  }

  // 2. Try Supabase JWT
  if (token) {
    validateSupabaseToken(token)
      .then((supabaseUserId) => {
        res.locals.authenticated = !!supabaseUserId;
        if (supabaseUserId) {
          res.locals.userId = supabaseUserId;
          console.log(`[divisionAuth] Supabase JWT: userId=${supabaseUserId}`);
        }
        next();
      })
      .catch(() => {
        res.locals.authenticated = false;
        next();
      });
    return;
  }

  // No token
  res.locals.authenticated = false;
  next();
}
