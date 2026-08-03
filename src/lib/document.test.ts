import { countWords, extractOutline, fileStem, readingMinutes, slugifyHeading } from './document'

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
})
