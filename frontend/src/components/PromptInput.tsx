import { useState, useRef, useEffect } from 'react'
import { useOrchestraStore } from '../stores/orchestraStore'

interface PromptInputProps {
  onSubmit: (input: string) => void
  isRunning: boolean
  onStop: () => void
}

export function PromptInput({ onSubmit, isRunning, onStop }: PromptInputProps) {
  const [value, setValue] = useState('')
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const [snapshotName, setSnapshotName] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const localWorkspaceContext = useOrchestraStore((s) => s.localWorkspaceContext)
  const setLocalWorkspaceContext = useOrchestraStore((s) => s.setLocalWorkspaceContext)
  const clearLocalWorkspaceContext = useOrchestraStore((s) => s.clearLocalWorkspaceContext)

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`
    }
  }, [value])

  const handleSubmit = () => {
    if (!value.trim() || isRunning) return
    onSubmit(value.trim())
    setValue('')
  }

  const handleSnapshotFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    setSnapshotError(null)
    if (!file) return
    setSnapshotName(file.name)
    const reader = new FileReader()
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : ''
      setLocalWorkspaceContext(text)
      if (!text.length) {
        setSnapshotError('ファイルが空か、テキストとして読めませんでした')
      }
    }
    reader.onerror = () => {
      setSnapshotError(reader.error?.message || 'ファイルの読み込みに失敗しました')
      setLocalWorkspaceContext('')
      setSnapshotName(null)
    }
    // 第2引数: 環境差のある文字化けを減らす
    reader.readAsText(file, 'UTF-8')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div className="glass-card p-3">
      <div className="flex items-end gap-3">
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="オーケストレーションの指示を入力... (Shift+Enter で改行)"
            className="w-full bg-transparent text-sm text-white/90 placeholder-conductor-muted resize-none outline-none min-h-[40px] max-h-[120px] leading-relaxed"
            rows={1}
            disabled={isRunning}
          />
        </div>
        {isRunning ? (
          <button
            onClick={onStop}
            className="flex-shrink-0 w-10 h-10 rounded-xl bg-conductor-error/20 text-conductor-error hover:bg-conductor-error/30 transition-colors flex items-center justify-center"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="6" width="12" height="12" rx="1" />
            </svg>
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={!value.trim()}
            className="flex-shrink-0 w-10 h-10 rounded-xl bg-conductor-accent text-white hover:bg-conductor-accent-light disabled:bg-conductor-accent/30 disabled:text-white/30 transition-colors flex items-center justify-center"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
          </button>
        )}
      </div>
      <div className="mt-2 flex flex-col gap-1">
        {/*
          display:none の file input は Safari 等で input.click() が効かないことがあるため、
          画面外配置で非表示にする。
        */}
        <input
          ref={fileRef}
          type="file"
          accept=".md,.txt,.json,.markdown,text/markdown,text/plain"
          tabIndex={-1}
          className="sr-only"
          onChange={handleSnapshotFile}
        />
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-conductor-muted">
          <button
            type="button"
            disabled={isRunning}
            onClick={() => fileRef.current?.click()}
            className="px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-white/70 disabled:opacity-40 transition-colors"
          >
            ワークスペーススナップショット（テキストファイル）
          </button>
          {localWorkspaceContext ? (
            <>
              {snapshotName ? (
                <span className="text-white/50 truncate max-w-[200px]" title={snapshotName}>
                  {snapshotName}
                </span>
              ) : null}
              <span className="text-white/50">{localWorkspaceContext.length.toLocaleString()} 文字</span>
              <button
                type="button"
                disabled={isRunning}
                onClick={() => {
                  clearLocalWorkspaceContext()
                  setSnapshotName(null)
                  setSnapshotError(null)
                }}
                className="px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-white/70 disabled:opacity-40 transition-colors"
              >
                クリア
              </button>
            </>
          ) : null}
        </div>
        {snapshotError ? (
          <p className="text-[10px] text-conductor-error">{snapshotError}</p>
        ) : null}
      </div>
    </div>
  )
}
