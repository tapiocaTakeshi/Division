import { Router, Request, Response } from "express";
import { asyncHandler } from "../middleware/async-handler";
import { listAvailableModels, listModelsForProvider, clearModelCache } from "../services/sync-models";

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
 * POST /api/models/refresh
 * Clear the in-memory model cache so next request fetches fresh data.
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
 * List available models for a specific provider (cached).
 */
router.get(
  "/provider/:providerId",
  asyncHandler(async (req: Request, res: Response) => {
    const { providerId } = req.params;
    const result = await listModelsForProvider(providerId);
    if (!result) {
      res.status(404).json({ error: `Provider "${providerId}" not found` });
      return;
    }
    res.json({
      provider: result.provider,
      apiType: result.apiType,
      models: result.models,
      ...(result.error ? { error: result.error } : {}),
    });
  })
);

export { router as modelSyncRouter };
