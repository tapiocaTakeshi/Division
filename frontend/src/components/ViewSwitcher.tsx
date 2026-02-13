import { useOrchestraStore } from '../stores/orchestraStore'
import type { ViewMode } from '../types'

const VIEWS: { mode: ViewMode; label: string; icon: React.ReactNode }[] = [
  {
    mode: 'pipeline',
    label: 'パイプライン',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 12h16M4 18h16" />
      </svg>
    ),
  },
  {
    mode: 'conductor',
    label: '指揮者モード',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        <circle cx="12" cy="12" r="3" fill="currentColor" />
      </svg>
    ),
  },
  {
    mode: 'builder',
    label: 'ビルダー',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
      </svg>
    ),
  },
  {
    mode: 'templates',
    label: 'テンプレート',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
      </svg>
    ),
  },
]

export function ViewSwitcher() {
  const { viewMode, setViewMode } = useOrchestraStore()

  return (
    <div className="flex gap-1 bg-conductor-surface rounded-xl p-1">
      {VIEWS.map(({ mode, label, icon }) => (
        <button
          key={mode}
          onClick={() => setViewMode(mode)}
          className={`
            flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all
            ${viewMode === mode
              ? 'bg-conductor-accent/20 text-conductor-accent-light'
              : 'text-conductor-muted hover:text-white/70 hover:bg-white/5'
            }
          `}
        >
          {icon}
          <span className="hidden sm:inline">{label}</span>
        </button>
      ))}
    </div>
  )
}
