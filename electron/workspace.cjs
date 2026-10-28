const fs = require('node:fs/promises')
const path = require('node:path')

const SUPPORTED_DOCUMENT_EXTENSIONS = Object.freeze([
  '.md', '.markdown', '.mdown', '.mkd', '.txt',
])
const SUPPORTED_DOCUMENT_EXTENSION_SET = new Set(SUPPORTED_DOCUMENT_EXTENSIONS)
const DEFAULT_IGNORED_DIRECTORIES = Object.freeze([
  '.git', '.hg', '.svn', 'node_modules',
])
const DEFAULT_LIMITS = Object.freeze({
  maxRelativePathLength: 4096,
  maxDirectoryEntries: 2000,
  maxWalkEntries: 50_000,
  maxWalkDepth: 64,
  maxDocuments: 10_000,
  maxQueryLength: 256,
  maxSearchFileBytes: 5 * 1024 * 1024,
  maxSearchTotalBytes: 512 * 1024 * 1024,
  maxSearchMatches: 200,
  maxMatchesPerFile: 20,
  maxExcerptLength: 240,
  maxBuffers: 100,
  maxBufferBytes: 50 * 1024 * 1024,
})

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

function policyError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  const error = new Error('The workspace operation was cancelled.')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  throw error
}

function boundedLimit(value, fallback, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) return fallback
  return Math.min(value, fallback)
}

function limitsFrom(options = {}) {
  const provided = options.limits && typeof options.limits === 'object' ? options.limits : options
  return Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([name, fallback]) => [
    name,
    boundedLimit(provided[name], fallback),
  ]))
}

function ignoredDirectoriesFrom(options = {}) {
  const ignored = new Set(DEFAULT_IGNORED_DIRECTORIES.map((name) => name.toLocaleLowerCase('en')))
  if (Array.isArray(options.ignoredDirectories)) {
    for (const name of options.ignoredDirectories) {
      if (typeof name === 'string' && name && !name.includes('/') && !name.includes('\\')) {
        ignored.add(name.toLocaleLowerCase('en'))
      }
    }
  }
  return ignored
}

function isSupportedDocumentPath(filePath) {
  return typeof filePath === 'string'
    && SUPPORTED_DOCUMENT_EXTENSION_SET.has(path.extname(filePath).toLocaleLowerCase('en'))
}

/**
 * Normalize an untrusted renderer path to the portable, slash-separated form
 * used by workspace IPC. Both slash styles are treated as separators so input
 * cannot be safe on one platform and traversal on another.
 */
function normalizeWorkspaceRelativePath(value, { allowRoot = false } = {}) {
  if (typeof value !== 'string') throw policyError('ERR_WORKSPACE_PATH', 'Workspace paths must be strings.')
  if (value.length > DEFAULT_LIMITS.maxRelativePathLength) {
    throw policyError('ERR_WORKSPACE_PATH', 'The workspace path is too long.')
  }
  if (value.includes('\0')) throw policyError('ERR_WORKSPACE_PATH', 'The workspace path contains an invalid character.')
  if (!value) {
    if (allowRoot) return ''
    throw policyError('ERR_WORKSPACE_PATH', 'A workspace-relative path is required.')
  }
  if (
    path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || /^[a-z]:/i.test(value)
    || /^[/\\]{2}/.test(value)
    || /^[a-z][a-z\d+.-]*:/i.test(value)
  ) {
    throw policyError('ERR_WORKSPACE_PATH', 'Absolute paths and URLs are not valid workspace entries.')
  }

  const portable = value.replace(/\\/g, '/')
  const segments = portable.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw policyError('ERR_WORKSPACE_PATH', 'Workspace paths cannot contain empty or parent-directory segments.')
  }
  return segments.join('/')
}

function isPathInsideRoot(rootPath, candidatePath) {
  if (typeof rootPath !== 'string' || typeof candidatePath !== 'string') return false
  const root = path.resolve(rootPath)
  const candidate = path.resolve(candidatePath)
  const relative = path.relative(root, candidate)
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  )
}

