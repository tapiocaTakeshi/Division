import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { Flow, FlowRun } from "../types/flow";
import { FlowValidator } from "../services/flow-validator";
import { FlowExecutor } from "../services/flow-executor";
import { FlowLogger } from "../services/flow-logger";
import { TemplateLoader } from "../services/template-loader";
import * as path from "path";

const router = Router();
const prisma = new PrismaClient();
const validator = new FlowValidator();
const logger = new FlowLogger(prisma);
const templateLoader = new TemplateLoader(
  path.join(__dirname, "../templates")
);

interface FlowRequestBody {
  name: string;
  description?: string;
  nodes: any[];
  edges: any[];
  config?: Record<string, unknown>;
}

// Create a new flow
router.post("/flows", async (req: Request, res: Response) => {
  try {
    const { name, description, nodes, edges, config } =
      req.body as FlowRequestBody;
    const projectId = req.headers["x-project-id"] as string;

    if (!projectId) {
      res.status(400).json({ error: "Missing x-project-id header" });
      return;
    }

    const flow = {
      id: "",
      projectId,
      name,
      description,
      nodes,
      edges,
      status: "draft" as const,
      config,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Validate flow
    const validation = validator.validate(flow);
    if (!validation.valid) {
      res.status(400).json({
        error: "Flow validation failed",
        errors: validation.errors,
        warnings: validation.warnings,
      });
      return;
    }

    const created = await prisma.flow.create({
      data: {
        projectId,
        name,
        description,
        nodes: nodes as any,
        edges: edges as any,
        config: config as any,
        status: "draft",
      },
    });

    res.status(201).json({
      id: created.id,
      projectId: created.projectId,
      name: created.name,
      description: created.description,
      nodes: created.nodes,
      edges: created.edges,
      status: created.status,
      config: created.config,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Get a specific flow
router.get("/flows/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const projectId = req.headers["x-project-id"] as string;

    const flow = await prisma.flow.findFirst({
      where: { id, projectId },
    });

    if (!flow) {
      res.status(404).json({ error: "Flow not found" });
      return;
    }

    res.json({
      id: flow.id,
      projectId: flow.projectId,
      name: flow.name,
      description: flow.description,
      nodes: flow.nodes,
      edges: flow.edges,
      status: flow.status,
      config: flow.config,
      createdAt: flow.createdAt,
      updatedAt: flow.updatedAt,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// List flows for a project
router.get("/flows", async (req: Request, res: Response) => {
  try {
    const projectId = req.headers["x-project-id"] as string;
    const status = req.query.status as string | undefined;

    if (!projectId) {
      res.status(400).json({ error: "Missing x-project-id header" });
      return;
    }

    const where: Record<string, unknown> = { projectId };
    if (status) {
      where.status = status;
    }

    const flows = await prisma.flow.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    res.json(
      flows.map((f) => ({
        id: f.id,
        projectId: f.projectId,
        name: f.name,
        description: f.description,
        status: f.status,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
      }))
    );
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Update a flow
router.put("/flows/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const projectId = req.headers["x-project-id"] as string;
    const { name, description, nodes, edges, config, status } =
      req.body as Partial<FlowRequestBody> & { status?: string };

    if (!projectId) {
      res.status(400).json({ error: "Missing x-project-id header" });
      return;
    }

    const flow = await prisma.flow.findFirst({
      where: { id, projectId },
    });

    if (!flow) {
      res.status(404).json({ error: "Flow not found" });
      return;
    }

    // Validate updated flow if nodes/edges changed
    if (nodes || edges) {
      const updatedFlow = {
        ...flow,
        name: name || flow.name,
        nodes: nodes || flow.nodes,
        edges: edges || flow.edges,
        config: config || flow.config,
      } as any;

      const validation = validator.validate(updatedFlow);
      if (!validation.valid) {
        res.status(400).json({
          error: "Flow validation failed",
          errors: validation.errors,
          warnings: validation.warnings,
        });
        return;
      }
    }

    const updated = await prisma.flow.update({
      where: { id },
      data: {
        name: name || undefined,
        description: description !== undefined ? description : undefined,
        nodes: (nodes as any) || undefined,
        edges: (edges as any) || undefined,
        config: (config as any) || undefined,
        status: status || undefined,
      },
    });

    res.json({
      id: updated.id,
      projectId: updated.projectId,
      name: updated.name,
      description: updated.description,
      nodes: updated.nodes,
      edges: updated.edges,
      status: updated.status,
      config: updated.config,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Delete a flow
router.delete("/flows/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const projectId = req.headers["x-project-id"] as string;

    if (!projectId) {
      res.status(400).json({ error: "Missing x-project-id header" });
      return;
    }

    const flow = await prisma.flow.findFirst({
      where: { id, projectId },
    });

    if (!flow) {
      res.status(404).json({ error: "Flow not found" });
      return;
    }

    await prisma.flow.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Start a flow run
router.post(
  "/flows/:id/runs",
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const projectId = req.headers["x-project-id"] as string;
      const { input } = req.body as { input?: Record<string, unknown> };

      if (!projectId) {
        res.status(400).json({ error: "Missing x-project-id header" });
        return;
      }

      const flow = await prisma.flow.findFirst({
        where: { id, projectId },
      });

      if (!flow) {
        res.status(404).json({ error: "Flow not found" });
        return;
      }

      const run = await prisma.flowRun.create({
        data: {
          flowId: id,
          status: "pending",
          input: (input || undefined) as any,
        },
      });

      res.status(201).json({
        id: run.id,
        flowId: run.flowId,
        status: run.status,
        input: run.input,
        createdAt: run.createdAt,
      });

      // Start execution asynchronously
      const executor = new FlowExecutor(prisma);
      executor.executeFlow(flow as any, run as any, input || {}).catch((e) => {
        console.error("Flow execution error:", e);
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

// Get flow run details
router.get("/flows/:id/runs/:runId", async (req: Request, res: Response) => {
  try {
    const { id, runId } = req.params;
    const projectId = req.headers["x-project-id"] as string;

    if (!projectId) {
      res.status(400).json({ error: "Missing x-project-id header" });
      return;
    }

    const run = await prisma.flowRun.findFirst({
      where: { id: runId, flow: { id, projectId } },
      include: { executions: true },
    });

    if (!run) {
      res.status(404).json({ error: "Flow run not found" });
      return;
    }

    res.json({
      id: run.id,
      flowId: run.flowId,
      status: run.status,
      input: run.input,
      output: run.output,
      errorMsg: run.errorMsg,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      executions: run.executions.map((e) => ({
        id: e.id,
        nodeId: e.nodeId,
        status: e.status,
        input: e.input,
        output: e.output,
        errorMsg: e.errorMsg,
        durationMs: e.durationMs,
        costUsd: e.costUsd,
        retries: e.retries,
      })),
      createdAt: run.createdAt,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Stream flow run execution progress via SSE
router.get(
  "/flows/:id/runs/:runId/stream",
  async (req: Request, res: Response) => {
    try {
      const { id, runId } = req.params;
      const projectId = req.headers["x-project-id"] as string;

      if (!projectId) {
        res.status(400).json({ error: "Missing x-project-id header" });
        return;
      }

      // Verify flow exists and belongs to project
      const flow = await prisma.flow.findFirst({
        where: { id, projectId },
      });

      if (!flow) {
        res.status(404).json({ error: "Flow not found" });
        return;
      }

      // Verify run exists
      const run = await prisma.flowRun.findFirst({
        where: { id: runId, flowId: id },
      });

      if (!run) {
        res.status(404).json({ error: "Flow run not found" });
        return;
      }

      // Set up SSE response
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("Access-Control-Allow-Origin", "*");

      // Send initial state
      res.write(`data: ${JSON.stringify({ type: "started", runId })}\n\n`);

      // Poll for updates
      const pollInterval = setInterval(async () => {
        try {
          const updated = await prisma.flowRun.findUnique({
            where: { id: runId },
            include: { executions: { orderBy: { createdAt: "asc" } } },
          });

          if (!updated) {
            clearInterval(pollInterval);
            res.write(
              `data: ${JSON.stringify({ type: "error", message: "Run not found" })}\n\n`
            );
            res.end();
            return;
          }

          // Send execution updates
          for (const execution of updated.executions) {
            res.write(
              `data: ${JSON.stringify({
                type: "execution_update",
                execution: {
                  nodeId: execution.nodeId,
                  status: execution.status,
                  durationMs: execution.durationMs,
                  costUsd: execution.costUsd,
                },
              })}\n\n`
            );
          }

          // Send completion event
          if (
            updated.status === "completed" ||
            updated.status === "failed" ||
            updated.status === "cancelled"
          ) {
            clearInterval(pollInterval);
            res.write(
              `data: ${JSON.stringify({
                type: "completed",
                status: updated.status,
                output: updated.output,
                errorMsg: updated.errorMsg,
              })}\n\n`
            );
            res.end();
          }
        } catch (error) {
          clearInterval(pollInterval);
          res.write(
            `data: ${JSON.stringify({
              type: "error",
              message:
                error instanceof Error ? error.message : "Unknown error",
            })}\n\n`
          );
          res.end();
        }
      }, 1000);

      // Clean up on client disconnect
      req.on("close", () => {
        clearInterval(pollInterval);
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

// Get flow run metrics
router.get(
  "/flows/:id/runs/:runId/metrics",
  async (req: Request, res: Response) => {
    try {
      const { id, runId } = req.params;
      const projectId = req.headers["x-project-id"] as string;

      if (!projectId) {
        res.status(400).json({ error: "Missing x-project-id header" });
        return;
      }

      const metrics = await logger.getFlowMetrics(runId);

      if (!metrics) {
        res.status(404).json({ error: "Flow run not found" });
        return;
      }

      res.json(metrics);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

// Get flow runs list
router.get("/flows/:id/runs", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const projectId = req.headers["x-project-id"] as string;
    const status = req.query.status as string | undefined;

    if (!projectId) {
      res.status(400).json({ error: "Missing x-project-id header" });
      return;
    }

    const where: Record<string, any> = { flowId: id };
    if (status) {
      where.status = status;
    }

    const runs = await prisma.flowRun.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    res.json(
      runs.map((r) => ({
        id: r.id,
        flowId: r.flowId,
        status: r.status,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        createdAt: r.createdAt,
      }))
    );
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// List available flow templates
router.get("/templates", async (req: Request, res: Response) => {
  try {
    const templates = templateLoader.listTemplates();
    res.json({ templates });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Get a specific template
router.get("/templates/:name", async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const template = templateLoader.getTemplate(name);

    if (!template) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    res.json(template);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Create a flow from a template
router.post("/flows/from-template/:name", async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const projectId = req.headers["x-project-id"] as string;
    const { customName } = req.body as { customName?: string };

    if (!projectId) {
      res.status(400).json({ error: "Missing x-project-id header" });
      return;
    }

    const flowData = templateLoader.createFlowFromTemplate(
      name,
      projectId,
      customName
    );

    // Validate the flow
    const flow = {
      ...flowData,
      id: "",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any;

    const validation = validator.validate(flow);
    if (!validation.valid) {
      res.status(400).json({
        error: "Template validation failed",
        errors: validation.errors,
        warnings: validation.warnings,
      });
      return;
    }

    // Create the flow in database
    const created = await prisma.flow.create({
      data: {
        projectId: flowData.projectId!,
        name: flowData.name!,
        description: flowData.description || undefined,
        nodes: flowData.nodes! as any,
        edges: flowData.edges! as any,
        config: (flowData.config || undefined) as any,
        status: "draft",
      },
    });

    res.status(201).json({
      id: created.id,
      projectId: created.projectId,
      name: created.name,
      description: created.description,
      nodes: created.nodes,
      edges: created.edges,
      status: created.status,
      config: created.config,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default router;
