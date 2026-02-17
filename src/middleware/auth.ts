/**
 * Clerk Authentication Middleware
 *
 * Validates Bearer tokens via Clerk.
 * When a valid Clerk token is present, sets res.locals.authenticated = true,
 * which allows downstream routes to use server-side provider API keys
 * from environment variables.
 */

import { clerkMiddleware, getAuth } from "@clerk/express";
import { Request, Response, NextFunction } from "express";

export { clerkMiddleware };

/**
 * Middleware that checks Clerk auth state and sets res.locals.authenticated.
 * Does NOT block unauthenticated requests — they can still proceed
 * but must supply their own API keys in the request body.
 */
export function divisionAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = getAuth(req);
    res.locals.authenticated = !!auth.userId;
  } catch {
    res.locals.authenticated = false;
  }
  next();
}
