import type { AppSettings, DocumentTab, OpenedDocument } from '../types'
export { slugifyHeading } from './headings'

export const MAX_OPEN_TABS = 100
export const MAX_OPEN_CONTENT_BYTES = 200 * 1024 * 1024

export const DEFAULT_SETTINGS: AppSettings = {
  uiTheme: 'system',
  readerTheme: 'paper',
  readerFont: 'serif',
  fontSize: 18,
  lineHeight: 1.72,
  contentWidth: 760,
  customBackground: '#f7f4ec',
  customText: '#272822',
  customAccent: '#27766f',
  editorWordWrap: true,
  editorLineNumbers: true,
  editorSpellcheck: true,
  editorShowWhitespace: false,
  editorCodeFolding: true,
  editorTypewriterMode: false,
  editorFocus: 'off',
  editorFont: 'mono',
  editorFontSize: 15,
  editorLineHeight: 1.68,
  editorContentWidth: 960,
  editorTabSize: 2,
  editorIndentWithTabs: false,
  autosave: true,
  autosaveDelay: 1200,
  outlineOpen: true,
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback

const boundedNumber = (value: unknown, minimum: number, maximum: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback

const safeColor = (value: unknown, fallback: string) =>
  typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value : fallback

export function normalizeSettings(value: unknown): AppSettings {
  const input = value && typeof value === 'object' ? value as Partial<AppSettings> : {}
  return {
    uiTheme: oneOf(input.uiTheme, ['system', 'light', 'dark'] as const, DEFAULT_SETTINGS.uiTheme),
    readerTheme: oneOf(input.readerTheme, ['paper', 'snow', 'sepia', 'midnight', 'custom'] as const, DEFAULT_SETTINGS.readerTheme),
    readerFont: oneOf(input.readerFont, ['serif', 'sans', 'mono'] as const, DEFAULT_SETTINGS.readerFont),
    fontSize: boundedNumber(input.fontSize, 14, 26, DEFAULT_SETTINGS.fontSize),
    lineHeight: boundedNumber(input.lineHeight, 1.3, 2.1, DEFAULT_SETTINGS.lineHeight),
    contentWidth: boundedNumber(input.contentWidth, 560, 1040, DEFAULT_SETTINGS.contentWidth),
    customBackground: safeColor(input.customBackground, DEFAULT_SETTINGS.customBackground),
    customText: safeColor(input.customText, DEFAULT_SETTINGS.customText),
    customAccent: safeColor(input.customAccent, DEFAULT_SETTINGS.customAccent),
    editorWordWrap: typeof input.editorWordWrap === 'boolean' ? input.editorWordWrap : DEFAULT_SETTINGS.editorWordWrap,
    editorLineNumbers: typeof input.editorLineNumbers === 'boolean' ? input.editorLineNumbers : DEFAULT_SETTINGS.editorLineNumbers,
    editorSpellcheck: typeof input.editorSpellcheck === 'boolean' ? input.editorSpellcheck : DEFAULT_SETTINGS.editorSpellcheck,
    editorShowWhitespace: typeof input.editorShowWhitespace === 'boolean' ? input.editorShowWhitespace : DEFAULT_SETTINGS.editorShowWhitespace,
    editorCodeFolding: typeof input.editorCodeFolding === 'boolean' ? input.editorCodeFolding : DEFAULT_SETTINGS.editorCodeFolding,
    editorTypewriterMode: typeof input.editorTypewriterMode === 'boolean' ? input.editorTypewriterMode : DEFAULT_SETTINGS.editorTypewriterMode,
    editorFocus: oneOf(input.editorFocus, ['off', 'sentence', 'paragraph'] as const, 'off'),
    editorFont: oneOf(input.editorFont, ['mono', 'sans'] as const, DEFAULT_SETTINGS.editorFont),
    editorFontSize: boundedNumber(input.editorFontSize, 12, 24, DEFAULT_SETTINGS.editorFontSize),
    editorLineHeight: boundedNumber(input.editorLineHeight, 1.2, 2.2, DEFAULT_SETTINGS.editorLineHeight),
    editorContentWidth: boundedNumber(input.editorContentWidth, 560, 1400, DEFAULT_SETTINGS.editorContentWidth),
    editorTabSize: Math.round(boundedNumber(input.editorTabSize, 2, 8, DEFAULT_SETTINGS.editorTabSize)),
    editorIndentWithTabs: typeof input.editorIndentWithTabs === 'boolean' ? input.editorIndentWithTabs : DEFAULT_SETTINGS.editorIndentWithTabs,
    autosave: typeof input.autosave === 'boolean' ? input.autosave : DEFAULT_SETTINGS.autosave,
    autosaveDelay: boundedNumber(input.autosaveDelay, 300, 10_000, DEFAULT_SETTINGS.autosaveDelay),
    outlineOpen: typeof input.outlineOpen === 'boolean' ? input.outlineOpen : DEFAULT_SETTINGS.outlineOpen,
  }
}

export function createDocument(content = '', name = 'Untitled.md'): DocumentTab {
  return {
    id: crypto.randomUUID(),
    path: null,
    name,
    content,
    savedContent: '',
    mtimeMs: null,
    lineEnding: 'lf',
    bom: false,
    mode: 'edit',
    saveState: content ? 'edited' : 'saved',
    revision: content ? 1 : 0,
    cursorLine: 1,
    cursorColumn: 1,
    selectionAnchor: 0,
    selectionHead: 0,
    editorScrollTop: 0,
    editorScrollLeft: 0,
    readerScrollTop: 0,
  }
}

export function fromOpenedDocument(document: OpenedDocument): DocumentTab {
  return {
    id: crypto.randomUUID(),
    ...document,
    savedContent: document.content,
    mode: 'read',
    saveState: 'saved',
    revision: 0,
    cursorLine: 1,
    cursorColumn: 1,
    selectionAnchor: 0,
    selectionHead: 0,
    editorScrollTop: 0,
    editorScrollLeft: 0,
    readerScrollTop: 0,
  }
}

export function nextUntitledName(tabs: Pick<DocumentTab, 'name'>[]): string {
  const names = new Set(tabs.map((tab) => tab.name.toLowerCase()))
  if (!names.has('untitled.md')) return 'Untitled.md'
  let index = 2
  while (names.has(`untitled ${index}.md`)) index += 1
  return `Untitled ${index}.md`
}

export function toggleTaskAtLine(content: string, lineIndex: number, checked: boolean): string {
  if (!Number.isSafeInteger(lineIndex) || lineIndex < 0) return content
  const lines = content.split('\n')
  if (lineIndex >= lines.length) return content
  const nextLine = lines[lineIndex].replace(/^(\s*(?:[-+*]|\d+[.)])\s+\[)([ xX])(\])/, (_match, before, _state, after) =>
    `${before}${checked ? 'x' : ' '}${after}`)
  if (nextLine === lines[lineIndex]) return content
  lines[lineIndex] = nextLine
  return lines.join('\n')
}

export function hasUnresolvedChanges(tab: DocumentTab): boolean {
  return tab.content !== tab.savedContent || tab.saveState === 'conflict'
}

export function mergeOpenedDocuments(currentTabs: DocumentTab[], openedDocuments: OpenedDocument[]) {
  const tabs = [...currentTabs]
  const conflicts: string[] = []
  let activeId: string | null = null

  for (const document of openedDocuments) {
    const existingIndex = tabs.findIndex((tab) => tab.path === document.path)
    const existing = tabs[existingIndex]
    if (existing) {
      const locallyDirty = existing.content !== existing.savedContent
      const diskChanged = existing.mtimeMs == null
        || Math.abs(existing.mtimeMs - document.mtimeMs) > 2
        || existing.savedContent !== document.content
      if (!locallyDirty) {
        tabs[existingIndex] = {
          ...existing,
          ...document,
          savedContent: document.content,
          saveState: 'saved',
        }
      } else if (diskChanged) {
        tabs[existingIndex] = { ...existing, saveState: 'conflict' }
        conflicts.push(existing.name)
      }
      activeId = existing.id
      continue
    }
    const tab = fromOpenedDocument(document)
    tabs.push(tab)
    activeId = tab.id
  }

  return { tabs, activeId, conflicts }
}

export function limitOpenedDocuments(
  currentTabs: Pick<DocumentTab, 'path' | 'content' | 'savedContent'>[],
  openedDocuments: OpenedDocument[],
  limit = MAX_OPEN_TABS,
  byteLimit = MAX_OPEN_CONTENT_BYTES,
) {
  const knownTabs = new Map(currentTabs.flatMap((tab) => tab.path ? [[tab.path, {
    content: tab.content,
    savedContent: tab.savedContent,
  }] as const] : []))
  let retainedBytes = currentTabs.reduce((total, tab) => total + retainedTextBytes(tab.content, tab.savedContent), 0)
  let remaining = Math.max(0, limit - currentTabs.length)
  let dropped = 0
  let droppedForCount = 0
  let droppedForBytes = 0
  const documents: OpenedDocument[] = []
  for (const document of openedDocuments) {
    const existing = knownTabs.get(document.path)
    const openedBytes = utf8ByteLength(document.content)
    if (existing) {
      if (existing.content === existing.savedContent) {
        const refreshedBytes = retainedBytes - retainedTextBytes(existing.content, existing.savedContent) + openedBytes
        if (refreshedBytes > byteLimit) {
          dropped += 1
          droppedForBytes += 1
          continue
        }
        retainedBytes = refreshedBytes
        knownTabs.set(document.path, { content: document.content, savedContent: document.content })
      }
      documents.push(document)
      continue
    }
    if (remaining <= 0) {
      dropped += 1
      droppedForCount += 1
      continue
    }
    if (retainedBytes + openedBytes > byteLimit) {
      dropped += 1
      droppedForBytes += 1
      continue
    }
    knownTabs.set(document.path, { content: document.content, savedContent: document.content })
    documents.push(document)
    remaining -= 1
    retainedBytes += openedBytes
  }
  return { documents, dropped, droppedForCount, droppedForBytes, retainedBytes }
}

function retainedTextBytes(content: string, savedContent: string) {
  return utf8ByteLength(content) + (content === savedContent ? 0 : utf8ByteLength(savedContent))
}

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength
}

