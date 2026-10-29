import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, DocumentTab } from '../types'
import { enhanceMarkdown, renderMarkdown } from '../lib/markdown'
import { activateReaderFindMatch, clearReaderFind, highlightReaderFind } from '../lib/readerFind'
import { applyAnnotations, applyCollapsedSections, captureTextAnchor, type ReadingRecord, type TextAnchor } from '../lib/readingState'
import type { NoteIndex } from '../lib/noteIndex'
import { enhanceNotes } from '../lib/noteRendering'
import type { ReaderImage } from './ReaderOverlays'

interface MarkdownPreviewProps {
  tab: DocumentTab
  active: boolean
  settings: AppSettings
  findQuery?: string
  findNavigation?: { sequence: number; direction: 1 | -1 }
  onFindStatus?: (current: number, total: number) => void
  onOpenLink?: (documentPath: string | null, href: string) => void
  onToggleTask?: (id: string, sourceLine: number, checked: boolean) => void
  onScroll?: (id: string, scrollTop: number) => void
  onCopyCode?: (code: string) => void
  onReady?: (id: string) => void
  restoreScroll?: boolean
  notes?: NoteIndex
  relativePath?: string
  assetDocumentPath?: (path: string) => string | null
  reading?: ReadingRecord | null
  onOpenNote?: (target: string, origin: string, wiki: boolean) => void
  onAddAnnotation?: (anchor: TextAnchor, color: 'yellow' | 'green' | 'pink') => void
  onSelectAnnotation?: (id: string) => void
  onCollapsed?: (ids: string[]) => void
  onImage?: (images: ReaderImage[], initial: number) => void
  onProgress?: (id: string, top: number, progress: number) => void
  onAskAgent?: (text: string) => void
}

