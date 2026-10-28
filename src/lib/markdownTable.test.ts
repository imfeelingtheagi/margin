import {
  findMarkdownTableAt, formatMarkdownTableAt, getMarkdownTableNavigation,
} from './markdownTable'

describe('Markdown table detection', () => {
  it('detects leading-pipe and pipe-less simple GFM tables at any table row', () => {
    const leading = '| Name | Score |\n| --- | ---: |\n| Ada | 9 |'
    const detected = findMarkdownTableAt(leading, leading.indexOf('Ada'))
    expect(detected).toMatchObject({
      from: 0,
      to: leading.length,
      startLine: 1,
      endLine: 3,
      columnCount: 2,
      alignments: ['none', 'right'],
    })
    expect(detected?.rows.map((row) => row.kind)).toEqual(['header', 'delimiter', 'data'])

    const pipeLess = 'before\nName | Score\n--- | ---:\nAda | 9\nafter'
    expect(findMarkdownTableAt(pipeLess, pipeLess.indexOf('Score'))).toMatchObject({
      startLine: 2,
      endLine: 4,
      columnCount: 2,
    })
  })

  it('supports escaped pipes as cell content rather than separators', () => {
    const document = '| Name | Note |\n| --- | --- |\n| Ada | a \\| b |'
    const table = findMarkdownTableAt(document, document.indexOf('a \\| b'))
    expect(table?.columnCount).toBe(2)
    expect(table?.rows[2].cells[1].text).toBe('a \\| b')
  })

  it('rejects prose pipes, malformed delimiters, indented code, and fenced tables', () => {
    for (const document of [
      'this | is ordinary prose',
      'A | B\n-- | ---\n1 | 2',
      '    A | B\n    --- | ---\n    1 | 2',
      '```md\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```',
      '~~~\nA | B\n--- | ---\n1 | 2\n~~~',
    ]) {
      expect(findMarkdownTableAt(document, document.indexOf('A'))).toBeNull()
    }
  })
})

describe('Markdown table formatting', () => {
  it('trims and pads columns while preserving left, right, and center alignment markers', () => {
    const document = '| Name|Score|Note |\n|:---|---:|:---:|\n|Ada|9|ok|'
    const cursor = document.indexOf('Ada') + 1
    const plan = formatMarkdownTableAt(document, cursor)
    expect(plan?.change).toEqual({
      from: 0,
      to: document.length,
      insert: [
        '| Name | Score | Note  |',
        '| :--- | ----: | :---: |',
        '| Ada  |     9 |  ok   |',
      ].join('\n'),
    })
    expect(plan?.changed).toBe(true)
    expect(plan?.change.insert.slice(plan.selection.anchor - plan.change.from - 1, plan.selection.anchor - plan.change.from + 2)).toBe('Ada')
  })

  it('preserves CRLF and returns a stable no-op replacement for an already formatted table', () => {
    const document = '| A   | B   |\r\n| --- | --- |\r\n| 1   | 2   |'
    const plan = formatMarkdownTableAt(document, document.indexOf('1'))
    expect(plan?.change.insert).toContain('\r\n')
    expect(plan?.change.insert).not.toMatch(/(^|[^\r])\n/)
    expect(plan?.changed).toBe(false)
  })

  it('does not offer a formatting edit outside a valid table', () => {
    expect(formatMarkdownTableAt('A | B\nnot a delimiter', 0)).toBeNull()
  })
})

describe('Markdown table cell navigation', () => {
  const document = '| A | B |\n| --- | --- |\n| 1 | 2 |'

  it('moves forward and backward across rows while skipping the delimiter row', () => {
    const nextHeader = getMarkdownTableNavigation(document, document.indexOf('A'), 'next')
    expect(nextHeader).toMatchObject({ kind: 'move', rowIndex: 0, columnIndex: 1 })
    expect(document.slice(nextHeader!.selection.anchor, nextHeader!.selection.head)).toBe('B')

    const firstData = getMarkdownTableNavigation(document, document.indexOf('B'), 'next')
    expect(firstData).toMatchObject({ kind: 'move', rowIndex: 2, columnIndex: 0 })
    expect(document.slice(firstData!.selection.anchor, firstData!.selection.head)).toBe('1')

    const backToHeader = getMarkdownTableNavigation(document, document.indexOf('1'), 'previous')
    expect(backToHeader).toMatchObject({ kind: 'move', rowIndex: 0, columnIndex: 1 })
    expect(getMarkdownTableNavigation(document, document.indexOf('A'), 'previous')).toBeNull()
  })

  it('returns a safe append-row edit and first-cell caret at the final data cell', () => {
    const plan = getMarkdownTableNavigation(document, document.lastIndexOf('2'), 'next')
    expect(plan).toMatchObject({
      kind: 'insert-row',
      rowIndex: 3,
      columnIndex: 0,
      change: { from: document.length, to: document.length, insert: '\n|     |     |' },
    })
    if (plan?.kind !== 'insert-row') throw new Error('Expected an insert-row plan')
    const changed = `${document.slice(0, plan.change.from)}${plan.change.insert}${document.slice(plan.change.to)}`
    expect(changed[plan.selection.anchor]).toBe(' ')
    expect(findMarkdownTableAt(changed, plan.selection.anchor)?.rows).toHaveLength(4)
    expect(getMarkdownTableNavigation(document, document.length, 'next')).toMatchObject({ kind: 'insert-row' })
  })

  it('can create the first data row from a header-only table and ignores delimiter cells', () => {
    const headerOnly = '| A | B |\n| --- | --- |'
    expect(getMarkdownTableNavigation(headerOnly, headerOnly.indexOf('B'), 'next')).toMatchObject({ kind: 'insert-row' })
    expect(getMarkdownTableNavigation(headerOnly, headerOnly.indexOf('---'), 'next')).toBeNull()
  })
})
