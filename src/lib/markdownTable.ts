export type MarkdownTableAlignment = 'none' | 'left' | 'right' | 'center'
export type MarkdownTableRowKind = 'header' | 'delimiter' | 'data'

export interface MarkdownTableCell {
  rowIndex: number
  columnIndex: number
  line: number
  /** Trimmed cell-content range, as document offsets. */
  from: number
  to: number
  /** Full cell range between its pipe separators, as document offsets. */
  rawFrom: number
  rawTo: number
  text: string
}

export interface MarkdownTableRow {
  rowIndex: number
  kind: MarkdownTableRowKind
  line: number
  from: number
  to: number
  cells: MarkdownTableCell[]
}

export interface MarkdownTable {
  from: number
  to: number
  startLine: number
  endLine: number
  columnCount: number
  alignments: MarkdownTableAlignment[]
  rows: MarkdownTableRow[]
  indent: string
  lineEnding: '\n' | '\r\n' | '\r'
}

export interface MarkdownTableChange {
  from: number
  to: number
  insert: string
}

export interface MarkdownTableSelection {
  anchor: number
  head: number
}

export interface MarkdownTableFormatPlan {
  table: MarkdownTable
  change: MarkdownTableChange
  selection: MarkdownTableSelection
  changed: boolean
}

export type MarkdownTableNavigationPlan =
  | {
      kind: 'move'
      table: MarkdownTable
      rowIndex: number
      columnIndex: number
      selection: MarkdownTableSelection
    }
  | {
      kind: 'insert-row'
      table: MarkdownTable
      rowIndex: number
      columnIndex: 0
      change: MarkdownTableChange
      selection: MarkdownTableSelection
    }

interface DocumentLine {
  number: number
  from: number
  to: number
  text: string
  ending: '' | '\n' | '\r\n' | '\r'
}

interface ParsedCell {
  rawFrom: number
  rawTo: number
  from: number
  to: number
  text: string
}

interface ParsedRow {
  line: DocumentLine
  indent: string
  cells: ParsedCell[]
}

interface RenderedCell {
  rowIndex: number
  columnIndex: number
  contentStart: number
  contentLength: number
}

const delimiterPattern = /^(:)?(-{3,})(:)?$/

/** Locate a simple top-level GFM pipe table containing `cursor`. */
export function findMarkdownTableAt(document: string, cursor: number): MarkdownTable | null {
  if (typeof document !== 'string' || !Number.isFinite(cursor)) return null
  const lines = splitDocumentLines(document)
  const cursorLineIndex = lineIndexAt(lines, clamp(Math.trunc(cursor), 0, document.length))
  const fencedLines = findFencedLines(lines)

  for (let headerIndex = 0; headerIndex < lines.length - 1; headerIndex += 1) {
    if (headerIndex > cursorLineIndex || fencedLines.has(headerIndex) || fencedLines.has(headerIndex + 1)) continue
    const header = parsePipeRow(lines[headerIndex])
    const delimiter = parsePipeRow(lines[headerIndex + 1])
    if (!header || !delimiter || header.cells.length < 2 || delimiter.cells.length !== header.cells.length) continue
    const alignments = parseAlignments(delimiter)
    if (!alignments) continue

    const parsedRows: Array<{ parsed: ParsedRow; kind: MarkdownTableRowKind }> = [
      { parsed: header, kind: 'header' },
      { parsed: delimiter, kind: 'delimiter' },
    ]
    let nextIndex = headerIndex + 2
    while (nextIndex < lines.length && !fencedLines.has(nextIndex)) {
      const data = parsePipeRow(lines[nextIndex])
      if (!data || data.cells.length !== header.cells.length) break
      parsedRows.push({ parsed: data, kind: 'data' })
      nextIndex += 1
    }
    const lastLineIndex = headerIndex + parsedRows.length - 1
    if (cursorLineIndex < headerIndex || cursorLineIndex > lastLineIndex) continue

    const rows: MarkdownTableRow[] = parsedRows.map(({ parsed, kind }, rowIndex) => ({
      rowIndex,
      kind,
      line: parsed.line.number,
      from: parsed.line.from,
      to: parsed.line.to,
      cells: parsed.cells.map((cell, columnIndex) => ({
        rowIndex,
        columnIndex,
        line: parsed.line.number,
        ...cell,
      })),
    }))
    const lastLine = parsedRows.at(-1)!.parsed.line
    const lineEnding = parsedRows
      .map(({ parsed }) => parsed.line.ending)
      .find((ending): ending is '\n' | '\r\n' | '\r' => Boolean(ending)) ?? '\n'
    return {
      from: header.line.from,
      to: lastLine.to,
      startLine: header.line.number,
      endLine: lastLine.number,
      columnCount: header.cells.length,
      alignments,
      rows,
      indent: header.indent,
      lineEnding,
    }
  }
  return null
}

