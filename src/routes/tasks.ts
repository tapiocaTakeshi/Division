import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { z } from "zod";
import { executeTask, executeTaskStream } from "../services/ai-executor";
import { asyncHandler } from "../middleware/async-handler";

export const taskRouter = Router();

const executeTaskSchema = z.object({
  projectId: z.string().min(1),
  roleSlug: z.string().min(1),
  input: z.string().min(1),
  config: z.record(z.unknown()).optional(),
  stream: z.boolean().optional(),
  workspacePath: z.string().optional(),
});

const ROLE_MAX_TOKENS: Record<string, number> = {
  designer: 65536,
  coder: 65536,
  writer: 32768,
  planner: 8192,
  reviewer: 8192,
  searcher: 4096,
  researcher: 8192,
  "file-searcher": 4096,
  ideaman: 8192,
  leader: 4096,
  imager: 4096,
};

/**
 * Resolve a role slug to its canonical form.
 * First checks the DB directly; if not found, tries known aliases.
 */
async function resolveRole(slug: string) {
  const direct = await prisma.role.findUnique({ where: { slug } });
  if (direct) return direct;

  const ROLE_ALIASES: Record<string, string> = {
    "deep-research": "researcher",
    "planning": "planner",
    "coding": "coder",
    "design": "designer",
    "search": "searcher",
    "file-search": "file-searcher",
    "research": "researcher",
    "review": "reviewer",
    "writing": "writer",
    "image": "imager",
  };

  const canonical = ROLE_ALIASES[slug];
  if (canonical) {
    return prisma.role.findUnique({ where: { slug: canonical } });
  }
  return null;
}

// Execute a task: route to the AI assigned to the given role in the project
taskRouter.post("/execute", asyncHandler(async (req: Request, res: Response) => {
  const parsed = executeTaskSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }

  const { projectId, roleSlug, input, config, workspacePath } = parsed.data;

  // Find the role by slug (supports aliases for backward compatibility)
  const role = await resolveRole(roleSlug);
  if (!role) {
    const allRoles = await prisma.role.findMany({ select: { slug: true, name: true }, orderBy: { slug: "asc" } });
    const available = allRoles.map((r) => `${r.slug} (${r.name})`).join(", ");
    res.status(404).json({
      error: `Role not found: ${roleSlug}`,
      availableRoles: available,
    });
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

  // Merge saved config with request-time config + role-specific maxTokens
  const savedConfig = assignment.config ? JSON.parse(assignment.config) : {};
  const roleMaxTokens = ROLE_MAX_TOKENS[role.slug];
  const mergedConfig = {
    ...(roleMaxTokens ? { maxTokens: roleMaxTokens } : {}),
    ...savedConfig,
    ...config,
  };

  const execReq = {
    provider: assignment.provider,
    config: mergedConfig,
    input,
    role: { slug: role.slug, name: role.name },
    workspacePath,
  };

  // Streaming mode
  if (parsed.data.stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const result = await executeTaskStream(
      execReq,
      (text) => { res.write(`data: ${JSON.stringify({ type: "chunk", text })}\n\n`); },
      (text) => { res.write(`data: ${JSON.stringify({ type: "thinking", text })}\n\n`); }
    );

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

    res.write(`data: ${JSON.stringify({
      type: "done",
      role: role.name,
      provider: assignment.provider.displayName,
      model: assignment.provider.modelId,
      status: result.status,
      durationMs: result.durationMs,
    })}\n\n`);
    res.end();
    return;
  }

  // Non-streaming mode
  const result = await executeTask(execReq);

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
}));

// Get task execution logs
taskRouter.get("/logs", asyncHandler(async (req: Request, res: Response) => {
  const { projectId, roleSlug, limit } = req.query;

  const where: Record<string, unknown> = {};
  if (projectId) where.projectId = String(projectId);
  if (roleSlug) {
    const role = await resolveRole(String(roleSlug));
    if (role) where.roleId = role.id;
  }

  const logs = await prisma.taskLog.findMany({
    where,
    include: { role: true },
    orderBy: { createdAt: "desc" },
    take: limit ? parseInt(String(limit), 10) : 50,
  });

  res.json(logs);
}));
