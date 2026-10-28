import type { AgentApi } from './agentTypes'

export type DocumentMode = 'read' | 'live' | 'edit' | 'split'
export type SaveState = 'saved' | 'edited' | 'saving' | 'conflict' | 'error'
export type UiTheme = 'system' | 'light' | 'dark'
export type ReaderTheme = 'paper' | 'snow' | 'sepia' | 'midnight' | 'custom'
export type ReaderFont = 'serif' | 'sans' | 'mono'
export type EditorFont = 'mono' | 'sans'

export interface OpenedDocument {
  path: string
  name: string
  content: string
  mtimeMs: number
  lineEnding: 'lf' | 'crlf'
  bom: boolean
}

export interface DocumentOpenError {
  path: string
  message: string
}

export interface OpenDocumentsResult {
  documents: OpenedDocument[]
  errors: DocumentOpenError[]
  deliveryId?: number
}

export interface DocumentStat {
  exists: boolean
  mtimeMs: number | null
  writable: boolean
}

export interface DocumentTab {
  id: string
  path: string | null
  name: string
  content: string
  savedContent: string
  mtimeMs: number | null
  lineEnding: 'lf' | 'crlf'
  bom: boolean
  mode: DocumentMode
  saveState: SaveState
  revision: number
  cursorLine: number
  cursorColumn: number
  selectionAnchor: number
  selectionHead: number
  editorScrollTop: number
  editorScrollLeft: number
  readerScrollTop: number
}

export interface OutlineItem {
  id: string
  text: string
  level: number
  line: number
}

export interface WorkspaceDescriptor {
  id: string
  rootPath: string
  name: string
}

export interface WorkspaceEntry {
  name: string
  relativePath: string
  kind: 'directory' | 'document'
}

export interface WorkspaceDirectoryResult {
  workspaceId: string
  directory: string
  entries: WorkspaceEntry[]
  truncated: boolean
}

export interface WorkspaceDocumentsResult {
  workspaceId: string
  documents: WorkspaceEntry[]
  scannedFiles: number
  truncated: boolean
}

export interface WorkspaceBuffer {
  relativePath: string
  content: string
}

export interface NoteSource {
  relativePath: string
  content: string
}

export interface WorkspaceNotesResult {
  workspaceId: string
  documents: NoteSource[]
  skippedFiles: number
  truncated: boolean
}

export interface WorkspaceSearchRequest {
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  buffers: WorkspaceBuffer[]
  excludedPaths: string[]
}

export interface WorkspaceSearchMatch {
  relativePath: string
  name: string
  line: number
  column: number
  excerpt: string
  matchStart: number
  matchLength: number
  source: 'disk' | 'buffer'
}

export interface WorkspaceSearchResult {
  workspaceId: string
  matches: WorkspaceSearchMatch[]
  scannedFiles: number
  skippedFiles: number
  truncated: boolean
  cancelled?: boolean
}

export interface AppSettings {
  uiTheme: UiTheme
  readerTheme: ReaderTheme
  readerFont: ReaderFont
  fontSize: number
  lineHeight: number
  contentWidth: number
  customBackground: string
  customText: string
  customAccent: string
  editorWordWrap: boolean
  editorLineNumbers: boolean
  editorSpellcheck: boolean
  editorShowWhitespace: boolean
  editorCodeFolding: boolean
  editorTypewriterMode: boolean
  editorFocus: 'off' | 'sentence' | 'paragraph'
  editorFont: EditorFont
  editorFontSize: number
  editorLineHeight: number
  editorContentWidth: number
  editorTabSize: number
  editorIndentWithTabs: boolean
  autosave: boolean
  autosaveDelay: number
  outlineOpen: boolean
}

export interface SaveRequest {
  path: string | null
  name: string
  content: string
  expectedMtime: number | null
  lineEnding: 'lf' | 'crlf'
  bom: boolean
  saveAs?: boolean
  silent?: boolean
}

export type SaveResult =
  | { status: 'saved'; path: string; name: string; mtimeMs: number }
  | { status: 'conflict'; mtimeMs: number }
  | { status: 'cancelled' }

export interface ExportResult {
  status: 'saved' | 'cancelled'
  path?: string
}

export interface ImageImportData {
  name: string
  mimeType: string
  data: ArrayBuffer
}

export interface RecoverySessionResult {
  tabs: DocumentTab[]
  warning?: string
}

export interface MarginApi extends AgentApi {
  openDocuments: () => Promise<OpenDocumentsResult>
  saveDocument: (request: SaveRequest) => Promise<SaveResult>
  readDocument: (filePath: string) => Promise<OpenedDocument>
  reopenDocument: (filePath: string) => Promise<OpenDocumentsResult>
  openLinkedDocument: (documentPath: string, href: string) => Promise<OpenDocumentsResult>
  statDocument: (filePath: string) => Promise<DocumentStat | null>
  readAsset: (documentPath: string, assetPath: string) => Promise<string | null>
  importImage: (documentPath: string) => Promise<{ status: 'imported'; relativePath: string } | { status: 'cancelled' }>
  importImageData: (documentPath: string, image: ImageImportData) => Promise<{ status: 'imported'; relativePath: string }>
  openWorkspace: () => Promise<WorkspaceDescriptor | null>
  loadWorkspace: () => Promise<WorkspaceDescriptor | null>
  closeWorkspace: () => Promise<{ closed: true; warning?: string }>
  listWorkspaceDirectory: (relativeDirectory: string) => Promise<WorkspaceDirectoryResult>
  listWorkspaceDocuments: () => Promise<WorkspaceDocumentsResult>
  readWorkspaceNotes: () => Promise<WorkspaceNotesResult>
  openWorkspaceDocument: (relativePath: string) => Promise<OpenDocumentsResult>
  createWorkspaceDocument: (relativePath: string) => Promise<OpenDocumentsResult>
  searchWorkspace: (request: WorkspaceSearchRequest) => Promise<WorkspaceSearchResult>
  cancelWorkspaceSearch: () => void
  exportHtml: (request: { html: string; suggestedName: string }) => Promise<ExportResult>
  exportPdf: (request: { html: string; suggestedName: string }) => Promise<ExportResult>
  confirmClose: (name: string) => Promise<'save' | 'discard' | 'cancel'>
  loadSession: () => Promise<RecoverySessionResult>
  saveSession: (tabs: DocumentTab[], generation?: number) => Promise<void>
  clearSession: () => Promise<void>
  setDirty: (isDirty: boolean) => void
  closeWindow: () => void
  cancelWindowClose: () => void
  showItemInFolder: (filePath: string) => Promise<void>
  openExternal: (url: string) => Promise<void>
  startFind: (text: string, options?: { forward?: boolean; findNext?: boolean }) => Promise<number | null>
  stopFind: (action?: 'clearSelection' | 'keepSelection' | 'activateSelection') => void
  copyText: (text: string) => Promise<boolean>
  setOpenDocumentPaths: (paths: string[]) => void
  setViewOptions: (options: { wordWrap: boolean; lineNumbers: boolean; typewriterMode: boolean; showWhitespace: boolean }) => void
  onOpenDocuments: (callback: (result: OpenDocumentsResult) => void) => () => void
  readyForOpenDocuments: () => void
  readyForSafeClose: () => void
  onCommand: (callback: (command: string, payload?: string) => void) => () => void
}

declare global {
  interface Window {
    margin: MarginApi
  }
}
