import { useEffect, useState } from 'react'

interface Stats {
  total_notes: number
  by_type: Record<string, number>
  total_edges: number
}

interface NoteSummary {
  id: string
  title: string | null
  type: string | null
  tags: string[]
  updated: string | null
}

interface Hub {
  id: string
  label: string
  type: string | null
  val: number
}

interface SidebarProps {
  activeTypes: Set<string>
  activeTags: Set<string>
  onToggleType: (type: string) => void
  onToggleTag: (tag: string) => void
  searchQuery: string
  onSearchChange: (query: string) => void
  is3D: boolean
  onToggle3D: () => void
  focusedId: string | null
  onSelectHub: (id: string) => void
}

function FilterRow({
  label,
  count,
  active,
  onClick,
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={`w-full flex justify-between items-baseline bg-transparent border-none p-0 cursor-pointer text-left ${
          active ? 'text-accent font-semibold' : 'text-text'
        }`}
      >
        <span>{label}</span>
        <span className={active ? 'text-accent' : 'text-text-dim'}>{count}</span>
      </button>
    </li>
  )
}

function Sidebar({
  activeTypes,
  activeTags,
  onToggleType,
  onToggleTag,
  searchQuery,
  onSearchChange,
  is3D,
  onToggle3D,
  focusedId,
  onSelectHub,
}: SidebarProps) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [tagCounts, setTagCounts] = useState<[string, number][]>([])
  const [hubs, setHubs] = useState<Hub[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/stats')
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        return res.json()
      })
      .then(setStats)
      .catch((err) => setError(String(err)))
  }, [])

  // /api/stats has no tag breakdown — derive it from the notes list, which
  // already carries each note's tags for free.
  useEffect(() => {
    fetch('/api/notes')
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        return res.json()
      })
      .then((json: { notes: NoteSummary[] }) => {
        const counts = new Map<string, number>()
        for (const note of json.notes) {
          for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
        }
        setTagCounts([...counts.entries()].sort((a, b) => b[1] - a[1]))
      })
      .catch(() => {
        // Tag filters are supplementary — a failed fetch here shouldn't
        // block the rest of the sidebar.
      })
  }, [])

  useEffect(() => {
    fetch('/api/graph/hubs?limit=10')
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        return res.json()
      })
      .then((json: { hubs: Hub[] }) => setHubs(json.hubs))
      .catch(() => {
        // Supplementary, same reasoning as the tag-count fetch above.
      })
  }, [])

  return (
    <div className="space-y-4">
      <input
        type="text"
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Search notes..."
        className="w-full bg-surface border border-border rounded px-2 py-1 text-text text-sm placeholder:text-text-dim focus:outline-none focus:border-accent"
      />

      <button
        type="button"
        onClick={onToggle3D}
        className="w-full flex items-center justify-center gap-2 bg-surface border border-border rounded px-2 py-1 text-xs cursor-pointer"
      >
        <span className={is3D ? 'text-text-dim' : 'text-accent font-semibold'}>2D</span>
        <span className="text-text-dim">/</span>
        <span className={is3D ? 'text-accent font-semibold' : 'text-text-dim'}>3D</span>
      </button>

      {error && <p className="text-text-dim">Stats unavailable: {error}</p>}
      {!error && !stats && <p className="text-text-dim">Loading...</p>}

      {stats && (
        <>
          <div>
            <div className="text-text-dim uppercase tracking-wide text-xs">Notes</div>
            <div className="text-text text-lg">{stats.total_notes}</div>
          </div>

          <div>
            <div className="text-text-dim uppercase tracking-wide text-xs">
              Connections
            </div>
            <div className="text-text text-lg">{stats.total_edges}</div>
          </div>

          <div>
            <div className="text-text-dim uppercase tracking-wide text-xs mb-1">
              By type
            </div>
            <ul className="space-y-0.5">
              {Object.entries(stats.by_type)
                .sort((a, b) => b[1] - a[1])
                .map(([type, count]) => (
                  <FilterRow
                    key={type}
                    label={type}
                    count={count}
                    active={activeTypes.has(type)}
                    onClick={() => onToggleType(type)}
                  />
                ))}
            </ul>
          </div>

          {tagCounts.length > 0 && (
            <div>
              <div className="text-text-dim uppercase tracking-wide text-xs mb-1">
                By tag
              </div>
              <ul className="space-y-0.5">
                {tagCounts.map(([tag, count]) => (
                  <FilterRow
                    key={tag}
                    label={tag}
                    count={count}
                    active={activeTags.has(tag)}
                    onClick={() => onToggleTag(tag)}
                  />
                ))}
              </ul>
            </div>
          )}

          {hubs.length > 0 && (
            <div>
              <div className="text-text-dim uppercase tracking-wide text-xs mb-1">
                Top hubs
              </div>
              <ul className="space-y-0.5">
                {hubs.map((hub) => (
                  <FilterRow
                    key={hub.id}
                    label={hub.label}
                    count={hub.val}
                    active={focusedId === hub.id}
                    onClick={() => onSelectHub(hub.id)}
                  />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default Sidebar
