import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import highlightCssSource from 'highlight.js/styles/github.css?raw'
import MarkdownIt from 'markdown-it'
import type { Token } from 'markdown-it'
import anchor from 'markdown-it-anchor'
import deflist from 'markdown-it-deflist'
import footnote from 'markdown-it-footnote'
import markdownItKatexModule from '@vscode/markdown-it-katex'
import mark from 'markdown-it-mark'
import sub from 'markdown-it-sub'
import sup from 'markdown-it-sup'
import taskLists from 'markdown-it-task-lists'
import type { AppSettings, OutlineItem } from '../types'
import { slugifyHeading } from './headings'
import { wikiLinks } from './noteLinks'
import { callouts } from './callouts'
import { noteSectionRange, resolveNote, type NoteIndex } from './noteIndex'
import { enhanceNotes } from './noteRendering'

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  })[character]!)

const markdownItKatex = markdownItKatexModule.default ?? markdownItKatexModule

const markdown = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: false,
  highlight(code, language) {
    if (language && hljs.getLanguage(language)) {
      return `<pre class="hljs"><code>${hljs.highlight(code, { language, ignoreIllegals: true }).value}</code></pre>`
    }
    return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`
  },
})
  .use(anchor, { slugify: slugifyHeading, getTokensText: (tokens: Token[]) => tokens.filter((token) => ['text', 'code_inline', 'margin_wiki'].includes(token.type)).map((token) => token.content).join('') })
  .use(wikiLinks)
  .use(callouts)
  .use(footnote)
  .use(deflist)
  .use(mark)
  .use(sub)
  .use(sup)
  .use(taskLists, { enabled: true, label: true, labelAfter: true })
  .use(markdownItKatex, { throwOnError: false, errorColor: '#b42318' })

const KATEX_MARKER_ATTRIBUTE = 'data-margin-katex-generated'
const katexRendererNames = ['math_inline', 'math_inline_block', 'math_inline_bare_block', 'math_block'] as const

katexRendererNames.forEach((name) => {
  const render = markdown.renderer.rules[name]
  if (!render) return
  markdown.renderer.rules[name] = (tokens, index, options, env, self) => {
    const html = render(tokens, index, options, env, self)
    const marker = typeof env?.katexMarker === 'string' ? env.katexMarker : ''
    if (!marker) return html
    return html.replace(/^<([a-z][\w-]*)/i, `<$1 ${KATEX_MARKER_ATTRIBUTE}="${escapeHtml(marker)}"`)
  }
})

markdown.core.ruler.after('github-task-lists', 'margin-task-source-lines', (state) => {
  state.tokens.forEach((token) => {
    if (token.type !== 'inline' || !token.map || !token.children) return
    const checkbox = token.children.find((child) => child.type === 'html_inline' && child.content.includes('task-list-item-checkbox'))
    if (!checkbox) return
    const rawSourceLineOffset = state.env?.sourceLineOffset
    const sourceLineOffset = typeof rawSourceLineOffset === 'number' && Number.isSafeInteger(rawSourceLineOffset) ? rawSourceLineOffset : 0
    checkbox.content = checkbox.content.replace('<input', `<input data-margin-task-line="${token.map[0] + sourceLineOffset}"`)
  })
})

markdown.core.ruler.after('anchor', 'margin-outline', (state) => {
  const outline = state.env?.outline
  if (!Array.isArray(outline)) return
  const rawOffset = state.env?.sourceLineOffset
  const sourceLineOffset = typeof rawOffset === 'number' && Number.isSafeInteger(rawOffset) ? rawOffset : 0
  state.tokens.forEach((token, index) => {
    if (token.type !== 'heading_open') return
    const inline = state.tokens[index + 1]
    if (!inline?.children) return
    const anchorText = inline.children
      .filter((child) => child.type === 'text' || child.type === 'code_inline' || child.type === 'margin_wiki')
      .map((child) => child.content)
      .join('')
    const displayText = inline.children
      .filter((child) => child.type === 'text' || child.type === 'code_inline' || child.type === 'image' || child.type === 'margin_wiki')
      .map((child) => child.content)
      .join('')
      .trim() || 'Untitled heading'
    const level = Number(token.tag.slice(1))
    const sourceLine = token.map?.[0]
    if (!Number.isInteger(level) || typeof sourceLine !== 'number') return
    outline.push({
      id: token.attrGet('id') || slugifyHeading(anchorText),
      text: displayText,
      level,
      line: sourceLine + sourceLineOffset + 1,
    })
  })
})

const defaultFence = markdown.renderer.rules.fence!
markdown.renderer.rules.fence = (tokens, index, options, env, self) => {
  const token = tokens[index]
  if (token.info.trim().toLowerCase() === 'mermaid') {
    return `<div class="mermaid-block" data-mermaid-source="${encodeURIComponent(token.content)}"><pre>${escapeHtml(token.content)}</pre></div>`
  }
  return defaultFence(tokens, index, options, env, self)
}

const defaultLinkOpen = markdown.renderer.rules.link_open
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const href = String(tokens[index].attrGet('href') || '')
  if (/^https?:\/\//i.test(href)) {
    tokens[index].attrSet('target', '_blank')
    tokens[index].attrSet('rel', 'noreferrer noopener')
  }
  return defaultLinkOpen ? defaultLinkOpen(tokens, index, options, env, self) : self.renderToken(tokens, index, options)
}

function splitFrontMatter(content: string): { frontMatter: string | null; markdown: string; sourceLineOffset: number } {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return { frontMatter: null, markdown: content, sourceLineOffset: 0 }
  const match = content.match(/^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/)
  if (!match) return { frontMatter: null, markdown: content, sourceLineOffset: 0 }
  return {
    frontMatter: match[1] ?? '',
    markdown: content.slice(match[0].length),
    sourceLineOffset: (match[0].match(/\r?\n/g) || []).length,
  }
}

export function extractOutline(content: string): OutlineItem[] {
  const { markdown: body, sourceLineOffset } = splitFrontMatter(content)
  const outline: OutlineItem[] = []
  markdown.parse(body, { sourceLineOffset, outline })
  return outline
}

export function markdownBlocks(content: string): Array<{ fromLine: number; toLine: number }> {
  const { markdown: body, sourceLineOffset, frontMatter } = splitFrontMatter(content)
  const blocks = markdown.parse(body, {}).filter((token) => token.level === 0 && token.map && token.nesting !== -1)
    .map((token) => ({ fromLine: token.map![0] + sourceLineOffset + 1, toLine: token.map![1] + sourceLineOffset }))
  if (frontMatter != null) blocks.unshift({ fromLine: 1, toLine: sourceLineOffset + (!body && !content.endsWith('\n') ? 1 : 0) || content.split('\n').length })
  return blocks
}

export interface RenderableMarkdownBlock {
  fromLine: number
  toLine: number
  render: () => string
  footnote?: boolean
}

/** Parse once for global reference/footnote/heading context; render visible blocks lazily. */
export function renderableMarkdownBlocks(content: string): RenderableMarkdownBlock[] {
  const { markdown: body, sourceLineOffset, frontMatter } = splitFrontMatter(content)
  const katexMarker = createRenderMarker()
  const env = { sourceLineOffset, katexMarker }
  const tokens = markdown.parse(body, env)
  type Plan = { fromLine: number; toLine: number; tokens: Token[]; footnotes: Token[][]; footnote?: boolean }
  const plans: Plan[] = []
  const footnotes: Token[][] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.type === 'footnote_open') {
      let end = i + 1
      while (end < tokens.length && tokens[end].type !== 'footnote_close') end += 1
      footnotes.push(tokens.slice(i, end + 1))
      i = end
      continue
    }
    if (token.level !== 0 || !token.map || token.nesting === -1) continue
    let end = i + 1
    if (token.nesting === 1) {
      while (end < tokens.length && !(tokens[end].level === token.level && tokens[end].nesting === -1)) end += 1
      end = Math.min(tokens.length, end + 1)
    }
    plans.push({ fromLine: token.map[0] + sourceLineOffset + 1, toLine: token.map[1] + sourceLineOffset, tokens: tokens.slice(i, end), footnotes: [] })
    i = end - 1
  }
  for (const chunk of footnotes) {
    const maps = chunk.flatMap((token) => token.map ? [token.map] : [])
    if (maps.length) {
      const fromLine = Math.min(...maps.map((map) => map[0])) + sourceLineOffset + 1
      const toLine = Math.max(...maps.map((map) => map[1])) + sourceLineOffset
      const containing = plans.find((plan) => plan.fromLine <= toLine && plan.toLine >= fromLine)
      if (containing) containing.footnotes.push(chunk)
      else plans.push({ fromLine, toLine, tokens: chunk, footnotes: [], footnote: true })
    } else {
      const id = chunk[0].meta?.id
      const owner = plans.find((plan) => plan.tokens.some((token) => token.children?.some((child) => child.type === 'footnote_ref' && child.meta?.id === id)))
      owner?.footnotes.push(chunk)
    }
  }
  const renderTokens = (chunk: Token[]) => markdown.renderer.render(chunk, markdown.options, env)
  const renderFootnote = (chunk: Token[]) => `<section class="footnotes"><ol start="${Number(chunk[0].meta?.id || 0) + 1}" class="footnotes-list">${renderTokens(chunk)}</ol></section>`
  const blocks: RenderableMarkdownBlock[] = plans.map((plan) => {
    let cached: string | undefined
    return {
      fromLine: plan.fromLine, toLine: plan.toLine, footnote: plan.footnote,
      render: () => cached ??= sanitizeRenderedMarkdown(annotateTaskInputs((plan.footnote ? renderFootnote(plan.tokens) : renderTokens(plan.tokens)) + plan.footnotes.map(renderFootnote).join('')), katexMarker),
    }
  })
  if (frontMatter != null) {
    const toLine = sourceLineOffset + (!body && !content.endsWith('\n') ? 1 : 0) || content.split('\n').length
    blocks.push({ fromLine: 1, toLine, render: () => renderMarkdown(content.slice(0, content.length - body.length)) })
  }
  return blocks.sort((left, right) => left.fromLine - right.fromLine)
}

export function renderMarkdownFragment(content: string, fragment: string): string {
  if (!fragment) return renderMarkdown(content)
  const range = noteSectionRange(content, fragment)
  if (!range) return ''
  const blocks = renderableMarkdownBlocks(content)
  const selected = blocks.filter((block) => block.fromLine >= range.fromLine && block.toLine <= range.toLine)
  const template = document.createElement('template')
  template.innerHTML = selected.map((block) => block.render()).join('')
  const footnotes = new Set(Array.from(template.content.querySelectorAll<HTMLAnchorElement>('.footnote-ref > a[href]')).map((anchor) => anchor.getAttribute('href')!.slice(1)))
  for (const block of blocks) {
    if (!block.footnote || selected.includes(block)) continue
    const footnote = document.createElement('template')
    footnote.innerHTML = block.render()
    if (Array.from(footnote.content.querySelectorAll('[id]')).some((element) => footnotes.has(element.id))) template.content.append(footnote.content)
  }
  if (range.blockId) {
    const marker = new RegExp(`\\s*\\^${range.blockId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const text = walker.currentNode as Text
      if (marker.test(text.data)) text.data = text.data.replace(marker, '')
    }
  }
  return template.innerHTML
}

