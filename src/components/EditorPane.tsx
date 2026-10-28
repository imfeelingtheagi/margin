import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { indentUnit } from '@codemirror/language'
import { searchKeymap } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import {
  EditorView, highlightWhitespace, keymap, placeholder, scrollPastEnd,
} from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import type { CompletionContext } from '@codemirror/autocomplete'
import type { AppSettings, DocumentTab } from '../types'
import { getMarkdownTableNavigation } from '../lib/markdownTable'
import { livePreview, MAX_LIVE_DOCUMENT_LENGTH, writingFocus } from '../lib/livePreview'
import { noteStem, type NoteIndex } from '../lib/noteIndex'

interface EditorPaneProps {
  tab: DocumentTab
  active: boolean
  dark: boolean
  settings: AppSettings
  onChange: (id: string, content: string) => void
  onCursor: (id: string, line: number, column: number, anchor: number, head: number) => void
  onScroll: (id: string, scrollTop: number, scrollLeft: number) => void
  onCreate: (id: string, view: EditorView) => void
  onImportImages: (id: string, files: File[], selection: { from: number; to: number }) => void
  notes: NoteIndex
  relativePath: string
  assetDocumentPath: (relativePath: string) => string | null
  onOpenNote: (target: string, origin: string, wiki: boolean) => void
}

