import "./env";
import express from "express";
import { providerRouter } from "./routes/providers";
import { roleRouter } from "./routes/roles";
import { assignmentRouter } from "./routes/assignments";
import { taskRouter } from "./routes/tasks";
import { projectRouter } from "./routes/projects";
import { agentRouter } from "./routes/agent";
import { generateRouter } from "./routes/generate";
import providersListRouter from "./routes/providers-list";
import { modelSyncRouter } from "./routes/model-sync";
import mcpRouter from "./routes/mcp";
import { sseRouter } from "./routes/sse";
import { taskCreateRouter } from "./routes/task-create";
import { apiKeyRouter } from "./routes/api-keys";
import { knockRouter } from "./routes/knock";
import { divisionAuth } from "./middleware/auth";
import { syncModelsBackground } from "./services/sync-models";

const app = express();

app.use(express.json());

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
app.use("/api/projects", divisionAuth, projectRouter);
app.use("/api/assignments", assignmentRouter);
app.use("/api/tasks", divisionAuth, taskRouter);
app.use("/api/tasks", divisionAuth, taskCreateRouter);
app.use("/api/models", providersListRouter);
app.use("/api/models", modelSyncRouter);

// API key management (requires Clerk auth)
app.use("/api/api-keys", apiKeyRouter);

// Knock detection (API port-knocking security layer)
app.use("/api/knock", knockRouter);

// Protected API routes (auth state checked — uses env var provider keys when authenticated)
app.use("/api/agent", divisionAuth, agentRouter);
app.use("/api/generate", divisionAuth, generateRouter);
app.use("/api/sse", divisionAuth, sseRouter);
app.use("/mcp", divisionAuth, mcpRouter);

// Vercel: trigger background model sync on first request (once per cold start)
let vercelSyncTriggered = false;
if (process.env.VERCEL) {
  app.use((_req, _res, next) => {
    if (!vercelSyncTriggered) {
      vercelSyncTriggered = true;
      syncModelsBackground();
    }
    next();
  });
}

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
    syncModelsBackground();
  });
}

export default app;
