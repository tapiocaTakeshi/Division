import { Router, Request, Response } from "express";
import { asyncHandler } from "../middleware/async-handler";
import { prisma } from "../db";
import {
  listAvailableModels,
  listModelsForProvider,
  clearModelCache,
  syncModelsToDb,
} from "../services/sync-models";

const router = Router();

/**
 * GET /api/models/available
 * List all available models from provider APIs (real-time, cached 1h).
 *
 * Query params:
 *   - provider (optional): Filter by provider (openai, anthropic, google, xai, deepseek, perplexity)
 */
router.get(
  "/available",
  asyncHandler(async (req: Request, res: Response) => {
    const provider = req.query.provider as string | undefined;
    const result = await listAvailableModels(provider);
    res.json(result);
  })
);

/**
 * POST /api/models/sync
 * Fetch latest models from all provider APIs and save to DB.
 */
router.post(
  "/sync",
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await syncModelsToDb();
    res.json(result);
  })
);

/**
 * POST /api/models/refresh
 * Clear the in-memory cache and re-fetch from APIs.
 */
router.post(
  "/refresh",
  asyncHandler(async (_req: Request, res: Response) => {
    clearModelCache();
    const result = await listAvailableModels();
    res.json(result);
  })
);

/**
 * GET /api/models/provider/:providerId
 * List models for a specific provider from DB.
 */
router.get(
  "/provider/:providerId",
  asyncHandler(async (req: Request, res: Response) => {
    const { providerId } = req.params;

    const provider = await prisma.provider.findFirst({
      where: {
        OR: [
          { id: providerId },
          { apiType: providerId },
          { name: { equals: providerId, mode: "insensitive" } },
        ],
      },
    });

    if (!provider) {
      res.status(404).json({ error: `Provider "${providerId}" not found` });
      return;
    }

    const models = await prisma.model.findMany({
      where: { providerId: provider.id, isEnabled: true },
      orderBy: { modelId: "asc" },
      select: { modelId: true, displayName: true },
    });

    // If DB is empty for this provider, fall back to real-time fetch
    if (models.length === 0) {
      const realtime = await listModelsForProvider(provider.apiType);
      if (realtime) {
        res.json({
          provider: provider.name,
          apiType: provider.apiType,
          models: realtime.models,
          source: "api",
          ...(realtime.error ? { error: realtime.error } : {}),
        });
        return;
      }
    }

    res.json({
      provider: provider.name,
      apiType: provider.apiType,
      models,
      source: "db",
    });
  })
);

export { router as modelSyncRouter };