export function renderMarkdown(content: string, lineOffset = 0): string {
  const { frontMatter, markdown: body, sourceLineOffset } = splitFrontMatter(content)
  const katexMarker = createRenderMarker()
  const rendered = annotateTaskInputs(markdown.render(body, { sourceLineOffset: sourceLineOffset + lineOffset, katexMarker }))
  const frontMatterHtml = frontMatter == null
    ? ''
    : `<details class="front-matter"><summary>Document metadata</summary><pre>${escapeHtml(frontMatter)}</pre></details>`
  return sanitizeRenderedMarkdown(frontMatterHtml + rendered, katexMarker)
}

function sanitizeRenderedMarkdown(html: string, katexMarker: string) {
  const sanitized = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['audio', 'video', 'source', 'track', 'picture', 'iframe', 'object', 'embed', 'style'],
    FORBID_ATTR: ['srcset', 'poster', 'background', 'ping', 'formaction'],
    ADD_TAGS: ['input'],
    ADD_ATTR: ['checked', 'disabled', 'target', 'rel', 'data-mermaid-source', 'data-margin-task-line', 'data-margin-asset-source', 'data-margin-note', 'data-margin-embed', KATEX_MARKER_ATTRIBUTE],
  })
  return neutralizeImageSources(preserveGeneratedKatexStyles(sanitized, katexMarker))
}

