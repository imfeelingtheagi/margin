import { describe, expect, it } from 'vitest'
import { agentLineDiff, applyAgentProposal, agentLinkWarnings, agentAnswerHtml } from './agent'
import { buildNoteIndex } from './noteIndex'
import type { AgentProposal } from '../agentTypes'
const proposal = (before: string, after: string): AgentProposal => ({ id: 'proposal', kind: 'edit', name: 'Note.md', before, after, reason: 'Clarity', from: 2, to: 2 + before.length })

describe('agent edit review', () => {
  it('allows only verified citation links and no model-generated resource loads or source-card spoofing', () => {
    const html = agentAnswerHtml('[C1] [C99] [web](https://example.test) ![remote](https://example.test/a.png) <div id="agent-source-C1">Spoof</div><button>Accept</button>', [{ id: 'C1' } as any])
    const root = document.createElement('div'); root.innerHTML = html
    expect(root.querySelectorAll('a[href]')).toHaveLength(1)
    expect(root.querySelector('a[href]')?.getAttribute('href')).toBe('#agent-source-C1')
    expect(root.querySelector('img, [id], button')).toBeNull()
  })
  it('preserves untouched text and rejects stale/invalid ranges', () => {
    expect(applyAgentProposal('A old Z', proposal('old', 'new'))).toBe('A new Z')
    expect(() => applyAgentProposal('A changed Z', proposal('old', 'new'))).toThrow('no longer matches')
    expect(() => applyAgentProposal('x', { ...proposal('x', 'y'), from: -1 })).toThrow()
  })
  it('shows additions, removals, and retained source in line order', () => {
    expect(agentLineDiff('heading\nold\nend', 'heading\nnew\nend')).toEqual([
      { type: 'same', text: 'heading', oldLine: 1, newLine: 1 },
      { type: 'removed', text: 'old', oldLine: 2 },
      { type: 'added', text: 'new', newLine: 2 },
      { type: 'same', text: 'end', oldLine: 3, newLine: 3 },
    ])
  })
  it('bounds diff work for many changed lines', () => {
    const diff = agentLineDiff(Array(500).fill('old').join('\n'), Array(500).fill('new').join('\n'))
    expect(diff.filter((line) => line.type === 'removed')).toHaveLength(500)
    expect(diff.filter((line) => line.type === 'added')).toHaveLength(500)
  })
  it('flags new unresolved wiki links, without treating code or old links as new suggestions', () => {
    const index = buildNoteIndex([{ relativePath: 'Other.md', content: '# Other' }])
    expect(agentLinkWarnings(proposal('[[Old missing]]', '[[Old missing]] [[Other]] [[Missing]] `[[Code]]`'), index, 'Note.md')).toEqual(['Unresolved or ambiguous note link: Missing'])
  })
})