async function resolveWorkspaceRoot(rootPath, { signal } = {}) {
  throwIfAborted(signal)
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || rootPath.includes('\0')) {
    throw policyError('ERR_WORKSPACE_ROOT', 'The workspace root must be an absolute path.')
  }
  let canonicalRoot
  try {
    canonicalRoot = await fs.realpath(rootPath)
  } catch {
    throw policyError('ERR_WORKSPACE_ROOT', 'The workspace folder does not exist or cannot be accessed.')
  }
  throwIfAborted(signal)
  const stat = await fs.lstat(canonicalRoot)
  if (!stat.isDirectory()) throw policyError('ERR_WORKSPACE_ROOT', 'The workspace root is not a directory.')
  return canonicalRoot
}

function nativePathFromRelative(canonicalRoot, relativePath) {
  if (!relativePath) return canonicalRoot
  return path.join(canonicalRoot, ...relativePath.split('/'))
}

async function resolveFromCanonicalRoot(canonicalRoot, relativePath, expectedKind = 'any', signal) {
  throwIfAborted(signal)
  const normalized = normalizeWorkspaceRelativePath(relativePath, { allowRoot: expectedKind === 'directory' })
  const segments = normalized ? normalized.split('/') : []
  let candidate = canonicalRoot

  for (let index = 0; index < segments.length; index += 1) {
    throwIfAborted(signal)
    candidate = path.join(candidate, segments[index])
    let componentStat
    try {
      componentStat = await fs.lstat(candidate)
    } catch {
      throw policyError('ERR_WORKSPACE_MISSING', 'The workspace entry does not exist or cannot be accessed.')
    }
    if (componentStat.isSymbolicLink()) {
      throw policyError('ERR_WORKSPACE_SYMLINK', 'Symbolic links and junctions are not followed inside a workspace.')
    }
    if (index < segments.length - 1 && !componentStat.isDirectory()) {
      throw policyError('ERR_WORKSPACE_PATH', 'A workspace path component is not a directory.')
    }
  }

  throwIfAborted(signal)
  let canonicalPath
  try {
    canonicalPath = await fs.realpath(candidate)
  } catch {
    throw policyError('ERR_WORKSPACE_MISSING', 'The workspace entry does not exist or cannot be accessed.')
  }
  if (!isPathInsideRoot(canonicalRoot, canonicalPath)) {
    throw policyError('ERR_WORKSPACE_ESCAPE', 'The workspace entry resolves outside the selected folder.')
  }
  const stat = await fs.lstat(canonicalPath)
  let kind
  if (stat.isDirectory()) kind = 'directory'
  else if (stat.isFile() && isSupportedDocumentPath(canonicalPath)) kind = 'document'
  else if (stat.isFile()) kind = 'file'
  else kind = 'other'

  if (expectedKind === 'directory' && kind !== 'directory') {
    throw policyError('ERR_WORKSPACE_KIND', 'The workspace entry is not a directory.')
  }
  if (expectedKind === 'document' && kind !== 'document') {
    throw policyError('ERR_WORKSPACE_KIND', 'The workspace entry is not a supported Markdown or text document.')
  }
  if (expectedKind === 'file' && kind !== 'file' && kind !== 'document') {
    throw policyError('ERR_WORKSPACE_KIND', 'The workspace entry is not a regular file.')
  }
  if (!['any', 'directory', 'document', 'file'].includes(expectedKind)) {
    throw policyError('ERR_WORKSPACE_KIND', 'The requested workspace entry kind is invalid.')
  }

  return {
    rootPath: canonicalRoot,
    path: canonicalPath,
    relativePath: normalized,
    name: normalized ? normalized.split('/').at(-1) : path.basename(canonicalRoot),
    kind,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  }
}

async function resolveWorkspaceEntry(rootPath, relativePath, expectedKind = 'any', options = {}) {
  const canonicalRoot = await resolveWorkspaceRoot(rootPath, options)
  return resolveFromCanonicalRoot(canonicalRoot, relativePath, expectedKind, options.signal)
}

