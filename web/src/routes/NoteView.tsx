import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface NoteDetail {
  id: string
  type: string | null
  title: string | null
  tags: string[]
  status: string | null
  created: string | null
  updated: string | null
  links: string[]
  backlinks: string[]
  body: string
  path: string | null
  parse_error: string | null
}

// [[note-id]] or [[note-id|display text]] -> [display text](/note/note-id),
// so react-markdown renders a real, styled, clickable link. Also tolerates
// a #heading segment (vault.py strips the same way when it resolves links).
const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g

function transformWikilinks(body: string): string {
  return body.replace(WIKILINK_RE, (_match, id: string, alias?: string) => {
    const target = id.trim()
    const label = (alias ?? target).trim()
    return `[${label}](/note/${target})`
  })
}

// Internal /note/ links navigate in-app via React Router; anything else
// (a real external link in a note body) behaves like a normal link.
function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (href?.startsWith('/note/')) {
    return <Link to={href}>{children}</Link>
  }
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}

function Chip({ label }: { label: string }) {
  return (
    <span className="border border-border rounded px-2 py-0.5 text-xs text-text-dim font-sans uppercase tracking-wide">
      {label}
    </span>
  )
}

function NoteView() {
  const { id } = useParams()
  const [note, setNote] = useState<NoteDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setNote(null)
    setError(null)
    fetch(`/api/notes/${id}`)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        return res.json()
      })
      .then(setNote)
      .catch((err) => setError(String(err)))
  }, [id])

  return (
    <div className="max-w-3xl mx-auto px-10 py-12">
      {error && <p className="text-text-dim font-sans text-base">Note unavailable: {error}</p>}
      {!error && !note && <p className="text-text-dim font-sans text-base">Loading...</p>}

      {note && (
        <>
          <h1 className="font-serif text-3xl text-text mb-3">{note.title ?? note.id}</h1>

          <div className="flex flex-wrap gap-2 mb-8">
            {note.type && <Chip label={note.type} />}
            {note.status && <Chip label={note.status} />}
            {note.tags.map((tag) => (
              <Chip key={tag} label={tag} />
            ))}
          </div>

          <article className="markdown-body font-serif text-lg">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink }}>
              {transformWikilinks(note.body)}
            </ReactMarkdown>
          </article>

          <div className="mt-12 pt-6 border-t border-border font-sans">
            <div className="text-text-dim uppercase tracking-wide text-xs mb-2">
              Backlinks
            </div>
            {note.backlinks.length === 0 ? (
              <p className="text-text-dim text-sm">Nothing links here yet.</p>
            ) : (
              <ul className="space-y-1">
                {note.backlinks.map((backlinkId) => (
                  <li key={backlinkId}>
                    <Link to={`/note/${backlinkId}`} className="text-accent">
                      {backlinkId}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default NoteView