function createRenderMarker(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function preserveGeneratedKatexStyles(html: string, marker: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  template.content.querySelectorAll<HTMLElement>('[style]').forEach((element) => {
    let current: Element | null = element
    let generatedByKatex = false
    while (current) {
      if (current.getAttribute(KATEX_MARKER_ATTRIBUTE) === marker) {
        generatedByKatex = true
        break
      }
      current = current.parentElement
    }
    if (!generatedByKatex) element.removeAttribute('style')
  })
  template.content.querySelectorAll(`[${KATEX_MARKER_ATTRIBUTE}]`).forEach((element) => {
    element.removeAttribute(KATEX_MARKER_ATTRIBUTE)
  })
  return template.innerHTML
}

function neutralizeImageSources(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  template.content.querySelectorAll<HTMLImageElement>('img').forEach((image) => {
    const source = image.getAttribute('src') || image.getAttribute('srcset') || ''
    if (source) image.dataset.marginAssetSource = source
    image.removeAttribute('src')
    image.removeAttribute('srcset')
  })
  template.content.querySelectorAll<HTMLInputElement>('input[type="image"]').forEach((input) => input.remove())
  return template.innerHTML
}

function annotateTaskInputs(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  template.content.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox').forEach((checkbox) => {
    checkbox.removeAttribute('disabled')
  })
  return template.innerHTML
}

