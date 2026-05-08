import { PrismaClient } from "@prisma/client";
import Decimal from "decimal.js";

export interface NodeExecutionCost {
  nodeId: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd: number;
}

export interface FlowRunMetrics {
  runId: string;
  flowId: string;
  totalDurationMs: number;
  totalCostUsd: number;
  nodeExecutions: {
    nodeId: string;
    status: string;
    durationMs: number;
    costUsd: number;
  }[];
}

export class FlowLogger {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async logNodeExecution(
    nodeId: string,
    runId: string,
    cost: NodeExecutionCost
  ): Promise<void> {
    await this.prisma.flowNodeExecution.update({
      where: { id: nodeId },
      data: {
        costUsd: new Decimal(cost.costUsd),
      },
    });
  }

  async calculateFlowCost(runId: string): Promise<number> {
    const executions = await this.prisma.flowNodeExecution.findMany({
      where: { runId },
      select: { costUsd: true },
    });

    let totalCost = new Decimal(0);
    for (const execution of executions) {
      totalCost = totalCost.plus(new Decimal(execution.costUsd));
    }

    return totalCost.toNumber();
  }

  async getFlowMetrics(runId: string): Promise<FlowRunMetrics | null> {
    const run = await this.prisma.flowRun.findUnique({
      where: { id: runId },
      include: { executions: true },
    });

    if (!run) return null;

    const totalDurationMs =
      run.completedAt && run.startedAt
        ? run.completedAt.getTime() - run.startedAt.getTime()
        : 0;

    let totalCost = new Decimal(0);
    const nodeMetrics = [];

    for (const execution of run.executions) {
      totalCost = totalCost.plus(new Decimal(execution.costUsd));

      nodeMetrics.push({
        nodeId: execution.nodeId,
        status: execution.status,
        durationMs: execution.durationMs || 0,
        costUsd: new Decimal(execution.costUsd).toNumber(),
      });
    }

    return {
      runId,
      flowId: run.flowId,
      totalDurationMs,
      totalCostUsd: totalCost.toNumber(),
      nodeExecutions: nodeMetrics,
    };
  }

  async logUsage(
    runId: string,
    projectId: string | null,
    providerId: string,
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    costUsd: number
  ): Promise<void> {
    await this.prisma.usageLog.create({
      data: {
        projectId,
        sessionId: runId,
        providerId,
        modelId,
        inputTokens,
        outputTokens,
        inputCostUsd: new Decimal(costUsd * 0.6), // Estimate 60% for input
        outputCostUsd: new Decimal(costUsd * 0.4), // Estimate 40% for output
        totalCostUsd: new Decimal(costUsd),
      },
    });
  }

  async getRunCostBreakdown(runId: string): Promise<{
    byNode: Record<string, number>;
    total: number;
  }> {
    const executions = await this.prisma.flowNodeExecution.findMany({
      where: { runId },
      select: { nodeId: true, costUsd: true },
    });

    const byNode: Record<string, number> = {};
    let total = new Decimal(0);

    for (const execution of executions) {
      const cost = new Decimal(execution.costUsd);
      byNode[execution.nodeId] = cost.toNumber();
      total = total.plus(cost);
    }

    return {
      byNode,
      total: total.toNumber(),
    };
  }

  async exportMetrics(
    flowId: string,
    startDate: Date,
    endDate: Date
  ): Promise<{
    flowId: string;
    runsCount: number;
    avgDurationMs: number;
    totalCostUsd: number;
    successRate: number;
  }> {
    const runs = await this.prisma.flowRun.findMany({
      where: {
        flowId,
        createdAt: { gte: startDate, lte: endDate },
      },
      include: { executions: true },
    });

    if (runs.length === 0) {
      return {
        flowId,
        runsCount: 0,
        avgDurationMs: 0,
        totalCostUsd: 0,
        successRate: 0,
      };
    }

    let totalDurationMs = 0;
    let totalCost = new Decimal(0);
    let successCount = 0;

    for (const run of runs) {
      if (run.completedAt && run.startedAt) {
        totalDurationMs += run.completedAt.getTime() - run.startedAt.getTime();
      }

      if (run.status === "completed") {
        successCount++;
      }

      for (const execution of run.executions) {
        totalCost = totalCost.plus(new Decimal(execution.costUsd));
      }
    }

    return {
      flowId,
      runsCount: runs.length,
      avgDurationMs: Math.round(totalDurationMs / runs.length),
      totalCostUsd: totalCost.toNumber(),
      successRate: (successCount / runs.length) * 100,
    };
  }
}
