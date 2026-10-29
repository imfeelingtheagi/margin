import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, undo, redo } from '@codemirror/commands'
import { toggleEditorTask } from './editorTasks'

describe('reader task editing', () => {
  it('isolates checkbox undo from recent typing and preserves quoted task syntax', () => {
    const view = new EditorView({ state: EditorState.create({ doc: '> - [ ] Task\n', extensions: [history()] }) })
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'Recent typing.' }, userEvent: 'input.type' })
    toggleEditorTask(view, 0, true)
    expect(view.state.doc.toString()).toBe('> - [x] Task\nRecent typing.')
    undo(view)
    expect(view.state.doc.toString()).toBe('> - [ ] Task\nRecent typing.')
    redo(view)
    expect(view.state.doc.toString()).toBe('> - [x] Task\nRecent typing.')
    view.destroy()
  })
})