function mermaidTheme(settings: AppSettings): 'default' | 'dark' | 'neutral' {
  return settings.readerTheme === 'midnight' || settings.uiTheme === 'dark' ? 'dark' : 'neutral'
}

const assetReadsInFlight = new Map<string, Promise<string | null>>()
const mermaidSvgCache = new Map<string, string>()
let mermaidRenderQueue = Promise.resolve()
const MAX_PREVIEW_IMAGES = 100
const MAX_PREVIEW_IMAGE_DATA_CHARACTERS = 64 * 1024 * 1024
const PREVIEW_IMAGE_CONCURRENCY = 3

function readAssetDeduplicated(documentPath: string, source: string): Promise<string | null> {
  const key = `${documentPath}\0${source}`
  const existing = assetReadsInFlight.get(key)
  if (existing) return existing
  const read = window.margin.readAsset(documentPath, source)
  assetReadsInFlight.set(key, read)
  const cleanup = () => {
    if (assetReadsInFlight.get(key) === read) assetReadsInFlight.delete(key)
  }
  void read.then(cleanup, cleanup)
  return read
}

function rememberMermaidSvg(key: string, svg: string) {
  if (mermaidSvgCache.size >= 24) mermaidSvgCache.delete(mermaidSvgCache.keys().next().value ?? '')
  mermaidSvgCache.set(key, svg)
}

function enqueueMermaidRender(operation: () => Promise<string>): Promise<string> {
  const next = mermaidRenderQueue.then(operation, operation)
  mermaidRenderQueue = next.then(() => undefined, () => undefined)
  return next
}

