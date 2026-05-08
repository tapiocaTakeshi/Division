import {
  Flow,
  FlowRun,
  FlowNodeExecution,
  FlowNode,
  FlowRunStatus,
  ExecutionContext,
} from "../types/flow";
import { PrismaClient } from "@prisma/client";

export class FlowExecutor {
  private prisma: PrismaClient;
  private maxRetries = 3;
  private retryDelaysMs = [1000, 2000, 4000, 8000]; // Exponential backoff

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async executeFlow(
    flow: Flow,
    flowRun: FlowRun,
    input: Record<string, unknown> = {}
  ): Promise<FlowRun> {
    try {
      await this.prisma.flowRun.update({
        where: { id: flowRun.id },
        data: { status: "running", startedAt: new Date() },
      });

      // Build node execution order (topological sort)
      const executionOrder = this.topologicalSort(flow.nodes, flow.edges);
      const previousOutputs = new Map<string, Record<string, unknown>>();

      // Set initial inputs
      const initialNodeIds = this.getInitialNodes(flow.edges);
      for (const nodeId of initialNodeIds) {
        previousOutputs.set(nodeId, input);
      }

      // Execute nodes in order
      for (const nodeId of executionOrder) {
        const node = flow.nodes.find((n) => n.id === nodeId);
        if (!node) continue;

        const nodeInput = this.resolveNodeInput(
          node,
          flow,
          previousOutputs,
          input
        );

        const execution = await this.executeNode(
          flowRun.id,
          node,
          nodeInput,
          previousOutputs
        );

        if (execution.output && typeof execution.output === "object") {
          previousOutputs.set(nodeId, execution.output as Record<string, unknown>);
        }

        if (execution.status === "failed") {
          await this.prisma.flowRun.update({
            where: { id: flowRun.id },
            data: {
              status: "failed",
              errorMsg: execution.errorMsg,
              completedAt: new Date(),
            },
          });
          return flowRun;
        }
      }

      // Collect final output from output nodes
      const outputNodes = flow.nodes.filter((n) => n.type === "output");
      const finalOutput: Record<string, unknown> = {};

      for (const outputNode of outputNodes) {
        const output = previousOutputs.get(outputNode.id);
        if (output) {
          finalOutput[outputNode.id] = output;
        }
      }

      await this.prisma.flowRun.update({
        where: { id: flowRun.id },
        data: {
          status: "completed",
          output: finalOutput as any,
          completedAt: new Date(),
        },
      });

      return {
        ...flowRun,
        status: "completed" as FlowRunStatus,
        output: finalOutput,
        completedAt: new Date(),
      };
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : "Unknown error";
      await this.prisma.flowRun.update({
        where: { id: flowRun.id },
        data: {
          status: "failed",
          errorMsg: errorMsg || "Unknown error",
          completedAt: new Date(),
        },
      });

      return {
        ...flowRun,
        status: "failed" as FlowRunStatus,
        errorMsg: errorMsg || "Unknown error",
        completedAt: new Date(),
      };
    }
  }

  private async executeNode(
    runId: string,
    node: FlowNode,
    input: Record<string, unknown>,
    previousOutputs: Map<string, Record<string, unknown>>
  ): Promise<FlowNodeExecution> {
    const execution = await this.prisma.flowNodeExecution.create({
      data: {
        runId,
        nodeId: node.id,
        status: "pending",
        input: (input || undefined) as any,
        maxRetries: this.maxRetries,
      },
    });

    let lastError: Error | undefined;
    let output: Record<string, unknown> | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delayMs = this.retryDelaysMs[Math.min(attempt - 1, 3)];
          await new Promise((resolve) => setTimeout(resolve, delayMs));

          await this.prisma.flowNodeExecution.update({
            where: { id: execution.id },
            data: { retries: attempt },
          });
        }

        const startTime = Date.now();

        await this.prisma.flowNodeExecution.update({
          where: { id: execution.id },
          data: { status: "running", startedAt: new Date() },
        });

