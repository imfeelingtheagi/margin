import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'
import { searchPanelOpen } from '@codemirror/search'
import type { AppSettings } from '../types'
import type { NoteIndex } from './noteIndex'
import { renderableMarkdownBlocks, enhanceMarkdown } from './markdown'
import { enhanceNotes, type NoteEmbedBudget } from './noteRendering'

export const MAX_LIVE_DOCUMENT_LENGTH = 300_000
interface LiveContext {
  settings: AppSettings
  path: string | null
  relativePath: string
  notes: NoteIndex
  assetDocumentPath: (relativePath: string) => string | null
  onOpenNote: (target: string, origin: string, wiki: boolean) => void
}
interface Block { from: number; to: number; line: number; render: () => string }
const refresh = StateEffect.define<null>()

class MarkdownBlockWidget extends WidgetType {
  private allocations = new WeakMap<HTMLElement, NoteEmbedBudget>()
  constructor(readonly source: string, readonly block: Block, readonly context: LiveContext, readonly embedBudget: NoteEmbedBudget) { super() }
  eq(other: MarkdownBlockWidget) {
    return this.source === other.source && this.block.from === other.block.from && this.block.line === other.block.line && this.block.render === other.block.render && this.context === other.context
  }
  toDOM(view: EditorView) {
    const dom = document.createElement('div')
    dom.className = `cm-live-block markdown-body reader-font-${this.context.settings.readerFont}`
    dom.dataset.liveSourceLine = String(this.block.line)
    dom.innerHTML = this.block.render()
    const before = { ...this.embedBudget }
    enhanceNotes(dom, this.context.notes, this.context.relativePath, 0, new Set(), this.embedBudget)
    this.allocations.set(dom, { count: this.embedBudget.count - before.count, characters: this.embedBudget.characters - before.characters, htmlCharacters: (this.embedBudget.htmlCharacters || 0) - (before.htmlCharacters || 0) })
    dom.querySelectorAll<HTMLInputElement>('input[data-margin-task-line]').forEach((input) => { input.disabled = true })
    dom.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a')
      if (anchor && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        if (anchor.dataset.marginNote != null) this.context.onOpenNote(anchor.dataset.marginNote, anchor.dataset.marginNoteOrigin || this.context.relativePath, anchor.dataset.marginNoteKind !== 'markdown')
        else if (/^(?:https?:|mailto:)/i.test(anchor.href)) void window.margin.openExternal(anchor.href)
        return
      }
      event.preventDefault()
      const point = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(event.clientX, event.clientY)
      let offset = 0
      if (point && dom.contains(point.startContainer) && point.startContainer.nodeType === Node.TEXT_NODE) {
        const text = point.startContainer.textContent || ''
        const at = this.source.indexOf(text)
        if (at >= 0) offset = at + point.startOffset
      }
      view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, this.block.from + offset) }, userEvent: 'select.pointer' })
      view.focus()
    })
    queueMicrotask(() => {
      void enhanceMarkdown(dom, this.context.path, this.context.settings, {
        interactive: false,
        isCurrent: () => dom.isConnected && !dom.dataset.destroyed,
        assetDocumentPath: this.context.assetDocumentPath,
      }).then(() => { if (dom.isConnected) view.requestMeasure() }).catch(() => {})
    })
    return dom
  }
  destroy(dom: HTMLElement) {
    dom.dataset.destroyed = 'true'
    const allocation = this.allocations.get(dom)
    if (allocation) {
      this.embedBudget.count = Math.max(0, this.embedBudget.count - allocation.count)
      this.embedBudget.characters = Math.max(0, this.embedBudget.characters - allocation.characters)
      this.embedBudget.htmlCharacters = Math.max(0, (this.embedBudget.htmlCharacters || 0) - (allocation.htmlCharacters || 0))
      this.allocations.delete(dom)
    }
  }
  ignoreEvent() { return true }
}

function parseBlocks(state: EditorState): Block[] {
  if (state.doc.length > MAX_LIVE_DOCUMENT_LENGTH) return []
  return renderableMarkdownBlocks(state.doc.toString()).flatMap((block) => {
    if (block.fromLine < 1 || block.toLine < block.fromLine || block.fromLine > state.doc.lines) return []
    const from = state.doc.line(block.fromLine).from
    const to = state.doc.line(Math.min(state.doc.lines, block.toLine)).to
    return from < to ? [{ from, to, line: block.fromLine, render: block.render }] : []
  })
}

