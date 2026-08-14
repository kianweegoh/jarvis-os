import { useEffect, useState } from 'react'
import type { AgentHudState } from './agentEvents'

interface AgentHudProps {
  hud: AgentHudState
}

// Header strip for the right rail, sitting above ChatPanel in the same
// aside — not a separate view. The HUD is only ever describing the turn
// currently visible in the chat below it, so splitting them into different
// panes would just force you to look in two places to read one thing.
function AgentHud({ hud }: AgentHudProps) {
  const [model, setModel] = useState<string | null>(null)

  // Static config, not per-turn state — fetched once here rather than
  // routed through Layout's event plumbing, same self-contained pattern
  // Sidebar already uses for its own independent /api/* fetches.
  useEffect(() => {
    fetch('/api/agent/info')
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        return res.json()
      })
      .then((json: { model: string }) => setModel(json.model))
      .catch(() => {
        // Model badge is supplementary — a failed fetch shouldn't block the
        // rest of the HUD or the chat panel beneath it.
      })
  }, [])

  const toolNames = Object.values(hud.openTools)
  const usingTool = toolNames.length > 0
  const label = usingTool
    ? `Using tool: ${toolNames.join(', ')}`
    : hud.phase === 'thinking'
      ? 'Thinking…'
      : 'Idle'
  const active = usingTool || hud.phase === 'thinking'

  return (
    <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs uppercase tracking-wide">
      <div className="flex items-center gap-2">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            active ? 'animate-pulse bg-accent' : 'bg-text-dim'
          }`}
        />
        <span className={active ? 'text-accent' : 'text-text-dim'}>{label}</span>
      </div>
      {model && (
        <span className="rounded border border-border px-1.5 py-0.5 text-[10px] normal-case text-text-dim">
          {model}
        </span>
      )}
    </div>
  )
}

export default AgentHud
