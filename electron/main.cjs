const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const {
  createExternalOpenCoordinator,
  extractExternalFilePaths,
  normalizeExternalFilePaths,
  readDocumentsSettled,
  resolveLinkedDocumentPath,
} = require('./external-open.cjs')

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
let recoveryQueue = Promise.resolve()
let mainWindow = null
let bootstrapReady = false
let quitRequested = false
let nextExternalDeliveryId = 0

const externalOpenCoordinator = createExternalOpenCoordinator({
  readDocument,
  deliver: (target, result) => {
    if (target.isDestroyed()) throw new Error('The document window is no longer available.')
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
  const target = BrowserWindow.getFocusedWindow() || mainWindow
  target?.webContents.send('app-command', command, payload)
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
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => sendCommand('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendCommand('saveAs') },
        { type: 'separator' },
        { label: 'Export as HTML…', click: () => sendCommand('exportHtml') },
        { label: 'Export as PDF…', click: () => sendCommand('exportPdf') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => sendCommand('closeTab') },
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
        { label: 'Toggle Outline', accelerator: 'CmdOrCtrl+Shift+O', click: () => sendCommand('toggleOutline') },
        { label: 'Focus Mode', accelerator: 'CmdOrCtrl+Shift+F', click: () => sendCommand('focusMode') },
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
  if (buffer.length > 25 * 1024 * 1024) {
    throw new Error(`${path.basename(filePath)} is larger than the 25 MB safety limit.`)
  }
  if (buffer.subarray(0, 8192).includes(0)) {
    throw new Error(`${path.basename(filePath)} appears to be a binary file.`)
  }
}

async function readFileSnapshot(filePath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const handle = await fs.open(filePath, 'r')
    try {
      const before = await handle.stat()
      if (!before.isFile()) throw new Error(`${path.basename(filePath)} is not a regular file.`)
      const buffer = await handle.readFile()
      const after = await handle.stat()
      const stable = before.size === after.size
        && before.mtimeMs === after.mtimeMs
        && before.ctimeMs === after.ctimeMs
      if (stable && buffer.length === after.size) return { buffer, stat: after }
    } finally {
      await handle.close()
    }
  }
  throw new Error(`${path.basename(filePath)} changed while it was being opened. Try again.`)
}

async function readDocument(filePath) {
  const canonicalPath = await canonicalize(filePath)
  const { buffer, stat } = await readFileSnapshot(canonicalPath)
  assertMarkdownText(buffer, canonicalPath)
  allowedDocuments.add(canonicalPath)
  const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
  let decoded
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '')
  } catch {
    throw new Error(`${path.basename(canonicalPath)} is not valid UTF-8 text.`)
  }
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
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
  const existing = await fs.stat(filePath).catch(() => null)
  await fs.writeFile(tempPath, content, { encoding: 'utf8', mode: existing ? existing.mode & 0o777 : 0o600 })
  try {
    await fs.rename(tempPath, filePath)
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {})
    throw error
  }
}

function enqueueDocumentSave(filePath, operation) {
  const previous = documentSaveQueues.get(filePath) || Promise.resolve()
  const next = previous.catch(() => {}).then(operation)
  documentSaveQueues.set(filePath, next)
  void next.finally(() => {
    if (documentSaveQueues.get(filePath) === next) documentSaveQueues.delete(filePath)
  })
  return next
}

function enqueueRecovery(operation) {
  const next = recoveryQueue.catch(() => {}).then(operation)
  recoveryQueue = next
  return next
}

function sessionFilePath() {
  return path.join(app.getPath('userData'), 'recovery-session.json')
}

async function saveRecoverySession(tabs) {
  if (!Array.isArray(tabs)) return
  let totalLength = 0
  const safeTabs = []
  for (const tab of tabs.slice(0, 20)) {
    if (!tab || typeof tab.id !== 'string' || typeof tab.content !== 'string') continue
    let documentPath = null
    if (typeof tab.path === 'string') {
      const candidate = await canonicalize(tab.path)
      if (allowedDocuments.has(candidate)) documentPath = candidate
    }
    const dirty = tab.content !== tab.savedContent || tab.saveState === 'conflict'
    const recoveryContent = documentPath && !dirty ? '' : tab.content
    const recoveryBaseline = dirty && typeof tab.savedContent === 'string' ? tab.savedContent : ''
    totalLength += recoveryContent.length + recoveryBaseline.length
    if (totalLength > 50 * 1024 * 1024) throw new Error('The recovery session is larger than 50 MB.')
    safeTabs.push({
      id: tab.id,
      path: documentPath,
      name: typeof tab.name === 'string' ? tab.name : 'Untitled.md',
      content: recoveryContent,
      savedContent: recoveryBaseline,
      dirty,
      mtimeMs: Number.isFinite(tab.mtimeMs) ? tab.mtimeMs : null,
      mode: tab.mode === 'edit' ? 'edit' : 'read',
      lineEnding: tab.lineEnding === 'crlf' ? 'crlf' : 'lf',
      bom: Boolean(tab.bom),
      cursorLine: Number.isFinite(tab.cursorLine) ? tab.cursorLine : 1,
      cursorColumn: Number.isFinite(tab.cursorColumn) ? tab.cursorColumn : 1,
    })
  }
  await atomicWrite(sessionFilePath(), JSON.stringify(safeTabs))
}

