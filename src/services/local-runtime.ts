/**
 * Local Runtime Bridge
 *
 * Lets a connected IDE client (Orchestra's Electron main process) execute
 * NATIVE_TOOLS calls on the user's own machine instead of Division running
 * them itself. Division queues a tool call per project; the client long-polls
 * for queued calls and posts results back. If no client is connected for a
 * project, callers fall back to server-side execution (see agent-tools.ts).
 *
 * This is intentionally an in-memory, single-process registry — Division
 * runs as one process per deployment, so no cross-instance coordination is
 * needed here.
 */

import crypto from "crypto";
import { logger } from "../utils/logger";

export interface ToolCallRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

interface PendingResult {
  resolve: (result: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const CONNECTED_WINDOW_MS = 20_000; // no poll within this window => treated as disconnected

class ProjectAgentChannel {
  private queue: ToolCallRequest[] = [];
  private waitingPollers: Array<(calls: ToolCallRequest[]) => void> = [];
  private pendingResults = new Map<string, PendingResult>();
  private lastPolledAt = 0;

  get connected(): boolean {
    return Date.now() - this.lastPolledAt < CONNECTED_WINDOW_MS;
  }

  markPolled(): void {
    this.lastPolledAt = Date.now();
  }

  /** Called by Division when it wants a tool executed on the client's machine. */
  dispatch(tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<string> {
    const id = crypto.randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResults.delete(id);
        reject(new Error(`Local agent timed out after ${timeoutMs}ms waiting for "${tool}"`));
      }, timeoutMs);
      this.pendingResults.set(id, { resolve, reject, timer });
      this.queue.push({ id, tool, args });
      this.flushWaitingPollers();
    });
  }

  /** Called by the long-poll route handler. Resolves once a call is queued or waitMs elapses. */
  poll(waitMs: number): Promise<ToolCallRequest[]> {
    this.markPolled();
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.splice(0));
    }
    return new Promise<ToolCallRequest[]>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waitingPollers.indexOf(wrapped);
        if (idx >= 0) this.waitingPollers.splice(idx, 1);
        resolve([]);
      }, waitMs);
      const wrapped = (calls: ToolCallRequest[]) => {
        clearTimeout(timer);
        resolve(calls);
      };
      this.waitingPollers.push(wrapped);
    });
  }

  /** Called by the result-posting route handler. Returns false if `id` is unknown (e.g. already timed out). */
  postResult(id: string, result: string | undefined, error: string | undefined): boolean {
    const pending = this.pendingResults.get(id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingResults.delete(id);
    if (error) pending.reject(new Error(error));
    else pending.resolve(result ?? "");
    return true;
  }

  private flushWaitingPollers(): void {
    if (this.waitingPollers.length === 0) return;
    const calls = this.queue.splice(0);
    const pollers = this.waitingPollers.splice(0);
    for (const p of pollers) p(calls);
  }
}

const channels = new Map<string, ProjectAgentChannel>();

function getChannel(projectId: string): ProjectAgentChannel {
  let channel = channels.get(projectId);
  if (!channel) {
    channel = new ProjectAgentChannel();
    channels.set(projectId, channel);
  }
  return channel;
}

export function isLocalAgentConnected(projectId: string | undefined): boolean {
  if (!projectId) return false;
  return channels.get(projectId)?.connected ?? false;
}

export async function dispatchToLocalAgent(
  projectId: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs = 45_000
): Promise<string> {
  logger.info(`[LocalRuntime] Dispatching "${tool}" to local agent for project ${projectId}`);
  return getChannel(projectId).dispatch(tool, args, timeoutMs);
}

export function pollForProject(projectId: string, waitMs: number): Promise<ToolCallRequest[]> {
  return getChannel(projectId).poll(waitMs);
}

export function postToolResult(projectId: string, id: string, result: string | undefined, error: string | undefined): boolean {
  return getChannel(projectId).postResult(id, result, error);
}

export function isProjectChannelConnected(projectId: string): boolean {
  return channels.get(projectId)?.connected ?? false;
}
