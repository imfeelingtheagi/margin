import { activateReaderFindMatch, clearReaderFind, highlightReaderFind } from './readerFind'

describe('reader find', () => {
  it('highlights visible preview text without touching SVG labels', () => {
    const container = document.createElement('article')
    container.innerHTML = '<h1>Margin notes</h1><p>margin twice: Margin</p><svg><text>Margin diagram</text></svg>'

    const matches = highlightReaderFind(container, 'margin')

    expect(matches).toHaveLength(3)
    expect(container.querySelectorAll('svg mark')).toHaveLength(0)
    expect(container.textContent).toContain('Margin diagram')
  })

  it('moves the current match in either direction with wraparound', () => {
    const container = document.createElement('article')
    container.textContent = 'one one'
    const matches = highlightReaderFind(container, 'one')

    expect(activateReaderFindMatch(matches, 0)).toBe(0)
    expect(activateReaderFindMatch(matches, -1)).toBe(1)
    expect(matches[1]).toHaveClass('is-current')
  })

  it('restores the original text when find closes', () => {
    const container = document.createElement('article')
    container.innerHTML = '<p>Read Margin</p>'
    highlightReaderFind(container, 'Margin')

    clearReaderFind(container)

    expect(container.querySelector('mark')).toBeNull()
    expect(container.innerHTML).toBe('<p>Read Margin</p>')
  })

  it('uses match indices from the original Unicode text', () => {
    const container = document.createElement('article')
    container.textContent = 'İstanbul İSTANBUL'

    const matches = highlightReaderFind(container, 'İ')

    expect(matches.map((match) => match.textContent)).toEqual(['İ', 'İ'])
    expect(container.textContent).toBe('İstanbul İSTANBUL')
  })

  it('does not treat preview controls as document matches', () => {
    const container = document.createElement('article')
    container.innerHTML = '<p>Copy this value</p><button data-margin-copy-code>Copy</button>'

    expect(highlightReaderFind(container, 'copy')).toHaveLength(1)
    expect(container.querySelector('button mark')).toBeNull()
  })
})
