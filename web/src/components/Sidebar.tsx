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

interface SidebarProps {
  activeTypes: Set<string>
  activeTags: Set<string>
  onToggleType: (type: string) => void
  onToggleTag: (tag: string) => void
  searchQuery: string
  onSearchChange: (query: string) => void
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
}: SidebarProps) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [tagCounts, setTagCounts] = useState<[string, number][]>([])
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

  return (
    <div className="space-y-4">
      <input
        type="text"
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Search notes..."
        className="w-full bg-surface border border-border rounded px-2 py-1 text-text text-sm placeholder:text-text-dim focus:outline-none focus:border-accent"
      />

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
        </>
      )}
    </div>
  )
}

export default Sidebar
