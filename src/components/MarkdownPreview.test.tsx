import { fireEvent, render, screen } from '@testing-library/react'
import { createDocument, DEFAULT_SETTINGS } from '../lib/document'
import { MarkdownPreview } from './MarkdownPreview'

describe('MarkdownPreview', () => {
  it('reports a reading position before a document can unmount or close', () => {
    const tab = { ...createDocument('# Heading\n\nParagraph.'), mode: 'read' as const }
    const onProgress = vi.fn()
    const { unmount } = render(<MarkdownPreview tab={tab} active settings={DEFAULT_SETTINGS} onProgress={onProgress} />)
    const pane = screen.getByRole('region', { name: 'Rendered preview' })
    Object.defineProperties(pane, { scrollTop: { value: 300, configurable: true }, scrollHeight: { value: 1000, configurable: true }, clientHeight: { value: 400, configurable: true } })
    fireEvent.scroll(pane)
    unmount()
    expect(onProgress).toHaveBeenCalledWith(tab.id, 300, .5)
  })
  it('enhances preview code blocks after rendering', async () => {
    const tab = {
      ...createDocument('```js\nconst local = true\n```'),
      mode: 'read' as const,
    }

    const { rerender } = render(<MarkdownPreview tab={tab} active settings={DEFAULT_SETTINGS} />)

    const copyButton = await screen.findByRole('button', { name: 'Copy code block' })
    expect(copyButton).toHaveTextContent('Copy')

    rerender(<MarkdownPreview tab={{ ...tab, readerScrollTop: 120 }} active settings={DEFAULT_SETTINGS} />)

    expect(screen.getByRole('button', { name: 'Copy code block' })).toBe(copyButton)
  })

  it('reports task clicks with their source line and checked state', () => {
    const tab = {
      ...createDocument('- [ ] Ship the preview'),
      mode: 'read' as const,
    }
    const onToggleTask = vi.fn()
    render(<MarkdownPreview tab={tab} active settings={DEFAULT_SETTINGS} onToggleTask={onToggleTask} />)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Ship the preview' }))

    expect(onToggleTask).toHaveBeenCalledWith(tab.id, 0, true)
  })

  it('disables stale split-preview tasks until the debounced source catches up', () => {
    const tab = {
      ...createDocument('- [ ] Ship the preview'),
      mode: 'split' as const,
    }
    const onToggleTask = vi.fn()
    const { rerender } = render(<MarkdownPreview tab={tab} active settings={DEFAULT_SETTINGS} onToggleTask={onToggleTask} />)

    rerender(<MarkdownPreview tab={{ ...tab, content: 'New first line\n- [ ] Ship the preview' }} active settings={DEFAULT_SETTINGS} onToggleTask={onToggleTask} />)

    const checkbox = screen.getByRole('checkbox', { name: 'Ship the preview' })
    expect(checkbox).toBeDisabled()
    fireEvent.click(checkbox)
    expect(onToggleTask).not.toHaveBeenCalled()
  })
})