export function reconcileExternalReload(tab: DocumentTab, expectedMtime: number | null, fresh: OpenedDocument) {
  if (tab.path !== fresh.path) return { tab, reloaded: false, conflict: false }
  const changedDuringRead = tab.mtimeMs !== expectedMtime || tab.content !== tab.savedContent
  if (changedDuringRead) {
    return { tab: { ...tab, saveState: 'conflict' as const }, reloaded: false, conflict: true }
  }
  return {
    tab: { ...tab, ...fresh, savedContent: fresh.content, saveState: 'saved' as const },
    reloaded: true,
    conflict: false,
  }
}

export function countWords(content: string): number {
  const plain = content
    .replace(/^---[\s\S]*?^---\s*/m, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#>*_~|\-]/g, ' ')
  const matches = plain.trim().match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu)
  return matches?.length ?? 0
}

export function readingMinutes(words: number): number {
  return words === 0 ? 0 : Math.max(1, Math.ceil(words / 220))
}

export function fileStem(name: string): string {
  return name.replace(/\.(?:md|markdown|mdown|mkd|txt)$/i, '') || 'Document'
}

export function loadSettings(): AppSettings {
  try {
    return normalizeSettings(JSON.parse(window.localStorage.getItem('margin:settings') || '{}'))
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function normalizeStoredTabs(stored: unknown): DocumentTab[] {
  if (!Array.isArray(stored)) return []
  return stored.flatMap((value): DocumentTab[] => {
      if (!value || typeof value !== 'object') return []
      const tab = value as Partial<DocumentTab>
      if (typeof tab.id !== 'string' || typeof tab.content !== 'string') return []
      const savedContent = typeof tab.savedContent === 'string' ? tab.savedContent : ''
      const mode = tab.mode === 'read' || tab.mode === 'split' || tab.mode === 'live' ? tab.mode : 'edit'
      const saveState = ['saved', 'edited', 'saving', 'conflict', 'error'].includes(String(tab.saveState))
        ? tab.saveState as DocumentTab['saveState']
        : tab.content === savedContent ? 'saved' : 'edited'
      return [{
        id: tab.id,
        path: typeof tab.path === 'string' ? tab.path : null,
        name: typeof tab.name === 'string' ? tab.name : 'Untitled.md',
        content: tab.content,
        savedContent,
        mtimeMs: typeof tab.mtimeMs === 'number' && Number.isFinite(tab.mtimeMs) ? tab.mtimeMs : null,
        lineEnding: tab.lineEnding === 'crlf' ? 'crlf' : 'lf',
        bom: Boolean(tab.bom),
        mode,
        saveState,
        revision: Number.isSafeInteger(tab.revision) && Number(tab.revision) >= 0 ? Number(tab.revision) : tab.content === savedContent ? 0 : 1,
        cursorLine: typeof tab.cursorLine === 'number' && Number.isFinite(tab.cursorLine) ? Math.max(1, tab.cursorLine) : 1,
        cursorColumn: typeof tab.cursorColumn === 'number' && Number.isFinite(tab.cursorColumn) ? Math.max(1, tab.cursorColumn) : 1,
        selectionAnchor: typeof tab.selectionAnchor === 'number' && Number.isFinite(tab.selectionAnchor) ? Math.max(0, tab.selectionAnchor) : 0,
        selectionHead: typeof tab.selectionHead === 'number' && Number.isFinite(tab.selectionHead) ? Math.max(0, tab.selectionHead) : 0,
        editorScrollTop: typeof tab.editorScrollTop === 'number' && Number.isFinite(tab.editorScrollTop) ? Math.max(0, tab.editorScrollTop) : 0,
        editorScrollLeft: typeof tab.editorScrollLeft === 'number' && Number.isFinite(tab.editorScrollLeft) ? Math.max(0, tab.editorScrollLeft) : 0,
        readerScrollTop: typeof tab.readerScrollTop === 'number' && Number.isFinite(tab.readerScrollTop) ? Math.max(0, tab.readerScrollTop) : 0,
      }]
    }).slice(0, MAX_OPEN_TABS)
}

export function restoreSession(): DocumentTab[] {
  try {
    return normalizeStoredTabs(JSON.parse(window.localStorage.getItem('margin:session') || '[]'))
  } catch {
    return []
  }
}
