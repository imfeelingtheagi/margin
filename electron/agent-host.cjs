const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { LIMITS, hash, createOllamaClient, createAgentScope, runAgent, checkAbort } = require('./agent.cjs')
const { isPathInsideRoot, resolveWorkspaceEntry } = require('./workspace.cjs')

const validId = (id) => typeof id === 'string' && /^[a-f\d-]{36}$/i.test(id)
const modes = new Set(['ask', 'summarize', 'extract', 'revise', 'draft', 'connect'])
const MAX_TEXT = 25 * 1024 * 1024
function text(value, maximum = MAX_TEXT) { if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximum) throw new Error('Document text exceeds the Agent desk safety limit.'); return value }

/** Native capabilities, never a general-purpose command or filesystem bridge. */
function createAgentHost({ ipcMain, app, dialog, BrowserWindow, atomicWrite, readDocument, assertOpen, getWorkspace, readWorkspaceNotes,
  client = createOllamaClient() }) {
  const states = new WeakMap()
  const settingsFile = () => path.join(app.getPath('userData'), 'agent-settings.json')
  const historyDirectory = () => path.join(app.getPath('userData'), 'agent-restore-points')
  let settingsQueue = Promise.resolve(), historyQueue = Promise.resolve()
  function state(contents) { if (!states.has(contents)) states.set(contents, { attachments: new Map(), active: null, last: null }); return states.get(contents) }
  function clear(contents) { const current = states.get(contents); current?.active?.controller.abort(); states.delete(contents) }
  async function loadConfiguration() {
    try {
      const stat = await fs.stat(settingsFile())
      if (!stat.isFile() || stat.size > 4096) return { enabled: false, model: '' }
      const value = JSON.parse(await fs.readFile(settingsFile(), 'utf8'))
      return { enabled: value.enabled === true && typeof value.model === 'string' && value.model.length <= 200, model: typeof value.model === 'string' ? value.model.slice(0, 200) : '' }
    } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return { enabled: false, model: '' }; throw error }
  }
  async function ensureHistoryDirectory() {
    await fs.mkdir(historyDirectory(), { recursive: true, mode: 0o700 })
    const stat = await fs.lstat(historyDirectory())
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The agent restore directory is not a safe local directory.')
  }
  async function history() {
    try { await ensureHistoryDirectory() } catch (error) { if (error.code === 'ENOENT') return []; throw error }
    const entries = []
    for (const name of await fs.readdir(historyDirectory())) {
      if (!/^[a-f\d-]{36}\.json$/i.test(name)) continue
      const file = path.join(historyDirectory(), name), stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 52 * 1024 * 1024) continue
      try {
        const item = JSON.parse(await fs.readFile(file, 'utf8'))
        if (validId(item.id) && `${item.id}.json` === name && typeof item.before === 'string' && /^[a-f\d]{64}$/.test(item.afterHash) && Number.isFinite(item.createdAt)) entries.push({ ...item, file, size: stat.size })
      } catch { /* A damaged restore point is not applied or overwritten. */ }
    }
    return entries.sort((a, b) => b.createdAt - a.createdAt)
  }
  const metadata = (item) => ({ id: item.id, path: item.path, tabId: item.tabId, name: item.name, createdAt: item.createdAt, afterHash: item.afterHash })
  async function verifyCurrent(contents, current) {
    if (!current || !validId(current.tabId)) throw new Error('The original document is no longer open.')
    text(current.content); text(current.savedContent)
    if (current.path) {
      assertOpen(contents, current.path)
      const disk = await readDocument(current.path, { register: false })
      if (disk.path !== current.path || disk.content !== current.savedContent || !Number.isFinite(current.mtimeMs) || Math.abs(disk.mtimeMs - current.mtimeMs) > 2) {
        throw new Error('The file changed on disk. Resolve its conflict before applying or undoing an agent change.')
      }
    }
  }
  function register() {
    ipcMain.handle('agent:configuration', () => loadConfiguration())
    ipcMain.handle('agent:configure', (event, input) => {
      const operation = settingsQueue.catch(() => {}).then(async () => {
        if (!input || typeof input.enabled !== 'boolean' || typeof input.model !== 'string' || input.model.length > 200) throw new Error('Invalid Agent desk configuration.')
        const value = { enabled: input.enabled, model: input.model }
        if (value.enabled) await client.validateModel(value.model)
        else state(event.sender).active?.controller.abort()
        await atomicWrite(settingsFile(), JSON.stringify(value))
        return value
      })
      settingsQueue = operation
      return operation
    })
    ipcMain.handle('agent:connection', () => client.inspect())
    ipcMain.handle('agent:attach', async (event) => {
      const current = state(event.sender)
      const selected = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Markdown and text', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] }] })
      if (selected.canceled) return []
      if (current.attachments.size + selected.filePaths.length > 10) throw new Error('Attach at most ten notes. Remove an attachment before adding more.')
      const pending = []
      let size = [...current.attachments.values()].reduce((total, item) => total + item.content.length, 0)
      for (const file of selected.filePaths) {
        const document = await readDocument(file)
        if (document.content.length > 1024 * 1024) throw new Error('Agent attachments are limited to 1 MiB of text each. Select a smaller note.')
        size += document.content.length
        if (size > 4 * 1024 * 1024) throw new Error('Agent attachments exceed the 4 MiB text-memory limit.')
        pending.push({ id: randomUUID(), ...document })
      }
      if (states.get(event.sender) !== current) throw new Error('The document window changed while notes were being attached.')
      for (const item of pending) current.attachments.set(item.id, item)
      return pending.map((item) => ({ id: item.id, path: item.path, name: item.name, characters: item.content.length }))
    })
    ipcMain.on('agent:detach', (event, id) => state(event.sender).attachments.delete(id))
    ipcMain.on('agent:cancel', (event, id) => {
      const current = state(event.sender), active = current.active
      if (active?.id === id) active.controller.abort()
      if (current.last?.id === id) current.last = null
    })
    ipcMain.handle('agent:run', async (event, request) => {
      const contents = event.sender, current = state(contents)
      if (current.active) throw new Error('Stop the current task before starting another.')
      if (!request || !validId(request.taskId) || !modes.has(request.mode) || typeof request.prompt !== 'string' || request.prompt.length > 4000 || !request.prompt.trim()) throw new Error('Invalid Agent desk task.')
      const controller = new AbortController(), signal = controller.signal
      current.active = { id: request.taskId, controller }; current.last = null
      const timeout = setTimeout(() => controller.abort(), LIMITS.taskMs)
      const emit = (item) => { if (!signal.aborted && !contents.isDestroyed() && states.get(contents) === current) contents.send('agent:event', { ...item, taskId: request.taskId }) }
      try {
        const config = await loadConfiguration()
        if (!config.enabled) throw new Error('The Agent desk is disabled. Configure an installed local model first.')
        emit({ type: 'status', message: 'Verifying local-only Ollama and model capabilities…' })
        // This preflight runs before sending a single document character.
        const model = await client.validateModel(config.model, signal)
        const sources = [], attachedIds = request.attachedIds || []
        if (!Array.isArray(attachedIds) || attachedIds.length > 10) throw new Error('Invalid attachment scope.')
        let target = null, originalTarget = null
        if (request.target) {
          const item = request.target
          if (!validId(item.tabId) || typeof item.name !== 'string' || item.name.length > 512) throw new Error('Invalid current document.')
          text(item.content); text(item.savedContent)
          if (item.path) assertOpen(contents, item.path)
          if (!Number.isSafeInteger(item.from) || !Number.isSafeInteger(item.to) || item.from < 0 || item.to < item.from || item.to > item.content.length) throw new Error('The selected range is invalid.')
          const selectedText = typeof request.selectionText === 'string' ? text(request.selectionText, 40_000) : null
          const before = selectedText ?? item.content.slice(item.from, item.to)
          const rawTarget = !selectedText || before === item.content.slice(item.from, item.to)
          sources.push({ name: item.name, path: item.path, tabId: item.tabId, content: before,
            lineOffset: item.content.slice(0, item.from).split('\n').length - 1, initial: true, selection: before !== item.content, documentHash: hash(item.content) })
          originalTarget = { ...item }
          if (['revise', 'connect'].includes(request.mode)) {
            if (!rawTarget) throw new Error('For an exact replacement, select the Markdown source in Edit or Live mode. You can still ask about this rendered selection.')
            if (before.length > 12_000 || before.length > model.characters / 2) throw new Error('Select a shorter passage to revise. This local model needs room for the source and its replacement.')
            target = { ...item, before }
          }
        }
        if (['revise', 'connect'].includes(request.mode) && !target) throw new Error('Open a document or select a passage to revise first.')
        for (const id of [...new Set(attachedIds)]) {
          const attached = current.attachments.get(id)
          if (!attached) throw new Error('An attached note is no longer permitted. Attach it again.')
          sources.push({ name: attached.name, path: attached.path, content: attached.content, initial: true })
        }
        if (request.workspaceId) {
          const workspace = getWorkspace(contents)
          if (!workspace || workspace.id !== request.workspaceId) throw new Error('The attached folder changed. Choose its scope again.')
          emit({ type: 'status', message: 'Taking a bounded snapshot of the folder you attached…' })
          const snapshot = await readWorkspaceNotes(workspace.rootPath, { signal })
          checkAbort(signal)
          if (getWorkspace(contents)?.id !== workspace.id) throw new Error('The attached folder changed while it was being read.')
          const notes = new Map(snapshot.documents.map((note) => [note.relativePath, note]))
          let bufferUnits = 0
          if (!Array.isArray(request.buffers) || request.buffers.length > 100) throw new Error('Invalid open-note buffers.')
          for (const buffer of request.buffers) {
            if (typeof buffer.path !== 'string' || !isPathInsideRoot(workspace.rootPath, buffer.path)) continue
            assertOpen(contents, buffer.path)
            const relative = path.relative(workspace.rootPath, buffer.path).split(path.sep).join('/')
            await resolveWorkspaceEntry(workspace.rootPath, relative, 'document', { signal })
            text(buffer.content)
            if (buffer.content.length > 1024 * 1024 || bufferUnits + buffer.content.length > 4 * 1024 * 1024) { notes.delete(relative); snapshot.truncated = true; continue }
            bufferUnits += buffer.content.length
            notes.set(relative, { relativePath: relative, content: buffer.content })
          }
          for (const note of notes.values()) sources.push({ name: path.basename(note.relativePath), relativePath: note.relativePath, path: path.join(workspace.rootPath, note.relativePath), content: note.content })
          if (snapshot.truncated || snapshot.skippedFiles) emit({ type: 'activity', message: 'Folder snapshot is limited', details: 'Large, unsupported, or excess files were skipped. Do not treat the result as a complete notebook audit.' })
        }
        if (!sources.length && request.mode !== 'draft') throw new Error('Attach a note or open a document before asking a document-based question.')
        checkAbort(signal)
        const scope = createAgentScope(sources, { target, maxCharacters: model.characters, limited: sources.length > LIMITS.sources })
        const result = await runAgent({ client, model, prompt: request.prompt, mode: request.mode, scope, signal, emit })
        checkAbort(signal)
        if (states.get(contents) !== current) throw new Error('The document window changed during the task.')
        current.last = { id: request.taskId, result, target: originalTarget, applied: false }
        return result
      } finally { clearTimeout(timeout); if (current.active?.id === request.taskId) current.active = null }
    })
    ipcMain.handle('agent:prepare-apply', (event, taskId, proposalId, document) => {
      const operation = historyQueue.catch(() => {}).then(async () => {
        const last = state(event.sender).last, proposal = last?.result.proposal
        if (!last || last.id !== taskId || !proposal || proposal.id !== proposalId || proposal.kind !== 'edit' || last.applied) throw new Error('This proposal is no longer available. Generate it again.')
        await verifyCurrent(event.sender, document)
        if (proposal.tabId !== document.tabId || proposal.path !== document.path || hash(document.content) !== proposal.baseHash) throw new Error('The document changed after this proposal was generated. Your newer edits were preserved.')
        if (document.content.slice(proposal.from, proposal.to) !== proposal.before) throw new Error('The selected passage changed. Generate a new proposal.')
        const after = document.content.slice(0, proposal.from) + proposal.after + document.content.slice(proposal.to)
        if (Buffer.byteLength(after) > MAX_TEXT) throw new Error('The proposed document exceeds the file safety limit.')
        const checkpoint = { id: randomUUID(), path: document.path, tabId: document.tabId, name: proposal.name, createdAt: Date.now(), before: document.content, afterHash: hash(after) }
        const encoded = JSON.stringify(checkpoint)
        if (Buffer.byteLength(encoded) > 50 * 1024 * 1024) throw new Error('This restore point is too large to store safely. Nothing was applied.')
        await ensureHistoryDirectory()
        await atomicWrite(path.join(historyDirectory(), `${checkpoint.id}.json`), encoded)
        let size = 0, retained = 0
        for (const item of await history()) {
          size += item.size; retained += 1
          if (item.id !== checkpoint.id && (retained > 20 || size > 50 * 1024 * 1024)) await fs.unlink(item.file)
        }
        last.applied = true
        return metadata(checkpoint)
      })
      historyQueue = operation
      return operation
    })
    ipcMain.handle('agent:checkpoints', async () => (await history()).map(metadata))
    ipcMain.handle('agent:restore', async (event, id, document) => {
      if (!validId(id)) throw new Error('Invalid restore point.')
      await verifyCurrent(event.sender, document)
      const checkpoint = (await history()).find((item) => item.id === id)
      if (!checkpoint || checkpoint.path !== document.path || (!document.path && checkpoint.tabId !== document.tabId)) throw new Error('This restore point belongs to a different document.')
      if (hash(document.content) !== checkpoint.afterHash) throw new Error('There are newer edits. Automatic agent undo would overwrite them; use the editor undo history or review a copy instead.')
      return checkpoint.before
    })
  }
  return { register, clear }
}

module.exports = { createAgentHost }
