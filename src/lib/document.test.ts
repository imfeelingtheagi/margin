import {
  countWords, createDocument, extractOutline, fileStem, hasUnresolvedChanges, mergeOpenedDocuments,
  normalizeSettings, readingMinutes, reconcileExternalReload, slugifyHeading,
} from './document'

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
      autosave: false,
    })

    expect(settings.uiTheme).toBe('system')
    expect(settings.readerTheme).toBe('midnight')
    expect(settings.lineHeight).toBe(1.72)
    expect(settings.fontSize).toBe(26)
    expect(settings.contentWidth).toBe(560)
    expect(settings.customAccent).toBe('#27766f')
    expect(settings.autosave).toBe(false)
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
