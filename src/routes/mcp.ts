/**
 * Remote MCP Server Route — Native Implementation
 *
 * Implements MCP protocol (JSON-RPC 2.0 over Streamable HTTP)
 * without SDK dependency to avoid ESM/CJS conflicts.
 *
 * Endpoint: POST /mcp
 * IDE config: { "url": "https://api.division.he-ro.jp/mcp" }
 */

import { Router, Request, Response } from "express";
import crypto from "crypto";
import { prisma } from "../db";
import { runAgent, runAgentStream, StreamEvent } from "../services/orchestrator";

const router = Router();

// ===== Tool Definitions =====

const TOOLS = [
  {
    name: "division_run",
    description:
      "Execute AI agent orchestration. A Leader AI decomposes your request into sub-tasks and dispatches them to specialized AI agents (Claude, Gemini, GPT, Grok, DeepSeek, Perplexity).",
    inputSchema: {
      type: "object",
      properties: {
        input: {
          type: "string",
          description: "The task or question to process",
        },
        projectId: {
          type: "string",
          description: "Project ID (default: demo-project-001)",
          default: "demo-project-001",
        },
        overrides: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Override AI for roles. Keys: coding/search/planning/writing/review. Values: model names (e.g. claude-opus-4.6, gemini-3-pro, gpt-5.2, grok-4.1-fast, deepseek-r1)",
        },
      },
      required: ["input"],
    },
  },
  {
    name: "division_list_models",
    description:
      "List all available AI models in Division. Shows model names for use in overrides.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "division_stream",
    description:
      "Execute AI agent orchestration with streaming. Returns real-time progress updates as the Leader decomposes tasks and each agent executes.",
    inputSchema: {
      type: "object",
      properties: {
        input: {
          type: "string",
          description: "The task or question to process",
        },
        projectId: {
          type: "string",
          description: "Project ID (default: demo-project-001)",
          default: "demo-project-001",
        },
        overrides: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Override AI for roles. Keys: coding/search/planning/writing/review. Values: model names (e.g. claude-opus-4.6, gemini-3-pro, gpt-5.2)",
        },
      },
      required: ["input"],
    },
  },
  {
    name: "division_health",
    description: "Check Division API health status.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "division_list_agents",
    description:
      "List all agents (AI providers assigned to roles) for a project. Shows each agent's role, provider, and model.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "Project ID to list agents for (default: demo-project-001)",
          default: "demo-project-001",
        },
      },
    },
  },
  {
    name: "division_set_agent",
    description:
      "Assign an AI provider to a role in a project. Creates or updates the agent assignment.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "Project ID (default: demo-project-001)",
          default: "demo-project-001",
        },
        role: {
          type: "string",
          description:
            "Role slug to assign (e.g. leader, coding, search, planning, writing, review, image, ideaman, deep-research)",
        },
        provider: {
          type: "string",
          description:
            "Provider name to assign to the role (e.g. claude-sonnet-4, gemini-2.0-flash, gpt-4o, perplexity-sonar-pro)",
        },
        priority: {
          type: "number",
          description: "Priority of this assignment (higher = preferred). Default: 0",
          default: 0,
        },
      },
      required: ["role", "provider"],
    },
  },
];

// ===== Tool Handlers =====

async function handleDivisionRun(args: Record<string, unknown>) {
  const input = args.input as string;
  const projectId = (args.projectId as string) || "demo-project-001";
  const overrides = args.overrides as Record<string, string> | undefined;

  const request: { projectId: string; input: string; overrides?: Record<string, string> } = {
    projectId,
    input,
  };
  if (overrides && Object.keys(overrides).length > 0) {
    request.overrides = overrides;
  }

  const result = await runAgent(request);

  const lines: string[] = [];
  lines.push(`## Division Agent Result`);
  lines.push(`**Session**: ${result.sessionId}`);
  lines.push(`**Leader**: ${result.leaderProvider} (${result.leaderModel})`);
  lines.push(`**Status**: ${result.status} (${result.totalDurationMs}ms)\n`);

  for (let i = 0; i < result.tasks.length; i++) {
    const task = result.tasks[i];
    lines.push(`### Step ${i + 1}: ${task.role}`);
    lines.push(`**Model**: ${task.provider} (${task.model})`);
    lines.push(`**Reason**: ${task.reason}`);
    lines.push(`**Output**:\n${task.output}\n`);
  }

  return [{ type: "text", text: lines.join("\n") }];
}

