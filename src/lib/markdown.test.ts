import { DEFAULT_SETTINGS } from './document'
import { katexExportCss } from './katexExportCss'
import { createExportHtml, renderMarkdown } from './markdown'

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
  })

  it('renders math and leaves Mermaid source for the isolated enhancer', () => {
    const html = renderMarkdown('$E = mc^2$\n\n```mermaid\nflowchart LR\n  Draft --> Read\n```')

    expect(html).toContain('class="katex"')
    expect(html).toContain('data-mermaid-source=')
    expect(html).toContain('flowchart%20LR')
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