export async function enhanceMarkdown(
  container: HTMLElement,
  documentPath: string | null,
  settings: AppSettings,
  options: { interactive?: boolean; isCurrent?: () => boolean; assetDocumentPath?: (relativePath: string) => string | null } = {},
) {
  const isCurrent = options.isCurrent ?? (() => true)
  if (!isCurrent()) return
  const images = Array.from(container.querySelectorAll<HTMLImageElement>('img[data-margin-asset-source]'))
  images.slice(MAX_PREVIEW_IMAGES).forEach((image) => {
    const source = image.dataset.marginAssetSource || ''
    image.removeAttribute('data-margin-asset-source')
    image.replaceWith(createAssetNotice('Preview image limit reached', source))
  })
  const queuedImages = images.slice(0, MAX_PREVIEW_IMAGES)
  let loadedImageCharacters = 0
  let imageCursor = 0
  const processImage = async (image: HTMLImageElement) => {
    if (!isCurrent()) return
    const source = image.dataset.marginAssetSource || ''
    const imageDocumentPath = image.dataset.marginAssetDocument
      ? options.assetDocumentPath?.(image.dataset.marginAssetDocument) ?? null : documentPath
    if (/^(?:https?:)?\/\//i.test(source)) {
      image.removeAttribute('data-margin-asset-source')
      image.replaceWith(createAssetNotice('Remote image blocked', source))
      return
    }
    if (/^data:/i.test(source)) {
      image.removeAttribute('data-margin-asset-source')
      if (!/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,/i.test(source) || source.length > 28 * 1024 * 1024) {
        image.replaceWith(createAssetNotice('Inline image blocked', 'Only common bitmap data images are supported.'))
      } else if (loadedImageCharacters + source.length > MAX_PREVIEW_IMAGE_DATA_CHARACTERS) {
        image.replaceWith(createAssetNotice('Preview image memory limit reached', 'Open the image separately to view it.'))
      } else {
        loadedImageCharacters += source.length
        image.src = source
      }
      return
    }
    if (!source || /^(?:blob:|file:|#)/i.test(source) || /^[/\\]{2}/.test(source) || /^[a-z]:[\\/]/i.test(source)) {
      image.removeAttribute('data-margin-asset-source')
      image.replaceWith(createAssetNotice('Image path blocked', source || 'Empty image path'))
      return
    }
    if (!imageDocumentPath) {
      image.removeAttribute('data-margin-asset-source')
      image.replaceWith(createAssetNotice('Save to load this image', source))
      return
    }
    try {
      const data = await readAssetDeduplicated(imageDocumentPath, source)
      if (!isCurrent()) return
      image.removeAttribute('data-margin-asset-source')
      if (data && loadedImageCharacters + data.length <= MAX_PREVIEW_IMAGE_DATA_CHARACTERS) {
        loadedImageCharacters += data.length
        image.src = data
      }
      else if (data) image.replaceWith(createAssetNotice('Preview image memory limit reached', 'Open the image separately to view it.'))
      else image.replaceWith(createAssetNotice('Image not found', source))
    } catch {
      if (!isCurrent()) return
      image.removeAttribute('data-margin-asset-source')
      image.replaceWith(createAssetNotice('Image not found', source))
    }
  }
  const imageWorker = async () => {
    while (imageCursor < queuedImages.length && isCurrent()) {
      const index = imageCursor
      imageCursor += 1
      await processImage(queuedImages[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(PREVIEW_IMAGE_CONCURRENCY, queuedImages.length) }, imageWorker))

  if (!isCurrent()) return
  if (options.interactive !== false) {
    container.querySelectorAll<HTMLElement>('pre > code').forEach((code) => {
      const pre = code.parentElement
      if (!pre || pre.parentElement?.classList.contains('margin-code-block')) return
      const wrapper = document.createElement('div')
      wrapper.className = 'margin-code-block'
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.marginCopyCode = ''
      button.setAttribute('aria-label', 'Copy code block')
      button.textContent = 'Copy'
      pre.replaceWith(wrapper)
      wrapper.append(pre, button)
    })
  }

  const diagrams = Array.from(container.querySelectorAll<HTMLElement>('[data-mermaid-source]'))
  if (!diagrams.length || !isCurrent()) return
  const theme = mermaidTheme(settings)
  for (const [diagramIndex, diagram] of diagrams.entries()) {
    try {
      const source = decodeURIComponent(diagram.dataset.mermaidSource || '')
      const cacheKey = `${theme}\0${diagramIndex}\0${source}`
      let svg = mermaidSvgCache.get(cacheKey)
      if (!svg) svg = await enqueueMermaidRender(async () => {
        if (!isCurrent()) return ''
        const { default: mermaid } = await import('mermaid')
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme,
          fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
          flowchart: { htmlLabels: false },
        })
        const id = `margin-diagram-${crypto.randomUUID().replaceAll('-', '')}`
        const result = await mermaid.render(id, source)
        const sanitized = DOMPurify.sanitize(convertMermaidLabelsToSvgText(result.svg), {
          USE_PROFILES: { svg: true, svgFilters: true },
          ADD_ATTR: ['role', 'aria-label', 'aria-roledescription'],
        })
        rememberMermaidSvg(cacheKey, sanitized)
        return sanitized
      })
      if (!isCurrent() || !svg) return
      diagram.innerHTML = svg
      diagram.classList.add('is-rendered')
    } catch (error) {
      if (!isCurrent()) return
      diagram.replaceChildren(createDiagramError(error instanceof Error ? error.message : 'This diagram could not be rendered.'))
      diagram.classList.add('has-error')
    }
  }
}

