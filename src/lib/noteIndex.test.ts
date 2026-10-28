import { describe, expect, it } from 'vitest'
import { buildNoteIndex, indexNote, normalizeNotePath, noteConnections, noteSection, resolveNote } from './noteIndex'
import { renderMarkdown } from './markdown'
import { enhanceNotes } from './noteRendering'
import { createExportHtml } from './markdown'
import { DEFAULT_SETTINGS } from './document'

const index = buildNoteIndex([
  { relativePath: 'Start.md', content: '# Start\n\n[[chapters/One#Details|Read more]] and [Two](chapters/Two.md). #guide\n\n![[chapters/One#Details]]' },
  { relativePath: 'chapters/One.md', content: '---\naliases: [First]\ntags: [guide, work/project]\n---\n# One\n\n## Details\n\nA **useful** section.\n\n[[../Start]]\n\n## Next\n\nMore.' },
  { relativePath: 'chapters/Two.md', content: '# Two\n\n`[[Fake]] #code`\n\n```md\n[[No]] #no\n```\n\n#real/tag' },
])

describe('connected notes', () => {
  it('reads multiline YAML alias/tag lists without consuming the next field', () => {
    const note = indexNote({ relativePath: 'Lists.md', content: '---\naliases:\n  - First name\n  - "Second name"\ntags:\n  - work/project\n  - reading\ntitle: Example\n---\n# Lists' })
    expect(note.aliases).toEqual(['First name', 'Second name'])
    expect(note.tags).toEqual(['reading', 'work/project'])
  })
  it('bounds aggregate embed expansion even when many sibling notes are transcluded', () => {
    const source = buildNoteIndex([{ relativePath: 'Large.md', content: '# Large\n\n' + 'Readable prose. '.repeat(200) }])
    const element = document.createElement('article')
    element.innerHTML = renderMarkdown(Array.from({ length: 50 }, () => '![[Large]]').join('\n\n'))
    enhanceNotes(element, source, 'Start.md')
    expect(element.querySelectorAll('.note-embed-body').length).toBeLessThanOrEqual(32)
    expect(element.querySelectorAll('.note-embed > a')).toHaveLength(50)
    expect(element.textContent).toContain('Open this note')
  })
  it('preserves whole-note references in section embeds and keeps heading ids distinct from their host', () => {
    const notes = buildNoteIndex([{ relativePath: 'Guide.md', content: '# Guide\n\n## Details\n\nA [reference][manual] and footnote[^one].\n\n## Other\n\nNot embedded.\n\n[manual]: https://example.test/manual\n\n[^one]: A **useful** note.' }])
    const element = document.createElement('article')
    element.innerHTML = renderMarkdown('# Details\n\n![[Guide#Details]]')
    enhanceNotes(element, notes, 'Start.md')
    expect(element.querySelectorAll('#details')).toHaveLength(1)
    expect(element.querySelector('.note-embed-body a[href="https://example.test/manual"]')).toHaveTextContent('reference')
    expect(element.querySelector('.note-embed-body .footnotes strong')).toHaveTextContent('useful')
    expect(element.querySelector('.note-embed-body')?.textContent).not.toContain('Not embedded.')
  })
  it('bounds connection metadata and restores excluded links when index capacity becomes available', () => {
    const sources = Array.from({ length: 120 }, (_, i) => ({ relativePath: `Note${i}.md`, content: `# Note ${i}\n\n${'[[Note0]] '.repeat(350)}` }))
    const bounded = buildNoteIndex(sources)
    expect(bounded.notes.reduce((total, note) => total + note.links.length, 0)).toBeLessThanOrEqual(40_000)
    expect(bounded.limited).toBe(true)
    const smaller = buildNoteIndex(sources.slice(100), bounded)
    expect(smaller.notes.every((note) => note.links.length === 350)).toBe(true)
    expect(smaller.limited).toBe(false)
  })
  it('reuses unchanged parsed notes when a single open buffer changes', () => {
    const next = buildNoteIndex(index.notes.map((note) => ({ relativePath: note.relativePath, content: note.relativePath === 'Start.md' ? `${note.content}\nNew thought.` : note.content })), index)
    expect(next.notes[1]).toBe(index.notes[1])
    expect(next.notes[0]).not.toBe(index.notes[0])
  })
  it('parses wiki links, embeds, standard links, aliases and tags while ignoring code', () => {
    expect(index.notes[0].links).toHaveLength(3)
    expect(index.notes[1].aliases).toEqual(['First'])
    expect(index.notes[1].tags).toEqual(['guide', 'work/project'])
    expect(index.notes[2].links).toEqual([])
    expect(index.notes[2].tags).toEqual(['real/tag'])
    expect(indexNote({ relativePath: 'n.md', content: '\\[[escaped]]\n\n    [[indented code]]' }).links).toEqual([])
    expect(indexNote({ relativePath: 'n.md', content: '![[photo.png]] and [paper](paper.pdf)' }).links).toEqual([])
  })
  it('resolves relative/root paths, aliases, encoded names, and heading fragments', () => {
    expect(resolveNote(index, 'One#Details', 'chapters/Two.md')?.note.relativePath).toBe('chapters/One.md')
    expect(resolveNote(index, 'First', 'Start.md')?.note.relativePath).toBe('chapters/One.md')
    expect(resolveNote(index, '../Start.md', 'chapters/Two.md', false)?.note.relativePath).toBe('Start.md')
    expect(resolveNote(index, '#Details', 'chapters/One.md')?.fragment).toBe('Details')
    for (const unsafe of ['../../secret', 'https://example.test/note', 'C:\\secret', '//server/share']) expect(resolveNote(index, unsafe, 'Start.md')).toBeNull()
    expect(normalizeNotePath('../Start', 'chapters')).toBe('Start')
  })
  it('refuses ambiguous names instead of jumping to an arbitrary note', () => {
    const duplicate = buildNoteIndex([{ relativePath: 'a/Note.md', content: '' }, { relativePath: 'b/Note.md', content: '' }])
    expect(resolveNote(duplicate, 'Note', 'Start.md')).toBeNull()
    expect(resolveNote(duplicate, 'Note', 'a/Other.md')?.note.relativePath).toBe('a/Note.md')
  })
  it('builds backlinks for standard and wiki links', () => {
    const connections = noteConnections(index, 'chapters/One.md')
    expect(connections.backlinks.map(({ note }) => note.relativePath)).toEqual(['Start.md', 'Start.md'])
    expect(connections.outgoing[0].resolved?.note.relativePath).toBe('Start.md')
  })
  it('extracts heading sections and block references without matching code fences', () => {
    expect(noteSection(index.notes[1].content, 'details')).toContain('A **useful** section.')
    expect(noteSection(index.notes[1].content, 'details')).not.toContain('More.')
    expect(noteSection('First paragraph.\nSecond line. ^block\n\nNext', '^block')).toBe('First paragraph.\nSecond line.')
    expect(noteSection('```\n## Fake\n```\n\n## Real\n\nYes', 'Fake')).toBe('')
    expect(noteSection('````\n```\n## Fake\n````\n\n## Real\n\nYes', 'Fake')).toBe('')
    expect(noteSection('A title\n=======\n\nBody\n\nOther\n-----\n\nEnd', 'A title')).toContain('Body')
  })
  it('renders sanitized wiki links and expands embeds with bounded cycles', () => {
    const element = document.createElement('article')
    element.innerHTML = renderMarkdown(index.notes[0].content)
    enhanceNotes(element, index, 'Start.md')
    expect(element.querySelector('a[data-margin-note]')?.textContent).toBe('Read more')
    expect(element.querySelector('.note-embed-body strong')?.textContent).toBe('useful')
    expect(element.querySelector('.note-embed-body')?.textContent).not.toContain('More.')
    const cycle = buildNoteIndex([{ relativePath: 'A.md', content: '![[B]]' }, { relativePath: 'B.md', content: '![[A]]' }])
    element.innerHTML = renderMarkdown('![[A]]')
    enhanceNotes(element, cycle, 'B.md')
    expect(element.querySelectorAll('.note-embed-body').length).toBeLessThanOrEqual(2)
    expect(renderMarkdown('[[<img src=x onerror=alert(1)>]]')).not.toContain('onerror=')
  })
  it('exports embedded note content and usable file links without scripts', async () => {
    const html = await createExportHtml(index.notes[0].content, null, 'Start', DEFAULT_SETTINGS, { index, relativePath: 'Start.md', assetDocumentPath: () => null })
    expect(html).toContain('A <strong>useful</strong> section.')
    expect(html).toContain('href="chapters/One.md#Details"')
    expect(html).not.toContain('<script')
  })
  it('renders GitHub alerts and foldable callouts with sanitized titles', () => {
    const html = renderMarkdown('> [!NOTE]\n> A useful note.\n\n> [!warning]- Careful\n> Body with **emphasis**.')
    expect(html).toContain('class="markdown-callout callout-note"')
    expect(html).toContain('<details class="markdown-callout callout-warning">')
    expect(html).toContain('<summary class="callout-title">Careful</summary>')
    expect(html).toContain('<strong>emphasis</strong>')
    expect(html).not.toContain('[!NOTE]')
  })
})
