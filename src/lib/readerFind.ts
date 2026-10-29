const MATCH_SELECTOR = 'mark[data-margin-reader-find]'
const matchFragments = new WeakMap<HTMLElement, HTMLElement[]>()

export function clearReaderFind(container: HTMLElement) {
  const parents = new Set<Node>()
  container.querySelectorAll<HTMLElement>(MATCH_SELECTOR).forEach((mark) => {
    const parent = mark.parentNode
    if (!parent) return
    parents.add(parent)
    parent.replaceChild(mark.ownerDocument.createTextNode(mark.textContent ?? ''), mark)
  })
  parents.forEach((parent) => parent.normalize())
}

export function highlightReaderFind(container: HTMLElement, query: string): HTMLElement[] {
  clearReaderFind(container)
  if (!query) return []

  const ownerDocument = container.ownerDocument
  const filter = ownerDocument.defaultView?.NodeFilter ?? NodeFilter
  const walker = ownerDocument.createTreeWalker(container, filter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent || !node.nodeValue) return filter.FILTER_REJECT
      if (parent.closest('button, script, style, textarea, svg, [hidden], [aria-hidden="true"]')) return filter.FILTER_REJECT
      for (let ancestor: HTMLElement | null = parent; ancestor && ancestor !== container; ancestor = ancestor.parentElement) {
        if (ancestor.tagName !== 'DETAILS' || ancestor.hasAttribute('open')) continue
        const summary = Array.from(ancestor.children).find((child) => child.tagName === 'SUMMARY')
        if (!summary?.contains(node)) return filter.FILTER_REJECT
      }
      return filter.FILTER_ACCEPT
    },
  })
  const runs: Array<{ block: Element | null; text: string; nodes: Array<{ node: Text; from: number; to: number }> }> = []
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const block = node.parentElement?.closest('p, li, h1, h2, h3, h4, h5, h6, pre, td, th, blockquote, summary, dt, dd') || null
    let run = runs.at(-1)
    if (!run || run.block !== block) { run = { block, text: '', nodes: [] }; runs.push(run) }
    run.nodes.push({ node, from: run.text.length, to: run.text.length + node.length })
    run.text += node.data
  }

  const matcher = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  const matches: HTMLElement[] = []
  for (const run of runs) {
    const textMatches = Array.from(run.text.matchAll(matcher))
    if (!textMatches.length) continue
    const fragments = textMatches.map(() => [] as HTMLElement[])
    let firstMatch = 0
    for (const entry of run.nodes) {
      while (firstMatch < textMatches.length && textMatches[firstMatch].index + textMatches[firstMatch][0].length <= entry.from) firstMatch += 1
      if (firstMatch >= textMatches.length || textMatches[firstMatch].index >= entry.to) continue
      const fragment = ownerDocument.createDocumentFragment()
      let cursor = 0
      for (let index = firstMatch; index < textMatches.length && textMatches[index].index < entry.to; index += 1) {
        const textMatch = textMatches[index]
        const from = Math.max(entry.from, textMatch.index) - entry.from
        const to = Math.min(entry.to, textMatch.index + textMatch[0].length) - entry.from
        fragment.append(entry.node.data.slice(cursor, from))
        const mark = ownerDocument.createElement('mark')
        mark.dataset.marginReaderFind = ''
        mark.textContent = entry.node.data.slice(from, to)
        fragment.append(mark)
        fragments[index].push(mark)
        cursor = to
      }
      fragment.append(entry.node.data.slice(cursor))
      entry.node.replaceWith(fragment)
    }
    for (const parts of fragments) {
      if (!parts.length) continue
      matchFragments.set(parts[0], parts)
      matches.push(parts[0])
    }
  }
  return matches
}

export function activateReaderFindMatch(matches: HTMLElement[], index: number): number {
  matches.forEach((match) => {
    for (const fragment of matchFragments.get(match) || [match]) {
      fragment.classList.remove('is-current')
      fragment.removeAttribute('aria-current')
    }
  })
  if (!matches.length) return -1
  const normalizedIndex = ((index % matches.length) + matches.length) % matches.length
  const match = matches[normalizedIndex]
  for (const fragment of matchFragments.get(match) || [match]) fragment.classList.add('is-current')
  match.setAttribute('aria-current', 'true')
  match.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  return normalizedIndex
}
