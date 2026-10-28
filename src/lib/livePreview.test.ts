import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, undo } from '@codemirror/commands'
import { DEFAULT_SETTINGS } from './document'
import { livePreview, focusRange } from './livePreview'
import { buildNoteIndex } from './noteIndex'
import { presentationSlides } from './presentation'

describe('live editing', () => {
  it('renders reference links, duplicate heading ids, and footnotes using whole-document context', () => {
    const source = '# Editing\n\nA [reference][guide] and footnote[^one].\n\n## Details\n\nText.\n\n## Details\n\n[guide]: https://example.test/guide\n\n[^one]: A **useful** footnote.'
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({ parent, state: EditorState.create({ doc: source, extensions: [livePreview({ settings: DEFAULT_SETTINGS, path: null, relativePath: '', notes: buildNoteIndex([]), assetDocumentPath: () => null, onOpenNote: () => {} })] }) })
    expect(parent.querySelector('a[href="https://example.test/guide"]')).toHaveTextContent('reference')
    expect(parent.querySelector('#details-1')).not.toBeNull()
    expect(parent.querySelector('.footnote-ref')).not.toBeNull()
    expect(parent.querySelector('.footnotes strong')).toHaveTextContent('useful')
    expect(view.state.doc.toString()).toBe(source)
    view.destroy(); parent.remove()
  })
  it('renders inactive blocks, reveals the selected block, and retains exact Markdown with undo', () => {
    const source = '# Heading\n\nA **bold** paragraph.\n\n- One\n- Two\n'
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({ parent, state: EditorState.create({ doc: source, extensions: [history(), livePreview({ settings: DEFAULT_SETTINGS, path: null, relativePath: '', notes: buildNoteIndex([]), assetDocumentPath: () => null, onOpenNote: () => {} })] }) })
    expect(parent.querySelector('.cm-live-block strong')?.textContent).toBe('bold')
    view.dispatch({ selection: { anchor: source.indexOf('bold') } })
    expect(parent.querySelector('.cm-live-block strong')).toBeNull()
    expect(parent.querySelector('.cm-live-block h1')?.textContent).toBe('Heading')
    view.dispatch({ changes: { from: source.indexOf('bold'), insert: 'very ' } })
    expect(view.state.doc.toString()).toContain('**very bold**')
    undo(view)
    expect(view.state.doc.toString()).toBe(source)
    view.destroy()
    parent.remove()
  })
  it('selects sentence or paragraph boundaries for writing focus', () => {
    const text = 'First sentence. Second one! Third.\n\nNext paragraph.'
    const range = focusRange(text, 20, 'sentence')
    expect(text.slice(range.from, range.to)).toBe('Second one! ')
    expect(text.slice(focusRange(text, text.length, 'paragraph').from)).toBe('Next paragraph.')
  })
  it('splits presentations on headings and separators while leaving fenced code intact', () => {
    const slides = presentationSlides('# Title\n\nIntro\n\n## Next\n\n```md\n## Not a slide\n---\n```\n\n---\n\nLast')
    expect(slides).toHaveLength(3)
    expect(slides[1]).toContain('## Not a slide')
    expect(slides[2]).toBe('Last')
  })
})
