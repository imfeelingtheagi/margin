const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')

const isMac = process.platform === 'darwin'
const devUrl = !app.isPackaged && process.env.VITE_DEV_SERVER_URL === 'http://127.0.0.1:5173'
  ? process.env.VITE_DEV_SERVER_URL
  : null
const allowedDocuments = new Set()
const dirtyWindows = new WeakMap()
const forceClosing = new WeakSet()
const documentSaveQueues = new Map()
const internalWriteTimes = new Map()
let recoveryQueue = Promise.resolve()
let mainWindow = null

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
        { label: 'Find and Replace', accelerator: 'CmdOrCtrl+H', click: () => sendCommand('replace') },
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
        { role: 'reload' },
        { role: 'toggleDevTools', visible: Boolean(devUrl) },
        { type: 'separator' },
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

async function readDocument(filePath) {
  const canonicalPath = await canonicalize(filePath)
  const buffer = await fs.readFile(canonicalPath)
  assertMarkdownText(buffer, canonicalPath)
  const stat = await fs.stat(canonicalPath)
  allowedDocuments.add(canonicalPath)
  const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
  const decoded = buffer.toString('utf8').replace(/^\uFEFF/, '')
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
    const dirty = tab.content !== tab.savedContent
    const recoveryContent = documentPath && !dirty ? '' : tab.content
    totalLength += recoveryContent.length
    if (totalLength > 50 * 1024 * 1024) throw new Error('The recovery session is larger than 50 MB.')
    safeTabs.push({
      id: tab.id,
      path: documentPath,
      name: typeof tab.name === 'string' ? tab.name : 'Untitled.md',
      content: recoveryContent,
      dirty,
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
  const raw = await fs.readFile(sessionFilePath(), 'utf8').catch(() => '[]')
  let stored
  try {
    stored = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(stored)) return []
  const restored = []
  for (const item of stored.slice(0, 20)) {
    if (!item || typeof item.id !== 'string' || typeof item.content !== 'string') continue
    if (typeof item.path === 'string') {
      try {
        const disk = await readDocument(item.path)
        const content = item.dirty ? item.content : disk.content
        restored.push({
          id: item.id,
          path: disk.path,
          name: disk.name,
          content,
          savedContent: disk.content,
          mtimeMs: disk.mtimeMs,
          lineEnding: disk.lineEnding,
          bom: disk.bom,
          mode: item.mode === 'edit' ? 'edit' : 'read',
          saveState: content === disk.content ? 'saved' : 'edited',
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
    if (result.canceled) return []
    return Promise.all(result.filePaths.map(readDocument))
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
        const changedSinceExpected = currentStat && Math.abs(currentStat.mtimeMs - request.expectedMtime) > 2
        const isOurPreviousWrite = currentStat && lastInternalWrite != null && Math.abs(currentStat.mtimeMs - lastInternalWrite) <= 2
        if (changedSinceExpected && !isOurPreviousWrite) {
          if (request.silent) return { status: 'conflict', mtimeMs: currentStat.mtimeMs }
          const choice = await dialog.showMessageBox(parent, {
            type: 'warning',
            title: 'This file changed on disk',
            message: `${path.basename(targetPath)} was changed by another application.`,
            detail: 'Overwriting will replace those external changes.',
            buttons: ['Overwrite', 'Save a Copy…', 'Cancel'],
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

  ipcMain.handle('documents:stat', async (_event, filePath) => {
    const canonicalPath = await canonicalize(filePath)
    if (!allowedDocuments.has(canonicalPath)) return null
    const stat = await fs.stat(canonicalPath).catch(() => null)
    return stat ? { mtimeMs: stat.mtimeMs, writable: true } : null
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
    forceClosing.add(window)
    window.close()
  })

  ipcMain.handle('shell:show-item', (_event, filePath) => {
    if (filePath) shell.showItemInFolder(filePath)
  })

  ipcMain.handle('shell:open-external', (_event, url) => {
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url)
    return false
  })

  ipcMain.handle('find:start', (event, text, options) => {
    if (!text) return null
    return event.sender.findInPage(text, options)
  })

  ipcMain.on('find:stop', (event, action = 'clearSelection') => event.sender.stopFindInPage(action))
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    title: 'Margin',
    backgroundColor: '#f5f3ee',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL()
    if (url !== current) event.preventDefault()
  })
  window.on('close', (event) => {
    if (dirtyWindows.get(window) && !forceClosing.has(window)) {
      event.preventDefault()
      window.webContents.send('app-command', 'requestWindowClose')
    }
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  if (devUrl) window.loadURL(devUrl)
  else window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  return window
}

app.whenReady().then(async () => {
  app.setName('Margin')
  await registerIpc()
  buildMenu()
  mainWindow = createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})
