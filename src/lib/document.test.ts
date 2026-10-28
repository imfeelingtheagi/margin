import {
  countWords, createDocument, fileStem, hasUnresolvedChanges, limitOpenedDocuments, mergeOpenedDocuments,
  nextUntitledName, normalizeSettings, normalizeStoredTabs, readingMinutes, reconcileExternalReload, slugifyHeading,
  toggleTaskAtLine,
} from './document'
import { extractOutline } from './markdown'

describe('document helpers', () => {
  it('counts prose while ignoring common Markdown syntax', () => {
    expect(countWords('# Hello, world\n\nThis is **Margin**. [Open it](https://example.com).')).toBe(7)
    expect(readingMinutes(0)).toBe(0)
    expect(readingMinutes(221)).toBe(2)
  })

  it('extracts stable, unique headings outside code fences', () => {
    const outline = extractOutline('# Hello world\n## Details\n```md\n# Ignore me\n```\n## Details')
    expect(outline.map(({ id, level, line }) => ({ id, level, line }))).toEqual([
      { id: 'hello-world', level: 1, line: 1 },
      { id: 'details', level: 2, line: 2 },
      { id: 'details-1', level: 2, line: 6 },
    ])
  })

  it('does not treat front-matter comments as outline headings', () => {
    expect(extractOutline('---\ntitle: Draft\n# metadata comment\n---\n# Document heading')).toEqual([
      { id: 'document-heading', text: 'Document heading', level: 1, line: 5 },
    ])
  })

  it('includes Setext headings with the same stable duplicate ids as rendered Markdown', () => {
    expect(extractOutline('Document title\n==============\n\n[Details](details.md)\n---\n\n# Document title')).toEqual([
      { id: 'document-title', text: 'Document title', level: 1, line: 1 },
      { id: 'details', text: 'Details', level: 2, line: 4 },
      { id: 'document-title-1', text: 'Document title', level: 1, line: 7 },
    ])
  })

  it('does not misclassify list items or fenced content as Setext headings', () => {
    expect(extractOutline('- list item\n---\n```\nInside\n===\n```')).toEqual([])
  })

  it('uses the rendered heading text and ids for entities, links, code, and images', () => {
    expect(extractOutline('# A &amp; B\n## `Code` and [link](note.md)\n### ![Alt](x.png)')).toEqual([
      { id: 'a-b', text: 'A & B', level: 1, line: 1 },
      { id: 'code-and-link', text: 'Code and link', level: 2, line: 2 },
      { id: 'section', text: 'Alt', level: 3, line: 3 },
    ])
  })

  it('normalizes names and slugs', () => {
    expect(slugifyHeading('A calm & useful note')).toBe('a-calm-useful-note')
    expect(fileStem('notes.markdown')).toBe('notes')
  })

  it('validates persisted appearance and autosave settings', () => {
    const settings = normalizeSettings({
      uiTheme: 'broken',
      readerTheme: 'midnight',
      lineHeight: 'wide',
      fontSize: 999,
      contentWidth: -20,
      customAccent: 'javascript:bad',
      editorWordWrap: false,
      editorFont: 'serif',
      editorFontSize: 99,
      editorLineHeight: 0,
      editorContentWidth: 5000,
      editorTabSize: 99,
      autosave: false,
    })

    expect(settings.uiTheme).toBe('system')
    expect(settings.readerTheme).toBe('midnight')
    expect(settings.lineHeight).toBe(1.72)
    expect(settings.fontSize).toBe(26)
    expect(settings.contentWidth).toBe(560)
    expect(settings.customAccent).toBe('#27766f')
    expect(settings.editorWordWrap).toBe(false)
    expect(settings.editorFont).toBe('mono')
    expect(settings.editorFontSize).toBe(24)
    expect(settings.editorLineHeight).toBe(1.2)
    expect(settings.editorContentWidth).toBe(1400)
    expect(settings.editorTabSize).toBe(8)
    expect(settings.autosave).toBe(false)
  })

  it('defaults word wrap and other editor essentials on for existing settings', () => {
    const settings = normalizeSettings({})
    expect(settings.editorWordWrap).toBe(true)
    expect(settings.editorLineNumbers).toBe(true)
    expect(settings.editorSpellcheck).toBe(true)
    expect(settings.editorCodeFolding).toBe(true)
  })

  it('assigns distinct names to new drafts', () => {
    expect(nextUntitledName([])).toBe('Untitled.md')
    expect(nextUntitledName([{ name: 'Untitled.md' }, { name: 'UNTITLED 2.MD' }])).toBe('Untitled 3.md')
  })

  it('toggles a specific task without changing other Markdown', () => {
    const source = '- [ ] first\n1. [x] second\n- ordinary\n  * [X] third'
    expect(toggleTaskAtLine(source, 1, false)).toBe('- [ ] first\n1. [ ] second\n- ordinary\n  * [X] third')
    expect(toggleTaskAtLine(source, 3, false)).toBe('- [ ] first\n1. [x] second\n- ordinary\n  * [ ] third')
    expect(toggleTaskAtLine(source, 9, true)).toBe(source)
  })

  it('migrates older browser recovery tabs to the current state shape', () => {
    const [tab] = normalizeStoredTabs([{ id: 'old-tab', content: 'changed', name: 'Old.md' }])

    expect(tab).toMatchObject({
      id: 'old-tab', revision: 1, selectionAnchor: 0, selectionHead: 0,
      editorScrollTop: 0, editorScrollLeft: 0, readerScrollTop: 0, cursorLine: 1, cursorColumn: 1,
    })
  })

  it('protects a clean in-memory copy when its disk file is unresolved', () => {
    const tab = { ...createDocument(), content: 'only copy', savedContent: 'only copy', saveState: 'conflict' as const }
    expect(hasUnresolvedChanges(tab)).toBe(true)
  })
})

