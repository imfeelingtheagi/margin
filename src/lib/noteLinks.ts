import type { MarkdownIt } from 'markdown-it'

export function parseWikiTarget(value: string) {
  const [target, ...alias] = value.split('|')
  return { target: target.trim(), label: alias.join('|').trim() || target.trim() }
}

/** Keep wiki syntax in the normal Markdown parser so code and escapes stay literal. */
export function wikiLinks(markdown: MarkdownIt) {
  markdown.inline.ruler.before('image', 'margin_wiki', (state, silent) => {
    const start = state.pos
    if (state.linkLevel > 0) return false
    const embed = state.src.startsWith('![[', start)
    if (!embed && !state.src.startsWith('[[', start)) return false
    const end = state.src.indexOf(']]', start + (embed ? 3 : 2))
    if (end < 0 || end - start > 1024 || state.src.slice(start, end).includes('\n')) return false
    const { target, label } = parseWikiTarget(state.src.slice(start + (embed ? 3 : 2), end))
    if (!target || /[<>\u0000-\u001f]/.test(target)) return false
    if (!silent) {
      const token = state.push(embed ? 'margin_embed' : 'margin_wiki', '', 0)
      token.content = label
      token.meta = { target }
    }
    state.pos = end + 2
    return true
  })
  markdown.renderer.rules.margin_wiki = (tokens, index) => {
    const token = tokens[index]
    const target = markdown.utils.escapeHtml(String(token.meta?.target || ''))
    return `<a class="wiki-link" href="#" data-margin-note="${target}">${markdown.utils.escapeHtml(token.content)}</a>`
  }
  markdown.renderer.rules.margin_embed = (tokens, index) => {
    const token = tokens[index]
    const target = String(token.meta?.target || '')
    if (/\.(?:png|jpe?g|gif|webp|svg|avif|bmp)(?:#.*)?$/i.test(target)) {
      return `<img src="${markdown.utils.escapeHtml(target)}" alt="${markdown.utils.escapeHtml(token.content)}">`
    }
    return `<span class="note-embed" data-margin-embed="${markdown.utils.escapeHtml(target)}">${markdown.utils.escapeHtml(token.content)}</span>`
  }
}
