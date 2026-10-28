import type { MarkdownIt } from 'markdown-it'

/** GitHub alerts and Obsidian callouts share the same familiar blockquote form. */
export function callouts(markdown: MarkdownIt) {
  markdown.core.ruler.after('inline', 'margin_callouts', (state) => {
    for (let i = state.tokens.length - 1; i >= 0; i -= 1) {
      const opening = state.tokens[i]
      const paragraph = state.tokens[i + 1], inline = state.tokens[i + 2]
      if (opening.type !== 'blockquote_open' || paragraph?.type !== 'paragraph_open' || inline?.type !== 'inline') continue
      const match = inline.content.match(/^\[!([a-z][a-z\d-]*)\]([+-])?(?:[ \t]+([^\n]*))?(?:\n|$)/i)
      if (!match) continue
      let end = i + 1
      while (end < state.tokens.length && !(state.tokens[end].type === 'blockquote_close' && state.tokens[end].level === opening.level)) end += 1
      if (end === state.tokens.length) continue
      const type = match[1].toLocaleLowerCase()
      const foldable = Boolean(match[2])
      opening.tag = foldable ? 'details' : 'aside'
      state.tokens[end].tag = opening.tag
      opening.attrSet('class', `markdown-callout callout-${type}`)
      if (match[2] === '+') opening.attrSet('open', '')
      const title = new state.Token('html_block', '', 0)
      title.content = `<${foldable ? 'summary' : 'div'} class="callout-title">${markdown.utils.escapeHtml(match[3]?.trim() || type.charAt(0).toUpperCase() + type.slice(1))}</${foldable ? 'summary' : 'div'}>`
      const body = inline.content.slice(match[0].length)
      inline.content = body
      inline.children = markdown.parseInline(body, state.env)[0]?.children || []
      if (!body) state.tokens.splice(i + 1, 3, title)
      else state.tokens.splice(i + 1, 0, title)
    }
  })
}
