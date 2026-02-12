import express from "express";
import { providerRouter } from "./routes/providers";
import { roleRouter } from "./routes/roles";
import { assignmentRouter } from "./routes/assignments";
import { taskRouter } from "./routes/tasks";
import { projectRouter } from "./routes/projects";
import { agentRouter } from "./routes/agent";
import providersListRouter from "./routes/providers-list";
import mcpRouter from "./routes/mcp";
import { sseRouter } from "./routes/sse";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Health check – v2 (shows API key config status)
app.get("/health", (_req, res) => {
  const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "PERPLEXITY_API_KEY", "XAI_API_KEY", "DEEPSEEK_API_KEY"];
  const configured: Record<string, boolean> = {};
  for (const k of keys) {
    configured[k] = !!process.env[k];
  }
  res.json({ status: "ok", service: "division-api", version: "v2", apiKeys: configured });
});

// API routes
app.use("/api/providers", providerRouter);
app.use("/api/roles", roleRouter);
app.use("/api/projects", projectRouter);
app.use("/api/assignments", assignmentRouter);
app.use("/api/tasks", taskRouter);
app.use("/api/agent", agentRouter);
app.use("/api/models", providersListRouter);
app.use("/api/sse", sseRouter);
app.use("/mcp", mcpRouter);

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
  app.listen(PORT, () => {
    console.log(`Division API running on port ${PORT}`);
  });
}

export default app;
