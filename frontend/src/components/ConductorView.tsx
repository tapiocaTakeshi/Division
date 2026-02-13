import { useOrchestraStore, ROLE_META } from '../stores/orchestraStore'
import { AgentCard } from './AgentCard'

interface ConductorViewProps {
  onRerunAgent?: (agentId: string) => void
}

export function ConductorView({ onRerunAgent }: ConductorViewProps) {
  const { session } = useOrchestraStore()

  if (!session) {
    return <EmptyState />
  }

  const { agents, waves, leaderOutput } = session

  return (
    <div className="flex flex-col gap-6 animate-fade-in">
      {/* Leader section */}
      <div className="glass-card p-5">
        <div className="flex items-center gap-3 mb-3">
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center text-lg
              ${session.status === 'running' ? 'animate-pulse-glow' : ''}
            `}
            style={{ backgroundColor: `${ROLE_META.leader.color}20` }}
          >
            {ROLE_META.leader.icon}
          </div>
          <div>
            <h3 className="text-sm font-bold text-white">Leader AI</h3>
            <p className="text-xs text-conductor-muted">タスク分解 & オーケストレーション</p>
          </div>
          {session.status === 'running' && !leaderOutput && (
            <div className="ml-auto flex items-center gap-2 text-xs text-conductor-accent-light">
              <LoadingDots />
              分析中...
            </div>
          )}
        </div>
        {leaderOutput && (
          <div className="bg-white/5 rounded-lg p-3 text-xs text-white/70 font-mono leading-relaxed max-h-32 overflow-y-auto">
            {leaderOutput}
          </div>
        )}
      </div>

      {/* Wave-based pipeline */}
      {waves.length > 0 && (
        <div className="flex flex-col gap-4">
          {waves.map((wave, waveIdx) => {
            const waveAgents = wave.taskIds
              .map((id) => agents.find((a) => a.id === id))
              .filter(Boolean) as typeof agents

            return (
              <div key={waveIdx} className="animate-slide-up" style={{ animationDelay: `${waveIdx * 100}ms` }}>
                {/* Wave header with connector */}
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex items-center gap-2">
                    <WaveIndicator index={waveIdx} total={waves.length} />
                    <span className="text-xs font-bold text-conductor-muted uppercase tracking-wider">
                      Wave {waveIdx + 1}
                    </span>
                  </div>
                  <div className="flex-1 h-px bg-gradient-to-r from-conductor-border to-transparent" />
                  <span className="text-[10px] text-conductor-muted">
                    {waveAgents.length} agents
                    {waveAgents.length > 1 && ' (並列実行)'}
                  </span>
                </div>

                {/* Agent cards */}
                <div className={`grid gap-3 ${waveAgents.length === 1 ? 'grid-cols-1 max-w-md' : waveAgents.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
                  {waveAgents.map((agent) => (
                    <AgentCard
                      key={agent.id}
                      agent={agent}
                      onRerun={onRerunAgent}
                      onChangeProvider={onRerunAgent ? () => onRerunAgent(agent.id) : undefined}
                    />
                  ))}
                </div>

                {/* Flow connector between waves */}
                {waveIdx < waves.length - 1 && (
                  <div className="flex justify-center py-2">
                    <svg width="24" height="32" viewBox="0 0 24 32" className="text-conductor-accent/40">
                      <line
                        x1="12" y1="0" x2="12" y2="24"
                        stroke="currentColor"
                        strokeWidth="2"
                        className="flow-connector"
                      />
                      <polygon points="6,24 12,32 18,24" fill="currentColor" />
                    </svg>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Agents without waves (fallback flat view) */}
      {waves.length === 0 && agents.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              onRerun={onRerunAgent}
            />
          ))}
        </div>
      )}

      {/* Final output */}
      {session.finalOutput && (
        <div className="glass-card p-5 border-conductor-success/30 glow-success">
          <div className="flex items-center gap-2 mb-3">
            <svg className="w-5 h-5 text-conductor-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <h3 className="text-sm font-bold text-conductor-success">最終出力</h3>
          </div>
          <div className="bg-white/5 rounded-lg p-4 text-sm text-white/80 leading-relaxed max-h-64 overflow-y-auto font-mono whitespace-pre-wrap">
            {session.finalOutput}
          </div>
        </div>
      )}
    </div>
  )
}

function WaveIndicator({ index, total }: { index: number; total: number }) {
  const progress = total > 1 ? index / (total - 1) : 1
  const hue = 240 + progress * 120 // indigo → green

  return (
    <div
      className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold"
      style={{
        backgroundColor: `hsl(${hue}, 60%, 50%, 0.2)`,
        color: `hsl(${hue}, 60%, 70%)`,
      }}
    >
      {index + 1}
    </div>
  )
}

function LoadingDots() {
  return (
    <span className="flex gap-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-1 h-1 rounded-full bg-conductor-accent-light animate-pulse"
          style={{ animationDelay: `${i * 200}ms` }}
        />
      ))}
    </span>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-20 h-20 rounded-full bg-conductor-accent/10 flex items-center justify-center mb-6">
        <svg className="w-10 h-10 text-conductor-accent/50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
        </svg>
      </div>
      <h3 className="text-lg font-bold text-white/60 mb-2">指揮台の準備完了</h3>
      <p className="text-sm text-conductor-muted max-w-md">
        プロンプトを入力してオーケストレーションを開始してください。
        <br />
        複数のAIエージェントが協調して最適な結果を生成します。
      </p>
    </div>
  )
}
