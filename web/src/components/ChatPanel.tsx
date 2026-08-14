import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

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

function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)

  const listRef = useRef<HTMLDivElement>(null)
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

  function handleScroll() {
    const el = listRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    autoScrollRef.current = distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX
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
        body: JSON.stringify({ message: text }),
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

          const event = JSON.parse(dataLine.slice('data: '.length)) as {
            type: string
            text?: string
            message?: string
          }

          if (event.type === 'token' && event.text) {
            const chunk = event.text
            patchLastMessage((msg) => ({ ...msg, content: msg.content + chunk }))
          } else if (event.type === 'done') {
            const finalMessage = event.message ?? ''
            patchLastMessage((msg) => ({ ...msg, content: finalMessage, status: 'done' }))
          }
          // status / tool_start / tool_end: no visible chat UI for these yet
          // (tools=[] server-side) — ignored, not an error.
        }
      }
    } catch (err) {
      // Release the connection on any failure — including a stall timeout,
      // which is us giving up rather than the platform reporting an error.
      controller.abort()
      if (err instanceof DOMException && err.name === 'AbortError') return
      patchLastMessage((msg) => ({ ...msg, status: 'error' }))
    } finally {
      setIsStreaming(false)
      abortRef.current = null
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-3 py-2 text-xs uppercase tracking-wide text-text-dim">
        Jarvis
      </div>

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

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
        className="flex gap-2 border-t border-border p-3"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask Jarvis..."
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
  )
}

export default ChatPanel
