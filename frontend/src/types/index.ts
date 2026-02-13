// ===== Agent & Task Types =====

export type AgentStatus = 'idle' | 'running' | 'success' | 'error'
export type RoleSlug = 'leader' | 'coding' | 'search' | 'planning' | 'writing' | 'review'

export interface AgentNode {
  id: string
  role: RoleSlug
  label: string
  provider: string
  modelId: string
  status: AgentStatus
  output?: string
  durationMs?: number
  tokenCount?: number
  dependsOn: string[]
}

export interface WaveGroup {
  waveIndex: number
  taskIds: string[]
}

export interface OrchestraSession {
  sessionId: string
  projectId: string
  input: string
  status: 'pending' | 'running' | 'success' | 'error'
  agents: AgentNode[]
  waves: WaveGroup[]
  leaderOutput?: string
  finalOutput?: string
  totalDurationMs?: number
  totalTokens?: number
  estimatedCost?: number
}

// ===== Pipeline Builder Types =====

export interface PipelineStep {
  id: string
  role: RoleSlug
  provider: string
  modelId: string
  dependsOn: string[]
  config?: Record<string, unknown>
}

export interface PipelineTemplate {
  id: string
  name: string
  description: string
  icon: string
  steps: PipelineStep[]
  tags: string[]
}

// ===== Provider Types =====

export interface Provider {
  id: string
  name: string
  displayName: string
  apiType: string
  modelId: string
  isEnabled: boolean
  strengths?: string[]
}

export interface Role {
  id: string
  slug: RoleSlug
  name: string
  description: string
}

// ===== SSE Event Types =====

export type SSEEventType =
  | 'session_start'
  | 'leader_start'
  | 'leader_chunk'
  | 'leader_done'
  | 'leader_error'
  | 'wave_start'
  | 'wave_done'
  | 'task_start'
  | 'task_chunk'
  | 'task_done'
  | 'task_error'
  | 'session_done'
  | 'heartbeat'

export interface SSEEvent {
  type: SSEEventType
  data: Record<string, unknown>
  timestamp: number
}

// ===== Meta Dashboard Types =====

export interface SessionMetrics {
  totalTokens: number
  estimatedCost: number
  totalDurationMs: number
  successRate: number
  agentCount: number
  waveCount: number
}

// ===== View Mode =====

export type ViewMode = 'pipeline' | 'conductor' | 'builder' | 'templates'