function childRelativePath(parent, name) {
  // A backslash is a legal POSIX filename character, but IPC treats both slash
  // styles as separators. Skipping it avoids representing two different files
  // with the same portable path on different operating systems.
  if (!name || name.includes('/') || name.includes('\\') || name.includes('\0')) return null
  const candidate = parent ? `${parent}/${name}` : name
  try {
    return normalizeWorkspaceRelativePath(candidate)
  } catch {
    return null
  }
}

async function scanDirectory(canonicalRoot, relativeDirectory, options, budget) {
  const signal = options.signal
  const directory = await resolveFromCanonicalRoot(canonicalRoot, relativeDirectory, 'directory', signal)
  const entries = []
  let exhausted = true
  let handle
  try {
    handle = await fs.opendir(directory.path)
    for await (const dirent of handle) {
      throwIfAborted(signal)
      budget.visited += 1
      if (budget.visited > budget.maximum) {
        exhausted = false
        break
      }
      if (dirent.isSymbolicLink()) continue
      const relativePath = childRelativePath(relativeDirectory, dirent.name)
      if (!relativePath) continue
      if (dirent.isDirectory()) {
        if (options.ignoredDirectories.has(dirent.name.toLocaleLowerCase('en'))) continue
        try {
          const resolved = await resolveFromCanonicalRoot(canonicalRoot, relativePath, 'directory', signal)
          entries.push({ name: dirent.name, relativePath, kind: 'directory', path: resolved.path })
        } catch (error) {
          if (error?.name === 'AbortError') throw error
        }
        continue
      }
      if (!dirent.isFile() || !isSupportedDocumentPath(dirent.name)) continue
      try {
        const resolved = await resolveFromCanonicalRoot(canonicalRoot, relativePath, 'document', signal)
        entries.push({
          name: dirent.name,
          relativePath,
          kind: 'document',
          path: resolved.path,
          size: resolved.size,
        })
      } catch (error) {
        if (error?.name === 'AbortError') throw error
      }
    }
  } finally {
    // A completed `for await` closes the directory automatically. If opening
    // succeeded but iteration failed before it began, close defensively.
    if (handle && typeof handle.close === 'function') await handle.close().catch(() => {})
  }
  entries.sort((left, right) => collator.compare(left.name, right.name) || left.name.localeCompare(right.name))
  return { directory, entries, exhausted }
}

async function listWorkspaceDirectory(rootPath, relativeDirectory = '', options = {}) {
  const limits = limitsFrom(options)
  const canonicalRoot = await resolveWorkspaceRoot(rootPath, options)
  const normalizedDirectory = normalizeWorkspaceRelativePath(relativeDirectory, { allowRoot: true })
  const scan = await scanDirectory(canonicalRoot, normalizedDirectory, {
    signal: options.signal,
    ignoredDirectories: ignoredDirectoriesFrom(options),
  }, { visited: 0, maximum: limits.maxWalkEntries })
  const visible = scan.entries
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
      return collator.compare(left.name, right.name) || left.name.localeCompare(right.name)
    })
  const truncated = !scan.exhausted || visible.length > limits.maxDirectoryEntries
  return {
    rootPath: canonicalRoot,
    directory: normalizedDirectory,
    entries: visible.slice(0, limits.maxDirectoryEntries).map(({ name, relativePath, kind }) => ({
      name, relativePath, kind,
    })),
    truncated,
  }
}

async function walkWorkspaceDocuments(rootPath, options = {}) {
  const limits = limitsFrom(options)
  const signal = options.signal
  const canonicalRoot = await resolveWorkspaceRoot(rootPath, { signal })
  const ignoredDirectories = ignoredDirectoriesFrom(options)
  const budget = { visited: 0, maximum: limits.maxWalkEntries }
  const stack = [{ relativePath: '', path: canonicalRoot, depth: 0 }]
  const documents = []
  let scannedFiles = 0
  let truncated = false

  while (stack.length) {
    throwIfAborted(signal)
    const current = stack.pop()
    if (current.depth > limits.maxWalkDepth) {
      truncated = true
      continue
    }
    const scan = await scanDirectory(canonicalRoot, current.relativePath, {
      signal,
      ignoredDirectories,
    }, budget)
    if (!scan.exhausted) {
      truncated = true
      break
    }

    // Stack in reverse lexical order so traversal itself is deterministic and
    // depth-first in ascending portable-path order.
    for (let index = scan.entries.length - 1; index >= 0; index -= 1) {
      const entry = scan.entries[index]
      if (entry.kind === 'directory') {
        stack.push({ relativePath: entry.relativePath, path: entry.path, depth: current.depth + 1 })
        continue
      }
      scannedFiles += 1
      documents.push(entry)
    }
  }

  documents.sort((left, right) => collator.compare(left.relativePath, right.relativePath)
    || left.relativePath.localeCompare(right.relativePath))
  if (documents.length > limits.maxDocuments) truncated = true
  return {
    rootPath: canonicalRoot,
    documents: documents.slice(0, limits.maxDocuments),
    scannedFiles,
    truncated,
  }
}

