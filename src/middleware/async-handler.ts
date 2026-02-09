import { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Wraps an async Express route handler to catch rejected promises
 * and forward them to Express error handling middleware.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