export const MarkdownPreview = memo(function MarkdownPreview({
  tab, active, settings, findQuery = '', findNavigation, onFindStatus, onOpenLink,
  onToggleTask, onScroll, onCopyCode, onReady, restoreScroll = true,
  notes, relativePath = '', assetDocumentPath, reading, onOpenNote, onAddAnnotation, onSelectAnnotation, onCollapsed, onImage, onProgress, onAskAgent,
}: MarkdownPreviewProps) {
  const paneRef = useRef<HTMLElement>(null)
  const containerRef = useRef<HTMLElement>(null)
  const findQueryRef = useRef(findQuery)
  const findMatchesRef = useRef<HTMLElement[]>([])
  const findIndexRef = useRef(-1)
  const userScrolledSinceActivationRef = useRef(false)
  const enhancementGenerationRef = useRef(0)
  const readingRef = useRef(reading)
  readingRef.current = reading
  const [selection, setSelection] = useState<{ anchor: TextAnchor; x: number; y: number } | null>(null)
  const [previewSource, setPreviewSource] = useState(() => ({ tabId: tab.id, content: tab.content }))
  const renderedContent = previewSource.tabId === tab.id ? previewSource.content : tab.content
  const previewIsStale = renderedContent !== tab.content
  const html = useMemo(() => renderMarkdown(renderedContent), [renderedContent])
  const renderedMarkup = useMemo(() => ({ __html: html }), [html])
  findQueryRef.current = findQuery

  useEffect(() => {
    const updateSource = () => setPreviewSource((current) => (
      current.tabId === tab.id && current.content === tab.content
        ? current
        : { tabId: tab.id, content: tab.content }
    ))
    if (tab.mode !== 'split' || previewSource.tabId !== tab.id) {
      updateSource()
      return
    }
    const timer = window.setTimeout(updateSource, 280)
    return () => window.clearTimeout(timer)
  }, [previewSource.tabId, tab.content, tab.id, tab.mode])

  useEffect(() => {
    containerRef.current?.querySelectorAll<HTMLInputElement>('input[data-margin-task-line]').forEach((checkbox) => {
      checkbox.disabled = previewIsStale
    })
  }, [html, previewIsStale])

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
    const generation = ++enhancementGenerationRef.current
    const container = containerRef.current
    container.innerHTML = html
    if (notes) enhanceNotes(container, notes, relativePath)
    applyCollapsedSections(container, readingRef.current?.collapsed || [])
    applyAnnotations(container, readingRef.current?.annotations || [])
    userScrolledSinceActivationRef.current = false
    const timer = window.setTimeout(async () => {
      if (cancelled) return
      const isCurrent = () => !cancelled
        && generation === enhancementGenerationRef.current
        && containerRef.current === container
        && container.isConnected
      await enhanceMarkdown(container, tab.path, settings, { isCurrent, assetDocumentPath })
      if (!cancelled) {
        if (restoreScroll && !userScrolledSinceActivationRef.current && paneRef.current) paneRef.current.scrollTop = Math.max(0, tab.readerScrollTop)
        onReady?.(tab.id)
        refreshFind(findQueryRef.current)
      }
    }, 30)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [active, html, onReady, restoreScroll, settings, tab.id, tab.path, notes, relativePath, assetDocumentPath])

  useEffect(() => {
    if (!containerRef.current) return
    applyAnnotations(containerRef.current, reading?.annotations || [])
    applyCollapsedSections(containerRef.current, reading?.collapsed || [])
    if (findQueryRef.current) refreshFind(findQueryRef.current, findIndexRef.current)
  }, [reading?.annotations, reading?.collapsed, html])

  useEffect(() => { setSelection(null) }, [tab.id])

  useEffect(() => {
    if (!active || !containerRef.current) return
    const timer = window.setTimeout(() => refreshFind(findQuery), 45)
    return () => window.clearTimeout(timer)
  }, [active, findQuery, html, tab.id])

  useEffect(() => {
    const container = containerRef.current
    if (!active || !container) return
    const update = () => { if (findQueryRef.current) refreshFind(findQueryRef.current, findIndexRef.current) }
    // details.toggle does not bubble; capture it so opening/closing a callout
    // updates visible search matches without requiring the query to change.
    container.addEventListener('toggle', update, true)
    return () => container.removeEventListener('toggle', update, true)
  }, [active, tab.id])

  useEffect(() => {
    if (!active || !findNavigation || !findQuery) return
    refreshFind(findQuery, findIndexRef.current + findNavigation.direction)
  }, [active, findNavigation?.sequence])

  useEffect(() => () => {
    if (containerRef.current) clearReaderFind(containerRef.current)
  }, [])

  useEffect(() => {
    if (!active || !restoreScroll || !paneRef.current) return
    const frame = window.requestAnimationFrame(() => {
      if (paneRef.current) paneRef.current.scrollTop = Math.max(0, tab.readerScrollTop)
    })
    return () => window.cancelAnimationFrame(frame)
    // Restore only when this document becomes visible; live scrolling remains owned by the pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, restoreScroll, tab.id])

  const handleClick = (event: React.MouseEvent) => {
    const target = event.target as HTMLElement
    const fold = target.closest<HTMLButtonElement>('[data-margin-fold]')
    if (fold) {
      const ids = new Set(reading?.collapsed || [])
      const id = fold.dataset.marginFold!
      if (ids.has(id)) ids.delete(id); else ids.add(id)
      onCollapsed?.([...ids])
      return
    }
    const image = target.closest<HTMLImageElement>('img[src]')
    if (image && containerRef.current) {
      event.preventDefault()
      const all = Array.from(containerRef.current.querySelectorAll<HTMLImageElement>('img[src]'))
      onImage?.(all.map((img) => ({ src: img.src, alt: img.alt })), all.indexOf(image))
      return
    }
    const highlight = target.closest<HTMLElement>('[data-margin-annotation]')
    if (highlight && !window.getSelection()?.toString()) onSelectAnnotation?.(highlight.dataset.marginAnnotation!)
    const checkbox = (event.target as HTMLElement).closest<HTMLInputElement>('input[data-margin-task-line]')
    if (checkbox) {
      if (previewIsStale) {
        event.preventDefault()
        checkbox.checked = !checkbox.checked
        return
      }
      const sourceLine = Number(checkbox.dataset.marginTaskLine)
      if (Number.isSafeInteger(sourceLine)) onToggleTask?.(tab.id, sourceLine, checkbox.checked)
      return
    }
    const copyButton = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-margin-copy-code]')
    if (copyButton) {
      event.preventDefault()
      const code = copyButton.parentElement?.querySelector('code')?.textContent ?? ''
      if (code) onCopyCode?.(code)
      return
    }
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]')
    if (!anchor) return
    if (anchor.dataset.marginNote != null) {
      event.preventDefault()
      onOpenNote?.(anchor.dataset.marginNote, anchor.dataset.marginNoteOrigin || relativePath, anchor.dataset.marginNoteKind !== 'markdown')
      return
    }
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

  const captureSelection = () => {
    if (tab.mode !== 'read' || !containerRef.current) return
    const chosen = window.getSelection()
    const anchor = captureTextAnchor(containerRef.current, chosen)
    if (!anchor || !chosen?.rangeCount) { setSelection(null); return }
    const bounds = chosen.getRangeAt(0).getBoundingClientRect()
    setSelection({ anchor, x: Math.max(12, Math.min(window.innerWidth - 345, bounds.left)), y: Math.max(12, Math.min(window.innerHeight - 54, bounds.top - 44)) })
  }

  return (
    <section
      ref={paneRef}
      className={`preview-pane reader-theme-${settings.readerTheme} ${active ? 'is-active' : ''}`}
      role="region"
      aria-label="Rendered preview"
      aria-hidden={!active}
      aria-busy={previewIsStale}
      style={style}
      data-preview-id={tab.id}
      onScroll={(event) => {
        setSelection(null)
        if (event.nativeEvent.isTrusted) userScrolledSinceActivationRef.current = true
        onScroll?.(tab.id, event.currentTarget.scrollTop)
        const pane = event.currentTarget
        const top = pane.scrollTop
        const max = pane.scrollHeight - pane.clientHeight
        onProgress?.(tab.id, top, max > 0 ? Math.min(1, top / max) : 1)
      }}
    >
      <article
        ref={containerRef}
        className={`markdown-body reader-font-${settings.readerFont}`}
        dangerouslySetInnerHTML={renderedMarkup}
        onClick={handleClick}
        onMouseUp={() => requestAnimationFrame(captureSelection)}
        onKeyUp={(event) => { if (event.shiftKey) captureSelection() }}
      />
      {selection && <div className="selection-tools" role="toolbar" aria-label="Annotate selection" style={{ left: selection.x, top: selection.y }} onMouseDown={(event) => event.preventDefault()}>
        <button onClick={() => { onAddAnnotation?.(selection.anchor, 'yellow'); setSelection(null); window.getSelection()?.removeAllRanges() }}>Highlight</button>
        <button onClick={() => { onAddAnnotation?.(selection.anchor, 'green'); setSelection(null); window.getSelection()?.removeAllRanges() }}>Add note</button>
        {onAskAgent && <button onClick={() => { onAskAgent(selection.anchor.quote); setSelection(null); window.getSelection()?.removeAllRanges() }}>Ask agent</button>}
        <button onClick={() => { void window.margin.copyText(selection.anchor.quote); setSelection(null) }}>Copy</button>
        <button aria-label="Dismiss selection tools" onClick={() => setSelection(null)}>×</button>
      </div>}
    </section>
  )
})
