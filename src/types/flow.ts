export type FlowNodeType = "prompt" | "function" | "branch" | "join" | "output";
export type FlowNodeStatus = "pending" | "running" | "completed" | "failed" | "skipped";
export type FlowRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type FlowStatus = "draft" | "active" | "archived";

export interface FlowNodeInput {
  name: string;
  description?: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  required?: boolean;
  default?: unknown;
}

export interface FlowNodeOutput {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
}

export interface FlowNodeConfig {
  providerId?: string;
  modelId?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: unknown[];
  [key: string]: unknown;
}

export interface FlowNode {
  id: string;
  type: FlowNodeType;
  name: string;
  description?: string;
  inputs: FlowNodeInput[];
  outputs: FlowNodeOutput[];
  config: FlowNodeConfig;
  position?: { x: number; y: number };
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  condition?: string;
}

export interface Flow {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  status: FlowStatus;
  config?: {
    timeout?: number;
    retryPolicy?: {
      maxRetries: number;
      backoffMs: number;
    };
    [key: string]: unknown;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface FlowRun {
  id: string;
  flowId: string;
  status: FlowRunStatus;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  errorMsg?: string;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface FlowNodeExecution {
  id: string;
  runId: string;
  nodeId: string;
  status: FlowNodeStatus;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  errorMsg?: string;
  retries: number;
  maxRetries: number;
  durationMs?: number;
  costUsd: number;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
}

export interface FlowValidationError {
  type: "cycle" | "missing_node" | "missing_input" | "invalid_config";
  nodeId?: string;
  message: string;
}

export interface FlowValidationResult {
  valid: boolean;
  errors: FlowValidationError[];
  warnings: string[];
}

export interface ExecutionContext {
  runId: string;
  nodeId: string;
  previousOutputs: Map<string, Record<string, unknown>>;
  flowConfig?: Flow["config"];
}
