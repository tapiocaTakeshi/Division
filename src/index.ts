import express from "express";
import { providerRouter } from "./routes/providers";
import { roleRouter } from "./routes/roles";
import { assignmentRouter } from "./routes/assignments";
import { taskRouter } from "./routes/tasks";
import { projectRouter } from "./routes/projects";
import { agentRouter } from "./routes/agent";
import { generateRouter } from "./routes/generate";
import providersListRouter from "./routes/providers-list";
import mcpRouter from "./routes/mcp";
import { sseRouter } from "./routes/sse";
import { taskCreateRouter } from "./routes/task-create";
import { apiKeyRouter } from "./routes/api-keys";
import { clerkMiddleware, divisionAuth } from "./middleware/auth";

const app = express();

app.use(express.json());

// Authentication layer (Clerk when configured, no-op otherwise)
app.use(clerkMiddleware());

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "division-api" });
});

// Debug: check auth state and env var availability (temporary)
app.get("/debug/auth", divisionAuth, (_req, res) => {
  const envKeys = [
    "DIVISION_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "OPENAI_API_KEY",
    "PERPLEXITY_API_KEY",
    "XAI_API_KEY",
    "DEEPSEEK_API_KEY",
  ];
  const envStatus: Record<string, boolean> = {};
  for (const key of envKeys) {
    envStatus[key] = !!process.env[key];
  }
  res.json({
    authenticated: !!res.locals.authenticated,
    envVars: envStatus,
  });
});

// Public API routes (no auth required)
app.use("/api/providers", providerRouter);
app.use("/api/roles", roleRouter);
app.use("/api/projects", projectRouter);
app.use("/api/assignments", assignmentRouter);
app.use("/api/tasks", taskRouter);
app.use("/api/tasks", taskCreateRouter);
app.use("/api/models", providersListRouter);

// API key management (requires Clerk auth)
app.use("/api/api-keys", apiKeyRouter);

// Protected API routes (auth state checked — uses env var provider keys when authenticated)
app.use("/api/agent", divisionAuth, agentRouter);
app.use("/api/generate", divisionAuth, generateRouter);
app.use("/api/sse", divisionAuth, sseRouter);
app.use("/mcp", divisionAuth, mcpRouter);

// Error handler
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error(err.stack);
    res.status(500).json({ error: "Internal server error", message: err.message });
  }
);

// Only start server when running locally (not on Vercel)
if (!process.env.VERCEL) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Division API running on port ${port}`);
  });
}

export default app;
