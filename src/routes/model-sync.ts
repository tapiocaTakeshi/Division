import { Router, Request, Response } from "express";
import { asyncHandler } from "../middleware/async-handler";
import { prisma } from "../db";
import {
  listAvailableModels,
  fetchModelsForProvider,
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
 * List models in real-time: provider.apiBaseUrl + modelsEndpoint
 * Results are cached in-memory (1h) for performance.
 *
 * Query params:
 *   - refresh (optional): "true" to bypass cache and force a fresh fetch
 */
router.get(
  "/provider/:providerId",
  asyncHandler(async (req: Request, res: Response) => {
    const { providerId } = req.params;
    const forceRefresh = req.query.refresh === "true";

    // id exact match first, then fallback to apiType / name
    let provider = await prisma.provider.findUnique({ where: { id: providerId } });
    if (!provider) {
      provider = await prisma.provider.findFirst({
        where: {
          OR: [
            { apiType: providerId },
            { name: { equals: providerId, mode: "insensitive" } },
          ],
        },
      });
    }

    if (!provider) {
      res.status(404).json({ error: `Provider "${providerId}" not found` });
      return;
    }

    if (forceRefresh) {
      clearModelCache();
    }

    const result = await fetchModelsForProvider(provider);

    res.json({
      provider: provider.name,
      apiBaseUrl: provider.apiBaseUrl,
      apiType: provider.apiType,
      models: result.models,
      endpoint: result.endpoint,
      source: "api",
      ...(result.error ? { error: result.error } : {}),
    });
  })
);

export { router as modelSyncRouter };
