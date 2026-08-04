const { contextBridge, ipcRenderer } = require('electron')

const pendingOpenResults = []
let openDocumentsCallback = null

function deliverOpenResult(result) {
  openDocumentsCallback(result)
  if (Number.isSafeInteger(result?.deliveryId)) ipcRenderer.send('external-open:ack', result.deliveryId)
}

ipcRenderer.on('external-open:documents', (_event, result) => {
  if (openDocumentsCallback) deliverOpenResult(result)
  else pendingOpenResults.push(result)
})

contextBridge.exposeInMainWorld('margin', {
  openDocuments: () => ipcRenderer.invoke('documents:open'),
  saveDocument: (request) => ipcRenderer.invoke('documents:save', request),
  readDocument: (filePath) => ipcRenderer.invoke('documents:read', filePath),
  openLinkedDocument: (documentPath, href) => ipcRenderer.invoke('documents:open-link', documentPath, href),
  statDocument: (filePath) => ipcRenderer.invoke('documents:stat', filePath),
  readAsset: (documentPath, assetPath) => ipcRenderer.invoke('assets:read', documentPath, assetPath),
  exportHtml: (request) => ipcRenderer.invoke('export:html', request),
  exportPdf: (request) => ipcRenderer.invoke('export:pdf', request),
  confirmClose: (name) => ipcRenderer.invoke('dialog:confirm-close', name),
  loadSession: () => ipcRenderer.invoke('session:load'),
  saveSession: (tabs) => ipcRenderer.invoke('session:save', tabs),
  clearSession: () => ipcRenderer.invoke('session:clear'),
  setDirty: (isDirty) => ipcRenderer.send('app:set-dirty', isDirty),
  closeWindow: () => ipcRenderer.send('app:close-window'),
  cancelWindowClose: () => ipcRenderer.send('app:cancel-close'),
  showItemInFolder: (filePath) => ipcRenderer.invoke('shell:show-item', filePath),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  startFind: (text, options) => ipcRenderer.invoke('find:start', text, options),
  stopFind: (action) => ipcRenderer.send('find:stop', action),
  onOpenDocuments: (callback) => {
    openDocumentsCallback = callback
    while (pendingOpenResults.length) deliverOpenResult(pendingOpenResults.shift())
    return () => {
      if (openDocumentsCallback === callback) openDocumentsCallback = null
    }
  },
  readyForOpenDocuments: () => ipcRenderer.send('external-open:ready'),
  readyForSafeClose: () => ipcRenderer.send('app:close-safety-ready'),
  onCommand: (callback) => {
    const listener = (_event, command, payload) => callback(command, payload)
    ipcRenderer.on('app-command', listener)
    return () => ipcRenderer.removeListener('app-command', listener)
  },
})
