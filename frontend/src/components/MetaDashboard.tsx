import { useOrchestraStore } from '../stores/orchestraStore'

export function MetaDashboard() {
  const { metrics, session, isRunning } = useOrchestraStore()

  const costEstimate = (metrics.totalTokens / 1000) * 0.003 // rough average

  return (
    <div className="glass-card p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-bold uppercase tracking-wider text-conductor-muted">
          メタ管理パネル
        </h3>
        {isRunning && (
          <span className="flex items-center gap-1.5 text-xs text-conductor-accent-light">
            <span className="w-1.5 h-1.5 rounded-full bg-conductor-accent animate-pulse" />
            LIVE
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <MetricCard
          label="総トークン"
          value={formatNumber(metrics.totalTokens)}
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
            </svg>
          }
          color="text-conductor-accent-light"
        />
        <MetricCard
          label="推定コスト"
          value={`$${costEstimate.toFixed(4)}`}
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
          color="text-conductor-success"
        />
        <MetricCard
          label="実行時間"
          value={formatDuration(metrics.totalDurationMs)}
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
          color="text-conductor-warning"
        />
        <MetricCard
          label="成功率"
          value={`${(metrics.successRate * 100).toFixed(0)}%`}
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
          color={metrics.successRate >= 0.8 ? 'text-conductor-success' : 'text-conductor-error'}
        />
      </div>

      {/* Agent breakdown */}
      {session && session.agents.length > 0 && (
        <div className="mt-4 pt-3 border-t border-conductor-border">
          <div className="flex items-center justify-between text-xs text-conductor-muted mb-2">
            <span>Agent進捗</span>
            <span>
              {session.agents.filter((a) => a.status === 'success').length} / {session.agents.length}
            </span>
          </div>
          <div className="flex gap-1">
            {session.agents.map((agent) => (
              <div
                key={agent.id}
                className="flex-1 h-2 rounded-full transition-all duration-500"
                style={{
                  backgroundColor:
                    agent.status === 'success'
                      ? '#22c55e'
                      : agent.status === 'running'
                        ? '#6366f1'
                        : agent.status === 'error'
                          ? '#ef4444'
                          : '#2a2a3e',
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Wave info */}
      {session && session.waves.length > 0 && (
        <div className="mt-3 pt-3 border-t border-conductor-border">
          <span className="text-xs text-conductor-muted">
            Wave: {metrics.waveCount} | Agents: {metrics.agentCount}
          </span>
        </div>
      )}
    </div>
  )
}

function MetricCard({
  label,
  value,
  icon,
  color,
}: {
  label: string
  value: string
  icon: React.ReactNode
  color: string
}) {
  return (
    <div className="bg-white/5 rounded-lg p-3 flex flex-col gap-1">
      <div className={`flex items-center gap-1.5 ${color}`}>
        {icon}
        <span className="text-[10px] uppercase tracking-wider text-conductor-muted">{label}</span>
      </div>
      <span className={`text-lg font-mono font-bold ${color}`}>{value}</span>
    </div>
  )
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatDuration(ms: number): string {
  if (ms === 0) return '--'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}
