import type { MarginApi } from '../types'
import { restoreSession } from './document'

/** Keeps the Vite renderer preview usable outside Electron for visual testing. */
export function installBrowserPreviewApi() {
  if (window.margin) return
  const browserWindow = window as Window & { find?: (text: string) => boolean }
  const api: MarginApi = {
    getAgentConfiguration: async () => ({ enabled: false, model: '' }),
    setAgentConfiguration: async () => { throw new Error('The Agent desk requires the desktop app and a local Ollama model.') },
    checkAgentConnection: async () => { throw new Error('Local model access is available only in the desktop app.') },
    attachAgentNotes: async () => [],
    detachAgentNote: () => {},
    runAgentTask: async () => { throw new Error('Local model access is available only in the desktop app.') },
    cancelAgentTask: () => {},
    onAgentEvent: () => () => {},
    prepareAgentApply: async () => { throw new Error('The desktop app is required to approve changes.') },
    getAgentRestore: async () => { throw new Error('The desktop app is required to restore changes.') },
    listAgentCheckpoints: async () => [],
    openDocuments: async () => ({ documents: [], errors: [] }),
    saveDocument: async () => ({ status: 'cancelled' }),
    readDocument: async () => { throw new Error('Local files are available in the desktop app.') },
    reopenDocument: async () => ({ documents: [], errors: [{ path: '', message: 'Local files are available in the desktop app.' }] }),
    openLinkedDocument: async () => ({ documents: [], errors: [{ path: '', message: 'Linked files are available in the desktop app.' }] }),
    statDocument: async () => null,
    readAsset: async () => null,
    importImage: async () => ({ status: 'cancelled' }),
    importImageData: async () => { throw new Error('Image paste and drop are available in the desktop app.') },
    openWorkspace: async () => null,
    loadWorkspace: async () => null,
    closeWorkspace: async () => ({ closed: true }),
    listWorkspaceDirectory: async (directory) => ({ workspaceId: '', directory, entries: [], truncated: false }),
    listWorkspaceDocuments: async () => ({ workspaceId: '', documents: [], scannedFiles: 0, truncated: false }),
    readWorkspaceNotes: async () => ({ workspaceId: '', documents: [], skippedFiles: 0, truncated: false }),
    openWorkspaceDocument: async () => ({ documents: [], errors: [{ path: '', message: 'Folders are available in the desktop app.' }] }),
    createWorkspaceDocument: async () => ({ documents: [], errors: [{ path: '', message: 'Folders are available in the desktop app.' }] }),
    searchWorkspace: async () => ({ workspaceId: '', matches: [], scannedFiles: 0, skippedFiles: 0, truncated: false }),
    cancelWorkspaceSearch: () => {},
    exportHtml: async () => ({ status: 'cancelled' }),
    exportPdf: async () => ({ status: 'cancelled' }),
    confirmClose: async () => 'discard',
    loadSession: async () => ({ tabs: restoreSession() }),
    saveSession: async (tabs) => { window.localStorage.setItem('margin:session', JSON.stringify(tabs)) },
    clearSession: async () => { localStorage.removeItem('margin:session') },
    setDirty: () => {},
    closeWindow: () => {},
    cancelWindowClose: () => {},
    showItemInFolder: async () => {},
    openExternal: async () => {},
    startFind: async (text) => text && browserWindow.find?.(text) ? 1 : null,
    stopFind: () => window.getSelection()?.removeAllRanges(),
    copyText: async (text) => {
      if (!navigator.clipboard) return false
      await navigator.clipboard.writeText(text)
      return true
    },
    setOpenDocumentPaths: () => {},
    setViewOptions: () => {},
    onOpenDocuments: () => () => {},
    readyForOpenDocuments: () => {},
    readyForSafeClose: () => {},
    onCommand: () => () => {},
  }
  window.margin = api
}
