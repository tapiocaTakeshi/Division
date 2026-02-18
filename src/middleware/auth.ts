/**
 * Authentication Middleware
 *
 * Supports two authentication methods:
 *
 * 1. **Clerk Authentication** (frontend / OAuth users)
 *    Validates session tokens via Clerk. Used by the Conductor UI.
 *
 * 2. **Division API Key** (MCP servers / external clients / Vercel)
 *    Validates `Authorization: Bearer ak_xxx` against:
 *      a) Database-stored API keys (created by Clerk users)
 *      b) The DIVISION_API_KEY environment variable (legacy fallback)
 *    Used by MCP servers, curl, and programmatic access.
 *
 * When either method succeeds, sets res.locals.authenticated = true,
 * which allows downstream routes to use server-side provider API keys
 * from environment variables.
 */

import { clerkMiddleware as _clerkMiddleware, getAuth } from "@clerk/express";
import { Request, Response, NextFunction } from "express";
import { prisma } from "../db";

/**
 * Check whether Clerk is configured by looking for required env vars.
 * When deploying without Clerk (API-key-only mode), this avoids
 * the "Publishable key is missing" error.
 * Read dynamically so env var changes are reflected without restart.
 */
function isClerkConfigured(): boolean {
  return !!process.env.CLERK_PUBLISHABLE_KEY && !!process.env.CLERK_SECRET_KEY;
}

/**
 * Wraps Clerk's middleware so it only runs when Clerk env vars are present.
 * When Clerk is not configured, this is a no-op passthrough.
 */
export function clerkMiddleware() {
  if (isClerkConfigured()) {
    return _clerkMiddleware();
  }
  // No-op: skip Clerk when keys aren't configured
  return (_req: Request, _res: Response, next: NextFunction) => next();
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
async function validateDbApiKey(token: string): Promise<boolean> {
  try {
    const apiKey = await prisma.apiKey.findUnique({
      where: { key: token },
      select: { revoked: true },
    });
    return !!apiKey && !apiKey.revoked;
  } catch {
    // DB unavailable — fall through to env var check
    return false;
  }
}

/**
 * Unified authentication middleware.
 *
 * Authentication priority:
 *   1. Division API Key — `Authorization: Bearer ak_xxx`
 *      a) Check database first (Clerk-user-generated keys)
 *      b) Fall back to DIVISION_API_KEY env var (legacy)
 *   2. Clerk session token — validated via getAuth()
 *
 * Does NOT block unauthenticated requests — they can still proceed
 * but must supply their own provider API keys in the request body.
 */
export function divisionAuth(req: Request, res: Response, next: NextFunction) {
  // 1. Check Division API key (ak_ prefix)
  const token = extractBearerToken(req);
  if (token && token.startsWith("ak_")) {
    // Try DB first, then env var fallback
    validateDbApiKey(token)
      .then((valid) => {
        res.locals.authenticated = valid || validateEnvApiKey(token);
        next();
      })
      .catch(() => {
        res.locals.authenticated = validateEnvApiKey(token);
        next();
      });
    return;
  }

  // 2. Fall back to Clerk authentication
  if (isClerkConfigured()) {
    try {
      const auth = getAuth(req);
      res.locals.authenticated = !!auth.userId;
    } catch {
      res.locals.authenticated = false;
    }
  } else {
    res.locals.authenticated = false;
  }

  next();
}
