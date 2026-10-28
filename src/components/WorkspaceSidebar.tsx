import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  BookOpenText,
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  LoaderCircle,
  RefreshCw,
  Search,
  WholeWord,
  X,
} from 'lucide-react'
import type {
  DocumentTab,
  OutlineItem,
  WorkspaceBuffer,
  WorkspaceDescriptor,
  WorkspaceDirectoryResult,
  WorkspaceSearchMatch,
  WorkspaceSearchResult,
} from '../types'

export type SidebarView = 'files' | 'search' | 'outline'

interface WorkspaceSidebarProps {
  workspace: WorkspaceDescriptor | null
  tabs: DocumentTab[]
  activeId: string | null
  outline: OutlineItem[]
  view: SidebarView
  refreshToken: number
  searchBuffers: WorkspaceBuffer[]
  searchExcludedPaths: string[]
  onView: (view: SidebarView) => void
  onOpenWorkspace: () => void
  onCloseWorkspace: () => void
  onRefresh: () => void
  onOpenFile: (relativePath: string) => void
  onOpenMatch: (match: WorkspaceSearchMatch) => void
  onSelectTab: (id: string) => void
  onHeading: (item: OutlineItem) => void
}

type DirectoryState =
  | { status: 'loading' }
  | { status: 'loaded'; result: WorkspaceDirectoryResult }
  | { status: 'error'; message: string }

type SearchState =
  | { status: 'idle' }
  | { status: 'waiting' }
  | { status: 'searching' }
  | { status: 'done'; result: WorkspaceSearchResult }
  | { status: 'error'; message: string }

const SEARCH_DELAY_MS = 260
const MIN_SEARCH_LENGTH = 2

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function parentDirectory(relativePath: string) {
  const separator = relativePath.lastIndexOf('/')
  return separator < 0 ? '' : relativePath.slice(0, separator)
}

function HighlightedExcerpt({ match }: { match: WorkspaceSearchMatch }) {
  const start = Math.max(0, Math.min(match.excerpt.length, match.matchStart))
  const end = Math.max(start, Math.min(match.excerpt.length, start + match.matchLength))

  if (end === start) return <>{match.excerpt}</>
  return <>{match.excerpt.slice(0, start)}<mark>{match.excerpt.slice(start, end)}</mark>{match.excerpt.slice(end)}</>
}

