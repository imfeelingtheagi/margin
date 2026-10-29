import { isolateHistory } from '@codemirror/commands'
import type { EditorView } from '@codemirror/view'

export function toggleEditorTask(view: EditorView, sourceLine: number, checked: boolean) {
  if (!Number.isSafeInteger(sourceLine) || sourceLine < 0 || sourceLine >= view.state.doc.lines) return
  const line = view.state.doc.line(sourceLine + 1)
  const match = line.text.match(/^((?:[\t ]*>[\t ]?)*[\t ]*(?:[-+*]|\d+[.)])\s+\[)([ xX])(\])/)
  if (!match) return
  const marker = line.from + match[1].length
  const insert = checked ? 'x' : ' '
  if (view.state.sliceDoc(marker, marker + 1).toLowerCase() === insert) return
  view.dispatch({ changes: { from: marker, to: marker + 1, insert }, userEvent: 'input.task', annotations: isolateHistory.of('full') })
}
