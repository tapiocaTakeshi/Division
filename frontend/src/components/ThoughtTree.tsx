import { useState } from 'react'
import { useOrchestraStore, ROLE_META } from '../stores/orchestraStore'
import type { AgentNode, RoleSlug } from '../types'

export function ThoughtTree() {
  const { session } = useOrchestraStore()
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())

  if (!session) {
    return (
      <div className="flex items-center justify-center h-64 text-conductor-muted text-sm">
        思考ツリーはオーケストレーション完了後に表示されます
      </div>
    )
  }

  const toggleNode = (id: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const expandAll = () => {
    const all = new Set<string>(['leader', ...session.agents.map((a) => a.id)])
    setExpandedNodes(all)
  }

  const collapseAll = () => setExpandedNodes(new Set())

  // Build dependency tree
  const rootAgents = session.agents.filter((a) => a.dependsOn.length === 0)
  const getChildren = (parentId: string) =>
    session.agents.filter((a) => a.dependsOn.includes(parentId))

  return (
    <div className="animate-fade-in">
      {/* Controls */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-bold uppercase tracking-wider text-conductor-muted">
          思考プロセスツリー
        </h3>
        <div className="flex gap-2">
          <button
            onClick={expandAll}
            className="text-[10px] px-2 py-1 rounded bg-white/5 text-conductor-muted hover:bg-white/10 transition-colors"
          >
            すべて展開
          </button>
          <button
            onClick={collapseAll}
            className="text-[10px] px-2 py-1 rounded bg-white/5 text-conductor-muted hover:bg-white/10 transition-colors"
          >
            すべて折りたたむ
          </button>
        </div>
      </div>

      {/* Tree */}
      <div className="space-y-1">
        {/* Leader node */}
        <TreeNode
          icon={ROLE_META.leader.icon}
          label="Leader - タスク分解"
          color={ROLE_META.leader.color}
          status={session.leaderOutput ? 'success' : session.status === 'running' ? 'running' : 'idle'}
          content={session.leaderOutput}
          isExpanded={expandedNodes.has('leader')}
          onToggle={() => toggleNode('leader')}
          depth={0}
        />

        {/* Root-level agents */}
        {rootAgents.map((agent) => (
          <AgentTreeBranch
            key={agent.id}
            agent={agent}
            allAgents={session.agents}
            getChildren={getChildren}
            expandedNodes={expandedNodes}
            onToggle={toggleNode}
            depth={1}
          />
        ))}

        {/* Final synthesis */}
        {session.finalOutput && (
          <TreeNode
            icon="🎯"
            label="最終統合出力"
            color="#22c55e"
            status="success"
            content={session.finalOutput}
            isExpanded={expandedNodes.has('final')}
            onToggle={() => toggleNode('final')}
            depth={0}
          />
        )}
      </div>
    </div>
  )
}

function AgentTreeBranch({
  agent,
  allAgents,
  getChildren,
  expandedNodes,
  onToggle,
  depth,
}: {
  agent: AgentNode
  allAgents: AgentNode[]
  getChildren: (id: string) => AgentNode[]
  expandedNodes: Set<string>
  onToggle: (id: string) => void
  depth: number
}) {
  const meta = ROLE_META[agent.role as RoleSlug] ?? ROLE_META.coding
  const children = getChildren(agent.id)

  return (
    <>
      <TreeNode
        icon={meta.icon}
        label={`${meta.label} - ${agent.label}`}
        sublabel={`${agent.provider} / ${agent.modelId}`}
        color={meta.color}
        status={agent.status}
        content={agent.output}
        durationMs={agent.durationMs}
        tokenCount={agent.tokenCount}
        isExpanded={expandedNodes.has(agent.id)}
        onToggle={() => onToggle(agent.id)}
        depth={depth}
        hasChildren={children.length > 0}
      />
      {children.map((child) => (
        <AgentTreeBranch
          key={child.id}
          agent={child}
          allAgents={allAgents}
          getChildren={getChildren}
          expandedNodes={expandedNodes}
          onToggle={onToggle}
          depth={depth + 1}
        />
      ))}
    </>
  )
}

function TreeNode({
  icon,
  label,
  sublabel,
  color,
  status,
  content,
  durationMs,
  tokenCount,
  isExpanded,
  onToggle,
  depth,
  hasChildren,
}: {
  icon: string
  label: string
  sublabel?: string
  color: string
  status: 'idle' | 'running' | 'success' | 'error'
  content?: string
  durationMs?: number
  tokenCount?: number
  isExpanded: boolean
  onToggle: () => void
  depth: number
  hasChildren?: boolean
}) {
  const indent = depth * 24

  return (
    <div className="animate-fade-in" style={{ marginLeft: indent }}>
      {/* Node header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 p-2 rounded-lg hover:bg-white/5 transition-colors group text-left"
      >
        {/* Tree line indicator */}
        <div className="flex items-center gap-1">
          {depth > 0 && (
            <div
              className="w-4 h-px"
              style={{ backgroundColor: `${color}40` }}
            />
          )}
          <div
            className={`w-5 h-5 rounded flex items-center justify-center text-[10px] transition-transform ${
              isExpanded ? 'rotate-90' : ''
            }`}
            style={{ backgroundColor: `${color}15` }}
          >
            {content || hasChildren ? (
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke={color}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            ) : (
              <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
            )}
          </div>
        </div>

        {/* Icon */}
        <span className="text-sm">{icon}</span>

        {/* Label */}
        <div className="flex-1 min-w-0">
          <span className="text-xs font-medium text-white/90 truncate block">{label}</span>
          {sublabel && (
            <span className="text-[10px] text-conductor-muted truncate block">{sublabel}</span>
          )}
        </div>

        {/* Status & stats */}
        <div className="flex items-center gap-2">
          {durationMs != null && (
            <span className="text-[10px] text-conductor-muted font-mono">
              {(durationMs / 1000).toFixed(1)}s
            </span>
          )}
          {tokenCount != null && (
            <span className="text-[10px] text-conductor-muted font-mono">
              {tokenCount > 1000 ? `${(tokenCount / 1000).toFixed(1)}k` : tokenCount}tok
            </span>
          )}
          <StatusDot status={status} />
        </div>
      </button>

      {/* Expanded content */}
      {isExpanded && content && (
        <div
          className="ml-8 mt-1 mb-2 p-3 rounded-lg bg-white/5 border-l-2 text-xs text-white/70 font-mono leading-relaxed max-h-48 overflow-y-auto whitespace-pre-wrap"
          style={{ borderLeftColor: color }}
        >
          {content}
        </div>
      )}
    </div>
  )
}

function StatusDot({ status }: { status: string }) {
  const styles: Record<string, string> = {
    idle: 'bg-conductor-muted/30',
    running: 'bg-conductor-accent animate-pulse',
    success: 'bg-conductor-success',
    error: 'bg-conductor-error',
  }
  return <div className={`w-2 h-2 rounded-full ${styles[status] ?? styles.idle}`} />
}
