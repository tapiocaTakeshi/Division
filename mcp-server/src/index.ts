#!/usr/bin/env node

/**
 * Division MCP Server
 *
 * Exposes the Division API as MCP tools
 * for use in Cursor, Antigravity, Claude Desktop, etc.
 *
 * Tools:
 *   - division_run: Execute AI agent orchestration
 *   - division_list_models: List available AI models
 *   - division_list_agents: List agents with their assigned roles
 *   - division_set_agent: Assign a provider to a role
 *   - division_health: Check API health
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// --- Configuration ---
function getApiBaseUrl(): string {
  return process.env.DIVISION_API_URL || "https://api.division.he-ro.jp";
}

function getHeaders(): Record<string, string> {
  const apiKey = process.env.DIVISION_API_KEY || "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

async function apiRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const url = `${getApiBaseUrl()}${path}`;
  const options: RequestInit = {
    method,
    headers: getHeaders(),
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error ${response.status}: ${errorText}`);
  }
  return response.json();
}

// --- MCP Server ---
const server = new McpServer({
  name: "division",
  version: "1.0.0",
});

// Tool: division_run
server.tool(
  "division_run",
  "Execute AI agent orchestration. A Leader AI decomposes your request into sub-tasks and dispatches them to specialized AI agents (Claude, Gemini, GPT, Grok, DeepSeek, Perplexity). Returns aggregated results from all agents.",
  {
    input: z
      .string()
      .describe("The task or question to process (e.g. 'Build a React blog app')"),
    projectId: z
      .string()
      .default("demo-project-001")
      .describe("Project ID for role assignments (default: demo-project-001)"),
    overrides: z
      .record(z.string())
      .optional()
      .describe(
        "Override default AI for specific roles. Keys are role slugs (coding, search, planning, writing, review), values are model names (e.g. claude-opus-4.6, gemini-3-pro, gpt-5.2, grok-4.1-fast, deepseek-r1)"
      ),
  },
  async ({ input, projectId, overrides }) => {
    try {
      const body: Record<string, unknown> = { projectId, input };
      if (overrides && Object.keys(overrides).length > 0) {
        body.overrides = overrides;
      }

      const result = (await apiRequest("POST", "/api/agent/run", body)) as {
        sessionId: string;
        leaderProvider: string;
        leaderModel: string;
        status: string;
        totalDurationMs: number;
        tasks: Array<{
          step: number;
          role: string;
          provider: string;
          model: string;
          reason: string;
          output: string;
          status: string;
          durationMs: number;
        }>;
      };

      // Format the output nicely
      const lines: string[] = [];
      lines.push(`## Division Agent Result`);
      lines.push(`**Session**: ${result.sessionId}`);
      lines.push(
        `**Leader**: ${result.leaderProvider} (${result.leaderModel})`
      );
      lines.push(
        `**Status**: ${result.status} (${result.totalDurationMs}ms)\n`
      );

      for (const task of result.tasks) {
        lines.push(`### Step ${task.step}: ${task.role}`);
        lines.push(`**Model**: ${task.provider} (${task.model})`);
        lines.push(`**Reason**: ${task.reason}`);
        lines.push(`**Output**:\n${task.output}\n`);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: division_list_models
server.tool(
  "division_list_models",
  "List all available AI models/providers in the Division system. Shows model names that can be used in the 'overrides' parameter of division_run.",
  {},
  async () => {
    try {
      const result = (await apiRequest("GET", "/api/models")) as {
        providers: Array<{
          name: string;
          displayName: string;
          apiType: string;
          modelId: string;
          description: string;
        }>;
      };

      // Group by apiType
      const grouped: Record<string, typeof result.providers> = {};
      for (const p of result.providers) {
        if (!grouped[p.apiType]) grouped[p.apiType] = [];
        grouped[p.apiType].push(p);
      }

      const lines: string[] = ["## Available AI Models\n"];

      const typeLabels: Record<string, string> = {
        anthropic: "🟣 Anthropic (Claude)",
        google: "🔵 Google (Gemini)",
        openai: "🟢 OpenAI (GPT/o-series)",
        perplexity: "🟠 Perplexity",
        xai: "⚫ xAI (Grok)",
        deepseek: "🔴 DeepSeek",
      };

      for (const [apiType, providers] of Object.entries(grouped)) {
        lines.push(`### ${typeLabels[apiType] || apiType}`);
        for (const p of providers) {
          lines.push(
            `- **\`${p.name}\`** → ${p.modelId} — ${p.description}`
          );
        }
        lines.push("");
      }

      lines.push("---");
      lines.push(
        "Use model names (e.g. `claude-opus-4.6`, `gemini-3-pro`) in the `overrides` parameter of `division_run`."
      );

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: division_list_agents
server.tool(
  "division_list_agents",
  "List all agents (AI providers assigned to roles) for a project. Shows each agent's role, provider, and model.",
  {
    projectId: z
      .string()
      .default("demo-project-001")
      .describe("Project ID to list agents for (default: demo-project-001)"),
  },
  async ({ projectId }) => {
    try {
      const result = (await apiRequest(
        "GET",
        `/api/assignments?projectId=${encodeURIComponent(projectId)}`
      )) as Array<{
        id: string;
        projectId: string;
        priority: number;
        role: { slug: string; name: string; description?: string };
        provider: {
          name: string;
          displayName: string;
          modelId: string;
          apiType: string;
        };
      }>;

      if (!result || result.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No agents configured for project \`${projectId}\`. Use \`division_set_agent\` to assign AI providers to roles.`,
            },
          ],
        };
      }

      const lines: string[] = [`## Agents for Project \`${projectId}\`\n`];

      // Group by role
      const byRole: Record<string, typeof result> = {};
      for (const a of result) {
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
      lines.push(
        `Total: ${result.length} agent(s) across ${Object.keys(byRole).length} role(s)`
      );

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: division_set_agent
server.tool(
  "division_set_agent",
  "Assign an AI provider to a role in a project. Creates or updates the agent assignment.",
  {
    projectId: z
      .string()
      .default("demo-project-001")
      .describe("Project ID (default: demo-project-001)"),
    role: z
      .string()
      .describe(
        "Role slug to assign (e.g. leader, coding, search, planning, writing, review, image, ideaman, deep-research)"
      ),
    provider: z
      .string()
      .describe(
        "Provider name to assign to the role (e.g. claude-sonnet-4, gemini-2.0-flash, gpt-4o, perplexity-sonar-pro)"
      ),
    priority: z
      .number()
      .default(0)
      .describe("Priority of this assignment (higher = preferred). Default: 0"),
  },
  async ({ projectId, role, provider, priority }) => {
    try {
      // First, get the role ID
      const roles = (await apiRequest("GET", "/api/roles")) as Array<{
        id: string;
        slug: string;
        name: string;
      }>;
      const foundRole = roles.find((r) => r.slug === role);
      if (!foundRole) {
        const available = roles
          .map((r) => `\`${r.slug}\` (${r.name})`)
          .join(", ");
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Role \`${role}\` not found.\n\nAvailable roles: ${available}`,
            },
          ],
          isError: true,
        };
      }

      // Get the provider ID
      const providers = (await apiRequest("GET", "/api/models")) as {
        providers: Array<{
          id: string;
          name: string;
          displayName: string;
          modelId: string;
        }>;
      };
      const foundProvider = providers.providers.find((p) => p.name === provider);
      if (!foundProvider) {
        const available = providers.providers
          .map((p) => `\`${p.name}\` (${p.displayName} — ${p.modelId})`)
          .join("\n- ");
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Provider \`${provider}\` not found.\n\nAvailable providers:\n- ${available}`,
            },
          ],
          isError: true,
        };
      }

      // Check for existing assignment and update or create
      const existingAssignments = (await apiRequest(
        "GET",
        `/api/assignments?projectId=${encodeURIComponent(projectId)}`
      )) as Array<{
        id: string;
        roleId: string;
        providerId: string;
      }>;

      const existing = existingAssignments.find(
        (a) => a.roleId === foundRole.id && a.providerId === foundProvider.id
      );

      if (existing) {
        await apiRequest("PUT", `/api/assignments/${existing.id}`, {
          priority,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `✅ Updated agent: **${foundProvider.displayName}** (\`${provider}\`) assigned to role **${foundRole.name}** (\`${role}\`) with priority ${priority} in project \`${projectId}\`.`,
            },
          ],
        };
      }

      await apiRequest("POST", "/api/assignments", {
        projectId,
        roleId: foundRole.id,
        providerId: foundProvider.id,
        priority,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Agent assigned: **${foundProvider.displayName}** (\`${provider}\`) → role **${foundRole.name}** (\`${role}\`) with priority ${priority} in project \`${projectId}\`.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: division_health
server.tool(
  "division_health",
  "Check the health status of the Division API server.",
  {},
  async () => {
    try {
      const result = (await apiRequest("GET", "/health")) as {
        status: string;
        service: string;
      };
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Division API is **${result.status}** (${result.service}) at ${getApiBaseUrl()}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `❌ Division API is down: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// --- Start Server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Division MCP Server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
