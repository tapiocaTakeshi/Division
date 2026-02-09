import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { z } from "zod";
import { asyncHandler } from "../middleware/async-handler";

export const projectRouter = Router();

const createProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

const updateProjectSchema = createProjectSchema.partial();

// List all projects
projectRouter.get("/", asyncHandler(async (_req: Request, res: Response) => {
  const projects = await prisma.project.findMany({ orderBy: { createdAt: "desc" } });
  res.json(projects);
}));

// Get a project with its role assignments
projectRouter.get("/:id", asyncHandler(async (req: Request, res: Response) => {
  const project = await prisma.project.findUnique({
    where: { id: req.params.id },
  });
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const assignments = await prisma.roleAssignment.findMany({
    where: { projectId: req.params.id },
    include: { role: true, provider: true },
    orderBy: { role: { name: "asc" } },
  });
  res.json({ ...project, assignments });
}));

// Create a project
projectRouter.post("/", asyncHandler(async (req: Request, res: Response) => {
  const parsed = createProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }
  const project = await prisma.project.create({ data: parsed.data });
  res.status(201).json(project);
}));

// Update a project
projectRouter.put("/:id", asyncHandler(async (req: Request, res: Response) => {
  const parsed = updateProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }
  try {
    const project = await prisma.project.update({
      where: { id: req.params.id },
      data: parsed.data,
    });
    res.json(project);
  } catch {
    res.status(404).json({ error: "Project not found" });
  }
}));

// Delete a project
projectRouter.delete("/:id", asyncHandler(async (req: Request, res: Response) => {
  try {
    await prisma.roleAssignment.deleteMany({ where: { projectId: req.params.id } });
    await prisma.project.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Project not found" });
  }
}));