export const EditorPane = memo(function EditorPane({
  tab, active, dark, settings, onChange, onCursor, onScroll, onCreate, onImportImages,
  notes, relativePath, assetDocumentPath, onOpenNote,
}: EditorPaneProps) {
  const viewRef = useRef<EditorView | null>(null)
  const scrollFrameRef = useRef<number | null>(null)
  const tabRef = useRef(tab)
  tabRef.current = tab
  const theme = useMemo(() => editorViewTheme(dark, settings), [
    dark, settings.editorContentWidth, settings.editorFont, settings.editorFontSize, settings.editorLineHeight,
  ])
  const extensions = useMemo(() => [
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    keymap.of([markdownTableTabBinding, indentWithTab, ...searchKeymap]),
    EditorState.tabSize.of(settings.editorTabSize),
    indentUnit.of(settings.editorIndentWithTabs ? '\t' : ' '.repeat(settings.editorTabSize)),
    EditorView.contentAttributes.of({
      spellcheck: settings.editorSpellcheck ? 'true' : 'false',
      autocapitalize: settings.editorSpellcheck ? 'sentences' : 'off',
      autocorrect: settings.editorSpellcheck ? 'on' : 'off',
    }),
    settings.editorWordWrap ? EditorView.lineWrapping : [],
    settings.editorShowWhitespace ? highlightWhitespace() : [],
    settings.editorTypewriterMode ? typewriterMode() : [],
    settings.editorFocus !== 'off' ? writingFocus(settings.editorFocus) : [],
    tab.mode === 'live' ? livePreview({ settings, path: tab.path, notes, relativePath, assetDocumentPath, onOpenNote }) : [],
    markdownLanguage.data.of({ autocomplete: (context: CompletionContext) => {
      const match = context.matchBefore(/!?(?:\[\[)[^\]\n]*/)
      if (!match) return null
      const from = match.from + (match.text.startsWith('!') ? 3 : 2)
      return {
        from,
        options: notes.notes.slice(0, 2000).map((note) => ({
          label: noteStem(note.relativePath), displayLabel: note.title, detail: note.relativePath, type: 'text',
          apply: (view: EditorView, _completion: unknown, start: number, end: number) => {
            const closing = view.state.sliceDoc(end, end + 2) === ']]' ? end + 2 : end
            const insert = `${noteStem(note.relativePath)}]]`
            view.dispatch({ changes: { from: start, to: closing, insert }, selection: { anchor: start + insert.length } })
          },
        })),
        validFor: /^[^\]\n]*$/,
      }
    } }),
    EditorView.domEventHandlers({
      scroll: (_event, view) => {
        if (scrollFrameRef.current != null) return
        scrollFrameRef.current = window.requestAnimationFrame(() => {
          scrollFrameRef.current = null
          onScroll(tab.id, view.scrollDOM.scrollTop, view.scrollDOM.scrollLeft)
        })
      },
      paste: (event, view) => {
        const files = imageFiles(event.clipboardData?.files)
        if (!files.length) return false
        event.preventDefault()
        const selection = view.state.selection.main
        onImportImages(tab.id, files, { from: selection.from, to: selection.to })
        return true
      },
      dragover: (event) => {
        // During dragover Chromium commonly protects FileList and exposes no
        // files until drop. DataTransferItem/type metadata is still available.
        if (!hasFileDrag(event.dataTransfer)) return false
        event.preventDefault()
        return true
      },
      drop: (event, view) => {
        const files = imageFiles(event.dataTransfer?.files)
        if (!files.length) {
          if (!hasFileDrag(event.dataTransfer)) return false
          event.preventDefault()
          return true
        }
        event.preventDefault()
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head
        onImportImages(tab.id, files, { from: position, to: position })
        return true
      },
    }),
    scrollPastEnd(),
    placeholder('Start writing in Markdown…'),
  ], [
    settings.editorIndentWithTabs, settings.editorShowWhitespace, settings.editorSpellcheck,
    onImportImages, onScroll, settings.editorTabSize, settings.editorTypewriterMode, settings.editorWordWrap, tab.id,
    tab.mode, tab.path, settings.editorFocus, notes, relativePath, assetDocumentPath, onOpenNote,
    settings.readerTheme, settings.readerFont,
    settings.uiTheme,
  ])
  const basicSetup = useMemo(() => ({
    lineNumbers: settings.editorLineNumbers,
    foldGutter: settings.editorCodeFolding,
    highlightActiveLine: true,
    highlightActiveLineGutter: settings.editorLineNumbers,
    bracketMatching: true,
    closeBrackets: true,
    autocompletion: true,
    rectangularSelection: true,
  }), [settings.editorCodeFolding, settings.editorLineNumbers])

  useEffect(() => () => {
    if (scrollFrameRef.current != null) window.cancelAnimationFrame(scrollFrameRef.current)
  }, [])

  useEffect(() => {
    if (!active || !viewRef.current) return
    const view = viewRef.current
    const frame = window.requestAnimationFrame(() => {
      const length = view.state.doc.length
      const anchor = Math.min(length, Math.max(0, tab.selectionAnchor))
      const head = Math.min(length, Math.max(0, tab.selectionHead))
      if (view.state.selection.main.anchor !== anchor || view.state.selection.main.head !== head) {
        view.dispatch({ selection: { anchor, head } })
      }
      view.scrollDOM.scrollTop = Math.max(0, tab.editorScrollTop)
      view.scrollDOM.scrollLeft = Math.max(0, tab.editorScrollLeft)
    })
    return () => window.cancelAnimationFrame(frame)
    // Restore only when a hidden editor becomes active; live selection/scroll updates must remain owned by CodeMirror.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, tab.id])

  const handleChange = useCallback((value: string) => onChange(tab.id, value), [onChange, tab.id])

  const handleUpdate = useCallback((update: ViewUpdate) => {
    if (update.selectionSet || update.docChanged) {
      const selection = update.state.selection.main
      const line = update.state.doc.lineAt(selection.head)
      onCursor(tab.id, line.number, selection.head - line.from + 1, selection.anchor, selection.head)
    }
  }, [onCursor, tab.id])

  const handleCreate = useCallback((view: EditorView) => {
    viewRef.current = view
    const currentTab = tabRef.current
    const length = view.state.doc.length
    const anchor = Math.min(length, Math.max(0, currentTab.selectionAnchor))
    const head = Math.min(length, Math.max(0, currentTab.selectionHead))
    view.dispatch({ selection: { anchor, head } })
    window.requestAnimationFrame(() => {
      view.scrollDOM.scrollTop = Math.max(0, tabRef.current.editorScrollTop)
      view.scrollDOM.scrollLeft = Math.max(0, tabRef.current.editorScrollLeft)
    })
    onCreate(currentTab.id, view)
  }, [onCreate])

  return (
    <section
      className={`editor-pane ${tab.mode === 'live' ? `live-editor reader-theme-${settings.readerTheme} reader-font-${settings.readerFont}` : ''} ${settings.editorFocus !== 'off' ? 'writing-focus' : ''} ${active ? 'is-active' : ''}`}
      role="region"
      aria-label={tab.mode === 'live' ? 'Live Markdown editor' : 'Markdown source'}
      aria-hidden={!active}
      data-editor-id={tab.id}
      style={{ '--reader-size': `${settings.fontSize}px`, '--reader-leading': settings.lineHeight, '--reader-width': `${settings.contentWidth}px`, '--custom-bg': settings.customBackground, '--custom-text': settings.customText, '--custom-accent': settings.customAccent } as React.CSSProperties}
    >
      {tab.mode === 'live' && tab.content.length > MAX_LIVE_DOCUMENT_LENGTH && <div className="live-large-notice" role="status">Large document: showing Markdown source to keep editing responsive.</div>}
      <CodeMirror
        value={tab.content}
        height="100%"
        indentWithTab={false}
        theme={theme}
        extensions={extensions}
        basicSetup={basicSetup}
        onChange={handleChange}
        onUpdate={handleUpdate}
        onCreateEditor={handleCreate}
      />
    </section>
  )
})

function imageFiles(files: FileList | null | undefined): File[] {
  return Array.from(files || []).filter((file) => file.type.startsWith('image/') || /\.(?:png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(file.name))
}

function hasFileDrag(dataTransfer: DataTransfer | null | undefined) {
  if (!dataTransfer) return false
  if (Array.from(dataTransfer.items || []).some((item) => item.kind === 'file')) return true
  return Array.from(dataTransfer.types || []).includes('Files')
}

const markdownTableTabBinding = {
  key: 'Tab',
  run: (view: EditorView) => navigateMarkdownTable(view, 'next'),
  shift: (view: EditorView) => navigateMarkdownTable(view, 'previous'),
}

function navigateMarkdownTable(view: EditorView, direction: 'next' | 'previous') {
  const position = view.state.selection.main.head
  if (!view.state.doc.lineAt(position).text.includes('|')) return false
  const plan = getMarkdownTableNavigation(view.state.doc.toString(), position, direction)
  if (!plan) return false
  view.dispatch({
    changes: plan.kind === 'insert-row' ? plan.change : undefined,
    selection: plan.selection,
    scrollIntoView: true,
  })
  return true
}

function typewriterMode() {
  return EditorView.updateListener.of((update) => {
    if ((!update.selectionSet && !update.docChanged) || !update.view.hasFocus) return
    const position = update.state.selection.main.head
    window.requestAnimationFrame(() => {
      try {
        update.view.dispatch({ effects: EditorView.scrollIntoView(position, { y: 'center', yMargin: 80 }) })
      } catch {
        // The editor may have closed before the animation frame ran.
      }
    })
  })
}

function editorViewTheme(dark: boolean, settings: AppSettings) {
  const editorFont = settings.editorFont === 'sans'
    ? "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    : "'SFMono-Regular', Consolas, 'Liberation Mono', monospace"

  return EditorView.theme({
    '&': {
      height: '100%',
      backgroundColor: dark ? '#1d201f' : '#fbfaf7',
      color: dark ? '#e8e8e2' : '#282b29',
      fontSize: `${settings.editorFontSize}px`,
    },
    '.cm-scroller': {
      fontFamily: editorFont,
      lineHeight: String(settings.editorLineHeight),
      padding: '30px 0 60px',
      overflow: 'auto',
    },
    '.cm-content': {
      boxSizing: 'border-box',
      width: '100%',
      maxWidth: `${settings.editorContentWidth}px`,
      margin: '0 auto',
      padding: '0 clamp(20px, 4%, 58px)',
    },
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
