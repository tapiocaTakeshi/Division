import { useState, useRef, useEffect } from 'react'
import { useOrchestraStore } from '../stores/orchestraStore'

interface PromptInputProps {
  onSubmit: (input: string) => void
  isRunning: boolean
  onStop: () => void
}

// フォルダ選択で自動収集するときに除外するディレクトリ / ファイル。
// mcp-server/src/index.ts の collectWorkspaceSnapshot と揃えている。
const SNAPSHOT_IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt',
  '.turbo', '.cache', 'coverage', 'target', 'vendor', '__pycache__', '.venv', 'venv',
])
const SNAPSHOT_SKIP_FILENAME_RE = /^\.env(\..*)?$|\.(pem|key|p12|pfx)$/i
const SNAPSHOT_SKIP_EXTENSION_RE =
  /\.(png|jpe?g|gif|webp|svg|ico|bmp|pdf|zip|tar|gz|7z|rar|mp4|mp3|wav|mov|avi|woff2?|ttf|eot|otf|wasm|db|sqlite3?|lock)$/i
const SNAPSHOT_MAX_FILE_CHARS = 60_000
const SNAPSHOT_MAX_TOTAL_CHARS = 400_000
const SNAPSHOT_MAX_FILE_BYTES = 500_000

interface FileWithRelativePath extends File {
  webkitRelativePath: string
}

export function PromptInput({ onSubmit, isRunning, onStop }: PromptInputProps) {
  const [value, setValue] = useState('')
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const [snapshotName, setSnapshotName] = useState<string | null>(null)
  const [isCollectingFolder, setIsCollectingFolder] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const localWorkspaceContext = useOrchestraStore((s) => s.localWorkspaceContext)
  const setLocalWorkspaceContext = useOrchestraStore((s) => s.setLocalWorkspaceContext)
  const clearLocalWorkspaceContext = useOrchestraStore((s) => s.clearLocalWorkspaceContext)
  const workspacePath = useOrchestraStore((s) => s.workspacePath)
  const setWorkspacePath = useOrchestraStore((s) => s.setWorkspacePath)

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`
    }
  }, [value])

  // React の JSX には無い non-standard 属性なので DOM に直接立てる
  useEffect(() => {
    if (folderRef.current) {
      folderRef.current.setAttribute('webkitdirectory', '')
      folderRef.current.setAttribute('directory', '')
    }
  }, [])

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

  // 本番API利用時、サーバーはユーザーのディスクを読めないため、既存プロジェクトを
  // coder / file-searcher に渡す唯一の手段はこのブラウザ側スナップショット収集になる。
  // フォルダを選んでもらい、ファイルを直接読んで1つの Markdown スナップショットに束ねる。
  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []) as FileWithRelativePath[]
    e.target.value = ''
    if (!files.length) return

    setSnapshotError(null)
    setIsCollectingFolder(true)

    try {
      const parts: string[] = []
      let totalChars = 0
      let includedCount = 0
      let truncated = false

      for (const file of files) {
        if (truncated) break
        const rel = file.webkitRelativePath || file.name
        const segments = rel.split('/')
        if (segments.some((seg) => SNAPSHOT_IGNORE_DIRS.has(seg))) continue
        const basename = segments[segments.length - 1]
        if (SNAPSHOT_SKIP_FILENAME_RE.test(basename) || SNAPSHOT_SKIP_EXTENSION_RE.test(basename)) continue
        if (file.size > SNAPSHOT_MAX_FILE_BYTES) continue

        let content: string
        try {
          content = await file.text()
        } catch {
          continue
        }
        if (content.includes(String.fromCharCode(0))) continue // バイナリ判定

        if (content.length > SNAPSHOT_MAX_FILE_CHARS) {
          content = content.slice(0, SNAPSHOT_MAX_FILE_CHARS) + '\n...[truncated]'
        }

        const block = `### ${rel}\n\`\`\`\n${content}\n\`\`\`\n\n`
        if (totalChars + block.length > SNAPSHOT_MAX_TOTAL_CHARS) {
          truncated = true
          break
        }
        parts.push(block)
        totalChars += block.length
        includedCount++
      }

      if (!includedCount) {
        setSnapshotError('選択したフォルダから読み込めるテキストファイルが見つかりませんでした')
        return
      }

      const header = '# ローカルワークスペーススナップショット（ブラウザがローカルで収集）\n\n'
      const footer = truncated
        ? '\n> ...スナップショットが上限に達したため、以降のファイルは省略されました。\n'
        : ''
      setLocalWorkspaceContext(header + parts.join('') + footer)
      setSnapshotName(`フォルダ（${includedCount}ファイル）`)
    } finally {
      setIsCollectingFolder(false)
    }
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
        <input
          ref={folderRef}
          type="file"
          multiple
          tabIndex={-1}
          className="sr-only"
          onChange={handleFolderSelect}
        />
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-conductor-muted">
          <button
            type="button"
            disabled={isRunning || isCollectingFolder}
            onClick={() => folderRef.current?.click()}
            className="px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-white/70 disabled:opacity-40 transition-colors"
          >
            {isCollectingFolder ? '読み込み中...' : 'プロジェクトフォルダを選択'}
          </button>
          <button
            type="button"
            disabled={isRunning}
            onClick={() => fileRef.current?.click()}
            className="px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-white/70 disabled:opacity-40 transition-colors"
          >
            スナップショット（1ファイル）
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
        <div className="flex items-center gap-2 text-[10px] text-conductor-muted">
          <span className="text-white/50 whitespace-nowrap">ワークスペースパス</span>
          <input
            type="text"
            value={workspacePath}
            onChange={(e) => setWorkspacePath(e.target.value)}
            disabled={isRunning}
            placeholder="/Users/you/project（Division API をローカル起動している場合のみ有効。本番APIでは「プロジェクトフォルダを選択」を使ってください）"
            className="flex-1 min-w-0 bg-white/5 rounded-lg px-2 py-1 text-white/70 placeholder-white/30 outline-none disabled:opacity-40"
          />
        </div>
      </div>
    </div>
  )
}
