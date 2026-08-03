const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('margin', {
  openDocuments: () => ipcRenderer.invoke('documents:open'),
  saveDocument: (request) => ipcRenderer.invoke('documents:save', request),
  readDocument: (filePath) => ipcRenderer.invoke('documents:read', filePath),
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
  showItemInFolder: (filePath) => ipcRenderer.invoke('shell:show-item', filePath),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  startFind: (text, options) => ipcRenderer.invoke('find:start', text, options),
  stopFind: (action) => ipcRenderer.send('find:stop', action),
  onCommand: (callback) => {
    const listener = (_event, command, payload) => callback(command, payload)
    ipcRenderer.on('app-command', listener)
    return () => ipcRenderer.removeListener('app-command', listener)
  },
})