/**
 * Return one CodeMirror-friendly replacement and caret plan that trims cells,
 * pads columns, and retains each delimiter cell's alignment colons.
 */
export function formatMarkdownTableAt(document: string, cursor: number): MarkdownTableFormatPlan | null {
  const table = findMarkdownTableAt(document, cursor)
  if (!table) return null
  const widths = tableColumnWidths(table)
  const renderedRows: string[] = []
  const renderedCells: RenderedCell[] = []
  let renderedLength = 0

  for (const row of table.rows) {
    const rendered = renderFormattedRow(table, row, widths)
    renderedRows.push(rendered.text)
    for (const cell of rendered.cells) {
      renderedCells.push({ ...cell, contentStart: renderedLength + cell.contentStart })
    }
    renderedLength += rendered.text.length
    if (row.rowIndex < table.rows.length - 1) renderedLength += table.lineEnding.length
  }

  const insert = renderedRows.join(table.lineEnding)
  const currentCell = locateCell(table, cursor, true)
  let nextCursor = table.from
  if (currentCell) {
    const rendered = renderedCells.find((cell) =>
      cell.rowIndex === currentCell.rowIndex && cell.columnIndex === currentCell.columnIndex)
    if (rendered) {
      const innerOffset = clamp(cursor - currentCell.from, 0, currentCell.text.length)
      nextCursor = table.from + rendered.contentStart + Math.min(innerOffset, rendered.contentLength)
    }
  }

  return {
    table,
    change: { from: table.from, to: table.to, insert },
    selection: { anchor: nextCursor, head: nextCursor },
    changed: document.slice(table.from, table.to) !== insert,
  }
}

/**
 * Compute Tab/Shift-Tab navigation without touching the document. Delimiter
 * cells are intentionally not navigable. Moving forward from the final cell
 * returns an insertion plan for one padded empty data row.
 */
export function getMarkdownTableNavigation(
  document: string,
  cursor: number,
  direction: 'next' | 'previous',
): MarkdownTableNavigationPlan | null {
  const table = findMarkdownTableAt(document, cursor)
  if (!table) return null
  const currentCell = locateCell(table, cursor, false)
  if (!currentCell) return null
  const cells = table.rows
    .filter((row) => row.kind !== 'delimiter')
    .flatMap((row) => row.cells)
  const currentIndex = cells.findIndex((cell) =>
    cell.rowIndex === currentCell.rowIndex && cell.columnIndex === currentCell.columnIndex)
  if (currentIndex < 0) return null

  const targetIndex = direction === 'next' ? currentIndex + 1 : currentIndex - 1
  if (targetIndex >= 0 && targetIndex < cells.length) {
    const target = cells[targetIndex]
    return {
      kind: 'move',
      table,
      rowIndex: target.rowIndex,
      columnIndex: target.columnIndex,
      selection: { anchor: target.from, head: target.to },
    }
  }
  if (direction === 'previous') return null

  const widths = tableColumnWidths(table)
  const empty = renderEmptyDataRow(table, widths)
  const insert = `${table.lineEnding}${empty.text}`
  const firstCell = table.to + table.lineEnding.length + empty.firstCellOffset
  return {
    kind: 'insert-row',
    table,
    rowIndex: table.rows.length,
    columnIndex: 0,
    change: { from: table.to, to: table.to, insert },
    selection: { anchor: firstCell, head: firstCell },
  }
}

