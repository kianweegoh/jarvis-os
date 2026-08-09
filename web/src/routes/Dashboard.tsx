import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Brief {
  id: string
  title: string | null
  updated: string | null
  body: string
}

function Dashboard() {
  const [brief, setBrief] = useState<Brief | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/brief/today')
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        return res.json()
      })
      .then(setBrief)
      .catch((err) => setError(String(err)))
  }, [])

  return (
    <div className="max-w-3xl mx-auto px-10 py-12 font-serif text-lg">
      {error && <p className="text-text-dim font-sans text-base">No brief today: {error}</p>}
      {!error && !brief && <p className="text-text-dim font-sans text-base">Loading...</p>}
      {brief && (
        <article className="markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{brief.body}</ReactMarkdown>
        </article>
      )}
    </div>
  )
}

export default Dashboard
