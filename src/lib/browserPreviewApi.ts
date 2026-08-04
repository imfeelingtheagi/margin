import type { MarginApi } from '../types'
import { restoreSession } from './document'

/** Keeps the Vite renderer preview usable outside Electron for visual testing. */
export function installBrowserPreviewApi() {
  if (window.margin) return
  const browserWindow = window as Window & { find?: (text: string) => boolean }
  const api: MarginApi = {
    openDocuments: async () => ({ documents: [], errors: [] }),
    saveDocument: async () => ({ status: 'cancelled' }),
    readDocument: async () => { throw new Error('Local files are available in the desktop app.') },
    openLinkedDocument: async () => ({ documents: [], errors: [{ path: '', message: 'Linked files are available in the desktop app.' }] }),
    statDocument: async () => null,
    readAsset: async () => null,
    exportHtml: async () => ({ status: 'cancelled' }),
    exportPdf: async () => ({ status: 'cancelled' }),
    confirmClose: async () => 'discard',
    loadSession: async () => restoreSession(),
    saveSession: async (tabs) => { localStorage.setItem('margin:session', JSON.stringify(tabs)) },
    clearSession: async () => { localStorage.removeItem('margin:session') },
    setDirty: () => {},
    closeWindow: () => {},
    cancelWindowClose: () => {},
    showItemInFolder: async () => {},
    openExternal: async () => {},
    startFind: async (text) => text && browserWindow.find?.(text) ? 1 : null,
    stopFind: () => window.getSelection()?.removeAllRanges(),
    onOpenDocuments: () => () => {},
    readyForOpenDocuments: () => {},
    readyForSafeClose: () => {},
    onCommand: () => () => {},
  }
  window.margin = api
}