async function handleListModels() {
  const providers = await prisma.provider.findMany({
    orderBy: { name: "asc" },
    select: {
      name: true,
      displayName: true,
      apiType: true,
      modelId: true,
      description: true,
    },
  });

  const grouped: Record<string, typeof providers> = {};
  for (const p of providers) {
    if (!grouped[p.apiType]) grouped[p.apiType] = [];
    grouped[p.apiType].push(p);
  }

  const typeLabels: Record<string, string> = {
    anthropic: "🟣 Anthropic (Claude)",
    google: "🔵 Google (Gemini)",
    openai: "🟢 OpenAI (GPT/o-series)",
    perplexity: "🟠 Perplexity",
    xai: "⚫ xAI (Grok)",
    deepseek: "🔴 DeepSeek",
  };

  const lines: string[] = ["## Available AI Models\n"];
  for (const [apiType, provs] of Object.entries(grouped)) {
    lines.push(`### ${typeLabels[apiType] || apiType}`);
    for (const p of provs) {
      lines.push(`- **\`${p.name}\`** → ${p.modelId} — ${p.description}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(
    "Use model names in the `overrides` parameter of `division_run`."
  );

  return [{ type: "text", text: lines.join("\n") }];
}

async function handleDivisionStream(args: Record<string, unknown>) {
  const input = args.input as string;
  const projectId = (args.projectId as string) || "demo-project-001";
  const overrides = args.overrides as Record<string, string> | undefined;

  const request: { projectId: string; input: string; overrides?: Record<string, string> } = {
    projectId,
    input,
  };
  if (overrides && Object.keys(overrides).length > 0) {
    request.overrides = overrides;
  }

  // Collect stream events and build a formatted output
  const lines: string[] = [];
  let sessionId = "";

  await runAgentStream(request, (event: StreamEvent) => {
    switch (event.type) {
      case "session_start":
        sessionId = event.sessionId;
        lines.push(`## Division Agent Stream`);
        lines.push(`**Session**: ${event.sessionId}`);
        lines.push(`**Leader**: ${event.leader}\n`);
        break;
      case "leader_done":
        lines.push(`### Leader Decomposition (${event.taskCount} tasks)`);
        for (const t of event.tasks) {
          lines.push(`- **${t.role}**: ${t.reason}`);
        }
        lines.push("");
        break;
      case "task_start":
        lines.push(`### Step ${event.index + 1}/${event.total}: ${event.role}`);
        lines.push(`**Model**: ${event.provider} (${event.model})`);
        break;
      case "task_done":
        lines.push(`**Status**: ${event.status} (${event.durationMs}ms)`);
        lines.push(`**Output**:\n${event.output}\n`);
        break;
      case "task_error":
        lines.push(`**Error**: ${event.error}\n`);
        break;
      case "session_done":
        lines.push(`---`);
        lines.push(`**Overall Status**: ${event.status} (${event.totalDurationMs}ms, ${event.taskCount} tasks)`);
        break;
      // heartbeat, leader_chunk, task_chunk are not included in final text output
    }
  });

  return [{ type: "text", text: lines.join("\n") }];
}

async function handleHealth() {
  return [
    {
      type: "text",
      text: `✅ Division API is **running** (division-api v1.0.0)`,
    },
  ];
}

async function handleListAgents(args: Record<string, unknown>) {
  const projectId = (args.projectId as string) || "demo-project-001";

  const assignments = await prisma.roleAssignment.findMany({
    where: { projectId },
    include: { role: true, provider: true },
    orderBy: [{ role: { name: "asc" } }, { priority: "desc" }],
  });

  if (assignments.length === 0) {
    return [
      {
        type: "text",
        text: `No agents configured for project \`${projectId}\`. Use \`division_set_agent\` to assign AI providers to roles.`,
      },
    ];
  }

  const lines: string[] = [`## Agents for Project \`${projectId}\`\n`];

  // Group by role
  const byRole: Record<string, typeof assignments> = {};
  for (const a of assignments) {
    const key = a.role.slug;
    if (!byRole[key]) byRole[key] = [];
    byRole[key].push(a);
  }

  for (const [roleSlug, roleAssignments] of Object.entries(byRole)) {
    const role = roleAssignments[0].role;
    lines.push(`### ${role.name} (\`${roleSlug}\`)`);
    if (role.description) lines.push(`> ${role.description}`);
    for (const a of roleAssignments) {
      lines.push(
        `- **${a.provider.displayName}** (\`${a.provider.name}\`) → ${a.provider.modelId} (priority: ${a.priority})`
      );
    }
    lines.push("");
  }

  lines.push(`---`);
  lines.push(`Total: ${assignments.length} agent(s) across ${Object.keys(byRole).length} role(s)`);

  return [{ type: "text", text: lines.join("\n") }];
}

