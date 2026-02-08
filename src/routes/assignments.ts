import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { z } from "zod";

export const assignmentRouter = Router();

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
assignmentRouter.get("/", async (req: Request, res: Response) => {
  const { projectId } = req.query;
  const where = projectId ? { projectId: String(projectId) } : {};
  const assignments = await prisma.roleAssignment.findMany({
    where,
    include: { role: true, provider: true },
    orderBy: [{ role: { name: "asc" } }, { priority: "desc" }],
  });
  res.json(assignments);
});

// Get a single assignment
assignmentRouter.get("/:id", async (req: Request, res: Response) => {
  const assignment = await prisma.roleAssignment.findUnique({
    where: { id: req.params.id },
    include: { role: true, provider: true },
  });
  if (!assignment) {
    res.status(404).json({ error: "Assignment not found" });
    return;
  }
  res.json(assignment);
});

// Create an assignment (assign AI to a role in a project)
assignmentRouter.post("/", async (req: Request, res: Response) => {
  const parsed = createAssignmentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }
  const { config, ...rest } = parsed.data;
  try {
    const assignment = await prisma.roleAssignment.create({
      data: {
        ...rest,
        config: config ? JSON.stringify(config) : null,
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
});

// Update an assignment (switch AI provider for a role)
assignmentRouter.put("/:id", async (req: Request, res: Response) => {
  const parsed = updateAssignmentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }
  const { config, ...rest } = parsed.data;
  try {
    const data: Record<string, unknown> = { ...rest };
    if (config !== undefined) {
      data.config = JSON.stringify(config);
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
});

// Delete an assignment
assignmentRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    await prisma.roleAssignment.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Assignment not found" });
  }
});

// Bulk assign: set all role assignments for a project at once
assignmentRouter.post("/bulk", async (req: Request, res: Response) => {
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
      const record = await tx.roleAssignment.create({
        data: {
          projectId,
          ...rest,
          config: config ? JSON.stringify(config) : null,
        },
        include: { role: true, provider: true },
      });
      created.push(record);
    }
    return created;
  });

  res.status(201).json(result);
});
