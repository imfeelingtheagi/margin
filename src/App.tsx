import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import { gotoLine, openSearchPanel } from '@codemirror/search'
import { redo, undo } from '@codemirror/commands'
import {
  BookOpen, Check, CircleAlert, FilePlus2, FolderOpen, FolderTree, Keyboard,
  LocateFixed, Search, X,
} from 'lucide-react'
import { AppearancePanel } from './components/AppearancePanel'
import { CommandPalette, type PaletteCommand } from './components/CommandPalette'
import { MarkdownPreview } from './components/MarkdownPreview'
import { Toolbar, type FormatAction } from './components/Toolbar'
import { WorkspaceSidebar, type SidebarView } from './components/WorkspaceSidebar'
import {
  countWords, createDocument, fileStem, hasUnresolvedChanges, limitOpenedDocuments, loadSettings,
  MAX_OPEN_CONTENT_BYTES, MAX_OPEN_TABS, mergeOpenedDocuments, nextUntitledName, readingMinutes, reconcileExternalReload,
  toggleTaskAtLine,
} from './lib/document'
import { createExportHtml, extractOutline } from './lib/markdown'
import { formatMarkdownTableAt } from './lib/markdownTable'
import { buildNoteIndex, normalizeNotePath, resolveNote, type NoteIndex } from './lib/noteIndex'
import { emptyReadingRecord, loadReadingLibrary, readingKey, saveReadingLibrary, type Annotation, type ReadingRecord, type TextAnchor } from './lib/readingState'
import type { ReaderImage } from './components/ReaderOverlays'
import { useModal } from './lib/useModal'
import type { AgentCheckpoint, AgentProposal, AgentSelection, AgentSource } from './agentTypes'
import { agentTextHash, applyAgentProposal } from './lib/agent'
import type {
  AppSettings, DocumentMode, DocumentTab, OpenDocumentsResult, OutlineItem, WorkspaceBuffer,
  WorkspaceDescriptor, WorkspaceEntry, WorkspaceSearchMatch, NoteSource,
} from './types'

type DialogName = 'about' | 'shortcuts' | null
type Toast = { id: number; message: string; tone: 'neutral' | 'success' | 'error' }

const EditorPane = lazy(async () => {
  const module = await import('./components/EditorPane')
  return { default: module.EditorPane }
})
const ReadingTools = lazy(() => import('./components/ReadingTools').then((module) => ({ default: module.ReadingTools })))
const AgentDesk = lazy(() => import('./components/AgentDesk'))
const NoteGraph = lazy(() => import('./components/NoteGraph'))
const ImageViewer = lazy(() => import('./components/ReaderOverlays').then((module) => ({ default: module.ImageViewer })))
const PresentationViewer = lazy(() => import('./components/ReaderOverlays').then((module) => ({ default: module.PresentationViewer })))