async function listWorkspaceDocuments(rootPath, options = {}) {
  const result = await walkWorkspaceDocuments(rootPath, options)
  return {
    rootPath: result.rootPath,
    documents: result.documents.map((document) => document.relativePath),
    scannedFiles: result.scannedFiles,
    truncated: result.truncated,
  }
}

async function readStableFile(filePath, maximumBytes, signal) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    throwIfAborted(signal)
    const handle = await fs.open(filePath, 'r')
    try {
      const before = await handle.stat()
      if (!before.isFile()) throw policyError('ERR_WORKSPACE_KIND', 'The search entry is not a regular file.')
      if (before.size > maximumBytes) throw policyError('ERR_WORKSPACE_TOO_LARGE', 'The search entry is too large.')
      const buffer = Buffer.allocUnsafe(before.size)
      let offset = 0
      while (offset < buffer.length) {
        throwIfAborted(signal)
        const { bytesRead } = await handle.read(buffer, offset, Math.min(buffer.length - offset, 256 * 1024), offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      const after = await handle.stat()
      if (
        offset === buffer.length
        && before.size === after.size
        && before.mtimeMs === after.mtimeMs
        && before.ctimeMs === after.ctimeMs
      ) return buffer
    } finally {
      await handle.close()
    }
  }
  throw policyError('ERR_WORKSPACE_CHANGED', 'The search entry changed while it was being read.')
}

function isWordCharacter(character) {
  return Boolean(character) && /[\p{L}\p{N}_]/u.test(character)
}

function isWholeWordMatch(line, index, length, query) {
  const queryFirst = query[0]
  const queryLast = query.at(-1)
  if (isWordCharacter(queryFirst) && isWordCharacter(line[index - 1])) return false
  if (isWordCharacter(queryLast) && isWordCharacter(line[index + length])) return false
  return true
}

function excerptForMatch(line, index, matchLength, maximumLength) {
  maximumLength = Math.max(maximumLength, matchLength)
  if (line.length <= maximumLength) {
    return { excerpt: line, matchStart: index }
  }
  let start = Math.max(0, index - Math.floor((maximumLength - Math.min(matchLength, maximumLength)) / 2))
  let end = Math.min(line.length, start + maximumLength)
  start = Math.max(0, end - maximumLength)
  let prefix = start > 0 ? '…' : ''
  let suffix = end < line.length ? '…' : ''
  while (end - start + prefix.length + suffix.length > maximumLength) {
    if (end > index + matchLength) end -= 1
    else if (start < index) start += 1
    else break
    prefix = start > 0 ? '…' : ''
    suffix = end < line.length ? '…' : ''
  }
  return {
    excerpt: `${prefix}${line.slice(start, end)}${suffix}`,
    matchStart: prefix.length + index - start,
  }
}

