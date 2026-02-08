import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { z } from "zod";
import { executeTask } from "../services/ai-executor";

export const taskRouter = Router();

const executeTaskSchema = z.object({
  projectId: z.string().min(1),
  roleSlug: z.string().min(1),
  input: z.string().min(1),
  config: z.record(z.unknown()).optional(),
});

// Execute a task: route to the AI assigned to the given role in the project
taskRouter.post("/execute", async (req: Request, res: Response) => {
  const parsed = executeTaskSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }

  const { projectId, roleSlug, input, config } = parsed.data;

  // Find the role by slug
  const role = await prisma.role.findUnique({ where: { slug: roleSlug } });
  if (!role) {
    res.status(404).json({ error: `Role not found: ${roleSlug}` });
    return;
  }

  // Find the assignment for this project + role (highest priority first)
  const assignment = await prisma.roleAssignment.findFirst({
    where: { projectId, roleId: role.id },
    include: { provider: true },
    orderBy: { priority: "desc" },
  });

  if (!assignment) {
    res.status(404).json({
      error: `No AI provider assigned to role "${roleSlug}" in this project`,
      hint: "Use POST /api/assignments to assign a provider to this role",
    });
    return;
  }

  if (!assignment.provider.isEnabled) {
    res.status(400).json({
      error: `Provider "${assignment.provider.displayName}" is currently disabled`,
    });
    return;
  }

  // Merge saved config with request-time config
  const savedConfig = assignment.config ? JSON.parse(assignment.config) : {};
  const mergedConfig = { ...savedConfig, ...config };

  // Execute
  const result = await executeTask({
    provider: assignment.provider,
    config: mergedConfig,
    input,
    role: { slug: role.slug, name: role.name },
  });

  // Log the task
  await prisma.taskLog.create({
    data: {
      projectId,
      roleId: role.id,
      providerId: assignment.provider.id,
      input,
      output: result.output || null,
      status: result.status,
      errorMsg: result.errorMsg || null,
      durationMs: result.durationMs,
    },
  });

  res.json({
    role: role.name,
    provider: assignment.provider.displayName,
    model: assignment.provider.modelId,
    ...result,
  });
});

// Get task execution logs
taskRouter.get("/logs", async (req: Request, res: Response) => {
  const { projectId, roleSlug, limit } = req.query;

  const where: Record<string, unknown> = {};
  if (projectId) where.projectId = String(projectId);
  if (roleSlug) {
    const role = await prisma.role.findUnique({
      where: { slug: String(roleSlug) },
    });
    if (role) where.roleId = role.id;
  }

  const logs = await prisma.taskLog.findMany({
    where,
    include: { role: true },
    orderBy: { createdAt: "desc" },
    take: limit ? parseInt(String(limit), 10) : 50,
  });

  res.json(logs);
});