export function WorkspaceSidebar({
  workspace,
  tabs,
  activeId,
  outline,
  view,
  refreshToken,
  searchBuffers,
  searchExcludedPaths,
  onView,
  onOpenWorkspace,
  onCloseWorkspace,
  onRefresh,
  onOpenFile,
  onOpenMatch,
  onSelectTab,
  onHeading,
}: WorkspaceSidebarProps) {
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [searchState, setSearchState] = useState<SearchState>({ status: 'idle' })
  const directoryEpochRef = useRef(0)
  const inFlightDirectoriesRef = useRef(new Map<string, number>())
  const searchSequenceRef = useRef(0)
  const treeRef = useRef<HTMLUListElement>(null)

  const loadDirectory = useCallback(async (relativeDirectory: string, epoch = directoryEpochRef.current) => {
    if (!workspace || inFlightDirectoriesRef.current.get(relativeDirectory) === epoch) return

    inFlightDirectoriesRef.current.set(relativeDirectory, epoch)
    setDirectories((current) => ({ ...current, [relativeDirectory]: { status: 'loading' } }))
    try {
      const result = await window.margin.listWorkspaceDirectory(relativeDirectory)
      if (directoryEpochRef.current !== epoch || result.workspaceId !== workspace.id) return
      setDirectories((current) => ({ ...current, [relativeDirectory]: { status: 'loaded', result } }))
    } catch (error) {
      if (directoryEpochRef.current !== epoch) return
      setDirectories((current) => ({
        ...current,
        [relativeDirectory]: { status: 'error', message: errorMessage(error, 'This folder could not be read.') },
      }))
    } finally {
      if (inFlightDirectoriesRef.current.get(relativeDirectory) === epoch) {
        inFlightDirectoriesRef.current.delete(relativeDirectory)
      }
    }
  }, [workspace?.id])

  useEffect(() => {
    directoryEpochRef.current += 1
    const epoch = directoryEpochRef.current
    inFlightDirectoriesRef.current.clear()
    setDirectories({})
    setExpanded(new Set())
    if (workspace) void loadDirectory('', epoch)
  }, [workspace?.id, refreshToken, loadDirectory])

  useEffect(() => {
    searchSequenceRef.current += 1
    const sequence = searchSequenceRef.current
    window.margin.cancelWorkspaceSearch()

    const normalizedQuery = query.trim()
    if (view !== 'search' || !workspace || normalizedQuery.length < MIN_SEARCH_LENGTH) {
      setSearchState({ status: 'idle' })
      return
    }

    setSearchState({ status: 'waiting' })
    const timer = window.setTimeout(() => {
      if (searchSequenceRef.current !== sequence) return
      setSearchState({ status: 'searching' })
      void window.margin.searchWorkspace({
        query: normalizedQuery,
        caseSensitive,
        wholeWord,
        buffers: searchBuffers,
        excludedPaths: searchExcludedPaths,
      }).then((result) => {
        if (searchSequenceRef.current !== sequence || result.workspaceId !== workspace.id || result.cancelled) return
        setSearchState({ status: 'done', result })
      }).catch((error) => {
        if (searchSequenceRef.current !== sequence) return
        setSearchState({ status: 'error', message: errorMessage(error, 'The workspace could not be searched.') })
      })
    }, SEARCH_DELAY_MS)

    return () => {
      window.clearTimeout(timer)
      window.margin.cancelWorkspaceSearch()
    }
  }, [caseSensitive, query, searchBuffers, searchExcludedPaths.join('\0'), view, wholeWord, workspace?.id])

  const toggleDirectory = useCallback((relativePath: string) => {
    const opening = !expanded.has(relativePath)
    if (opening && (!directories[relativePath] || directories[relativePath].status === 'error')) {
      void loadDirectory(relativePath)
    }
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(relativePath)) next.delete(relativePath)
      else next.add(relativePath)
      return next
    })
  }, [directories, expanded, loadDirectory])

  const focusRelativeTreeItem = (current: HTMLButtonElement, direction: -1 | 1 | 'first' | 'last') => {
    const items = Array.from(treeRef.current?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]') || [])
      .filter((item) => item.offsetParent !== null)
    const index = items.indexOf(current)
    const target = direction === 'first'
      ? items[0]
      : direction === 'last'
        ? items.at(-1)
        : items[index + direction]
    target?.focus()
  }

  const handleTreeKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, relativePath: string, isDirectory: boolean) => {
    const current = event.currentTarget
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusRelativeTreeItem(current, 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusRelativeTreeItem(current, -1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusRelativeTreeItem(current, 'first')
    } else if (event.key === 'End') {
      event.preventDefault()
      focusRelativeTreeItem(current, 'last')
    } else if (isDirectory && event.key === 'ArrowRight') {
      event.preventDefault()
      if (!expanded.has(relativePath)) toggleDirectory(relativePath)
      else {
        const child = current.parentElement?.querySelector<HTMLButtonElement>('[role="group"] [role="treeitem"]')
        child?.focus()
      }
    } else if (event.key === 'ArrowLeft') {
      if (isDirectory && expanded.has(relativePath)) {
        event.preventDefault()
        toggleDirectory(relativePath)
      } else {
        const parent = parentDirectory(relativePath)
        const parentItem = treeRef.current?.querySelector<HTMLButtonElement>(`[role="treeitem"][data-workspace-path="${CSS.escape(parent)}"]`)
        if (parentItem) {
          event.preventDefault()
          parentItem.focus()
        }
      }
    }
  }

  const handleViewKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, currentView: SidebarView) => {
    const views: SidebarView[] = ['files', 'search', 'outline']
    const currentIndex = views.indexOf(currentView)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? views.length - 1
        : event.key === 'ArrowRight'
          ? (currentIndex + 1) % views.length
          : event.key === 'ArrowLeft'
            ? (currentIndex - 1 + views.length) % views.length
            : -1
    if (nextIndex < 0) return
    event.preventDefault()
    const nextView = views[nextIndex]
    onView(nextView)
    window.requestAnimationFrame(() => document.getElementById(`workspace-sidebar-tab-${nextView}`)?.focus())
  }

  const renderDirectory = (relativeDirectory: string, level: number): React.ReactNode => {
    const state = directories[relativeDirectory]
    if (!state || state.status === 'loading') {
      return <li className="workspace-tree-message" role="none"><LoaderCircle className="is-spinning" /> Loading…</li>
    }
    if (state.status === 'error') {
      return (
        <li className="workspace-tree-message is-error" role="none">
          <AlertTriangle />
          <span>{state.message}</span>
          <button type="button" onClick={() => void loadDirectory(relativeDirectory)}>Retry</button>
        </li>
      )
    }

    const entries = [...state.result.entries].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
    })

    return (
      <>
        {entries.map((entry) => {
          const isDirectory = entry.kind === 'directory'
          const isExpanded = isDirectory && expanded.has(entry.relativePath)
          return (
            <li key={entry.relativePath} role="none">
              <button
                type="button"
                role="treeitem"
                aria-level={level}
                aria-expanded={isDirectory ? isExpanded : undefined}
                className="workspace-tree-item"
                data-workspace-path={entry.relativePath}
                style={{ '--tree-depth': level } as React.CSSProperties}
                title={entry.relativePath}
                onClick={() => isDirectory ? toggleDirectory(entry.relativePath) : onOpenFile(entry.relativePath)}
                onKeyDown={(event) => handleTreeKeyDown(event, entry.relativePath, isDirectory)}
              >
                <span className="workspace-tree-chevron" aria-hidden="true">
                  {isDirectory ? (isExpanded ? <ChevronDown /> : <ChevronRight />) : null}
                </span>
                {isDirectory ? (isExpanded ? <FolderOpen /> : <Folder />) : <FileText />}
                <span>{entry.name}</span>
              </button>
              {isExpanded && (
                <ul role="group" className="workspace-tree-group">
                  {renderDirectory(entry.relativePath, level + 1)}
                </ul>
              )}
            </li>
          )
        })}
        {entries.length === 0 && <li className="workspace-tree-message" role="none">Empty folder</li>}
        {state.result.truncated && (
          <li className="workspace-tree-message is-warning" role="none"><AlertTriangle /> Some items are not shown.</li>
        )}
      </>
    )
  }

  const searchMatches = searchState.status === 'done' ? searchState.result.matches : []
  const searchSummary = useMemo(() => {
    if (searchState.status !== 'done') return ''
    const { matches, scannedFiles, skippedFiles, truncated } = searchState.result
    const parts = [`${matches.length} ${matches.length === 1 ? 'match' : 'matches'} in ${scannedFiles} ${scannedFiles === 1 ? 'file' : 'files'}`]
    if (skippedFiles > 0) parts.push(`${skippedFiles} skipped`)
    if (truncated) parts.push('results limited')
    return parts.join(' · ')
  }, [searchState])

  const selectedTabId = `workspace-sidebar-tab-${view}`
  const panelId = `workspace-sidebar-panel-${view}`

  return (
    <aside className="workspace-sidebar" aria-label="Workspace sidebar">
      <header className="workspace-sidebar-header">
        <div className="workspace-sidebar-title" title={workspace?.rootPath}>
          {workspace ? <FolderOpen /> : <Folder />}
          <span>
            <strong>{workspace?.name || 'No folder open'}</strong>
            <small>{workspace?.rootPath || 'Open a folder to browse and search Markdown files.'}</small>
          </span>
        </div>
        <div className="workspace-sidebar-actions">
          {workspace ? (
            <>
              <button type="button" title="Refresh workspace" aria-label="Refresh workspace" onClick={onRefresh}>
                <RefreshCw className={directories['']?.status === 'loading' ? 'is-spinning' : ''} />
              </button>
              <button type="button" title="Close workspace" aria-label="Close workspace" onClick={onCloseWorkspace}><X /></button>
            </>
          ) : (
            <button type="button" title="Open folder" aria-label="Open folder" onClick={onOpenWorkspace}><FolderPlus /></button>
          )}
        </div>
      </header>

      <div className="workspace-sidebar-tabs" role="tablist" aria-label="Sidebar views">
        <button type="button" role="tab" id="workspace-sidebar-tab-files" aria-controls="workspace-sidebar-panel-files" aria-selected={view === 'files'} tabIndex={view === 'files' ? 0 : -1} className={view === 'files' ? 'is-active' : ''} onClick={() => onView('files')} onKeyDown={(event) => handleViewKeyDown(event, 'files')}><Folder /><span>Files</span></button>
        <button type="button" role="tab" id="workspace-sidebar-tab-search" aria-controls="workspace-sidebar-panel-search" aria-selected={view === 'search'} tabIndex={view === 'search' ? 0 : -1} className={view === 'search' ? 'is-active' : ''} onClick={() => onView('search')} onKeyDown={(event) => handleViewKeyDown(event, 'search')}><Search /><span>Search</span></button>
        <button type="button" role="tab" id="workspace-sidebar-tab-outline" aria-controls="workspace-sidebar-panel-outline" aria-selected={view === 'outline'} tabIndex={view === 'outline' ? 0 : -1} className={view === 'outline' ? 'is-active' : ''} onClick={() => onView('outline')} onKeyDown={(event) => handleViewKeyDown(event, 'outline')}><BookOpenText /><span>Outline</span></button>
      </div>

      <div className="workspace-sidebar-content" role="tabpanel" id={panelId} aria-labelledby={selectedTabId}>
        {view === 'files' && (
          <>
            <section className="workspace-sidebar-section">
              <h2>Open documents <span>{tabs.length}</span></h2>
              {tabs.length === 0 ? <p className="workspace-sidebar-empty">No open documents</p> : (
                <div className="workspace-open-documents">
                  {tabs.map((tab) => (
                    <button type="button" key={tab.id} className={tab.id === activeId ? 'is-active' : ''} title={tab.path || tab.name} onClick={() => onSelectTab(tab.id)}>
                      <FileText />
                      <span>{tab.name}</span>
                      {tab.content !== tab.savedContent && <i aria-label="Unsaved changes" title="Unsaved changes" />}
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="workspace-sidebar-section workspace-files-section">
              <h2>Workspace</h2>
              {workspace ? (
                <ul className="workspace-tree" role="tree" aria-label={`${workspace.name} files`} ref={treeRef}>
                  {renderDirectory('', 1)}
                </ul>
              ) : (
                <div className="workspace-sidebar-callout">
                  <FolderPlus />
                  <p>Browse a folder without importing or uploading anything.</p>
                  <button type="button" onClick={onOpenWorkspace}>Open folder</button>
                </div>
              )}
            </section>
          </>
        )}

        {view === 'search' && (
          <section className="workspace-search-section">
            {workspace ? (
              <>
                <div className="workspace-search-box">
                  <Search />
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search workspace"
                    aria-label="Search workspace"
                    autoFocus
                  />
                  {query && <button type="button" aria-label="Clear search" title="Clear search" onClick={() => setQuery('')}><X /></button>}
                </div>
                <div className="workspace-search-options" aria-label="Search options">
                  <button type="button" aria-pressed={caseSensitive} className={caseSensitive ? 'is-active' : ''} title="Match case" onClick={() => setCaseSensitive((value) => !value)}><CaseSensitive /><span>Match case</span></button>
                  <button type="button" aria-pressed={wholeWord} className={wholeWord ? 'is-active' : ''} title="Match whole word" onClick={() => setWholeWord((value) => !value)}><WholeWord /><span>Whole word</span></button>
                </div>

                <div className="workspace-search-status" aria-live="polite">
                  {query.trim().length < MIN_SEARCH_LENGTH && 'Type at least 2 characters to search.'}
                  {(searchState.status === 'waiting' || searchState.status === 'searching') && <><LoaderCircle className="is-spinning" /> Searching…</>}
                  {searchState.status === 'done' && searchSummary}
                  {searchState.status === 'error' && <span className="is-error"><AlertTriangle /> {searchState.message}</span>}
                </div>

                {searchState.status === 'done' && searchMatches.length === 0 ? (
                  <p className="workspace-sidebar-empty workspace-search-empty">No matches found.</p>
                ) : (
                  <div className="workspace-search-results" aria-label="Workspace search results">
                    {searchMatches.map((match, index) => (
                      <button type="button" key={`${match.relativePath}:${match.line}:${match.column}:${index}`} onClick={() => onOpenMatch(match)}>
                        <span className="workspace-search-result-heading">
                          <FileText />
                          <strong>{match.relativePath}</strong>
                          <small>Ln {match.line}, Col {match.column}</small>
                        </span>
                        <span className="workspace-search-excerpt"><HighlightedExcerpt match={match} /></span>
                        {match.source === 'buffer' && <span className="workspace-search-buffer">Open buffer</span>}
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="workspace-sidebar-callout is-centered">
                <Search />
                <p>Open a folder to search all of its Markdown files.</p>
                <button type="button" onClick={onOpenWorkspace}>Open folder</button>
              </div>
            )}
          </section>
        )}

        {view === 'outline' && (
          <section className="workspace-outline-section">
            {outline.length === 0 ? <p className="workspace-sidebar-empty">Headings in the active document will appear here.</p> : (
              <nav aria-label="Document outline">
                {outline.map((item) => (
                  <button
                    type="button"
                    key={`${item.id}-${item.line}`}
                    style={{ '--heading-depth': item.level } as React.CSSProperties}
                    title={`Line ${item.line}`}
                    onClick={() => onHeading(item)}
                  >
                    <span>{item.text}</span>
                    <small>{item.line}</small>
                  </button>
                ))}
              </nav>
            )}
          </section>
        )}
      </div>
    </aside>
  )
}
