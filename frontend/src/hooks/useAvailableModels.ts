import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RoleSlug } from '../types'

const API_BASE = '/api'

// Poll backend every 5 min so the model list stays in sync with upstream providers.
const POLL_INTERVAL_MS = 5 * 60 * 1000

export interface DiscoveredModel {
  name: string
  displayName: string
  apiBaseUrl: string
  apiType: string
  modelId: string
  description: string
}

export interface ProviderModels {
  provider: string
  apiType: string
  models: DiscoveredModel[]
  error?: string
}

interface ListModelsResponse {
  timestamp: string
  totalModels: number
  providers: ProviderModels[]
}

export interface PipelineProviderOption {
  id: string
  name: string
  provider: string
  apiType: string
  roles: RoleSlug[]
}

// Map apiType to the display label used by the pipeline builder.
const PROVIDER_DISPLAY: Record<string, string> = {
  openai: 'GPT',
  anthropic: 'Claude',
  google: 'Gemini',
  xai: 'Grok',
  deepseek: 'DeepSeek',
  mistral: 'Mistral',
  perplexity: 'Perplexity',
  cohere: 'Cohere',
  meta: 'Llama',
  qwen: 'Qwen',
  moonshot: 'Kimi',
}

// Derive which roles a given model is best suited for, based on its ID.
// The mapping is deliberately broad so newly-released models show up somewhere
// without waiting for a manual edit.
function rolesForModel(apiType: string, modelId: string): RoleSlug[] {
  const id = modelId.toLowerCase()
  const roles = new Set<RoleSlug>()

  // Image generation models
  if (/image|imagen|dall-?e|dalle|flux|stable-diffusion|sdxl/.test(id)) {
    roles.add('imager')
    return [...roles]
  }

  // Embedding / audio / moderation get filtered out upstream — defensive:
  if (/embed|whisper|tts-|moderation/.test(id)) return []

  // Search-first providers
  if (apiType === 'perplexity' || /sonar|research/.test(id)) {
    roles.add('searcher')
  }

  // Small / fast / flash / mini variants are reasonable reviewers
  const isSmall = /mini|flash|haiku|small|lite|nano/.test(id)
  // Frontier / large models good for planning & ideation
  const isLarge = /opus|ultra|pro|large|max|reasoning|r1|o1|o3|o4|deep-think|deep_think/.test(id)

  // Coding-capable defaults (most modern chat models code well)
  roles.add('coder')
  roles.add('writer')
  roles.add('reviewer')

  if (isLarge) {
    roles.add('planner')
    roles.add('ideaman')
  }
  if (isSmall) {
    roles.add('reviewer')
  }

  // Code-specialist models
  if (/code|codex|coder|codestral/.test(id)) {
    roles.add('coder')
    roles.add('reviewer')
  }

  return [...roles]
}

function toPipelineOption(apiType: string, model: DiscoveredModel): PipelineProviderOption {
  const provider = PROVIDER_DISPLAY[apiType] ?? apiType
  // Prefer the human-readable name, but strip trailing "(Provider)" suffix to avoid duplication.
  const name = model.displayName.replace(/\s*\([^)]+\)\s*$/, '').trim() || model.modelId
  return {
    id: model.modelId,
    name,
    provider,
    apiType,
    roles: rolesForModel(apiType, model.modelId),
  }
}

export interface UseAvailableModelsResult {
  options: PipelineProviderOption[]
  providers: ProviderModels[]
  loading: boolean
  error: string | null
  lastUpdatedAt: Date | null
  refresh: (force?: boolean) => Promise<void>
}

/**
 * Fetch the latest list of available models from provider APIs via the backend.
 * Auto-refreshes every {@link POLL_INTERVAL_MS} ms and when the tab regains focus.
 * Call `refresh(true)` to force a cache-bypassing re-fetch.
 */
export function useAvailableModels(): UseAvailableModelsResult {
  const [providers, setProviders] = useState<ProviderModels[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const refresh = useCallback(async (force = false) => {
    abortRef.current?.abort()
    const abort = new AbortController()
    abortRef.current = abort
    setLoading(true)
    setError(null)
    try {
      const url = force ? `${API_BASE}/models/available?refresh=1` : `${API_BASE}/models/available`
      const res = await fetch(url, { signal: abort.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as ListModelsResponse
      setProviders(data.providers ?? [])
      setLastUpdatedAt(new Date(data.timestamp ?? Date.now()))
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh(false)
    const interval = window.setInterval(() => {
      void refresh(false)
    }, POLL_INTERVAL_MS)
    const onFocus = () => {
      if (document.visibilityState === 'visible') void refresh(false)
    }
    document.addEventListener('visibilitychange', onFocus)
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onFocus)
      window.removeEventListener('focus', onFocus)
      abortRef.current?.abort()
    }
  }, [refresh])

  const options = useMemo<PipelineProviderOption[]>(() => {
    const out: PipelineProviderOption[] = []
    const seen = new Set<string>()
    for (const p of providers) {
      if (p.error) continue
      for (const m of p.models) {
        const key = `${p.apiType}:${m.modelId}`
        if (seen.has(key)) continue
        seen.add(key)
        const option = toPipelineOption(p.apiType, m)
        if (option.roles.length > 0) out.push(option)
      }
    }
    // Deterministic ordering: by provider name, then model id.
    out.sort((a, b) =>
      a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)
    )
    return out
  }, [providers])

  return { options, providers, loading, error, lastUpdatedAt, refresh }
}