describe('opened document merging', () => {
  const opened = (path: string, content: string, mtimeMs: number) => ({
    path,
    name: path.split('/').pop()!,
    content,
    mtimeMs,
    lineEnding: 'lf' as const,
    bom: false,
  })

  it('adds several files in order and activates the final one', () => {
    const result = mergeOpenedDocuments([], [opened('/tmp/one.md', '# One', 1), opened('/tmp/two.md', '# Two', 2)])

    expect(result.tabs.map((tab) => tab.path)).toEqual(['/tmp/one.md', '/tmp/two.md'])
    expect(result.activeId).toBe(result.tabs[1].id)
    expect(result.tabs.every((tab) => tab.mode === 'read')).toBe(true)
  })

  it('caps new tabs without dropping requests for documents that are already open', () => {
    const existing = Array.from({ length: 100 }, (_, index) => ({ path: `/tmp/${index}.md`, content: '', savedContent: '' }))
    const result = limitOpenedDocuments(existing, [
      opened('/tmp/50.md', 'updated', 2),
      opened('/tmp/overflow.md', 'new', 3),
    ])

    expect(result.documents.map((document) => document.path)).toEqual(['/tmp/50.md'])
    expect(result.dropped).toBe(1)
  })

  it('caps aggregate retained text across repeated open batches', () => {
    const existing = [{ path: '/tmp/one.md', content: '1234', savedContent: '1234' }]
    const result = limitOpenedDocuments(existing, [
      opened('/tmp/two.md', '5678', 2),
      opened('/tmp/three.md', '9', 3),
    ], 100, 8)

    expect(result.documents.map((document) => document.path)).toEqual(['/tmp/two.md'])
    expect(result.droppedForBytes).toBe(1)
    expect(result.retainedBytes).toBe(8)
  })

  it('counts a dirty tab baseline while allowing an already-open dirty file to be selected', () => {
    const existing = [{ path: '/tmp/note.md', content: 'draft', savedContent: 'base' }]
    const result = limitOpenedDocuments(existing, [opened('/tmp/note.md', 'disk changed', 2)], 100, 9)

    expect(result.documents).toHaveLength(1)
    expect(result.dropped).toBe(0)
    expect(result.retainedBytes).toBe(9)
  })

  it('refreshes a clean duplicate without creating another tab', () => {
    const initial = mergeOpenedDocuments([], [opened('/tmp/note.md', 'old', 1)]).tabs
    const result = mergeOpenedDocuments(initial, [opened('/tmp/note.md', 'new', 2)])

    expect(result.tabs).toHaveLength(1)
    expect(result.tabs[0].content).toBe('new')
    expect(result.tabs[0].savedContent).toBe('new')
    expect(result.conflicts).toEqual([])
  })

  it('preserves a dirty duplicate and flags disk changes', () => {
    const tab = {
      ...createDocument('draft', 'note.md'),
      path: '/tmp/note.md',
      savedContent: 'baseline',
      mtimeMs: 1,
    }
    const result = mergeOpenedDocuments([tab], [opened('/tmp/note.md', 'external', 2)])

    expect(result.tabs).toHaveLength(1)
    expect(result.tabs[0].content).toBe('draft')
    expect(result.tabs[0].saveState).toBe('conflict')
    expect(result.conflicts).toEqual(['note.md'])
  })

  it('does not overwrite edits made while an external reload is in flight', () => {
    const initial = mergeOpenedDocuments([], [opened('/tmp/note.md', 'baseline', 1)]).tabs[0]
    const editedDuringRead = { ...initial, content: 'typed while reading', saveState: 'edited' as const }
    const result = reconcileExternalReload(editedDuringRead, 1, opened('/tmp/note.md', 'external', 2))

    expect(result.reloaded).toBe(false)
    expect(result.conflict).toBe(true)
    expect(result.tab.content).toBe('typed while reading')
  })
})
