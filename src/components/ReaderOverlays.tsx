import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Maximize2, Minus, Plus, X } from 'lucide-react'
import type { AppSettings, DocumentTab } from '../types'
import type { NoteIndex } from '../lib/noteIndex'
import { enhanceMarkdown, renderMarkdown } from '../lib/markdown'
import { enhanceNotes } from '../lib/noteRendering'
import { presentationSlides } from '../lib/presentation'
import { useModal } from '../lib/useModal'

export interface ReaderImage { src: string; alt: string }
export function ImageViewer({ images, initial, onClose }: { images: ReaderImage[]; initial: number; onClose: () => void }) {
  const ref = useModal(onClose)
  const [at, setAt] = useState(initial)
  const [zoom, setZoom] = useState(1)
  const image = images[at]
  const step = (direction: number) => { setAt((value) => (value + direction + images.length) % images.length); setZoom(1) }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') { event.preventDefault(); step(1) }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1) }
      else if (event.key === '+' || event.key === '=') setZoom((value) => Math.min(5, value * 1.25))
      else if (event.key === '-') setZoom((value) => Math.max(.25, value / 1.25))
      else if (event.key === '0') setZoom(1)
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [images.length])
  if (!image) return null
  return <section ref={ref} className="reader-modal image-modal" role="dialog" aria-modal="true" aria-label="Image viewer">
    <header><span>{image.alt || 'Image'} <small>{at + 1} / {images.length}</small></span><div><button className="icon-button" aria-label="Zoom image out" onClick={() => setZoom((value) => Math.max(.25, value / 1.25))}><Minus /></button><span>{Math.round(zoom * 100)}%</span><button className="icon-button" aria-label="Zoom image in" onClick={() => setZoom((value) => Math.min(5, value * 1.25))}><Plus /></button><button className="icon-button" aria-label="Fit image" onClick={() => setZoom(1)}><Maximize2 /></button><button className="icon-button" aria-label="Close image viewer" onClick={onClose}><X /></button></div></header>
    <div className="image-stage"><img src={image.src} alt={image.alt} style={{ width: `${zoom * 100}%`, maxWidth: `${zoom * 1400}px`, maxHeight: zoom === 1 ? '100%' : undefined }} /></div>
    <footer><button disabled={images.length < 2} onClick={() => step(-1)}><ChevronLeft /> Previous</button><span>Scroll to pan · + / − to zoom · 0 to fit</span><button disabled={images.length < 2} onClick={() => step(1)}>Next <ChevronRight /></button></footer>
  </section>
}

export function PresentationViewer({ tab, settings, notes, relativePath, assetDocumentPath, onClose }: {
  tab: DocumentTab; settings: AppSettings; notes: NoteIndex; relativePath: string;
  assetDocumentPath: (path: string) => string | null; onClose: () => void
}) {
  const ref = useModal(onClose)
  const article = useRef<HTMLElement>(null)
  const slides = useMemo(() => presentationSlides(tab.content), [tab.content])
  const [at, setAt] = useState(0)
  const html = useMemo(() => ({ __html: renderMarkdown(slides[at] || '') }), [slides, at])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(event.key)) { event.preventDefault(); setAt((value) => Math.min(slides.length - 1, value + 1)) }
      else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)) { event.preventDefault(); setAt((value) => Math.max(0, value - 1)) }
      else if (event.key === 'Home') { event.preventDefault(); setAt(0) }
      else if (event.key === 'End') { event.preventDefault(); setAt(slides.length - 1) }
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [slides.length])
  useEffect(() => {
    if (!article.current) return
    const container = article.current
    let cancelled = false
    enhanceNotes(container, notes, relativePath)
    container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => { input.disabled = true })
    void enhanceMarkdown(container, tab.path, settings, { interactive: false, assetDocumentPath, isCurrent: () => !cancelled && container.isConnected }).catch(() => {})
    container.scrollTop = 0
    return () => { cancelled = true }
  }, [html, notes, tab.path, settings, relativePath, assetDocumentPath])
  return <section ref={ref} className={`reader-modal presentation-modal reader-theme-${settings.readerTheme}`} role="dialog" aria-modal="true" aria-label="Presentation" style={{ '--custom-bg': settings.customBackground, '--custom-text': settings.customText, '--custom-accent': settings.customAccent } as React.CSSProperties}>
    <header><span>{tab.name}</span><button className="icon-button" aria-label="Close presentation" onClick={onClose}><X /></button></header>
    <article ref={article} className={`markdown-body reader-font-${settings.readerFont}`} dangerouslySetInnerHTML={html} onClick={(event) => { const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a'); if (anchor) { event.preventDefault(); if (/^(?:https?:|mailto:)/.test(anchor.href)) void window.margin.openExternal(anchor.href) } }} />
    <footer><button aria-label="Previous slide" disabled={at === 0} onClick={() => setAt((value) => value - 1)}><ChevronLeft /> Previous</button><span aria-live="polite">{at + 1} / {slides.length}</span><button aria-label="Next slide" disabled={at === slides.length - 1} onClick={() => setAt((value) => value + 1)}>Next <ChevronRight /></button></footer>
  </section>
}
