const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } = require('electron')
const { constants: fsConstants } = require('node:fs')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { isAllowedAppRequest } = require('./network-policy.cjs')
const { createAgentHost } = require('./agent-host.cjs')
const { createOllamaClient } = require('./agent.cjs')
if (!app.isPackaged && process.env.NODE_ENV === 'test' && process.env.MARGIN_TEST_USER_DATA && path.isAbsolute(process.env.MARGIN_TEST_USER_DATA)) {
  app.setPath('userData', process.env.MARGIN_TEST_USER_DATA)
}
const {
  createExternalOpenCoordinator,
  extractExternalFilePaths,
  normalizeExternalFilePaths,
  readDocumentsSettled,
  resolveLinkedDocumentPath,
} = require('./external-open.cjs')
const {
  isPathInsideRoot,
  listWorkspaceDirectory,
  listWorkspaceDocuments,
  normalizeWorkspaceRelativePath,
  resolveWorkspaceEntry,
  resolveWorkspaceRoot,
  searchWorkspace,
  readWorkspaceNotes,
} = require('./workspace.cjs')

const isMac = process.platform === 'darwin'
const developmentIconPath = path.join(__dirname, '..', 'build', 'icon.png')
const devUrl = !app.isPackaged && process.env.VITE_DEV_SERVER_URL === 'http://127.0.0.1:5173'
  ? process.env.VITE_DEV_SERVER_URL
  : null
const allowedDocuments = new Set()
const dirtyWindows = new WeakMap()
const forceClosing = new WeakSet()
const rendererReadyWindows = new WeakSet()
const closeSafetyReadyWindows = new WeakSet()
const documentSaveQueues = new Map()
const internalWriteTimes = new Map()
const pendingExternalDeliveries = new Map()
const openDocumentPathsByContents = new WeakMap()
const saveTargetClaimsByContents = new WeakMap()
const workspaceByContents = new WeakMap()
const workspaceGenerationByContents = new WeakMap()
const workspaceDirectoryListingsByContents = new WeakMap()
const workspaceSearchByContents = new WeakMap()
const workspaceIndexByContents = new WeakMap()
const noteSnapshotsByContents = new WeakMap()
const recoveryStateByContents = new WeakMap()
const pendingCommandsByWindow = new WeakMap()
const temporaryRenderFilesByContentsId = new Map()
let recoveryQueue = Promise.resolve()
let workspaceStateQueue = Promise.resolve()
let rememberedStateQueue = Promise.resolve()
let rememberedPaths = null
let mainWindow = null
let bootstrapReady = false
let quitRequested = false
let nextExternalDeliveryId = 0

const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024
const MAX_ASSET_BYTES = 20 * 1024 * 1024
const MAX_OPEN_TABS = 100
const MAX_OPEN_CONTENT_BYTES = 200 * 1024 * 1024
const MAX_RECOVERY_CONTENT_BYTES = 50 * 1024 * 1024
const MAX_RECOVERY_FILE_BYTES = 64 * 1024 * 1024

const agentHost = createAgentHost({
  ipcMain, app, dialog, BrowserWindow, atomicWrite, readDocument,
  assertOpen: (contents, filePath) => {
    if (typeof filePath !== 'string' || !allowedDocuments.has(filePath) || !openDocumentPathsByContents.get(contents)?.has(filePath)) {
      throw new Error('The Agent desk can use only the document you explicitly opened in this window.')
    }
  },
  getWorkspace: (contents) => workspaceByContents.get(contents),
  readWorkspaceNotes,
  // Production always uses 127.0.0.1:11434. Only isolated unpackaged tests may
  // point at an ephemeral loopback protocol fixture; never a remote endpoint.
  ...(!app.isPackaged && process.env.NODE_ENV === 'test' && path.isAbsolute(process.env.MARGIN_TEST_USER_DATA || '') && /^\d{1,5}$/.test(process.env.MARGIN_TEST_OLLAMA_PORT || '')
    ? { client: createOllamaClient({ port: Number(process.env.MARGIN_TEST_OLLAMA_PORT) }) } : {}),
})

const externalOpenCoordinator = createExternalOpenCoordinator({
  readDocument,
  deliver: (target, result) => {
    if (target.isDestroyed()) throw new Error('The document window is no longer available.')
    addRecentDocuments(result.documents)
    return new Promise((resolve, reject) => {
      const deliveryId = ++nextExternalDeliveryId
      pendingExternalDeliveries.set(deliveryId, { target, resolve, reject })
      try {
        target.send('external-open:documents', { ...result, deliveryId })
      } catch (error) {
        pendingExternalDeliveries.delete(deliveryId)
        reject(error)
      }
    })
  },
  requestAttention: focusMainWindow,
})

function rejectExternalDeliveries(target) {
  for (const [deliveryId, delivery] of pendingExternalDeliveries) {
    if (delivery.target !== target) continue
    pendingExternalDeliveries.delete(deliveryId)
    delivery.reject(new Error('The document window reloaded before the file-open request was applied.'))
  }
}

function sendCommand(command, payload) {
  let target = BrowserWindow.getFocusedWindow() || mainWindow
  if (!target || target.isDestroyed()) target = focusMainWindow()
  if (!target || target.isDestroyed()) return
  if (rendererReadyWindows.has(target)) {
    target.webContents.send('app-command', command, payload)
    return
  }
  const pending = pendingCommandsByWindow.get(target) || []
  pending.push([command, payload])
  pendingCommandsByWindow.set(target, pending)
}

function addRecentDocuments(documents) {
  rememberedStateQueue = rememberedStateQueue.catch(() => {}).then(async () => {
    await loadRememberedPaths()
    for (const document of documents || []) {
      if (typeof document?.path === 'string') {
        rememberedPaths.delete(document.path)
        rememberedPaths.add(document.path)
      }
    }
    while (rememberedPaths.size > 2000) rememberedPaths.delete(rememberedPaths.values().next().value)
    await atomicWrite(path.join(app.getPath('userData'), 'known-documents.json'), JSON.stringify([...rememberedPaths]))
  })
  void rememberedStateQueue.catch(() => {})
  if (typeof app.addRecentDocument !== 'function' || !Array.isArray(documents)) return
  for (const document of documents) {
    if (typeof document?.path === 'string') app.addRecentDocument(document.path)
  }
}

async function loadRememberedPaths() {
  if (rememberedPaths) return
  rememberedPaths = new Set()
  try {
    const { buffer } = await readFileSnapshot(path.join(app.getPath('userData'), 'known-documents.json'), 1024 * 1024)
    const parsed = JSON.parse(buffer.toString('utf8'))
    if (Array.isArray(parsed)) for (const item of parsed.slice(-2000)) {
      if (typeof item === 'string' && path.isAbsolute(item) && !item.includes('\0')) rememberedPaths.add(item)
    }
  } catch { /* A missing history starts an empty, local capability list. */ }
}

