import { useState, useRef } from 'react'
import { useOrchestraStore, ROLE_META } from '../stores/orchestraStore'
import type { PipelineStep, RoleSlug } from '../types'

const AVAILABLE_PROVIDERS = [
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'Claude', roles: ['coding', 'writing', 'review'] },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'Claude', roles: ['coding', 'writing', 'review', 'planning'] },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'Gemini', roles: ['planning', 'coding', 'writing'] },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'Gemini', roles: ['planning', 'writing'] },
  { id: 'gpt-4.1', name: 'GPT-4.1', provider: 'GPT', roles: ['coding', 'review', 'writing'] },
  { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', provider: 'GPT', roles: ['coding', 'review'] },
  { id: 'sonar-pro', name: 'Perplexity Sonar Pro', provider: 'Perplexity', roles: ['search'] },
  { id: 'sonar-deep-research', name: 'Perplexity Deep Research', provider: 'Perplexity', roles: ['search'] },
  { id: 'grok-4.1-fast', name: 'Grok 4.1 Fast', provider: 'Grok', roles: ['coding', 'writing'] },
  { id: 'deepseek-r1', name: 'DeepSeek R1', provider: 'DeepSeek', roles: ['coding', 'planning'] },
  { id: 'gpt-image-1', name: 'GPT Image 1', provider: 'GPT', roles: ['image'] },
  { id: 'dall-e-3', name: 'DALL-E 3', provider: 'GPT', roles: ['image'] },
  { id: 'imagen-3', name: 'Imagen 3', provider: 'Gemini', roles: ['image'] },
]