async function loadRecoverySession() {
  let raw
  try {
    raw = await fs.readFile(sessionFilePath(), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw new Error('The recovery backup could not be read. Margin will not overwrite it.')
  }
  let stored
  try {
    stored = JSON.parse(raw)
  } catch {
    await quarantineRecoverySession('damaged')
  }
  if (!Array.isArray(stored)) await quarantineRecoverySession('in an unsupported format')
  const restored = []
  for (const item of stored.slice(0, 20)) {
    if (!item || typeof item.id !== 'string' || typeof item.content !== 'string') continue
    if (typeof item.path === 'string') {
      try {
        const disk = await readDocument(item.path)
        const content = item.dirty ? item.content : disk.content
        const baselineMtime = Number.isFinite(item.mtimeMs) ? item.mtimeMs : null
        const diskChangedWhileClosed = Boolean(item.dirty) && (
          baselineMtime == null || Math.abs(disk.mtimeMs - baselineMtime) > 2
        )
        const savedContent = diskChangedWhileClosed && typeof item.savedContent === 'string'
          ? item.savedContent
          : disk.content
        restored.push({
          id: item.id,
          path: disk.path,
          name: disk.name,
          content,
          savedContent,
          mtimeMs: diskChangedWhileClosed ? (baselineMtime ?? 0) : disk.mtimeMs,
          lineEnding: diskChangedWhileClosed ? (item.lineEnding === 'crlf' ? 'crlf' : 'lf') : disk.lineEnding,
          bom: diskChangedWhileClosed ? Boolean(item.bom) : disk.bom,
          mode: item.mode === 'edit' ? 'edit' : 'read',
          saveState: diskChangedWhileClosed ? 'conflict' : content === disk.content ? 'saved' : 'edited',
          cursorLine: item.cursorLine || 1,
          cursorColumn: item.cursorColumn || 1,
        })
        continue
      } catch {
        if (!item.dirty) continue
      }
    }
    restored.push({
      id: item.id,
      path: null,
      name: item.path ? `Recovered — ${item.name}` : item.name,
      content: item.content,
      savedContent: '',
      mtimeMs: null,
      lineEnding: item.lineEnding === 'crlf' ? 'crlf' : 'lf',
      bom: Boolean(item.bom),
      mode: item.mode === 'read' ? 'read' : 'edit',
      saveState: item.content ? 'edited' : 'saved',
      cursorLine: item.cursorLine || 1,
      cursorColumn: item.cursorColumn || 1,
    })
  }
  return restored
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

async function registerIpc() {
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
    return readDocumentsSettled(result.filePaths, readDocument)
  })

  ipcMain.handle('documents:save', async (event, request) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    let targetPath = request.path ? await canonicalize(request.path) : null

    if (!targetPath || request.saveAs) {
      targetPath = await chooseSavePath(parent, request.saveAs ? null : targetPath, request.name, 'md')
      if (!targetPath) return { status: 'cancelled' }
      targetPath = path.resolve(targetPath)
    } else if (!allowedDocuments.has(targetPath)) {
      throw new Error('This document is not registered as open.')
    }

    return enqueueDocumentSave(targetPath, async () => {
      if (!request.saveAs && request.expectedMtime != null) {
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
            targetPath = path.resolve(targetPath)
          }
        }
      }

      let output = request.lineEnding === 'crlf' ? request.content.replace(/\r?\n/g, '\r\n') : request.content.replace(/\r\n/g, '\n')
      if (request.bom) output = `\uFEFF${output}`
      await atomicWrite(targetPath, output)
      const stat = await fs.stat(targetPath)
      const canonicalPath = await canonicalize(targetPath)
      allowedDocuments.add(canonicalPath)
      internalWriteTimes.set(canonicalPath, stat.mtimeMs)
      return {
        status: 'saved',
        path: canonicalPath,
        name: path.basename(canonicalPath),
        mtimeMs: stat.mtimeMs,
      }
    })
  })

  ipcMain.handle('documents:read', async (_event, filePath) => {
    const canonicalPath = await canonicalize(filePath)
    if (!allowedDocuments.has(canonicalPath)) throw new Error('This document is not registered as open.')
    return readDocument(canonicalPath)
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
      return readDocumentsSettled([canonicalTarget], readDocument)
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
    return stat
      ? { exists: true, mtimeMs: stat.mtimeMs, writable: true }
      : { exists: false, mtimeMs: null, writable: false }
  })

  ipcMain.handle('assets:read', async (_event, documentPath, assetPath) => {
    if (!documentPath || !assetPath || /^(?:https?:|data:|blob:)/i.test(assetPath)) return null
    const canonicalDocument = await canonicalize(documentPath)
    if (!allowedDocuments.has(canonicalDocument)) return null
    const capabilityRoot = path.dirname(canonicalDocument)
    const resolved = path.resolve(capabilityRoot, decodeURIComponent(assetPath.split('#')[0].split('?')[0]))
    const canonicalAsset = await canonicalize(resolved)
    if (canonicalAsset !== capabilityRoot && !canonicalAsset.startsWith(`${capabilityRoot}${path.sep}`)) return null
    const extension = path.extname(canonicalAsset).toLowerCase()
    const mimeTypes = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
      '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.bmp': 'image/bmp',
    }
    if (!mimeTypes[extension]) return null
    const data = await fs.readFile(canonicalAsset).catch(() => null)
    if (!data || data.length > 20 * 1024 * 1024) return null
    return `data:${mimeTypes[extension]};base64,${data.toString('base64')}`
  })

  ipcMain.handle('export:html', async (event, { html, suggestedName }) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const filePath = await chooseSavePath(parent, null, suggestedName, 'html')
    if (!filePath) return { status: 'cancelled' }
    await atomicWrite(path.resolve(filePath), html)
    return { status: 'saved', path: path.resolve(filePath) }
  })

  ipcMain.handle('export:pdf', async (event, { html, suggestedName }) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const filePath = await chooseSavePath(parent, null, suggestedName, 'pdf')
    if (!filePath) return { status: 'cancelled' }
    const exportWindow = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    const exportDirectory = await fs.mkdtemp(path.join(app.getPath('temp'), 'margin-export-'))
    const exportHtmlPath = path.join(exportDirectory, 'document.html')
    try {
      await fs.writeFile(exportHtmlPath, html, 'utf8')
      await exportWindow.loadFile(exportHtmlPath)
      await exportWindow.webContents.executeJavaScript('document.fonts ? document.fonts.ready : Promise.resolve()')
      const pdf = await exportWindow.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: { top: 0.55, bottom: 0.55, left: 0.6, right: 0.6 },
        preferCSSPageSize: true,
      })
      await fs.writeFile(path.resolve(filePath), pdf)
      return { status: 'saved', path: path.resolve(filePath) }
    } finally {
      exportWindow.destroy()
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
  ipcMain.handle('session:save', (_event, tabs) => enqueueRecovery(() => saveRecoverySession(tabs)))
  ipcMain.handle('session:clear', () => enqueueRecovery(() => fs.unlink(sessionFilePath()).catch(() => {})))

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

  ipcMain.handle('shell:show-item', (_event, filePath) => {
    if (filePath) shell.showItemInFolder(filePath)
  })

  ipcMain.handle('shell:open-external', (_event, url) => {
    if (typeof url === 'string' && url.length <= 2048 && /^(?:https?:\/\/|mailto:)/i.test(url)) return shell.openExternal(url)
    return false
  })

  ipcMain.handle('find:start', (event, text, options) => {
    if (!text) return null
    return event.sender.findInPage(text, options)
  })

  ipcMain.on('find:stop', (event, action = 'clearSelection') => event.sender.stopFindInPage(action))

  ipcMain.on('external-open:ready', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) rendererReadyWindows.add(window)
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
  if (!bootstrapReady) return
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
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
    },
  })
  const contents = window.webContents

  contents.setWindowOpenHandler(({ url }) => {
    if (/^(?:https?:\/\/|mailto:)/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    const current = contents.getURL()
    if (url !== current) event.preventDefault()
  })
  contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  contents.on('did-start-loading', () => {
    rendererReadyWindows.delete(window)
    closeSafetyReadyWindows.delete(window)
    rejectExternalDeliveries(contents)
    externalOpenCoordinator.setRendererUnavailable(contents)
  })
  contents.on('render-process-gone', () => {
    rendererReadyWindows.delete(window)
    closeSafetyReadyWindows.delete(window)
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
    rendererReadyWindows.delete(window)
    closeSafetyReadyWindows.delete(window)
    rejectExternalDeliveries(contents)
    externalOpenCoordinator.setRendererUnavailable(contents)
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
