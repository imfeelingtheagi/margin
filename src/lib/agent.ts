import type { AgentProposal } from '../agentTypes'
import type { NoteIndex } from './noteIndex'
import { indexNote, resolveNote } from './noteIndex'
import { renderMarkdown } from './markdown'
import type { AgentSource } from '../agentTypes'

export function agentAnswerHtml(answer: string, sources: AgentSource[]) {
  const ids = new Set(sources.map((source) => source.id))
  const cited = answer.replace(/\[(C\d+)\]/g, (marker, id: string) => ids.has(id) ? `[${id}](#agent-source-${id})` : marker)
  const container = document.createElement('div')
  container.innerHTML = renderMarkdown(cited)
  container.querySelectorAll('img, audio, video, source, iframe, object, embed, button, input, form, textarea, select').forEach((node) => node.remove())
  container.querySelectorAll('[id], [name]').forEach((node) => { node.removeAttribute('id'); node.removeAttribute('name') })
  container.querySelectorAll<HTMLAnchorElement>('a').forEach((anchor) => {
    const id = anchor.getAttribute('href')?.replace(/^#agent-source-/, '')
    if (!id || !ids.has(id) || anchor.getAttribute('href') !== `#agent-source-${id}`) anchor.removeAttribute('href')
  })
  return container.innerHTML
}

export async function agentTextHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function applyAgentProposal(content: string, proposal: AgentProposal) {
  if (proposal.kind !== 'edit' || !Number.isSafeInteger(proposal.from) || !Number.isSafeInteger(proposal.to)
    || proposal.from! < 0 || proposal.to! < proposal.from! || proposal.to! > content.length
    || content.slice(proposal.from, proposal.to) !== proposal.before) throw new Error('The proposal no longer matches this document. Generate it again.')
  return content.slice(0, proposal.from) + proposal.after + content.slice(proposal.to)
}

export interface AgentDiffLine { type: 'same' | 'removed' | 'added'; text: string; oldLine?: number; newLine?: number }
/** Bounded line diff: common ends plus an LCS for reasonably sized changed regions. */
export function agentLineDiff(before: string, after: string): AgentDiffLine[] {
  const a = before.split('\n'), b = after.split('\n')
  let prefix = 0, suffix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1
  const result: AgentDiffLine[] = []
  for (let i = 0; i < prefix; i += 1) result.push({ type: 'same', text: a[i], oldLine: i + 1, newLine: i + 1 })
  const x = a.slice(prefix, a.length - suffix), y = b.slice(prefix, b.length - suffix)
  if (x.length * y.length > 100_000) {
    x.forEach((text, i) => result.push({ type: 'removed', text, oldLine: prefix + i + 1 }))
    y.forEach((text, i) => result.push({ type: 'added', text, newLine: prefix + i + 1 }))
  } else {
    const rows = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1))
    for (let i = x.length - 1; i >= 0; i -= 1) for (let j = y.length - 1; j >= 0; j -= 1) rows[i][j] = x[i] === y[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1])
    let i = 0, j = 0
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) { result.push({ type: 'same', text: x[i], oldLine: prefix + i + 1, newLine: prefix + j + 1 }); i += 1; j += 1 }
      else if (i < x.length && (j === y.length || rows[i + 1][j] >= rows[i][j + 1])) { result.push({ type: 'removed', text: x[i], oldLine: prefix + i + 1 }); i += 1 }
      else { result.push({ type: 'added', text: y[j], newLine: prefix + j + 1 }); j += 1 }
    }
  }
  for (let i = suffix; i > 0; i -= 1) result.push({ type: 'same', text: a[a.length - i], oldLine: a.length - i + 1, newLine: b.length - i + 1 })
  return result
}

export function agentLinkWarnings(proposal: AgentProposal, notes: NoteIndex, origin: string): string[] {
  const before = new Set(indexNote({ relativePath: origin, content: proposal.before }).links.map((link) => link.target))
  return indexNote({ relativePath: origin, content: proposal.after }).links.filter((link) => link.wiki && !before.has(link.target) && !resolveNote(notes, link.target, origin, true))
    .map((link) => `Unresolved or ambiguous note link: ${link.target}`)
}
