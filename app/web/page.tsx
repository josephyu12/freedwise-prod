'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceX,
  forceY,
  Simulation,
} from 'd3-force'
import { useEmbeddingSync } from '@/hooks/useEmbeddingSync'

interface GraphNode {
  id: string
  text: string
  source: string | null
  author: string | null
  cats: string[]
  hasEmbedding: boolean
  // d3-force mutates these in place
  x?: number
  y?: number
  vx?: number
  vy?: number
  index?: number
}

interface GraphEdge {
  s: number
  t: number
  w: number
  source?: any
  target?: any
}

interface GraphCategory {
  id: string
  name: string
  color: string | null
}

interface GraphPayload {
  nodes: GraphNode[]
  edges: GraphEdge[]
  categories: GraphCategory[]
  stats: { highlights: number; embedded: number; edges: number }
}

// Fallback palette when a category has no stored color.
const PALETTE = [
  '#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6',
  '#8b5cf6', '#ef4444', '#14b8a6', '#f97316', '#84cc16',
  '#06b6d4', '#d946ef',
]
const NO_CATEGORY_COLOR = '#9ca3af'

export default function WebPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [graph, setGraph] = useState<GraphPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const [filter, setFilter] = useState('')
  const embeddingSync = useEmbeddingSync()

  // Mutable render state lives in refs: the animation loop reads them
  // without re-subscribing, React state only drives the UI chrome.
  const simRef = useRef<Simulation<GraphNode, any> | null>(null)
  const fitRef = useRef<(() => void) | null>(null)
  const transformRef = useRef({ x: 0, y: 0, k: 1 })
  const selectedRef = useRef<number | null>(null)
  const hoverRef = useRef<number | null>(null)
  const filterRef = useRef('')
  const needsDrawRef = useRef(true)

  selectedRef.current = selectedIdx
  hoverRef.current = hoverIdx

  const load = useCallback(async (refresh = false) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/web/graph${refresh ? '?refresh=1' : ''}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to load the highlight web')
      }
      const payload: GraphPayload = await res.json()
      setGraph(payload)
      setSelectedIdx(null)
    } catch (e: any) {
      setError(e?.message || 'Failed to load the highlight web')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // When the embedding sync finishes a pass that actually embedded rows,
  // rebuild the graph so new highlights get meaning-based edges.
  const syncWasActive = useRef(false)
  useEffect(() => {
    if (embeddingSync.syncing) syncWasActive.current = true
    else if (syncWasActive.current) {
      syncWasActive.current = false
      load(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embeddingSync.syncing])

  const categoryColor = useMemo(() => {
    const map = new Map<string, string>()
    if (graph) {
      graph.categories.forEach((c, i) => {
        map.set(c.id, c.color || PALETTE[i % PALETTE.length])
      })
    }
    return map
  }, [graph])

  const degrees = useMemo(() => {
    if (!graph) return new Map<number, number>()
    const d = new Map<number, number>()
    for (const e of graph.edges) {
      d.set(e.s, (d.get(e.s) || 0) + 1)
      d.set(e.t, (d.get(e.t) || 0) + 1)
    }
    return d
  }, [graph])

  const neighborsOf = useCallback(
    (idx: number): { idx: number; w: number }[] => {
      if (!graph) return []
      const out: { idx: number; w: number }[] = []
      for (const e of graph.edges) {
        if (e.s === idx) out.push({ idx: e.t, w: e.w })
        else if (e.t === idx) out.push({ idx: e.s, w: e.w })
      }
      return out.sort((a, b) => b.w - a.w)
    },
    [graph]
  )

  const filterMatches = useMemo(() => {
    if (!graph || !filter.trim()) return null
    const q = filter.trim().toLowerCase()
    const set = new Set<number>()
    graph.nodes.forEach((n, i) => {
      if (n.text.toLowerCase().includes(q)) set.add(i)
    })
    return set
  }, [graph, filter])
  const filterMatchesRef = useRef<Set<number> | null>(null)
  filterMatchesRef.current = filterMatches
  filterRef.current = filter
  useEffect(() => {
    needsDrawRef.current = true
  }, [filterMatches, selectedIdx, hoverIdx])

  // --- simulation + render loop ---
  useEffect(() => {
    if (!graph || !canvasRef.current || !containerRef.current) return
    const canvas = canvasRef.current
    const container = containerRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const nodes = graph.nodes
    const links = graph.edges.map((e) => ({ ...e, source: e.s, target: e.t }))

    // Seed positions deterministically in a disc so layout is stable-ish.
    const R = 60 * Math.sqrt(nodes.length)
    nodes.forEach((n, i) => {
      if (n.x === undefined) {
        const a = (i / nodes.length) * Math.PI * 2 * 17 // spiral
        const r = R * Math.sqrt(i / nodes.length)
        n.x = Math.cos(a) * r
        n.y = Math.sin(a) * r
      }
    })

    const sim = forceSimulation<GraphNode>(nodes)
      .force(
        'link',
        forceLink(links)
          .distance((l: any) => 40 + (1 - l.w) * 120)
          .strength((l: any) => 0.2 + 0.6 * l.w)
      )
      .force('charge', forceManyBody().strength(-40).theta(0.9).distanceMax(600))
      .force('center', forceCenter(0, 0))
      .force('x', forceX(0).strength(0.03))
      .force('y', forceY(0).strength(0.03))
      .alpha(1)
      .alphaDecay(0.03)
    simRef.current = sim

    const styles = getComputedStyle(document.documentElement)
    const isDark = document.documentElement.classList.contains('dark') ||
      window.matchMedia('(prefers-color-scheme: dark)').matches
    const edgeColor = isDark ? 'rgba(148,163,184,0.18)' : 'rgba(100,116,139,0.16)'
    const edgeHiColor = isDark ? 'rgba(129,140,248,0.7)' : 'rgba(79,70,229,0.55)'
    const labelColor = styles.getPropertyValue('--text-primary').trim() || (isDark ? '#e5e7eb' : '#1f2937')

    const resize = () => {
      const rect = container.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      needsDrawRef.current = true
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(container)

    // Fit the layout into view once it has mostly settled.
    let fitted = false
    const fit = () => {
      const rect = container.getBoundingClientRect()
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (const n of nodes) {
        if (n.x! < minX) minX = n.x!
        if (n.x! > maxX) maxX = n.x!
        if (n.y! < minY) minY = n.y!
        if (n.y! > maxY) maxY = n.y!
      }
      const w = maxX - minX || 1
      const h = maxY - minY || 1
      const k = Math.min(rect.width / (w + 100), rect.height / (h + 100), 2)
      transformRef.current = {
        k,
        x: rect.width / 2 - k * (minX + w / 2),
        y: rect.height / 2 - k * (minY + h / 2),
      }
      needsDrawRef.current = true
    }
    fitRef.current = fit

    const nodeRadius = (i: number) => 2.5 + Math.sqrt(degrees.get(i) || 0) * 1.1

    const draw = () => {
      const rect = container.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const { x: tx, y: ty, k } = transformRef.current
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, rect.width, rect.height)
      ctx.translate(tx, ty)
      ctx.scale(k, k)

      const sel = selectedRef.current
      const hov = hoverRef.current
      const matches = filterMatchesRef.current
      const selNeighbors = new Set<number>()
      if (sel !== null) {
        for (const l of links) {
          if (l.s === sel) selNeighbors.add(l.t)
          if (l.t === sel) selNeighbors.add(l.s)
        }
      }

      // edges
      ctx.lineWidth = 1 / k
      for (const l of links) {
        const a = nodes[l.s], b = nodes[l.t]
        const emphasized = sel !== null && (l.s === sel || l.t === sel)
        ctx.strokeStyle = emphasized ? edgeHiColor : edgeColor
        ctx.lineWidth = (emphasized ? 1.8 : 0.8 + l.w) / k
        ctx.beginPath()
        ctx.moveTo(a.x!, a.y!)
        ctx.lineTo(b.x!, b.y!)
        ctx.stroke()
      }

      // nodes
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]
        const r = nodeRadius(i) / Math.sqrt(k)
        const color = n.cats.length > 0
          ? categoryColor.get(n.cats[0]) || NO_CATEGORY_COLOR
          : NO_CATEGORY_COLOR
        const dimmed =
          (matches && !matches.has(i)) ||
          (sel !== null && i !== sel && !selNeighbors.has(i))
        ctx.globalAlpha = dimmed ? 0.15 : 0.9
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(n.x!, n.y!, r, 0, Math.PI * 2)
        ctx.fill()
        if (i === sel || i === hov) {
          ctx.globalAlpha = 1
          ctx.strokeStyle = labelColor
          ctx.lineWidth = 1.5 / k
          ctx.stroke()
        }
      }
      ctx.globalAlpha = 1

      // hover label
      const labelIdx = hov ?? sel
      if (labelIdx !== null && k > 0.25) {
        const n = nodes[labelIdx]
        const snippet = n.text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 80)
        ctx.font = `${12 / k}px sans-serif`
        ctx.fillStyle = labelColor
        ctx.fillText(snippet, n.x! + 8 / k, n.y! - 8 / k)
      }
    }

    let raf = 0
    const loop = () => {
      if (sim.alpha() > sim.alphaMin()) {
        needsDrawRef.current = true
        if (!fitted && sim.alpha() < 0.3) {
          fitted = true
          fit()
        }
      }
      if (needsDrawRef.current) {
        needsDrawRef.current = false
        draw()
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      sim.stop()
      simRef.current = null
    }
  }, [graph, categoryColor, degrees])

  // --- pointer interaction: pan, zoom, hover, click ---
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !graph) return
    const nodes = graph.nodes

    const toWorld = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect()
      const { x, y, k } = transformRef.current
      return {
        x: (clientX - rect.left - x) / k,
        y: (clientY - rect.top - y) / k,
      }
    }

    const hitTest = (clientX: number, clientY: number): number | null => {
      const p = toWorld(clientX, clientY)
      const { k } = transformRef.current
      const threshold = 10 / Math.sqrt(k)
      let best: number | null = null
      let bestD = threshold * threshold
      for (let i = 0; i < nodes.length; i++) {
        const dx = nodes[i].x! - p.x
        const dy = nodes[i].y! - p.y
        const d = dx * dx + dy * dy
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      return best
    }

    let dragging = false
    let moved = false
    let last = { x: 0, y: 0 }

    const onPointerDown = (e: PointerEvent) => {
      dragging = true
      moved = false
      last = { x: e.clientX, y: e.clientY }
      canvas.setPointerCapture(e.pointerId)
    }
    const onPointerMove = (e: PointerEvent) => {
      if (dragging) {
        const dx = e.clientX - last.x
        const dy = e.clientY - last.y
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true
        transformRef.current.x += dx
        transformRef.current.y += dy
        last = { x: e.clientX, y: e.clientY }
        needsDrawRef.current = true
      } else {
        setHoverIdx(hitTest(e.clientX, e.clientY))
      }
    }
    const onPointerUp = (e: PointerEvent) => {
      canvas.releasePointerCapture(e.pointerId)
      if (dragging && !moved) {
        setSelectedIdx(hitTest(e.clientX, e.clientY))
      }
      dragging = false
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const { x, y, k } = transformRef.current
      const factor = Math.exp(-e.deltaY * 0.0015)
      const nk = Math.min(Math.max(k * factor, 0.05), 8)
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      transformRef.current = {
        k: nk,
        x: px - ((px - x) / k) * nk,
        y: py - ((py - y) / k) * nk,
      }
      needsDrawRef.current = true
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [graph])

  const selected = selectedIdx !== null && graph ? graph.nodes[selectedIdx] : null
  const selectedNeighbors = selectedIdx !== null ? neighborsOf(selectedIdx) : []

  const centerOn = (idx: number) => {
    const canvas = canvasRef.current
    if (!canvas || !graph) return
    const n = graph.nodes[idx]
    const rect = canvas.getBoundingClientRect()
    const k = Math.max(transformRef.current.k, 0.8)
    transformRef.current = {
      k,
      x: rect.width / 2 - k * n.x!,
      y: rect.height / 2 - k * n.y!,
    }
    needsDrawRef.current = true
    setSelectedIdx(idx)
  }

  return (
    <main className="min-h-screen" style={{ background: 'var(--background)' }}>
      <div className="container mx-auto px-4 py-8 sm:py-10">
        <div className="max-w-7xl mx-auto">
          <div className="mb-6 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>
                Highlight Web
              </h1>
              <p className="text-sm mt-1" style={{ color: 'var(--text-tertiary)' }}>
                Highlights connected by meaning and shared words — clusters are ideas you keep returning to
              </p>
            </div>
            {graph && (
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {graph.stats.highlights} highlights · {graph.stats.edges} connections
                {graph.stats.embedded < graph.stats.highlights &&
                  ` · ${graph.stats.highlights - graph.stats.embedded} not yet indexed`}
              </p>
            )}
          </div>

          {embeddingSync.syncing && (
            <div className="mb-4 text-xs" style={{ color: 'var(--text-tertiary)' }}>
              Indexing highlights for the web…
              {embeddingSync.remaining !== null && embeddingSync.total > 0 &&
                ` ${Math.max(embeddingSync.total - (embeddingSync.remaining ?? 0), 0)}/${embeddingSync.total}`}
            </div>
          )}

          {error && (
            <div className="glass-card p-6 mb-6 text-sm" style={{ color: 'var(--text-secondary)' }}>
              {error}
              <button
                onClick={() => load()}
                className="ml-3 px-3 py-1 text-sm bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded hover:bg-blue-200 dark:hover:bg-blue-800 transition"
              >
                Retry
              </button>
            </div>
          )}

          <div className="grid lg:grid-cols-[1fr,340px] gap-6">
            <div className="glass-card p-3 sm:p-4">
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Highlight nodes containing…"
                  className="input-boxed-elegant !py-2 flex-1 min-w-[180px]"
                />
                <button
                  onClick={() => fitRef.current?.()}
                  className="px-3 py-2 text-sm rounded-lg transition"
                  style={{ background: 'var(--surface-hover)', color: 'var(--text-secondary)' }}
                >
                  Fit view
                </button>
                <button
                  onClick={() => load(true)}
                  className="px-3 py-2 text-sm rounded-lg transition"
                  style={{ background: 'var(--surface-hover)', color: 'var(--text-secondary)' }}
                >
                  Rebuild
                </button>
              </div>
              <div
                ref={containerRef}
                className="relative w-full rounded-xl overflow-hidden"
                style={{ height: 'min(70vh, 640px)', background: 'var(--surface-hover)' }}
              >
                {loading && (
                  <div className="absolute inset-0 flex items-center justify-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
                    Weaving the web…
                  </div>
                )}
                <canvas ref={canvasRef} className="w-full h-full touch-none cursor-grab" />
              </div>
              {graph && graph.categories.length > 0 && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3">
                  {graph.categories.map((c) => (
                    <span key={c.id} className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      <span
                        className="inline-block w-2.5 h-2.5 rounded-full"
                        style={{ background: categoryColor.get(c.id) }}
                      />
                      {c.name}
                    </span>
                  ))}
                  <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: NO_CATEGORY_COLOR }} />
                    Uncategorized
                  </span>
                </div>
              )}
            </div>

            <div>
              {selected ? (
                <div className="glass-card p-5">
                  <p className="text-base mb-3 whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>
                    {selected.text}
                  </p>
                  {(selected.author || selected.source) && (
                    <p className="text-sm mb-3" style={{ color: 'var(--text-tertiary)' }}>
                      {selected.author}
                      {selected.author && selected.source && ' • '}
                      {selected.source}
                    </p>
                  )}
                  <h3 className="text-sm font-semibold mt-4 mb-2" style={{ color: 'var(--text-primary)' }}>
                    Connected highlights
                  </h3>
                  {selectedNeighbors.length === 0 && (
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                      No strong connections. {!selected.hasEmbedding && 'This highlight is not indexed yet.'}
                    </p>
                  )}
                  <div className="space-y-2">
                    {selectedNeighbors.map(({ idx, w }) => (
                      <button
                        key={graph!.nodes[idx].id}
                        onClick={() => centerOn(idx)}
                        className="block w-full text-left p-3 rounded-lg transition text-sm hover:opacity-80"
                        style={{ background: 'var(--surface-hover)', color: 'var(--text-secondary)' }}
                      >
                        <span className="block text-xs mb-1" style={{ color: 'var(--text-tertiary)' }}>
                          {(w * 100).toFixed(0)}% connected
                        </span>
                        {graph!.nodes[idx].text.replace(/\s+/g, ' ').slice(0, 160)}
                        {graph!.nodes[idx].text.length > 160 && '…'}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="glass-card p-8 text-center">
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                    Click a dot to read the highlight and see what it connects to.
                    Scroll to zoom, drag to pan.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}
