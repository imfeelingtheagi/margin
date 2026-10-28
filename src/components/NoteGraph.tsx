import { useMemo, useState } from 'react'
import { Minus, Plus, RotateCcw, X } from 'lucide-react'
import { resolveNote, type NoteIndex } from '../lib/noteIndex'
import { useModal } from '../lib/useModal'

export default function NoteGraph({ index, currentPath, onOpenNote, onClose }: {
  index: NoteIndex; currentPath: string; onOpenNote: (path: string, origin: string, wiki: boolean) => void; onClose: () => void
}) {
  const ref = useModal(onClose)
  const [query, setQuery] = useState('')
  const [local, setLocal] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [hovered, setHovered] = useState<string | null>(null)
  const graph = useMemo(() => {
    const edges: Array<{ from: string; to: string }> = []
    const edgeKeys = new Set<string>()
    for (const note of index.notes) for (const link of note.links.slice(0, 200)) {
      const target = resolveNote(index, link.target, note.relativePath, link.wiki)?.note.relativePath
      if (!target || target === note.relativePath) continue
      const key = [note.relativePath, target].sort().join('\0')
      if (!edgeKeys.has(key)) { edgeKeys.add(key); edges.push({ from: note.relativePath, to: target }) }
    }
    const neighbors = new Set([currentPath])
    edges.forEach((edge) => { if (edge.from === currentPath) neighbors.add(edge.to); if (edge.to === currentPath) neighbors.add(edge.from) })
    const matching = index.notes.filter((note) => (!local || neighbors.has(note.relativePath)) && `${note.title} ${note.relativePath} ${note.tags.join(' ')}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      .sort((a, b) => Number(b.relativePath === currentPath) - Number(a.relativePath === currentPath))
    const nodes = matching.slice(0, 250).map((note, i, all) => ({
      ...note, x: 450 + Math.cos(i * 2.39996) * (all.length <= 1 ? 0 : Math.sqrt(i / (all.length - 1))) * 330,
      y: 290 + Math.sin(i * 2.39996) * (all.length <= 1 ? 0 : Math.sqrt(i / (all.length - 1))) * 230, degree: 0,
    }))
    const byPath = new Map(nodes.map((node) => [node.relativePath, node]))
    const visibleEdges = edges.filter((edge) => byPath.has(edge.from) && byPath.has(edge.to))
    visibleEdges.forEach((edge) => { byPath.get(edge.from)!.degree += 1; byPath.get(edge.to)!.degree += 1 })
    // Static layout: no running simulation, workers, timers, or graph dependency.
    for (let iteration = 0; iteration < 35; iteration += 1) {
      for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i]
        for (let j = i + 1; j < nodes.length; j += 1) {
          const other = nodes[j]
          const dx = node.x - other.x || 0.1
          const dy = node.y - other.y || 0.1
          const distance = Math.max(40, dx * dx + dy * dy)
          const force = Math.min(0.12, 70 / distance)
          node.x += dx * force; node.y += dy * force
          other.x -= dx * force; other.y -= dy * force
        }
      }
      for (const edge of visibleEdges) {
        const from = byPath.get(edge.from)!, to = byPath.get(edge.to)!
        const dx = to.x - from.x, dy = to.y - from.y
        const distance = Math.hypot(dx, dy) || 1
        const force = (distance - 130) / distance * 0.025
        from.x += dx * force; from.y += dy * force
        to.x -= dx * force; to.y -= dy * force
      }
      nodes.forEach((node) => { node.x = Math.min(840, Math.max(60, node.x)); node.y = Math.min(540, Math.max(40, node.y)) })
    }
    return { nodes, byPath, edges: visibleEdges, total: matching.length }
  }, [index, currentPath, query, local])
  const nearby = new Set([hovered])
  graph.edges.forEach((edge) => { if (edge.from === hovered) nearby.add(edge.to); if (edge.to === hovered) nearby.add(edge.from) })
  return <section ref={ref} className="reader-modal graph-modal" role="dialog" aria-modal="true" aria-label="Note graph">
    <header><div><h2>Note graph</h2><span>{graph.nodes.length} notes · {graph.edges.length} connections{graph.total > 250 ? ' · showing the first 250 matching notes' : ''}</span></div><button className="icon-button" onClick={onClose} aria-label="Close graph"><X /></button></header>
    <div className="graph-controls"><input aria-label="Filter graph" placeholder="Filter notes, paths, or tags…" value={query} onChange={(event) => setQuery(event.target.value)} /><label><input type="checkbox" checked={local} onChange={(event) => setLocal(event.target.checked)} /> Active note’s neighborhood</label><button className="icon-button" aria-label="Zoom graph out" onClick={() => setZoom((value) => Math.max(.5, value / 1.2))}><Minus /></button><button className="icon-button" aria-label="Zoom graph in" onClick={() => setZoom((value) => Math.min(4, value * 1.2))}><Plus /></button><button className="icon-button" aria-label="Reset graph view" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }}><RotateCcw /></button></div>
    <div className="graph-canvas"><svg viewBox="0 0 900 580" aria-label="Interactive note connections" onPointerDown={(event) => { if (event.target === event.currentTarget) event.currentTarget.setPointerCapture(event.pointerId) }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId) && event.buttons) setPan((value) => ({ x: value.x + event.movementX, y: value.y + event.movementY })) }} onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }} onWheel={(event) => setZoom((value) => Math.min(4, Math.max(.5, value * (event.deltaY < 0 ? 1.08 : .92))))}>
      <g transform={`translate(${pan.x} ${pan.y}) translate(450 290) scale(${zoom}) translate(-450 -290)`}>
        {graph.edges.map((edge, i) => { const from = graph.byPath.get(edge.from)!, to = graph.byPath.get(edge.to)!; return <line key={i} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={hovered && (edge.from === hovered || edge.to === hovered) ? 'is-connected' : ''} /> })}
        {graph.nodes.map((node) => <g key={node.relativePath} className={`graph-node ${node.relativePath === currentPath ? 'is-current' : ''} ${hovered && !nearby.has(node.relativePath) ? 'is-dimmed' : ''}`} role="button" tabIndex={0} aria-label={`Open ${node.title}`} onClick={() => { onOpenNote(node.relativePath, '', true); onClose() }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenNote(node.relativePath, '', true); onClose() } }} onMouseEnter={() => setHovered(node.relativePath)} onMouseLeave={() => setHovered(null)} onFocus={() => setHovered(node.relativePath)} onBlur={() => setHovered(null)}><title>{node.relativePath}</title><circle cx={node.x} cy={node.y} r={19} aria-hidden="true" style={{ fill: 'transparent', stroke: 'none', pointerEvents: 'all' }} /><circle cx={node.x} cy={node.y} r={5 + Math.min(8, node.degree)} /><text x={node.x} y={node.y + 25} textAnchor="middle">{node.title.length > 26 ? `${node.title.slice(0, 25)}…` : node.title}</text></g>)}
      </g>
    </svg>{!graph.nodes.length && <p className="graph-empty">Open a folder with linked Markdown notes to explore their connections.</p>}</div>
    <footer>Click a note to open it. Drag the background to pan, scroll to zoom, or use the zoom buttons.</footer>
  </section>
}