function escapeRegularExpression(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

function searchText(relativePath, content, query, request, limits, source) {
  const matches = []
  // The expression is a fully escaped literal. Using the engine only for
  // Unicode-aware case matching preserves source-string indices without
  // exposing the regex/ReDoS surface of user-authored expressions.
  const matcher = new RegExp(escapeRegularExpression(query), request.caseSensitive ? 'gu' : 'giu')
  const lines = content.replace(/^\uFEFF/, '').split('\n')

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex].endsWith('\r') ? lines[lineIndex].slice(0, -1) : lines[lineIndex]
    matcher.lastIndex = 0
    let match
    while ((match = matcher.exec(line))) {
      const index = match.index
      const matchLength = match[0].length
      if (request.wholeWord && !isWholeWordMatch(line, index, matchLength, match[0])) continue
      if (matches.length >= limits.maxMatchesPerFile) return { matches, truncated: true }
      const preview = excerptForMatch(line, index, matchLength, limits.maxExcerptLength)
      matches.push({
        relativePath,
        name: relativePath.split('/').at(-1),
        line: lineIndex + 1,
        column: index + 1,
        excerpt: preview.excerpt,
        matchStart: preview.matchStart,
        matchLength,
        source,
      })
    }
  }
  return { matches, truncated: false }
}

function normalizeBuffers(buffers, limits) {
  if (buffers == null) return new Map()
  if (!Array.isArray(buffers)) throw policyError('ERR_WORKSPACE_SEARCH', 'Search buffers must be an array.')
  if (buffers.length > limits.maxBuffers) throw policyError('ERR_WORKSPACE_SEARCH', 'Too many open buffers were supplied for workspace search.')
  const normalized = new Map()
  let totalBytes = 0
  for (const buffer of buffers) {
    if (!buffer || typeof buffer !== 'object' || typeof buffer.content !== 'string') {
      throw policyError('ERR_WORKSPACE_SEARCH', 'A workspace search buffer is invalid.')
    }
    const relativePath = normalizeWorkspaceRelativePath(buffer.relativePath)
    if (!isSupportedDocumentPath(relativePath)) {
      throw policyError('ERR_WORKSPACE_SEARCH', 'Workspace search buffers must be supported Markdown or text documents.')
    }
    totalBytes += Buffer.byteLength(buffer.content, 'utf8')
    if (totalBytes > limits.maxBufferBytes) {
      throw policyError('ERR_WORKSPACE_SEARCH', 'The open buffers are too large for workspace search.')
    }
    normalized.set(relativePath, buffer.content)
  }
  return normalized
}

function normalizeExcludedPaths(paths, limits) {
  if (paths == null) return new Set()
  if (!Array.isArray(paths) || paths.length > limits.maxBuffers) {
    throw policyError('ERR_WORKSPACE_SEARCH', 'Too many excluded open buffers were supplied for workspace search.')
  }
  const normalized = new Set()
  for (const value of paths) {
    const relativePath = normalizeWorkspaceRelativePath(value)
    if (!isSupportedDocumentPath(relativePath)) {
      throw policyError('ERR_WORKSPACE_SEARCH', 'Excluded workspace buffers must be supported Markdown or text documents.')
    }
    normalized.add(relativePath)
  }
  return normalized
}