function buildMenu() {
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => sendCommand('appearance') },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => sendCommand('open') },
        { label: 'Open Folder…', click: () => sendCommand('openWorkspace') },
        { label: 'Close Folder', click: () => sendCommand('closeWorkspace') },
        ...(isMac ? [{ label: 'Open Recent', role: 'recentDocuments', submenu: [{ label: 'Clear Recent Documents', role: 'clearRecentDocuments' }] }] : []),
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => sendCommand('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendCommand('saveAs') },
        { type: 'separator' },
        { label: 'Export as HTML…', click: () => sendCommand('exportHtml') },
        { label: 'Export as PDF…', click: () => sendCommand('exportPdf') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => sendCommand('closeTab') },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => sendCommand('reopenClosedTab') },
        { label: 'Close All Tabs', click: () => sendCommand('closeAllTabs') },
        ...(!isMac ? [{ type: 'separator' }, { role: 'quit' }] : []),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find', accelerator: 'CmdOrCtrl+F', click: () => sendCommand('find') },
        { label: 'Find and Replace', accelerator: isMac ? 'Cmd+Alt+F' : 'Ctrl+H', click: () => sendCommand('replace') },
        { label: 'Quick Open…', accelerator: 'CmdOrCtrl+P', click: () => sendCommand('quickOpen') },
        { label: 'Find in Folder', accelerator: 'CmdOrCtrl+Shift+F', click: () => sendCommand('searchWorkspace') },
        { label: 'Go to Line…', accelerator: 'CmdOrCtrl+Alt+G', click: () => sendCommand('goToLine') },
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+Shift+P', click: () => sendCommand('commandPalette') },
        ...(!isMac ? [{ type: 'separator' }, { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => sendCommand('appearance') }] : []),
      ],
    },
    {
      label: 'Format',
      submenu: [
        { label: 'Bold', accelerator: 'CmdOrCtrl+B', click: () => sendCommand('format', 'bold') },
        { label: 'Italic', accelerator: 'CmdOrCtrl+I', click: () => sendCommand('format', 'italic') },
        { label: 'Link', accelerator: 'CmdOrCtrl+K', click: () => sendCommand('format', 'link') },
        { type: 'separator' },
        { label: 'Heading 1', click: () => sendCommand('format', 'heading1') },
        { label: 'Heading 2', click: () => sendCommand('format', 'heading2') },
        { label: 'Heading 3', click: () => sendCommand('format', 'heading3') },
        { label: 'Blockquote', click: () => sendCommand('format', 'quote') },
        { label: 'Code', click: () => sendCommand('format', 'code') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Read / Edit', accelerator: 'CmdOrCtrl+E', click: () => sendCommand('toggleMode') },
        { label: 'Live Editing', accelerator: 'CmdOrCtrl+Alt+E', click: () => sendCommand('liveMode') },
        { label: 'Back', accelerator: 'CmdOrCtrl+Alt+Left', click: () => sendCommand('back') },
        { label: 'Forward', accelerator: 'CmdOrCtrl+Alt+Right', click: () => sendCommand('forward') },
        { label: 'Split Editor and Preview', accelerator: 'CmdOrCtrl+Shift+E', click: () => sendCommand('splitMode') },
        { label: 'Reading Desk', accelerator: 'CmdOrCtrl+Shift+L', click: () => sendCommand('readingTools') },
        { label: 'Bookmark Document', accelerator: 'CmdOrCtrl+Shift+D', click: () => sendCommand('bookmark') },
        { label: 'Note Graph', accelerator: 'CmdOrCtrl+Shift+G', click: () => sendCommand('graph') },
        { label: 'Present Document', accelerator: 'F5', click: () => sendCommand('presentation') },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+Shift+O', click: () => sendCommand('toggleOutline') },
        { label: 'Focus Mode', accelerator: 'F8', click: () => sendCommand('focusMode') },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => sendCommand('nextTab') },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => sendCommand('previousTab') },
        { type: 'separator' },
        { id: 'view.wordWrap', label: 'Word Wrap', type: 'checkbox', checked: true, accelerator: 'Alt+Z', click: (item) => sendCommand('setWordWrap', String(item.checked)) },
        { id: 'view.lineNumbers', label: 'Line Numbers', type: 'checkbox', checked: true, click: (item) => sendCommand('setLineNumbers', String(item.checked)) },
        { id: 'view.whitespace', label: 'Visible Whitespace', type: 'checkbox', checked: false, click: (item) => sendCommand('setShowWhitespace', String(item.checked)) },
        { id: 'view.typewriter', label: 'Typewriter Mode', type: 'checkbox', checked: false, click: (item) => sendCommand('setTypewriterMode', String(item.checked)) },
        { type: 'separator' },
        ...(devUrl ? [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }] : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Keyboard shortcuts', click: () => sendCommand('shortcuts') },
        { label: 'About Margin', click: () => sendCommand('about') },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function canonicalize(filePath) {
  try {
    return await fs.realpath(filePath)
  } catch {
    return path.resolve(filePath)
  }
}

function assertMarkdownText(buffer, filePath) {
  if (buffer.length > MAX_DOCUMENT_BYTES) {
    throw new Error(`${path.basename(filePath)} is larger than the 25 MB safety limit.`)
  }
  if (buffer.subarray(0, 8192).includes(0)) {
    throw new Error(`${path.basename(filePath)} appears to be a binary file.`)
  }
}

async function readFileSnapshot(filePath, maxBytes = MAX_DOCUMENT_BYTES) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const handle = await fs.open(filePath, 'r')
    try {
      const before = await handle.stat()
      if (!before.isFile()) throw new Error(`${path.basename(filePath)} is not a regular file.`)
      if (before.size > maxBytes) throw new Error(`${path.basename(filePath)} is larger than the ${Math.floor(maxBytes / 1024 / 1024)} MB safety limit.`)
      const buffer = Buffer.allocUnsafe(before.size)
      let offset = 0
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      const after = await handle.stat()
      const stable = before.size === after.size
        && before.mtimeMs === after.mtimeMs
        && before.ctimeMs === after.ctimeMs
      if (stable && offset === buffer.length && buffer.length === after.size) return { buffer, stat: after }
    } finally {
      await handle.close()
    }
  }
  throw new Error(`${path.basename(filePath)} changed while it was being opened. Try again.`)
}

async function readDocument(filePath, { register = true } = {}) {
  const canonicalPath = await canonicalize(filePath)
  const { buffer, stat } = await readFileSnapshot(canonicalPath)
  assertMarkdownText(buffer, canonicalPath)
  const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
  let decoded
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '')
  } catch {
    throw new Error(`${path.basename(canonicalPath)} is not valid UTF-8 text.`)
  }
  if (register) allowedDocuments.add(canonicalPath)
  return {
    path: canonicalPath,
    name: path.basename(canonicalPath),
    content: decoded.replace(/\r\n?/g, '\n'),
    mtimeMs: stat.mtimeMs,
    lineEnding: decoded.includes('\r\n') ? 'crlf' : 'lf',
    bom: hasBom,
  }
}

async function atomicWrite(filePath, content) {
  const directory = path.dirname(filePath)
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  const existing = await fs.stat(filePath).catch(() => null)
  try {
    await fs.writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx', mode: existing ? existing.mode & 0o777 : 0o600 })
    await fs.rename(tempPath, filePath)
  } finally {
    await fs.unlink(tempPath).catch(() => {})
  }
}

async function assertWritableFileTarget(filePath) {
  const existing = await fs.stat(filePath).catch(() => null)
  if (!existing) return
  if (!existing.isFile()) throw new Error(`${path.basename(filePath)} is not a regular file.`)
  const writable = await fs.access(filePath, fsConstants.W_OK).then(() => true).catch(() => false)
  if (!writable) throw new Error(`${path.basename(filePath)} is read-only.`)
}

function enqueueDocumentSave(filePath, operation) {
  const previous = documentSaveQueues.get(filePath) || Promise.resolve()
  const next = previous.catch(() => {}).then(operation)
  documentSaveQueues.set(filePath, next)
  const cleanup = () => {
    if (documentSaveQueues.get(filePath) === next) documentSaveQueues.delete(filePath)
  }
  void next.then(cleanup, cleanup)
  return next
}

function enqueueRecovery(operation) {
  const next = recoveryQueue.catch(() => {}).then(operation)
  recoveryQueue = next
  return next
}

function enqueueWorkspaceState(operation) {
  const next = workspaceStateQueue.catch(() => {}).then(operation)
  workspaceStateQueue = next
  return next
}

function workspaceStateFilePath() {
  return path.join(app.getPath('userData'), 'workspace-state.json')
}

function nextWorkspaceGeneration(contents) {
  const generation = (workspaceGenerationByContents.get(contents) || 0) + 1
  workspaceGenerationByContents.set(contents, generation)
  return generation
}

