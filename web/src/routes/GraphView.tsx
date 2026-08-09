import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d'
import type { FilterContext } from '../components/Layout'

interface GraphNode {
  id: string
  label: string
  type: string | null
  tags: string[]
  val: number
  x?: number
  y?: number
}

interface GraphLink {
  source: string
  target: string
}

interface GraphData {
  nodes: GraphNode[]
  links: GraphLink[]
  broken_links: GraphLink[]
}

// Desaturated, one per type, distinct enough at a glance against #151517.
// The amber accent stays reserved for interactive states — none of these
// are it.
const TYPE_COLORS: Record<string, string> = {
  project: '#6B9B8F',
  person: '#B27F8C',
  tool: '#7B84B5',
  concept: '#8FA36B',
  org: '#9B84B0',
  note: '#A79A85',
  decision: '#C08A6B',
  daily: '#6E7F91',
}
const DEFAULT_NODE_COLOR = '#7A7A7E'

// Canvas drawing can't read CSS custom properties — must stay in sync with
// index.css's --color-bg.
const GRAPH_BG = '#151517'

// force-graph's own default link stroke (read from node_modules/force-graph's
// source — it falls back to this whenever no explicit linkColor is set).
// Reproduced here so dimming can happen *around* it without changing how a
// fully-visible link actually looks.
const LINK_COLOR_DEFAULT = 'rgba(0,0,0,0.15)'
const LINK_COLOR_DIMMED = 'rgba(0,0,0,0.03)'
const DIM_ALPHA = 0.15

const DOUBLE_CLICK_MS = 500
const CAMERA_DURATION_MS = 800
const SINGLE_MATCH_ZOOM = 6

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// A link's source/target start as plain id strings but react-force-graph
// mutates them into node object references once the sim ticks — resolve
// either form back to the real node via the lookup map (needed for the
// string case; the object case already carries type/tags directly).
function resolveEndpoint(
  endpoint: string | GraphNode,
  nodesById: Map<string, GraphNode>,
): GraphNode | undefined {
  return typeof endpoint === 'object' ? endpoint : nodesById.get(endpoint)
}

