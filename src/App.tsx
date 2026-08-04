import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import { openSearchPanel } from '@codemirror/search'
import { redo, undo } from '@codemirror/commands'
import {
  BookOpen, Check, CircleAlert, FilePlus2, FolderOpen, Keyboard,
  LocateFixed, Search, X,
} from 'lucide-react'
import { AppearancePanel } from './components/AppearancePanel'
import { MarkdownPreview } from './components/MarkdownPreview'
import { Outline } from './components/Outline'
import { Toolbar, type FormatAction } from './components/Toolbar'
import {
  countWords, createDocument, extractOutline, fileStem, hasUnresolvedChanges, loadSettings,
  mergeOpenedDocuments, readingMinutes, reconcileExternalReload,
} from './lib/document'
import { createExportHtml } from './lib/markdown'
import type { AppSettings, DocumentMode, DocumentTab, OpenDocumentsResult, OutlineItem } from './types'

type DialogName = 'about' | 'shortcuts' | null
type Toast = { id: number; message: string; tone: 'neutral' | 'success' | 'error' }

const EditorPane = lazy(async () => {
  const module = await import('./components/EditorPane')
  return { default: module.EditorPane }
})

export default function App() {
  const [tabs, setTabs] = useState<DocumentTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [sessionReady, setSessionReady] = useState(false)
  const [settings, setSettings] = useState<AppSettings>(loadSettings)
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const [focusMode, setFocusMode] = useState(false)
  const [readerFindOpen, setReaderFindOpen] = useState(false)
  const [readerFind, setReaderFind] = useState('')
  const [readerFindStatus, setReaderFindStatus] = useState({ current: 0, total: 0 })
  const [readerFindNavigation, setReaderFindNavigation] = useState<{ sequence: number; direction: 1 | -1 }>({ sequence: 0, direction: 1 })
  const [saveScheduleEpoch, setSaveScheduleEpoch] = useState(0)
  const [dialog, setDialog] = useState<DialogName>(null)
  const [toasts, setToasts] = useState<Toast[]>([])

  const tabsRef = useRef(tabs)
  const closingRef = useRef(false)
  const closingTabsRef = useRef(new Set<string>())
  const editorViews = useRef(new Map<string, EditorView>())
  const pendingEditorFind = useRef(new Set<string>())
  const pendingEditorFormat = useRef(new Map<string, FormatAction | string>())
  const documentSaveQueues = useRef(new Map<string, Promise<boolean>>())
  const toastId = useRef(0)
  const recoveryWarningShown = useRef(false)
  const recoveryWritableRef = useRef(true)
  const observedExternalChanges = useRef(new Map<string, number>())
  const activeTab = tabs.find((tab) => tab.id === activeId) ?? null
  const activeMode = activeTab?.mode ?? 'read'
  const outline = useMemo(() => activeTab ? extractOutline(activeTab.content) : [], [activeTab?.content])
  const wordCount = useMemo(() => activeTab ? countWords(activeTab.content) : 0, [activeTab?.content])
  const darkInterface = useDarkInterface(settings.uiTheme)

  const showToast = useCallback((message: string, tone: Toast['tone'] = 'neutral') => {
    const id = ++toastId.current
    setToasts((current) => [...current.slice(-2), { id, message, tone }])
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 3200)
  }, [])

  const updateTab = useCallback((id: string, patch: Partial<DocumentTab> | ((tab: DocumentTab) => Partial<DocumentTab>)) => {
    const next = tabsRef.current.map((tab) => tab.id === id
      ? { ...tab, ...(typeof patch === 'function' ? patch(tab) : patch) }
      : tab)
    tabsRef.current = next
    setTabs(next)
  }, [])

  const newDocument = useCallback(() => {
    const tab = createDocument()
    const next = [...tabsRef.current, tab]
    tabsRef.current = next
    setTabs(next)
    setActiveId(tab.id)
    setFocusMode(false)
  }, [])

  const applyOpenedDocuments = useCallback((result: OpenDocumentsResult) => {
    let openedId: string | null = null
    if (result.documents.length) {
      const merged = mergeOpenedDocuments(tabsRef.current, result.documents)
      tabsRef.current = merged.tabs
      setTabs(merged.tabs)
      setActiveId(merged.activeId)
      openedId = merged.activeId
      setFocusMode(false)
      merged.conflicts.forEach((name) => showToast(`${name} also changed on disk. Your edits were preserved.`, 'error'))
    }
    result.errors.forEach((error) => showToast(error.message, 'error'))
    return openedId
  }, [showToast])

  const openDocuments = useCallback(async () => {
    try {
      applyOpenedDocuments(await window.margin.openDocuments())
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'The file could not be opened.', 'error')
    }
  }, [applyOpenedDocuments, showToast])

  const openLinkedDocument = useCallback(async (documentPath: string | null, href: string) => {
    if (!documentPath) {
      showToast('Save this draft before opening a relative document link.', 'error')
      return
    }
    try {
      const openedId = applyOpenedDocuments(await window.margin.openLinkedDocument(documentPath, href))
      const rawFragment = href.includes('#') ? href.slice(href.indexOf('#') + 1) : ''
      if (!openedId || !rawFragment) return
      let fragment = rawFragment
      try { fragment = decodeURIComponent(rawFragment) } catch { /* use the literal fragment */ }
      updateTab(openedId, { mode: 'read' })
      window.setTimeout(() => {
        const preview = document.querySelector<HTMLElement>(`[data-preview-id="${CSS.escape(openedId)}"]`)
        preview?.querySelector<HTMLElement>(`#${CSS.escape(fragment)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 80)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'The linked document could not be opened.', 'error')
    }
  }, [applyOpenedDocuments, showToast, updateTab])

  const performSave = useCallback(async (id: string, options: { saveAs?: boolean; silent?: boolean } = {}) => {
    const snapshot = tabsRef.current.find((tab) => tab.id === id)
    if (!snapshot) return false
    updateTab(id, { saveState: 'saving' })
    try {
      const result = await window.margin.saveDocument({
        path: snapshot.path,
        name: snapshot.name,
        content: snapshot.content,
        expectedMtime: snapshot.mtimeMs,
        lineEnding: snapshot.lineEnding,
        bom: snapshot.bom,
        saveAs: options.saveAs,
        silent: options.silent,
      })
      if (result.status === 'cancelled') {
        updateTab(id, (tab) => ({
          saveState: snapshot.saveState === 'conflict'
            ? 'conflict'
            : tab.content === tab.savedContent ? 'saved' : 'edited',
        }))
        return false
      }
      if (result.status === 'conflict') {
        updateTab(id, { saveState: 'conflict' })
        if (!options.silent) showToast('This file changed on disk. Choose Save to review the conflict.', 'error')
        return false
      }
      updateTab(id, (tab) => ({
        path: result.path,
        name: result.name,
        mtimeMs: result.mtimeMs,
        savedContent: snapshot.content,
        saveState: tab.content === snapshot.content ? 'saved' : 'edited',
      }))
      if (!options.silent) showToast(`Saved ${result.name}`, 'success')
      return true
    } catch (error) {
      updateTab(id, { saveState: snapshot.saveState === 'conflict' ? 'conflict' : 'error' })
      showToast(error instanceof Error ? error.message : 'The document could not be saved.', 'error')
      return false
    }
  }, [showToast, updateTab])

  const saveDocument = useCallback((id: string, options: { saveAs?: boolean; silent?: boolean } = {}) => {
    const previous = documentSaveQueues.current.get(id) ?? Promise.resolve(true)
    const queued = previous.catch(() => false).then(() => performSave(id, options))
    documentSaveQueues.current.set(id, queued)
    void queued.finally(() => {
      if (documentSaveQueues.current.get(id) === queued) documentSaveQueues.current.delete(id)
    })
    return queued
  }, [performSave])

  const closeTab = useCallback(async (id: string) => {
    if (closingTabsRef.current.has(id)) return false
    closingTabsRef.current.add(id)
    await documentSaveQueues.current.get(id)?.catch(() => false)
    const tab = tabsRef.current.find((candidate) => candidate.id === id)
    if (!tab) return true
    if (hasUnresolvedChanges(tab)) {
      const choice = await window.margin.confirmClose(tab.name)
      if (choice === 'cancel') {
        closingTabsRef.current.delete(id)
        setSaveScheduleEpoch((value) => value + 1)
        return false
      }
      if (choice === 'save' && !(await saveDocument(id))) {
        closingTabsRef.current.delete(id)
        setSaveScheduleEpoch((value) => value + 1)
        return false
      }
    }
    const current = tabsRef.current
    const index = current.findIndex((candidate) => candidate.id === id)
    const next = current.filter((candidate) => candidate.id !== id)
    tabsRef.current = next
    setTabs(next)
    editorViews.current.delete(id)
    if (activeId === id) setActiveId(next[Math.min(index, next.length - 1)]?.id ?? null)
    return true
  }, [activeId, saveDocument])

  const closeWindow = useCallback(async () => {
    if (closingRef.current) return
    closingRef.current = true
    for (const tab of [...tabsRef.current]) {
      await documentSaveQueues.current.get(tab.id)?.catch(() => false)
      const latest = tabsRef.current.find((candidate) => candidate.id === tab.id)
      if (!latest || !hasUnresolvedChanges(latest)) continue
      const choice = await window.margin.confirmClose(latest.name)
      if (choice === 'cancel') {
        closingRef.current = false
        window.margin.cancelWindowClose()
        setSaveScheduleEpoch((value) => value + 1)
        return
      }
      if (choice === 'save' && !(await saveDocument(latest.id))) {
        closingRef.current = false
        window.margin.cancelWindowClose()
        setSaveScheduleEpoch((value) => value + 1)
        return
      }
    }
    if (recoveryWritableRef.current) await window.margin.clearSession()
    window.margin.closeWindow()
  }, [saveDocument])

  const setMode = useCallback((mode: DocumentMode) => {
    const id = activeId
    if (!id) return
    updateTab(id, { mode })
    if (mode === 'edit') {
      setReaderFindOpen(false)
      setReaderFind('')
    }
    if (mode === 'edit') window.setTimeout(() => editorViews.current.get(id)?.focus(), 20)
  }, [activeId, updateTab])

  const handleContentChange = useCallback((id: string, content: string) => {
    updateTab(id, (tab) => ({
      content,
      saveState: tab.saveState === 'conflict' ? 'conflict' : content === tab.savedContent ? 'saved' : 'edited',
    }))
  }, [updateTab])

  const handleCursor = useCallback((id: string, cursorLine: number, cursorColumn: number) => {
    updateTab(id, { cursorLine, cursorColumn })
  }, [updateTab])

  const registerEditor = useCallback((id: string, view: EditorView) => {
    editorViews.current.set(id, view)
    const pendingFormat = pendingEditorFormat.current.get(id)
    if (pendingFormat) {
      pendingEditorFormat.current.delete(id)
      if (pendingFormat === 'undo') undo(view)
      else if (pendingFormat === 'redo') redo(view)
      else applyFormat(view, pendingFormat as FormatAction)
      return
    }
    if (pendingEditorFind.current.delete(id)) {
      openSearchPanel(view)
      return
    }
    if (tabsRef.current.find((tab) => tab.id === id)?.mode === 'edit') view.focus()
  }, [])

  const format = useCallback((action: FormatAction | string) => {
    if (!activeId) return
    const view = editorViews.current.get(activeId)
    updateTab(activeId, { mode: 'edit' })
    if (!view) {
      pendingEditorFormat.current.set(activeId, action)
      return
    }
    if (action === 'undo') { undo(view); view.focus(); return }
    if (action === 'redo') { redo(view); view.focus(); return }
    applyFormat(view, action as FormatAction)
  }, [activeId, updateTab])

  const openFind = useCallback((replace = false) => {
    if (!activeTab) return
    if (activeTab.mode === 'edit' || replace) {
      if (replace) {
        setReaderFindOpen(false)
        setReaderFind('')
        updateTab(activeTab.id, { mode: 'edit' })
      }
      window.setTimeout(() => {
        const view = editorViews.current.get(activeTab.id)
        if (view) openSearchPanel(view)
        else pendingEditorFind.current.add(activeTab.id)
      }, 30)
    } else {
      setReaderFindOpen(true)
      window.setTimeout(() => document.querySelector<HTMLInputElement>('.reader-find input')?.focus(), 20)
    }
  }, [activeTab, updateTab])

  const goToHeading = useCallback((item: OutlineItem) => {
    if (!activeTab) return
    if (activeTab.mode === 'read') {
      const preview = document.querySelector<HTMLElement>(`[data-preview-id="${activeTab.id}"]`)
      preview?.querySelector<HTMLElement>(`#${CSS.escape(item.id)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    const view = editorViews.current.get(activeTab.id)
    if (!view) return
    const line = view.state.doc.line(Math.min(item.line, view.state.doc.lines))
    view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true })
    view.focus()
  }, [activeTab])

  const exportDocument = useCallback(async (kind: 'html' | 'pdf') => {
    const tab = tabsRef.current.find((candidate) => candidate.id === activeId)
    if (!tab) return
    showToast(`Preparing ${kind.toUpperCase()}…`)
    try {
      const html = await createExportHtml(tab.content, tab.path, fileStem(tab.name), settings)
      const request = { html, suggestedName: `${fileStem(tab.name)}.${kind}` }
      const result = kind === 'html' ? await window.margin.exportHtml(request) : await window.margin.exportPdf(request)
      if (result.status === 'saved') showToast(`${kind.toUpperCase()} exported`, 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : `The ${kind.toUpperCase()} export failed.`, 'error')
    }
  }, [activeId, settings, showToast])

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings((current) => ({ ...current, ...patch }))
  }, [])

  const updateReaderFindStatus = useCallback((current: number, total: number) => {
    setReaderFindStatus((previous) => previous.current === current && previous.total === total
      ? previous
      : { current, total })
  }, [])

  useEffect(() => {
    const unsubscribe = window.margin.onCommand((command, payload) => {
      switch (command) {
        case 'new': newDocument(); break
        case 'open': void openDocuments(); break
        case 'save': if (activeId) void saveDocument(activeId); break
        case 'saveAs': if (activeId) void saveDocument(activeId, { saveAs: true }); break
        case 'closeTab': if (activeId) void closeTab(activeId); break
        case 'toggleMode': if (activeTab) setMode(activeTab.mode === 'read' ? 'edit' : 'read'); break
        case 'toggleOutline': updateSettings({ outlineOpen: !settings.outlineOpen }); break
        case 'focusMode': setFocusMode((value) => !value); break
        case 'appearance': setAppearanceOpen(true); break
        case 'find': openFind(); break
        case 'replace': openFind(true); break
        case 'format': if (payload) format(payload); break
        case 'exportHtml': void exportDocument('html'); break
        case 'exportPdf': void exportDocument('pdf'); break
        case 'shortcuts': setDialog('shortcuts'); break
        case 'about': setDialog('about'); break
        case 'requestWindowClose': void closeWindow(); break
      }
    })
    return unsubscribe
  }, [activeId, activeTab, closeTab, closeWindow, exportDocument, format, newDocument, openDocuments, openFind, saveDocument, setMode, settings.outlineOpen, updateSettings])

  useEffect(() => {
    let mounted = true
    const unsubscribe = window.margin.onOpenDocuments((result) => {
      if (mounted) applyOpenedDocuments(result)
    })
    void window.margin.loadSession().then((restored) => {
      if (!mounted || tabsRef.current.length) return
      tabsRef.current = restored
      setTabs(restored)
      setActiveId(restored[0]?.id ?? null)
    }).catch((error) => {
      recoveryWritableRef.current = false
      if (mounted) showToast(error instanceof Error ? error.message : 'The recovery backup could not be loaded.', 'error')
    }).finally(() => {
      if (!mounted) return
      setSessionReady(true)
      window.margin.readyForSafeClose()
      window.margin.readyForOpenDocuments()
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [applyOpenedDocuments, showToast])

  useEffect(() => {
    if (!sessionReady) return
    const timeout = window.setTimeout(() => {
      if (!closingRef.current && recoveryWritableRef.current) void window.margin.saveSession(tabs).catch(() => {
        if (!recoveryWarningShown.current) {
          recoveryWarningShown.current = true
          showToast('The local recovery backup could not be updated.', 'error')
        }
      })
    }, 1000)
    return () => window.clearTimeout(timeout)
  }, [saveScheduleEpoch, sessionReady, showToast, tabs])

  useEffect(() => {
    let checking = false
    const checkForExternalChanges = async () => {
      if (checking) return
      checking = true
      try {
        for (const tab of tabsRef.current) {
          if (!tab.path || tab.saveState === 'saving') continue
          const stat = await window.margin.statDocument(tab.path)
          if (!stat) continue
          if (!stat.exists) {
            if (observedExternalChanges.current.get(tab.path) === -1) continue
            observedExternalChanges.current.set(tab.path, -1)
            updateTab(tab.id, { saveState: 'conflict' })
            showToast(`${tab.name} was moved or deleted. Autosave is paused.`, 'error')
            continue
          }
          if (stat.mtimeMs == null || tab.mtimeMs == null || Math.abs(stat.mtimeMs - tab.mtimeMs) <= 2) continue
          if (observedExternalChanges.current.get(tab.path) === stat.mtimeMs) continue
          if (tab.content !== tab.savedContent) {
            observedExternalChanges.current.set(tab.path, stat.mtimeMs)
            updateTab(tab.id, { saveState: 'conflict' })
            showToast(`${tab.name} changed on disk while you were editing.`, 'error')
          } else {
            try {
              const fresh = await window.margin.readDocument(tab.path)
              const latest = tabsRef.current.find((candidate) => candidate.id === tab.id)
              const outcome = latest ? reconcileExternalReload(latest, tab.mtimeMs, fresh) : null
              const next = outcome
                ? tabsRef.current.map((candidate) => candidate.id === tab.id ? outcome.tab : candidate)
                : tabsRef.current
              tabsRef.current = next
              setTabs(next)
              observedExternalChanges.current.set(tab.path, stat.mtimeMs)
              if (outcome?.conflict) showToast(`${tab.name} changed on disk while you were editing.`, 'error')
              else showToast(`Reloaded changes from ${tab.name}.`, 'neutral')
            } catch (error) {
              updateTab(tab.id, { saveState: 'conflict' })
              showToast(error instanceof Error ? error.message : `${tab.name} could not be reloaded safely.`, 'error')
            }
          }
        }
      } finally {
        checking = false
      }
    }
    const interval = window.setInterval(() => void checkForExternalChanges(), 6000)
    window.addEventListener('focus', checkForExternalChanges)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', checkForExternalChanges)
    }
  }, [showToast, updateTab])

  useEffect(() => {
    localStorage.setItem('margin:settings', JSON.stringify(settings))
    document.documentElement.dataset.uiTheme = darkInterface ? 'dark' : 'light'
  }, [darkInterface, settings])

  useEffect(() => {
    window.margin.setDirty(tabs.some(hasUnresolvedChanges))
  }, [tabs])

  const autosaveKey = tabs.map((tab) => `${tab.id}:${tab.path ?? ''}:${tab.saveState}:${tab.content.length}:${tab.content === tab.savedContent}`).join('|')
  useEffect(() => {
    if (!settings.autosave) return
    const timers = tabsRef.current
      .filter((tab) => tab.path && tab.saveState === 'edited' && tab.content !== tab.savedContent)
      .map((tab) => window.setTimeout(() => {
        if (!closingRef.current && !closingTabsRef.current.has(tab.id)) void saveDocument(tab.id, { silent: true })
      }, settings.autosaveDelay))
    return () => timers.forEach(window.clearTimeout)
    // autosaveKey intentionally summarizes the change state without retaining entire document strings.
  }, [autosaveKey, saveDocument, saveScheduleEpoch, settings.autosave, settings.autosaveDelay])

  useEffect(() => {
    if (!readerFindOpen || !readerFind) setReaderFindStatus({ current: 0, total: 0 })
  }, [readerFind, readerFindOpen])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (dialog) setDialog(null)
        else if (appearanceOpen) setAppearanceOpen(false)
        else if (readerFindOpen) { setReaderFindOpen(false); setReaderFind('') }
        else if (focusMode) setFocusMode(false)
        else if (activeTab?.mode === 'edit') setMode('read')
      }
      if ((event.metaKey || event.ctrlKey) && event.key >= '1' && event.key <= '9') {
        const tab = tabsRef.current[Number(event.key) - 1]
        if (tab) { event.preventDefault(); setActiveId(tab.id) }
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [activeTab?.mode, appearanceOpen, dialog, focusMode, readerFindOpen, setMode])

  return (
    <div className={`app-shell ${focusMode ? 'focus-mode' : ''}`}>
      <Toolbar
        mode={activeMode}
        hasDocument={Boolean(activeTab)}
        outlineOpen={settings.outlineOpen}
        onNew={newDocument}
        onOpen={() => void openDocuments()}
        onSave={() => activeId && void saveDocument(activeId)}
        onMode={setMode}
        onOutline={() => updateSettings({ outlineOpen: !settings.outlineOpen })}
        onFind={() => openFind()}
        onAppearance={() => setAppearanceOpen(true)}
        onFormat={format}
      />

      {tabs.length > 0 && (
        <div className="tab-strip app-drag-region" role="tablist">
          <div className="tab-scroll no-drag">
            {tabs.map((tab) => (
              <button
                role="tab"
                aria-selected={tab.id === activeId}
                className={`document-tab ${tab.id === activeId ? 'is-active' : ''}`}
                key={tab.id}
                onClick={() => setActiveId(tab.id)}
                onAuxClick={(event) => { if (event.button === 1) void closeTab(tab.id) }}
                title={tab.path ?? tab.name}
              >
                <span>{tab.name}</span>
                {hasUnresolvedChanges(tab) && <i className="dirty-dot" aria-label="Unsaved or unresolved changes" />}
                <span
                  className="tab-close"
                  role="button"
                  aria-label={`Close ${tab.name}`}
                  onClick={(event) => { event.stopPropagation(); void closeTab(tab.id) }}
                ><X /></span>
              </button>
            ))}
            <button className="new-tab-button" title="New document" aria-label="New document" onClick={newDocument}><FilePlus2 /></button>
          </div>
        </div>
      )}

      <main className="workspace">
        {settings.outlineOpen && !focusMode && activeTab && (
          <Outline tabs={tabs} activeId={activeId} items={outline} onSelectTab={setActiveId} onHeading={goToHeading} />
        )}
        <div className="document-area">
          {!activeTab ? <Welcome onNew={newDocument} onOpen={() => void openDocuments()} /> : (
            <div className="document-stack">
              {tabs.map((tab) => (
                (tab.mode === 'edit' || editorViews.current.has(tab.id)) && (
                  <Suspense key={tab.id} fallback={<div className="editor-loading" role="status">Opening editor…</div>}>
                    <EditorPane
                      tab={tab}
                      active={tab.id === activeId && tab.mode === 'edit'}
                      dark={darkInterface}
                      onChange={handleContentChange}
                      onCursor={handleCursor}
                      onCreate={registerEditor}
                    />
                  </Suspense>
                )
              ))}
              {activeTab.mode === 'read' && (
                <MarkdownPreview
                  tab={activeTab}
                  active
                  settings={settings}
                  findQuery={readerFindOpen ? readerFind : ''}
                  findNavigation={readerFindNavigation}
                  onFindStatus={updateReaderFindStatus}
                  onOpenLink={openLinkedDocument}
                />
              )}
            </div>
          )}
        </div>
      </main>

      {activeTab && (
        <footer className="status-bar">
          <div className={`save-indicator state-${activeTab.saveState}`}>
            {activeTab.saveState === 'saved' && <Check />}
            {(activeTab.saveState === 'conflict' || activeTab.saveState === 'error') && <CircleAlert />}
            <span>{saveLabel(activeTab.saveState)}</span>
          </div>
          <button className="document-location" title={activeTab.path ?? 'This draft is recovered on this device'} onClick={() => activeTab.path && void window.margin.showItemInFolder(activeTab.path)}>
            {activeTab.path ? <><LocateFixed /> {activeTab.path}</> : 'Local recovery draft'}
          </button>
          <div className="document-stats">
            {activeTab.mode === 'edit' && <span>Ln {activeTab.cursorLine}, Col {activeTab.cursorColumn}</span>}
            <span>{wordCount.toLocaleString()} words</span>
            <span>{activeTab.content.length.toLocaleString()} characters</span>
            <span>{readingMinutes(wordCount)} min read</span>
          </div>
        </footer>
      )}

      {readerFindOpen && (
        <div className="reader-find">
          <Search />
          <input value={readerFind} onChange={(event) => setReaderFind(event.target.value)} placeholder="Find in document" autoFocus />
          <span className="reader-find-status" aria-live="polite">{readerFindStatus.current}/{readerFindStatus.total}</span>
          <button aria-label="Previous match" disabled={!readerFindStatus.total} onClick={() => setReaderFindNavigation((value) => ({ sequence: value.sequence + 1, direction: -1 }))}>↑</button>
          <button aria-label="Next match" disabled={!readerFindStatus.total} onClick={() => setReaderFindNavigation((value) => ({ sequence: value.sequence + 1, direction: 1 }))}>↓</button>
          <button aria-label="Close find" onClick={() => { setReaderFindOpen(false); setReaderFind('') }}><X /></button>
        </div>
      )}

      {appearanceOpen && <><div className="panel-scrim" onClick={() => setAppearanceOpen(false)} /><AppearancePanel settings={settings} onChange={updateSettings} onClose={() => setAppearanceOpen(false)} /></>}
      {dialog && <InfoDialog name={dialog} onClose={() => setDialog(null)} />}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => <div className={`toast tone-${toast.tone}`} key={toast.id}>{toast.tone === 'success' && <Check />}{toast.tone === 'error' && <CircleAlert />}{toast.message}</div>)}
      </div>
    </div>
  )
}

