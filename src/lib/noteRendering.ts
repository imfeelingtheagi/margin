import type { NoteIndex } from './noteIndex'
import { noteSection, resolveNote } from './noteIndex'
import { renderMarkdownFragment } from './markdown'

export interface NoteEmbedBudget { count: number; characters: number; htmlCharacters?: number; cachedHtmlCharacters?: number; renderCache?: Map<string, { html: string; characters: number }> }
export const MAX_EXPANDED_NOTES = 32
export const MAX_EXPANDED_CHARACTERS = 500_000
export const MAX_EMBED_HTML_CHARACTERS = 4 * 1024 * 1024
let embeddedRenderId = 0

/** Expansion is intentionally bounded; cyclic transclusions stay usable links. */
export function enhanceNotes(container: HTMLElement, index: NoteIndex, fromPath: string, depth = 0, ancestors = new Set<string>(), budget: NoteEmbedBudget = { count: 0, characters: 0 }) {
  for (const anchor of container.querySelectorAll<HTMLAnchorElement>('a[href], a[data-margin-note]')) {
    if (anchor.closest('[data-margin-expanded]')) continue
    const wiki = anchor.dataset.marginNote
    const href = anchor.getAttribute('href') || ''
    if (wiki == null && /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) continue
    const resolved = resolveNote(index, wiki ?? href, fromPath, wiki != null)
    if (wiki != null || resolved) {
      anchor.dataset.marginNote = wiki ?? href
      anchor.dataset.marginNoteOrigin = fromPath
      anchor.dataset.marginNoteKind = wiki == null ? 'markdown' : 'wiki'
      anchor.classList.toggle('is-unresolved', !resolved)
      anchor.title = resolved ? resolved.note.relativePath : `Note not found: ${wiki ?? href}`
    }
  }
  for (const placeholder of container.querySelectorAll<HTMLElement>('[data-margin-embed]')) {
    if (placeholder.dataset.marginExpanded != null) continue
    const target = placeholder.dataset.marginEmbed || ''
    const resolved = resolveNote(index, target, fromPath)
    const link = document.createElement('a')
    link.href = '#'
    link.dataset.marginNote = target
    link.dataset.marginNoteOrigin = fromPath
    link.textContent = resolved?.note.title || target
    placeholder.replaceChildren(link)
    placeholder.dataset.marginExpanded = ''
    if (!resolved) { placeholder.classList.add('is-unresolved'); continue }
    const identity = `${resolved.note.relativePath}#${resolved.fragment}`
    if (depth >= 2 || ancestors.has(identity)) continue
    const cached = budget.renderCache?.get(identity)
    const content = cached ? '' : noteSection(resolved.note.content, resolved.fragment)
    const characters = cached?.characters ?? content.length
    if (!characters || characters > 100_000 || budget.count >= MAX_EXPANDED_NOTES || budget.characters + characters > MAX_EXPANDED_CHARACTERS) {
      const notice = document.createElement('small')
      notice.textContent = characters ? 'Open this note to read the full document.' : 'This heading or block was not found.'
      placeholder.append(notice)
      continue
    }
    const body = document.createElement('div')
    body.className = 'note-embed-body'
    const html = cached?.html ?? renderMarkdownFragment(resolved.note.content, resolved.fragment)
    if ((budget.htmlCharacters || 0) + html.length > MAX_EMBED_HTML_CHARACTERS) {
      const notice = document.createElement('small')
      notice.textContent = 'Open this note to read the full document.'
      placeholder.append(notice)
      continue
    }
    budget.count += 1
    budget.characters += characters
    budget.htmlCharacters = (budget.htmlCharacters || 0) + html.length
    budget.renderCache ??= new Map()
    if (!budget.renderCache.has(identity)) {
      budget.cachedHtmlCharacters ??= 0
      while (budget.cachedHtmlCharacters + html.length > MAX_EMBED_HTML_CHARACTERS && budget.renderCache.size) {
        const first = budget.renderCache.keys().next().value!
        budget.cachedHtmlCharacters -= budget.renderCache.get(first)!.html.length
        budget.renderCache.delete(first)
      }
      budget.renderCache.set(identity, { html, characters })
      budget.cachedHtmlCharacters += html.length
    }
    body.innerHTML = html
    // Transcluded assets use the owning note's path, never the containing file.
    body.querySelectorAll<HTMLElement>('[data-margin-asset-source]').forEach((asset) => {
      asset.dataset.marginAssetDocument = resolved.note.relativePath
    })
    body.querySelectorAll<HTMLInputElement>('input[data-margin-task-line]').forEach((input) => {
      input.disabled = true
      input.removeAttribute('data-margin-task-line')
    })
    enhanceNotes(body, index, resolved.note.relativePath, depth + 1, new Set([...ancestors, identity]), budget)
    // Embedded headings/footnotes must not capture the containing document's outline targets.
    const prefix = `margin-embed-${++embeddedRenderId}-`
    const ids = new Map<string, string>()
    body.querySelectorAll<HTMLElement>('[id]').forEach((element) => { ids.set(element.id, prefix + element.id); element.id = prefix + element.id })
    body.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((anchor) => {
      const id = ids.get((anchor.getAttribute('href') || '').slice(1))
      if (id) anchor.setAttribute('href', `#${id}`)
    })
    placeholder.append(body)
  }
}
