import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { z } from "zod";

export const providerRouter = Router();

const createProviderSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  apiBaseUrl: z.string().url(),
  apiType: z.enum(["openai", "anthropic", "google", "perplexity", "custom"]),
  modelId: z.string().min(1),
  description: z.string().optional(),
  isEnabled: z.boolean().optional(),
});

const updateProviderSchema = createProviderSchema.partial();

// List all providers
providerRouter.get("/", async (_req: Request, res: Response) => {
  const providers = await prisma.provider.findMany({
    orderBy: { name: "asc" },
    include: { assignments: { select: { id: true, projectId: true, roleId: true } } },
  });
  res.json(providers);
});

// Get a single provider
providerRouter.get("/:id", async (req: Request, res: Response) => {
  const provider = await prisma.provider.findUnique({
    where: { id: req.params.id },
    include: { assignments: { include: { role: true } } },
  });
  if (!provider) {
    res.status(404).json({ error: "Provider not found" });
    return;
  }
  res.json(provider);
});

// Create a provider
providerRouter.post("/", async (req: Request, res: Response) => {
  const parsed = createProviderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }
  const provider = await prisma.provider.create({ data: parsed.data });
  res.status(201).json(provider);
});

// Update a provider
providerRouter.put("/:id", async (req: Request, res: Response) => {
  const parsed = updateProviderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }
  try {
    const provider = await prisma.provider.update({
      where: { id: req.params.id },
      data: parsed.data,
    });
    res.json(provider);
  } catch {
    res.status(404).json({ error: "Provider not found" });
  }
});

// Delete a provider
providerRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    await prisma.provider.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Provider not found" });
  }
});
