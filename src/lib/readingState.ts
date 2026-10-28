import type { DocumentTab } from '../types'

export interface TextAnchor { quote: string; prefix: string; suffix: string; offset: number }
export interface Annotation extends TextAnchor { id: string; note: string; color: 'yellow' | 'green' | 'pink'; createdAt: number }
export interface ReadingRecord {
  key: string
  path: string | null
  name: string
  bookmarked: boolean
  scrollTop: number
  progress: number
  collapsed: string[]
  annotations: Annotation[]
  updatedAt: number
}
export type ReadingLibrary = Record<string, ReadingRecord>
const STORAGE_KEY = 'margin:reading-library:v1'
export const readingKey = (tab: Pick<DocumentTab, 'id' | 'path'>) => tab.path || `draft:${tab.id}`
export const emptyReadingRecord = (tab: Pick<DocumentTab, 'id' | 'path' | 'name'>): ReadingRecord => ({
  key: readingKey(tab), path: tab.path, name: tab.name, bookmarked: false,
  scrollTop: 0, progress: 0, collapsed: [], annotations: [], updatedAt: Date.now(),
})

export function loadReadingLibrary(): ReadingLibrary {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY) || '{}'
    if (raw.length > 4 * 1024 * 1024) return {}
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const library: ReadingLibrary = Object.create(null)
    for (const [key, item] of Object.entries(value).slice(0, 2000)) {
      if (!item || typeof item !== 'object' || key === '__proto__' || key.length > 4096) continue
      const record = item as Partial<ReadingRecord>
      if (typeof record.name !== 'string') continue
      library[key] = {
        key, path: typeof record.path === 'string' ? record.path : null,
        name: record.name.slice(0, 512), bookmarked: record.bookmarked === true,
        scrollTop: Number.isFinite(record.scrollTop) ? Math.max(0, record.scrollTop!) : 0,
        progress: Number.isFinite(record.progress) ? Math.min(1, Math.max(0, record.progress!)) : 0,
        collapsed: Array.isArray(record.collapsed) ? record.collapsed.filter((id): id is string => typeof id === 'string').slice(0, 1000) : [],
        annotations: Array.isArray(record.annotations) ? record.annotations.filter((a): a is Annotation =>
          a && typeof a.id === 'string' && typeof a.quote === 'string' && a.quote.length > 0 && a.quote.length <= 10_000
          && typeof a.prefix === 'string' && typeof a.suffix === 'string' && typeof a.note === 'string' && a.note.length <= 20_000
          && ['yellow', 'green', 'pink'].includes(a.color) && Number.isFinite(a.offset) && Number.isFinite(a.createdAt),
        ).slice(0, 200) : [],
        updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
      }
    }
    return library
  } catch { return {} }
}

export function saveReadingLibrary(library: ReadingLibrary) {
  // Retain annotations/bookmarks; prune only old, unmarked reading positions.
  const entries = Object.entries(library).sort((a, b) => b[1].updatedAt - a[1].updatedAt)
  const marked = entries.filter(([, record]) => record.bookmarked || record.annotations.length)
  if (marked.length > 2000) throw new Error('Your reading library is full. Remove older bookmarks or annotations to save more.')
  const cost = ([key, record]: [string, ReadingRecord]) => JSON.stringify(key).length + JSON.stringify(record).length + 2
  let used = 2 + marked.reduce((total, entry) => total + cost(entry), 0)
  if (used > 4 * 1024 * 1024) throw new Error('Your reading library is full. Remove older annotations to save more.')
  let positions: Array<[string, ReadingRecord]> = []
  for (const entry of entries) {
    if (entry[1].bookmarked || entry[1].annotations.length) continue
    if (positions.length >= 1000 || marked.length + positions.length >= 2000) break
    const bytes = cost(entry)
    if (used + bytes > 4 * 1024 * 1024) continue
    used += bytes
    positions.push(entry)
  }
  for (;;) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries([...marked, ...positions])))
      return
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError' || !positions.length) throw error
      // On real disk/quota pressure, release expendable positions before asking
      // the user to remove any of their bookmarks or annotations.
      positions = positions.slice(0, Math.floor(positions.length / 2))
    }
  }
}

function textMap(container: HTMLElement) {
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.nodeValue && !node.parentElement?.closest('button, script, style, svg, [aria-hidden="true"], .front-matter, .note-embed > a')
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    },
  })
  const nodes: Array<{ node: Text; from: number; to: number }> = []
  let text = ''
  let previousBlock: Element | null = null
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const block = node.parentElement?.closest('p, li, h1, h2, h3, h4, h5, h6, pre, td, th, blockquote, summary') || null
    if (text && block && previousBlock && block !== previousBlock && !/\s$/.test(text) && !/^\s/.test(node.data)) text += '\n'
    nodes.push({ node, from: text.length, to: text.length + node.length })
    text += node.data
    if (block) previousBlock = block
  }
  return { nodes, text }
}