function splitDocumentLines(document: string): DocumentLine[] {
  const lines: DocumentLine[] = []
  let lineStart = 0
  let lineNumber = 1
  let index = 0
  while (index < document.length) {
    const character = document[index]
    if (character !== '\n' && character !== '\r') {
      index += 1
      continue
    }
    const ending = character === '\r' && document[index + 1] === '\n' ? '\r\n' : character
    lines.push({
      number: lineNumber,
      from: lineStart,
      to: index,
      text: document.slice(lineStart, index),
      ending,
    })
    index += ending.length
    lineStart = index
    lineNumber += 1
  }
  lines.push({
    number: lineNumber,
    from: lineStart,
    to: document.length,
    text: document.slice(lineStart),
    ending: '',
  })
  return lines
}

function lineIndexAt(lines: DocumentLine[], offset: number) {
  for (let index = 0; index < lines.length; index += 1) {
    const nextFrom = lines[index + 1]?.from ?? Number.POSITIVE_INFINITY
    if (offset < nextFrom || index === lines.length - 1) return index
  }
  return lines.length - 1
}

function findFencedLines(lines: DocumentLine[]) {
  const fenced = new Set<number>()
  let open: { marker: '`' | '~'; length: number } | null = null
  lines.forEach((line, index) => {
    if (open) {
      fenced.add(index)
      const closing = line.text.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
      if (closing && closing[1][0] === open.marker && closing[1].length >= open.length) open = null
      return
    }
    const opening = line.text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (!opening) return
    fenced.add(index)
    open = { marker: opening[1][0] as '`' | '~', length: opening[1].length }
  })
  return fenced
}

function parsePipeRow(line: DocumentLine): ParsedRow | null {
  if (!line.text.trim()) return null
  const indentation = line.text.match(/^ */)?.[0] ?? ''
  if (indentation.length > 3 || line.text[indentation.length] === '\t') return null
  const pipes: number[] = []
  for (let index = 0; index < line.text.length; index += 1) {
    if (line.text[index] === '|' && !isEscaped(line.text, index)) pipes.push(index)
  }
  if (!pipes.length) return null

  const firstNonSpace = line.text.search(/\S/)
  let lastNonSpace = line.text.length - 1
  while (lastNonSpace >= 0 && /[ \t]/.test(line.text[lastNonSpace])) lastNonSpace -= 1
  const leadingPipe = firstNonSpace >= 0 && line.text[firstNonSpace] === '|' && !isEscaped(line.text, firstNonSpace)
  const trailingPipe = lastNonSpace >= 0 && line.text[lastNonSpace] === '|' && !isEscaped(line.text, lastNonSpace)
  const contentStart = leadingPipe ? firstNonSpace + 1 : 0
  const contentEnd = trailingPipe ? lastNonSpace : line.text.length
  const separators = pipes.filter((position) => position >= contentStart && position < contentEnd)
  const boundaries = [contentStart, ...separators, contentEnd]
  const cells: ParsedCell[] = []
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const rawStart = boundaries[index] + (index ? 1 : 0)
    const rawEnd = boundaries[index + 1]
    let trimmedStart = rawStart
    let trimmedEnd = rawEnd
    while (trimmedStart < trimmedEnd && /[ \t]/.test(line.text[trimmedStart])) trimmedStart += 1
    while (trimmedEnd > trimmedStart && /[ \t]/.test(line.text[trimmedEnd - 1])) trimmedEnd -= 1
    cells.push({
      rawFrom: line.from + rawStart,
      rawTo: line.from + rawEnd,
      from: line.from + trimmedStart,
      to: line.from + trimmedEnd,
      text: line.text.slice(trimmedStart, trimmedEnd),
    })
  }
  return { line, indent: indentation, cells }
}

