import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler } from "../middleware/async-handler";

const router = Router();

/**
 * GET /api/models
 * List all AI providers (6 providers only).
 */
router.get("/", asyncHandler(async (_req, res) => {
  const providers = await prisma.provider.findMany({
    where: { isEnabled: true },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      displayName: true,
      apiType: true,
      modelId: true,
    },
  });
  res.json({ providers });
}));

export default router;