export function captureTextAnchor(container: HTMLElement, selection: Selection | null): TextAnchor | null {
  if (!selection?.rangeCount || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null
  const { text, nodes } = textMap(container)
  let start = -1, end = -1
  for (const entry of nodes) {
    if (!range.intersectsNode(entry.node)) continue
    if (start < 0) {
      if (range.startContainer === entry.node) start = entry.from + range.startOffset
      else if (range.comparePoint(entry.node, 0) === 0) start = entry.from
    }
    if (range.endContainer === entry.node) end = entry.from + range.endOffset
    else if (range.comparePoint(entry.node, entry.node.length) === 0) end = entry.to
  }
  if (start < 0 || end <= start || end - start > 10_000) return null
  const quote = text.slice(start, end)
  if (!quote.trim()) return null
  return { quote, prefix: text.slice(Math.max(0, start - 48), start), suffix: text.slice(end, end + 48), offset: start }
}

export function locateAnchor(text: string, anchor: TextAnchor): number {
  if (text.slice(anchor.offset, anchor.offset + anchor.quote.length) === anchor.quote
    && text.slice(Math.max(0, anchor.offset - anchor.prefix.length), anchor.offset) === anchor.prefix
    && text.slice(anchor.offset + anchor.quote.length, anchor.offset + anchor.quote.length + anchor.suffix.length) === anchor.suffix) return anchor.offset
  let best = -1
  let bestScore = -Infinity
  for (let at = text.indexOf(anchor.quote); at >= 0; at = text.indexOf(anchor.quote, at + 1)) {
    const prefix = text.slice(Math.max(0, at - anchor.prefix.length), at)
    const suffix = text.slice(at + anchor.quote.length, at + anchor.quote.length + anchor.suffix.length)
    const score = (prefix === anchor.prefix ? 1_000_000 : 0) + (suffix === anchor.suffix ? 1_000_000 : 0) - Math.abs(at - anchor.offset)
    if (score > bestScore) { best = at; bestScore = score }
  }
  return best
}

export function applyAnnotations(container: HTMLElement, annotations: Annotation[]): Set<string> {
  const parents = new Set<Node>()
  container.querySelectorAll<HTMLElement>('mark[data-margin-annotation]').forEach((mark) => {
    if (mark.parentNode) parents.add(mark.parentNode)
    mark.replaceWith(...mark.childNodes)
  })
  parents.forEach((parent) => parent.normalize())
  const found = new Set<string>()
  const { text, nodes } = textMap(container)
  const plans = annotations.flatMap((annotation) => {
    const at = locateAnchor(text, annotation)
    if (at < 0) return []
    found.add(annotation.id)
    return [{ annotation, from: at, to: at + annotation.quote.length }]
  })
  // Split each text node once, preserving inline markup and overlapping ranges.
  for (const { node, from, to } of nodes) {
    const covering = plans.filter((plan) => plan.to > from && plan.from < to)
    if (!covering.length) continue
    const boundaries = [...new Set([0, node.length, ...covering.flatMap((plan) => [Math.max(0, plan.from - from), Math.min(node.length, plan.to - from)])])].sort((a, b) => a - b)
    const fragment = document.createDocumentFragment()
    for (let i = 1; i < boundaries.length; i += 1) {
      const start = boundaries[i - 1], end = boundaries[i]
      let segment: Node = document.createTextNode(node.data.slice(start, end))
      for (const { annotation } of covering.filter((plan) => plan.from <= from + start && plan.to >= from + end)) {
        const mark = document.createElement('mark')
        mark.dataset.marginAnnotation = annotation.id
        mark.className = `reading-highlight highlight-${annotation.color}`
        mark.title = annotation.note || 'Highlight'
        mark.append(segment)
        segment = mark
      }
      fragment.append(segment)
    }
    node.replaceWith(fragment)
  }
  return found
}

export function applyCollapsedSections(container: HTMLElement, collapsed: string[]) {
  const closed = new Set(collapsed)
  let hiddenBelow = 7
  for (const child of Array.from(container.children)) {
    if (!(child instanceof HTMLElement)) continue
    const level = /^H[1-6]$/.test(child.tagName) ? Number(child.tagName[1]) : null
    if (level != null && level <= hiddenBelow) hiddenBelow = 7
    child.hidden = hiddenBelow < 7
    if (level == null || !child.id) continue
    let button = child.querySelector<HTMLButtonElement>('[data-margin-fold]')
    if (!button) {
      button = document.createElement('button')
      button.type = 'button'
      button.dataset.marginFold = child.id
      button.className = 'section-fold'
      button.setAttribute('aria-label', `Collapse or expand ${child.textContent}`)
      child.prepend(button)
    }
    button.setAttribute('aria-expanded', String(!closed.has(child.id)))
    button.textContent = closed.has(child.id) ? '▸' : '▾'
    if (closed.has(child.id) && !child.hidden) hiddenBelow = level
  }
}