export function PipelineBuilder() {
  const { pipelineSteps, addPipelineStep, removePipelineStep, reorderPipelineSteps, clearPipeline, loadTemplate, templates } = useOrchestraStore()
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const stepCounter = useRef(pipelineSteps.length)

  const handleAddStep = (role: RoleSlug, modelId: string) => {
    const provider = AVAILABLE_PROVIDERS.find((p) => p.id === modelId)
    if (!provider) return

    stepCounter.current++
    const step: PipelineStep = {
      id: `step-${stepCounter.current}`,
      role,
      provider: provider.provider,
      modelId,
      dependsOn: pipelineSteps.length > 0 ? [pipelineSteps[pipelineSteps.length - 1].id] : [],
    }
    addPipelineStep(step)
  }

  const handleDragStart = (index: number) => setDragIndex(index)
  const handleDragOver = (index: number) => setDropIndex(index)
  const handleDragEnd = () => {
    if (dragIndex !== null && dropIndex !== null && dragIndex !== dropIndex) {
      reorderPipelineSteps(dragIndex, dropIndex)
    }
    setDragIndex(null)
    setDropIndex(null)
  }

  return (
    <div className="flex gap-6 h-full animate-fade-in">
      {/* Left panel: Available models */}
      <div className="w-72 flex-shrink-0">
        <div className="glass-card p-4 h-full">
          <h3 className="text-xs font-bold uppercase tracking-wider text-conductor-muted mb-4">
            利用可能モデル
          </h3>

          {/* Role filter sections */}
          {(Object.keys(ROLE_META) as RoleSlug[])
            .filter((r) => r !== 'leader')
            .map((role) => {
              const meta = ROLE_META[role]
              const roleProviders = AVAILABLE_PROVIDERS.filter((p) => p.roles.includes(role))

              return (
                <div key={role} className="mb-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm">{meta.icon}</span>
                    <span
                      className="text-[10px] font-bold uppercase tracking-wider"
                      style={{ color: meta.color }}
                    >
                      {meta.label}
                    </span>
                  </div>
                  <div className="space-y-1">
                    {roleProviders.map((p) => (
                      <button
                        key={`${role}-${p.id}`}
                        onClick={() => handleAddStep(role, p.id)}
                        className="w-full flex items-center gap-2 p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors text-left group"
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData('role', role)
                          e.dataTransfer.setData('modelId', p.id)
                        }}
                      >
                        <div
                          className="w-1 h-6 rounded-full"
                          style={{ backgroundColor: meta.color }}
                        />
                        <div className="flex-1 min-w-0">
                          <span className="text-xs text-white/80 truncate block">{p.name}</span>
                          <span className="text-[10px] text-conductor-muted">{p.provider}</span>
                        </div>
                        <svg
                          className="w-3.5 h-3.5 text-conductor-muted opacity-0 group-hover:opacity-100 transition-opacity"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                        </svg>
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
        </div>
      </div>

      {/* Right panel: Pipeline */}
      <div className="flex-1">
        <div className="glass-card p-4 h-full">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-conductor-muted">
              パイプライン構築
            </h3>
            <div className="flex gap-2">
              {/* Template buttons */}
              <div className="relative group">
                <button className="text-[10px] px-2 py-1 rounded bg-conductor-accent/10 text-conductor-accent-light hover:bg-conductor-accent/20 transition-colors">
                  テンプレート
                </button>
                <div className="absolute right-0 top-full mt-1 w-56 glass-card p-2 hidden group-hover:block z-10">
                  {templates.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => loadTemplate(t)}
                      className="w-full text-left p-2 rounded hover:bg-white/5 transition-colors"
                    >
                      <span className="text-xs text-white/90 block">{t.name}</span>
                      <span className="text-[10px] text-conductor-muted block">{t.description}</span>
                      <div className="flex gap-1 mt-1">
                        {t.tags.map((tag) => (
                          <span key={tag} className="text-[9px] px-1 py-0.5 rounded bg-white/5 text-conductor-muted">
                            {tag}
                          </span>
                        ))}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
              <button
                onClick={clearPipeline}
                className="text-[10px] px-2 py-1 rounded bg-white/5 text-conductor-muted hover:bg-white/10 transition-colors"
              >
                クリア
              </button>
            </div>
          </div>

          {/* Pipeline flow */}
          {pipelineSteps.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center h-64 border-2 border-dashed border-conductor-border rounded-xl text-center"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                const role = e.dataTransfer.getData('role') as RoleSlug
                const modelId = e.dataTransfer.getData('modelId')
                if (role && modelId) handleAddStep(role, modelId)
              }}
            >
              <svg className="w-8 h-8 text-conductor-muted/50 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
              </svg>
              <p className="text-xs text-conductor-muted">
                左からモデルをドラッグ&ドロップ
                <br />
                またはクリックで追加
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {/* User Prompt (fixed start) */}
              <div className="flex items-center gap-3 p-3 rounded-lg bg-conductor-accent/5 border border-conductor-accent/20">
                <div className="w-8 h-8 rounded-lg bg-conductor-accent/20 flex items-center justify-center">
                  <svg className="w-4 h-4 text-conductor-accent-light" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                </div>
                <div>
                  <span className="text-xs font-bold text-conductor-accent-light">User Prompt</span>
                  <span className="text-[10px] text-conductor-muted block">入力テキスト</span>
                </div>
              </div>

              <FlowConnector />

              {/* Pipeline steps */}
              {pipelineSteps.map((step, index) => {
                const meta = ROLE_META[step.role]
                return (
                  <div key={step.id}>
                    <div
                      className={`
                        flex items-center gap-3 p-3 rounded-lg bg-white/5 border border-conductor-border
                        cursor-grab active:cursor-grabbing transition-all
                        ${dragIndex === index ? 'opacity-50' : ''}
                        ${dropIndex === index ? 'border-conductor-accent bg-conductor-accent/5' : ''}
                      `}
                      draggable
                      onDragStart={() => handleDragStart(index)}
                      onDragOver={(e) => {
                        e.preventDefault()
                        handleDragOver(index)
                      }}
                      onDragEnd={handleDragEnd}
                    >
                      <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-sm"
                        style={{ backgroundColor: `${meta.color}20` }}
                      >
                        {meta.icon}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className="text-[10px] font-bold uppercase"
                            style={{ color: meta.color }}
                          >
                            {meta.label}
                          </span>
                          <span className="text-xs text-white/80">{step.provider}</span>
                        </div>
                        <span className="text-[10px] text-conductor-muted">{step.modelId}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        {/* Drag handle */}
                        <div className="text-conductor-muted/50 cursor-grab">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8h16M4 16h16" />
                          </svg>
                        </div>
                        {/* Remove button */}
                        <button
                          onClick={() => removePipelineStep(step.id)}
                          className="p-1 rounded hover:bg-white/10 text-conductor-muted hover:text-conductor-error transition-colors"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    </div>
                    {index < pipelineSteps.length - 1 && <FlowConnector />}
                  </div>
                )
              })}

              <FlowConnector />

              {/* Final Synthesizer (fixed end) */}
              <div className="flex items-center gap-3 p-3 rounded-lg bg-conductor-success/5 border border-conductor-success/20">
                <div className="w-8 h-8 rounded-lg bg-conductor-success/20 flex items-center justify-center">
                  <svg className="w-4 h-4 text-conductor-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div>
                  <span className="text-xs font-bold text-conductor-success">Final Synthesizer</span>
                  <span className="text-[10px] text-conductor-muted block">最終統合 & 出力</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function FlowConnector() {
  return (
    <div className="flex justify-center py-1">
      <svg width="16" height="20" viewBox="0 0 16 20" className="text-conductor-border">
        <line x1="8" y1="0" x2="8" y2="14" stroke="currentColor" strokeWidth="1.5" className="flow-connector" />
        <polygon points="4,14 8,20 12,14" fill="currentColor" />
      </svg>
    </div>
  )
}
