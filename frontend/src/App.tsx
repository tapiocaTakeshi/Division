import { useState } from 'react'
import { useOrchestraStore } from './stores/orchestraStore'
import { useOrchestrator } from './hooks/useOrchestrator'
import { useAuth } from './hooks/useAuth'
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
  const { user, loading, signInWithGoogle, signOut } = useAuth()
  const [showThoughtTree, setShowThoughtTree] = useState(false)

  const handleSubmit = (input: string) => {
    runOrchestration(input)
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-conductor-bg flex items-center justify-center">
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-conductor-accent border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-conductor-muted">Loading...</span>
        </div>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-conductor-bg flex items-center justify-center">
        <div className="glass-card p-8 max-w-sm w-full text-center">
          <div className="w-12 h-12 rounded-xl bg-conductor-accent/20 flex items-center justify-center mx-auto mb-4">
            <svg className="w-7 h-7 text-conductor-accent-light" viewBox="0 0 64 64" fill="none">
              <circle cx="32" cy="20" r="4" fill="currentColor" />
              <circle cx="18" cy="40" r="3" fill="#22c55e" />
              <circle cx="32" cy="44" r="3" fill="#f59e0b" />
              <circle cx="46" cy="40" r="3" fill="currentColor" />
              <line x1="32" y1="24" x2="18" y2="37" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" />
              <line x1="32" y1="24" x2="32" y2="41" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" />
              <line x1="32" y1="24" x2="46" y2="37" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" />
            </svg>
          </div>
          <h1 className="text-lg font-bold text-white mb-1">Division Conductor</h1>
          <p className="text-xs text-conductor-muted mb-6">Multi-Agent Orchestration UI</p>
          <button
            onClick={signInWithGoogle}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-white text-gray-800 text-sm font-medium hover:bg-gray-100 transition-colors"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
            </svg>
            Googleでサインイン
          </button>
        </div>
      </div>
    )
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

            {/* User menu */}
            <div className="flex items-center gap-2">
              {user.user_metadata?.avatar_url && (
                <img
                  src={user.user_metadata.avatar_url}
                  alt=""
                  className="w-6 h-6 rounded-full"
                />
              )}
              <span className="text-xs text-conductor-muted hidden sm:block">
                {user.user_metadata?.full_name || user.email}
              </span>
              <button
                onClick={signOut}
                className="text-[10px] px-2 py-1 rounded bg-white/5 text-conductor-muted hover:bg-white/10 hover:text-white/70 transition-colors"
              >
                ログアウト
              </button>
            </div>
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
