import { useMemo } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { searchKeymap } from '@codemirror/search'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import type { DocumentTab } from '../types'

interface EditorPaneProps {
  tab: DocumentTab
  active: boolean
  dark: boolean
  onChange: (id: string, content: string) => void
  onCursor: (id: string, line: number, column: number) => void
  onCreate: (id: string, view: EditorView) => void
}

export function EditorPane({ tab, active, dark, onChange, onCursor, onCreate }: EditorPaneProps) {
  const theme = useMemo(() => EditorViewTheme(dark), [dark])
  const extensions = useMemo(() => [
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    keymap.of(searchKeymap),
    placeholder('Start writing in Markdown…'),
  ], [])

  const handleUpdate = (update: ViewUpdate) => {
    if (!update.selectionSet && !update.docChanged) return
    const head = update.state.selection.main.head
    const line = update.state.doc.lineAt(head)
    onCursor(tab.id, line.number, head - line.from + 1)
  }

  return (
    <section
      className={`editor-pane ${active ? 'is-active' : ''}`}
      aria-hidden={!active}
      data-editor-id={tab.id}
    >
      <CodeMirror
        value={tab.content}
        height="100%"
        theme={theme}
        extensions={extensions}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: false,
          rectangularSelection: true,
        }}
        onChange={(value) => onChange(tab.id, value)}
        onUpdate={handleUpdate}
        onCreateEditor={(view) => onCreate(tab.id, view)}
      />
    </section>
  )
}

function EditorViewTheme(dark: boolean) {
  return EditorView.theme({
    '&': {
      height: '100%',
      backgroundColor: dark ? '#1d201f' : '#fbfaf7',
      color: dark ? '#e8e8e2' : '#282b29',
      fontSize: '15px',
    },
    '.cm-scroller': {
      fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
      lineHeight: '1.68',
      padding: '30px 0 60px',
      overflow: 'auto',
    },
    '.cm-content': { padding: '0 7vw', maxWidth: '1120px', margin: '0 auto', width: '100%' },
    '.cm-gutters': {
      backgroundColor: dark ? '#1d201f' : '#fbfaf7',
      color: dark ? '#6f7773' : '#a3a49e',
      border: 'none',
    },
    '.cm-activeLine': { backgroundColor: dark ? '#252a283d' : '#e8e7df66' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: dark ? '#aab3ae' : '#656963' },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor': { borderLeftColor: dark ? '#73c4ba' : '#27766f' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: dark ? '#315e59aa' : '#a9d9d2aa',
    },
    '.cm-panels': {
      backgroundColor: dark ? '#252927' : '#f0eee8',
      color: dark ? '#e8e8e2' : '#282b29',
    },
  }, { dark })
}
