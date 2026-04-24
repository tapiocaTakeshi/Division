import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { z } from "zod";
import { asyncHandler } from "../middleware/async-handler";

export const assignmentRouter = Router();

/**
 * `RoleAssignment.config` は JSON `{"model":"..."}` を想定しているが、
 * 旧データはプレーン文字列のモデル ID (`"gpt-5.4"` 等) が保存されているため、
 * JSON.parse すると落ちる。プレーン文字列は `{ model }` とみなす。
 */
function parseAssignmentConfigSafe(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return {};
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
  }
  return { model: text };
}

const createAssignmentSchema = z.object({
  projectId: z.string().min(1),
  roleId: z.string().uuid(),
  providerId: z.string().uuid(),
  priority: z.number().int().min(0).optional(),
  config: z.record(z.unknown()).optional(),
});

const updateAssignmentSchema = z.object({
  providerId: z.string().uuid().optional(),
  priority: z.number().int().min(0).optional(),
  config: z.record(z.unknown()).optional(),
});

// List assignments (optionally filtered by projectId)
assignmentRouter.get("/", asyncHandler(async (req: Request, res: Response) => {
  const { projectId } = req.query;
  const where = projectId ? { projectId: String(projectId) } : {};
  const assignments = await prisma.roleAssignment.findMany({
    where,
    include: { role: true, provider: true },
    orderBy: [{ role: { name: "asc" } }, { priority: "desc" }],
  });
  res.json(assignments);
}));

// Get a single assignment
assignmentRouter.get("/:id", asyncHandler(async (req: Request, res: Response) => {
  const assignment = await prisma.roleAssignment.findUnique({
    where: { id: req.params.id },
    include: { role: true, provider: true },
  });
  if (!assignment) {
    res.status(404).json({ error: "Assignment not found" });
    return;
  }
  res.json(assignment);
}));

// Create an assignment (assign AI to a role in a project)
assignmentRouter.post("/", asyncHandler(async (req: Request, res: Response) => {
  const parsed = createAssignmentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }
  const { config, ...rest } = parsed.data;

  // Ensure config.model is set so orchestrator always has an explicit model reference
  const provider = await prisma.provider.findUnique({ where: { id: rest.providerId } });
  if (!provider) {
    res.status(400).json({ error: "Provider not found" });
    return;
  }
  const mergedConfig = { model: provider.modelId, ...config };

  try {
    const assignment = await prisma.roleAssignment.create({
      data: {
        ...rest,
        config: JSON.stringify(mergedConfig),
      },
      include: { role: true, provider: true },
    });
    res.status(201).json(assignment);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Unique constraint")) {
      res.status(409).json({ error: "This provider is already assigned to this role in this project" });
    } else if (message.includes("Foreign key constraint")) {
      res.status(400).json({ error: "Invalid projectId, roleId, or providerId" });
    } else {
      throw err;
    }
  }
}));

// Update an assignment (switch AI provider for a role)
assignmentRouter.put("/:id", asyncHandler(async (req: Request, res: Response) => {
  const parsed = updateAssignmentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }
  const { config, ...rest } = parsed.data;
  try {
    const data: Record<string, unknown> = { ...rest };

    // When providerId changes and no explicit config.model is given, update config.model
    // to reflect the new provider's modelId so the orchestrator always has an explicit reference
    if (config !== undefined || rest.providerId !== undefined) {
      const existing = await prisma.roleAssignment.findUnique({
        where: { id: req.params.id },
        include: { provider: true },
      });
      if (!existing) {
        res.status(404).json({ error: "Assignment not found" });
        return;
      }
      const targetProviderId = rest.providerId ?? existing.providerId;
      const provider = rest.providerId
        ? await prisma.provider.findUnique({ where: { id: targetProviderId } })
        : existing.provider;
      if (!provider) {
        res.status(400).json({ error: "Provider not found" });
        return;
      }
      const existingConfig = parseAssignmentConfigSafe(existing.config);
      const mergedConfig = { model: provider.modelId, ...existingConfig, ...config };
      data.config = JSON.stringify(mergedConfig);
    }

    const assignment = await prisma.roleAssignment.update({
      where: { id: req.params.id },
      data,
      include: { role: true, provider: true },
    });
    res.json(assignment);
  } catch {
    res.status(404).json({ error: "Assignment not found" });
  }
}));

// Delete an assignment
assignmentRouter.delete("/:id", asyncHandler(async (req: Request, res: Response) => {
  try {
    await prisma.roleAssignment.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Assignment not found" });
  }
}));

// Bulk assign: set all role assignments for a project at once
assignmentRouter.post("/bulk", asyncHandler(async (req: Request, res: Response) => {
  const bulkSchema = z.object({
    projectId: z.string().min(1),
    assignments: z.array(
      z.object({
        roleId: z.string().uuid(),
        providerId: z.string().uuid(),
        priority: z.number().int().min(0).optional(),
        config: z.record(z.unknown()).optional(),
      })
    ),
  });

  const parsed = bulkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }

  const { projectId, assignments } = parsed.data;

  const result = await prisma.$transaction(async (tx) => {
    // Remove existing assignments for the project
    await tx.roleAssignment.deleteMany({ where: { projectId } });

    // Create new assignments
    const created = [];
    for (const a of assignments) {
      const { config, ...rest } = a;
      // Fetch provider to ensure config.model is always explicitly set
      const provider = await tx.provider.findUnique({ where: { id: rest.providerId } });
      const mergedConfig = { model: provider?.modelId ?? "", ...config };
      const record = await tx.roleAssignment.create({
        data: {
          projectId,
          ...rest,
          config: JSON.stringify(mergedConfig),
        },
        include: { role: true, provider: true },
      });
      created.push(record);
    }
    return created;
  });

  res.status(201).json(result);
}));
