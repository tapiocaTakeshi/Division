import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler } from "../middleware/async-handler";

const router = Router();

/**
 * GET /api/models
 * List all available AI providers/models
 */
router.get("/", asyncHandler(async (_req, res) => {
  const providers = await prisma.provider.findMany({
    orderBy: { name: "asc" },
    select: {
      name: true,
      displayName: true,
      apiType: true,
      modelId: true,
      description: true,
    },
  });
  res.json({ providers });
}));

export default router;