function abortWorkspaceSearch(contents) {
  workspaceSearchByContents.get(contents)?.abort()
  workspaceSearchByContents.delete(contents)
}

function abortWorkspaceDirectoryListings(contents) {
  const listings = workspaceDirectoryListingsByContents.get(contents)
  if (!listings) return
  for (const listing of listings.values()) listing.controller.abort()
  listings.clear()
  workspaceDirectoryListingsByContents.delete(contents)
}

function abortWorkspaceIndex(contents) {
  noteSnapshotsByContents.get(contents)?.controller.abort()
  noteSnapshotsByContents.delete(contents)
  workspaceIndexByContents.get(contents)?.controller.abort()
  workspaceIndexByContents.delete(contents)
}

function clearWorkspaceCapability(contents) {
  nextWorkspaceGeneration(contents)
  abortWorkspaceDirectoryListings(contents)
  abortWorkspaceSearch(contents)
  abortWorkspaceIndex(contents)
  workspaceByContents.delete(contents)
}

function requireWorkspace(contents) {
  const workspace = workspaceByContents.get(contents)
  if (!workspace) throw new Error('Open a folder before using workspace navigation.')
  return workspace
}

function workspaceDescriptor(rootPath) {
  return { id: randomUUID(), rootPath, name: path.basename(rootPath) || rootPath }
}

async function persistWorkspaceRoot(rootPath) {
  await atomicWrite(workspaceStateFilePath(), JSON.stringify({ rootPath }))
}

