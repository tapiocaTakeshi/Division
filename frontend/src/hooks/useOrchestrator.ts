import { useCallback, useRef } from 'react'
import { useOrchestraStore } from '../stores/orchestraStore'
import type { AgentNode, RoleSlug } from '../types'

const API_BASE = '/api'

export function useOrchestrator() {
  const store = useOrchestraStore()
  const abortRef = useRef<AbortController | null>(null)

  const runOrchestration = useCallback(
    async (input: string, projectId = 'demo-project-001', overrides?: Record<string, string>) => {
      abortRef.current?.abort()
      const abort = new AbortController()
      abortRef.current = abort

      store.resetSession()

      try {
        const res = await fetch(`${API_BASE}/agent/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, input, overrides }),
          signal: abort.signal,
        })

        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        if (!res.body) throw new Error('No response body')

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const raw = line.slice(6).trim()
            if (!raw || raw === '[DONE]') continue

            try {
              const event = JSON.parse(raw)
              handleSSEEvent(event, store)
            } catch {
              // skip malformed JSON
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          store.failSession((err as Error).message)
        }
      }
    },
    [store]
  )

  const stopOrchestration = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const rerunAgent = useCallback(
    async (agentId: string, newProvider?: string) => {
      const agent = store.session?.agents.find((a) => a.id === agentId)
      if (!agent || !store.session) return

      store.updateAgentStatus(agentId, 'running')

      try {
        const res = await fetch(`${API_BASE}/tasks/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: store.session.projectId,
            role: agent.role,
            input: agent.output ? `Re-execute: ${agent.label}` : agent.label,
            providerId: newProvider ?? agent.modelId,
          }),
        })

        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const result = await res.json()

        store.updateAgentStatus(agentId, 'success', {
          output: result.output,
          durationMs: result.durationMs,
          provider: newProvider ?? agent.provider,
        })
      } catch {
        store.updateAgentStatus(agentId, 'error')
      }
    },
    [store]
  )

  return { runOrchestration, stopOrchestration, rerunAgent, isRunning: store.isRunning }
}

function handleSSEEvent(
  event: { type: string; [key: string]: unknown },
  store: ReturnType<typeof useOrchestraStore.getState> & ReturnType<typeof useOrchestraStore>
) {
  switch (event.type) {
    case 'session_start':
      store.startSession(
        event.sessionId as string,
        (event.projectId as string) ?? '',
        event.input as string
      )
      break

    case 'leader_done': {
      store.setLeaderOutput(event.output as string)
      const tasks = event.tasks as Array<{
        id: string
        role: string
        title: string
        provider?: string
        modelId?: string
        dependsOn?: string[]
        mode?: string
      }>
      if (tasks) {
        const agents: AgentNode[] = tasks.map((t) => ({
          id: t.id,
          role: t.role as RoleSlug,
          label: t.title,
          provider: t.provider ?? 'Unknown',
          modelId: t.modelId ?? '',
          status: 'idle',
          dependsOn: t.dependsOn ?? [],
          mode: t.mode,
        }))
        store.addAgents(agents)
      }
      break
    }

    case 'wave_start': {
      const taskIds = event.taskIds as string[]
      const waveIndex = event.waveIndex as number
      store.setWaves([
        ...(useOrchestraStore.getState().session?.waves ?? []),
        { waveIndex, taskIds },
      ])
      taskIds.forEach((id) => store.updateAgentStatus(id, 'running'))
      break
    }

    case 'leader_chunk': {
      const chunkText = event.text as string
      const currentLeader = useOrchestraStore.getState().session?.leaderOutput ?? ''
      store.setLeaderOutput(currentLeader + chunkText)
      break
    }

    case 'task_start':
      store.updateAgentStatus(event.taskId as string, 'running', {
        provider: event.provider as string,
        mode: event.mode as string,
      })
      break

    case 'task_chunk': {
      const agentId = event.taskId as string
      const chunkText = event.text as string
      const currentAgent = useOrchestraStore.getState().session?.agents.find((a) => a.id === agentId)
      store.updateAgentStatus(agentId, 'running', {
        output: (currentAgent?.output ?? '') + chunkText,
      })
      break
    }

    case 'task_thinking_chunk': {
      const agentId = event.taskId as string
      const thinkingText = event.text as string
      const current = useOrchestraStore.getState().session?.agents.find((a) => a.id === agentId)
      store.updateAgentStatus(agentId, 'running', {
        thinking: (current?.thinking ?? '') + thinkingText,
      })
      break
    }

    case 'task_done':
      store.updateAgentStatus(event.taskId as string, 'success', {
        output: event.output as string,
        durationMs: event.durationMs as number,
        tokenCount: event.tokenCount as number | undefined,
        thinking: event.thinking as string | undefined,
        citations: event.citations as string[] | undefined,
      })
      break

    case 'task_error':
      store.updateAgentStatus(event.taskId as string, 'error', {
        output: event.error as string,
      })
      break

    case 'session_done':
      store.completeSession(
        event.finalOutput as string,
        event.totalDurationMs as number
      )
      break
  }
}
