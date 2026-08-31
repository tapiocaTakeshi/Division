/**
 * Local Agent Bridge routes
 *
 * The client (Orchestra's Electron main process) long-polls `/poll` for tool
 * calls Division has queued for its project, executes them locally, and
 * reports results back via `/result`. See src/services/local-runtime.ts.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/async-handler";
import { divisionAuth } from "../middleware/auth";
import { prisma } from "../db";
import { pollForProject, postToolResult, isProjectChannelConnected } from "../services/local-runtime";

export const localAgentRouter = Router();

const MAX_WAIT_MS = 25_000;

/**
 * This channel carries file contents and command output for a project, so
 * (unlike most Division routes) it must reject unauthenticated callers and
 * callers who don't own the project outright, rather than silently
 * degrading to server-side execution.
 */
const requireProjectOwner = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  if (!res.locals.authenticated) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const { projectId } = req.params;
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const userId = res.locals.userId as string | undefined;
  if (userId && project.userId && project.userId !== userId) {
    res.status(403).json({ error: "Access denied" });
    return;
  }
  next();
});

localAgentRouter.get(
  "/:projectId/poll",
  divisionAuth,
  requireProjectOwner,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectId } = req.params;
    const waitMs = Math.min(Number(req.query.waitMs) || MAX_WAIT_MS, MAX_WAIT_MS);
    const calls = await pollForProject(projectId, waitMs);
    res.json({ calls });
  })
);

const resultSchema = z.object({
  id: z.string().min(1),
  result: z.string().optional(),
  error: z.string().optional(),
});

localAgentRouter.post(
  "/:projectId/result",
  divisionAuth,
  requireProjectOwner,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectId } = req.params;
    const parsed = resultSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
      return;
    }
    const { id, result, error } = parsed.data;
    const ok = postToolResult(projectId, id, result, error);
    res.json({ ok });
  })
);

localAgentRouter.get(
  "/:projectId/status",
  divisionAuth,
  requireProjectOwner,
  asyncHandler(async (req: Request, res: Response) => {
    const { projectId } = req.params;
    res.json({ connected: isProjectChannelConnected(projectId) });
  })
);
