import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AgentEvent } from './agentEvents'

// Local component state per the Day 31 spec — nothing else needs chat
// history yet, so no global store. Day 34 widens this to a discriminated
// union (ChatItem) so a write-proposal card can live in the same ordered
// stream as chat bubbles, not a separate list.
interface ChatMessage {
  kind: 'message'
  role: 'user' | 'assistant'
  content: string
  status: 'streaming' | 'done' | 'error'
}

// Day 34: mirrors the server's write_proposal event fields (see
// agentEvents.ts) plus local approve/reject lifecycle state.
interface WriteProposal {
  id: string
  action: 'create' | 'edit'
  note_id: string
  title: string
  content: string
  frontmatter: Record<string, unknown>
  target_path: string
}

interface ProposalItem {
  kind: 'proposal'
  proposal: WriteProposal
  status: 'pending' | 'approved' | 'rejected' | 'error'
  busy?: boolean
  error?: string
}

type ChatItem = ChatMessage | ProposalItem

// How close to the bottom (px) still counts as "at the bottom" for
// auto-scroll purposes — a manual scroll-up past this disables it until the
// user scrolls back down themselves.
const AUTO_SCROLL_THRESHOLD_PX = 40

// A dead backend (crash, killed process) doesn't always surface as a
// rejected read — a dev-proxy sitting between the browser and the backend
// can leave the connection open with no more bytes ever arriving, so
// `reader.read()` just hangs forever with nothing to catch. This bounds how
// long we wait for the *next* chunk (reset on every chunk received, not a
// single overall deadline) before giving up and treating it as an error.
const STALL_TIMEOUT_MS = 15_000

// Day 33: @-mention picker. Matches a trailing "@word" at the end of the
// input — a plain <input> has no notion of cursor-relative tokens, so this
// (like most minimal mention implementations) assumes forward typing rather
// than editing mid-string. "@" with nothing after it still matches (empty
// capture group), which is what opens the picker the instant "@" is typed.
const MENTION_RE = /@([\w-]*)$/
const MENTION_DEBOUNCE_MS = 200

interface MentionResult {
  id: string
  title: string | null
}

