import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { z } from "zod";

export const roleRouter = Router();

const createRoleSchema = z.object({
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric with hyphens"),
  name: z.string().min(1),
  description: z.string().optional(),
});

const updateRoleSchema = createRoleSchema.partial();

// List all roles
roleRouter.get("/", async (_req: Request, res: Response) => {
  const roles = await prisma.role.findMany({ orderBy: { name: "asc" } });
  res.json(roles);
});

// Get a single role
roleRouter.get("/:id", async (req: Request, res: Response) => {
  const role = await prisma.role.findUnique({
    where: { id: req.params.id },
    include: { assignments: { include: { provider: true } } },
  });
  if (!role) {
    res.status(404).json({ error: "Role not found" });
    return;
  }
  res.json(role);
});

// Create a role
roleRouter.post("/", async (req: Request, res: Response) => {
  const parsed = createRoleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }
  const role = await prisma.role.create({ data: parsed.data });
  res.status(201).json(role);
});

// Update a role
roleRouter.put("/:id", async (req: Request, res: Response) => {
  const parsed = updateRoleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }
  try {
    const role = await prisma.role.update({
      where: { id: req.params.id },
      data: parsed.data,
    });
    res.json(role);
  } catch {
    res.status(404).json({ error: "Role not found" });
  }
});

// Delete a role
roleRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    await prisma.role.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Role not found" });
  }
});
