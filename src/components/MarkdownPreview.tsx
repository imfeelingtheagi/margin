import { memo, useEffect, useMemo, useRef } from 'react'
import type { AppSettings, DocumentTab } from '../types'
import { enhanceMarkdown, renderMarkdown } from '../lib/markdown'
import { activateReaderFindMatch, clearReaderFind, highlightReaderFind } from '../lib/readerFind'

interface MarkdownPreviewProps {
  tab: DocumentTab
  active: boolean
  settings: AppSettings
  findQuery?: string
  findNavigation?: { sequence: number; direction: 1 | -1 }
  onFindStatus?: (current: number, total: number) => void
  onOpenLink?: (documentPath: string | null, href: string) => void
}

export const MarkdownPreview = memo(function MarkdownPreview({
  tab, active, settings, findQuery = '', findNavigation, onFindStatus, onOpenLink,
}: MarkdownPreviewProps) {
  const containerRef = useRef<HTMLElement>(null)
  const findQueryRef = useRef(findQuery)
  const findMatchesRef = useRef<HTMLElement[]>([])
  const findIndexRef = useRef(-1)
  const html = useMemo(() => renderMarkdown(tab.content), [tab.content])
  findQueryRef.current = findQuery

  const refreshFind = (query: string, requestedIndex = 0) => {
    const container = containerRef.current
    if (!container) return
    findMatchesRef.current = highlightReaderFind(container, query)
    findIndexRef.current = activateReaderFindMatch(findMatchesRef.current, requestedIndex)
    onFindStatus?.(findIndexRef.current + 1, findMatchesRef.current.length)
  }

  useEffect(() => {
    if (!active || !containerRef.current) return
    let cancelled = false
    const container = containerRef.current
    const timer = window.setTimeout(async () => {
      if (cancelled) return
      await enhanceMarkdown(container, tab.path, settings)
      if (!cancelled) refreshFind(findQueryRef.current)
    }, 30)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [active, html, settings, tab.path])

  useEffect(() => {
    if (!active || !containerRef.current) return
    const timer = window.setTimeout(() => refreshFind(findQuery), 45)
    return () => window.clearTimeout(timer)
  }, [active, findQuery, html, tab.id])

  useEffect(() => {
    if (!active || !findNavigation || !findQuery) return
    refreshFind(findQuery, findIndexRef.current + findNavigation.direction)
  }, [active, findNavigation?.sequence])

  useEffect(() => () => {
    if (containerRef.current) clearReaderFind(containerRef.current)
  }, [])

  const handleClick = (event: React.MouseEvent) => {
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]')
    if (!anchor) return
    const href = anchor.getAttribute('href') || ''
    if (href.startsWith('#')) {
      event.preventDefault()
      let headingId = href.slice(1)
      try { headingId = decodeURIComponent(headingId) } catch { /* keep the literal fragment */ }
      if (headingId) containerRef.current?.querySelector<HTMLElement>(`#${CSS.escape(headingId)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else if (/^(?:https?:\/\/|mailto:)/i.test(href)) {
      event.preventDefault()
      void window.margin.openExternal(href)
    } else {
      event.preventDefault()
      if (!/^[a-z][a-z\d+.-]*:/i.test(href)) onOpenLink?.(tab.path, href)
    }
  }

  const style = {
    '--reader-size': `${settings.fontSize}px`,
    '--reader-leading': settings.lineHeight,
    '--reader-width': `${settings.contentWidth}px`,
    '--custom-bg': settings.customBackground,
    '--custom-text': settings.customText,
    '--custom-accent': settings.customAccent,
  } as React.CSSProperties

  return (
    <section
      className={`preview-pane reader-theme-${settings.readerTheme} ${active ? 'is-active' : ''}`}
      aria-hidden={!active}
      style={style}
      data-preview-id={tab.id}
    >
      <article
        ref={containerRef}
        className={`markdown-body reader-font-${settings.readerFont}`}
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={handleClick}
      />
    </section>
  )
})
