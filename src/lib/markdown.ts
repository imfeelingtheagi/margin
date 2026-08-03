import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import highlightCssSource from 'highlight.js/styles/github.css?raw'
import MarkdownIt from 'markdown-it'
import anchor from 'markdown-it-anchor'
import deflist from 'markdown-it-deflist'
import footnote from 'markdown-it-footnote'
import markdownItKatexModule from '@vscode/markdown-it-katex'
import mark from 'markdown-it-mark'
import sub from 'markdown-it-sub'
import sup from 'markdown-it-sup'
import taskLists from 'markdown-it-task-lists'
import type { AppSettings } from '../types'
import { slugifyHeading } from './document'

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
  .use(anchor, { slugify: slugifyHeading })
  .use(footnote)
  .use(deflist)
  .use(mark)
  .use(sub)
  .use(sup)
  .use(taskLists, { enabled: false, label: true, labelAfter: true })
  .use(markdownItKatex, { throwOnError: false, errorColor: '#b42318' })

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

function splitFrontMatter(content: string): { frontMatter: string | null; markdown: string } {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return { frontMatter: null, markdown: content }
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return { frontMatter: null, markdown: content }
  return { frontMatter: match[1], markdown: content.slice(match[0].length) }
}

export function renderMarkdown(content: string): string {
  const { frontMatter, markdown: body } = splitFrontMatter(content)
  const rendered = markdown.render(body)
  const frontMatterHtml = frontMatter == null
    ? ''
    : `<details class="front-matter"><summary>Document metadata</summary><pre>${escapeHtml(frontMatter)}</pre></details>`
  return DOMPurify.sanitize(frontMatterHtml + rendered, {
    USE_PROFILES: { html: true },
    ADD_TAGS: ['input'],
    ADD_ATTR: ['checked', 'disabled', 'target', 'rel', 'data-mermaid-source'],
  })
}

function mermaidTheme(settings: AppSettings): 'default' | 'dark' | 'neutral' {
  return settings.readerTheme === 'midnight' || settings.uiTheme === 'dark' ? 'dark' : 'neutral'
}

export async function enhanceMarkdown(container: HTMLElement, documentPath: string | null, settings: AppSettings) {
  const images = Array.from(container.querySelectorAll<HTMLImageElement>('img[src]'))
  await Promise.all(images.map(async (image) => {
    const source = image.getAttribute('src') || ''
    if (/^https?:\/\//i.test(source)) {
      image.replaceWith(createAssetNotice('Remote image blocked', source))
      return
    }
    if (!documentPath || /^(?:data:|blob:|#)/i.test(source)) return
    try {
      const data = await window.margin.readAsset(documentPath, source)
      if (data) image.src = data
      else image.replaceWith(createAssetNotice('Image not found', source))
    } catch {
      image.replaceWith(createAssetNotice('Image not found', source))
    }
  }))

  const diagrams = Array.from(container.querySelectorAll<HTMLElement>('[data-mermaid-source]'))
  if (!diagrams.length) return
  const { default: mermaid } = await import('mermaid')
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: mermaidTheme(settings),
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
    flowchart: { htmlLabels: false },
  })
  for (const diagram of diagrams) {
    try {
      const source = decodeURIComponent(diagram.dataset.mermaidSource || '')
      const id = `margin-diagram-${crypto.randomUUID().replaceAll('-', '')}`
      const result = await mermaid.render(id, source)
      diagram.innerHTML = DOMPurify.sanitize(convertMermaidLabelsToSvgText(result.svg), {
        USE_PROFILES: { svg: true, svgFilters: true },
        ADD_ATTR: ['role', 'aria-label', 'aria-roledescription'],
      })
      diagram.classList.add('is-rendered')
    } catch (error) {
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
@page{size:A4;margin:16mm 17mm} @media print{body{padding:0}a{color:inherit}pre,blockquote,table,.mermaid-block{page-break-inside:avoid}}
`

export async function createExportHtml(content: string, documentPath: string | null, title: string, settings: AppSettings): Promise<string> {
  const { katexExportCss } = await import('./katexExportCss')
  const container = document.createElement('main')
  container.className = 'markdown-body'
  container.innerHTML = renderMarkdown(content)
  await enhanceMarkdown(container, documentPath, settings)
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