function Message({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user'
  return (
    <div
      className={`max-w-[92%] rounded px-3 py-2 text-sm ${
        isUser ? 'self-end bg-accent/15' : 'self-start bg-surface'
      } ${msg.status === 'error' ? 'border border-red-500/50' : ''}`}
    >
      <div className="markdown-body chat-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
        {msg.status === 'streaming' && <span className="chat-cursor" />}
      </div>
      {msg.status === 'error' && (
        <div className="mt-1 text-xs text-red-400">
          ⚠ Connection dropped before the reply finished. Try again.
        </div>
      )}
    </div>
  )
}

// Day 34: a write proposal renders as its own card, not a chat bubble — the
// point is that it's visibly a different kind of thing (a pending decision,
// not prose) so it can't be mistaken for something already written.
function ProposalCard({
  item,
  onApprove,
  onReject,
}: {
  item: ProposalItem
  onApprove: (id: string) => void
  onReject: (id: string) => void
}) {
  const { proposal, status, busy, error } = item
  const frontmatterEntries = Object.entries(proposal.frontmatter)

  return (
    <div className="self-stretch rounded border border-accent/40 bg-surface p-3 text-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-accent">
          {proposal.action === 'create' ? 'New note proposed' : 'Edit proposed'}
        </span>
        {status === 'approved' && (
          <span className="text-xs text-accent">✓ Written to {proposal.target_path}</span>
        )}
        {status === 'rejected' && <span className="text-xs text-text-dim">Discarded</span>}
      </div>

      <div className="mb-2">
        <div className="font-semibold text-text">{proposal.title}</div>
        <div className="text-xs text-text-dim">
          {proposal.note_id} · {proposal.target_path}
        </div>
      </div>

      {frontmatterEntries.length > 0 && (
        <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
          {frontmatterEntries.map(([key, value]) => (
            <Fragment key={key}>
              <dt className="font-semibold text-text-dim">{key}</dt>
              <dd className="truncate text-text-dim">
                {Array.isArray(value) ? value.join(', ') : String(value)}
              </dd>
            </Fragment>
          ))}
        </dl>
      )}

      <div className="markdown-body chat-markdown mb-2 rounded border border-border bg-bg p-2">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{proposal.content}</ReactMarkdown>
      </div>

      {error && <div className="mb-2 text-xs text-red-400">⚠ {error}</div>}

      {(status === 'pending' || status === 'error') && (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onApprove(proposal.id)}
            className="cursor-pointer rounded bg-accent px-2 py-1 text-xs font-semibold text-bg disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? '…' : 'Approve'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onReject(proposal.id)}
            className="cursor-pointer rounded border border-border px-2 py-1 text-xs text-text-dim hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      )}
    </div>
  )
}

interface ChatPanelProps {
  // Day 32: forwards every parsed SSE event upward so AgentHud (a sibling,
  // not a child) can derive live agent state from the same stream — see
  // agentEvents.ts for why this is a lifted callback and not a second fetch.
  onAgentEvent?: (event: AgentEvent) => void
  // Day 33: both lifted in Layout — see the comments there for why they're
  // independent (navigation sets/clears openNoteId; only the picker below
  // touches attachedNoteIds).
  openNoteId: string | null
  attachedNoteIds: string[]
  onAttachNote: (id: string) => void
  onRemoveAttachedNote: (id: string) => void
}

function ChatPanel({
  onAgentEvent,
  openNoteId,
  attachedNoteIds,
  onAttachNote,
  onRemoveAttachedNote,
}: ChatPanelProps) {
  const [items, setItems] = useState<ChatItem[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  // null = picker closed. A string (possibly empty, right after typing a
  // bare "@") = picker open, holding the filter text typed after the "@".
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionResults, setMentionResults] = useState<MentionResult[]>([])

  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Ref, not state — read inside the scroll-driven effect below without
  // needing to re-run it on every scroll event.
  const autoScrollRef = useRef(true)
  const abortRef = useRef<AbortController | null>(null)
  // Day 34: a write_proposal event can insert a new item *after* the
  // streaming assistant message but *before* it finishes (the model can
  // keep talking after the tool call). "Patch the last item" stopped being
  // safe the moment a second kind of item could land at the end — this
  // tracks the assistant message's own index instead, captured once at
  // send() time, so later token/done events always find the right item
  // regardless of what got appended after it.
  const assistantIndexRef = useRef(-1)

  // Auto-scroll to the latest content (new messages *and* in-flight token
  // deltas) unless the user has manually scrolled up to read history.
  useEffect(() => {
    if (autoScrollRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [items])

  // Abort any in-flight stream if the panel unmounts mid-response — same
  // AbortController pattern Layout.tsx uses for the debounced search fetch.
  useEffect(() => () => abortRef.current?.abort(), [])

  // Mention picker results: reuses Day 18's /api/search once there's a
  // filter to actually search on (FTS5 needs real terms — an empty MATCH
  // returns nothing by design), and falls back to the plain /api/notes list
  // for the instant-after-"@" moment before any filter text exists. Same
  // debounce pattern Layout.tsx already uses for the sidebar search box.
  useEffect(() => {
    if (mentionQuery === null) {
      setMentionResults([])
      return
    }

    const controller = new AbortController()
    const trimmed = mentionQuery.trim()

    const timer = window.setTimeout(() => {
      const request = trimmed
        ? fetch(`/api/search?q=${encodeURIComponent(trimmed)}&limit=8`, {
            signal: controller.signal,
          })
            .then((res) => {
              if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
              return res.json()
            })
            .then((json: { results: MentionResult[] }) => json.results)
        : fetch('/api/notes', { signal: controller.signal })
            .then((res) => {
              if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
              return res.json()
            })
            .then((json: { notes: MentionResult[] }) => json.notes.slice(0, 8))

      request.then(setMentionResults).catch((err) => {
        if (err.name !== 'AbortError') setMentionResults([])
      })
    }, MENTION_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [mentionQuery])

  function handleScroll() {
    const el = listRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    autoScrollRef.current = distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX
  }

  function handleInputChange(value: string) {
    setInput(value)
    const match = value.match(MENTION_RE)
    setMentionQuery(match ? match[1] : null)
  }

  function handleInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape' && mentionQuery !== null) {
      setMentionQuery(null)
    }
  }

  function selectMention(id: string) {
    // Drop the trailing "@query" the picker was opened on — the mention
    // becomes a chip, not text in the message body.
    setInput((prev) => prev.replace(MENTION_RE, ''))
    onAttachNote(id)
    setMentionQuery(null)
    inputRef.current?.focus()
  }

  // Applies `fn` to the item at `index` — a no-op if that slot isn't (or
  // isn't still) a chat message, so a stale index can't corrupt a proposal
  // card that happens to occupy the same slot.
  function patchMessageAt(index: number, fn: (msg: ChatMessage) => ChatMessage) {
    setItems((prev) => {
      if (index < 0 || index >= prev.length) return prev
      const target = prev[index]
      if (target.kind !== 'message') return prev
      const next = prev.slice()
      next[index] = fn(target)
      return next
    })
  }

  function patchProposal(id: string, fn: (item: ProposalItem) => ProposalItem) {
    setItems((prev) =>
      prev.map((item) => (item.kind === 'proposal' && item.proposal.id === id ? fn(item) : item)),
    )
  }

  async function approveProposal(id: string) {
    patchProposal(id, (item) => ({ ...item, busy: true, error: undefined }))
    try {
      const res = await fetch(`/api/notes/proposals/${encodeURIComponent(id)}/approve`, {
        method: 'POST',
      })
      if (!res.ok) {
        const body: { detail?: { error?: string } | string } | null = await res
          .json()
          .catch(() => null)
        const detail = body?.detail
        const message = typeof detail === 'string' ? detail : detail?.error
        throw new Error(message ?? `${res.status} ${res.statusText}`)
      }
      const saved: { id: string; body: string } = await res.json()

      // Don't just trust the 200 — re-fetch the note fresh from the same
      // endpoint the note viewer uses and confirm the content on disk
      // actually matches. This is the same "check the real file, not the
      // response" instinct that caught Day 17's write bug in the first
      // place.
      const verifyRes = await fetch(`/api/notes/${encodeURIComponent(saved.id)}`)
      if (!verifyRes.ok) {
        throw new Error('Wrote it, but re-fetching the note to verify failed.')
      }
      const verified: { body: string } = await verifyRes.json()
      if (verified.body !== saved.body) {
        throw new Error('Verification mismatch — the file on disk does not match the approval.')
      }

      patchProposal(id, (item) => ({ ...item, status: 'approved', busy: false }))
    } catch (err) {
      patchProposal(id, (item) => ({ ...item, status: 'error', busy: false, error: String(err) }))
    }
  }

  async function rejectProposal(id: string) {
    patchProposal(id, (item) => ({ ...item, busy: true, error: undefined }))
    try {
      const res = await fetch(`/api/notes/proposals/${encodeURIComponent(id)}/reject`, {
        method: 'POST',
      })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      patchProposal(id, (item) => ({ ...item, status: 'rejected', busy: false }))
    } catch (err) {
      patchProposal(id, (item) => ({ ...item, status: 'error', busy: false, error: String(err) }))
    }
  }

  async function send() {
    const text = input.trim()
    if (!text || isStreaming) return

    setInput('')
    setItems((prev) => {
      const next: ChatItem[] = [
        ...prev,
        { kind: 'message', role: 'user', content: text, status: 'done' },
        { kind: 'message', role: 'assistant', content: '', status: 'streaming' },
      ]
      // The updater runs synchronously, so this is set before send()
      // continues — see the ref's own comment above for why index, not
      // "last item", is what later events target.
      assistantIndexRef.current = next.length - 1
      return next
    })
    setIsStreaming(true)
    autoScrollRef.current = true

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          // Day 33: server resolves these against the real vault — the
          // client only ever sends ids, never note bodies.
          open_note_id: openNoteId,
          attached_note_ids: attachedNoteIds,
        }),
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        throw new Error(`${res.status} ${res.statusText}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        // Races the next chunk against a fresh stall clock each iteration —
        // "time since last chunk", not one deadline for the whole response.
        let stallTimer: number
        const stalled = new Promise<never>((_, reject) => {
          stallTimer = window.setTimeout(
            () => reject(new Error(`No data received for ${STALL_TIMEOUT_MS / 1000}s`)),
            STALL_TIMEOUT_MS,
          )
        })
        let value: Uint8Array | undefined
        let done: boolean
        try {
          ;({ value, done } = await Promise.race([reader.read(), stalled]))
        } finally {
          window.clearTimeout(stallTimer!)
        }
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        // SSE frames are blank-line-delimited; hold the trailing partial
        // frame back in `buffer` until more bytes complete it.
        const frames = buffer.split('\n\n')
        buffer = frames.pop() ?? ''

        for (const frame of frames) {
          const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
          if (!dataLine) continue

          const event = JSON.parse(dataLine.slice('data: '.length)) as AgentEvent
          // Forward first, unconditionally — ChatPanel stays the transport,
          // AgentHud's reducer is the one place that decides what each
          // event type means for on-screen agent state.
          onAgentEvent?.(event)

          if (event.type === 'token') {
            const chunk = event.text
            patchMessageAt(assistantIndexRef.current, (msg) => ({
              ...msg,
              content: msg.content + chunk,
            }))
          } else if (event.type === 'done') {
            patchMessageAt(assistantIndexRef.current, (msg) => ({
              ...msg,
              content: event.message,
              status: 'done',
            }))
          } else if (event.type === 'write_proposal') {
            // A new item appended after the (possibly still-streaming)
            // assistant message — see assistantIndexRef's comment for why
            // that's safe.
            setItems((prev) => [
              ...prev,
              {
                kind: 'proposal',
                proposal: {
                  id: event.id,
                  action: event.action,
                  note_id: event.note_id,
                  title: event.title,
                  content: event.content,
                  frontmatter: event.frontmatter,
                  target_path: event.target_path,
                },
                status: 'pending',
              },
            ])
          }
          // status / tool_start / tool_end: no chat-bubble UI for these —
          // they're what AgentHud renders instead. Not ignored, just routed
          // elsewhere.
        }
      }
    } catch (err) {
      // Release the connection on any failure — including a stall timeout,
      // which is us giving up rather than the platform reporting an error.
      controller.abort()
      if (err instanceof DOMException && err.name === 'AbortError') return
      patchMessageAt(assistantIndexRef.current, (msg) => ({ ...msg, status: 'error' }))
      // No real "done" is coming now — tell the HUD the turn is over so it
      // doesn't stay stuck on Thinking/Using tool forever.
      onAgentEvent?.({ type: 'stream_error' })
    } finally {
      setIsStreaming(false)
      abortRef.current = null
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="flex flex-1 flex-col gap-2 overflow-y-auto p-3"
      >
        {items.length === 0 && <p className="text-sm text-text-dim">Ask Jarvis anything.</p>}
        {items.map((item, i) =>
          item.kind === 'message' ? (
            <Message key={i} msg={item} />
          ) : (
            <ProposalCard key={i} item={item} onApprove={approveProposal} onReject={rejectProposal} />
          ),
        )}
      </div>

      <div className="relative border-t border-border">
        {mentionQuery !== null && (
          <div className="absolute bottom-full left-3 right-3 mb-1 max-h-48 overflow-y-auto rounded border border-border bg-surface shadow-lg">
            {mentionResults.length === 0 ? (
              <p className="px-3 py-2 text-xs text-text-dim">No matching notes.</p>
            ) : (
              mentionResults.map((note) => (
                <button
                  key={note.id}
                  type="button"
                  onClick={() => selectMention(note.id)}
                  className="block w-full cursor-pointer truncate px-3 py-1.5 text-left text-sm hover:bg-bg"
                >
                  <span className="text-text">{note.title ?? note.id}</span>
                  <span className="ml-1.5 text-xs text-text-dim">{note.id}</span>
                </button>
              ))
            )}
          </div>
        )}

        {(openNoteId || attachedNoteIds.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2 text-xs">
            {openNoteId && (
              <span
                className="rounded border border-border px-1.5 py-0.5 text-text-dim"
                title="Included automatically — the note you're currently viewing"
              >
                {openNoteId}
              </span>
            )}
            {attachedNoteIds.map((id) => (
              <span
                key={id}
                className="flex items-center gap-1 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-accent"
              >
                {id}
                <button
                  type="button"
                  onClick={() => onRemoveAttachedNote(id)}
                  aria-label={`Remove ${id}`}
                  className="cursor-pointer text-text-dim hover:text-text"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault()
            // Still picking a mention — Enter shouldn't send a half-typed
            // "@query" as the message.
            if (mentionQuery !== null) return
            void send()
          }}
          className="flex gap-2 p-3"
        >
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="Ask Jarvis... (@ to attach a note)"
            disabled={isStreaming}
            className="flex-1 rounded border border-border bg-surface px-2 py-1.5 text-sm text-text placeholder:text-text-dim focus:outline-none focus:border-accent disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={isStreaming || !input.trim()}
            className="cursor-pointer rounded bg-accent px-3 py-1.5 text-sm font-semibold text-bg disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isStreaming ? '…' : 'Send'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default ChatPanel