async function searchWorkspace(rootPath, request, options = {}) {
  const limits = limitsFrom(options)
  const signal = options.signal
  throwIfAborted(signal)
  if (!request || typeof request !== 'object' || typeof request.query !== 'string') {
    throw policyError('ERR_WORKSPACE_SEARCH', 'A literal workspace search query is required.')
  }
  if (request.query.length > limits.maxQueryLength) {
    throw policyError('ERR_WORKSPACE_SEARCH', 'The workspace search query is too long.')
  }
  const query = request.query
  const canonicalRoot = await resolveWorkspaceRoot(rootPath, { signal })
  const buffers = normalizeBuffers(request.buffers, limits)
  const excludedPaths = normalizeExcludedPaths(request.excludedPaths, limits)
  const emptyResult = {
    rootPath: canonicalRoot,
    matches: [],
    scannedFiles: 0,
    skippedFiles: excludedPaths.size,
    scannedBytes: 0,
    truncated: excludedPaths.size > 0,
  }
  if (!query.trim()) return emptyResult

  const walked = await walkWorkspaceDocuments(canonicalRoot, { ...options, signal })
  const bufferEntries = [...buffers.keys()].map((relativePath) => ({
    relativePath,
    name: relativePath.split('/').at(-1),
    path: null,
    size: Buffer.byteLength(buffers.get(relativePath), 'utf8'),
  }))
  const bufferPaths = new Set(buffers.keys())
  const diskEntries = walked.documents.filter((document) => !bufferPaths.has(document.relativePath) && !excludedPaths.has(document.relativePath))
  let candidates = [...bufferEntries, ...diskEntries]
  let truncated = walked.truncated || excludedPaths.size > 0
  if (candidates.length > limits.maxDocuments) {
    // Always retain dirty buffers; they are the user's current truth.
    candidates = [...bufferEntries, ...diskEntries.slice(0, Math.max(0, limits.maxDocuments - bufferEntries.length))]
    truncated = true
  }
  candidates.sort((left, right) => collator.compare(left.relativePath, right.relativePath)
    || left.relativePath.localeCompare(right.relativePath))

  const matches = []
  let scannedFiles = 0
  let skippedFiles = excludedPaths.size
  let scannedBytes = 0
  for (const document of candidates) {
    throwIfAborted(signal)
    let content
    let bytes
    let source
    if (buffers.has(document.relativePath)) {
      content = buffers.get(document.relativePath)
      bytes = Buffer.byteLength(content, 'utf8')
      source = 'buffer'
      if (bytes > limits.maxSearchFileBytes) {
        skippedFiles += 1
        continue
      }
    } else {
      source = 'disk'
      if (document.size > limits.maxSearchFileBytes) {
        skippedFiles += 1
        continue
      }
      let raw
      try {
        raw = await readStableFile(document.path, limits.maxSearchFileBytes, signal)
        if (raw.includes(0)) throw policyError('ERR_WORKSPACE_BINARY', 'The search entry appears to be binary.')
        content = new TextDecoder('utf-8', { fatal: true }).decode(raw)
        bytes = raw.length
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        skippedFiles += 1
        continue
      }
    }
    if (scannedBytes + bytes > limits.maxSearchTotalBytes) {
      skippedFiles += 1
      truncated = true
      break
    }
    scannedBytes += bytes
    scannedFiles += 1
    const found = searchText(document.relativePath, content, query, {
      caseSensitive: Boolean(request.caseSensitive),
      wholeWord: Boolean(request.wholeWord),
    }, limits, source)
    if (found.truncated) truncated = true
    const remaining = limits.maxSearchMatches - matches.length
    if (found.matches.length > remaining) truncated = true
    matches.push(...found.matches.slice(0, Math.max(0, remaining)))
    if (matches.length >= limits.maxSearchMatches) {
      truncated = true
      break
    }
  }

  return {
    rootPath: canonicalRoot,
    matches,
    scannedFiles,
    skippedFiles,
    scannedBytes,
    truncated,
  }
}

// A bounded, on-demand snapshot for connected notes. Uses the same capability
// checks as search, never follows symlinks, and does not register files as open.
async function readWorkspaceNotes(rootPath, options = {}) {
  const listing = await listWorkspaceDocuments(rootPath, options)
  const documents = []
  let bytes = 0
  let skippedFiles = 0
  let truncated = listing.truncated
  for (const relativePath of listing.documents) {
    throwIfAborted(options.signal)
    if (documents.length >= 2000 || bytes >= 16 * 1024 * 1024) { truncated = true; break }
    try {
      const entry = await resolveWorkspaceEntry(rootPath, relativePath, 'document', options)
      if (entry.size > 1024 * 1024 || bytes + entry.size > 16 * 1024 * 1024) {
        skippedFiles += 1
        truncated = true
        continue
      }
      const raw = await readStableFile(entry.path, 1024 * 1024, options.signal)
      if (raw.includes(0)) throw new Error('Binary document')
      const content = new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
      bytes += raw.length
      documents.push({ relativePath, content })
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      skippedFiles += 1
    }
  }
  return { documents, skippedFiles, truncated }
}

module.exports = {
  DEFAULT_IGNORED_DIRECTORIES,
  DEFAULT_LIMITS,
  SUPPORTED_DOCUMENT_EXTENSIONS,
  isPathInsideRoot,
  isSupportedDocumentPath,
  listWorkspaceDirectory,
  listWorkspaceDocuments,
  normalizeWorkspaceRelativePath,
  resolveWorkspaceEntry,
  resolveWorkspaceRoot,
  searchWorkspace,
  readWorkspaceNotes,
}
