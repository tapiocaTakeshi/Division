/**
 * API Key Management Routes
 *
 * Allows authenticated Clerk users to create, list, and revoke
 * Division API keys (ak_xxx format) stored in the database.
 *
 * All routes require Clerk authentication.
 *
 * POST   /api/api-keys       — Create a new API key
 * GET    /api/api-keys       — List all keys for the current user
 * DELETE /api/api-keys/:id   — Revoke an API key
 */

import { Router, Request, Response } from "express";
import crypto from "crypto";
import { getAuth } from "@clerk/express";
import { prisma } from "../db";
import { asyncHandler } from "../middleware/async-handler";

export const apiKeyRouter = Router();

/** Generate a random API key with ak_ prefix */
function generateApiKey(): string {
  const bytes = crypto.randomBytes(24);
  return `ak_${bytes.toString("base64url")}`;
}

/** Extract Clerk userId from request, returns null if not authenticated */
function getClerkUserId(req: Request): string | null {
  try {
    const auth = getAuth(req);
    return auth.userId || null;
  } catch {
    return null;
  }
}

/**
 * POST /api/api-keys
 * Create a new API key for the authenticated user.
 */
apiKeyRouter.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = getClerkUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Clerk authentication required to manage API keys" });
      return;
    }

    const name = req.body.name || "default";
    const key = generateApiKey();

    const apiKey = await prisma.apiKey.create({
      data: { key, userId, name },
    });

    // Return the full key only at creation time
    res.status(201).json({
      id: apiKey.id,
      key: apiKey.key,
      name: apiKey.name,
      createdAt: apiKey.createdAt,
    });
  })
);

/**
 * GET /api/api-keys
 * List all API keys for the authenticated user.
 * Keys are masked (only first 7 chars shown).
 */
apiKeyRouter.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = getClerkUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Clerk authentication required to manage API keys" });
      return;
    }

    const keys = await prisma.apiKey.findMany({
      where: { userId, revoked: false },
      select: { id: true, key: true, name: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });

    // Mask keys for security
    const masked = keys.map((k) => ({
      ...k,
      key: k.key.slice(0, 7) + "..." + k.key.slice(-4),
    }));

    res.json(masked);
  })
);

/**
 * DELETE /api/api-keys/:id
 * Revoke an API key (soft delete).
 */
apiKeyRouter.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = getClerkUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Clerk authentication required to manage API keys" });
      return;
    }

    const apiKey = await prisma.apiKey.findFirst({
      where: { id: req.params.id, userId },
    });

    if (!apiKey) {
      res.status(404).json({ error: "API key not found" });
      return;
    }

    await prisma.apiKey.update({
      where: { id: apiKey.id },
      data: { revoked: true },
    });

    res.json({ message: "API key revoked" });
  })
);