function isEscaped(text: string, index: number) {
  let slashes = 0
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) slashes += 1
  return slashes % 2 === 1
}

function parseAlignments(row: ParsedRow): MarkdownTableAlignment[] | null {
  const alignments: MarkdownTableAlignment[] = []
  for (const cell of row.cells) {
    const match = cell.text.match(delimiterPattern)
    if (!match) return null
    alignments.push(match[1] && match[3] ? 'center' : match[1] ? 'left' : match[3] ? 'right' : 'none')
  }
  return alignments
}

function locateCell(table: MarkdownTable, cursor: number, includeDelimiter: boolean) {
  const row = table.rows.find((candidate) => cursor >= candidate.from && cursor <= candidate.to)
  if (!row || (!includeDelimiter && row.kind === 'delimiter')) return null
  let nearest: MarkdownTableCell | null = null
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const cell of row.cells) {
    if (cursor >= cell.rawFrom && cursor <= cell.rawTo) return cell
    const distance = Math.min(Math.abs(cursor - cell.rawFrom), Math.abs(cursor - cell.rawTo))
    if (distance < nearestDistance) {
      nearest = cell
      nearestDistance = distance
    }
  }
  return nearest
}

function tableColumnWidths(table: MarkdownTable) {
  return table.alignments.map((alignment, columnIndex) => {
    const alignmentCharacters = alignment === 'center' ? 2 : alignment === 'none' ? 0 : 1
    const minimum = 3 + alignmentCharacters
    return table.rows
      .filter((row) => row.kind !== 'delimiter')
      .reduce((width, row) => Math.max(width, row.cells[columnIndex].text.length), minimum)
  })
}

function renderFormattedRow(table: MarkdownTable, row: MarkdownTableRow, widths: number[]) {
  let text = `${table.indent}|`
  const cells: RenderedCell[] = []
  for (let columnIndex = 0; columnIndex < table.columnCount; columnIndex += 1) {
    const original = row.cells[columnIndex].text
    let content: string
    let textOffset = 0
    if (row.kind === 'delimiter') {
      content = renderDelimiter(table.alignments[columnIndex], widths[columnIndex])
    } else {
      const padded = padCell(original, widths[columnIndex], table.alignments[columnIndex])
      content = padded.text
      textOffset = padded.textOffset
    }
    text += ' '
    const contentStart = text.length + textOffset
    text += content
    cells.push({
      rowIndex: row.rowIndex,
      columnIndex,
      contentStart,
      contentLength: original.length,
    })
    text += ' |'
  }
  return { text, cells }
}

function renderDelimiter(alignment: MarkdownTableAlignment, width: number) {
  const left = alignment === 'left' || alignment === 'center' ? ':' : ''
  const right = alignment === 'right' || alignment === 'center' ? ':' : ''
  return `${left}${'-'.repeat(Math.max(3, width - left.length - right.length))}${right}`
}

function padCell(text: string, width: number, alignment: MarkdownTableAlignment) {
  const padding = Math.max(0, width - text.length)
  let left = 0
  if (alignment === 'right') left = padding
  else if (alignment === 'center') left = Math.floor(padding / 2)
  const right = padding - left
  return { text: `${' '.repeat(left)}${text}${' '.repeat(right)}`, textOffset: left }
}

function renderEmptyDataRow(table: MarkdownTable, widths: number[]) {
  let text = `${table.indent}|`
  let firstCellOffset = text.length + 1
  widths.forEach((width, columnIndex) => {
    text += ` ${' '.repeat(width)} |`
    if (columnIndex === 0) firstCellOffset = table.indent.length + 2
  })
  return { text, firstCellOffset }
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}
