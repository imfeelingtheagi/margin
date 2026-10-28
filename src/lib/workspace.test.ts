import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const {
  isPathInsideRoot,
  listWorkspaceDirectory,
  listWorkspaceDocuments,
  normalizeWorkspaceRelativePath,
  resolveWorkspaceEntry,
  resolveWorkspaceRoot,
  searchWorkspace,
  readWorkspaceNotes,
} = require('../../electron/workspace.cjs') as {
  isPathInsideRoot: (root: string, candidate: string) => boolean
  normalizeWorkspaceRelativePath: (value: unknown, options?: { allowRoot?: boolean }) => string
  resolveWorkspaceRoot: (root: string, options?: { signal?: AbortSignal }) => Promise<string>
  resolveWorkspaceEntry: (root: string, relativePath: string, kind?: 'any' | 'directory' | 'document' | 'file', options?: { signal?: AbortSignal }) => Promise<{
    rootPath: string; path: string; relativePath: string; kind: string; size: number
  }>
  listWorkspaceDirectory: (root: string, relativePath?: string, options?: WorkspaceOptions) => Promise<{
    rootPath: string; directory: string; entries: Array<{ name: string; relativePath: string; kind: 'directory' | 'document' }>; truncated: boolean
  }>
  listWorkspaceDocuments: (root: string, options?: WorkspaceOptions) => Promise<{
    rootPath: string; documents: string[]; scannedFiles: number; truncated: boolean
  }>
  searchWorkspace: (root: string, request: {
    query: string; caseSensitive?: boolean; wholeWord?: boolean; buffers?: Array<{ relativePath: string; content: string }>; excludedPaths?: string[]
  }, options?: WorkspaceOptions) => Promise<{
    rootPath: string
    matches: Array<{ relativePath: string; line: number; column: number; excerpt: string; matchStart: number; matchLength: number; source: 'disk' | 'buffer' }>
    scannedFiles: number; skippedFiles: number; scannedBytes: number; truncated: boolean
  }>
  readWorkspaceNotes: (root: string, options?: WorkspaceOptions) => Promise<{ documents: Array<{ relativePath: string; content: string }>; skippedFiles: number; truncated: boolean }>
}

interface WorkspaceOptions {
  signal?: AbortSignal
  ignoredDirectories?: string[]
  limits?: Partial<{
    maxDirectoryEntries: number
    maxWalkEntries: number
    maxWalkDepth: number
    maxDocuments: number
    maxQueryLength: number
    maxSearchFileBytes: number
    maxSearchTotalBytes: number
    maxSearchMatches: number
    maxMatchesPerFile: number
    maxExcerptLength: number
    maxBuffers: number
    maxBufferBytes: number
  }>
}

const temporaryRoots: string[] = []

async function makeWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'margin-workspace-'))
  temporaryRoots.push(root)
  return root
}

