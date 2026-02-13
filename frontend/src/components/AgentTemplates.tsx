import { useOrchestraStore, ROLE_META } from '../stores/orchestraStore'
import type { RoleSlug } from '../types'

const TEMPLATE_ICONS: Record<string, React.ReactNode> = {
  article: (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z" />
    </svg>
  ),
  code: (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
    </svg>
  ),
  research: (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
    </svg>
  ),
}

export function AgentTemplates() {
  const { templates, loadTemplate, setViewMode } = useOrchestraStore()

  const handleLoadTemplate = (templateId: string) => {
    const template = templates.find((t) => t.id === templateId)
    if (template) {
      loadTemplate(template)
      setViewMode('builder')
    }
  }

  return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-sm font-bold text-white">テンプレートギャラリー</h3>
          <p className="text-xs text-conductor-muted mt-1">
            よく使うパイプライン構成を素早くロード
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {templates.map((template) => (
          <div
            key={template.id}
            className="glass-card p-5 hover:border-conductor-accent/30 transition-all cursor-pointer group"
            onClick={() => handleLoadTemplate(template.id)}
          >
            {/* Header */}
            <div className="flex items-start gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-conductor-accent/10 text-conductor-accent-light flex items-center justify-center group-hover:bg-conductor-accent/20 transition-colors">
                {TEMPLATE_ICONS[template.icon] ?? TEMPLATE_ICONS.code}
              </div>
              <div>
                <h4 className="text-sm font-bold text-white group-hover:text-conductor-accent-light transition-colors">
                  {template.name}
                </h4>
                <p className="text-xs text-conductor-muted mt-0.5">{template.description}</p>
              </div>
            </div>

            {/* Pipeline preview */}
            <div className="space-y-2 mb-4">
              {template.steps.map((step, i) => {
                const meta = ROLE_META[step.role as RoleSlug] ?? ROLE_META.coding
                return (
                  <div key={step.id} className="flex items-center gap-2">
                    {/* Step number */}
                    <span className="text-[9px] text-conductor-muted font-mono w-3">{i + 1}</span>

                    {/* Connector line */}
                    {i > 0 && (
                      <div className="w-2 h-px bg-conductor-border" />
                    )}

                    {/* Step pill */}
                    <div
                      className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px]"
                      style={{ backgroundColor: `${meta.color}10`, color: meta.color }}
                    >
                      <span>{meta.icon}</span>
                      <span className="font-bold">{meta.label}</span>
                      <span className="text-[9px] opacity-70">{step.provider}</span>
                    </div>

                    {/* Parallel indicator */}
                    {step.dependsOn.length === 0 && i > 0 && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-conductor-accent/10 text-conductor-accent-light">
                        並列
                      </span>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Tags */}
            <div className="flex flex-wrap gap-1.5">
              {template.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-conductor-muted"
                >
                  {tag}
                </span>
              ))}
            </div>

            {/* Load button */}
            <button
              className="w-full mt-4 py-2 rounded-lg bg-conductor-accent/10 text-conductor-accent-light text-xs font-medium hover:bg-conductor-accent/20 transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                handleLoadTemplate(template.id)
              }}
            >
              このテンプレートをロード
            </button>
          </div>
        ))}

        {/* Create new template card */}
        <div className="glass-card p-5 border-dashed flex flex-col items-center justify-center text-center min-h-[240px] hover:border-conductor-accent/30 transition-all cursor-pointer">
          <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center mb-3">
            <svg className="w-5 h-5 text-conductor-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
            </svg>
          </div>
          <h4 className="text-xs font-bold text-conductor-muted mb-1">カスタムテンプレート</h4>
          <p className="text-[10px] text-conductor-muted">
            ビルダーでパイプラインを構築し
            <br />
            テンプレートとして保存
          </p>
        </div>
      </div>

      {/* Agent strengths reference */}
      <div className="mt-8">
        <h3 className="text-xs font-bold uppercase tracking-wider text-conductor-muted mb-4">
          エージェント能力マップ
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {(Object.keys(ROLE_META) as RoleSlug[])
            .filter((r) => r !== 'leader')
            .map((role) => {
              const meta = ROLE_META[role]
              return (
                <div key={role} className="glass-card p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm">{meta.icon}</span>
                    <span className="text-xs font-bold" style={{ color: meta.color }}>
                      {meta.label}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {meta.strengths.map((s) => (
                      <span
                        key={s}
                        className="text-[9px] px-1.5 py-0.5 rounded bg-white/5 text-conductor-muted"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              )
            })}
        </div>
      </div>
    </div>
  )
}