export default function App() {
  const [tabs, setTabs] = useState<DocumentTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [sessionReady, setSessionReady] = useState(false)
  const [settings, setSettings] = useState<AppSettings>(() => {
    const loaded = loadSettings()
    return isMacPlatform() ? loaded : { ...loaded, editorSpellcheck: false }
  })
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [quickOpenOpen, setQuickOpenOpen] = useState(false)
  const [quickOpenDocuments, setQuickOpenDocuments] = useState<WorkspaceEntry[]>([])
  const [quickOpenLoading, setQuickOpenLoading] = useState(false)
  const [workspace, setWorkspace] = useState<WorkspaceDescriptor | null>(null)
  const [sidebarView, setSidebarView] = useState<SidebarView>('outline')
  const [workspaceRefreshToken, setWorkspaceRefreshToken] = useState(0)
  const [focusMode, setFocusMode] = useState(false)
  const [readerFindOpen, setReaderFindOpen] = useState(false)
  const [readerFind, setReaderFind] = useState('')
  const [readerFindStatus, setReaderFindStatus] = useState({ current: 0, total: 0 })
  const [readerFindNavigation, setReaderFindNavigation] = useState<{ sequence: number; direction: 1 | -1 }>({ sequence: 0, direction: 1 })
  const [saveScheduleEpoch, setSaveScheduleEpoch] = useState(0)
  const [dialog, setDialog] = useState<DialogName>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [readingLibrary, setReadingLibrary] = useState(loadReadingLibrary)
  const readingLibraryRef = useRef(readingLibrary)
  const readingUiTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const readingStorageWarning = useRef(false)
  const [readingToolsOpen, setReadingToolsOpen] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)
  const [agentSelection, setAgentSelection] = useState<AgentSelection | null>(null)
  const [graphOpen, setGraphOpen] = useState(false)
  const [presentationOpen, setPresentationOpen] = useState(false)
  const [imageViewer, setImageViewer] = useState<{ images: ReaderImage[]; initial: number } | null>(null)
  const [noteSources, setNoteSources] = useState<NoteSource[]>([])
  const [notesLoading, setNotesLoading] = useState(false)
  const [notesWarning, setNotesWarning] = useState('')
  const snapshotWorkspaceId = useRef<string | null>(null)
  const [missingNote, setMissingNote] = useState<{ target: string; origin: string } | null>(null)
  const navigation = useRef<{ current: string | null; back: string[]; forward: string[]; moving: boolean }>({ current: null, back: [], forward: [], moving: false })
  const [, setNavigationRevision] = useState(0)
  const closeAppearance = useCallback(() => setAppearanceOpen(false), [])
  const closeCommandPalette = useCallback(() => setCommandPaletteOpen(false), [])
  const closeQuickOpen = useCallback(() => setQuickOpenOpen(false), [])
  const closeDialog = useCallback(() => setDialog(null), [])
  const openAppearance = useCallback(() => {
    setCommandPaletteOpen(false)
    setQuickOpenOpen(false)
    setDialog(null)
    setAppearanceOpen(true)
  }, [])
  const openCommandPalette = useCallback(() => {
    setAppearanceOpen(false)
    setQuickOpenOpen(false)
    setDialog(null)
    setCommandPaletteOpen(true)
  }, [])
  const openInfoDialog = useCallback((name: Exclude<DialogName, null>) => {
    setAppearanceOpen(false)
    setCommandPaletteOpen(false)
    setQuickOpenOpen(false)
    setDialog(name)
  }, [])

  const tabsRef = useRef(tabs)
  const closingRef = useRef(false)
  const closingTabsRef = useRef(new Set<string>())
  const closedTabsRef = useRef<DocumentTab[]>([])
  const scrollSyncSource = useRef<'editor' | 'reader' | null>(null)
  const editorViews = useRef(new Map<string, EditorView>())
  const pendingAgentEdits = useRef(new Map<string, { expected: string; path: string | null; from: number; to: number; insert: string; resolve: () => void; reject: (error: Error) => void }>())
  const pendingEditorFind = useRef(new Set<string>())
  const pendingEditorFormat = useRef(new Map<string, FormatAction | string>())
  const pendingEditorReveal = useRef(new Map<string, { line: number; column: number }>())
  const documentSaveQueues = useRef(new Map<string, Promise<boolean>>())
  const toastId = useRef(0)
  const recoveryWarningShown = useRef(false)
  const recoveryWritableRef = useRef(true)
  const recoveryGenerationRef = useRef(0)
  const workspaceMutationRef = useRef(0)
  const quickOpenSequenceRef = useRef(0)
  const observedExternalChanges = useRef(new Map<string, number>())
  const activeTab = tabs.find((tab) => tab.id === activeId) ?? null
  const activeMode = activeTab?.mode ?? 'read'
  const analyzedContent = useDebouncedKeyedValue(activeId, activeTab?.content ?? '', 240)
  const outline = useMemo(() => analyzedContent ? extractOutline(analyzedContent) : [], [analyzedContent])
  const wordCount = useMemo(() => analyzedContent ? countWords(analyzedContent) : 0, [analyzedContent])
  const workspaceBufferKey = tabs.map((tab) => `${tab.id}:${tab.path ?? ''}:${tab.revision}:${tab.saveState}:${tab.content === tab.savedContent}`).join('|')
  const debouncedWorkspaceBufferKey = useDebouncedKeyedValue(workspace?.id ?? null, workspaceBufferKey, 220)
  const noteIndexRef = useRef<NoteIndex | null>(null)
  const noteIndex = useMemo(() => {
    const sources = new Map(noteSources.map((source) => [source.relativePath, source]))
    const preferred: string[] = []
    let limited = false
    const open = [...tabsRef.current].sort((left, right) => Number(right.id === activeId) - Number(left.id === activeId))
    for (const tab of open) {
      const relativePath = notePathForTab(tab, workspace)
      if (tab.content.length > 1024 * 1024) { sources.delete(relativePath); limited = true; continue }
      sources.set(relativePath, { relativePath, content: tab.content })
      preferred.push(relativePath)
    }
    const retained: NoteSource[] = []
    let textUnits = 0
    for (const relativePath of new Set([...preferred, ...sources.keys()])) {
      const source = sources.get(relativePath)!
      if (retained.length >= 2000 || textUnits + source.content.length > 8 * 1024 * 1024) { limited = true; continue }
      textUnits += source.content.length
      retained.push(source)
    }
    const built = buildNoteIndex(retained, noteIndexRef.current)
    built.limited ||= limited
    noteIndexRef.current = built
    return built
  }, [noteSources, debouncedWorkspaceBufferKey, workspace?.id])
  const activeNotePath = activeTab ? notePathForTab(activeTab, workspace) : ''
  const activeReading = useMemo(() => activeTab ? readingLibrary[readingKey(activeTab)] || emptyReadingRecord(activeTab) : null,
    [activeTab?.id, activeTab?.path, readingLibrary])
  const assetDocumentPath = useCallback((relativePath: string) => {
    const opened = tabsRef.current.find((tab) => notePathForTab(tab, workspace) === relativePath)
    if (opened?.path) return opened.path
    if (!workspace || normalizeNotePath(relativePath) !== relativePath) return null
    return `${workspace.rootPath.replace(/[\\/]$/, '')}/${relativePath}`
  }, [workspace?.rootPath])
  useEffect(() => {
    if (!activeId || navigation.current.current === activeId) return
    const history = navigation.current
    if (!history.moving && history.current) {
      history.back = [...history.back.slice(-99), history.current]
      history.forward = []
    }
    history.current = activeId
    history.moving = false
    setNavigationRevision((value) => value + 1)
  }, [activeId])
  const navigate = useCallback((direction: 'back' | 'forward') => {
    const history = navigation.current
    let id: string | undefined
    while ((id = history[direction].pop())) if (tabsRef.current.some((tab) => tab.id === id)) break
    if (!id) return
    if (history.current) history[direction === 'back' ? 'forward' : 'back'].push(history.current)
    history.moving = true
    setActiveId(id)
    setFocusMode(false)
  }, [])
  const workspaceSearchState = useMemo<{ buffers: WorkspaceBuffer[]; excludedPaths: string[] }>(() => {
    if (!workspace || sidebarView !== 'search') return { buffers: [], excludedPaths: [] }
    let totalBytes = 0
    const buffers: WorkspaceBuffer[] = []
    const excludedPaths: string[] = []
    const candidates = tabs
      .filter((tab) => tab.path && (tab.content !== tab.savedContent || tab.saveState === 'conflict'))
      .sort((left, right) => Number(right.id === activeId) - Number(left.id === activeId))
    for (const tab of candidates) {
      if (!tab.path) continue
      const relativePath = relativePathWithinWorkspace(workspace.rootPath, tab.path)
      if (!relativePath) continue
      const bytes = new Blob([tab.content]).size
      if (buffers.length >= MAX_OPEN_TABS || totalBytes + bytes > 50 * 1024 * 1024) {
        excludedPaths.push(relativePath)
        continue
      }
      totalBytes += bytes
      buffers.push({ relativePath, content: tab.content })
    }
    return { buffers, excludedPaths }
    // The debounced key changes for content/path/save-state updates, but not
    // high-frequency cursor/scroll persistence. Exact UTF-8 sizing is deferred
    // until the user pauses, instead of rescanning large buffers on each key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, debouncedWorkspaceBufferKey, sidebarView, workspace?.rootPath])
  const darkInterface = useDarkInterface(settings.uiTheme)

  const showToast = useCallback((message: string, tone: Toast['tone'] = 'neutral') => {
    const id = ++toastId.current
    setToasts((current) => [...current.slice(-2), { id, message, tone }])
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 3200)
  }, [])

  const updateReading = useCallback((id: string, patch: Partial<ReadingRecord> | ((record: ReadingRecord) => Partial<ReadingRecord>)) => {
    const tab = tabsRef.current.find((tab) => tab.id === id)
    if (!tab) return
    const current = readingLibraryRef.current
    const key = readingKey(tab)
    const record = current[key] || emptyReadingRecord(tab)
    const values = typeof patch === 'function' ? patch(record) : patch
    const next = { ...current, [key]: { ...record, ...values, key, path: tab.path, name: tab.name, updatedAt: Date.now() } }
    readingLibraryRef.current = next
    setReadingLibrary(next)
  }, [])

  useEffect(() => () => clearTimeout(readingUiTimer.current), [])

  useEffect(() => {
    const persist = () => {
      try { saveReadingLibrary(readingLibraryRef.current); readingStorageWarning.current = false } catch (error) {
        if (!readingStorageWarning.current) showToast(error instanceof Error ? error.message : 'Reading notes could not be stored.', 'error')
        readingStorageWarning.current = true
      }
    }
    const timer = setTimeout(persist, 350)
    window.addEventListener('beforeunload', persist)
    return () => { clearTimeout(timer); window.removeEventListener('beforeunload', persist) }
  }, [readingLibrary, showToast])

  useEffect(() => {
    let cancelled = false
    if (snapshotWorkspaceId.current !== (workspace?.id || null)) setNoteSources([])
    snapshotWorkspaceId.current = workspace?.id || null
    setNotesWarning('')
    setNotesLoading(Boolean(workspace))
    if (!workspace) return
    const timer = setTimeout(() => {
      void window.margin.readWorkspaceNotes().then((result) => {
        if (cancelled || result.workspaceId !== workspace.id) return
        setNoteSources(result.documents)
        setNotesWarning(result.truncated || result.skippedFiles ? `Some files were skipped. Connected notes index up to 2,000 files, 1 MB each, and 16 MB total.` : '')
      }).catch((error) => { if (!cancelled) setNotesWarning(error instanceof Error ? error.message : 'Notes could not be indexed.') })
        .finally(() => { if (!cancelled) setNotesLoading(false) })
    }, 400)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [workspace?.id, workspaceRefreshToken])

  useEffect(() => {
    if (!workspace) return
    let lastRefresh = Date.now()
    const refreshOnFocus = () => {
      if (Date.now() - lastRefresh < 10_000) return
      lastRefresh = Date.now()
      setWorkspaceRefreshToken((value) => value + 1)
    }
    window.addEventListener('focus', refreshOnFocus)
    return () => window.removeEventListener('focus', refreshOnFocus)
  }, [workspace?.id])

  const reserveRecoveryGeneration = useCallback(() => {
    recoveryGenerationRef.current += 1
    return recoveryGenerationRef.current
  }, [])

  const saveRecoverySnapshot = useCallback((snapshot: DocumentTab[], generation = reserveRecoveryGeneration()) => {
    return window.margin.saveSession(snapshot, generation)
  }, [reserveRecoveryGeneration])

  const updateTab = useCallback((id: string, patch: Partial<DocumentTab> | ((tab: DocumentTab) => Partial<DocumentTab>)) => {
    let changed = false
    const next = tabsRef.current.map((tab) => {
      if (tab.id !== id) return tab
      const values = typeof patch === 'function' ? patch(tab) : patch
      if (Object.entries(values).every(([key, value]) => Object.is(tab[key as keyof DocumentTab], value))) return tab
      changed = true
      return { ...tab, ...values }
    })
    if (!changed) return
    tabsRef.current = next
    setTabs(next)
  }, [])

  const captureAgentSelection = useCallback(() => {
    const tab = tabsRef.current.find((item) => item.id === activeId)
    if (!tab) return
    const view = editorViews.current.get(tab.id)
    if (tab.mode !== 'read' && view && !view.state.selection.main.empty) {
      const { from, to } = view.state.selection.main
      setAgentSelection({ tabId: tab.id, from, to, text: view.state.sliceDoc(from, to) })
      return
    }
    const chosen = window.getSelection()
    if (chosen?.rangeCount && chosen.toString().trim() && document.querySelector('.preview-pane article')?.contains(chosen.anchorNode)) {
      const text = chosen.toString().slice(0, 10_000)
      const from = tab.content.indexOf(text)
      const unique = from >= 0 && tab.content.indexOf(text, from + 1) === -1
      setAgentSelection({ tabId: tab.id, text, from: unique ? from : null, to: unique ? from + text.length : null })
    } else setAgentSelection(null)
  }, [activeId])

  const openAgent = useCallback(() => {
    captureAgentSelection()
    setReadingToolsOpen(false); setAgentOpen(true); setFocusMode(false)
  }, [captureAgentSelection])

  const editFromAgent = useCallback(async (id: string, expected: string, from: number, to: number, insert: string, expectedPath: string | null) => {
    const tab = tabsRef.current.find((item) => item.id === id)
    if (!tab || tab.path !== expectedPath || tab.content !== expected || closingRef.current || closingTabsRef.current.has(id)) throw new Error('The document changed or closed. Your newer edits were preserved.')
    setActiveId(id); updateTab(id, { mode: 'edit' })
    const view = editorViews.current.get(id)
    if (view) {
      if (view.state.doc.toString() !== expected) throw new Error('The editor changed. Generate a new proposal.')
      view.dispatch({ changes: { from, to, insert }, userEvent: 'input.agent' }); view.focus()
      return
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { pendingAgentEdits.current.delete(id); reject(new Error('The editor did not open in time. Nothing was applied.')) }, 10_000)
      pendingAgentEdits.current.set(id, { expected, path: expectedPath, from, to, insert,
        resolve: () => { clearTimeout(timer); resolve() }, reject: (error) => { clearTimeout(timer); reject(error) } })
    })
  }, [updateTab])

  const applyAgentEdit = useCallback(async (taskId: string, proposal: AgentProposal) => {
    const tab = tabsRef.current.find((item) => item.id === proposal.tabId)
    if (!tab || tab.path !== proposal.path || tab.saveState === 'conflict' || tab.saveState === 'error' || await agentTextHash(tab.content) !== proposal.baseHash) throw new Error('The proposal is stale or its file has a conflict. Your current text was preserved.')
    const after = applyAgentProposal(tab.content, proposal)
    const checkpoint = await window.margin.prepareAgentApply(taskId, proposal.id, { tabId: tab.id, path: tab.path, content: tab.content, savedContent: tab.savedContent, mtimeMs: tab.mtimeMs })
    if (await agentTextHash(after) !== checkpoint.afterHash) throw new Error('The restore-point checksum did not match the proposal.')
    await editFromAgent(tab.id, tab.content, proposal.from!, proposal.to!, proposal.after, tab.path)
    showToast('Agent edit accepted. A local restore point was saved.', 'success')
    return checkpoint
  }, [editFromAgent, showToast])

  const createAgentDraft = useCallback((proposal: AgentProposal) => {
    if (tabsRef.current.length >= MAX_OPEN_TABS) throw new Error('Close a tab before creating this draft.')
    const retained = tabsRef.current.reduce((bytes, tab) => bytes + new Blob([tab.content]).size + (tab.content !== tab.savedContent ? new Blob([tab.savedContent]).size : 0), 0)
    if (retained + new Blob([proposal.after]).size > MAX_OPEN_CONTENT_BYTES) throw new Error('Close a document before adding more text to this session.')
    const tab = { ...createDocument(proposal.after, proposal.name), mode: 'edit' as const }
    const next = [...tabsRef.current, tab]; tabsRef.current = next; setTabs(next); setActiveId(tab.id); setAgentSelection(null)
  }, [])

  const undoAgentEdit = useCallback(async (checkpoint: AgentCheckpoint) => {
    const tab = tabsRef.current.find((item) => checkpoint.path ? item.path === checkpoint.path : item.id === checkpoint.tabId)
    if (!tab || tab.saveState === 'conflict' || tab.saveState === 'error') throw new Error('Open the original document and resolve its conflict before undoing this change.')
    const before = await window.margin.getAgentRestore(checkpoint.id, { tabId: tab.id, path: tab.path, content: tab.content, savedContent: tab.savedContent, mtimeMs: tab.mtimeMs })
    await editFromAgent(tab.id, tab.content, 0, tab.content.length, before, tab.path)
    showToast('Agent change undone.', 'success')
  }, [editFromAgent, showToast])

  const newDocument = useCallback(() => {
    if (tabsRef.current.length >= MAX_OPEN_TABS) {
      showToast(`Margin supports up to ${MAX_OPEN_TABS} open tabs. Close one before creating another.`, 'error')
      return
    }
    const tab = { ...createDocument('', nextUntitledName(tabsRef.current)), mode: 'live' as const }
    const next = [...tabsRef.current, tab]
    tabsRef.current = next
    setTabs(next)
    setActiveId(tab.id)
    setFocusMode(false)
  }, [showToast])

  const applyOpenedDocuments = useCallback((result: OpenDocumentsResult) => {
    let openedId: string | null = null
    if (result.documents.length) {
      const limited = limitOpenedDocuments(tabsRef.current, result.documents)
      if (limited.documents.length) {
        const merged = mergeOpenedDocuments(tabsRef.current, limited.documents)
        const restored = merged.tabs.map((tab) => {
          if (tabsRef.current.some((previous) => previous.id === tab.id)) return tab
          const record = readingLibraryRef.current[readingKey(tab)]
          return record ? { ...tab, readerScrollTop: record.scrollTop } : tab
        })
        tabsRef.current = restored
        setTabs(restored)
        setActiveId(merged.activeId)
        openedId = merged.activeId
        setFocusMode(false)
        merged.conflicts.forEach((name) => showToast(`${name} also changed on disk. Your edits were preserved.`, 'error'))
      }
      if (limited.dropped) {
        const reason = limited.droppedForBytes
          ? `Margin keeps at most ${Math.floor(MAX_OPEN_CONTENT_BYTES / 1024 / 1024)} MB of document text open at once.`
          : `Margin supports up to ${MAX_OPEN_TABS} tabs.`
        showToast(`${limited.dropped} document${limited.dropped === 1 ? ' was' : 's were'} not opened. ${reason}`, 'error')
      }
    }
    result.errors.forEach((error) => showToast(error.message, 'error'))
    return openedId
  }, [showToast])

  const revealAgentSource = useCallback(async (source: AgentSource) => {
    let tab = tabsRef.current.find((item) => item.id === source.tabId || (source.path && item.path === source.path))
    if (!tab && source.path) {
      const id = applyOpenedDocuments(await window.margin.reopenDocument(source.path))
      tab = tabsRef.current.find((item) => item.id === id)
    }
    if (!tab) throw new Error('The source is no longer available. Its quoted snapshot remains in the Agent desk.')
    if (await agentTextHash(tab.content) !== source.hash) showToast('This source changed after the task. The Agent desk retains the passage it actually read.')
    setActiveId(tab.id); setFocusMode(false)
    pendingEditorReveal.current.set(tab.id, { line: source.startLine, column: 1 })
    updateTab(tab.id, { mode: 'edit' })
    const id = tab.id
    window.setTimeout(() => {
      const view = editorViews.current.get(id), position = pendingEditorReveal.current.get(id)
      if (view && position) { pendingEditorReveal.current.delete(id); revealEditorPosition(view, position.line, position.column) }
    }, 40)
  }, [applyOpenedDocuments, showToast, updateTab])

  const openDocuments = useCallback(async () => {
    try {
      applyOpenedDocuments(await window.margin.openDocuments())
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'The file could not be opened.', 'error')
    }
  }, [applyOpenedDocuments, showToast])

  const openWorkspace = useCallback(async () => {
    const mutation = ++workspaceMutationRef.current
    ++quickOpenSequenceRef.current
    setQuickOpenOpen(false)
    setQuickOpenDocuments([])
    try {
      const opened = await window.margin.openWorkspace()
      if (mutation !== workspaceMutationRef.current || !opened) return
      setWorkspace(opened)
      setSidebarView('files')
      setWorkspaceRefreshToken((value) => value + 1)
      setSettings((current) => ({ ...current, outlineOpen: true }))
      showToast(`Opened folder ${opened.name}`, 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'The folder could not be opened.', 'error')
    }
  }, [showToast])

  const closeWorkspace = useCallback(async () => {
    ++workspaceMutationRef.current
    ++quickOpenSequenceRef.current
    window.margin.cancelWorkspaceSearch()
    setWorkspace(null)
    setQuickOpenOpen(false)
    setQuickOpenDocuments([])
    setSidebarView('outline')
    try {
      const result = await window.margin.closeWorkspace()
      if (result.warning) showToast(result.warning, 'error')
      else showToast('Folder closed. Open documents remain available.')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'The folder could not be closed.', 'error')
    }
  }, [showToast])

  const refreshWorkspace = useCallback(() => {
    setWorkspaceRefreshToken((value) => value + 1)
    setQuickOpenDocuments([])
  }, [])

  const showWorkspaceSearch = useCallback(() => {
    if (!workspace) {
      showToast('Open a folder before searching across files.', 'error')
      return
    }
    setSidebarView('search')
    setSettings((current) => ({ ...current, outlineOpen: true }))
  }, [showToast, workspace])

  const openWorkspaceFile = useCallback(async (relativePath: string) => {
    const existing = workspace && tabsRef.current.find((tab) => {
      if (!tab.path) return false
      const openRelativePath = relativePathWithinWorkspace(workspace.rootPath, tab.path)
      return openRelativePath != null && workspacePathsEqual(openRelativePath, relativePath)
    })
    if (existing) {
      setActiveId(existing.id)
      setFocusMode(false)
      return existing.id
    }
    try {
      return applyOpenedDocuments(await window.margin.openWorkspaceDocument(relativePath))
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'The workspace document could not be opened.', 'error')
      return null
    }
  }, [applyOpenedDocuments, showToast, workspace])

  const openWorkspaceMatch = useCallback(async (match: WorkspaceSearchMatch) => {
    const openedId = await openWorkspaceFile(match.relativePath)
    if (!openedId) return
    pendingEditorReveal.current.set(openedId, { line: match.line, column: match.column })
    updateTab(openedId, { mode: 'edit' })
    window.setTimeout(() => {
      const view = editorViews.current.get(openedId)
      const position = pendingEditorReveal.current.get(openedId)
      if (!view || !position) return
      pendingEditorReveal.current.delete(openedId)
      revealEditorPosition(view, position.line, position.column)
    }, 40)
  }, [openWorkspaceFile, updateTab])

  const openNote = useCallback(async (target: string, origin: string, wiki = true) => {
    const resolved = resolveNote(noteIndex, target, origin || activeNotePath, wiki)
    if (!resolved) {
      if (workspace) setMissingNote({ target, origin: origin || activeNotePath })
      else showToast('Open a folder to resolve this note link.', 'error')
      return
    }
    const existing = tabsRef.current.find((tab) => notePathForTab(tab, workspace) === resolved.note.relativePath)
    const id = existing?.id || await openWorkspaceFile(resolved.note.relativePath)
    if (!id) return
    setActiveId(id)
    updateTab(id, { mode: 'read' })
    if (resolved.fragment) {
      updateReading(id, { collapsed: [] })
      window.setTimeout(() => {
        const preview = document.querySelector<HTMLElement>(`[data-preview-id="${CSS.escape(id)}"]`)
        if (!preview) return
        if (resolved.fragment.startsWith('^')) {
          const block = Array.from(preview.querySelectorAll<HTMLElement>('p, li, blockquote')).find((element) => element.textContent?.includes(resolved.fragment))
          block?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        } else {
          const normalize = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')
          const heading = preview.querySelector<HTMLElement>(`#${CSS.escape(resolved.fragment)}`) || Array.from(preview.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')).find((element) => normalize(element.textContent?.replace(/^[▾▸]/, '') || '') === normalize(resolved.fragment))
          heading?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      }, 120)
    }
  }, [noteIndex, activeNotePath, workspace, openWorkspaceFile, showToast, updateReading, updateTab])

  const openReadingRecord = useCallback(async (record: ReadingRecord) => {
    const existing = tabsRef.current.find((tab) => readingKey(tab) === record.key)
    const id = existing?.id || (record.path ? applyOpenedDocuments(await window.margin.reopenDocument(record.path)) : null)
    if (id) { setActiveId(id); updateTab(id, { mode: 'read' }) }
    else if (!record.path) showToast('This draft is no longer open. Save drafts to keep permanent bookmarks.', 'error')
  }, [applyOpenedDocuments, showToast, updateTab])

  const openQuickOpen = useCallback(async () => {
    if (!workspace) {
      showToast('Open a folder before using Quick Open.', 'error')
      return
    }
    const workspaceId = workspace.id
    const sequence = ++quickOpenSequenceRef.current
    setAppearanceOpen(false)
    setCommandPaletteOpen(false)
    setDialog(null)
    setQuickOpenOpen(true)
    setQuickOpenLoading(true)
    try {
      const result = await window.margin.listWorkspaceDocuments()
      if (sequence !== quickOpenSequenceRef.current || result.workspaceId !== workspaceId) return
      setQuickOpenDocuments(result.documents)
      if (result.truncated) showToast('Quick Open is showing the first 10,000 documents.', 'error')
    } catch (error) {
      if (sequence === quickOpenSequenceRef.current) {
        setQuickOpenDocuments([])
        showToast(error instanceof Error ? error.message : 'The folder index could not be read.', 'error')
      }
    } finally {
      if (sequence === quickOpenSequenceRef.current) setQuickOpenLoading(false)
    }
  }, [showToast, workspace])

  const quickOpenCommands = useMemo<PaletteCommand[]>(() => quickOpenOpen ? quickOpenDocuments.map((entry) => ({
    id: `workspace-${entry.relativePath}`,
    label: entry.name,
    group: entry.relativePath,
    run: () => { void openWorkspaceFile(entry.relativePath) },
  })) : [], [openWorkspaceFile, quickOpenDocuments, quickOpenOpen])

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
      const previousReadingKey = readingKey(snapshot)
      if (previousReadingKey !== result.path && readingLibraryRef.current[previousReadingKey]) {
        const current = readingLibraryRef.current
        const next = { ...current, [result.path]: { ...current[previousReadingKey], key: result.path, path: result.path, name: result.name } }
        if (!snapshot.path) delete next[previousReadingKey]
        readingLibraryRef.current = next
        setReadingLibrary(next)
      }
      if (snapshot.path) observedExternalChanges.current.delete(snapshot.path)
      observedExternalChanges.current.delete(result.path)
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
    const cleanup = () => {
      if (documentSaveQueues.current.get(id) === queued) documentSaveQueues.current.delete(id)
    }
    void queued.then(cleanup, cleanup)
    return queued
  }, [performSave])

  const closeTab = useCallback(async (id: string) => {
    if (closingTabsRef.current.has(id)) return false
    closingTabsRef.current.add(id)
    await documentSaveQueues.current.get(id)?.catch(() => false)
    const tab = tabsRef.current.find((candidate) => candidate.id === id)
    if (!tab) {
      closingTabsRef.current.delete(id)
      return true
    }
    let discarded = false
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
      discarded = choice === 'discard'
    }
    const current = tabsRef.current
    const index = current.findIndex((candidate) => candidate.id === id)
    const next = current.filter((candidate) => candidate.id !== id)
    const closed = tabsRef.current.find((candidate) => candidate.id === id)
    if (closed && !discarded) closedTabsRef.current = [closed, ...closedTabsRef.current.filter((candidate) => candidate.id !== id)].slice(0, 10)
    tabsRef.current = next
    setTabs(next)
    editorViews.current.delete(id)
    closingTabsRef.current.delete(id)
    const nextActiveId = next[Math.min(index, next.length - 1)]?.id ?? null
    setActiveId((currentActiveId) => currentActiveId === id ? nextActiveId : currentActiveId)
    if (recoveryWritableRef.current) void saveRecoverySnapshot(next).catch(() => showToast('The local recovery backup could not be updated.', 'error'))
    return true
  }, [saveDocument, saveRecoverySnapshot, showToast])

  const reopenClosedTab = useCallback(() => {
    const closed = closedTabsRef.current[0]
    if (!closed) {
      showToast('There are no recently closed tabs.')
      return
    }
    const existing = closed.path ? tabsRef.current.find((tab) => tab.path === closed.path) : null
    if (existing) {
      setActiveId(existing.id)
      closedTabsRef.current.shift()
      return
    }
    if (tabsRef.current.length >= MAX_OPEN_TABS) {
      showToast(`Close a tab before reopening ${closed.name}.`, 'error')
      return
    }
    closedTabsRef.current.shift()
    const next = [...tabsRef.current, closed]
    tabsRef.current = next
    setTabs(next)
    setActiveId(closed.id)
  }, [showToast])

  const closeAllTabs = useCallback(async () => {
    for (const tab of [...tabsRef.current]) {
      if (!(await closeTab(tab.id))) return
    }
  }, [closeTab])

  const closeWindow = useCallback(async () => {
    if (closingRef.current) return
    closingRef.current = true
    try {
      saveReadingLibrary(readingLibraryRef.current)
    } catch {
      closingRef.current = false
      window.margin.cancelWindowClose()
      showToast('Reading notes could not be saved. Free local storage or remove older annotations before quitting.', 'error')
      return
    }
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
    if (recoveryWritableRef.current) {
      try {
        await window.margin.clearSession()
      } catch (error) {
        closingRef.current = false
        window.margin.cancelWindowClose()
        showToast(error instanceof Error ? error.message : 'The recovery backup could not be cleared safely.', 'error')
        return
      }
    }
    window.margin.closeWindow()
  }, [saveDocument, showToast])

  const setMode = useCallback((mode: DocumentMode) => {
    const id = activeId
    if (!id) return
    updateTab(id, { mode })
    if (mode !== 'read') {
      setReaderFindOpen(false)
      setReaderFind('')
    }
    if (mode !== 'read') window.setTimeout(() => editorViews.current.get(id)?.focus(), 20)
  }, [activeId, updateTab])

  const handleContentChange = useCallback((id: string, content: string) => {
    updateTab(id, (tab) => ({
      content,
      revision: tab.revision + 1,
      saveState: tab.saveState === 'conflict' ? 'conflict' : content === tab.savedContent ? 'saved' : 'edited',
    }))
  }, [updateTab])

  const handleCursor = useCallback((id: string, cursorLine: number, cursorColumn: number, selectionAnchor: number, selectionHead: number) => {
    updateTab(id, { cursorLine, cursorColumn, selectionAnchor, selectionHead })
  }, [updateTab])

  const handleEditorScroll = useCallback((id: string, editorScrollTop: number, editorScrollLeft: number) => {
    updateTab(id, { editorScrollTop, editorScrollLeft })
    const tab = tabsRef.current.find((candidate) => candidate.id === id)
    if (tab?.mode !== 'split') return
    if (scrollSyncSource.current === 'reader') {
      scrollSyncSource.current = null
      return
    }
    const view = editorViews.current.get(id)
    const preview = document.querySelector<HTMLElement>(`[data-preview-id="${CSS.escape(id)}"]`)
    if (!view || !preview) return
    const editorMax = Math.max(1, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight)
    const previewMax = Math.max(0, preview.scrollHeight - preview.clientHeight)
    const nextScrollTop = (editorScrollTop / editorMax) * previewMax
    if (Math.abs(preview.scrollTop - nextScrollTop) < 0.5) return
    scrollSyncSource.current = 'editor'
    preview.scrollTop = nextScrollTop
  }, [updateTab])

  const handleReaderScroll = useCallback((id: string, readerScrollTop: number) => {
    updateTab(id, { readerScrollTop })
    const tab = tabsRef.current.find((candidate) => candidate.id === id)
    if (tab?.mode !== 'split') return
    if (scrollSyncSource.current === 'editor') {
      scrollSyncSource.current = null
      return
    }
    const view = editorViews.current.get(id)
    const preview = document.querySelector<HTMLElement>(`[data-preview-id="${CSS.escape(id)}"]`)
    if (!view || !preview) return
    const previewMax = Math.max(1, preview.scrollHeight - preview.clientHeight)
    const editorMax = Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight)
    const nextScrollTop = (readerScrollTop / previewMax) * editorMax
    if (Math.abs(view.scrollDOM.scrollTop - nextScrollTop) < 0.5) return
    scrollSyncSource.current = 'reader'
    view.scrollDOM.scrollTop = nextScrollTop
  }, [updateTab])

  const togglePreviewTask = useCallback((id: string, sourceLine: number, checked: boolean) => {
    const view = editorViews.current.get(id)
    if (view && sourceLine >= 0 && sourceLine < view.state.doc.lines) {
      const line = view.state.doc.line(sourceLine + 1)
      const match = line.text.match(/^(\s*(?:[-+*]|\d+[.)])\s+\[)([ xX])(\])/)
      if (match) {
        const marker = line.from + match[1].length
        if (view.state.sliceDoc(marker, marker + 1).toLowerCase() !== (checked ? 'x' : ' ')) {
          view.dispatch({ changes: { from: marker, to: marker + 1, insert: checked ? 'x' : ' ' } })
        }
        return
      }
    }
    updateTab(id, (tab) => {
      const content = toggleTaskAtLine(tab.content, sourceLine, checked)
      return content === tab.content ? {} : {
        content,
        revision: tab.revision + 1,
        saveState: tab.saveState === 'conflict' ? 'conflict' : content === tab.savedContent ? 'saved' : 'edited',
      }
    })
  }, [updateTab])

  const copyCode = useCallback((code: string) => {
    void window.margin.copyText(code).then((copied) => showToast(copied ? 'Code copied.' : 'This code block is too large to copy.', copied ? 'success' : 'error')).catch(() => showToast('Code could not be copied.', 'error'))
  }, [showToast])

  const handlePreviewReady = useCallback((id: string) => {
    const tab = tabsRef.current.find((candidate) => candidate.id === id)
    const view = editorViews.current.get(id)
    if (tab?.mode === 'split' && view) handleEditorScroll(id, view.scrollDOM.scrollTop, view.scrollDOM.scrollLeft)
  }, [handleEditorScroll])

  const registerEditor = useCallback((id: string, view: EditorView) => {
    editorViews.current.set(id, view)
    const agentEdit = pendingAgentEdits.current.get(id)
    if (agentEdit) {
      pendingAgentEdits.current.delete(id)
      const tab = tabsRef.current.find((item) => item.id === id)
      if (!tab || tab.path !== agentEdit.path || tab.content !== agentEdit.expected || view.state.doc.toString() !== agentEdit.expected || closingRef.current || closingTabsRef.current.has(id)) {
        agentEdit.reject(new Error('The original document changed or closed. Nothing was applied.'))
      } else {
        view.dispatch({ changes: { from: agentEdit.from, to: agentEdit.to, insert: agentEdit.insert }, userEvent: 'input.agent' })
        view.focus(); agentEdit.resolve()
      }
      return
    }
    const pendingReveal = pendingEditorReveal.current.get(id)
    if (pendingReveal) {
      pendingEditorReveal.current.delete(id)
      revealEditorPosition(view, pendingReveal.line, pendingReveal.column)
    }
    const pendingFormat = pendingEditorFormat.current.get(id)
    if (pendingFormat) {
      pendingEditorFormat.current.delete(id)
      if (pendingFormat === 'undo') undo(view)
      else if (pendingFormat === 'redo') redo(view)
      else if (pendingFormat === 'gotoLine') gotoLine(view)
      else if (pendingFormat.startsWith('image:')) insertImagePath(view, pendingFormat.slice(6))
      else applyFormat(view, pendingFormat as FormatAction)
      return
    }
    if (pendingEditorFind.current.delete(id)) {
      openSearchPanel(view)
      return
    }
    if (tabsRef.current.find((tab) => tab.id === id)?.mode !== 'read') view.focus()
  }, [])

  const format = useCallback((action: FormatAction | string) => {
    if (!activeId) return
    const tab = tabsRef.current.find((candidate) => candidate.id === activeId)
    if (!tab) return
    if (action === 'image') {
      if (!tab.path) {
        showToast('Save this draft before importing an image.', 'error')
        return
      }
      if (tab.saveState === 'conflict' || tab.saveState === 'error') {
        showToast('Resolve this document’s file conflict before importing an image.', 'error')
        return
      }
      const importedDocumentPath = tab.path
      void window.margin.importImage(importedDocumentPath).then((result) => {
        if (result.status !== 'imported') return
        const current = tabsRef.current.find((candidate) => candidate.id === activeId)
        if (!current || current.path !== importedDocumentPath || current.saveState === 'conflict' || current.saveState === 'error') {
          showToast('The image was copied beside the previous file, but its link was not inserted because the document moved, closed, or conflicted.', 'error')
          return
        }
        updateTab(activeId, (current) => ({ mode: current.mode === 'read' ? 'edit' : current.mode }))
        window.setTimeout(() => {
          const currentView = editorViews.current.get(activeId)
          if (currentView) insertImagePath(currentView, result.relativePath)
          else pendingEditorFormat.current.set(activeId, `image:${result.relativePath}`)
        }, 20)
      }).catch((error) => showToast(error instanceof Error ? error.message : 'The image could not be imported.', 'error'))
      return
    }
    const view = editorViews.current.get(activeId)
    updateTab(activeId, (current) => ({ mode: current.mode === 'read' ? 'edit' : current.mode }))
    if (!view) {
      pendingEditorFormat.current.set(activeId, action)
      return
    }
    if (action === 'undo') { undo(view); view.focus(); return }
    if (action === 'redo') { redo(view); view.focus(); return }
    applyFormat(view, action as FormatAction)
  }, [activeId, showToast, updateTab])

  const importImageFiles = useCallback(async (id: string, files: File[], selection: { from: number; to: number }) => {
    const tab = tabsRef.current.find((candidate) => candidate.id === id)
    if (!tab?.path) {
      showToast('Save this draft before pasting or dropping images.', 'error')
      return
    }
    if (tab.saveState === 'conflict' || tab.saveState === 'error') {
      showToast('Resolve this document’s file conflict before importing images.', 'error')
      return
    }
    const initialPath = tab.path
    const initialRevision = tab.revision
    const initialContent = tab.content
    const importedPaths: string[] = []
    let acceptedBytes = 0
    let skipped = Math.max(0, files.length - 20)
    let lastError = ''
    const candidates = files.slice(0, 20)
    for (const [index, file] of candidates.entries()) {
      const current = tabsRef.current.find((candidate) => candidate.id === id)
      if (!current || current.path !== initialPath) {
        skipped += candidates.length - index
        lastError = 'The document moved while its images were being imported.'
        break
      }
      if (!file.size || file.size > 20 * 1024 * 1024 || acceptedBytes + file.size > 50 * 1024 * 1024) {
        skipped += 1
        continue
      }
      acceptedBytes += file.size
      try {
        const result = await window.margin.importImageData(initialPath, {
          name: file.name || `pasted-image-${index + 1}.png`,
          mimeType: file.type || 'application/octet-stream',
          data: await file.arrayBuffer(),
        })
        importedPaths.push(result.relativePath)
      } catch (error) {
        skipped += 1
        lastError = error instanceof Error ? error.message : 'An image could not be imported.'
      }
    }
    const current = tabsRef.current.find((candidate) => candidate.id === id)
    const view = editorViews.current.get(id)
    if (importedPaths.length && current?.path === initialPath && view) {
      const insertionSelection = current.revision === initialRevision && current.content === initialContent
        ? selection
        : { from: view.state.selection.main.head, to: view.state.selection.main.head }
      insertImagePaths(view, importedPaths, insertionSelection)
      showToast(`Imported ${importedPaths.length} image${importedPaths.length === 1 ? '' : 's'} into assets.`, 'success')
    } else if (importedPaths.length) {
      showToast('Images were copied beside the previous file, but links were not inserted because the document moved or closed.', 'error')
    }
    if (skipped) showToast(lastError || `${skipped} image${skipped === 1 ? ' was' : 's were'} skipped because the import limit was reached.`, 'error')
  }, [showToast])

  const openGoToLine = useCallback(() => {
    if (!activeId) return
    updateTab(activeId, (tab) => ({ mode: tab.mode === 'read' ? 'edit' : tab.mode }))
    window.setTimeout(() => {
      const view = editorViews.current.get(activeId)
      if (view) gotoLine(view)
      else pendingEditorFormat.current.set(activeId, 'gotoLine')
    }, 20)
  }, [activeId, updateTab])

  const selectAdjacentTab = useCallback((direction: 1 | -1) => {
    const current = tabsRef.current
    if (current.length < 2) return
    const index = Math.max(0, current.findIndex((tab) => tab.id === activeId))
    setActiveId(current[(index + direction + current.length) % current.length].id)
  }, [activeId])

  const reorderTabs = useCallback((sourceId: string, targetId: string) => {
    if (sourceId === targetId) return
    const current = [...tabsRef.current]
    const sourceIndex = current.findIndex((tab) => tab.id === sourceId)
    const targetIndex = current.findIndex((tab) => tab.id === targetId)
    if (sourceIndex < 0 || targetIndex < 0) return
    const [moved] = current.splice(sourceIndex, 1)
    current.splice(targetIndex, 0, moved)
    tabsRef.current = current
    setTabs(current)
  }, [])

  const openFind = useCallback((replace = false) => {
    if (!activeTab) return
    if (activeTab.mode !== 'read' || replace) {
      if (replace) {
        setReaderFindOpen(false)
        setReaderFind('')
        updateTab(activeTab.id, { mode: activeTab.mode === 'read' ? 'edit' : activeTab.mode })
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
      updateReading(activeTab.id, { collapsed: [] })
      window.setTimeout(() => {
        const preview = document.querySelector<HTMLElement>(`[data-preview-id="${activeTab.id}"]`)
        preview?.querySelector<HTMLElement>(`#${CSS.escape(item.id)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 20)
      return
    }
    const view = editorViews.current.get(activeTab.id)
    if (!view) return
    const line = view.state.doc.line(Math.min(item.line, view.state.doc.lines))
    view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true })
    view.focus()
  }, [activeTab, updateReading])

  const exportDocument = useCallback(async (kind: 'html' | 'pdf') => {
    const tab = tabsRef.current.find((candidate) => candidate.id === activeId)
    if (!tab) return
    showToast(`Preparing ${kind.toUpperCase()}…`)
    try {
      const html = await createExportHtml(tab.content, tab.path, fileStem(tab.name), settings, { index: noteIndex, relativePath: notePathForTab(tab, workspace), assetDocumentPath, expandCallouts: kind === 'pdf' })
      const request = { html, suggestedName: `${fileStem(tab.name)}.${kind}` }
      const result = kind === 'html' ? await window.margin.exportHtml(request) : await window.margin.exportPdf(request)
      if (result.status === 'saved') showToast(`${kind.toUpperCase()} exported`, 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : `The ${kind.toUpperCase()} export failed.`, 'error')
    }
  }, [activeId, settings, showToast, noteIndex, workspace, assetDocumentPath])

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings((current) => ({ ...current, ...patch }))
  }, [])

  const updateReaderFindStatus = useCallback((current: number, total: number) => {
    setReaderFindStatus((previous) => previous.current === current && previous.total === total
      ? previous
      : { current, total })
  }, [])

  const toggleBookmark = useCallback(() => {
    if (activeId) updateReading(activeId, (record) => ({ bookmarked: !record.bookmarked }))
  }, [activeId, updateReading])
  const handleReadingProgress = useCallback((id: string, scrollTop: number, progress: number) => {
    const tab = tabsRef.current.find((tab) => tab.id === id)
    if (!tab) return
    const key = readingKey(tab)
    const current = readingLibraryRef.current
    const record = current[key] || emptyReadingRecord(tab)
    if (record.scrollTop === scrollTop && record.progress === progress) return
    readingLibraryRef.current = { ...current, [key]: { ...record, scrollTop, progress, updatedAt: Date.now() } }
    if (readingUiTimer.current != null) return
    // Capture the latest position synchronously; only the desk repaint is throttled.
    readingUiTimer.current = setTimeout(() => {
      readingUiTimer.current = undefined
      setReadingLibrary(readingLibraryRef.current)
    }, 120)
  }, [])
  const addAnnotation = useCallback((anchor: TextAnchor, color: Annotation['color']) => {
    if (!activeId) return
    const tab = tabsRef.current.find((tab) => tab.id === activeId)
    if (!tab) return
    if ((readingLibraryRef.current[readingKey(tab)]?.annotations.length || 0) >= 200) { showToast('This document already has 200 annotations.', 'error'); return }
    const annotation: Annotation = { ...anchor, id: crypto.randomUUID(), note: '', color, createdAt: Date.now() }
    updateReading(activeId, (record) => ({ annotations: [...record.annotations, annotation] }))
    setReadingToolsOpen(true)
    if (color === 'green') window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(`[data-annotation-id="${CSS.escape(annotation.id)}"] textarea`)?.focus(), 80)
  }, [activeId, showToast, updateReading])
  const editAnnotation = useCallback((id: string, patch: Partial<Pick<Annotation, 'note' | 'color'>>) => {
    if (activeId) updateReading(activeId, (record) => ({ annotations: record.annotations.map((annotation) => annotation.id === id ? { ...annotation, ...patch } : annotation) }))
  }, [activeId, updateReading])
  const deleteAnnotation = useCallback((id: string) => {
    if (activeId) updateReading(activeId, (record) => ({ annotations: record.annotations.filter((annotation) => annotation.id !== id) }))
  }, [activeId, updateReading])
  const revealAnnotation = useCallback((id: string) => {
    if (!activeId) return
    setMode('read')
    updateReading(activeId, { collapsed: [] })
    window.setTimeout(() => {
      const mark = document.querySelector<HTMLElement>(`[data-preview-id="${CSS.escape(activeId)}"] [data-margin-annotation="${CSS.escape(id)}"]`)
      if (mark) { mark.scrollIntoView({ block: 'center', behavior: 'smooth' }); mark.animate?.([{ outline: '3px solid var(--ui-accent)' }, { outline: '3px solid transparent' }], { duration: 1300 }) }
      else showToast('The highlighted text has changed and could not be found.', 'neutral')
    }, 100)
  }, [activeId, setMode, showToast, updateReading])
  const selectAnnotation = useCallback((id: string) => {
    setReadingToolsOpen(true)
    window.setTimeout(() => document.querySelector<HTMLElement>(`[data-annotation-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' }), 80)
  }, [])
  const closeGraph = useCallback(() => setGraphOpen(false), [])
  const closePresentation = useCallback(() => setPresentationOpen(false), [])
  const closeImageViewer = useCallback(() => setImageViewer(null), [])
  const createMissingNote = useCallback(async (relativePath: string) => {
    try {
      const id = applyOpenedDocuments(await window.margin.createWorkspaceDocument(relativePath))
      if (id) { updateTab(id, { mode: 'live' }); setMissingNote(null); refreshWorkspace() }
    } catch (error) { showToast(error instanceof Error ? error.message : 'The note could not be created.', 'error') }
  }, [applyOpenedDocuments, refreshWorkspace, showToast, updateTab])

  useEffect(() => {
    const unsubscribe = window.margin.onCommand((command, payload) => {
      switch (command) {
        case 'new': newDocument(); break
        case 'open': void openDocuments(); break
        case 'openWorkspace': void openWorkspace(); break
        case 'closeWorkspace': void closeWorkspace(); break
        case 'refreshWorkspace': refreshWorkspace(); break
        case 'quickOpen': void openQuickOpen(); break
        case 'searchWorkspace': showWorkspaceSearch(); break
        case 'save': if (activeId) void saveDocument(activeId); break
        case 'saveAs': if (activeId) void saveDocument(activeId, { saveAs: true }); break
        case 'closeTab': if (activeId) void closeTab(activeId); break
        case 'closeAllTabs': void closeAllTabs(); break
        case 'reopenClosedTab': reopenClosedTab(); break
        case 'toggleMode': if (activeTab) setMode(activeTab.mode === 'read' ? 'edit' : 'read'); break
        case 'splitMode': if (activeTab) setMode(activeTab.mode === 'split' ? 'edit' : 'split'); break
        case 'liveMode': if (activeTab) setMode('live'); break
        case 'back': navigate('back'); break
        case 'forward': navigate('forward'); break
        case 'readingTools': setReadingToolsOpen((value) => !value); break
        case 'graph': setGraphOpen(true); break
        case 'presentation': if (activeTab) setPresentationOpen(true); break
        case 'bookmark': toggleBookmark(); break
        case 'toggleOutline': updateSettings({ outlineOpen: !settings.outlineOpen }); break
        case 'focusMode': setFocusMode((value) => !value); break
        case 'setWordWrap': updateSettings({ editorWordWrap: payload === 'true' }); break
        case 'setLineNumbers': updateSettings({ editorLineNumbers: payload === 'true' }); break
        case 'setShowWhitespace': updateSettings({ editorShowWhitespace: payload === 'true' }); break
        case 'setTypewriterMode': updateSettings({ editorTypewriterMode: payload === 'true' }); break
        case 'nextTab': selectAdjacentTab(1); break
        case 'previousTab': selectAdjacentTab(-1); break
        case 'appearance': openAppearance(); break
        case 'commandPalette': openCommandPalette(); break
        case 'find': openFind(); break
        case 'replace': openFind(true); break
        case 'goToLine': openGoToLine(); break
        case 'format': if (payload) format(payload); break
        case 'exportHtml': void exportDocument('html'); break
        case 'exportPdf': void exportDocument('pdf'); break
        case 'shortcuts': openInfoDialog('shortcuts'); break
        case 'about': openInfoDialog('about'); break
        case 'requestWindowClose': void closeWindow(); break
      }
    })
    return unsubscribe
  }, [activeId, activeTab, closeAllTabs, closeTab, closeWindow, closeWorkspace, exportDocument, format, newDocument, openAppearance, openCommandPalette, openDocuments, openFind, openGoToLine, openInfoDialog, openQuickOpen, openWorkspace, refreshWorkspace, reopenClosedTab, saveDocument, selectAdjacentTab, setMode, settings.outlineOpen, showWorkspaceSearch, updateSettings, toggleBookmark, navigate])

  useEffect(() => {
    let mounted = true
    const unsubscribe = window.margin.onOpenDocuments((result) => {
      if (mounted) applyOpenedDocuments(result)
    })
    void window.margin.loadSession().then(({ tabs: restored, warning }) => {
      if (!mounted) return
      if (warning) showToast(warning, 'error')
      if (tabsRef.current.length) return
      tabsRef.current = restored
      setTabs(restored)
      const preferredId = localStorage.getItem('margin:active-tab')
      setActiveId(restored.find((tab) => tab.id === preferredId)?.id ?? restored[0]?.id ?? null)
    }).catch((error) => {
      recoveryWritableRef.current = false
      if (mounted) showToast(error instanceof Error ? error.message : 'The recovery backup could not be loaded.', 'error')
    }).finally(() => {
      if (!mounted) return
      setSessionReady(true)
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [applyOpenedDocuments, showToast])

  useEffect(() => {
    if (!sessionReady) return
    // Signal readiness only after restored tabs and the latest command-handler
    // closure have committed, so queued native commands see the active document.
    window.margin.readyForSafeClose()
    window.margin.readyForOpenDocuments()
  }, [sessionReady])

  useEffect(() => {
    if (!sessionReady) return
    let mounted = true
    const mutation = workspaceMutationRef.current
    void window.margin.loadWorkspace().then((restoredWorkspace) => {
      if (!mounted || mutation !== workspaceMutationRef.current || !restoredWorkspace) return
      setWorkspace(restoredWorkspace)
      setSidebarView('files')
    }).catch((error) => {
      if (mounted && mutation === workspaceMutationRef.current) {
        showToast(error instanceof Error ? error.message : 'The previous folder could not be restored.', 'error')
      }
    })
    return () => { mounted = false }
  }, [sessionReady, showToast])

  useEffect(() => {
    if (!sessionReady) return
    // Reserve the ordering before the timer starts so an older delayed snapshot
    // cannot outrank an immediate close-tab or edit snapshot that runs first.
    const generation = reserveRecoveryGeneration()
    const timeout = window.setTimeout(() => {
      if (!closingRef.current && recoveryWritableRef.current) void saveRecoverySnapshot(tabs, generation).catch(() => {
        if (!recoveryWarningShown.current) {
          recoveryWarningShown.current = true
          showToast('The local recovery backup could not be updated.', 'error')
        }
      })
    }, 1000)
    return () => window.clearTimeout(timeout)
  }, [reserveRecoveryGeneration, saveRecoverySnapshot, saveScheduleEpoch, sessionReady, showToast, tabs])

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
          const current = tabsRef.current.find((candidate) => candidate.id === tab.id)
          if (!current || current.path !== tab.path || current.mtimeMs !== tab.mtimeMs || current.saveState === 'saving') continue
          if (!stat.exists) {
            if (observedExternalChanges.current.get(current.path) === -1) continue
            observedExternalChanges.current.set(current.path, -1)
            updateTab(current.id, { saveState: 'conflict' })
            showToast(`${current.name} was moved or deleted. Autosave is paused.`, 'error')
            continue
          }
          if (stat.mtimeMs == null || current.mtimeMs == null || Math.abs(stat.mtimeMs - current.mtimeMs) <= 2) continue
          if (observedExternalChanges.current.get(current.path) === stat.mtimeMs) continue
          if (current.content !== current.savedContent) {
            observedExternalChanges.current.set(current.path, stat.mtimeMs)
            updateTab(current.id, { saveState: 'conflict' })
            showToast(`${current.name} changed on disk while you were editing.`, 'error')
          } else {
            try {
              const fresh = await window.margin.readDocument(current.path)
              const latest = tabsRef.current.find((candidate) => candidate.id === current.id)
              const outcome = latest ? reconcileExternalReload(latest, current.mtimeMs, fresh) : null
              if (!outcome || (!outcome.reloaded && !outcome.conflict)) continue
              const next = outcome
                ? tabsRef.current.map((candidate) => candidate.id === current.id ? outcome.tab : candidate)
                : tabsRef.current
              tabsRef.current = next
              setTabs(next)
              observedExternalChanges.current.set(current.path, stat.mtimeMs)
              if (outcome?.conflict) showToast(`${current.name} changed on disk while you were editing.`, 'error')
              else showToast(`Reloaded changes from ${current.name}.`, 'neutral')
            } catch (error) {
              const latest = tabsRef.current.find((candidate) => candidate.id === current.id)
              if (!latest || latest.path !== current.path || latest.mtimeMs !== current.mtimeMs) continue
              updateTab(current.id, { saveState: 'conflict' })
              showToast(error instanceof Error ? error.message : `${current.name} could not be reloaded safely.`, 'error')
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
    window.margin.setViewOptions({
      wordWrap: settings.editorWordWrap,
      lineNumbers: settings.editorLineNumbers,
      typewriterMode: settings.editorTypewriterMode,
      showWhitespace: settings.editorShowWhitespace,
    })
  }, [darkInterface, settings])

  useEffect(() => {
    if (activeId) localStorage.setItem('margin:active-tab', activeId)
    else localStorage.removeItem('margin:active-tab')
  }, [activeId])

  useEffect(() => {
    window.margin.setDirty(tabs.some(hasUnresolvedChanges))
  }, [tabs])

  const openDocumentPathsKey = tabs.flatMap((tab) => tab.path ? [tab.path] : []).join('\0')
  useEffect(() => {
    window.margin.setOpenDocumentPaths(openDocumentPathsKey ? openDocumentPathsKey.split('\0') : [])
  }, [openDocumentPathsKey])

  const autosaveKey = tabs.map((tab) => `${tab.id}:${tab.path ?? ''}:${tab.saveState}:${tab.revision}:${tab.content === tab.savedContent}`).join('|')
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
    scrollSyncSource.current = null
    if (!activeId || activeMode !== 'split') return
    const frame = window.requestAnimationFrame(() => {
      const view = editorViews.current.get(activeId)
      if (view) handleEditorScroll(activeId, view.scrollDOM.scrollTop, view.scrollDOM.scrollLeft)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeId, activeMode, handleEditorScroll])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        openCommandPalette()
        return
      }
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        void openQuickOpen()
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        showWorkspaceSearch()
        return
      }
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key === ',') {
        event.preventDefault()
        openAppearance()
        return
      }
      if (event.key === 'F8' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        event.preventDefault()
        setFocusMode((value) => !value)
        return
      }
      if (event.key === 'Escape') {
        if (dialog) setDialog(null)
        else if (quickOpenOpen) setQuickOpenOpen(false)
        else if (commandPaletteOpen) setCommandPaletteOpen(false)
        else if (appearanceOpen) setAppearanceOpen(false)
        else if (readerFindOpen) { setReaderFindOpen(false); setReaderFind('') }
        else if (focusMode) setFocusMode(false)
      }
      if ((event.metaKey || event.ctrlKey) && event.key >= '1' && event.key <= '9') {
        const tab = tabsRef.current[Number(event.key) - 1]
        if (tab) { event.preventDefault(); setActiveId(tab.id) }
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [appearanceOpen, commandPaletteOpen, dialog, focusMode, openAppearance, openCommandPalette, openQuickOpen, quickOpenOpen, readerFindOpen, showWorkspaceSearch])

  if (!sessionReady) {
    return <div className="startup-screen" role="status" aria-live="polite"><BookOpen /><span>Restoring your workspace…</span></div>
  }

  const commandKey = isMacPlatform() ? '⌘' : 'Ctrl'
  const paletteOptionKey = isMacPlatform() ? '⌥' : 'Alt'
  const paletteCommands: PaletteCommand[] = [
    { id: 'new', label: 'New document', group: 'File', shortcut: `${commandKey} N`, run: newDocument },
    { id: 'open', label: 'Open document…', group: 'File', shortcut: `${commandKey} O`, run: () => void openDocuments() },
    { id: 'open-folder', label: 'Open folder…', group: 'File', run: () => void openWorkspace() },
    { id: 'close-folder', label: 'Close folder', group: 'File', disabled: !workspace, run: () => void closeWorkspace() },
    { id: 'quick-open', label: 'Quick Open…', group: 'Navigation', shortcut: `${commandKey} P`, disabled: !workspace, run: () => void openQuickOpen() },
    { id: 'search-folder', label: 'Find in folder', group: 'Search', shortcut: `${commandKey} ⇧ F`, disabled: !workspace, run: showWorkspaceSearch },
    { id: 'save', label: 'Save', group: 'File', shortcut: `${commandKey} S`, disabled: !activeId, run: () => { if (activeId) void saveDocument(activeId) } },
    { id: 'save-as', label: 'Save as…', group: 'File', disabled: !activeId, run: () => { if (activeId) void saveDocument(activeId, { saveAs: true }) } },
    { id: 'read', label: 'Switch to Read mode', group: 'View', disabled: !activeTab, run: () => setMode('read') },
    { id: 'live', label: 'Switch to Live editing', group: 'View', disabled: !activeTab, run: () => setMode('live') },
    { id: 'edit', label: 'Switch to Edit mode', group: 'View', disabled: !activeTab, run: () => setMode('edit') },
    { id: 'split', label: 'Switch to Split view', group: 'View', disabled: !activeTab, run: () => setMode('split') },
    { id: 'wrap', label: settings.editorWordWrap ? 'Turn word wrap off' : 'Turn word wrap on', group: 'Editor', shortcut: 'Alt Z', run: () => updateSettings({ editorWordWrap: !settings.editorWordWrap }) },
    { id: 'line-numbers', label: settings.editorLineNumbers ? 'Hide line numbers' : 'Show line numbers', group: 'Editor', run: () => updateSettings({ editorLineNumbers: !settings.editorLineNumbers }) },
    { id: 'typewriter', label: settings.editorTypewriterMode ? 'Turn typewriter mode off' : 'Turn typewriter mode on', group: 'Editor', run: () => updateSettings({ editorTypewriterMode: !settings.editorTypewriterMode }) },
    { id: 'sentence-focus', label: settings.editorFocus === 'sentence' ? 'Turn sentence focus off' : 'Focus on the current sentence', group: 'Editor', run: () => updateSettings({ editorFocus: settings.editorFocus === 'sentence' ? 'off' : 'sentence' }) },
    { id: 'paragraph-focus', label: settings.editorFocus === 'paragraph' ? 'Turn paragraph focus off' : 'Focus on the current paragraph', group: 'Editor', run: () => updateSettings({ editorFocus: settings.editorFocus === 'paragraph' ? 'off' : 'paragraph' }) },
    { id: 'reading-desk', label: readingToolsOpen ? 'Hide reading desk' : 'Show reading desk and connections', group: 'Reading', run: () => setReadingToolsOpen((value) => !value) },
    { id: 'bookmark', label: activeReading?.bookmarked ? 'Remove document bookmark' : 'Bookmark document', group: 'Reading', disabled: !activeTab, run: toggleBookmark },
    { id: 'graph', label: 'Explore note graph', group: 'Navigation', run: () => setGraphOpen(true) },
    { id: 'back', label: 'Go back', group: 'Navigation', disabled: !navigation.current.back.length, run: () => navigate('back') },
    { id: 'forward', label: 'Go forward', group: 'Navigation', disabled: !navigation.current.forward.length, run: () => navigate('forward') },
    { id: 'present', label: 'Present document', group: 'Reading', disabled: !activeTab, run: () => setPresentationOpen(true) },
    { id: 'expand-sections', label: 'Expand all reading sections', group: 'Reading', disabled: !activeTab, run: () => { if (activeId) updateReading(activeId, { collapsed: [] }) } },
    { id: 'collapse-sections', label: 'Collapse all reading sections', group: 'Reading', disabled: !activeTab, run: () => { if (activeId) updateReading(activeId, { collapsed: outline.map((heading) => heading.id) }) } },
    { id: 'find', label: 'Find in document', group: 'Search', shortcut: `${commandKey} F`, disabled: !activeTab, run: () => openFind() },
    { id: 'replace', label: 'Find and replace', group: 'Search', disabled: !activeTab, run: () => openFind(true) },
    { id: 'go-line', label: 'Go to line…', group: 'Navigation', shortcut: `${commandKey} ${paletteOptionKey} G`, disabled: !activeTab, run: openGoToLine },
    { id: 'table', label: 'Insert or format table', group: 'Editor', disabled: !activeTab, run: () => format('table') },
    { id: 'sidebar', label: settings.outlineOpen ? 'Hide sidebar' : 'Show sidebar', group: 'View', run: () => updateSettings({ outlineOpen: !settings.outlineOpen }) },
    { id: 'focus', label: focusMode ? 'Leave focus mode' : 'Enter focus mode', group: 'View', shortcut: 'F8', run: () => setFocusMode((value) => !value) },
    { id: 'settings', label: 'Open settings', group: 'Preferences', shortcut: `${commandKey} ,`, run: openAppearance },
    { id: 'export-html', label: 'Export as HTML…', group: 'Export', disabled: !activeTab, run: () => void exportDocument('html') },
    { id: 'export-pdf', label: 'Export as PDF…', group: 'Export', disabled: !activeTab, run: () => void exportDocument('pdf') },
    { id: 'close-tab', label: 'Close current tab', group: 'Tabs', shortcut: `${commandKey} W`, disabled: !activeId, run: () => { if (activeId) void closeTab(activeId) } },
    { id: 'reopen-tab', label: 'Reopen closed tab', group: 'Tabs', run: reopenClosedTab },
    ...tabs.map((tab, index): PaletteCommand => ({
      id: `tab-${tab.id}`,
      label: `Switch to ${tab.name}`,
      group: tab.path ?? `Tab ${index + 1}`,
      shortcut: index < 9 ? `${commandKey} ${index + 1}` : undefined,
      run: () => setActiveId(tab.id),
    })),
  ]
  return (
    <div className={`app-shell ${focusMode ? 'focus-mode' : ''}`}>
      <Toolbar
        mode={activeMode}
        hasDocument={Boolean(activeTab)}
        outlineOpen={settings.outlineOpen}
        onNew={newDocument}
        onOpen={() => void openDocuments()}
        onOpenWorkspace={() => void openWorkspace()}
        workspaceOpen={Boolean(workspace)}
        onSave={() => activeId && void saveDocument(activeId)}
        onMode={setMode}
        onOutline={() => updateSettings({ outlineOpen: !settings.outlineOpen })}
        onFind={() => openFind()}
        onAppearance={openAppearance}
        onFormat={format}
        readingToolsOpen={readingToolsOpen}
        onReadingTools={() => { setAgentOpen(false); setReadingToolsOpen((value) => !value) }}
        agentOpen={agentOpen}
        onAgent={() => agentOpen ? setAgentOpen(false) : openAgent()}
        onGraph={() => setGraphOpen(true)}
        onPresent={() => setPresentationOpen(true)}
        onBack={() => navigate('back')}
        onForward={() => navigate('forward')}
        canBack={navigation.current.back.some((id) => tabs.some((tab) => tab.id === id))}
        canForward={navigation.current.forward.some((id) => tabs.some((tab) => tab.id === id))}
      />

      {tabs.length > 0 && (
        <div className="tab-strip app-drag-region" role="tablist">
          <div className="tab-scroll no-drag">
            {tabs.map((tab) => (
              <div
                role="presentation"
                className={`document-tab ${tab.id === activeId ? 'is-active' : ''}`}
                key={tab.id}
                draggable
                onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/x-margin-tab', tab.id) }}
                onDragOver={(event) => { if (event.dataTransfer.types.includes('text/x-margin-tab')) event.preventDefault() }}
                onDrop={(event) => { event.preventDefault(); reorderTabs(event.dataTransfer.getData('text/x-margin-tab'), tab.id) }}
                title={tab.path ?? tab.name}
              >
                <button
                  className="tab-select"
                  role="tab"
                  aria-selected={tab.id === activeId}
                  onClick={() => setActiveId(tab.id)}
                  onAuxClick={(event) => { if (event.button === 1) void closeTab(tab.id) }}
                >
                  <span>{tab.name}</span>
                  {hasUnresolvedChanges(tab) && <i className="dirty-dot" aria-label="Unsaved or unresolved changes" />}
                </button>
                <button
                  className="tab-close"
                  aria-label={`Close ${tab.name}`}
                  onClick={() => void closeTab(tab.id)}
                ><X /></button>
              </div>
            ))}
            <button className="new-tab-button" title="New document" aria-label="New document" onClick={newDocument}><FilePlus2 /></button>
          </div>
        </div>
      )}

      <main className="workspace">
        {settings.outlineOpen && !focusMode && (activeTab || workspace) && (
          <WorkspaceSidebar
            key={workspace?.id ?? 'no-workspace'}
            workspace={workspace}
            tabs={tabs}
            activeId={activeId}
            outline={outline}
            view={sidebarView}
            refreshToken={workspaceRefreshToken}
            searchBuffers={workspaceSearchState.buffers}
            searchExcludedPaths={workspaceSearchState.excludedPaths}
            onView={setSidebarView}
            onOpenWorkspace={() => void openWorkspace()}
            onCloseWorkspace={() => void closeWorkspace()}
            onRefresh={refreshWorkspace}
            onOpenFile={(relativePath) => { void openWorkspaceFile(relativePath) }}
            onOpenMatch={(match) => { void openWorkspaceMatch(match) }}
            onSelectTab={setActiveId}
            onHeading={goToHeading}
          />
        )}
        <div className="document-area">
          {!activeTab ? <Welcome onNew={newDocument} onOpen={() => void openDocuments()} onOpenWorkspace={() => void openWorkspace()} /> : (
            <div className={`document-stack mode-${activeTab.mode}`}>
              {tabs.map((tab) => (
                (tab.mode !== 'read' || editorViews.current.has(tab.id)) && (
                  <Suspense key={tab.id} fallback={<div className="editor-loading" role="status">Opening editor…</div>}>
                    <EditorPane
                      tab={tab}
                      active={tab.id === activeId && tab.mode !== 'read'}
                      dark={darkInterface}
                      settings={settings}
                      onChange={handleContentChange}
                      onCursor={handleCursor}
                      onScroll={handleEditorScroll}
                      onCreate={registerEditor}
                      onImportImages={importImageFiles}
                      notes={noteIndex}
                      relativePath={notePathForTab(tab, workspace)}
                      assetDocumentPath={assetDocumentPath}
                      onOpenNote={openNote}
                    />
                  </Suspense>
                )
              ))}
              {(activeTab.mode === 'read' || activeTab.mode === 'split') && (
                <MarkdownPreview
                  tab={activeTab}
                  active
                  settings={settings}
                  findQuery={readerFindOpen ? readerFind : ''}
                  findNavigation={readerFindNavigation}
                  onFindStatus={updateReaderFindStatus}
                  onOpenLink={openLinkedDocument}
                  onToggleTask={togglePreviewTask}
                  onScroll={handleReaderScroll}
                  onCopyCode={copyCode}
                  onReady={handlePreviewReady}
                  restoreScroll={activeTab.mode !== 'split'}
                  notes={noteIndex}
                  relativePath={activeNotePath}
                  assetDocumentPath={assetDocumentPath}
                  reading={activeReading}
                  onOpenNote={openNote}
                  onAddAnnotation={addAnnotation}
                  onSelectAnnotation={selectAnnotation}
                  onCollapsed={(collapsed) => updateReading(activeTab.id, { collapsed })}
                  onImage={(images, initial) => setImageViewer({ images, initial })}
                  onProgress={handleReadingProgress}
                  onAskAgent={(text) => {
                    const from = activeTab.content.indexOf(text), unique = from >= 0 && activeTab.content.indexOf(text, from + 1) === -1
                    setAgentSelection({ tabId: activeTab.id, text, from: unique ? from : null, to: unique ? from + text.length : null })
                    setReadingToolsOpen(false); setAgentOpen(true)
                  }}
                />
              )}
            </div>
          )}
        </div>
        {readingToolsOpen && !focusMode && <Suspense fallback={<aside className="reading-tools desk-empty">Opening reading desk…</aside>}><ReadingTools
          record={activeReading} library={readingLibrary} notes={noteIndex} currentPath={activeNotePath} loading={notesLoading} warning={notesWarning || (noteIndex.limited ? 'Some open or indexed notes exceed the connected-note memory limits.' : '')}
          onClose={() => setReadingToolsOpen(false)} onBookmark={toggleBookmark} onOpenRecord={(record) => { void openReadingRecord(record).catch(() => showToast('The bookmarked file could not be opened.', 'error')) }}
          onOpenNote={openNote} onRevealAnnotation={revealAnnotation} onEditAnnotation={editAnnotation} onDeleteAnnotation={deleteAnnotation}
          onGraph={() => setGraphOpen(true)} onRefresh={refreshWorkspace}
        /></Suspense>}
        {agentOpen && !focusMode && <Suspense fallback={<aside className="reading-tools desk-empty">Opening Agent desk…</aside>}><AgentDesk
          activeTab={activeTab} tabs={tabs} workspace={workspace} notes={noteIndex} relativePath={activeNotePath}
          selection={agentSelection} autosave={settings.autosave}
          onCaptureSelection={captureAgentSelection} onClearSelection={() => setAgentSelection(null)}
          onClose={() => setAgentOpen(false)} onApply={applyAgentEdit} onDraft={createAgentDraft} onUndo={undoAgentEdit} onSource={revealAgentSource}
        /></Suspense>}
      </main>

      {activeTab && (
        <footer className="status-bar">
          <div className={`save-indicator state-${activeTab.saveState}`}>
            {activeTab.saveState === 'saved' && <Check />}
            {(activeTab.saveState === 'conflict' || activeTab.saveState === 'error') && <CircleAlert />}
            <span>{saveLabel(activeTab.saveState)}</span>
          </div>
          {activeTab.path ? (
            <button className="document-location" title={activeTab.path} onClick={() => void window.margin.showItemInFolder(activeTab.path!)}><LocateFixed /> {activeTab.path}</button>
          ) : <span className="document-location">Local recovery draft</span>}
          <div className="document-stats">
            {activeTab.mode !== 'read' && <span className="status-position">Ln {activeTab.cursorLine}, Col {activeTab.cursorColumn}</span>}
            {activeTab.mode !== 'read' && <button className="status-control status-wrap" aria-label="Toggle word wrap" aria-pressed={settings.editorWordWrap} onClick={() => updateSettings({ editorWordWrap: !settings.editorWordWrap })}>{settings.editorWordWrap ? 'Wrap' : 'No wrap'}</button>}
            {activeTab.mode !== 'read' && <button className="status-control status-indent" aria-label="Open indentation settings" onClick={openAppearance}>{settings.editorIndentWithTabs ? `Tabs: ${settings.editorTabSize}` : `Spaces: ${settings.editorTabSize}`}</button>}
            <span className="status-line-ending">{activeTab.lineEnding.toUpperCase()}</span>
            <span className="status-encoding">UTF-8{activeTab.bom ? ' BOM' : ''}</span>
            <span className="status-words">{wordCount.toLocaleString()} words</span>
            <span className="status-characters">{activeTab.content.length.toLocaleString()} characters</span>
            <span className="status-reading-time">{readingMinutes(wordCount)} min read</span>
          </div>
        </footer>
      )}

      {readerFindOpen && (
        <div className="reader-find">
          <Search />
          <input
            value={readerFind}
            onChange={(event) => setReaderFind(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              setReaderFindNavigation((value) => ({ sequence: value.sequence + 1, direction: event.shiftKey ? -1 : 1 }))
            }}
            placeholder="Find in document"
            autoFocus
          />
          <span className="reader-find-status" aria-live="polite">{readerFindStatus.current}/{readerFindStatus.total}</span>
          <button aria-label="Previous match" disabled={!readerFindStatus.total} onClick={() => setReaderFindNavigation((value) => ({ sequence: value.sequence + 1, direction: -1 }))}>↑</button>
          <button aria-label="Next match" disabled={!readerFindStatus.total} onClick={() => setReaderFindNavigation((value) => ({ sequence: value.sequence + 1, direction: 1 }))}>↓</button>
          <button aria-label="Close find" onClick={() => { setReaderFindOpen(false); setReaderFind('') }}><X /></button>
        </div>
      )}

      {appearanceOpen && <><div className="panel-scrim" onClick={closeAppearance} /><AppearancePanel settings={settings} spellcheckAvailable={isMacPlatform()} onChange={updateSettings} onClose={closeAppearance} /></>}
      {commandPaletteOpen && <CommandPalette commands={paletteCommands} onClose={closeCommandPalette} />}
      {quickOpenOpen && <CommandPalette
        commands={quickOpenCommands}
        onClose={closeQuickOpen}
        label="Quick Open"
        placeholder="Search files by name or path…"
        emptyMessage={quickOpenLoading ? 'Indexing folder…' : 'No matching documents'}
      />}
      {dialog && <InfoDialog name={dialog} onClose={closeDialog} />}
      {graphOpen && <Suspense fallback={<div className="overlay-loading" role="status">Opening note graph…</div>}><NoteGraph index={noteIndex} currentPath={activeNotePath} onOpenNote={openNote} onClose={closeGraph} /></Suspense>}
      {presentationOpen && activeTab && <Suspense fallback={<div className="overlay-loading" role="status">Opening presentation…</div>}><PresentationViewer tab={activeTab} settings={settings} notes={noteIndex} relativePath={activeNotePath} assetDocumentPath={assetDocumentPath} onClose={closePresentation} /></Suspense>}
      {imageViewer && <Suspense fallback={null}><ImageViewer {...imageViewer} onClose={closeImageViewer} /></Suspense>}
      {missingNote && <MissingNoteDialog target={missingNote.target} origin={missingNote.origin} onClose={() => setMissingNote(null)} onCreate={createMissingNote} />}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => <div className={`toast tone-${toast.tone}`} key={toast.id}>{toast.tone === 'success' && <Check />}{toast.tone === 'error' && <CircleAlert />}{toast.message}</div>)}
      </div>
    </div>
  )
}

function notePathForTab(tab: DocumentTab, workspace: WorkspaceDescriptor | null) {
  return (workspace && tab.path ? relativePathWithinWorkspace(workspace.rootPath, tab.path) : null) || `@open/${tab.id}/${tab.name}`
}

function MissingNoteDialog({ target, origin, onCreate, onClose }: { target: string; origin: string; onCreate: (path: string) => Promise<void>; onClose: () => void }) {
  const ref = useModal(onClose)
  const [path, setPath] = useState(() => {
    const directory = origin.startsWith('@open/') ? '' : origin.split('/').slice(0, -1).join('/')
    const normalized = normalizeNotePath(target.split('#')[0].split('?')[0], directory) || ''
    return normalized ? /\.(?:md|markdown|mdown|mkd|txt)$/i.test(normalized) ? normalized.replace(/\.(?:md|markdown|mdown|mkd|txt)$/i, '.md') : `${normalized}.md` : ''
  })
  const [busy, setBusy] = useState(false)
  return <div className="modal-backdrop"><section ref={ref} className="create-note-dialog" role="dialog" aria-modal="true" aria-label="Create linked note"><h2>Create linked note</h2><p>No unique note matches “{target}”. Choose a path inside the current folder.</p><label>Note path<input value={path} onChange={(event) => setPath(event.target.value)} placeholder="notes/New note.md" /></label><small>The containing folder must already exist.</small><div><button className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button><button className="primary-button" disabled={busy || !path.trim()} onClick={async () => { setBusy(true); try { await onCreate(path.trim()) } finally { setBusy(false) } }}>{busy ? 'Creating…' : 'Create note'}</button></div></section></div>
}

function Welcome({ onNew, onOpen, onOpenWorkspace }: { onNew: () => void; onOpen: () => void; onOpenWorkspace: () => void }) {
  const commandKey = isMacPlatform() ? '⌘' : 'Ctrl'
  return (
    <section className="welcome">
      <div className="welcome-mark"><BookOpen /></div>
      <span className="eyebrow">A quiet place for Markdown</span>
      <h1>Read deeply.<br />Edit simply.</h1>
      <p>Margin keeps your notes on your device and puts the document—not the interface—at the center.</p>
      <div className="welcome-actions">
        <button className="primary-button" onClick={onOpen}><FolderOpen /> Open a document</button>
        <button className="secondary-button" onClick={onNew}><FilePlus2 /> New document</button>
        <button className="secondary-button" onClick={onOpenWorkspace}><FolderTree /> Open a folder</button>
      </div>
      <div className="welcome-hints"><span><kbd>{commandKey}</kbd><kbd>O</kbd> Open</span><span><kbd>{commandKey}</kbd><kbd>N</kbd> New</span><span><kbd>{commandKey}</kbd><kbd>E</kbd> Read / Edit</span></div>
    </section>
  )
}

function InfoDialog({ name, onClose }: { name: Exclude<DialogName, null>; onClose: () => void }) {
  const commandKey = isMacPlatform() ? '⌘' : 'Ctrl'
  const optionKey = isMacPlatform() ? '⌥' : 'Alt'
  const shiftKey = isMacPlatform() ? '⇧' : 'Shift'
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex]:not([tabindex="-1"])'))
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
  }, [])
  return (
    <div className="dialog-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={dialogRef} className="info-dialog" role="dialog" aria-modal="true" aria-label={name === 'about' ? 'About Margin' : 'Keyboard shortcuts'}>
        <button ref={closeRef} className="icon-button dialog-close" onClick={onClose} aria-label="Close"><X /></button>
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
                ['New document', `${commandKey} N`], ['Open', `${commandKey} O`], ['Save', `${commandKey} S`], ['Save as', `${shiftKey} ${commandKey} S`],
                ['Read / Edit', `${commandKey} E`], ['Split view', `${shiftKey} ${commandKey} E`], ['Command palette', `${shiftKey} ${commandKey} P`], ['Quick Open', `${commandKey} P`], ['Find', `${commandKey} F`], ['Find in folder', `${shiftKey} ${commandKey} F`], ['Go to line', `${commandKey} ${optionKey} G`],
                ['Replace', isMacPlatform() ? `${optionKey} ${commandKey} F` : `${commandKey} H`], ['Close tab', `${commandKey} W`], ['Reopen tab', `${shiftKey} ${commandKey} T`], ['Word wrap', `${optionKey} Z`],
                ['Bold', `${commandKey} B`], ['Italic', `${commandKey} I`], ['Link', `${commandKey} K`], ['Toggle sidebar', `${shiftKey} ${commandKey} O`], ['Focus mode', 'F8'],
              ].map(([label, keys]) => <div key={label}><span>{label}</span><kbd>{keys}</kbd></div>)}
            </div>
            <p className="platform-note">Shortcuts follow your operating system conventions.</p>
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

