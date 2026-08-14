import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AgentEvent } from './agentEvents'

// Local component state per the Day 31 spec — nothing else needs chat
// history yet, so no global store.
interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  status: 'streaming' | 'done' | 'error'
}

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
  const [messages, setMessages] = useState<ChatMessage[]>([])
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

  // Auto-scroll to the latest content (new messages *and* in-flight token
  // deltas) unless the user has manually scrolled up to read history.
  useEffect(() => {
    if (autoScrollRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [messages])

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

  // Applies `fn` to the last message in place — safe because a stream is
  // only ever in flight while `isStreaming` is true, and input is disabled
  // for the duration, so the assistant placeholder is guaranteed to still
  // be the last element.
  function patchLastMessage(fn: (msg: ChatMessage) => ChatMessage) {
    setMessages((prev) => {
      if (prev.length === 0) return prev
      const next = prev.slice()
      next[next.length - 1] = fn(next[next.length - 1])
      return next
    })
  }

  async function send() {
    const text = input.trim()
    if (!text || isStreaming) return

    setInput('')
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: text, status: 'done' },
      { role: 'assistant', content: '', status: 'streaming' },
    ])
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
            patchLastMessage((msg) => ({ ...msg, content: msg.content + chunk }))
          } else if (event.type === 'done') {
            patchLastMessage((msg) => ({ ...msg, content: event.message, status: 'done' }))
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
      patchLastMessage((msg) => ({ ...msg, status: 'error' }))
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
        {messages.length === 0 && (
          <p className="text-sm text-text-dim">Ask Jarvis anything.</p>
        )}
        {messages.map((msg, i) => (
          <Message key={i} msg={msg} />
        ))}
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
