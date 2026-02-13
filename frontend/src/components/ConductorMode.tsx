import { useOrchestraStore, ROLE_META } from '../stores/orchestraStore'
import type { AgentNode, RoleSlug } from '../types'

export function ConductorMode() {
  const { session } = useOrchestraStore()
  const agents = session?.agents ?? []

  if (agents.length === 0) {
    return (
      <div className="flex items-center justify-center h-[500px] text-conductor-muted text-sm">
        指揮者モードはオーケストレーション実行中に表示されます
      </div>
    )
  }

  const centerX = 250
  const centerY = 250
  const radius = 160
  const leaderRadius = 30

  return (
    <div className="flex flex-col items-center gap-6 animate-fade-in">
      <h3 className="text-xs font-bold uppercase tracking-wider text-conductor-muted">
        指揮者モード - 全体俯瞰
      </h3>

      <div className="relative">
        <svg width="500" height="500" viewBox="0 0 500 500">
          {/* Outer ring glow */}
          <defs>
            <radialGradient id="ring-glow" cx="50%" cy="50%" r="50%">
              <stop offset="70%" stopColor="transparent" />
              <stop offset="100%" stopColor="rgba(99, 102, 241, 0.1)" />
            </radialGradient>
            <filter id="glow">
              <feGaussianBlur stdDeviation="4" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Background ring */}
          <circle cx={centerX} cy={centerY} r={radius + 20} fill="url(#ring-glow)" />
          <circle
            cx={centerX}
            cy={centerY}
            r={radius}
            fill="none"
            stroke="rgba(42, 42, 62, 0.5)"
            strokeWidth="1"
            strokeDasharray="4 4"
          />

          {/* Connection lines from center to agents */}
          {agents.map((agent, i) => {
            const angle = (i / agents.length) * Math.PI * 2 - Math.PI / 2
            const x = centerX + Math.cos(angle) * radius
            const y = centerY + Math.sin(angle) * radius
            const color = ROLE_META[agent.role]?.color ?? '#64748b'

            return (
              <line
                key={`line-${agent.id}`}
                x1={centerX}
                y1={centerY}
                x2={x}
                y2={y}
                stroke={color}
                strokeWidth={agent.status === 'running' ? 2 : 1}
                strokeOpacity={agent.status === 'idle' ? 0.2 : 0.5}
                className={agent.status === 'running' ? 'flow-connector' : ''}
              />
            )
          })}

          {/* Dependency arcs */}
          {agents.map((agent, i) => {
            const angle = (i / agents.length) * Math.PI * 2 - Math.PI / 2
            const x1 = centerX + Math.cos(angle) * radius
            const y1 = centerY + Math.sin(angle) * radius

            return agent.dependsOn.map((depId) => {
              const depIdx = agents.findIndex((a) => a.id === depId)
              if (depIdx === -1) return null
              const depAngle = (depIdx / agents.length) * Math.PI * 2 - Math.PI / 2
              const x2 = centerX + Math.cos(depAngle) * radius
              const y2 = centerY + Math.sin(depAngle) * radius

              const midX = (x1 + x2) / 2 + (centerX - (x1 + x2) / 2) * 0.3
              const midY = (y1 + y2) / 2 + (centerY - (y1 + y2) / 2) * 0.3

              return (
                <path
                  key={`dep-${agent.id}-${depId}`}
                  d={`M ${x2} ${y2} Q ${midX} ${midY} ${x1} ${y1}`}
                  fill="none"
                  stroke="rgba(99, 102, 241, 0.2)"
                  strokeWidth="1"
                  strokeDasharray="3 3"
                />
              )
            })
          })}

          {/* Agent nodes on the ring */}
          {agents.map((agent, i) => {
            const angle = (i / agents.length) * Math.PI * 2 - Math.PI / 2
            const x = centerX + Math.cos(angle) * radius
            const y = centerY + Math.sin(angle) * radius

            return (
              <AgentOrb
                key={agent.id}
                agent={agent}
                x={x}
                y={y}
              />
            )
          })}

          {/* Center: Leader / Conductor */}
          <circle
            cx={centerX}
            cy={centerY}
            r={leaderRadius + 8}
            fill="none"
            stroke={ROLE_META.leader.color}
            strokeWidth="2"
            strokeOpacity={session?.status === 'running' ? 0.8 : 0.3}
            filter={session?.status === 'running' ? 'url(#glow)' : undefined}
          />
          <circle
            cx={centerX}
            cy={centerY}
            r={leaderRadius}
            fill={`${ROLE_META.leader.color}20`}
          />
          <text
            x={centerX}
            y={centerY - 4}
            textAnchor="middle"
            className="text-lg"
            fill="white"
          >
            {ROLE_META.leader.icon}
          </text>
          <text
            x={centerX}
            y={centerY + 16}
            textAnchor="middle"
            className="text-[9px] font-bold"
            fill={ROLE_META.leader.color}
          >
            CONDUCTOR
          </text>
        </svg>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap justify-center gap-4 text-xs">
        {(['running', 'success', 'error', 'idle'] as const).map((status) => (
          <div key={status} className="flex items-center gap-1.5">
            <div
              className={`w-3 h-3 rounded-full ${
                status === 'running' ? 'bg-conductor-accent animate-pulse' :
                status === 'success' ? 'bg-conductor-success' :
                status === 'error' ? 'bg-conductor-error' :
                'bg-conductor-muted/30'
              }`}
            />
            <span className="text-conductor-muted">
              {status === 'running' ? '実行中' : status === 'success' ? '完了' : status === 'error' ? 'エラー' : '待機'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function AgentOrb({ agent, x, y }: { agent: AgentNode; x: number; y: number }) {
  const meta = ROLE_META[agent.role as RoleSlug] ?? ROLE_META.coding
  const orbRadius = 24

  const statusColor =
    agent.status === 'running' ? meta.color :
    agent.status === 'success' ? '#22c55e' :
    agent.status === 'error' ? '#ef4444' :
    '#2a2a3e'

  return (
    <g>
      {/* Glow for running */}
      {agent.status === 'running' && (
        <circle
          cx={x}
          cy={y}
          r={orbRadius + 6}
          fill="none"
          stroke={meta.color}
          strokeWidth="2"
          strokeOpacity="0.4"
          filter="url(#glow)"
        >
          <animate
            attributeName="r"
            values={`${orbRadius + 4};${orbRadius + 8};${orbRadius + 4}`}
            dur="2s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="stroke-opacity"
            values="0.4;0.8;0.4"
            dur="2s"
            repeatCount="indefinite"
          />
        </circle>
      )}

      {/* Error blink */}
      {agent.status === 'error' && (
        <circle
          cx={x}
          cy={y}
          r={orbRadius + 4}
          fill="none"
          stroke="#ef4444"
          strokeWidth="2"
        >
          <animate
            attributeName="stroke-opacity"
            values="0.2;0.8;0.2"
            dur="1s"
            repeatCount="indefinite"
          />
        </circle>
      )}

      {/* Main orb */}
      <circle
        cx={x}
        cy={y}
        r={orbRadius}
        fill={`${statusColor}20`}
        stroke={statusColor}
        strokeWidth="1.5"
      />

      {/* Role icon */}
      <text x={x} y={y - 2} textAnchor="middle" className="text-sm" fill="white">
        {meta.icon}
      </text>

      {/* Label */}
      <text
        x={x}
        y={y + orbRadius + 14}
        textAnchor="middle"
        className="text-[9px] font-bold"
        fill={meta.color}
      >
        {meta.label}
      </text>

      {/* Provider */}
      <text
        x={x}
        y={y + orbRadius + 26}
        textAnchor="middle"
        className="text-[8px]"
        fill="#64748b"
      >
        {agent.provider}
      </text>

      {/* Duration */}
      {agent.durationMs != null && (
        <text
          x={x}
          y={y + 12}
          textAnchor="middle"
          className="text-[8px] font-mono"
          fill="#64748b"
        >
          {(agent.durationMs / 1000).toFixed(1)}s
        </text>
      )}
    </g>
  )
}
