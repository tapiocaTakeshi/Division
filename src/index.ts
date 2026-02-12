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

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "division-api" });
});

// API routes
app.use("/api/providers", providerRouter);
app.use("/api/roles", roleRouter);
app.use("/api/projects", projectRouter);
app.use("/api/assignments", assignmentRouter);
app.use("/api/tasks", taskRouter);
app.use("/api/agent", agentRouter);
app.use("/api/generate", generateRouter);
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