async function write(root: string, relativePath: string, content: string | Buffer) {
  const target = path.join(root, relativePath)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
  return target
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('workspace capability paths', () => {
  it('takes a bounded note snapshot without symlinks, binary files, or oversized notes', async () => {
    const root = await makeWorkspace()
    const valid = await write(root, 'notes/one.md', '\uFEFF# One\r\n\r\n[[Two]]')
    await write(root, 'two.md', '# Two')
    await write(root, 'binary.md', Buffer.from([0, 1, 2]))
    await write(root, 'huge.md', 'x'.repeat(1024 * 1024 + 1))
    await fs.symlink(valid, path.join(root, 'linked.md'))
    const result = await readWorkspaceNotes(root)
    expect(result.documents.map((note) => note.relativePath).sort()).toEqual(['notes/one.md', 'two.md'])
    expect(result.documents.find((note) => note.relativePath === 'notes/one.md')?.content).toBe('# One\n\n[[Two]]')
    expect(result.skippedFiles).toBe(2)
    expect(result.truncated).toBe(true)
    const controller = new AbortController(); controller.abort()
    await expect(readWorkspaceNotes(root, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('normalizes portable relative paths and rejects traversal on every platform', () => {
    expect(normalizeWorkspaceRelativePath('chapters\\part 1.md')).toBe('chapters/part 1.md')
    expect(normalizeWorkspaceRelativePath('', { allowRoot: true })).toBe('')

    for (const unsafe of [
      '', '.', '..', '../secret.md', 'notes/../secret.md', 'notes//draft.md',
      '/tmp/secret.md', 'C:\\notes\\secret.md', 'C:secret.md', '\\\\server\\share\\secret.md',
      'file:///tmp/secret.md', 'https://example.test/note.md', `bad\0name.md`,
    ]) {
      expect(() => normalizeWorkspaceRelativePath(unsafe), unsafe).toThrow()
    }
  })

  it('uses separator-aware containment instead of vulnerable string prefixes', async () => {
    const root = await makeWorkspace()
    expect(isPathInsideRoot(root, path.join(root, 'notes', 'one.md'))).toBe(true)
    expect(isPathInsideRoot(root, root)).toBe(true)
    expect(isPathInsideRoot(root, `${root}-other/note.md`)).toBe(false)
  })

  it('requires an existing real directory and rejects symlink components', async () => {
    const root = await makeWorkspace()
    const document = await write(root, 'notes/real.md', '# Real')
    const canonicalDocument = await fs.realpath(document)
    await fs.symlink(path.join(root, 'notes'), path.join(root, 'linked-notes'))
    await fs.symlink(document, path.join(root, 'linked.md'))

    await expect(resolveWorkspaceRoot(path.join(root, 'missing'))).rejects.toThrow('does not exist')
    await expect(resolveWorkspaceEntry(root, 'notes/real.md', 'document')).resolves.toMatchObject({
      path: canonicalDocument,
      relativePath: 'notes/real.md',
      kind: 'document',
    })
    await expect(resolveWorkspaceEntry(root, 'linked-notes/real.md', 'document')).rejects.toMatchObject({ code: 'ERR_WORKSPACE_SYMLINK' })
    await expect(resolveWorkspaceEntry(root, 'linked.md', 'document')).rejects.toMatchObject({ code: 'ERR_WORKSPACE_SYMLINK' })
    await expect(resolveWorkspaceEntry(root, 'notes/real.md', 'directory')).rejects.toMatchObject({ code: 'ERR_WORKSPACE_KIND' })
  })
})

describe('workspace discovery', () => {
  it('lazily lists directories first, natural-sorts names, and filters unsafe or unsupported entries', async () => {
    const root = await makeWorkspace()
    await Promise.all([
      fs.mkdir(path.join(root, 'Chapter 10')),
      fs.mkdir(path.join(root, 'Chapter 2')),
    ])
    await Promise.all([
      write(root, 'b.md', '# B'),
      write(root, 'a.markdown', '# A'),
      write(root, 'image.png', 'not a document'),
      write(root, '.git/hidden.md', 'hidden'),
      write(root, 'node_modules/readme.md', 'dependency'),
    ])
    await fs.symlink(path.join(root, 'a.markdown'), path.join(root, 'linked.md'))

    const result = await listWorkspaceDirectory(root)
    expect(result.entries).toEqual([
      { name: 'Chapter 2', relativePath: 'Chapter 2', kind: 'directory' },
      { name: 'Chapter 10', relativePath: 'Chapter 10', kind: 'directory' },
      { name: 'a.markdown', relativePath: 'a.markdown', kind: 'document' },
      { name: 'b.md', relativePath: 'b.md', kind: 'document' },
    ])
    expect(result.truncated).toBe(false)
  })

  it('recursively enumerates deterministic quick-open paths without following symlinks or ignored trees', async () => {
    const root = await makeWorkspace()
    await Promise.all([
      write(root, 'z.md', 'z'),
      write(root, 'a/part 10.md', 'ten'),
      write(root, 'a/part 2.md', 'two'),
      write(root, 'b/nested/reference.txt', 'ref'),
      write(root, 'b/image.svg', '<svg/>'),
      write(root, '.git/private.md', 'private'),
      write(root, 'node_modules/pkg/readme.md', 'dependency'),
    ])
    await fs.symlink(path.join(root, 'a'), path.join(root, 'linked-a'))

    const result = await listWorkspaceDocuments(root)
    expect(result.documents).toEqual([
      'a/part 2.md',
      'a/part 10.md',
      'b/nested/reference.txt',
      'z.md',
    ])
    expect(result.scannedFiles).toBe(4)
    expect(result.truncated).toBe(false)
  })

  it('reports explicit truncation for bounded directory and recursive listings', async () => {
    const root = await makeWorkspace()
    await Promise.all([
      write(root, 'a/nested.md', 'nested'),
      write(root, 'one.md', '1'),
      write(root, 'two.md', '2'),
    ])

    const direct = await listWorkspaceDirectory(root, '', { limits: { maxDirectoryEntries: 2 } })
    expect(direct.entries).toHaveLength(2)
    expect(direct.truncated).toBe(true)

    const recursive = await listWorkspaceDocuments(root, { limits: { maxDocuments: 2 } })
    expect(recursive.documents).toEqual(['a/nested.md', 'one.md'])
    expect(recursive.scannedFiles).toBe(3)
    expect(recursive.truncated).toBe(true)
  })
})

describe('bounded literal workspace search', () => {
  it('returns exact CRLF line/column/excerpt offsets with case and whole-word controls', async () => {
    const root = await makeWorkspace()
    await write(root, 'notes.md', 'Alpha beta\r\nalphabet soup\r\nβeta ALPHA')

    const broad = await searchWorkspace(root, { query: 'alpha', caseSensitive: false, wholeWord: false })
    expect(broad.matches.map(({ line, column }) => ({ line, column }))).toEqual([
      { line: 1, column: 1 },
      { line: 2, column: 1 },
      { line: 3, column: 6 },
    ])

    const whole = await searchWorkspace(root, { query: 'alpha', caseSensitive: false, wholeWord: true })
    expect(whole.matches.map(({ line, column, matchStart, matchLength }) => ({ line, column, matchStart, matchLength }))).toEqual([
      { line: 1, column: 1, matchStart: 0, matchLength: 5 },
      { line: 3, column: 6, matchStart: 5, matchLength: 5 },
    ])

    const exact = await searchWorkspace(root, { query: 'Alpha', caseSensitive: true, wholeWord: true })
    expect(exact.matches).toHaveLength(1)
    expect(exact.matches[0]).toMatchObject({ relativePath: 'notes.md', line: 1, source: 'disk' })
  })

  it('treats regular-expression metacharacters as literal search text', async () => {
    const root = await makeWorkspace()
    await write(root, 'syntax.md', 'Use a+b, [draft], and *.md literally.')

    await expect(searchWorkspace(root, { query: 'a+b' })).resolves.toMatchObject({
      matches: [{ line: 1, column: 5, matchLength: 3 }],
    })
    await expect(searchWorkspace(root, { query: '[draft]' })).resolves.toMatchObject({
      matches: [{ line: 1, column: 10, matchLength: 7 }],
    })
  })

  it('searches dirty buffers instead of stale disk and includes a missing buffered document', async () => {
    const root = await makeWorkspace()
    await write(root, 'open.md', 'old disk phrase')

    const result = await searchWorkspace(root, {
      query: 'current',
      caseSensitive: false,
      wholeWord: false,
      buffers: [
        { relativePath: 'open.md', content: 'current unsaved phrase' },
        { relativePath: 'deleted.md', content: 'still current in memory' },
      ],
    })
    expect(result.matches.map(({ relativePath, source }) => ({ relativePath, source }))).toEqual([
      { relativePath: 'deleted.md', source: 'buffer' },
      { relativePath: 'open.md', source: 'buffer' },
    ])

    const stale = await searchWorkspace(root, {
      query: 'old disk',
      buffers: [{ relativePath: 'open.md', content: 'current unsaved phrase' }],
    })
    expect(stale.matches).toEqual([])
  })

  it('never falls back to stale disk for dirty buffers omitted by the aggregate size bound', async () => {
    const root = await makeWorkspace()
    await write(root, 'too-large-open.md', 'stale disk needle')

    const result = await searchWorkspace(root, {
      query: 'needle',
      buffers: [],
      excludedPaths: ['too-large-open.md'],
    })
    expect(result.matches).toEqual([])
    expect(result.skippedFiles).toBe(1)
    expect(result.truncated).toBe(true)
  })

  it('skips binary, invalid UTF-8, oversized, ignored, and symlinked files', async () => {
    const root = await makeWorkspace()
    await Promise.all([
      write(root, 'good.md', 'needle'),
      write(root, 'binary.md', Buffer.from([0x6e, 0x00, 0x65])),
      write(root, 'invalid.md', Buffer.from([0xc3, 0x28])),
      write(root, 'large.md', 'needle '.repeat(20)),
      write(root, '.git/hidden.md', 'needle'),
    ])
    await fs.symlink(path.join(root, 'good.md'), path.join(root, 'linked.md'))

    const result = await searchWorkspace(root, { query: 'needle' }, {
      limits: { maxSearchFileBytes: 32 },
    })
    expect(result.matches.map((match) => match.relativePath)).toEqual(['good.md'])
    expect(result.scannedFiles).toBe(1)
    expect(result.skippedFiles).toBe(3)
  })

  it('bounds matches and excerpts and reports truncation', async () => {
    const root = await makeWorkspace()
    await write(root, 'many.md', `${'x'.repeat(80)} needle ${'y'.repeat(80)} needle`)
    await write(root, 'more.md', 'needle')

    const result = await searchWorkspace(root, { query: 'needle' }, {
      limits: { maxSearchMatches: 2, maxMatchesPerFile: 1, maxExcerptLength: 48 },
    })
    expect(result.matches).toHaveLength(2)
    expect(result.matches.every((match) => match.excerpt.length <= 48)).toBe(true)
    expect(result.matches.every((match) => match.excerpt.slice(match.matchStart, match.matchStart + match.matchLength) === 'needle')).toBe(true)
    expect(result.truncated).toBe(true)
  })

  it('validates buffer/query bounds and supports AbortSignal cancellation', async () => {
    const root = await makeWorkspace()
    await write(root, 'note.md', 'needle')
    const controller = new AbortController()
    controller.abort()

    await expect(searchWorkspace(root, { query: 'needle' }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' })
    await expect(searchWorkspace(root, { query: 'toolong' }, { limits: { maxQueryLength: 3 } })).rejects.toMatchObject({ code: 'ERR_WORKSPACE_SEARCH' })
    await expect(searchWorkspace(root, {
      query: 'x',
      buffers: [{ relativePath: '../escape.md', content: 'x' }],
    })).rejects.toMatchObject({ code: 'ERR_WORKSPACE_PATH' })
  })
})
