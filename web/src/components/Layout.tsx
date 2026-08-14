import { useEffect, useReducer, useRef, useState } from 'react'
import { Outlet } from 'react-router-dom'
import AgentHud from './AgentHud'
import { agentHudReducer, initialAgentHudState } from './agentEvents'
import ChatPanel from './ChatPanel'
import Sidebar from './Sidebar'

// Shared with routed views via <Outlet context>. Named for its original
// scope (graph filters); it's since grown a Day 33 addition
// (setOpenNoteId) that isn't a filter at all, but everything here is still
// "state a routed view needs to hand up to Layout" — same contract, just
// not exclusively about filtering anymore.
export interface FilterContext {
  activeTypes: Set<string>
  activeTags: Set<string>
  // null = no search active (distinct from an empty-but-active result set).
  searchResultIds: Set<string> | null
  is3D: boolean
  // null = no node focused. Lifted here (out of GraphView's own state) so
  // the sidebar's Top Hubs list can drive the same focus mode a graph
  // double-click does, from outside the graph component entirely.
  focusedId: string | null
  setFocusedId: (id: string | null) => void
  // Day 33: NoteView calls this on mount/id-change/unmount so ChatPanel
  // always knows which note (if any) is currently open, for "summarize
  // this"-style context. Distinct from attachedNoteIds, which navigation
  // never touches.
  setOpenNoteId: (id: string | null) => void
}

const SEARCH_DEBOUNCE_MS = 300

function toggleInSet(set: Set<string>, value: string): Set<string> {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

function Layout() {
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set())
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResultIds, setSearchResultIds] = useState<Set<string> | null>(null)
  const [is3D, setIs3D] = useState(false)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  // Day 32: ChatPanel forwards every /api/chat SSE event here so AgentHud —
  // a sibling, not a child of ChatPanel — can render live agent state from
  // the same stream. See agentEvents.ts for why this is lifted state rather
  // than a Context/store.
  const [agentHud, dispatchAgentEvent] = useReducer(agentHudReducer, initialAgentHudState)
  // Day 33: context-aware chat. Two independent pieces, per spec — openNoteId
  // tracks navigation (set by NoteView via outlet context, cleared on
  // unmount); attachedNoteIds is purely user-driven via the @-mention picker
  // and is never touched by navigation. Both lifted here for the same
  // reason as agentHud above: ChatPanel and NoteView are siblings/routed
  // children, not parent/child, so Layout is the nearest place that can see
  // both.
  const [openNoteId, setOpenNoteId] = useState<string | null>(null)
  const [attachedNoteIds, setAttachedNoteIds] = useState<string[]>([])

  const attachNote = (id: string) =>
    setAttachedNoteIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
  const removeAttachedNote = (id: string) =>
    setAttachedNoteIds((prev) => prev.filter((existing) => existing !== id))

  const toggleType = (type: string) => setActiveTypes((prev) => toggleInSet(prev, type))
  const toggleTag = (tag: string) => setActiveTags((prev) => toggleInSet(prev, tag))

  // Debounced: the input itself updates every keystroke (via setSearchQuery
  // below), but the network call waits for a quiet period.
  const searchAbortRef = useRef<AbortController | null>(null)
  useEffect(() => {
    const trimmed = searchQuery.trim()
    if (!trimmed) {
      setSearchResultIds(null)
      return
    }

    const timer = window.setTimeout(() => {
      searchAbortRef.current?.abort()
      const controller = new AbortController()
      searchAbortRef.current = controller

      fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal })
        .then((res) => {
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
          return res.json()
        })
        .then((json: { results: { id: string }[] }) => {
          setSearchResultIds(new Set(json.results.map((r) => r.id)))
        })
        .catch((err) => {
          if (err.name !== 'AbortError') console.error('search failed', err)
        })
    }, SEARCH_DEBOUNCE_MS)

    return () => window.clearTimeout(timer)
  }, [searchQuery])

  return (
    <div className="grid h-screen grid-cols-[220px_1fr_320px] bg-bg text-text font-sans">
      <aside className="border-r border-border p-4 text-sm overflow-y-auto">
        <Sidebar
          activeTypes={activeTypes}
          activeTags={activeTags}
          onToggleType={toggleType}
          onToggleTag={toggleTag}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          is3D={is3D}
          onToggle3D={() => setIs3D((prev) => !prev)}
          focusedId={focusedId}
          // Same toggle rule as double-clicking a graph node: clicking the
          // already-focused hub again clears focus rather than re-setting it.
          onSelectHub={(id) => setFocusedId((current) => (current === id ? null : id))}
        />
      </aside>

      <main className="overflow-y-auto">
        <Outlet
          context={
            {
              activeTypes,
              activeTags,
              searchResultIds,
              is3D,
              focusedId,
              setFocusedId,
              setOpenNoteId,
            } satisfies FilterContext
          }
        />
      </main>

      <aside className="flex flex-col overflow-hidden border-l border-border">
        <AgentHud hud={agentHud} />
        <div className="min-h-0 flex-1">
          <ChatPanel
            onAgentEvent={dispatchAgentEvent}
            openNoteId={openNoteId}
            attachedNoteIds={attachedNoteIds}
            onAttachNote={attachNote}
            onRemoveAttachedNote={removeAttachedNote}
          />
        </div>
      </aside>
    </div>
  )
}

export default Layout
