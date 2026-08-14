// Shared contract between ChatPanel (the only thing that opens the
// /api/chat SSE connection) and AgentHud (which renders live agent state
// derived from the same events, Day 32). ChatPanel forwards every event it
// already parses up to Layout via this reducer's dispatch — Layout is the
// nearest common ancestor of both components, so lifting state there is the
// plain-React answer for a single producer / single consumer pair with no
// deep nesting: it's the exact same pattern this file already uses for
// `focusedId` (Sidebar's Top Hubs list driving GraphView's focus state from
// outside the graph component). A Context or an external store would solve
// a problem this codebase doesn't have yet — one pair of siblings, one
// direction of data flow, no dependency already in package.json for it.

// Mirrors the wire contract documented in server/agent.py's stream().
export type AgentEvent =
  | { type: 'status'; state: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_end'; id: string; name?: string; is_error: boolean }
  | { type: 'token'; text: string }
  | { type: 'done'; message: string }
  // Client-side only, not part of the server's SSE contract: ChatPanel
  // dispatches this when the stream errors or stalls out (Day 31's
  // stall-timeout fix) so the HUD doesn't stay stuck mid-turn when no real
  // "done" event is ever coming.
  | { type: 'stream_error' }

export interface AgentHudState {
  phase: 'idle' | 'thinking'
  // tool_use id -> tool name — same shape as agent.py's own
  // `open_tool_calls` bookkeeping. tool_start adds an entry, the matching
  // tool_end removes it; unopened until Week 7 gives the agent real tools,
  // but the wiring is exercised by every status/done event today regardless.
  openTools: Record<string, string>
}

export const initialAgentHudState: AgentHudState = { phase: 'idle', openTools: {} }

export function agentHudReducer(state: AgentHudState, event: AgentEvent): AgentHudState {
  switch (event.type) {
    case 'status':
      return event.state === 'thinking' ? { ...state, phase: 'thinking' } : state
    case 'tool_start':
      return { ...state, openTools: { ...state.openTools, [event.id]: event.name } }
    case 'tool_end': {
      if (!(event.id in state.openTools)) return state
      const openTools = { ...state.openTools }
      delete openTools[event.id]
      return { ...state, openTools }
    }
    case 'done':
    case 'stream_error':
      return initialAgentHudState
    default:
      // 'token' deltas don't change HUD phase — the agent is still
      // "thinking" for HUD purposes while it writes out its answer.
      return state
  }
}