export function livePreview(context: LiveContext): Extension {
  const embedBudget: NoteEmbedBudget = { count: 0, characters: 0 }
  function decorations(state: EditorState, blocks: Block[]) {
    if (searchPanelOpen(state) || state.doc.length > MAX_LIVE_DOCUMENT_LENGTH) return Decoration.none
    const ranges = blocks.filter((block) => !state.selection.ranges.some((selection) => selection.from <= block.to && selection.to >= block.from))
      .map((block) => Decoration.replace({ block: true, widget: new MarkdownBlockWidget(state.sliceDoc(block.from, block.to), block, context, embedBudget) }).range(block.from, block.to))
    const activeLines = new Set(state.selection.ranges.map((selection) => state.doc.lineAt(selection.head).number))
    const headings = [...activeLines].flatMap((number) => {
      const line = state.doc.line(number)
      const heading = line.text.match(/^\s{0,3}(#{1,6})\s/)
      return heading ? [Decoration.line({ class: `cm-live-heading cm-live-h${heading[1].length}` }).range(line.from)] : []
    })
    return Decoration.set([...ranges, ...headings], true)
  }
  const field = StateField.define<{ blocks: Block[]; decorations: DecorationSet }>({
    create(state) { const blocks = parseBlocks(state); return { blocks, decorations: decorations(state, blocks) } },
    update(value, transaction) {
      let blocks = value.blocks
      if (transaction.effects.some((effect) => effect.is(refresh))) blocks = parseBlocks(transaction.state)
      else if (transaction.docChanged) blocks = blocks.map((block) => {
        const from = transaction.changes.mapPos(block.from, 1)
        const to = transaction.changes.mapPos(block.to, -1)
        return { ...block, from, to, line: transaction.state.doc.lineAt(from).number }
      }).filter((block) => block.to > block.from)
      if (!transaction.docChanged && !transaction.selection && !transaction.effects.length) return value
      return { blocks, decorations: decorations(transaction.state, blocks) }
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  })
  const debounce = ViewPlugin.fromClass(class {
    timer: ReturnType<typeof setTimeout> | undefined
    constructor(readonly view: EditorView) {}
    update(update: { docChanged: boolean }) {
      if (!update.docChanged) return
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.view.dispatch({ effects: refresh.of(null) }), 180)
    }
    destroy() { clearTimeout(this.timer) }
  })
  return [field, debounce]
}

export function focusRange(text: string, position: number, mode: 'sentence' | 'paragraph') {
  let from = text.lastIndexOf('\n\n', Math.max(0, position - 1))
  from = from < 0 ? 0 : from + 2
  let to = text.indexOf('\n\n', position)
  if (to < 0) to = text.length
  if (mode === 'sentence') {
    const paragraph = text.slice(from, to)
    const cursor = position - from
    const boundaries = Array.from(paragraph.matchAll(/[.!?。！？]+(?:["'”’)]*)\s+/g))
    let start = 0
    let end = paragraph.length
    for (const boundary of boundaries) {
      const after = boundary.index! + boundary[0].length
      if (after <= cursor) start = after
      else { end = after; break }
    }
    return { from: from + start, to: from + end }
  }
  return { from, to }
}

export function writingFocus(mode: 'sentence' | 'paragraph') {
  return ViewPlugin.fromClass(class {
    decorations = Decoration.none
    constructor(view: EditorView) { this.refresh(view) }
    update(update: { view: EditorView; docChanged: boolean; selectionSet: boolean; viewportChanged: boolean }) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) this.refresh(update.view)
    }
    refresh(view: EditorView) {
      const head = view.state.selection.main.head
      const start = Math.max(0, head - 50_000), end = Math.min(view.state.doc.length, head + 50_000)
      const local = focusRange(view.state.sliceDoc(start, end), head - start, mode)
      const active = { from: start + local.from, to: start + local.to }
      const ranges = view.visibleRanges.flatMap(({ from, to }) => [
        ...(from < active.from ? [Decoration.mark({ class: 'cm-focus-dim' }).range(from, Math.min(to, active.from))] : []),
        ...(to > active.to ? [Decoration.mark({ class: 'cm-focus-dim' }).range(Math.max(from, active.to), to)] : []),
      ]).filter((range) => range.to > range.from)
      this.decorations = Decoration.set(ranges, true)
    }
  }, { decorations: (value) => value.decorations })
}
