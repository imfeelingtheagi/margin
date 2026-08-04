import type { AppSettings, DocumentTab, OpenedDocument, OutlineItem } from '../types'

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
    cursorLine: 1,
    cursorColumn: 1,
  }
}

export function fromOpenedDocument(document: OpenedDocument): DocumentTab {
  return {
    id: crypto.randomUUID(),
    ...document,
    savedContent: document.content,
    mode: 'read',
    saveState: 'saved',
    cursorLine: 1,
    cursorColumn: 1,
  }
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

export function slugifyHeading(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~[\](){}]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'section'
}

export function extractOutline(content: string): OutlineItem[] {
  const items: OutlineItem[] = []
  const counts = new Map<string, number>()
  let fenced = false
  let fenceMarker = ''

  content.split(/\r?\n/).forEach((line, index) => {
    const fence = line.match(/^\s*(```+|~~~+)/)
    if (fence) {
      if (!fenced) {
        fenced = true
        fenceMarker = fence[1][0]
      } else if (fence[1][0] === fenceMarker) {
        fenced = false
      }
      return
    }
    if (fenced) return
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (!heading) return
    const text = heading[2].replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*_~]/g, '').trim()
    const base = slugifyHeading(text)
    const occurrence = counts.get(base) ?? 0
    counts.set(base, occurrence + 1)
    items.push({
      id: occurrence ? `${base}-${occurrence}` : base,
      text,
      level: heading[1].length,
      line: index + 1,
    })
  })
  return items
}

export function fileStem(name: string): string {
  return name.replace(/\.(?:md|markdown|mdown|mkd|txt)$/i, '') || 'Document'
}

export function loadSettings(): AppSettings {
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem('margin:settings') || '{}'))
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function restoreSession(): DocumentTab[] {
  try {
    const tabs = JSON.parse(localStorage.getItem('margin:session') || '[]') as DocumentTab[]
    return tabs.filter((tab) => tab && typeof tab.content === 'string' && typeof tab.id === 'string').slice(0, 20)
  } catch {
    return []
  }
}
