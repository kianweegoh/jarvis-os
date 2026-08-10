import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import ForceGraph2D, { type ForceGraphMethods as ForceGraphMethods2D } from 'react-force-graph-2d'
import ForceGraph3D, { type ForceGraphMethods as ForceGraphMethods3D } from 'react-force-graph-3d'
import type { FilterContext } from '../components/Layout'

interface GraphNode {
  id: string
  label: string
  type: string | null
  tags: string[]
  val: number
  x?: number
  y?: number
  z?: number
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

// NOT force-graph's own default (that's black at 15% opacity — a sensible
// default against force-graph's typical light/white demo backgrounds, but
// on this app's near-black GRAPH_BG a black line at 15% opacity differs from
// the background by ~3/255 per channel: invisible in practice, not just
// faint. This bug predates the 2D/3D toggle work entirely — verified by
// diffing against the exact last-committed GraphView.tsx, byte for byte,
// which shows the same invisible-link behavior. White reads correctly
// against a dark background the way black read against force-graph's
// assumed light one.
const LINK_COLOR_DEFAULT = 'rgba(255,255,255,0.15)'
const LINK_COLOR_DIMMED = 'rgba(255,255,255,0.03)'
const DIM_ALPHA = 0.15

// Without an explicit linkWidth, three-forcegraph draws links as bare
// THREE.Line + LineBasicMaterial — a raw WebGL line whose `linewidth` most
// GPUs (via ANGLE on Windows in particular) silently ignore, always
// rendering it at 1px regardless of the requested value. Any truthy
// linkWidth switches it to an actual CylinderGeometry mesh instead, which
// has real, controllable screen-space width. 2D has no equivalent gap —
// canvas strokes already have real, anti-aliased width — so this is 3D-only.
const LINK_WIDTH_3D = 0.6

const DOUBLE_CLICK_MS = 500
const CAMERA_DURATION_MS = 800
const SINGLE_MATCH_ZOOM = 6
const SINGLE_MATCH_CAMERA_DISTANCE_3D = 120

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
  const { activeTypes, activeTags, searchResultIds, is3D, focusedId, setFocusedId } =
    useOutletContext<FilterContext>()
  const containerRef = useRef<HTMLDivElement>(null)
  // Separate refs per renderer — 2D and 3D expose different imperative APIs
  // (see the camera-follow effect below), so one ref can't type-check for
  // both. Only one is ever mounted at a time, driven by is3D.
  const fg2DRef = useRef<ForceGraphMethods2D<GraphNode, GraphLink> | undefined>(undefined)
  const fg3DRef = useRef<ForceGraphMethods3D<GraphNode, GraphLink> | undefined>(undefined)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const [data, setData] = useState<GraphData | null>(null)
  const [error, setError] = useState<string | null>(null)

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
  // counts); the facets, focus, and search are AND'd together. Identical in
  // 2D and 3D — these only touch id/type/tags/val, never x/y/z.
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

  // Click/double-click disambiguation is pure JS timing keyed on node.id —
  // no 2D/3D-specific API involved, so this is shared unmodified. Confirmed
  // onNodeClick / onBackgroundClick have identical signatures in both
  // libraries.
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
    [navigate, setFocusedId],
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
  //
  // This is the one place 2D and 3D genuinely diverge. 2D exposes
  // centerAt(x, y, ms) + a separate zoom(scale, ms); 3D has no equivalent —
  // instead cameraPosition({x,y,z}, lookAt, ms) moves the camera itself, so
  // "centering and zooming in" on a single match means placing the camera a
  // fixed distance from the node and pointing it there. zoomToFit exists in
  // both with the same signature, so the multi-match branch is unforked.
  useEffect(() => {
    if (!data || !searchResultIds || searchResultIds.size === 0) return
    const matchedIds = [...searchResultIds]

    if (is3D) {
      const fg = fg3DRef.current
      if (!fg) return
      if (matchedIds.length === 1) {
        const node = nodesByIdRef.current.get(matchedIds[0])
        if (
          node &&
          typeof node.x === 'number' &&
          typeof node.y === 'number' &&
          typeof node.z === 'number'
        ) {
          fg.cameraPosition(
            { x: node.x, y: node.y, z: node.z + SINGLE_MATCH_CAMERA_DISTANCE_3D },
            { x: node.x, y: node.y, z: node.z },
            CAMERA_DURATION_MS,
          )
        }
        return
      }
      fg.zoomToFit(CAMERA_DURATION_MS, 60, (node) => searchResultIds.has(String(node.id)))
      return
    }

    const fg = fg2DRef.current
    if (!fg) return
    if (matchedIds.length === 1) {
      const node = nodesByIdRef.current.get(matchedIds[0])
      if (node && typeof node.x === 'number' && typeof node.y === 'number') {
        fg.centerAt(node.x, node.y, CAMERA_DURATION_MS)
        fg.zoom(SINGLE_MATCH_ZOOM, CAMERA_DURATION_MS)
      }
      return
    }
    fg.zoomToFit(CAMERA_DURATION_MS, 60, (node) => searchResultIds.has(String(node.id)))
  }, [searchResultIds, data, is3D])

  const sharedProps = {
    graphData: { nodes: data?.nodes ?? [], links: data?.links ?? [] },
    width: dimensions.width,
    height: dimensions.height,
    backgroundColor: GRAPH_BG,
    nodeColor: (node: GraphNode) => {
      const base = TYPE_COLORS[node.type ?? ''] ?? DEFAULT_NODE_COLOR
      if (isNodeVisible(node)) return base
      const [r, g, b] = hexToRgb(base)
      return `rgba(${r}, ${g}, ${b}, ${DIM_ALPHA})`
    },
    // Leaf notes (val: 0) still need to render as a visible node.
    nodeVal: (node: GraphNode) => Math.max(node.val, 1),
    nodeLabel: 'label' as const,
    linkColor: (link: GraphLink) => {
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
    },
    onNodeClick: handleNodeClick,
    onBackgroundClick: () => setFocusedId(null),
  }

  return (
    <div ref={containerRef} className="h-full w-full">
      {error && (
        <p className="text-text-dim font-sans text-base p-6">Graph unavailable: {error}</p>
      )}
      {!error && !data && (
        <p className="text-text-dim font-sans text-base p-6">Loading...</p>
      )}
      {data && dimensions.width > 0 && (
        is3D ? (
          // three-forcegraph (the engine behind ForceGraph3D) multiplies
          // every node/link color's alpha by its own nodeOpacity/linkOpacity
          // config — defaults are 0.75 and 0.2 respectively. 2D has no such
          // concept (canvas fillStyle uses the color string as-is), so left
          // at 3D's defaults, "full opacity" renders permanently dimmed and
          // the default-vs-dimmed link distinction nearly disappears
          // (0.15 * 0.2 ≈ 0.03, the same as the dimmed link alpha). Forcing
          // both to 1 here makes the color strings themselves the only
          // source of opacity, matching 2D's behavior.
          <ForceGraph3D<GraphNode, GraphLink>
            ref={fg3DRef}
            {...sharedProps}
            nodeOpacity={1}
            linkOpacity={1}
            linkWidth={LINK_WIDTH_3D}
          />
        ) : (
          <ForceGraph2D<GraphNode, GraphLink> ref={fg2DRef} {...sharedProps} />
        )
        // Physics/interaction stay at react-force-graph defaults —
        // force-tuning is a later addition, not part of this pass.
      )}
    </div>
  )
}

export default GraphView