async function clearPersistedWorkspaceRoot() {
  try {
    await fs.unlink(workspaceStateFilePath())
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function readPersistedWorkspaceRoot() {
  let raw
  try {
    const stat = await fs.stat(workspaceStateFilePath())
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('The saved workspace state is invalid.')
    raw = await fs.readFile(workspaceStateFilePath(), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('The saved workspace state is invalid.')
  }
  return typeof parsed?.rootPath === 'string' ? parsed.rootPath : null
}

function sessionFilePath() {
  return path.join(app.getPath('userData'), 'recovery-session.json')
}

async function saveRecoverySession(tabs) {
  if (!Array.isArray(tabs)) return
  let totalBytes = 0
  const safeTabs = []
  for (const tab of tabs.slice(0, MAX_OPEN_TABS)) {
    if (!tab || typeof tab.id !== 'string' || typeof tab.content !== 'string') continue
    let documentPath = null
    if (typeof tab.path === 'string') {
      const candidate = await canonicalize(tab.path)
      if (allowedDocuments.has(candidate)) documentPath = candidate
    }
    const dirty = tab.content !== tab.savedContent || tab.saveState === 'conflict'
    const recoveryContent = documentPath && !dirty ? '' : tab.content
    const recoveryBaseline = dirty && typeof tab.savedContent === 'string' ? tab.savedContent : ''
    totalBytes += retainedTextBytes(recoveryContent, recoveryBaseline)
    if (totalBytes > MAX_RECOVERY_CONTENT_BYTES) throw new Error('The recovery session is larger than 50 MB.')
    safeTabs.push({
      id: tab.id,
      path: documentPath,
      name: typeof tab.name === 'string' ? tab.name : 'Untitled.md',
      content: recoveryContent,
      savedContent: recoveryBaseline,
      dirty,
      mtimeMs: Number.isFinite(tab.mtimeMs) ? tab.mtimeMs : null,
      mode: ['edit', 'split', 'live'].includes(tab.mode) ? tab.mode : 'read',
      lineEnding: tab.lineEnding === 'crlf' ? 'crlf' : 'lf',
      bom: Boolean(tab.bom),
      cursorLine: Number.isFinite(tab.cursorLine) ? tab.cursorLine : 1,
      cursorColumn: Number.isFinite(tab.cursorColumn) ? tab.cursorColumn : 1,
      selectionAnchor: Number.isFinite(tab.selectionAnchor) ? tab.selectionAnchor : 0,
      selectionHead: Number.isFinite(tab.selectionHead) ? tab.selectionHead : 0,
      editorScrollTop: Number.isFinite(tab.editorScrollTop) ? tab.editorScrollTop : 0,
      editorScrollLeft: Number.isFinite(tab.editorScrollLeft) ? tab.editorScrollLeft : 0,
      readerScrollTop: Number.isFinite(tab.readerScrollTop) ? tab.readerScrollTop : 0,
      revision: Number.isSafeInteger(tab.revision) && tab.revision >= 0 ? tab.revision : 0,
    })
  }
  const serialized = JSON.stringify(safeTabs)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RECOVERY_FILE_BYTES) {
    throw new Error('The recovery session cannot be stored safely because its encoded backup is larger than 64 MB.')
  }
  await atomicWrite(sessionFilePath(), serialized)
}

async function loadRecoverySession() {
  let raw
  try {
    const { buffer } = await readFileSnapshot(sessionFilePath(), MAX_RECOVERY_FILE_BYTES)
    raw = buffer.toString('utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { tabs: [] }
    throw new Error('The recovery backup could not be read. Margin will not overwrite it.')
  }
  let stored
  try {
    stored = JSON.parse(raw)
  } catch {
    await quarantineRecoverySession('damaged')
  }
  if (!Array.isArray(stored)) await quarantineRecoverySession('in an unsupported format')
  const candidates = stored.slice(0, MAX_OPEN_TABS)
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item && typeof item.id === 'string' && typeof item.content === 'string')
  const restoredByIndex = new Map()
  let retainedBytes = 0
  let skippedForBudget = 0

  // Recover unsaved work first. Clean documents can be reopened from disk;
  // dirty buffers are the irreplaceable part of the session backup.
  for (const dirtyPass of [true, false]) {
    for (const { item, index } of candidates) {
      if ((item.dirty === true) !== dirtyPass) continue
      const tab = await restoreRecoveryItem(item)
      if (!tab) continue
      const tabBytes = retainedTextBytes(tab.content, tab.savedContent)
      if (retainedBytes + tabBytes > MAX_OPEN_CONTENT_BYTES) {
        if (dirtyPass) {
          throw new Error('The recovery backup contains more than 200 MB of unsaved document text. Margin will not overwrite it.')
        }
        skippedForBudget += 1
        continue
      }
      retainedBytes += tabBytes
      if (tab.path) allowedDocuments.add(tab.path)
      restoredByIndex.set(index, tab)
    }
  }

  const tabs = [...restoredByIndex.entries()].sort(([left], [right]) => left - right).map(([, tab]) => tab)
  return {
    tabs,
    warning: skippedForBudget
      ? `${skippedForBudget} clean document${skippedForBudget === 1 ? ' was' : 's were'} not restored because Margin limits open document text to 200 MB.`
      : undefined,
  }
}

async function restoreRecoveryItem(item) {
  if (typeof item.path === 'string') {
    try {
      const disk = await readDocument(item.path, { register: false })
      const content = item.dirty ? item.content : disk.content
      const baselineMtime = Number.isFinite(item.mtimeMs) ? item.mtimeMs : null
      const diskChangedWhileClosed = Boolean(item.dirty) && (
        baselineMtime == null || Math.abs(disk.mtimeMs - baselineMtime) > 2
      )
      const savedContent = diskChangedWhileClosed && typeof item.savedContent === 'string'
        ? item.savedContent
        : disk.content
      return {
        id: item.id,
        path: disk.path,
        name: disk.name,
        content,
        savedContent,
        mtimeMs: diskChangedWhileClosed ? (baselineMtime ?? 0) : disk.mtimeMs,
        lineEnding: diskChangedWhileClosed ? (item.lineEnding === 'crlf' ? 'crlf' : 'lf') : disk.lineEnding,
        bom: diskChangedWhileClosed ? Boolean(item.bom) : disk.bom,
        mode: ['edit', 'split', 'live'].includes(item.mode) ? item.mode : 'read',
        saveState: diskChangedWhileClosed ? 'conflict' : content === disk.content ? 'saved' : 'edited',
        cursorLine: item.cursorLine || 1,
        cursorColumn: item.cursorColumn || 1,
        selectionAnchor: Number.isFinite(item.selectionAnchor) ? item.selectionAnchor : 0,
        selectionHead: Number.isFinite(item.selectionHead) ? item.selectionHead : 0,
        editorScrollTop: Number.isFinite(item.editorScrollTop) ? item.editorScrollTop : 0,
        editorScrollLeft: Number.isFinite(item.editorScrollLeft) ? item.editorScrollLeft : 0,
        readerScrollTop: Number.isFinite(item.readerScrollTop) ? item.readerScrollTop : 0,
        revision: Number.isSafeInteger(item.revision) && item.revision >= 0 ? item.revision : 0,
      }
    } catch {
      if (!item.dirty) return null
    }
  }
  return {
    id: item.id,
    path: null,
    name: item.path ? `Recovered — ${item.name}` : item.name,
    content: item.content,
    savedContent: '',
    mtimeMs: null,
    lineEnding: item.lineEnding === 'crlf' ? 'crlf' : 'lf',
    bom: Boolean(item.bom),
    mode: ['read', 'split', 'live'].includes(item.mode) ? item.mode : 'edit',
    saveState: item.content ? 'edited' : 'saved',
    cursorLine: item.cursorLine || 1,
    cursorColumn: item.cursorColumn || 1,
    selectionAnchor: Number.isFinite(item.selectionAnchor) ? item.selectionAnchor : 0,
    selectionHead: Number.isFinite(item.selectionHead) ? item.selectionHead : 0,
    editorScrollTop: Number.isFinite(item.editorScrollTop) ? item.editorScrollTop : 0,
    editorScrollLeft: Number.isFinite(item.editorScrollLeft) ? item.editorScrollLeft : 0,
    readerScrollTop: Number.isFinite(item.readerScrollTop) ? item.readerScrollTop : 0,
    revision: Number.isSafeInteger(item.revision) && item.revision >= 0 ? item.revision : 0,
  }
}

function retainedTextBytes(content, savedContent) {
  return Buffer.byteLength(content, 'utf8') + (content === savedContent ? 0 : Buffer.byteLength(savedContent, 'utf8'))
}

async function quarantineRecoverySession(reason) {
  const preservedPath = `${sessionFilePath()}.invalid-${Date.now()}`
  try {
    await fs.rename(sessionFilePath(), preservedPath)
  } catch {
    throw new Error(`The recovery backup is ${reason} and could not be preserved safely. Margin will not overwrite it.`)
  }
  throw new Error(`The recovery backup was ${reason} and was preserved as ${path.basename(preservedPath)}.`)
}

async function chooseSavePath(parent, currentPath, suggestedName, extension = 'md') {
  const isHtml = extension === 'html'
  const isPdf = extension === 'pdf'
  const filters = isHtml
    ? [{ name: 'HTML document', extensions: ['html'] }]
    : isPdf
      ? [{ name: 'PDF document', extensions: ['pdf'] }]
      : [{ name: 'Markdown document', extensions: ['md', 'markdown'] }, { name: 'Text file', extensions: ['txt'] }]
  const defaultPath = currentPath || suggestedName || `Untitled.${extension}`
  const result = await dialog.showSaveDialog(parent, { defaultPath, filters })
  return result.canceled ? null : result.filePath
}

function activeDocumentPaths(contents) {
  return openDocumentPathsByContents.get(contents) || new Set()
}

function assertSaveTargetAvailable(contents, targetPath, currentPath) {
  if (targetPath !== currentPath && activeDocumentPaths(contents).has(targetPath)) {
    throw new Error(`${path.basename(targetPath)} is already open in another tab.`)
  }
}

function claimSaveTarget(contents, targetPath, currentPath) {
  if (targetPath === currentPath) return null
  assertSaveTargetAvailable(contents, targetPath, currentPath)
  let claims = saveTargetClaimsByContents.get(contents)
  if (!claims) {
    claims = new Set()
    saveTargetClaimsByContents.set(contents, claims)
  }
  if (claims.has(targetPath)) throw new Error(`${path.basename(targetPath)} is already being used by another save.`)
  claims.add(targetPath)
  return targetPath
}

function releaseSaveTarget(contents, targetPath) {
  if (!targetPath) return
  const claims = saveTargetClaimsByContents.get(contents)
  claims?.delete(targetPath)
  if (claims && claims.size === 0) saveTargetClaimsByContents.delete(contents)
}

const supportedImageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp'])

function detectImageExtension(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg'
  if (buffer.length >= 6 && /^(?:GIF87a|GIF89a)$/.test(buffer.subarray(0, 6).toString('ascii'))) return '.gif'
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp'
  if (buffer.length >= 2 && buffer.subarray(0, 2).toString('ascii') === 'BM') return '.bmp'
  if (buffer.length >= 16 && /ftyp(?:avif|avis)/.test(buffer.subarray(4, 32).toString('ascii'))) return '.avif'
  const prefix = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8').replace(/^\uFEFF/, '').trimStart()
  if (/^(?:<\?xml[\s\S]*?\?>\s*)?<svg(?:\s|>)/i.test(prefix)) return '.svg'
  return null
}

async function assertOpenDocumentForAssetImport(contents, documentPath, message) {
  const canonicalDocument = await canonicalize(documentPath)
  if (!allowedDocuments.has(canonicalDocument) || !activeDocumentPaths(contents).has(canonicalDocument)) throw new Error(message)
  const documentStat = await fs.stat(canonicalDocument).catch(() => null)
  if (!documentStat?.isFile()) throw new Error('The document was moved or deleted. Save it before importing an image.')
  return canonicalDocument
}

async function writeImportedImage(contents, canonicalDocument, buffer, originalName, extension) {
  await assertOpenDocumentForAssetImport(contents, canonicalDocument, 'This document is no longer open for image imports.')
  const capabilityRoot = await canonicalize(path.dirname(canonicalDocument))
  const requestedAssets = path.join(capabilityRoot, 'assets')
  await fs.mkdir(requestedAssets, { recursive: true })
  const assetsDirectory = await canonicalize(requestedAssets)
  if (assetsDirectory !== capabilityRoot && !assetsDirectory.startsWith(`${capabilityRoot}${path.sep}`)) {
    throw new Error('The assets folder resolves outside this document folder.')
  }
  await assertOpenDocumentForAssetImport(contents, canonicalDocument, 'This document is no longer open for image imports.')

  const rawExtension = path.extname(originalName)
  const rawBase = path.basename(originalName, rawExtension).normalize('NFKC')
  const base = rawBase.replace(/[^\p{L}\p{N}._ -]/gu, '-').replace(/\s+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80) || 'image'
  let targetPath = ''
  for (let suffix = 1; suffix <= 9999; suffix += 1) {
    const candidateName = `${base}${suffix === 1 ? '' : `-${suffix}`}${extension}`
    const candidate = path.join(assetsDirectory, candidateName)
    try {
      await fs.writeFile(candidate, buffer, { flag: 'wx', mode: 0o600 })
      targetPath = candidate
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  if (!targetPath) throw new Error('Margin could not choose a unique image filename.')
  const relativePath = path.relative(capabilityRoot, targetPath).split(path.sep).map(encodeURIComponent).join('/')
  return { status: 'imported', relativePath }
}

async function registerIpc() {
  agentHost.register()
  ipcMain.handle('documents:open', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(parent, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Markdown and text', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled) return { documents: [], errors: [] }
    const opened = await readDocumentsSettled(result.filePaths, readDocument)
    addRecentDocuments(opened.documents)
    return opened
  })

  ipcMain.handle('workspace:open', async (event) => {
    const contents = event.sender
    const generation = nextWorkspaceGeneration(contents)
    const parent = BrowserWindow.fromWebContents(contents)
    const result = await dialog.showOpenDialog(parent, { properties: ['openDirectory'] })
    if (workspaceGenerationByContents.get(contents) !== generation || result.canceled || !result.filePaths[0]) return null
    const rootPath = await resolveWorkspaceRoot(result.filePaths[0])
    if (workspaceGenerationByContents.get(contents) !== generation) return null
    const descriptor = workspaceDescriptor(rootPath)
    await enqueueWorkspaceState(async () => {
      if (workspaceGenerationByContents.get(contents) !== generation) return
      await persistWorkspaceRoot(rootPath)
      if (workspaceGenerationByContents.get(contents) === generation) {
        abortWorkspaceDirectoryListings(contents)
        abortWorkspaceSearch(contents)
        abortWorkspaceIndex(contents)
        workspaceByContents.set(contents, descriptor)
      } else {
        // The picker was superseded while the atomic state write was in
        // flight. Restore the capability that is still live so restart state
        // never points at a folder the renderer intentionally ignored.
        const currentWorkspace = workspaceByContents.get(contents)
        if (currentWorkspace) await persistWorkspaceRoot(currentWorkspace.rootPath)
        else await clearPersistedWorkspaceRoot()
      }
    })
    return workspaceByContents.get(contents) === descriptor ? descriptor : null
  })

  ipcMain.handle('workspace:load', async (event) => {
    const contents = event.sender
    const generation = nextWorkspaceGeneration(contents)
    abortWorkspaceDirectoryListings(contents)
    abortWorkspaceSearch(contents)
    abortWorkspaceIndex(contents)
    workspaceByContents.delete(contents)
    // Reads share the same queue as open/close writes and open's compensation
    // write. Otherwise a reload can observe a half-completed state transition
    // and reinstall the root that transition is replacing or clearing.
    const storedRoot = await enqueueWorkspaceState(readPersistedWorkspaceRoot)
    if (!storedRoot || workspaceGenerationByContents.get(contents) !== generation) return null
    let rootPath
    try {
      rootPath = await resolveWorkspaceRoot(storedRoot)
    } catch {
      await enqueueWorkspaceState(async () => {
        if (workspaceGenerationByContents.get(contents) === generation) await clearPersistedWorkspaceRoot()
      })
      return null
    }
    if (workspaceGenerationByContents.get(contents) !== generation) return null
    const descriptor = workspaceDescriptor(rootPath)
    workspaceByContents.set(contents, descriptor)
    return descriptor
  })

  ipcMain.handle('workspace:close', async (event) => {
    clearWorkspaceCapability(event.sender)
    try {
      await enqueueWorkspaceState(clearPersistedWorkspaceRoot)
      return { closed: true }
    } catch {
      return { closed: true, warning: 'The folder was closed, but Margin could not clear its saved restore state.' }
    }
  })

  ipcMain.handle('workspace:list-directory', async (event, relativeDirectory) => {
    const contents = event.sender
    const workspace = requireWorkspace(contents)
    const normalizedDirectory = normalizeWorkspaceRelativePath(relativeDirectory, { allowRoot: true })
    let listings = workspaceDirectoryListingsByContents.get(contents)
    if (!listings) {
      listings = new Map()
      workspaceDirectoryListingsByContents.set(contents, listings)
    }
    const key = `${workspace.id}\0${normalizedDirectory}`
    const existing = listings.get(key)
    if (existing) return existing.promise

    const controller = new AbortController()
    const promise = (async () => {
      const result = await listWorkspaceDirectory(workspace.rootPath, normalizedDirectory, { signal: controller.signal })
      if (workspaceByContents.get(contents) !== workspace) throw new Error('The workspace changed while its files were being listed.')
      return { workspaceId: workspace.id, directory: result.directory, entries: result.entries, truncated: result.truncated }
    })()
    listings.set(key, { controller, promise })
    try {
      return await promise
    } finally {
      if (listings.get(key)?.promise === promise) listings.delete(key)
      if (!listings.size && workspaceDirectoryListingsByContents.get(contents) === listings) {
        workspaceDirectoryListingsByContents.delete(contents)
      }
    }
  })

  ipcMain.handle('workspace:list-documents', async (event) => {
    const workspace = requireWorkspace(event.sender)
    const existing = workspaceIndexByContents.get(event.sender)
    if (existing?.workspaceId === workspace.id) return existing.promise
    abortWorkspaceIndex(event.sender)
    const controller = new AbortController()
    const promise = (async () => {
      const result = await listWorkspaceDocuments(workspace.rootPath, { signal: controller.signal })
      if (workspaceByContents.get(event.sender) !== workspace) throw new Error('The workspace changed while Quick Open was indexing it.')
      return {
        workspaceId: workspace.id,
        documents: result.documents.map((relativePath) => ({
          relativePath,
          name: relativePath.split('/').at(-1),
          kind: 'document',
        })),
        scannedFiles: result.scannedFiles,
        truncated: result.truncated,
      }
    })()
    workspaceIndexByContents.set(event.sender, { workspaceId: workspace.id, controller, promise })
    try {
      return await promise
    } finally {
      if (workspaceIndexByContents.get(event.sender)?.promise === promise) workspaceIndexByContents.delete(event.sender)
    }
  })

  ipcMain.handle('workspace:notes', async (event) => {
    const contents = event.sender
    const workspace = requireWorkspace(contents)
    const existing = noteSnapshotsByContents.get(contents)
    if (existing?.workspaceId === workspace.id) return existing.promise
    const controller = new AbortController()
    const promise = readWorkspaceNotes(workspace.rootPath, { signal: controller.signal }).then((result) => {
      if (workspaceByContents.get(contents) !== workspace) throw new Error('The folder changed while notes were being indexed.')
      return { workspaceId: workspace.id, ...result }
    })
    noteSnapshotsByContents.set(contents, { workspaceId: workspace.id, controller, promise })
    try { return await promise } finally {
      if (noteSnapshotsByContents.get(contents)?.promise === promise) noteSnapshotsByContents.delete(contents)
    }
  })

  ipcMain.handle('workspace:open-document', async (event, relativePath) => {
    try {
      const workspace = requireWorkspace(event.sender)
      const entry = await resolveWorkspaceEntry(workspace.rootPath, relativePath, 'document')
      if (workspaceByContents.get(event.sender) !== workspace) throw new Error('The workspace changed before this document could be opened.')
      const document = await readDocument(entry.path, { register: false })
      if (workspaceByContents.get(event.sender) !== workspace) throw new Error('The workspace changed before this document could be delivered.')
      allowedDocuments.add(document.path)
      addRecentDocuments([document])
      return { documents: [document], errors: [] }
    } catch (error) {
      return {
        documents: [],
        errors: [{
          path: typeof relativePath === 'string' ? relativePath : '',
          message: error instanceof Error ? error.message : 'The workspace document could not be opened.',
        }],
      }
    }
  })

  ipcMain.handle('workspace:create-document', async (event, relativePath) => {
    const workspace = requireWorkspace(event.sender)
    const normalized = normalizeWorkspaceRelativePath(relativePath)
    if (!/\.md$/i.test(normalized)) throw new Error('New notes must use the .md extension.')
    const parent = normalized.split('/').slice(0, -1).join('/')
    const directory = await resolveWorkspaceEntry(workspace.rootPath, parent, 'directory')
    if (workspaceByContents.get(event.sender) !== workspace) throw new Error('The selected folder changed.')
    const target = path.join(directory.path, normalized.split('/').at(-1))
    await fs.writeFile(target, '', { flag: 'wx', mode: 0o600 })
    const document = await readDocument(target)
    addRecentDocuments([document])
    return { documents: [document], errors: [] }
  })

  ipcMain.handle('workspace:search', async (event, request) => {
    const contents = event.sender
    const workspace = requireWorkspace(contents)
    abortWorkspaceSearch(contents)
    const controller = new AbortController()
    workspaceSearchByContents.set(contents, controller)
    try {
      const result = await searchWorkspace(workspace.rootPath, request, { signal: controller.signal })
      if (workspaceByContents.get(contents) !== workspace) {
        return { workspaceId: workspace.id, matches: [], scannedFiles: 0, skippedFiles: 0, truncated: false, cancelled: true }
      }
      return {
        workspaceId: workspace.id,
        matches: result.matches,
        scannedFiles: result.scannedFiles,
        skippedFiles: result.skippedFiles,
        truncated: result.truncated,
      }
    } catch (error) {
      if (error?.name === 'AbortError') {
        return { workspaceId: workspace.id, matches: [], scannedFiles: 0, skippedFiles: 0, truncated: false, cancelled: true }
      }
      throw error
    } finally {
      if (workspaceSearchByContents.get(contents) === controller) workspaceSearchByContents.delete(contents)
    }
  })

  ipcMain.on('workspace:cancel-search', (event) => abortWorkspaceSearch(event.sender))

  ipcMain.handle('documents:save', async (event, request) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    let targetPath = request.path ? await canonicalize(request.path) : null
    const currentPath = targetPath

    if (!targetPath || request.saveAs) {
      targetPath = await chooseSavePath(parent, request.saveAs ? null : targetPath, request.name, 'md')
      if (!targetPath) return { status: 'cancelled' }
      targetPath = await canonicalize(targetPath)
    } else if (!allowedDocuments.has(targetPath)) {
      throw new Error('This document is not registered as open.')
    }

    let claimedTarget = claimSaveTarget(event.sender, targetPath, currentPath)
    try {
      const outcome = await enqueueDocumentSave(targetPath, async () => {
      if ((!request.saveAs || targetPath === currentPath) && request.expectedMtime != null) {
        const currentStat = await fs.stat(targetPath).catch(() => null)
        const lastInternalWrite = internalWriteTimes.get(targetPath)
        const fileIsMissing = !currentStat
        const changedSinceExpected = currentStat && Math.abs(currentStat.mtimeMs - request.expectedMtime) > 2
        const isOurPreviousWrite = currentStat && lastInternalWrite != null && Math.abs(currentStat.mtimeMs - lastInternalWrite) <= 2
        if (fileIsMissing || (changedSinceExpected && !isOurPreviousWrite)) {
          if (request.silent) return { status: 'conflict', mtimeMs: currentStat?.mtimeMs ?? 0 }
          const choice = await dialog.showMessageBox(parent, {
            type: 'warning',
            title: fileIsMissing ? 'This file is no longer on disk' : 'This file changed on disk',
            message: fileIsMissing
              ? `${path.basename(targetPath)} was moved or deleted by another application.`
              : `${path.basename(targetPath)} was changed by another application.`,
            detail: fileIsMissing
              ? 'Saving again will recreate it at the original location.'
              : 'Overwriting will replace those external changes.',
            buttons: [fileIsMissing ? 'Save Again' : 'Overwrite', 'Save a Copy…', 'Cancel'],
            defaultId: 2,
            cancelId: 2,
          })
          if (choice.response === 2) return { status: 'cancelled' }
          if (choice.response === 1) {
            targetPath = await chooseSavePath(parent, null, `Copy of ${path.basename(targetPath)}`, 'md')
            if (!targetPath) return { status: 'cancelled' }
            targetPath = await canonicalize(targetPath)
            releaseSaveTarget(event.sender, claimedTarget)
            claimedTarget = claimSaveTarget(event.sender, targetPath, currentPath)
          }
        }
      }

      const existingTarget = await fs.stat(targetPath).catch(() => null)
      if (existingTarget) {
        if (!existingTarget.isFile()) throw new Error(`${path.basename(targetPath)} is not a regular file.`)
        const writable = await fs.access(targetPath, fsConstants.W_OK).then(() => true).catch(() => false)
        if (!writable) throw new Error(`${path.basename(targetPath)} is read-only.`)
      }
      let output = request.lineEnding === 'crlf' ? request.content.replace(/\r?\n/g, '\r\n') : request.content.replace(/\r\n/g, '\n')
      if (request.bom) output = `\uFEFF${output}`
      if (Buffer.byteLength(output, 'utf8') > MAX_DOCUMENT_BYTES) {
        throw new Error('Margin cannot save documents larger than 25 MB. Shorten this document before saving.')
      }
      // Re-read the renderer's live tab set after every dialog and filesystem
      // await; holding the earlier Set would make the Save As guard stale.
      assertSaveTargetAvailable(event.sender, targetPath, currentPath)
      await atomicWrite(targetPath, output)
      const stat = await fs.stat(targetPath)
      const canonicalPath = await canonicalize(targetPath)
      allowedDocuments.add(canonicalPath)
      internalWriteTimes.set(canonicalPath, stat.mtimeMs)
      const saved = {
        status: 'saved',
        path: canonicalPath,
        name: path.basename(canonicalPath),
        mtimeMs: stat.mtimeMs,
      }
      if (!request.silent) addRecentDocuments([{ path: canonicalPath }])
      return saved
      })
      if (outcome.status === 'saved' && claimedTarget) {
        const retainedClaim = claimedTarget
        setTimeout(() => releaseSaveTarget(event.sender, retainedClaim), 15_000).unref?.()
        claimedTarget = null
      }
      return outcome
    } finally {
      releaseSaveTarget(event.sender, claimedTarget)
    }
  })

  ipcMain.handle('documents:read', async (_event, filePath) => {
    const canonicalPath = await canonicalize(filePath)
    if (!allowedDocuments.has(canonicalPath)) throw new Error('This document is not registered as open.')
    return readDocument(canonicalPath)
  })

  ipcMain.handle('documents:reopen', async (_event, filePath) => {
    try {
      await rememberedStateQueue.catch(() => {})
      await loadRememberedPaths()
      const canonical = await canonicalize(filePath)
      if (!allowedDocuments.has(canonical) && !rememberedPaths.has(canonical)) throw new Error('Open this file once before using its saved reading bookmark.')
      const result = await readDocumentsSettled([canonical], readDocument)
      addRecentDocuments(result.documents)
      return result
    } catch (error) {
      return { documents: [], errors: [{ path: typeof filePath === 'string' ? filePath : '', message: error instanceof Error ? error.message : 'The bookmark could not be opened.' }] }
    }
  })

  ipcMain.handle('documents:open-link', async (_event, documentPath, href) => {
    try {
      const canonicalDocument = await canonicalize(documentPath)
      if (!allowedDocuments.has(canonicalDocument)) throw new Error('The source document is not registered as open.')
      const capabilityRoot = await canonicalize(path.dirname(canonicalDocument))
      const resolved = resolveLinkedDocumentPath(canonicalDocument, href)
      const canonicalTarget = await canonicalize(resolved)
      if (canonicalTarget !== capabilityRoot && !canonicalTarget.startsWith(`${capabilityRoot}${path.sep}`)) {
        throw new Error('Links outside this document folder are blocked.')
      }
      const opened = await readDocumentsSettled([canonicalTarget], readDocument)
      addRecentDocuments(opened.documents)
      return opened
    } catch (error) {
      return {
        documents: [],
        errors: [{
          path: typeof href === 'string' ? href : '',
          message: error instanceof Error ? error.message : 'The linked document could not be opened.',
        }],
      }
    }
  })

  ipcMain.handle('documents:stat', async (_event, filePath) => {
    const canonicalPath = await canonicalize(filePath)
    if (!allowedDocuments.has(canonicalPath)) return null
    const stat = await fs.stat(canonicalPath).catch(() => null)
    if (!stat) return { exists: false, mtimeMs: null, writable: false }
    const writable = await fs.access(canonicalPath, fsConstants.W_OK).then(() => true).catch(() => false)
    return { exists: true, mtimeMs: stat.mtimeMs, writable }
  })

  ipcMain.handle('assets:read', async (event, documentPath, assetPath) => {
    if (!documentPath || !assetPath || /^(?:https?:|data:|blob:)/i.test(assetPath)) return null
    const canonicalDocument = await canonicalize(documentPath)
    if (!allowedDocuments.has(canonicalDocument)) {
      const workspace = workspaceByContents.get(event.sender)
      if (!workspace || !isPathInsideRoot(workspace.rootPath, canonicalDocument)) return null
      const relative = path.relative(workspace.rootPath, canonicalDocument).split(path.sep).join('/')
      try { await resolveWorkspaceEntry(workspace.rootPath, relative, 'document') } catch { return null }
    }
    const capabilityRoot = path.dirname(canonicalDocument)
    let decodedAssetPath
    try {
      decodedAssetPath = decodeURIComponent(assetPath.split('#')[0].split('?')[0])
    } catch {
      return null
    }
    if (path.isAbsolute(decodedAssetPath) || /^[/\\]{2}/.test(decodedAssetPath) || /^[a-z][a-z\d+.-]*:/i.test(decodedAssetPath)) return null
    const resolved = path.resolve(capabilityRoot, decodedAssetPath)
    const canonicalAsset = await canonicalize(resolved)
    if (canonicalAsset !== capabilityRoot && !canonicalAsset.startsWith(`${capabilityRoot}${path.sep}`)) return null
    const extension = path.extname(canonicalAsset).toLowerCase()
    const mimeTypes = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
      '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.bmp': 'image/bmp',
    }
    if (!mimeTypes[extension]) return null
    const snapshot = await readFileSnapshot(canonicalAsset, MAX_ASSET_BYTES).catch(() => null)
    const data = snapshot?.buffer
    if (!data) return null
    return `data:${mimeTypes[extension]};base64,${data.toString('base64')}`
  })

  ipcMain.handle('assets:import', async (event, documentPath) => {
    const canonicalDocument = await assertOpenDocumentForAssetImport(event.sender, documentPath, 'Save the document before importing an image.')
    const parent = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(parent, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'] }],
    })
    if (result.canceled || !result.filePaths[0]) return { status: 'cancelled' }

    await assertOpenDocumentForAssetImport(event.sender, canonicalDocument, 'This document is no longer open for image imports.')

    const source = await canonicalize(result.filePaths[0])
    const requestedExtension = path.extname(source).toLowerCase()
    if (!supportedImageExtensions.has(requestedExtension)) {
      throw new Error('That image format is not supported.')
    }
    let sourceSnapshot
    try {
      sourceSnapshot = await readFileSnapshot(source, MAX_ASSET_BYTES)
    } catch {
      throw new Error('Images must be stable regular files no larger than 20 MB.')
    }
    const extension = detectImageExtension(sourceSnapshot.buffer)
    if (!extension) throw new Error('The selected file does not contain a supported image.')

    return writeImportedImage(event.sender, canonicalDocument, sourceSnapshot.buffer, path.basename(source), extension)
  })

  ipcMain.handle('assets:import-data', async (event, documentPath, image) => {
    const canonicalDocument = await assertOpenDocumentForAssetImport(event.sender, documentPath, 'Save the document before pasting or dropping images.')
    if (!image || typeof image !== 'object' || typeof image.name !== 'string' || image.name.length > 512 || typeof image.mimeType !== 'string' || image.mimeType.length > 128) {
      throw new Error('The pasted image metadata is invalid.')
    }
    let buffer
    if (image.data instanceof ArrayBuffer) buffer = Buffer.from(image.data)
    else if (ArrayBuffer.isView(image.data)) buffer = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength)
    else throw new Error('The pasted image data is invalid.')
    if (!buffer.length || buffer.length > MAX_ASSET_BYTES) throw new Error('Pasted and dropped images must be no larger than 20 MB.')
    const extension = detectImageExtension(buffer)
    if (!extension) throw new Error('That pasted or dropped image format is not supported.')
    return writeImportedImage(event.sender, canonicalDocument, buffer, image.name || `pasted-image${extension}`, extension)
  })

  ipcMain.handle('export:html', async (event, { html, suggestedName }) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const filePath = await chooseSavePath(parent, null, suggestedName, 'html')
    if (!filePath) return { status: 'cancelled' }
    const targetPath = await canonicalize(filePath)
    assertSaveTargetAvailable(event.sender, targetPath, null)
    await assertWritableFileTarget(targetPath)
    assertSaveTargetAvailable(event.sender, targetPath, null)
    await atomicWrite(targetPath, html)
    return { status: 'saved', path: targetPath }
  })

  ipcMain.handle('export:pdf', async (event, { html, suggestedName }) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const filePath = await chooseSavePath(parent, null, suggestedName, 'pdf')
    if (!filePath) return { status: 'cancelled' }
    const targetPath = await canonicalize(filePath)
    assertSaveTargetAvailable(event.sender, targetPath, null)
    await assertWritableFileTarget(targetPath)
    const exportDirectory = await fs.mkdtemp(path.join(app.getPath('temp'), 'margin-export-'))
    const exportHtmlPath = path.join(exportDirectory, 'document.html')
    const exportWindow = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    const exportContentsId = exportWindow.webContents.id
    try {
      await fs.writeFile(exportHtmlPath, html, 'utf8')
      temporaryRenderFilesByContentsId.set(exportContentsId, exportHtmlPath)
      await exportWindow.loadFile(exportHtmlPath)
      await exportWindow.webContents.executeJavaScript('document.fonts ? document.fonts.ready : Promise.resolve()')
      const pdf = await exportWindow.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: { top: 0.55, bottom: 0.55, left: 0.6, right: 0.6 },
        preferCSSPageSize: true,
      })
      assertSaveTargetAvailable(event.sender, targetPath, null)
      await atomicWrite(targetPath, pdf)
      return { status: 'saved', path: targetPath }
    } finally {
      temporaryRenderFilesByContentsId.delete(exportContentsId)
      if (!exportWindow.isDestroyed()) exportWindow.destroy()
      await fs.rm(exportDirectory, { recursive: true, force: true }).catch(() => {})
    }
  })

  ipcMain.handle('dialog:confirm-close', async (event, name) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showMessageBox(parent, {
      type: 'question',
      title: 'Save your changes?',
      message: `Save changes to ${name}?`,
      detail: 'Your latest recovery draft remains on this device until the tab is closed.',
      buttons: ['Save', "Don’t Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    })
    return ['save', 'discard', 'cancel'][result.response]
  })

  ipcMain.handle('session:load', () => enqueueRecovery(loadRecoverySession))
  ipcMain.on('session:epoch', (event, epoch) => {
    if (typeof epoch !== 'string' || !/^[a-f\d-]{16,64}$/i.test(epoch)) return
    recoveryStateByContents.set(event.sender, { epoch, generation: -1 })
  })
  ipcMain.handle('session:save', (event, tabs, epoch, generation = 0) => {
    if (typeof epoch !== 'string' || !/^[a-f\d-]{16,64}$/i.test(epoch)) return
    const normalizedGeneration = Number.isSafeInteger(generation) && generation >= 0 ? generation : 0
    const latest = recoveryStateByContents.get(event.sender)
    if (!latest || latest.epoch !== epoch || normalizedGeneration < latest.generation) return
    recoveryStateByContents.set(event.sender, { epoch, generation: normalizedGeneration })
    return enqueueRecovery(() => {
      const current = recoveryStateByContents.get(event.sender)
      if (!current || current.epoch !== epoch || normalizedGeneration < current.generation) return
      return saveRecoverySession(tabs)
    })
  })
  ipcMain.handle('session:clear', () => enqueueRecovery(async () => {
    try {
      await fs.unlink(sessionFilePath())
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }))

  ipcMain.on('documents:set-open-paths', (event, paths) => {
    if (!Array.isArray(paths) || paths.length > MAX_OPEN_TABS) {
      openDocumentPathsByContents.set(event.sender, new Set())
      return
    }
    const activePaths = new Set(paths.filter((filePath) => typeof filePath === 'string' && allowedDocuments.has(filePath)))
    openDocumentPathsByContents.set(event.sender, activePaths)
    const claims = saveTargetClaimsByContents.get(event.sender)
    if (claims) {
      for (const filePath of activePaths) claims.delete(filePath)
      if (claims.size === 0) saveTargetClaimsByContents.delete(event.sender)
    }
  })

  ipcMain.on('app:set-dirty', (event, isDirty) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    dirtyWindows.set(window, Boolean(isDirty))
    window.setDocumentEdited(Boolean(isDirty))
  })

  ipcMain.on('app:close-window', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    const shouldQuit = quitRequested
    forceClosing.add(window)
    if (shouldQuit) window.once('closed', () => setImmediate(() => app.quit()))
    window.close()
  })

  ipcMain.on('app:cancel-close', () => {
    quitRequested = false
  })

  ipcMain.on('app:close-safety-ready', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) closeSafetyReadyWindows.add(window)
  })

  ipcMain.handle('shell:show-item', async (event, filePath) => {
    if (typeof filePath !== 'string' || !filePath) return false
    const canonicalPath = await canonicalize(filePath)
    const workspace = workspaceByContents.get(event.sender)
    if (!allowedDocuments.has(canonicalPath) && canonicalPath !== workspace?.rootPath) return false
    shell.showItemInFolder(canonicalPath)
    return true
  })

  ipcMain.handle('shell:open-external', (_event, url) => {
    if (typeof url === 'string' && url.length <= 2048 && /^(?:https?:\/\/|mailto:)/i.test(url)) return shell.openExternal(url)
    return false
  })

  ipcMain.handle('clipboard:write', (_event, text) => {
    if (typeof text !== 'string' || text.length > 5 * 1024 * 1024) return false
    clipboard.writeText(text)
    return true
  })

  ipcMain.on('app:set-view-options', (_event, options) => {
    if (!options || typeof options !== 'object') return
    const menu = Menu.getApplicationMenu()
    const states = [
      ['view.wordWrap', options.wordWrap],
      ['view.lineNumbers', options.lineNumbers],
      ['view.typewriter', options.typewriterMode],
      ['view.whitespace', options.showWhitespace],
    ]
    for (const [id, value] of states) {
      const item = menu?.getMenuItemById(id)
      if (item && typeof value === 'boolean') item.checked = value
    }
  })

  ipcMain.handle('find:start', (event, text, options) => {
    if (!text) return null
    return event.sender.findInPage(text, options)
  })

  ipcMain.on('find:stop', (event, action = 'clearSelection') => event.sender.stopFindInPage(action))

  ipcMain.on('external-open:ready', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) {
      rendererReadyWindows.add(window)
      const pending = pendingCommandsByWindow.get(window) || []
      pendingCommandsByWindow.delete(window)
      for (const [command, payload] of pending) window.webContents.send('app-command', command, payload)
    }
    externalOpenCoordinator.setRendererReady(event.sender)
  })

  ipcMain.on('external-open:ack', (event, deliveryId) => {
    if (!Number.isSafeInteger(deliveryId)) return
    const delivery = pendingExternalDeliveries.get(deliveryId)
    if (!delivery || delivery.target !== event.sender) return
    pendingExternalDeliveries.delete(deliveryId)
    delivery.resolve()
  })
}

