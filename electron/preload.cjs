const { contextBridge, ipcRenderer } = require('electron')

const pendingOpenResults = []
let openDocumentsCallback = null
const recoveryEpoch = globalThis.crypto.randomUUID()

ipcRenderer.send('session:epoch', recoveryEpoch)

function deliverOpenResult(result) {
  openDocumentsCallback(result)
  if (Number.isSafeInteger(result?.deliveryId)) ipcRenderer.send('external-open:ack', result.deliveryId)
}

ipcRenderer.on('external-open:documents', (_event, result) => {
  if (openDocumentsCallback) deliverOpenResult(result)
  else pendingOpenResults.push(result)
})

contextBridge.exposeInMainWorld('margin', {
  getAgentConfiguration: () => ipcRenderer.invoke('agent:configuration'),
  setAgentConfiguration: (configuration) => ipcRenderer.invoke('agent:configure', configuration),
  checkAgentConnection: () => ipcRenderer.invoke('agent:connection'),
  attachAgentNotes: () => ipcRenderer.invoke('agent:attach'),
  detachAgentNote: (id) => ipcRenderer.send('agent:detach', id),
  runAgentTask: (request) => ipcRenderer.invoke('agent:run', request),
  cancelAgentTask: (taskId) => ipcRenderer.send('agent:cancel', taskId),
  prepareAgentApply: (taskId, proposalId, current) => ipcRenderer.invoke('agent:prepare-apply', taskId, proposalId, current),
  getAgentRestore: (id, current) => ipcRenderer.invoke('agent:restore', id, current),
  listAgentCheckpoints: () => ipcRenderer.invoke('agent:checkpoints'),
  onAgentEvent: (callback) => {
    const listener = (_event, item) => callback(item)
    ipcRenderer.on('agent:event', listener)
    return () => ipcRenderer.removeListener('agent:event', listener)
  },
  openDocuments: () => ipcRenderer.invoke('documents:open'),
  saveDocument: (request) => ipcRenderer.invoke('documents:save', request),
  readDocument: (filePath) => ipcRenderer.invoke('documents:read', filePath),
  reopenDocument: (filePath) => ipcRenderer.invoke('documents:reopen', filePath),
  openLinkedDocument: (documentPath, href) => ipcRenderer.invoke('documents:open-link', documentPath, href),
  statDocument: (filePath) => ipcRenderer.invoke('documents:stat', filePath),
  readAsset: (documentPath, assetPath) => ipcRenderer.invoke('assets:read', documentPath, assetPath),
  importImage: (documentPath) => ipcRenderer.invoke('assets:import', documentPath),
  importImageData: (documentPath, image) => ipcRenderer.invoke('assets:import-data', documentPath, image),
  openWorkspace: () => ipcRenderer.invoke('workspace:open'),
  loadWorkspace: () => ipcRenderer.invoke('workspace:load'),
  closeWorkspace: () => ipcRenderer.invoke('workspace:close'),
  listWorkspaceDirectory: (relativeDirectory) => ipcRenderer.invoke('workspace:list-directory', relativeDirectory),
  listWorkspaceDocuments: () => ipcRenderer.invoke('workspace:list-documents'),
  readWorkspaceNotes: () => ipcRenderer.invoke('workspace:notes'),
  openWorkspaceDocument: (relativePath) => ipcRenderer.invoke('workspace:open-document', relativePath),
  createWorkspaceDocument: (relativePath) => ipcRenderer.invoke('workspace:create-document', relativePath),
  searchWorkspace: (request) => ipcRenderer.invoke('workspace:search', request),
  cancelWorkspaceSearch: () => ipcRenderer.send('workspace:cancel-search'),
  exportHtml: (request) => ipcRenderer.invoke('export:html', request),
  exportPdf: (request) => ipcRenderer.invoke('export:pdf', request),
  confirmClose: (name) => ipcRenderer.invoke('dialog:confirm-close', name),
  loadSession: () => ipcRenderer.invoke('session:load'),
  saveSession: (tabs, generation) => ipcRenderer.invoke('session:save', tabs, recoveryEpoch, generation),
  clearSession: () => ipcRenderer.invoke('session:clear'),
  setDirty: (isDirty) => ipcRenderer.send('app:set-dirty', isDirty),
  closeWindow: () => ipcRenderer.send('app:close-window'),
  cancelWindowClose: () => ipcRenderer.send('app:cancel-close'),
  showItemInFolder: (filePath) => ipcRenderer.invoke('shell:show-item', filePath),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  startFind: (text, options) => ipcRenderer.invoke('find:start', text, options),
  stopFind: (action) => ipcRenderer.send('find:stop', action),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  setOpenDocumentPaths: (paths) => ipcRenderer.send('documents:set-open-paths', paths),
  setViewOptions: (options) => ipcRenderer.send('app:set-view-options', options),
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
