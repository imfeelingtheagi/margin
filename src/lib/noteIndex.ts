import MarkdownIt from 'markdown-it'
import type { NoteSource } from '../types'
import { wikiLinks } from './noteLinks'
import { slugifyHeading } from './headings'

export interface NoteLink { target: string; label: string; line: number; embed: boolean; wiki: boolean }
export interface IndexedNote extends NoteSource {
  title: string
  aliases: string[]
  tags: string[]
  links: NoteLink[]
  limited?: boolean
}
export interface NoteIndex {
  notes: IndexedNote[]
  byPath: Map<string, IndexedNote>
  paths: Map<string, IndexedNote[]>
  names: Map<string, IndexedNote[]>
  limited?: boolean
}
export interface ResolvedNote { note: IndexedNote; fragment: string }
const parser = new MarkdownIt({ html: true }).use(wikiLinks)
const extension = /\.(?:md|markdown|mdown|mkd|txt)$/i
export const noteStem = (value: string) => value.replace(extension, '')
const key = (value: string) => value.normalize('NFC').toLocaleLowerCase()

function frontMatterValues(content: string, field: string) {
  const front = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1] || ''
  const match = front.match(new RegExp(`^${field}:[ \\t]*(.*)$`, 'im'))
  if (!match) return []
  const inline = match[1].replace(/^\[|\]$/g, '').split(',').map((v) => v.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  if (inline.length) return inline.slice(0, 201)
  const tail = front.slice((match.index || 0) + match[0].length)
  const values: string[] = []
  for (const line of tail.split('\n')) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    const item = line.match(/^[ \t]*-[ \t]+(.+?)\s*$/)
    if (!item) break
    values.push(item[1].replace(/^['"]|['"]$/g, '').trim())
    if (values.length > 200) break
  }
  return values
}

export function indexNote(source: NoteSource): IndexedNote {
  const frontTags = frontMatterValues(source.content, 'tags')
  const aliases = frontMatterValues(source.content, 'aliases')
  const tags = new Set(frontTags.slice(0, 200).map((tag) => tag.replace(/^#/, '').slice(0, 256)))
  const links: NoteLink[] = []
  let limited = frontTags.length > 200 || aliases.length > 20
  const addLink = (link: NoteLink) => { if (links.length < 400) links.push(link); else limited = true }
  const body = source.content.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, (match) => '\n'.repeat(match.split('\n').length - 1))
  const tokens = parser.parse(body, {})
  let title = noteStem(source.relativePath.split('/').at(-1) || source.relativePath)
  let foundTitle = false
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.type !== 'inline') continue
    if (!foundTitle && tokens[index - 1]?.type === 'heading_open') {
      title = token.content.replace(/[*_`]/g, '')
      foundTitle = true
    }
    let inLink = false
    for (const child of token.children || []) {
      if (child.type === 'margin_wiki' || child.type === 'margin_embed') {
        if (child.type === 'margin_embed' && /\.(?:png|jpe?g|gif|webp|svg|avif|bmp)(?:#.*)?$/i.test(String(child.meta?.target || ''))) continue
        addLink({ target: String(child.meta?.target || ''), label: child.content, line: (token.map?.[0] || 0) + 1, embed: child.type === 'margin_embed', wiki: true })
      } else if (child.type === 'link_open') {
        inLink = true
        const target = String(child.attrGet('href') || '')
        const path = target.split(/[?#]/)[0]
        if (!/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target) && (!/\.[^/]+$/.test(path) || extension.test(path))) addLink({ target, label: target, line: (token.map?.[0] || 0) + 1, embed: false, wiki: false })
      } else if (child.type === 'link_close') inLink = false
      else if (child.type === 'text' && !inLink) {
        for (const tag of child.content.matchAll(/(?:^|[\s(])#([\p{L}\p{N}_/-]+)/gu)) {
          if (/\p{L}|[_/-]/u.test(tag[1])) {
            const value = tag[1].slice(0, 256)
            if (tags.size < 200) tags.add(value)
            else if (!tags.has(value)) limited = true
          }
        }
      }
    }
  }
  return { ...source, title: title.slice(0, 512), aliases: aliases.slice(0, 20).map((alias) => alias.slice(0, 256)), tags: [...tags].sort(), links, limited }
}

export function buildNoteIndex(sources: NoteSource[], previous?: NoteIndex | null): NoteIndex {
  let linkBudget = 40_000
  let limited = false
  const notes = sources.map((source) => {
    const old = previous?.byPath.get(source.relativePath)
    const reusable = old?.content === source.content && !(old.limited && old.links.length < 400 && linkBudget > old.links.length)
    const parsed = reusable ? old! : indexNote(source)
    const note = parsed.links.length > linkBudget ? { ...parsed, links: parsed.links.slice(0, linkBudget), limited: true } : parsed
    linkBudget -= note.links.length
    limited ||= Boolean(note.limited)
    return note
  })
  const paths = new Map<string, IndexedNote[]>(), names = new Map<string, IndexedNote[]>()
  const add = (map: Map<string, IndexedNote[]>, value: string, note: IndexedNote) => {
    const normalized = key(value)
    const existing = map.get(normalized) || []
    if (!existing.includes(note)) map.set(normalized, [...existing, note])
  }
  notes.forEach((note) => {
    add(paths, note.relativePath, note); add(paths, noteStem(note.relativePath), note)
    add(names, noteStem(note.relativePath.split('/').at(-1) || ''), note)
    note.aliases.forEach((alias) => add(names, alias, note))
  })
  return { notes, byPath: new Map(notes.map((note) => [note.relativePath, note])), paths, names, limited }
}

export function normalizeNotePath(value: string, base = ''): string | null {
  if (/^[a-z][a-z\d+.-]*:|^[/\\]{2}|[\u0000-\u001f]/i.test(value)) return null
  const parts = value.startsWith('/') ? [] : base.split('/').filter(Boolean)
  for (const segment of value.replace(/\\/g, '/').replace(/^\//, '').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') { if (!parts.length) return null; parts.pop() }
    else parts.push(segment)
  }
  return parts.join('/')
}

export function resolveNote(index: NoteIndex, target: string, fromPath: string, wiki = true): ResolvedNote | null {
  let decoded = target
  try { decoded = decodeURIComponent(target) } catch { /* keep the literal name */ }
  const hash = decoded.indexOf('#')
  const fragment = hash < 0 ? '' : decoded.slice(hash + 1)
  const name = (hash < 0 ? decoded : decoded.slice(0, hash)).trim().split('?')[0]
  if (!name) {
    const note = index.byPath.get(fromPath)
    return note ? { note, fragment } : null
  }
  const directory = fromPath.split('/').slice(0, -1).join('/')
  const relative = normalizeNotePath(name, directory)
  const root = normalizeNotePath(name)
  const paths = [...new Set([relative, wiki ? root : null].filter((value): value is string => value != null))]
  for (const path of paths) {
    const exact = index.byPath.get(path)
    if (exact) return { note: exact, fragment }
    const found = index.paths.get(key(path)) || []
    if (found.length === 1) return { note: found[0], fragment }
  }
  if (!wiki || !root || name.includes('/') || name.includes('\\')) return null
  const candidates = index.names.get(key(noteStem(name))) || []
  return candidates.length === 1 ? { note: candidates[0], fragment } : null
}

export function noteConnections(index: NoteIndex, currentPath: string) {
  const current = index.byPath.get(currentPath)
  const outgoing = (current?.links || []).map((link) => ({ link, resolved: resolveNote(index, link.target, currentPath, link.wiki) }))
  const backlinks = index.notes.flatMap((note) => note.relativePath === currentPath ? [] : note.links
    .filter((link) => resolveNote(index, link.target, note.relativePath, link.wiki)?.note.relativePath === currentPath)
    .map((link) => ({ note, link })))
  return { outgoing, backlinks }
}

export interface NoteSectionRange { fromLine: number; toLine: number; blockId?: string }

export function noteSectionRange(content: string, fragment: string): NoteSectionRange | null {
  if (!fragment) return { fromLine: 1, toLine: content.split('\n').length }
  const body = content.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, (match) => '\n'.repeat(match.split('\n').length - 1))
  const tokens = parser.parse(body, {})
  const lines = content.split('\n')
  if (fragment.startsWith('^')) {
    const id = fragment.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const at = lines.findIndex((line, index) => new RegExp(`(?:^|\\s)\\^${id}\\s*$`).test(line)
      && tokens.some((token) => token.map && token.map[0] <= index && token.map[1] > index && token.type === 'paragraph_open'))
    if (at < 0) return null
    let start = at
    while (start > 0 && lines[start - 1].trim()) start -= 1
    return { fromLine: start + 1, toLine: at + 1, blockId: fragment.slice(1) }
  }
  let start = -1
  let level = 0
  const counts = new Map<string, number>()
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.type !== 'heading_open' || !token.map) continue
    const headingLevel = Number(token.tag.slice(1))
    if (start >= 0 && headingLevel <= level) return { fromLine: start + 1, toLine: token.map[0] }
    const text = (tokens[i + 1]?.children || []).filter((child) => ['text', 'code_inline', 'margin_wiki'].includes(child.type)).map((child) => child.content).join('')
    const slug = slugifyHeading(text)
    const count = counts.get(slug) || 0
    counts.set(slug, count + 1)
    const id = count ? `${slug}-${count}` : slug
    if (start < 0 && (key(text) === key(fragment) || id === slugifyHeading(fragment))) { start = token.map[0]; level = headingLevel }
  }
  return start < 0 ? null : { fromLine: start + 1, toLine: lines.length }
}

export function noteSection(content: string, fragment: string): string {
  const range = noteSectionRange(content, fragment)
  if (!range) return ''
  const result = content.split('\n').slice(range.fromLine - 1, range.toLine).join('\n')
  return range.blockId ? result.replace(new RegExp(`\\s*\\^${range.blockId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`), '') : result
}
