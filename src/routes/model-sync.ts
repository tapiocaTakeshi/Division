import { Router, Request, Response } from "express";
import { asyncHandler } from "../middleware/async-handler";
import { listAvailableModels, syncModels } from "../services/sync-models";

const router = Router();

/**
 * GET /api/models/available
 * List all available models from provider APIs (read-only, no DB writes).
 * 
 * Query params:
 *   - provider (optional): Filter by provider name (openai, anthropic, google, xai, deepseek, mistral)
 *
 * Example:
 *   GET /api/models/available
 *   GET /api/models/available?provider=google
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
    res.json(result);
  })
);

export { router as modelSyncRouter };