function Welcome({ onNew, onOpen }: { onNew: () => void; onOpen: () => void }) {
  return (
    <section className="welcome">
      <div className="welcome-mark"><BookOpen /></div>
      <span className="eyebrow">A quiet place for Markdown</span>
      <h1>Read deeply.<br />Edit simply.</h1>
      <p>Margin keeps your notes on your device and puts the document—not the interface—at the center.</p>
      <div className="welcome-actions">
        <button className="primary-button" onClick={onOpen}><FolderOpen /> Open a document</button>
        <button className="secondary-button" onClick={onNew}><FilePlus2 /> New document</button>
      </div>
      <div className="welcome-hints"><span><kbd>⌘</kbd><kbd>O</kbd> Open</span><span><kbd>⌘</kbd><kbd>N</kbd> New</span><span><kbd>⌘</kbd><kbd>E</kbd> Read / Edit</span></div>
    </section>
  )
}

function InfoDialog({ name, onClose }: { name: Exclude<DialogName, null>; onClose: () => void }) {
  return (
    <div className="dialog-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="info-dialog" role="dialog" aria-modal="true" aria-label={name === 'about' ? 'About Margin' : 'Keyboard shortcuts'}>
        <button className="icon-button dialog-close" onClick={onClose} aria-label="Close"><X /></button>
        {name === 'about' ? (
          <>
            <div className="about-mark"><BookOpen /></div>
            <span className="eyebrow">Margin 0.1</span>
            <h2>Markdown, with room to breathe.</h2>
            <p>A private, offline reader and editor for macOS, Windows, and Linux.</p>
            <div className="privacy-note"><Check /> Files stay on your device. Margin has no account, analytics, or cloud service.</div>
          </>
        ) : (
          <>
            <Keyboard className="dialog-hero-icon" />
            <span className="eyebrow">Reference</span>
            <h2>Keyboard shortcuts</h2>
            <div className="shortcut-grid">
              {[
                ['New document', '⌘ N'], ['Open', '⌘ O'], ['Save', '⌘ S'], ['Save as', '⇧ ⌘ S'],
                ['Read / Edit', '⌘ E'], ['Find', '⌘ F'], ['Replace', '⌥ ⌘ F'], ['Close tab', '⌘ W'],
                ['Bold', '⌘ B'], ['Italic', '⌘ I'], ['Link', '⌘ K'], ['Focus mode', '⇧ ⌘ F'],
              ].map(([label, keys]) => <div key={label}><span>{label}</span><kbd>{keys}</kbd></div>)}
            </div>
            <p className="platform-note">Use Ctrl instead of ⌘ on Windows and Linux.</p>
          </>
        )}
      </section>
    </div>
  )
}

