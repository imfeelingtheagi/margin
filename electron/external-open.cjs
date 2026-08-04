const path = require('node:path')
const supportedDocumentExtensions = new Set(['.md', '.markdown', '.mdown', '.mkd', '.txt'])

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
    if (argument.startsWith('-') || /^[a-z][a-z\d+.-]*:/i.test(argument)) continue
    const resolved = path.resolve(cwd, argument)
    if (!supportedDocumentExtensions.has(path.extname(resolved).toLowerCase())) continue
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    if (seen.has(key)) continue
    seen.add(key)
    paths.push(resolved)
  }

  return paths
}

async function readDocumentsSettled(filePaths, readDocument) {
  const settled = await Promise.allSettled(filePaths.map((filePath) => readDocument(filePath)))
  const documents = []
  const errors = []

  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      documents.push(result.value)
      return
    }
    errors.push({
      path: filePaths[index],
      message: result.reason instanceof Error ? result.reason.message : 'The document could not be opened.',
    })
  })

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
}) {
  const queuedPaths = []
  const queuedKeys = new Set()
  let readyTarget = null
  let flushTimer = null
  let inFlight = null

  const keyFor = (filePath) => {
    const resolved = path.resolve(filePath)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
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
      const resolved = path.resolve(candidate)
      const key = keyFor(resolved)
      if (queuedKeys.has(key)) continue
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
    batch.forEach((filePath) => queuedKeys.delete(keyFor(filePath)))

    inFlight = (async () => {
      const payload = await readDocumentsSettled(batch, readDocument)
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
