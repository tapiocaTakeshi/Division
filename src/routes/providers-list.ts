import { Router } from "express";
import { prisma } from "../db";

const router = Router();

/**
 * GET /api/providers
 * List all available AI providers/models
 */
router.get("/", async (_req, res) => {
  try {
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
  } catch (err: unknown) {
    res.status(500).json({
      error: "Failed to list providers",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