async function handleSetAgent(args: Record<string, unknown>) {
  const projectId = (args.projectId as string) || "demo-project-001";
  const roleSlug = args.role as string;
  const providerName = args.provider as string;
  const priority = (args.priority as number) ?? 0;

  if (!roleSlug) {
    return [{ type: "text", text: "Error: `role` is required." }];
  }
  if (!providerName) {
    return [{ type: "text", text: "Error: `provider` is required." }];
  }

  // Find role
  const role = await prisma.role.findUnique({ where: { slug: roleSlug } });
  if (!role) {
    const allRoles = await prisma.role.findMany({ select: { slug: true, name: true } });
    const available = allRoles.map((r) => `\`${r.slug}\` (${r.name})`).join(", ");
    return [
      {
        type: "text",
        text: `Error: Role \`${roleSlug}\` not found.\n\nAvailable roles: ${available}`,
      },
    ];
  }

  // Find provider
  const provider = await prisma.provider.findUnique({ where: { name: providerName } });
  if (!provider) {
    const allProviders = await prisma.provider.findMany({
      where: { isEnabled: true },
      select: { name: true, displayName: true, modelId: true },
    });
    const available = allProviders
      .map((p) => `\`${p.name}\` (${p.displayName} — ${p.modelId})`)
      .join("\n- ");
    return [
      {
        type: "text",
        text: `Error: Provider \`${providerName}\` not found.\n\nAvailable providers:\n- ${available}`,
      },
    ];
  }

  // Upsert assignment
  const existing = await prisma.roleAssignment.findFirst({
    where: { projectId, roleId: role.id, providerId: provider.id },
  });

  if (existing) {
    await prisma.roleAssignment.update({
      where: { id: existing.id },
      data: { priority },
    });
    return [
      {
        type: "text",
        text: `✅ Updated agent: **${provider.displayName}** (\`${provider.name}\`) assigned to role **${role.name}** (\`${roleSlug}\`) with priority ${priority} in project \`${projectId}\`.`,
      },
    ];
  }

  await prisma.roleAssignment.create({
    data: {
      projectId,
      roleId: role.id,
      providerId: provider.id,
      priority,
    },
  });

  return [
    {
      type: "text",
      text: `✅ Agent assigned: **${provider.displayName}** (\`${provider.name}\`) → role **${role.name}** (\`${roleSlug}\`) with priority ${priority} in project \`${projectId}\`.`,
    },
  ];
}

// ===== JSON-RPC Handler =====

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const sessions = new Map<string, { created: number }>();

/** Remove sessions older than SESSION_TTL_MS */
function cleanupStaleSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.created > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}

// Periodically clean up stale sessions (every 10 minutes)
const cleanupInterval = setInterval(cleanupStaleSessions, 10 * 60 * 1000);
cleanupInterval.unref(); // Don't prevent process exit

async function handleJsonRpc(
  req: JsonRpcRequest,
  sessionId: string
): Promise<JsonRpcResponse> {
  const id = req.id ?? null;

  switch (req.method) {
    case "initialize":
      sessions.set(sessionId, { created: Date.now() });
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: "division",
            version: "1.0.0",
            agents: {
              description: "Multi-agent orchestration with role-based task routing",
              availableRoles: [
                "leader", "coding", "search", "planning", "writing",
                "review", "image", "ideaman", "deep-research",
              ],
              managementTools: ["division_list_agents", "division_set_agent"],
            },
          },
        },
      };

    case "notifications/initialized":
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: TOOLS },
      };

    case "tools/call": {
      const params = req.params || {};
      const toolName = params.name as string;
      const args = (params.arguments || {}) as Record<string, unknown>;

      try {
        let content;
        switch (toolName) {
          case "division_run":
            content = await handleDivisionRun(args);
            break;
          case "division_stream":
            content = await handleDivisionStream(args);
            break;
          case "division_list_models":
            content = await handleListModels();
            break;
          case "division_health":
            content = await handleHealth();
            break;
          case "division_list_agents":
            content = await handleListAgents(args);
            break;
          case "division_set_agent":
            content = await handleSetAgent(args);
            break;
          default:
            return {
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: `Unknown tool: ${toolName}` },
            };
        }
        return { jsonrpc: "2.0", id, result: { content, isError: false } };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: `Error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          },
        };
      }
    }

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      };
  }
}

// ===== Express Routes =====

// POST /mcp — Handle JSON-RPC requests
router.post("/", async (req: Request, res: Response) => {
  try {
    let sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId) {
      sessionId = crypto.randomUUID();
    }

    const body = req.body;

    // Handle batch requests
    if (Array.isArray(body)) {
      const responses = await Promise.all(
        body.map((r: JsonRpcRequest) => handleJsonRpc(r, sessionId!))
      );
      // Filter out notifications (no id)
      const filtered = responses.filter((r) => r.id !== null);
      res.setHeader("mcp-session-id", sessionId);
      res.json(filtered.length === 1 ? filtered[0] : filtered);
      return;
    }

    const response = await handleJsonRpc(body, sessionId);
    res.setHeader("mcp-session-id", sessionId);
    res.json(response);
  } catch (err) {
    console.error("MCP error:", err);
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal server error" },
      id: null,
    });
  }
});

// GET /mcp — SSE connection info
router.get("/", (_req: Request, res: Response) => {
  res.json({
    name: "division",
    version: "1.0.0",
    description: "Division API — AI agent orchestration MCP server",
    tools: TOOLS.map((t) => t.name),
    agents: {
      description: "Multi-agent orchestration with role-based task routing",
      availableRoles: [
        "leader", "coding", "search", "planning", "writing",
        "review", "image", "ideaman", "deep-research",
      ],
      managementTools: ["division_list_agents", "division_set_agent"],
    },
    endpoint: "POST /mcp",
    usage: 'Send JSON-RPC 2.0 requests to POST /mcp with method "initialize" to start.',
  });
});

// DELETE /mcp — Close session
router.delete("/", (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId) {
    sessions.delete(sessionId);
  }
  res.json({ status: "session closed" });
});

export default router;