function useDebouncedKeyedValue<T>(key: string | null, value: T, delay: number): T {
  const [debounced, setDebounced] = useState({ key, value })
  useEffect(() => {
    if (debounced.key !== key) {
      setDebounced({ key, value })
      return
    }
    const timer = window.setTimeout(() => setDebounced({ key, value }), delay)
    return () => window.clearTimeout(timer)
  }, [debounced.key, delay, key, value])
  return debounced.key === key ? debounced.value : value
}

function isMacPlatform() {
  return document.documentElement.dataset.platform === 'darwin'
}

function relativePathWithinWorkspace(rootPath: string, filePath: string): string | null {
  const root = rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const candidate = filePath.replace(/\\/g, '/')
  const caseInsensitive = document.documentElement.dataset.platform === 'win32'
  const comparableRoot = caseInsensitive ? root.toLocaleLowerCase() : root
  const comparableCandidate = caseInsensitive ? candidate.toLocaleLowerCase() : candidate
  const prefix = `${comparableRoot}/`
  if (!comparableCandidate.startsWith(prefix)) return null
  const relativePath = candidate.slice(root.length + 1)
  return relativePath && !relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    ? relativePath
    : null
}

function workspacePathsEqual(left: string, right: string) {
  return document.documentElement.dataset.platform === 'win32'
    ? left.toLocaleLowerCase() === right.toLocaleLowerCase()
    : left === right
}

