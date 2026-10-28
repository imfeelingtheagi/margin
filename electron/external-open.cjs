const path = require('node:path')
const supportedDocumentExtensions = new Set(['.md', '.markdown', '.mdown', '.mkd', '.txt'])

function isWindowsAbsolutePath(value) {
  return /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value)
}

function resolveExternalPath(value, cwd = process.cwd()) {
  return isWindowsAbsolutePath(value) ? path.win32.resolve(value) : path.resolve(cwd, value)
}

function extractExternalFilePaths(argv, { isPackaged, cwd = process.cwd() }) {
  if (!Array.isArray(argv)) return []
  const firstUserArgument = isPackaged ? 1 : 2
  return normalizeExternalFilePaths(argv.slice(firstUserArgument), cwd)
}

function normalizeExternalFilePaths(candidates, cwd = process.cwd()) {
  const seen = new Set()
  const paths = []

  for (const argument of candidates || []) {
    if (typeof argument !== 'string' || !argument || argument === '--') continue
    const windowsAbsolute = isWindowsAbsolutePath(argument)
    if (argument.startsWith('-') || (!windowsAbsolute && /^[a-z][a-z\d+.-]*:/i.test(argument))) continue
    const resolved = resolveExternalPath(argument, cwd)
    const pathFlavor = windowsAbsolute ? path.win32 : path
    if (!supportedDocumentExtensions.has(pathFlavor.extname(resolved).toLowerCase())) continue
    const key = process.platform === 'win32' || windowsAbsolute ? resolved.toLowerCase() : resolved
    if (seen.has(key)) continue
    seen.add(key)
    paths.push(resolved)
  }

  return paths
}

async function readDocumentsSettled(filePaths, readDocument, {
  maxFiles = 100,
  concurrency = 3,
  maxTotalBytes = 100 * 1024 * 1024,
} = {}) {
  const candidates = Array.isArray(filePaths) ? filePaths.slice(0, maxFiles) : []
  const results = new Array(candidates.length)
  let cursor = 0
  let totalBytes = 0

  const worker = async () => {
    while (cursor < candidates.length) {
      const index = cursor
      cursor += 1
      const filePath = candidates[index]
      try {
        const document = await readDocument(filePath)
        const bytes = typeof document?.content === 'string' ? Buffer.byteLength(document.content, 'utf8') : 0
        if (bytes > maxTotalBytes - totalBytes) {
          results[index] = { error: new Error('The selected files exceed Margin’s 100 MB open-batch limit.') }
          continue
        }
        totalBytes += bytes
        results[index] = { document }
      } catch (error) {
        results[index] = { error }
      }
    }
  }

  const workerCount = Math.max(1, Math.min(8, concurrency, candidates.length || 1))
  await Promise.all(Array.from({ length: workerCount }, worker))
  const documents = []
  const errors = []
  results.forEach((result, index) => {
    if (result?.document) documents.push(result.document)
    else errors.push({
      path: candidates[index],
      message: result?.error instanceof Error ? result.error.message : 'The document could not be opened.',
    })
  })
  if (filePaths.length > candidates.length) {
    errors.push({
      path: '',
      message: `${filePaths.length - candidates.length} additional document${filePaths.length - candidates.length === 1 ? ' was' : 's were'} skipped. Open batches are limited to ${maxFiles} files.`,
    })
  }
  return { documents, errors }
}

function resolveLinkedDocumentPath(documentPath, href) {
  if (typeof documentPath !== 'string' || typeof href !== 'string' || !href) {
    throw new Error('This document link is invalid.')
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) throw new Error('This link is not a local document.')
  let decoded
  try {
    decoded = decodeURIComponent(href.split('#')[0].split('?')[0])
  } catch {
    throw new Error('This document link contains invalid characters.')
  }
  if (!decoded || path.isAbsolute(decoded)) throw new Error('Only relative document links can be opened.')

  const root = path.dirname(path.resolve(documentPath))
  const resolved = path.resolve(root, decoded)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Links outside this document folder are blocked.')
  }
  if (!supportedDocumentExtensions.has(path.extname(resolved).toLowerCase())) {
    throw new Error('Margin can only open Markdown or plain-text document links.')
  }
  return resolved
}

function createExternalOpenCoordinator({
  readDocument,
  deliver,
  requestAttention = () => {},
  debounceMs = 20,
  maxQueuedPaths = 100,
}) {
  const queuedPaths = []
  const queuedKeys = new Set()
  let readyTarget = null
  let flushTimer = null
  let inFlight = null
  let droppedCount = 0

  const keyFor = (filePath) => {
    const resolved = resolveExternalPath(filePath)
    return process.platform === 'win32' || isWindowsAbsolutePath(filePath) ? resolved.toLowerCase() : resolved
  }

  const requeueFront = (filePaths) => {
    for (let index = filePaths.length - 1; index >= 0; index -= 1) {
      const filePath = filePaths[index]
      const key = keyFor(filePath)
      if (queuedKeys.has(key)) continue
      queuedKeys.add(key)
      queuedPaths.unshift(filePath)
    }
  }

  const scheduleFlush = () => {
    if (!readyTarget || queuedPaths.length === 0 || flushTimer || inFlight) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flush().catch(() => {})
    }, debounceMs)
  }

  const enqueue = (filePaths) => {
    let added = false
    for (const candidate of filePaths || []) {
      if (typeof candidate !== 'string' || !candidate) continue
      const resolved = resolveExternalPath(candidate)
      const key = keyFor(resolved)
      if (queuedKeys.has(key)) continue
      if (queuedPaths.length >= maxQueuedPaths) {
        droppedCount += 1
        continue
      }
      queuedKeys.add(key)
      queuedPaths.push(resolved)
      added = true
    }
    if (added) requestAttention()
    scheduleFlush()
    return added
  }

  const setRendererReady = (target) => {
    readyTarget = target
    scheduleFlush()
  }

  const setRendererUnavailable = (target) => {
    if (!target || target === readyTarget) readyTarget = null
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
  }

  async function flush() {
    if (inFlight) return inFlight
    if (!readyTarget || queuedPaths.length === 0) return null

    const target = readyTarget
    const batch = queuedPaths.splice(0)
    const droppedInBatch = droppedCount
    droppedCount = 0
    batch.forEach((filePath) => queuedKeys.delete(keyFor(filePath)))

    inFlight = (async () => {
      const payload = await readDocumentsSettled(batch, readDocument)
      if (droppedInBatch) payload.errors.push({
        path: '',
        message: `${droppedInBatch} additional document${droppedInBatch === 1 ? ' was' : 's were'} skipped. External open batches are limited to ${maxQueuedPaths} files.`,
      })
      if (target !== readyTarget) {
        requeueFront(batch)
        return null
      }
      try {
        await deliver(target, payload)
        return payload
      } catch (error) {
        requeueFront(batch)
        setRendererUnavailable(target)
        throw error
      }
    })()

    try {
      return await inFlight
    } finally {
      inFlight = null
      scheduleFlush()
    }
  }

  const destroy = () => {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    readyTarget = null
  }

  return {
    enqueue,
    setRendererReady,
    setRendererUnavailable,
    flush,
    destroy,
    pendingCount: () => queuedPaths.length,
  }
}

module.exports = {
  createExternalOpenCoordinator,
  extractExternalFilePaths,
  normalizeExternalFilePaths,
  readDocumentsSettled,
  resolveLinkedDocumentPath,
}