        // Execute based on node type
        switch (node.type) {
          case "prompt":
            output = await this.executePromptNode(node, input);
            break;
          case "function":
            output = await this.executeFunctionNode(node, input);
            break;
          case "output":
            output = input; // Output nodes pass through their input
            break;
          default:
            output = input;
        }

        const durationMs = Date.now() - startTime;

        await this.prisma.flowNodeExecution.update({
          where: { id: execution.id },
          data: {
            status: "completed",
            output: output as any,
            durationMs,
            completedAt: new Date(),
          },
        });

        return {
          ...execution,
          status: "completed" as const,
          output,
          durationMs,
          completedAt: new Date(),
        } as any;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt === this.maxRetries) {
          const errorMsg = lastError.message;
          await this.prisma.flowNodeExecution.update({
            where: { id: execution.id },
            data: {
              status: "failed",
              errorMsg: errorMsg || "Unknown error",
              retries: attempt,
              completedAt: new Date(),
            },
          });

          return {
            ...execution,
            status: "failed" as const,
            errorMsg: errorMsg || "Unknown error",
            retries: attempt,
            completedAt: new Date(),
          } as any;
        }
      }
    }

    return {
      ...execution,
      status: "failed" as const,
      errorMsg: lastError?.message || "Unknown error",
    } as any;
  }

  private async executePromptNode(
    node: FlowNode,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    // This is a placeholder. In production, this would call the AI provider
    // For now, just return input as output for demonstration
    return {
      prompt_result: input,
      timestamp: new Date().toISOString(),
    };
  }

  private async executeFunctionNode(
    node: FlowNode,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    // This is a placeholder for function execution
    // Could integrate with serverless functions or external services
    return {
      function_result: input,
      timestamp: new Date().toISOString(),
    };
  }

  private resolveNodeInput(
    node: FlowNode,
    flow: Flow,
    previousOutputs: Map<string, Record<string, unknown>>,
    initialInput: Record<string, unknown>
  ): Record<string, unknown> {
    const input: Record<string, unknown> = {};

    // Find incoming edges
    const incomingEdges = flow.edges.filter((e) => e.target === node.id);

    if (incomingEdges.length === 0) {
      // No incoming edges, use initial input
      return initialInput;
    }

    for (const edge of incomingEdges) {
      const sourceOutput = previousOutputs.get(edge.source) || {};
      const handle = edge.sourceHandle || edge.targetHandle;

      if (handle) {
        input[handle] = sourceOutput[handle];
      } else {
        Object.assign(input, sourceOutput);
      }
    }

    return input;
  }

  private topologicalSort(
    nodes: FlowNode[],
    edges: { source: string; target: string }[]
  ): string[] {
    const adjList = new Map<string, string[]>();
    const inDegree = new Map<string, number>();

    // Initialize
    for (const node of nodes) {
      adjList.set(node.id, []);
      inDegree.set(node.id, 0);
    }

    // Build adjacency list
    for (const edge of edges) {
      adjList.get(edge.source)?.push(edge.target);
      inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
    }

    // Kahn's algorithm
    const queue: string[] = [];
    for (const [nodeId, degree] of inDegree.entries()) {
      if (degree === 0) {
        queue.push(nodeId);
      }
    }

    const result: string[] = [];
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      result.push(nodeId);

      for (const neighbor of adjList.get(nodeId) || []) {
        const newDegree = (inDegree.get(neighbor) || 1) - 1;
        inDegree.set(neighbor, newDegree);

        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }

    return result;
  }

  private getInitialNodes(edges: { source: string; target: string }[]): Set<string> {
    const allTargets = new Set(edges.map((e) => e.target));
    const allSources = new Set(edges.map((e) => e.source));

    const initial = new Set<string>();
    for (const source of allSources) {
      if (!allTargets.has(source)) {
        initial.add(source);
      }
    }

    return initial;
  }
}