function GraphView() {
  const navigate = useNavigate()
  const { activeTypes, activeTags, searchResultIds } = useOutletContext<FilterContext>()
  const containerRef = useRef<HTMLDivElement>(null)
  const fgRef = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(undefined)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const [data, setData] = useState<GraphData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)

  // Built once when data arrives, from the raw fetched ids — independent of
  // the link objects react-force-graph mutates in place, so both stay
  // correct regardless of sim state.
  const neighborsRef = useRef<Map<string, Set<string>>>(new Map())
  const nodesByIdRef = useRef<Map<string, GraphNode>>(new Map())

  // Click/double-click disambiguation: a click waits briefly to see if a
  // second click on the same node follows before committing to navigation.
  const pendingClickRef = useRef<{ nodeId: string | null; timer: number | null }>({
    nodeId: null,
    timer: null,
  })

  useEffect(() => {
    fetch('/api/graph')
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        return res.json()
      })
      .then((json: GraphData) => {
        const neighbors = new Map<string, Set<string>>()
        for (const node of json.nodes) neighbors.set(node.id, new Set())
        for (const link of json.links) {
          neighbors.get(link.source)?.add(link.target)
          neighbors.get(link.target)?.add(link.source)
        }
        neighborsRef.current = neighbors
        nodesByIdRef.current = new Map(json.nodes.map((node) => [node.id, node]))
        setData(json)
      })
      .catch((err) => setError(String(err)))
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setDimensions({ width, height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Type/tag filters, focus mode, and search are three independent dimming
  // conditions — a node (or link) must pass all three to stay full opacity.
  // Multiple selected types/tags are OR'd within their own facet (any match
  // counts); the facets, focus, and search are AND'd together.
  const passesFilters = useCallback(
    (node: GraphNode) => {
      const typeOk = activeTypes.size === 0 || activeTypes.has(node.type ?? '')
      const tagOk = activeTags.size === 0 || node.tags.some((tag) => activeTags.has(tag))
      return typeOk && tagOk
    },
    [activeTypes, activeTags],
  )

  const passesFocus = useCallback(
    (nodeId: string) =>
      focusedId === null ||
      nodeId === focusedId ||
      (neighborsRef.current.get(focusedId)?.has(nodeId) ?? false),
    [focusedId],
  )

  const passesSearch = useCallback(
    (nodeId: string) => searchResultIds === null || searchResultIds.has(nodeId),
    [searchResultIds],
  )

  const isNodeVisible = useCallback(
    (node: GraphNode) => passesFilters(node) && passesFocus(node.id) && passesSearch(node.id),
    [passesFilters, passesFocus, passesSearch],
  )

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      const pending = pendingClickRef.current
      if (pending.nodeId === node.id && pending.timer !== null) {
        // Second click on the same node within the window — double-click:
        // toggle focus, and cancel the pending single-click navigation.
        window.clearTimeout(pending.timer)
        pendingClickRef.current = { nodeId: null, timer: null }
        setFocusedId((current) => (current === node.id ? null : node.id))
        return
      }

      if (pending.timer !== null) window.clearTimeout(pending.timer)
      const timer = window.setTimeout(() => {
        pendingClickRef.current = { nodeId: null, timer: null }
        navigate(`/note/${node.id}`)
      }, DOUBLE_CLICK_MS)
      pendingClickRef.current = { nodeId: node.id, timer }
    },
    [navigate],
  )

  // A committed search takes over from focus mode rather than composing with
  // it — otherwise the camera can pan/zoom to a match that's dimmed because
  // it falls outside the previously-focused node's neighborhood, with the
  // actual focus highlight left off-screen. Filters are untouched; a search
  // match that's filtered out still shows dimmed, which is a much smaller
  // surprise than "the thing the camera just centered on is invisible."
  useEffect(() => {
    if (searchResultIds && searchResultIds.size > 0) {
      setFocusedId(null)
    }
  }, [searchResultIds])

  // Camera follows search matches. Single match: center + zoom in on it.
  // Multiple: zoomToFit framed to just the matched nodes.
  useEffect(() => {
    if (!data || !searchResultIds || searchResultIds.size === 0) return
    const fg = fgRef.current
    if (!fg) return

    const matchedIds = [...searchResultIds]

    if (matchedIds.length === 1) {
      const node = nodesByIdRef.current.get(matchedIds[0])
      if (node && typeof node.x === 'number' && typeof node.y === 'number') {
        fg.centerAt(node.x, node.y, CAMERA_DURATION_MS)
        fg.zoom(SINGLE_MATCH_ZOOM, CAMERA_DURATION_MS)
      }
      return
    }

    fg.zoomToFit(CAMERA_DURATION_MS, 60, (node) => searchResultIds.has(String(node.id)))
  }, [searchResultIds, data])

  return (
    <div ref={containerRef} className="h-full w-full">
      {error && (
        <p className="text-text-dim font-sans text-base p-6">Graph unavailable: {error}</p>
      )}
      {!error && !data && (
        <p className="text-text-dim font-sans text-base p-6">Loading...</p>
      )}
      {data && dimensions.width > 0 && (
        <ForceGraph2D<GraphNode, GraphLink>
          ref={fgRef}
          graphData={{ nodes: data.nodes, links: data.links }}
          width={dimensions.width}
          height={dimensions.height}
          backgroundColor={GRAPH_BG}
          nodeColor={(node) => {
            const base = TYPE_COLORS[node.type ?? ''] ?? DEFAULT_NODE_COLOR
            if (isNodeVisible(node)) return base
            const [r, g, b] = hexToRgb(base)
            return `rgba(${r}, ${g}, ${b}, ${DIM_ALPHA})`
          }}
          // Leaf notes (val: 0) still need to render as a visible dot.
          nodeVal={(node) => Math.max(node.val, 1)}
          nodeLabel="label"
          linkColor={(link) => {
            const source = resolveEndpoint(link.source, nodesByIdRef.current)
            const target = resolveEndpoint(link.target, nodesByIdRef.current)
            const bothPass =
              !!source &&
              !!target &&
              passesFilters(source) &&
              passesFilters(target) &&
              passesSearch(source.id) &&
              passesSearch(target.id)
            if (!bothPass) return LINK_COLOR_DIMMED
            if (focusedId === null) return LINK_COLOR_DEFAULT
            return source!.id === focusedId || target!.id === focusedId
              ? LINK_COLOR_DEFAULT
              : LINK_COLOR_DIMMED
          }}
          onNodeClick={handleNodeClick}
          onBackgroundClick={() => setFocusedId(null)}
          // Physics/interaction stay at react-force-graph defaults —
          // force-tuning is Day 39 (Week 6).
        />
      )}
    </div>
  )
}

export default GraphView
