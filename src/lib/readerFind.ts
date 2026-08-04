const MATCH_SELECTOR = 'mark[data-margin-reader-find]'

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
      if (parent.closest('script, style, textarea, svg, [aria-hidden="true"]')) return filter.FILTER_REJECT
      return filter.FILTER_ACCEPT
    },
  })
  const textNodes: Text[] = []
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text)

  const matcher = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  const matches: HTMLElement[] = []
  for (const textNode of textNodes) {
    const text = textNode.nodeValue ?? ''
    const textMatches = Array.from(text.matchAll(matcher))
    if (!textMatches.length) continue

    const fragment = ownerDocument.createDocumentFragment()
    let cursor = 0
    for (const textMatch of textMatches) {
      const matchAt = textMatch.index
      fragment.append(text.slice(cursor, matchAt))
      const mark = ownerDocument.createElement('mark')
      mark.dataset.marginReaderFind = ''
      mark.textContent = textMatch[0]
      fragment.append(mark)
      matches.push(mark)
      cursor = matchAt + textMatch[0].length
    }
    fragment.append(text.slice(cursor))
    textNode.replaceWith(fragment)
  }
  return matches
}

export function activateReaderFindMatch(matches: HTMLElement[], index: number): number {
  matches.forEach((match) => {
    match.classList.remove('is-current')
    match.removeAttribute('aria-current')
  })
  if (!matches.length) return -1
  const normalizedIndex = ((index % matches.length) + matches.length) % matches.length
  const match = matches[normalizedIndex]
  match.classList.add('is-current')
  match.setAttribute('aria-current', 'true')
  match.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  return normalizedIndex
}
