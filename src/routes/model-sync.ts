import { Router, Request, Response } from "express";
import { asyncHandler } from "../middleware/async-handler";
import { listAvailableModels, listModelsForProvider, syncModels } from "../services/sync-models";
import { getLatestModelsMap, clearLatestModelCache } from "../services/model-resolver";

const router = Router();

/**
 * GET /api/models/available
 * List all available models from provider APIs (read-only, no DB writes).
 *
 * Query params:
 *   - provider (optional): Filter by provider name (openai, anthropic, google, xai, deepseek, mistral)
 *   - refresh  (optional): "1" | "true" to bypass cache and re-query every provider API
 *
 * Example:
 *   GET /api/models/available
 *   GET /api/models/available?provider=google
 *   GET /api/models/available?refresh=1
 */
router.get(
  "/available",
  asyncHandler(async (req: Request, res: Response) => {
    const provider = req.query.provider as string | undefined;
    const refreshParam = req.query.refresh as string | undefined;
    const forceRefresh = refreshParam === "1" || refreshParam === "true";
    const result = await listAvailableModels(provider, forceRefresh);
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  })
);

/**
 * GET /api/models/latest
 * Returns the recommended "latest" flagship model per apiType.
 * Resolved dynamically from the DB (populated by sync).
 * Cached for 5 minutes.
 *
 * Example response:
 *   { openai: { modelId: "gpt-5.4", ... }, anthropic: { modelId: "claude-opus-4-7", ... }, ... }
 */
router.get(
  "/latest",
  asyncHandler(async (_req: Request, res: Response) => {
    const latest = await getLatestModelsMap();
    res.json(latest);
  })
);

/**
 * POST /api/models/sync
 * Sync models from provider APIs to database.
 * Fetches latest models and upserts into the Provider table.
 *
 * Example:
 *   POST /api/models/sync
 */
router.post(
  "/sync",
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await syncModels();
    clearLatestModelCache();
    res.json(result);
  })
);

/**
 * GET /api/models/provider/:providerId
 * List available models for a specific provider (cached).
 *
 * Example:
 *   GET /api/models/provider/openai
 *   GET /api/models/provider/google
 */
router.get(
  "/provider/:providerId",
  asyncHandler(async (req: Request, res: Response) => {
    const { providerId } = req.params;
    const refreshParam = req.query.refresh as string | undefined;
    const forceRefresh = refreshParam === "1" || refreshParam === "true";
    const result = await listModelsForProvider(providerId, forceRefresh);
    if (!result) {
      res.status(404).json({ error: `Provider "${providerId}" not found` });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({
      provider: result.provider,
      apiType: result.apiType,
      models: result.models.map((m) => ({ id: m.modelId, name: m.name })),
      ...(result.error ? { error: result.error } : {}),
    });
  })
);

export { router as modelSyncRouter };
