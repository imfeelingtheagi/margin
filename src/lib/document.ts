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
    const saved = JSON.parse(localStorage.getItem('margin:settings') || '{}')
    return { ...DEFAULT_SETTINGS, ...saved }
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