function saveLabel(state: DocumentTab['saveState']) {
  return { saved: 'Saved', edited: 'Edited', saving: 'Saving…', conflict: 'Changed on disk', error: 'Save failed' }[state]
}

function useDarkInterface(theme: AppSettings['uiTheme']) {
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = () => setSystemDark(media.matches)
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }, [])
  return theme === 'dark' || (theme === 'system' && systemDark)
}

function applyFormat(view: EditorView, action: FormatAction) {
  const range = view.state.selection.main
  const selected = view.state.sliceDoc(range.from, range.to)

  const replace = (text: string, selectionStart: number, selectionEnd = selectionStart) => {
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: text },
      selection: { anchor: range.from + selectionStart, head: range.from + selectionEnd },
      scrollIntoView: true,
    })
    view.focus()
  }
  const wrap = (before: string, after: string, placeholder: string) => {
    const body = selected || placeholder
    replace(`${before}${body}${after}`, before.length, before.length + body.length)
  }
  const prefixLines = (prefix: string) => {
    const startLine = view.state.doc.lineAt(range.from)
    const endLine = view.state.doc.lineAt(range.to)
    const text = view.state.sliceDoc(startLine.from, endLine.to)
    const replaced = text.split('\n').map((line, index) => `${typeof prefix === 'string' ? prefix.replace('{n}', String(index + 1)) : prefix}${line}`).join('\n')
    view.dispatch({ changes: { from: startLine.from, to: endLine.to, insert: replaced }, selection: { anchor: startLine.from, head: startLine.from + replaced.length } })
    view.focus()
  }

  switch (action) {
    case 'bold': wrap('**', '**', 'bold text'); break
    case 'italic': wrap('*', '*', 'italic text'); break
    case 'strike': wrap('~~', '~~', 'struck text'); break
    case 'heading1': prefixLines('# '); break
    case 'heading2': prefixLines('## '); break
    case 'heading3': prefixLines('### '); break
    case 'link': {
      const label = selected || 'link text'
      replace(`[${label}](https://example.com)`, 1, 1 + label.length)
      break
    }
    case 'image': replace(`![${selected || 'image description'}](image.png)`, 2, 2 + (selected || 'image description').length); break
    case 'code': wrap('`', '`', 'code'); break
    case 'codeblock': wrap('```\n', '\n```', 'code'); break
    case 'quote': prefixLines('> '); break
    case 'list': prefixLines('- '); break
    case 'ordered': prefixLines('{n}. '); break
    case 'task': prefixLines('- [ ] '); break
    case 'table': replace('| Column 1 | Column 2 |\n| --- | --- |\n| Value | Value |', 2, 10); break
    case 'math': wrap('$', '$', 'E = mc^2'); break
    case 'mermaid': replace('```mermaid\nflowchart LR\n  A[Start] --> B[Finish]\n```', 27, 32); break
  }
}
