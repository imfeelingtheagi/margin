import { DEFAULT_SETTINGS } from './document'
import { katexExportCss } from './katexExportCss'
import { createExportHtml, enhanceMarkdown, renderMarkdown } from './markdown'
import type { MarginApi } from '../types'

describe('Markdown rendering', () => {
  it('supports rich Markdown while removing executable HTML', () => {
    const html = renderMarkdown(`# Safe

<script>window.bad = true</script>
<img src="note.png" onerror="window.bad = true">

Term
: Definition

Footnote[^1]

[^1]: Local only`)

    expect(html).toContain('<h1')
    expect(html).toContain('<dl>')
    expect(html).toContain('class="footnote-ref"')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('src="note.png"')
    expect(html).toContain('data-margin-asset-source="note.png"')
  })

  it('preserves generated KaTeX layout and leaves Mermaid source for the isolated enhancer', () => {
    const html = renderMarkdown('$\\frac{a}{b} + x^2$\n\n```mermaid\nflowchart LR\n  Draft --> Read\n```')

    expect(html).toContain('class="katex"')
    expect(html).toMatch(/style="[^"]*(?:height|top|vertical-align):/)
    expect(html).not.toContain('data-margin-katex-generated')
    expect(html).toContain('data-mermaid-source=')
    expect(html).toContain('flowchart%20LR')
  })

  it('maps interactive tasks to their real source lines outside code fences', () => {
    const html = renderMarkdown('```text\n- [ ] example only\n```\n\n- [ ] real task')

    expect(html).toContain('data-margin-task-line="4"')
    expect(html).not.toContain('data-margin-task-line="1"')
    expect(html).not.toContain('disabled')
  })

  it('keeps task source lines aligned after front matter', () => {
    const html = renderMarkdown('---\ntitle: Tasks\n---\n- [ ] real task')

    expect(html).toContain('data-margin-task-line="3"')
  })

  it('recognizes empty front matter without creating a horizontal rule', () => {
    const html = renderMarkdown('---\n---\n# Heading')

    expect(html).toContain('class="front-matter"')
    expect(html).toContain('<h1')
    expect(html).not.toContain('<hr>')
  })

  it('adds copy controls to preview code without adding them to exports', async () => {
    const preview = document.createElement('article')
    preview.innerHTML = renderMarkdown('```js\nconst local = true\n```')

    await enhanceMarkdown(preview, null, DEFAULT_SETTINGS)
    expect(preview.querySelector('.margin-code-block [data-margin-copy-code]')).toHaveTextContent('Copy')

    const exported = document.createElement('article')
    exported.innerHTML = renderMarkdown('```js\nconst local = true\n```')
    await enhanceMarkdown(exported, null, DEFAULT_SETTINGS, { interactive: false })
    expect(exported.querySelector('[data-margin-copy-code]')).toBeNull()
  })

  it('keeps image paths inert until the local asset broker resolves them', async () => {
    const preview = document.createElement('article')
    preview.innerHTML = renderMarkdown('![local](assets/photo.png)\n\n![remote](//server/share/photo.png)')
    expect(preview.querySelectorAll('img[src]')).toHaveLength(0)

    await enhanceMarkdown(preview, null, DEFAULT_SETTINGS)

    expect(preview.querySelectorAll('img[src]')).toHaveLength(0)
    expect(preview.textContent).toContain('Save to load this image')
    expect(preview.textContent).toContain('Remote image blocked')
  })

  it('bounds local image reads and preview image count', async () => {
    const originalMargin = window.margin
    let active = 0
    let peak = 0
    const readAsset = vi.fn(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => window.setTimeout(resolve, 1))
      active -= 1
      return 'data:image/png;base64,eA=='
    })
    Object.defineProperty(window, 'margin', {
      configurable: true,
      writable: true,
      value: { readAsset } as Partial<MarginApi>,
    })
    try {
      const preview = document.createElement('article')
      preview.innerHTML = Array.from({ length: 105 }, (_, index) => `<img data-margin-asset-source="assets/${index}.png">`).join('')
      await enhanceMarkdown(preview, '/notes/index.md', DEFAULT_SETTINGS)

      expect(readAsset).toHaveBeenCalledTimes(100)
      expect(peak).toBeLessThanOrEqual(3)
      expect(preview.textContent).toContain('Preview image limit reached')
    } finally {
      if (originalMargin) window.margin = originalMargin
      else delete (window as unknown as { margin?: MarginApi }).margin
    }
  })

  it('strips raw HTML media and CSS loading surfaces', () => {
    const html = renderMarkdown('<picture><source srcset="//server/share/a.png"><img srcset="//server/share/b.png"></picture><video poster="//server/poster.png"></video><p style="background:url(//server/bg.png)">Safe text</p>')

    expect(html).not.toContain('<source')
    expect(html).not.toContain('<video')
    expect(html).not.toContain('srcset')
    expect(html).not.toContain('poster')
    expect(html).not.toContain('style=')
    expect(html).toContain('Safe text')
  })
})

describe('portable export', () => {
  it('embeds every KaTeX WOFF2 face without external font paths', () => {
    expect(katexExportCss.match(/data:font\/woff2;base64,/g)).toHaveLength(20)
    expect(katexExportCss).not.toContain('url(fonts/')
    expect(katexExportCss).not.toMatch(/\.woff(?:\)|")/)
    expect(katexExportCss).not.toMatch(/\.ttf(?:\)|")/)
  })

  it('creates a self-contained, locked-down HTML document', async () => {
    const html = await createExportHtml('# Offline\n\n$E = mc^2$', null, 'Offline note', DEFAULT_SETTINGS)

    expect(html).toContain('<!doctype html>')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain('data:font/woff2;base64,')
    expect(html).not.toContain('file://')
    expect(html).not.toContain('http://')
  })
})