function focusMainWindow() {
  if (!bootstrapReady) return null
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  return mainWindow
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    title: 'Margin',
    icon: app.isPackaged ? undefined : developmentIconPath,
    backgroundColor: '#f5f3ee',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: isMac,
    },
  })
  const contents = window.webContents

  contents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: !isAllowedAppRequest(details.url, path.join(__dirname, '..', 'dist'), devUrl, temporaryRenderFilesByContentsId.get(details.webContentsId)) })
  })

  contents.setWindowOpenHandler(({ url }) => {
    if (/^(?:https?:\/\/|mailto:)/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    const current = contents.getURL()
    if (url !== current) event.preventDefault()
  })
  contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  contents.on('context-menu', (_event, params) => {
    const template = []
    if (params.misspelledWord) {
      const suggestions = params.dictionarySuggestions.slice(0, 6)
      if (suggestions.length) {
        template.push(...suggestions.map((suggestion) => ({
          label: suggestion,
          click: () => contents.replaceMisspelling(suggestion),
        })))
      } else {
        template.push({ label: 'No spelling suggestions', enabled: false })
      }
      template.push({
        label: `Add “${params.misspelledWord}” to Dictionary`,
        click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      })
      template.push({ type: 'separator' })
    }
    if (params.isEditable) {
      template.push(
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      )
    } else if (params.selectionText) {
      template.push({ role: 'copy' }, { role: 'selectAll' })
    }
    if (template.length) Menu.buildFromTemplate(template).popup({ window })
  })
  contents.on('did-start-loading', () => {
    agentHost.clear(contents)
    rendererReadyWindows.delete(window)
    closeSafetyReadyWindows.delete(window)
    recoveryStateByContents.delete(contents)
    clearWorkspaceCapability(contents)
    rejectExternalDeliveries(contents)
    externalOpenCoordinator.setRendererUnavailable(contents)
  })
  contents.on('render-process-gone', () => {
    agentHost.clear(contents)
    rendererReadyWindows.delete(window)
    closeSafetyReadyWindows.delete(window)
    recoveryStateByContents.delete(contents)
    clearWorkspaceCapability(contents)
    rejectExternalDeliveries(contents)
    externalOpenCoordinator.setRendererUnavailable(contents)
  })
  window.on('close', (event) => {
    if (closeSafetyReadyWindows.has(window) && !forceClosing.has(window)) {
      event.preventDefault()
      contents.send('app-command', 'requestWindowClose')
    }
  })
  window.on('closed', () => {
    agentHost.clear(contents)
    rendererReadyWindows.delete(window)
    closeSafetyReadyWindows.delete(window)
    rejectExternalDeliveries(contents)
    externalOpenCoordinator.setRendererUnavailable(contents)
    clearWorkspaceCapability(contents)
    openDocumentPathsByContents.delete(contents)
    saveTargetClaimsByContents.delete(contents)
    pendingCommandsByWindow.delete(window)
    if (mainWindow === window) mainWindow = null
  })

  if (devUrl) window.loadURL(devUrl)
  else window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  return window
}