function convertMermaidLabelsToSvgText(svgSource: string): string {
  const parsed = new DOMParser().parseFromString(svgSource, 'image/svg+xml')
  if (parsed.querySelector('parsererror')) return svgSource
  parsed.querySelectorAll('foreignObject').forEach((foreignObject) => {
    const label = (foreignObject.textContent || '').replace(/\s+/g, ' ').trim()
    if (!label) return
    const width = Number.parseFloat(foreignObject.getAttribute('width') || '0')
    const height = Number.parseFloat(foreignObject.getAttribute('height') || '0')
    const text = parsed.createElementNS('http://www.w3.org/2000/svg', 'text')
    text.setAttribute('x', String(width / 2))
    text.setAttribute('y', String(height / 2))
    text.setAttribute('dy', '0.35em')
    text.setAttribute('text-anchor', 'middle')
    text.setAttribute('class', 'margin-mermaid-label')
    text.textContent = label
    foreignObject.replaceWith(text)
  })
  return new XMLSerializer().serializeToString(parsed.documentElement)
}

function createAssetNotice(label: string, source: string): HTMLElement {
  const notice = document.createElement('span')
  notice.className = 'asset-notice'
  const strong = document.createElement('strong')
  strong.textContent = label
  const detail = document.createElement('span')
  detail.textContent = source
  notice.append(strong, detail)
  return notice
}

function createDiagramError(message: string): HTMLElement {
  const notice = document.createElement('div')
  notice.className = 'diagram-error'
  const strong = document.createElement('strong')
  strong.textContent = 'Mermaid needs a small edit'
  const detail = document.createElement('span')
  detail.textContent = message.split('\n')[0]
  notice.append(strong, detail)
  return notice
}

function paletteFor(settings: AppSettings) {
  const palettes = {
    paper: { background: '#f7f4ec', text: '#282922', accent: '#27766f' },
    snow: { background: '#ffffff', text: '#202321', accent: '#176f67' },
    sepia: { background: '#f2e6cb', text: '#3d3325', accent: '#8a4b2b' },
    midnight: { background: '#191c1b', text: '#e8e8e2', accent: '#73c4ba' },
    custom: { background: settings.customBackground, text: settings.customText, accent: settings.customAccent },
  }
  return palettes[settings.readerTheme]
}

