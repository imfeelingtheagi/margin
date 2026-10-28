import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyAnnotations, applyCollapsedSections, captureTextAnchor, emptyReadingRecord, loadReadingLibrary, locateAnchor, saveReadingLibrary, type Annotation } from './readingState'
import { createDocument } from './document'

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), clear: () => values.clear() })
})
afterEach(() => { window.getSelection()?.removeAllRanges(); vi.unstubAllGlobals() })
describe('on-device reading data', () => {
  it('keeps marked documents ahead of expendable positions when the library reaches its record limit', () => {
    const records = Array.from({ length: 2000 }, (_, i) => ({ ...emptyReadingRecord({ id: `${i}`, path: `/notes/${i}.md`, name: `${i}.md` }), bookmarked: true }))
    const recent = { ...emptyReadingRecord({ id: 'recent', path: '/notes/recent.md', name: 'recent.md' }), updatedAt: Date.now() + 1 }
    saveReadingLibrary(Object.fromEntries([...records, recent].map((record) => [record.key, record])))
    const stored = loadReadingLibrary()
    expect(Object.keys(stored)).toHaveLength(2000)
    expect(stored[records[0].key].bookmarked).toBe(true)
    expect(stored[recent.key]).toBeUndefined()
  })
  it('evicts positions under storage pressure while preserving bookmarks and annotations', () => {
    const original = window.localStorage.setItem.bind(window.localStorage)
    vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
      if (value.length > 10_000) throw new DOMException('Full', 'QuotaExceededError')
      original(key, value)
    })
    const marked = { ...emptyReadingRecord({ id: 'marked', path: '/notes/marked.md', name: 'marked.md' }), bookmarked: true }
    const positions = Array.from({ length: 100 }, (_, i) => emptyReadingRecord({ id: `${i}`, path: `/notes/${i}.md`, name: 'Long title '.repeat(80) }))
    saveReadingLibrary(Object.fromEntries([marked, ...positions].map((record) => [record.key, record])))
    const stored = loadReadingLibrary()
    expect(stored[marked.key].bookmarked).toBe(true)
    expect(Object.keys(stored).length).toBeGreaterThan(1)
    expect(Object.keys(stored).length).toBeLessThan(101)
  })
  it('anchors a cross-paragraph selection and ignores interface text when distinguishing repeated quotes', () => {
    const element = document.createElement('article')
    element.innerHTML = '<h2><button>Very long section control text which is not document prose</button>Heading</h2><p>First <strong>shared phrase</strong>.</p><p>Second shared phrase.</p>'
    document.body.append(element)
    const paragraphs = element.querySelectorAll('p')
    const range = document.createRange()
    range.setStart(paragraphs[0].querySelector('strong')!.firstChild!, 0)
    range.setEnd(paragraphs[1].firstChild!, 6)
    const selection = window.getSelection()!
    selection.addRange(range)
    const anchor = captureTextAnchor(element, selection)!
    expect(anchor.quote).toBe('shared phrase.\nSecond')
    expect(anchor.prefix).not.toContain('control text')
    const annotation: Annotation = { ...anchor, id: 'paragraphs', color: 'yellow', note: '', createdAt: 1 }
    expect(applyAnnotations(element, [annotation]).has(annotation.id)).toBe(true)
    expect(paragraphs[0].querySelector('mark')).toHaveTextContent('shared phrase')
    expect(paragraphs[1].querySelector('mark')).toHaveTextContent('Second')
    selection.removeAllRanges()
    const repeated = document.createRange()
    repeated.selectNodeContents(paragraphs[0].querySelector('strong')!)
    selection.addRange(repeated)
    expect(captureTextAnchor(element, selection)?.offset).toBe(14)
    element.remove()
  })
  it('keeps overlapping annotations valid and removes them without changing document text', () => {
    const element = document.createElement('article')
    element.innerHTML = '<p>One useful paragraph.</p>'
    const base = { prefix: '', suffix: '', note: '', createdAt: 1, color: 'yellow' as const }
    const first: Annotation = { ...base, id: 'first', quote: 'One useful', offset: 0 }
    const second: Annotation = { ...base, id: 'second', quote: 'useful paragraph', offset: 4 }
    expect(applyAnnotations(element, [first, second]).size).toBe(2)
    expect(element.textContent).toBe('One useful paragraph.')
    applyAnnotations(element, [])
    expect(element.textContent).toBe('One useful paragraph.')
    expect(element.querySelector('mark')).toBeNull()
  })
  it('round-trips bookmarks and annotations and validates stored metadata', () => {
    const record = { ...emptyReadingRecord({ ...createDocument(), path: '/notes/test.md' }), bookmarked: true, progress: .42 }
    saveReadingLibrary({ [record.key]: record })
    expect(loadReadingLibrary()[record.key]).toMatchObject({ bookmarked: true, progress: .42 })
    window.localStorage.setItem('margin:reading-library:v1', '{"x":{"name":"n","progress":99,"scrollTop":-12,"annotations":[{"quote":"bad"}]}}')
    expect(loadReadingLibrary().x).toMatchObject({ progress: 1, scrollTop: 0, annotations: [] })
  })
  it('anchors a selection across inline markup and recovers it after inserted text', () => {
    const element = document.createElement('article')
    element.innerHTML = '<p>Before <strong>important</strong> text after.</p>'
    document.body.append(element)
    const range = document.createRange()
    range.setStart(element.querySelector('strong')!.firstChild!, 0)
    range.setEnd(element.querySelector('p')!.lastChild!, 5)
    const selection = window.getSelection()!
    selection.addRange(range)
    const anchor = captureTextAnchor(element, selection)!
    expect(anchor.quote).toBe('important text')
    const annotation: Annotation = { ...anchor, id: 'one', color: 'yellow', note: 'Remember this', createdAt: 1 }
    expect(applyAnnotations(element, [annotation]).has('one')).toBe(true)
    expect(Array.from(element.querySelectorAll('mark')).map((mark) => mark.textContent).join('')).toBe('important text')
    element.innerHTML = '<p>New intro. Before <strong>important</strong> text after.</p>'
    expect(applyAnnotations(element, [annotation]).has('one')).toBe(true)
    expect(element.textContent).toBe('New intro. Before important text after.')
    expect(applyAnnotations(element, []).size).toBe(0)
    expect(element.querySelector('mark')).toBeNull()
    element.remove()
  })
  it('uses surrounding context to distinguish repeated quotes', () => {
    expect(locateAnchor('one text. two text.', { quote: 'text', prefix: 'two ', suffix: '.', offset: 0 })).toBe(14)
  })
  it('collapses nested sections until the next sibling heading and expands cleanly', () => {
    const element = document.createElement('article')
    element.innerHTML = '<h1 id="title">Title</h1><p>Intro</p><h2 id="a">A</h2><p>Inside A</p><h3 id="nested">Nested</h3><p>Nested body</p><h2 id="b">B</h2><p>Inside B</p>'
    applyCollapsedSections(element, ['a'])
    expect((element.children[3] as HTMLElement).hidden).toBe(true)
    expect((element.children[4] as HTMLElement).hidden).toBe(true)
    expect((element.children[6] as HTMLElement).hidden).toBe(false)
    applyCollapsedSections(element, [])
    expect(Array.from(element.children).every((element) => !(element as HTMLElement).hidden)).toBe(true)
    expect(element.querySelectorAll('[data-margin-fold]')).toHaveLength(4)
  })
})
