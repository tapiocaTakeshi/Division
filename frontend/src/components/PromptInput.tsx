import { useState, useRef, useEffect } from 'react'

interface PromptInputProps {
  onSubmit: (input: string) => void
  isRunning: boolean
  onStop: () => void
}

export function PromptInput({ onSubmit, isRunning, onStop }: PromptInputProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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
    </div>
  )
}
