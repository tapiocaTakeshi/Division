import { create } from 'zustand'
import type {
  OrchestraSession,
  AgentNode,
  WaveGroup,
  ViewMode,
  PipelineTemplate,
  PipelineStep,
  SessionMetrics,
  AgentStatus,
  RoleSlug,
} from '../types'

interface OrchestraState {
  // Current session
  session: OrchestraSession | null
  viewMode: ViewMode
  isRunning: boolean

  // Pipeline builder
  pipelineSteps: PipelineStep[]
  templates: PipelineTemplate[]

  // Metrics
  metrics: SessionMetrics

  // Actions
  setViewMode: (mode: ViewMode) => void
  startSession: (sessionId: string, projectId: string, input: string) => void
  updateAgentStatus: (agentId: string, status: AgentStatus, data?: Partial<AgentNode>) => void
  setLeaderOutput: (output: string) => void
  addAgents: (agents: AgentNode[]) => void
  setWaves: (waves: WaveGroup[]) => void
  completeSession: (finalOutput: string, totalDurationMs: number) => void
  failSession: (error: string) => void
  resetSession: () => void
  updateMetrics: (metrics: Partial<SessionMetrics>) => void

  // Pipeline builder actions
  addPipelineStep: (step: PipelineStep) => void
  removePipelineStep: (stepId: string) => void
  reorderPipelineSteps: (fromIndex: number, toIndex: number) => void
  clearPipeline: () => void
  loadTemplate: (template: PipelineTemplate) => void
}

const defaultMetrics: SessionMetrics = {
  totalTokens: 0,
  estimatedCost: 0,
  totalDurationMs: 0,
  successRate: 0,
  agentCount: 0,
  waveCount: 0,
}

const defaultTemplates: PipelineTemplate[] = [
  {
    id: 'web-article',
    name: 'Web記事生成',
    description: 'リサーチから記事執筆・レビューまでの完全パイプライン',
    icon: 'article',
    tags: ['コンテンツ', '記事', 'SEO'],
    steps: [
      { id: 's1', role: 'search', provider: 'Perplexity', modelId: 'sonar-pro', dependsOn: [] },
      { id: 's2', role: 'planning', provider: 'Gemini', modelId: 'gemini-2.5-pro', dependsOn: ['s1'] },
      { id: 's3', role: 'writing', provider: 'Claude', modelId: 'claude-sonnet-4-5-20250514', dependsOn: ['s2'] },
      { id: 's4', role: 'review', provider: 'GPT', modelId: 'gpt-4.1', dependsOn: ['s3'] },
    ],
  },
  {
    id: 'app-dev',
    name: 'アプリ開発',
    description: '設計・コード生成・レビューのフルスタック開発パイプライン',
    icon: 'code',
    tags: ['開発', 'コード', 'レビュー'],
    steps: [
      { id: 's1', role: 'planning', provider: 'Gemini', modelId: 'gemini-2.5-pro', dependsOn: [] },
      { id: 's2', role: 'coding', provider: 'Claude', modelId: 'claude-sonnet-4-5-20250514', dependsOn: ['s1'] },
      { id: 's3', role: 'review', provider: 'GPT', modelId: 'gpt-4.1', dependsOn: ['s2'] },
      { id: 's4', role: 'coding', provider: 'Claude', modelId: 'claude-sonnet-4-5-20250514', dependsOn: ['s3'] },
    ],
  },
  {
    id: 'research',
    name: '論文調査',
    description: '多角的リサーチと統合分析パイプライン',
    icon: 'research',
    tags: ['調査', '分析', '論文'],
    steps: [
      { id: 's1', role: 'search', provider: 'Perplexity', modelId: 'sonar-pro', dependsOn: [] },
      { id: 's2', role: 'search', provider: 'Perplexity', modelId: 'sonar-deep-research', dependsOn: [] },
      { id: 's3', role: 'planning', provider: 'Gemini', modelId: 'gemini-2.5-pro', dependsOn: ['s1', 's2'] },
      { id: 's4', role: 'writing', provider: 'Claude', modelId: 'claude-sonnet-4-5-20250514', dependsOn: ['s3'] },
    ],
  },
]

