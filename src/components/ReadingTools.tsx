import { useMemo, useState } from 'react'
import { Bookmark, BookmarkCheck, ExternalLink, Highlighter, Link2, Network, RefreshCw, Tag, Trash2, X } from 'lucide-react'
import type { NoteIndex } from '../lib/noteIndex'
import { noteConnections } from '../lib/noteIndex'
import type { Annotation, ReadingLibrary, ReadingRecord } from '../lib/readingState'

interface Props {
  record: ReadingRecord | null
  library: ReadingLibrary
  notes: NoteIndex
  currentPath: string
  loading: boolean
  warning: string
  onClose: () => void
  onBookmark: () => void
  onOpenRecord: (record: ReadingRecord) => void
  onOpenNote: (target: string, origin: string, wiki: boolean) => void
  onRevealAnnotation: (id: string) => void
  onEditAnnotation: (id: string, patch: Partial<Pick<Annotation, 'note' | 'color'>>) => void
  onDeleteAnnotation: (id: string) => void
  onGraph: () => void
  onRefresh: () => void
}

export function ReadingTools(props: Props) {
  const [view, setView] = useState<'reading' | 'links' | 'tags'>('reading')
  const [tag, setTag] = useState('')
  const connections = useMemo(() => noteConnections(props.notes, props.currentPath), [props.notes, props.currentPath])
  const tags = useMemo(() => {
    const counts = new Map<string, number>()
    props.notes.notes.forEach((note) => note.tags.forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1)))
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [props.notes])
  const bookmarks = Object.values(props.library).filter((record) => record.bookmarked).sort((a, b) => b.updatedAt - a.updatedAt)
  return <aside className="reading-tools" aria-label="Reading tools and connections">
    <header><strong>Reading desk</strong><div><button className="icon-button" aria-label="Refresh note connections" onClick={props.onRefresh}><RefreshCw className={props.loading ? 'is-spinning' : ''} /></button><button className="icon-button" aria-label="Close reading tools" onClick={props.onClose}><X /></button></div></header>
    <div className="reading-tool-tabs" role="tablist" aria-label="Reading desk sections">
      {(['reading', 'links', 'tags'] as const).map((item) => <button key={item} role="tab" aria-selected={view === item} aria-controls={`reading-desk-${item}`} id={`reading-desk-tab-${item}`} tabIndex={view === item ? 0 : -1} onClick={() => setView(item)} onKeyDown={(event) => {
        const items = ['reading', 'links', 'tags'] as const
        const at = items.indexOf(item)
        const next = event.key === 'ArrowRight' ? items[(at + 1) % 3] : event.key === 'ArrowLeft' ? items[(at + 2) % 3] : null
        if (next) { event.preventDefault(); setView(next); requestAnimationFrame(() => document.getElementById(`reading-desk-tab-${next}`)?.focus()) }
      }}>{item === 'reading' ? <Highlighter /> : item === 'links' ? <Link2 /> : <Tag />}{item === 'reading' ? 'Reading' : item === 'links' ? 'Links' : 'Tags'}</button>)}
    </div>
    <div className="reading-tools-scroll" role="tabpanel" id={`reading-desk-${view}`} aria-labelledby={`reading-desk-tab-${view}`}>
      {view === 'reading' && <>
        {props.record && <section className="reading-section">
          <button className={`bookmark-action ${props.record.bookmarked ? 'is-active' : ''}`} onClick={props.onBookmark}>{props.record.bookmarked ? <BookmarkCheck /> : <Bookmark />}{props.record.bookmarked ? 'Bookmarked' : 'Bookmark document'}</button>
          <div className="reading-progress-label"><span>Reading progress</span><strong>{Math.round(props.record.progress * 100)}%</strong></div>
          <progress max="1" value={props.record.progress} aria-label="Reading progress" />
        </section>}
        <section className="reading-section"><h3>Highlights & notes <span>{props.record?.annotations.length || 0}</span></h3>
          {!props.record?.annotations.length && <p className="desk-empty">Select text in Read mode to highlight it or attach a note. Your Markdown stays untouched.</p>}
          {props.record?.annotations.map((annotation) => <article className={`annotation-card highlight-${annotation.color}`} key={annotation.id} data-annotation-id={annotation.id}>
            <button className="annotation-quote" onClick={() => props.onRevealAnnotation(annotation.id)} title="Jump to highlight">“{annotation.quote}”</button>
            <textarea aria-label="Annotation note" placeholder="Add a note…" value={annotation.note} maxLength={20_000} onChange={(event) => props.onEditAnnotation(annotation.id, { note: event.target.value })} />
            <div className="annotation-actions"><div>{(['yellow', 'green', 'pink'] as const).map((color) => <button key={color} className={`highlight-color color-${color}`} aria-label={`${color} highlight`} aria-pressed={annotation.color === color} onClick={() => props.onEditAnnotation(annotation.id, { color })} />)}</div><button className="icon-button" aria-label="Delete annotation" onClick={() => props.onDeleteAnnotation(annotation.id)}><Trash2 /></button></div>
          </article>)}
        </section>
        <section className="reading-section"><h3>Bookmarks <span>{bookmarks.length}</span></h3>
          {!bookmarks.length && <p className="desk-empty">Keep frequently read documents here.</p>}
          {bookmarks.map((record) => <button className="desk-note-link" key={record.key} title={record.path || record.name} onClick={() => props.onOpenRecord(record)}><Bookmark /><span>{record.name}<small>{Math.round(record.progress * 100)}% read</small></span></button>)}
        </section>
      </>}
      {view === 'links' && <>
        <section className="reading-section"><button className="bookmark-action" onClick={props.onGraph}><Network /> Explore note graph</button><p className="desk-empty">{props.notes.notes.length.toLocaleString()} indexed notes{props.loading ? ' · Refreshing…' : ''}</p>{props.warning && <p className="desk-warning">{props.warning}</p>}</section>
        <section className="reading-section"><h3>Backlinks <span>{connections.backlinks.length}</span></h3>
          {!connections.backlinks.length && <p className="desk-empty">Notes that link to this document appear here.</p>}
          {connections.backlinks.map(({ note, link }, i) => <button className="desk-note-link" key={`${note.relativePath}-${i}`} onClick={() => props.onOpenNote(note.relativePath, '', true)}><Link2 /><span>{note.title}<small>{note.relativePath} · line {link.line}</small></span></button>)}
        </section>
        <section className="reading-section"><h3>Outgoing links <span>{connections.outgoing.length}</span></h3>
          {!connections.outgoing.length && <p className="desk-empty">Use [[note name]], [[note#heading]], or standard Markdown links.</p>}
          {connections.outgoing.map(({ link, resolved }, i) => <button className={`desk-note-link ${resolved ? '' : 'is-unresolved'}`} key={i} onClick={() => props.onOpenNote(link.target, props.currentPath, link.wiki)}><ExternalLink /><span>{resolved?.note.title || link.label}<small>{resolved ? resolved.note.relativePath : 'Missing note · click to create'}</small></span></button>)}
        </section>
      </>}
      {view === 'tags' && <>
        <section className="reading-section"><h3>Tags <span>{tags.length}</span></h3><div className="desk-tags">{tags.map(([name, count]) => <button key={name} aria-pressed={tag === name} onClick={() => setTag(tag === name ? '' : name)}>#{name} <span>{count}</span></button>)}</div>{!tags.length && <p className="desk-empty">Use #tags in prose or a tags list in front matter.</p>}</section>
        {tag && <section className="reading-section"><h3>#{tag}</h3>{props.notes.notes.filter((note) => note.tags.some((value) => value === tag || value.startsWith(`${tag}/`))).map((note) => <button className="desk-note-link" key={note.relativePath} onClick={() => props.onOpenNote(note.relativePath, '', true)}><Tag /><span>{note.title}<small>{note.relativePath}</small></span></button>)}</section>}
      </>}
    </div>
  </aside>
}
