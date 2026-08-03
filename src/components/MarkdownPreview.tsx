import { useEffect, useMemo, useRef } from 'react'
import type { AppSettings, DocumentTab } from '../types'
import { enhanceMarkdown, renderMarkdown } from '../lib/markdown'

interface MarkdownPreviewProps {
  tab: DocumentTab
  active: boolean
  settings: AppSettings
}

export function MarkdownPreview({ tab, active, settings }: MarkdownPreviewProps) {
  const containerRef = useRef<HTMLElement>(null)
  const html = useMemo(() => renderMarkdown(tab.content), [tab.content])

  useEffect(() => {
    if (!active || !containerRef.current) return
    let cancelled = false
    const container = containerRef.current
    const timer = window.setTimeout(async () => {
      if (!cancelled) await enhanceMarkdown(container, tab.path, settings)
    }, 30)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [active, html, settings, tab.path])

  const handleClick = (event: React.MouseEvent) => {
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]')
    if (!anchor) return
    const href = anchor.getAttribute('href') || ''
    if (href.startsWith('#')) {
      event.preventDefault()
      let headingId = href.slice(1)
      try { headingId = decodeURIComponent(headingId) } catch { /* keep the literal fragment */ }
      if (headingId) containerRef.current?.querySelector<HTMLElement>(`#${CSS.escape(headingId)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else if (/^https?:\/\//i.test(href)) {
      event.preventDefault()
      void window.margin.openExternal(href)
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
}
