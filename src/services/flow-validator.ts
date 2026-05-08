import { Flow, FlowValidationResult, FlowValidationError, FlowNode, FlowEdge } from "../types/flow";

export class FlowValidator {
  validate(flow: Flow): FlowValidationResult {
    const errors: FlowValidationError[] = [];
    const warnings: string[] = [];

    // Check for cycles using DFS
    const hasCycle = this.detectCycle(flow.nodes, flow.edges);
    if (hasCycle) {
      errors.push({
        type: "cycle",
        message: "Flow contains circular dependency",
      });
    }

    // Validate all nodes
    for (const node of flow.nodes) {
      this.validateNode(node, flow, errors, warnings);
    }

    // Validate edges
    for (const edge of flow.edges) {
      this.validateEdge(edge, flow.nodes, errors);
    }

    // Check for orphaned nodes (not connected)
    const connectedNodes = this.findConnectedNodes(flow.nodes, flow.edges);
    for (const node of flow.nodes) {
      if (!connectedNodes.has(node.id)) {
        warnings.push(`Node "${node.id}" is not connected to the flow`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  private detectCycle(nodes: FlowNode[], edges: FlowEdge[]): boolean {
    const adjList = new Map<string, string[]>();

    // Build adjacency list
    for (const node of nodes) {
      adjList.set(node.id, []);
    }

    for (const edge of edges) {
      adjList.get(edge.source)?.push(edge.target);
    }

    // Track visited and recursion stack
    const visited = new Set<string>();
    const recStack = new Set<string>();

    for (const nodeId of adjList.keys()) {
      if (!visited.has(nodeId)) {
        if (this.hasCycleDFS(nodeId, adjList, visited, recStack)) {
          return true;
        }
      }
    }

    return false;
  }

  private hasCycleDFS(
    nodeId: string,
    adjList: Map<string, string[]>,
    visited: Set<string>,
    recStack: Set<string>
  ): boolean {
    visited.add(nodeId);
    recStack.add(nodeId);

    const neighbors = adjList.get(nodeId) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        if (this.hasCycleDFS(neighbor, adjList, visited, recStack)) {
          return true;
        }
      } else if (recStack.has(neighbor)) {
        return true;
      }
    }

    recStack.delete(nodeId);
    return false;
  }

  private validateNode(
    node: FlowNode,
    flow: Flow,
    errors: FlowValidationError[],
    warnings: string[]
  ): void {
    // Validate node configuration based on type
    if (node.type === "prompt") {
      if (!node.config.providerId || !node.config.modelId) {
        errors.push({
          type: "invalid_config",
          nodeId: node.id,
          message: `Prompt node "${node.id}" requires providerId and modelId`,
        });
      }
    }

    // Check inputs/outputs are well-formed
    for (const input of node.inputs) {
      if (!input.name) {
        errors.push({
          type: "invalid_config",
          nodeId: node.id,
          message: `Input in node "${node.id}" is missing name`,
        });
      }
    }

    for (const output of node.outputs) {
      if (!output.name) {
        errors.push({
          type: "invalid_config",
          nodeId: node.id,
          message: `Output in node "${node.id}" is missing name`,
        });
      }
    }

    // Warning if no outputs for non-terminal nodes
    if (node.type !== "output" && node.outputs.length === 0) {
      warnings.push(`Node "${node.id}" has no outputs`);
    }
  }

  private validateEdge(
    edge: FlowEdge,
    nodes: FlowNode[],
    errors: FlowValidationError[]
  ): void {
    const sourceNode = nodes.find((n) => n.id === edge.source);
    const targetNode = nodes.find((n) => n.id === edge.target);

    if (!sourceNode) {
      errors.push({
        type: "missing_node",
        message: `Edge references missing source node "${edge.source}"`,
      });
    }

    if (!targetNode) {
      errors.push({
        type: "missing_node",
        message: `Edge references missing target node "${edge.target}"`,
      });
    }

    // Validate handles if specified
    if (edge.sourceHandle && sourceNode) {
      const outputExists = sourceNode.outputs.some(
        (o) => o.name === edge.sourceHandle
      );
      if (!outputExists) {
        errors.push({
          type: "missing_input",
          message: `Edge references non-existent output "${edge.sourceHandle}" from node "${edge.source}"`,
        });
      }
    }

    if (edge.targetHandle && targetNode) {
      const inputExists = targetNode.inputs.some(
        (i) => i.name === edge.targetHandle
      );
      if (!inputExists) {
        errors.push({
          type: "missing_input",
          message: `Edge references non-existent input "${edge.targetHandle}" on node "${edge.target}"`,
        });
      }
    }
  }

  private findConnectedNodes(
    nodes: FlowNode[],
    edges: FlowEdge[]
  ): Set<string> {
    const connected = new Set<string>();

    // Start from output nodes and work backwards
    const outputNodes = nodes.filter((n) => n.type === "output");
    if (outputNodes.length === 0 && nodes.length > 0) {
      // If no output nodes, mark all as connected
      return new Set(nodes.map((n) => n.id));
    }

    const visited = new Set<string>();
    const queue = [...outputNodes.map((n) => n.id)];

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (visited.has(nodeId)) continue;

      visited.add(nodeId);
      connected.add(nodeId);

      // Find all edges pointing to this node
      const incomingEdges = edges.filter((e) => e.target === nodeId);
      for (const edge of incomingEdges) {
        if (!visited.has(edge.source)) {
          queue.push(edge.source);
        }
      }
    }

    return connected;
  }
}