const exportBaseCss = `
*{box-sizing:border-box}html{background:var(--reader-bg);color:var(--reader-text)}
body{margin:0;padding:56px 28px 80px;background:var(--reader-bg);color:var(--reader-text)}
main{max-width:var(--reader-width);margin:0 auto;font-family:var(--reader-font);font-size:var(--reader-size);line-height:var(--reader-leading)}
h1,h2,h3,h4,h5,h6{font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.2;letter-spacing:-.025em;margin:1.8em 0 .65em;page-break-after:avoid}
h1{font-size:2.35em;margin-top:.25em}h2{font-size:1.7em;border-bottom:1px solid color-mix(in srgb,var(--reader-text) 15%,transparent);padding-bottom:.28em}
h3{font-size:1.3em}p{margin:0 0 1.15em}a{color:var(--reader-accent);text-underline-offset:3px}
blockquote{border-left:3px solid var(--reader-accent);margin:1.5em 0;padding:.15em 0 .15em 1.2em;color:color-mix(in srgb,var(--reader-text) 75%,transparent)}
pre{overflow:auto;padding:1.1em 1.25em;border-radius:8px;background:color-mix(in srgb,var(--reader-text) 7%,var(--reader-bg));page-break-inside:avoid}
code,kbd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em}p code,li code{padding:.13em .34em;border-radius:4px;background:color-mix(in srgb,var(--reader-text) 8%,var(--reader-bg))}
table{border-collapse:collapse;width:100%;display:block;overflow:auto;margin:1.4em 0}th,td{border:1px solid color-mix(in srgb,var(--reader-text) 18%,transparent);padding:.55em .75em;text-align:left}th{background:color-mix(in srgb,var(--reader-text) 6%,var(--reader-bg))}
img,svg{max-width:100%;height:auto}.mermaid-block{text-align:center;margin:2em auto;page-break-inside:avoid}.footnotes{font-size:.86em;margin-top:4em;border-top:1px solid currentColor}
.front-matter{font-family:ui-monospace,monospace;font-size:.78em;margin-bottom:2em}.task-list-item{list-style:none}.task-list-item input{margin-left:-1.35em;margin-right:.45em}
.asset-notice,.diagram-error{display:flex;flex-direction:column;border:1px dashed currentColor;border-radius:8px;padding:1em;font-family:ui-sans-serif,system-ui,sans-serif;font-size:.8em;opacity:.75}
.note-embed,.markdown-callout{display:block;border:1px solid color-mix(in srgb,var(--reader-text) 18%,transparent);border-left:3px solid var(--reader-accent);border-radius:6px;padding:16px 20px;margin:1.4em 0;break-inside:avoid}.note-embed>a,.callout-title{display:block;font:600 .85em/1.5 system-ui,sans-serif;margin-bottom:.7em;color:var(--reader-accent)}.note-embed-body>:first-child{margin-top:0}.note-embed-body>:last-child{margin-bottom:0}
@page{size:A4;margin:16mm 17mm} @media print{body{padding:0}a{color:inherit}pre,blockquote,table,.mermaid-block{page-break-inside:avoid}}
`

export async function createExportHtml(content: string, documentPath: string | null, title: string, settings: AppSettings,
  notes?: { index: NoteIndex; relativePath: string; assetDocumentPath: (path: string) => string | null; expandCallouts?: boolean },
): Promise<string> {
  const { katexExportCss } = await import('./katexExportCss')
  const container = document.createElement('main')
  container.className = 'markdown-body'
  container.innerHTML = renderMarkdown(content)
  if (notes) {
    enhanceNotes(container, notes.index, notes.relativePath)
    container.querySelectorAll<HTMLAnchorElement>('a[data-margin-note]').forEach((anchor) => {
      const resolved = resolveNote(notes.index, anchor.dataset.marginNote || '', anchor.dataset.marginNoteOrigin || notes.relativePath, anchor.dataset.marginNoteKind !== 'markdown')
      if (!resolved) { anchor.removeAttribute('href'); return }
      const sourceDirectory = notes.relativePath.split('/').slice(0, -1)
      const target = resolved.note.relativePath.split('/')
      while (sourceDirectory[0] === target[0] && sourceDirectory.length && target.length) { sourceDirectory.shift(); target.shift() }
      anchor.setAttribute('href', `${sourceDirectory.map(() => '..').concat(target).map(encodeURIComponent).join('/')}${resolved.fragment ? `#${encodeURIComponent(resolved.fragment)}` : ''}`)
    })
  }
  await enhanceMarkdown(container, documentPath, settings, { interactive: false, assetDocumentPath: notes?.assetDocumentPath })
  container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => { input.disabled = true })
  if (notes?.expandCallouts) container.querySelectorAll<HTMLDetailsElement>('details.markdown-callout').forEach((details) => { details.open = true })
  const palette = paletteFor(settings)
  const fonts = {
    serif: "Iowan Old Style, Charter, 'Palatino Linotype', Georgia, serif",
    sans: 'Inter, ui-sans-serif, system-ui, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">
<title>${escapeHtml(title)}</title><style>
:root{--reader-bg:${palette.background};--reader-text:${palette.text};--reader-accent:${palette.accent};--reader-font:${fonts[settings.readerFont]};--reader-size:${settings.fontSize}px;--reader-leading:${settings.lineHeight};--reader-width:${settings.contentWidth}px}
${exportBaseCss}\n${katexExportCss}\n${highlightCssSource}
</style></head><body>${container.outerHTML}</body></html>`
}