const initialOpenPaths = extractExternalFilePaths(process.argv, {
  isPackaged: app.isPackaged,
  cwd: process.cwd(),
})
const hasSingleInstanceLock = app.requestSingleInstanceLock({ openPaths: initialOpenPaths })

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('open-file', (event, filePath) => {
    event.preventDefault()
    externalOpenCoordinator.enqueue([filePath])
  })

  app.on('second-instance', (_event, argv, workingDirectory, additionalData) => {
    const transmittedPaths = normalizeExternalFilePaths(additionalData?.openPaths, workingDirectory)
    const fallbackPaths = extractExternalFilePaths(argv, {
      isPackaged: app.isPackaged,
      cwd: workingDirectory,
    })
    externalOpenCoordinator.enqueue(transmittedPaths.length ? transmittedPaths : fallbackPaths)
    focusMainWindow()
  })

  externalOpenCoordinator.enqueue(initialOpenPaths)

  app.whenReady().then(async () => {
    app.setName('Margin')
    if (isMac && !app.isPackaged) app.dock.setIcon(developmentIconPath)
    await registerIpc()
    buildMenu()
    mainWindow = createWindow()
    bootstrapReady = true
    app.on('activate', focusMainWindow)
  })
}

app.on('before-quit', () => {
  quitRequested = true
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})
