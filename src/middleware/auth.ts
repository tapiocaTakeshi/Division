/**
 * Clerk Authentication Middleware
 *
 * Validates Bearer tokens via Clerk.
 * When a valid Clerk token is present, sets res.locals.authenticated = true,
 * which allows downstream routes to use server-side provider API keys
 * from environment variables.
 *
 * Gracefully degrades when Clerk keys are not configured —
 * the app still runs but all requests are treated as unauthenticated.
 */

import { clerkMiddleware, getAuth } from "@clerk/express";
import { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Returns Clerk middleware only when keys are configured.
 * If Clerk is not configured, passes through without error.
 */
export function clerkAuth(): RequestHandler {
  if (
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY &&
    process.env.CLERK_SECRET_KEY
  ) {
    return clerkMiddleware();
  }
  // No Clerk keys — skip Clerk middleware entirely
  return (_req: Request, _res: Response, next: NextFunction) => next();
}

/**
 * Middleware that checks Clerk auth state and sets res.locals.authenticated.
 * Does NOT block unauthenticated requests — they can still proceed
 * but must supply their own API keys in the request body.
 */
export function divisionAuth(req: Request, res: Response, next: NextFunction) {
  // If Clerk is not configured, always unauthenticated
  if (
    !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||
    !process.env.CLERK_SECRET_KEY
  ) {
    res.locals.authenticated = false;
    next();
    return;
  }

  try {
    const auth = getAuth(req);
    res.locals.authenticated = !!auth.userId;
  } catch {
    res.locals.authenticated = false;
  }
  next();
}
