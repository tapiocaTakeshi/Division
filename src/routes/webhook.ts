import { Router, Request, Response } from "express";
import { asyncHandler } from "../middleware/async-handler";
import { prisma } from "../db";

const router = Router();

const WEBHOOK_SECRET = process.env.DIVISION_WEBHOOK_SECRET || process.env.DIVISION_API_KEY || "";

/**
 * POST /api/webhook/usage
 * Receive usage notifications from external services or internal usage tracking.
 * Returns aggregated usage stats for the user.
 */
router.post(
  "/usage",
  asyncHandler(async (req: Request, res: Response) => {
    // Verify webhook secret
    const authHeader = req.headers.authorization;
    if (WEBHOOK_SECRET && authHeader !== `Bearer ${WEBHOOK_SECRET}`) {
      res.status(401).json({ error: "Invalid webhook secret" });
      return;
    }

    const { event, usageId, userId } = req.body;

    if (event !== "usage.recorded" || !usageId) {
      res.status(400).json({ error: "Invalid webhook payload" });
      return;
    }

    // Look up the usage log entry
    const usage = await prisma.usageLog.findUnique({ where: { id: usageId } });
    if (!usage) {
      res.status(404).json({ error: "Usage record not found" });
      return;
    }

    // Aggregate user stats if userId is present
    let userStats = null;
    if (userId) {
      const agg = await prisma.usageLog.aggregate({
        where: { userId },
        _sum: { totalCostUsd: true, inputTokens: true, outputTokens: true },
        _count: true,
      });
      userStats = {
        totalCostUsd: Number(agg._sum.totalCostUsd || 0),
        totalInputTokens: agg._sum.inputTokens || 0,
        totalOutputTokens: agg._sum.outputTokens || 0,
        totalRequests: agg._count,
      };
    }

    res.json({
      received: true,
      usageId,
      cost: Number(usage.totalCostUsd),
      userStats,
    });
  })
);

/**
 * GET /api/webhook/usage/stats
 * Get usage statistics for a user or project.
 * Query params: userId, projectId, sessionId, from, to
 */
router.get(
  "/usage/stats",
  asyncHandler(async (req: Request, res: Response) => {
    const { userId, projectId, sessionId, from, to } = req.query;

    const where: Record<string, unknown> = {};
    if (userId) where.userId = userId;
    if (projectId) where.projectId = projectId;
    if (sessionId) where.sessionId = sessionId;
    if (from || to) {
      where.createdAt = {};
      if (from) (where.createdAt as Record<string, unknown>).gte = new Date(from as string);
      if (to) (where.createdAt as Record<string, unknown>).lte = new Date(to as string);
    }

    const [agg, byProvider, recentLogs] = await Promise.all([
      prisma.usageLog.aggregate({
        where,
        _sum: { totalCostUsd: true, inputTokens: true, outputTokens: true },
        _count: true,
      }),
      prisma.usageLog.groupBy({
        by: ["providerId"],
        where,
        _sum: { totalCostUsd: true, inputTokens: true, outputTokens: true },
        _count: true,
      }),
      prisma.usageLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          providerId: true,
          modelId: true,
          role: true,
          inputTokens: true,
          outputTokens: true,
          totalCostUsd: true,
          createdAt: true,
        },
      }),
    ]);

    res.json({
      summary: {
        totalCostUsd: Number(agg._sum.totalCostUsd || 0),
        totalInputTokens: agg._sum.inputTokens || 0,
        totalOutputTokens: agg._sum.outputTokens || 0,
        totalRequests: agg._count,
      },
      byProvider: byProvider.map((p) => ({
        providerId: p.providerId,
        totalCostUsd: Number(p._sum.totalCostUsd || 0),
        totalInputTokens: p._sum.inputTokens || 0,
        totalOutputTokens: p._sum.outputTokens || 0,
        requests: p._count,
      })),
      recentLogs: recentLogs.map((l) => ({
        ...l,
        totalCostUsd: Number(l.totalCostUsd),
      })),
    });
  })
);

export { router as webhookRouter };
