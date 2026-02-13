import { useState } from 'react'
import { useOrchestraStore } from './stores/orchestraStore'
import { useOrchestrator } from './hooks/useOrchestrator'
import { ConductorView } from './components/ConductorView'
import { ConductorMode } from './components/ConductorMode'
import { PipelineBuilder } from './components/PipelineBuilder'
import { ThoughtTree } from './components/ThoughtTree'
import { AgentTemplates } from './components/AgentTemplates'
import { MetaDashboard } from './components/MetaDashboard'
import { PromptInput } from './components/PromptInput'
import { ViewSwitcher } from './components/ViewSwitcher'

export default function App() {
  const { viewMode, session } = useOrchestraStore()
  const { runOrchestration, stopOrchestration, rerunAgent, isRunning } = useOrchestrator()
  const [showThoughtTree, setShowThoughtTree] = useState(false)

  const handleSubmit = (input: string) => {
    runOrchestration(input)
  }

  return (
    <div className="min-h-screen bg-conductor-bg flex flex-col">
      {/* Header */}
      <header className="border-b border-conductor-border bg-conductor-surface/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-conductor-accent/20 flex items-center justify-center">
              <svg className="w-5 h-5 text-conductor-accent-light" viewBox="0 0 64 64" fill="none">
                <circle cx="32" cy="20" r="4" fill="currentColor" />
                <circle cx="18" cy="40" r="3" fill="#22c55e" />
                <circle cx="32" cy="44" r="3" fill="#f59e0b" />
                <circle cx="46" cy="40" r="3" fill="currentColor" />
                <line x1="32" y1="24" x2="18" y2="37" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" />
                <line x1="32" y1="24" x2="32" y2="41" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" />
                <line x1="32" y1="24" x2="46" y2="37" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" />
              </svg>
            </div>
            <div>
              <h1 className="text-sm font-bold text-white tracking-wide">
                Division <span className="text-conductor-accent-light">Conductor</span>
              </h1>
              <p className="text-[10px] text-conductor-muted">Multi-Agent Orchestration UI</p>
            </div>
          </div>

          <ViewSwitcher />

          <div className="flex items-center gap-3">
            {/* Thought tree toggle */}
            {session && (
              <button
                onClick={() => setShowThoughtTree(!showThoughtTree)}
                className={`
                  flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all
                  ${showThoughtTree
                    ? 'bg-conductor-accent/20 text-conductor-accent-light'
                    : 'bg-white/5 text-conductor-muted hover:text-white/70'}
                `}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                </svg>
                思考ツリー
              </button>
            )}

            {/* Status indicator */}
            {isRunning && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-conductor-accent/10">
                <div className="w-2 h-2 rounded-full bg-conductor-accent animate-pulse" />
                <span className="text-xs text-conductor-accent-light font-medium">実行中</span>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-6">
        <div className="flex gap-6">
          {/* Main view */}
          <div className="flex-1 min-w-0">
            {/* Prompt input (shown on pipeline and conductor views) */}
            {(viewMode === 'pipeline' || viewMode === 'conductor') && (
              <div className="mb-6">
                <PromptInput
                  onSubmit={handleSubmit}
                  isRunning={isRunning}
                  onStop={stopOrchestration}
                />
              </div>
            )}

            {/* View content */}
            {viewMode === 'pipeline' && (
              showThoughtTree ? (
                <ThoughtTree />
              ) : (
                <ConductorView onRerunAgent={rerunAgent} />
              )
            )}
            {viewMode === 'conductor' && (
              showThoughtTree ? (
                <ThoughtTree />
              ) : (
                <ConductorMode />
              )
            )}
            {viewMode === 'builder' && <PipelineBuilder />}
            {viewMode === 'templates' && <AgentTemplates />}
          </div>

          {/* Right sidebar: Meta Dashboard */}
          {(viewMode === 'pipeline' || viewMode === 'conductor') && (
            <div className="w-72 flex-shrink-0 hidden lg:block">
              <div className="sticky top-20">
                <MetaDashboard />

                {/* Quick actions */}
                {session && session.status !== 'running' && (
                  <div className="mt-4 glass-card p-4">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-conductor-muted mb-3">
                      クイックアクション
                    </h3>
                    <div className="space-y-2">
                      <button
                        onClick={() => {
                          if (session.input) runOrchestration(session.input)
                        }}
                        className="w-full flex items-center gap-2 p-2 rounded-lg bg-conductor-accent/10 text-conductor-accent-light text-xs hover:bg-conductor-accent/20 transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        全体を再実行
                      </button>
                      <button
                        onClick={() => useOrchestraStore.getState().resetSession()}
                        className="w-full flex items-center gap-2 p-2 rounded-lg bg-white/5 text-conductor-muted text-xs hover:bg-white/10 transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                        セッションをリセット
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-conductor-border py-3 px-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between text-[10px] text-conductor-muted">
          <span>Division Conductor v0.1.0</span>
          <div className="flex items-center gap-4">
            <span>API: localhost:3000</span>
            <span>
              {session ? `Session: ${session.sessionId.slice(0, 8)}...` : 'No active session'}
            </span>
          </div>
        </div>
      </footer>
    </div>
  )
}
