export type DocumentMode = 'read' | 'edit'
export type SaveState = 'saved' | 'edited' | 'saving' | 'conflict' | 'error'
export type UiTheme = 'system' | 'light' | 'dark'
export type ReaderTheme = 'paper' | 'snow' | 'sepia' | 'midnight' | 'custom'
export type ReaderFont = 'serif' | 'sans' | 'mono'

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
  cursorLine: number
  cursorColumn: number
}

export interface OutlineItem {
  id: string
  text: string
  level: number
  line: number
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

export interface MarginApi {
  openDocuments: () => Promise<OpenDocumentsResult>
  saveDocument: (request: SaveRequest) => Promise<SaveResult>
  readDocument: (filePath: string) => Promise<OpenedDocument>
  openLinkedDocument: (documentPath: string, href: string) => Promise<OpenDocumentsResult>
  statDocument: (filePath: string) => Promise<DocumentStat | null>
  readAsset: (documentPath: string, assetPath: string) => Promise<string | null>
  exportHtml: (request: { html: string; suggestedName: string }) => Promise<ExportResult>
  exportPdf: (request: { html: string; suggestedName: string }) => Promise<ExportResult>
  confirmClose: (name: string) => Promise<'save' | 'discard' | 'cancel'>
  loadSession: () => Promise<DocumentTab[]>
  saveSession: (tabs: DocumentTab[]) => Promise<void>
  clearSession: () => Promise<void>
  setDirty: (isDirty: boolean) => void
  closeWindow: () => void
  cancelWindowClose: () => void
  showItemInFolder: (filePath: string) => Promise<void>
  openExternal: (url: string) => Promise<void>
  startFind: (text: string, options?: { forward?: boolean; findNext?: boolean }) => Promise<number | null>
  stopFind: (action?: 'clearSelection' | 'keepSelection' | 'activateSelection') => void
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