function revealEditorPosition(view: EditorView, requestedLine: number, requestedColumn: number) {
  const lineNumber = Math.min(view.state.doc.lines, Math.max(1, Math.floor(requestedLine)))
  const line = view.state.doc.line(lineNumber)
  const columnOffset = Math.min(line.length, Math.max(0, Math.floor(requestedColumn) - 1))
  const anchor = line.from + columnOffset
  view.dispatch({ selection: { anchor }, scrollIntoView: true })
  view.focus()
}

function insertImagePath(view: EditorView, imagePath: string) {
  const range = view.state.selection.main
  const selected = view.state.sliceDoc(range.from, range.to)
  let fallback = imagePath.split('/').pop() || 'image'
  try { fallback = decodeURIComponent(fallback) } catch { /* keep the encoded filename */ }
  fallback = fallback.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'image'
  const alt = selected || fallback
  const markdown = `![${alt}](${imagePath})`
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: markdown },
    selection: { anchor: range.from + 2, head: range.from + 2 + alt.length },
    scrollIntoView: true,
  })
  view.focus()
}

function insertImagePaths(view: EditorView, imagePaths: string[], requestedSelection: { from: number; to: number }) {
  const documentLength = view.state.doc.length
  const from = Math.min(documentLength, Math.max(0, requestedSelection.from))
  const to = Math.min(documentLength, Math.max(from, requestedSelection.to))
  const markdown = imagePaths.map((imagePath) => {
    let filename = imagePath.split('/').at(-1) || 'image'
    try { filename = decodeURIComponent(filename) } catch { /* keep encoded name */ }
    const alt = filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/[\[\]\\]/g, '').trim() || 'image'
    return `![${alt}](${imagePath})`
  }).join('\n')
  const before = from > 0 ? view.state.sliceDoc(from - 1, from) : ''
  const after = to < documentLength ? view.state.sliceDoc(to, to + 1) : ''
  const insertion = `${before && before !== '\n' ? '\n' : ''}${markdown}${after && after !== '\n' ? '\n' : ''}`
  view.dispatch({
    changes: { from, to, insert: insertion },
    selection: { anchor: from + insertion.length },
    scrollIntoView: true,
  })
  view.focus()
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
  const toggleWrap = (before: string, after: string, placeholder: string) => {
    const beforeSelection = view.state.sliceDoc(Math.max(0, range.from - before.length), range.from)
    const afterSelection = view.state.sliceDoc(range.to, Math.min(view.state.doc.length, range.to + after.length))
    if (selected && selected.startsWith(before) && selected.endsWith(after) && selected.length >= before.length + after.length) {
      const body = selected.slice(before.length, selected.length - after.length)
      replace(body, 0, body.length)
      return
    }
    if (beforeSelection === before && afterSelection === after) {
      view.dispatch({
        changes: [
          { from: range.to, to: range.to + after.length, insert: '' },
          { from: range.from - before.length, to: range.from, insert: '' },
        ],
        selection: { anchor: range.from - before.length, head: range.to - before.length },
        scrollIntoView: true,
      })
      view.focus()
      return
    }
    wrap(before, after, placeholder)
  }
  const prefixLines = (prefix: string, cleanupMatcher?: RegExp, toggleMatcher = cleanupMatcher) => {
    const startLine = view.state.doc.lineAt(range.from)
    const rawEndLine = view.state.doc.lineAt(range.to)
    const endPosition = range.to > range.from && range.to === rawEndLine.from ? range.to - 1 : range.to
    const endLine = view.state.doc.lineAt(endPosition)
    const text = view.state.sliceDoc(startLine.from, endLine.to)
    const lines = text.split('\n')
    const contentLines = lines.map((line) => line.slice((line.match(/^[\t ]*/) || [''])[0].length))
    const nonBlankLines = contentLines.filter((line) => line.trim())
    const matchesAll = Boolean(toggleMatcher) && nonBlankLines.length > 0 && nonBlankLines.every((line) => toggleMatcher!.test(line))
    let transformedLine = 0
    const replaced = lines.map((line, index) => {
      const indentation = (line.match(/^[\t ]*/) || [''])[0]
      const content = line.slice(indentation.length)
      if (!content.trim()) return line
      if (matchesAll && toggleMatcher) return `${indentation}${content.replace(toggleMatcher, '')}`
      const clean = cleanupMatcher ? content.replace(cleanupMatcher, '') : content
      transformedLine += 1
      return `${indentation}${prefix.replace('{n}', String(transformedLine))}${clean}`
    }).join('\n')
    view.dispatch({ changes: { from: startLine.from, to: endLine.to, insert: replaced }, selection: { anchor: startLine.from, head: startLine.from + replaced.length } })
    view.focus()
  }

  switch (action) {
    case 'bold': toggleWrap('**', '**', 'bold text'); break
    case 'italic': toggleWrap('*', '*', 'italic text'); break
    case 'strike': toggleWrap('~~', '~~', 'struck text'); break
    case 'heading1': prefixLines('# ', /^#{1,6}\s+/, /^#\s+/); break
    case 'heading2': prefixLines('## ', /^#{1,6}\s+/, /^##\s+/); break
    case 'heading3': prefixLines('### ', /^#{1,6}\s+/, /^###\s+/); break
    case 'link': {
      const label = selected || 'link text'
      replace(`[${label}](https://example.com)`, 1, 1 + label.length)
      break
    }
    case 'image': replace(`![${selected || 'image description'}](image.png)`, 2, 2 + (selected || 'image description').length); break
    case 'code': toggleWrap('`', '`', 'code'); break
    case 'codeblock': toggleWrap('```\n', '\n```', 'code'); break
    case 'quote': prefixLines('> ', /^>\s?/); break
    case 'list': prefixLines('- ', /^(?:[-+*]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/, /^[-+*]\s+(?!\[[ xX]\]\s*)/); break
    case 'ordered': prefixLines('{n}. ', /^(?:[-+*]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/, /^\d+[.)]\s+/); break
    case 'task': prefixLines('- [ ] ', /^(?:[-+*]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/, /^[-+*]\s+\[[ xX]\]\s*/); break
    case 'table': {
      const plan = formatMarkdownTableAt(view.state.doc.toString(), range.head)
      if (plan) {
        if (plan.changed) view.dispatch({ changes: plan.change, selection: plan.selection, scrollIntoView: true })
        view.focus()
      } else {
        replace('| Column 1 | Column 2 |\n| --- | --- |\n| Value | Value |', 2, 10)
      }
      break
    }
    case 'math': toggleWrap('$', '$', 'E = mc^2'); break
    case 'mermaid': replace('```mermaid\nflowchart LR\n  A[Start] --> B[Finish]\n```', 28, 33); break
  }
}
