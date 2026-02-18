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
import { clerkMiddleware, divisionAuth } from "./middleware/auth";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Authentication layer (Clerk when configured, no-op otherwise)
app.use(clerkMiddleware());

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "division-api" });
});

// Public API routes (no auth required)
app.use("/api/providers", providerRouter);
app.use("/api/roles", roleRouter);
app.use("/api/projects", projectRouter);
app.use("/api/assignments", assignmentRouter);
app.use("/api/tasks", taskRouter);
app.use("/api/tasks", taskCreateRouter);
app.use("/api/models", providersListRouter);

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
  app.listen(PORT, () => {
    console.log(`Division API running on port ${PORT}`);
  });
}

export default app;
