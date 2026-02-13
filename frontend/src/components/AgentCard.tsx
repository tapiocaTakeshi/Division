import { ROLE_META } from '../stores/orchestraStore'
import type { AgentNode } from '../types'

interface AgentCardProps {
  agent: AgentNode
  onRerun?: (agentId: string) => void
  onChangeProvider?: (agentId: string) => void
  compact?: boolean
}

export function AgentCard({ agent, onRerun, onChangeProvider, compact }: AgentCardProps) {
  const meta = ROLE_META[agent.role]
  const statusStyles = getStatusStyles(agent.status)

  return (
    <div
      className={`
        glass-card p-4 transition-all duration-300 animate-fade-in
        ${agent.status === 'running' ? 'animate-pulse-glow border-conductor-accent' : ''}
        ${agent.status === 'error' ? 'animate-blink-error' : ''}
        ${agent.status === 'success' ? 'border-conductor-success/30' : ''}
        ${compact ? 'p-3' : 'p-4'}
      `}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-lg">{meta.icon}</span>
          <div>
            <span
              className="text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
              style={{ backgroundColor: `${meta.color}20`, color: meta.color }}
            >
              {meta.label}
            </span>
          </div>
        </div>
        <div className={`flex items-center gap-1.5 text-xs font-medium ${statusStyles.textClass}`}>
          <div className={`w-2 h-2 rounded-full ${statusStyles.dotClass}`} />
          {statusStyles.label}
        </div>
      </div>

      {/* Task title */}
      <p className="text-sm text-white/90 mb-3 line-clamp-2">{agent.label}</p>

      {/* Provider info */}
      <div className="flex items-center gap-2 mb-3">
        <ProviderBadge provider={agent.provider} />
        <span className="text-xs text-conductor-muted truncate">{agent.modelId}</span>
      </div>

      {/* Stats row */}
      {!compact && (
        <div className="grid grid-cols-2 gap-2 mb-3">
          <StatPill
            label="Time"
            value={agent.durationMs != null ? `${(agent.durationMs / 1000).toFixed(1)}s` : '--'}
          />
          <StatPill
            label="Tokens"
            value={agent.tokenCount != null ? formatTokens(agent.tokenCount) : '--'}
          />
        </div>
      )}

      {/* Strength tags */}
      {!compact && (
        <div className="flex flex-wrap gap-1 mb-3">
          {meta.strengths.map((s) => (
            <span
              key={s}
              className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-conductor-muted"
            >
              {s}
            </span>
          ))}
        </div>
      )}

      {/* Action buttons */}
      {(onRerun || onChangeProvider) && agent.status !== 'running' && (
        <div className="flex gap-2 mt-2 pt-2 border-t border-conductor-border">
          {onRerun && (
            <button
              onClick={() => onRerun(agent.id)}
              className="flex-1 text-xs py-1.5 rounded-lg bg-conductor-accent/10 text-conductor-accent-light hover:bg-conductor-accent/20 transition-colors"
            >
              再実行
            </button>
          )}
          {onChangeProvider && (
            <button
              onClick={() => onChangeProvider(agent.id)}
              className="flex-1 text-xs py-1.5 rounded-lg bg-white/5 text-conductor-muted hover:bg-white/10 transition-colors"
            >
              モデル変更
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function ProviderBadge({ provider }: { provider: string }) {
  const colors: Record<string, string> = {
    Claude: '#d97706',
    Gemini: '#3b82f6',
    GPT: '#22c55e',
    Perplexity: '#6366f1',
    Grok: '#ec4899',
    DeepSeek: '#14b8a6',
  }
  const key = Object.keys(colors).find((k) => provider.includes(k)) ?? ''
  const color = colors[key] ?? '#64748b'

  return (
    <span
      className="text-[10px] font-bold px-1.5 py-0.5 rounded"
      style={{ backgroundColor: `${color}20`, color }}
    >
      {provider}
    </span>
  )
}

function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between bg-white/5 rounded-lg px-2.5 py-1.5">
      <span className="text-[10px] text-conductor-muted">{label}</span>
      <span className="text-xs font-mono text-white/80">{value}</span>
    </div>
  )
}

function getStatusStyles(status: AgentNode['status']) {
  switch (status) {
    case 'idle':
      return { dotClass: 'bg-conductor-muted', textClass: 'text-conductor-muted', label: '待機' }
    case 'running':
      return { dotClass: 'bg-conductor-accent animate-pulse', textClass: 'text-conductor-accent-light', label: '実行中' }
    case 'success':
      return { dotClass: 'bg-conductor-success', textClass: 'text-conductor-success', label: '完了' }
    case 'error':
      return { dotClass: 'bg-conductor-error', textClass: 'text-conductor-error', label: 'エラー' }
  }
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