export const useOrchestraStore = create<OrchestraState>((set) => ({
  session: null,
  viewMode: 'pipeline',
  isRunning: false,
  pipelineSteps: [],
  templates: defaultTemplates,
  metrics: defaultMetrics,

  setViewMode: (mode) => set({ viewMode: mode }),

  startSession: (sessionId, projectId, input) =>
    set({
      session: {
        sessionId,
        projectId,
        input,
        status: 'running',
        agents: [],
        waves: [],
      },
      isRunning: true,
      metrics: { ...defaultMetrics },
    }),

  updateAgentStatus: (agentId, status, data) =>
    set((state) => {
      if (!state.session) return state
      const agents = state.session.agents.map((a) =>
        a.id === agentId ? { ...a, status, ...data } : a
      )
      const successCount = agents.filter((a) => a.status === 'success').length
      const doneCount = agents.filter((a) => a.status === 'success' || a.status === 'error').length
      return {
        session: { ...state.session, agents },
        metrics: {
          ...state.metrics,
          successRate: doneCount > 0 ? successCount / doneCount : 0,
          totalTokens: agents.reduce((sum, a) => sum + (a.tokenCount ?? 0), 0),
          totalDurationMs: agents.reduce((sum, a) => sum + (a.durationMs ?? 0), 0),
        },
      }
    }),

  setLeaderOutput: (output) =>
    set((state) => ({
      session: state.session ? { ...state.session, leaderOutput: output } : null,
    })),

  addAgents: (agents) =>
    set((state) => ({
      session: state.session
        ? { ...state.session, agents: [...state.session.agents, ...agents] }
        : null,
      metrics: { ...state.metrics, agentCount: (state.session?.agents.length ?? 0) + agents.length },
    })),

  setWaves: (waves) =>
    set((state) => ({
      session: state.session ? { ...state.session, waves } : null,
      metrics: { ...state.metrics, waveCount: waves.length },
    })),

  completeSession: (finalOutput, totalDurationMs) =>
    set((state) => ({
      session: state.session
        ? { ...state.session, status: 'success', finalOutput, totalDurationMs }
        : null,
      isRunning: false,
      metrics: { ...state.metrics, totalDurationMs },
    })),

  failSession: (_error) =>
    set((state) => ({
      session: state.session ? { ...state.session, status: 'error' } : null,
      isRunning: false,
    })),

  resetSession: () => set({ session: null, isRunning: false, metrics: defaultMetrics }),

  updateMetrics: (partial) =>
    set((state) => ({ metrics: { ...state.metrics, ...partial } })),

  addPipelineStep: (step) =>
    set((state) => ({ pipelineSteps: [...state.pipelineSteps, step] })),

  removePipelineStep: (stepId) =>
    set((state) => ({
      pipelineSteps: state.pipelineSteps.filter((s) => s.id !== stepId),
    })),

  reorderPipelineSteps: (fromIndex, toIndex) =>
    set((state) => {
      const steps = [...state.pipelineSteps]
      const [moved] = steps.splice(fromIndex, 1)
      steps.splice(toIndex, 0, moved)
      return { pipelineSteps: steps }
    }),

  clearPipeline: () => set({ pipelineSteps: [] }),

  loadTemplate: (template) =>
    set({ pipelineSteps: template.steps.map((s) => ({ ...s })) }),
}))

// Role metadata
export const ROLE_META: Record<RoleSlug, { label: string; color: string; icon: string; strengths: string[] }> = {
  leader: {
    label: 'Leader',
    color: '#6366f1',
    icon: '🎼',
    strengths: ['タスク分解', '全体統括', '最適化'],
  },
  coding: {
    label: 'Coder',
    color: '#22c55e',
    icon: '💻',
    strengths: ['コード生成', 'デバッグ', 'リファクタ'],
  },
  search: {
    label: 'Researcher',
    color: '#3b82f6',
    icon: '🔍',
    strengths: ['情報収集', 'ファクトチェック', '最新データ'],
  },
  planning: {
    label: 'Planner',
    color: '#f59e0b',
    icon: '📐',
    strengths: ['設計', 'アーキテクチャ', '戦略立案'],
  },
  writing: {
    label: 'Writer',
    color: '#ec4899',
    icon: '✍️',
    strengths: ['長文生成', 'コピー', '要約'],
  },
  review: {
    label: 'Reviewer',
    color: '#8b5cf6',
    icon: '🔎',
    strengths: ['品質検証', 'バグ発見', '改善提案'],
  },
  image: {
    label: 'Image',
    color: '#14b8a6',
    icon: '🎨',
    strengths: ['画像生成', 'イラスト', 'ビジュアル'],
  },
  ideaman: {
    label: 'Idea Man',
    color: '#f97316',
    icon: '💡',
    strengths: ['発想', 'ブレスト', 'コンセプト創出'],
  },
}
