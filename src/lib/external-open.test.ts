import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  createExternalOpenCoordinator,
  extractExternalFilePaths,
  normalizeExternalFilePaths,
  readDocumentsSettled,
  resolveLinkedDocumentPath,
} = require('../../electron/external-open.cjs') as {
  extractExternalFilePaths: (argv: string[], options: { isPackaged: boolean; cwd?: string }) => string[]
  normalizeExternalFilePaths: (paths: unknown, cwd?: string) => string[]
  readDocumentsSettled: <T>(paths: string[], read: (path: string) => Promise<T>, options?: { maxFiles?: number; concurrency?: number; maxTotalBytes?: number }) => Promise<{
    documents: T[]
    errors: Array<{ path: string; message: string }>
  }>
  resolveLinkedDocumentPath: (documentPath: string, href: string) => string
  createExternalOpenCoordinator: (options: {
    readDocument: (path: string) => Promise<unknown>
    deliver: (target: object, payload: unknown) => Promise<void> | void
    requestAttention?: () => void
    debounceMs?: number
    maxQueuedPaths?: number
  }) => {
    enqueue: (paths: string[]) => boolean
    setRendererReady: (target: object) => void
    setRendererUnavailable: (target?: object) => void
    flush: () => Promise<unknown>
    destroy: () => void
    pendingCount: () => number
  }
}

describe('external file argument parsing', () => {
  it('extracts packaged file arguments while ignoring switches and URLs', () => {
    expect(extractExternalFilePaths([
      '/Applications/Margin.app/Contents/MacOS/Margin',
      'Notes/project plan.md',
      '--inspect',
      '-psn_0_12345',
      'https://example.com/note.md',
      'Notes/project plan.md',
      '日本語.md',
    ], { isPackaged: true, cwd: '/Users/example' })).toEqual([
      '/Users/example/Notes/project plan.md',
      '/Users/example/日本語.md',
    ])
  })

  it('skips the Electron executable and project entry in development', () => {
    expect(extractExternalFilePaths([
      '/path/to/electron',
      '/workspace/margin',
      './one.md',
      '/tmp/two.markdown',
    ], { isPackaged: false, cwd: '/workspace/margin' })).toEqual([
      '/workspace/margin/one.md',
      '/tmp/two.markdown',
    ])
  })

  it('validates second-instance payloads and ignores detached switch values', () => {
    expect(normalizeExternalFilePaths([
      '/tmp/note.md',
      '9222',
      '--inspect-port',
      '/tmp/page.html',
      null,
    ], '/workspace')).toEqual(['/tmp/note.md'])
  })

  it('accepts Windows drive and UNC document paths without treating them as URL schemes', () => {
    expect(normalizeExternalFilePaths([
      'C:\\Users\\Example\\Notes\\plan.md',
      'c:\\users\\example\\notes\\PLAN.md',
      '\\\\server\\share\\reference.markdown',
      'file:///C:/Users/Example/Notes/blocked.md',
    ], '/workspace')).toEqual([
      'C:\\Users\\Example\\Notes\\plan.md',
      '\\\\server\\share\\reference.markdown',
    ])
  })
})

describe('settled document reads', () => {
  it('opens valid files even when another file fails', async () => {
    const result = await readDocumentsSettled(['/tmp/good.md', '/tmp/bad.md'], async (filePath: string) => {
      if (filePath.endsWith('bad.md')) throw new Error('Binary file rejected')
      return { path: filePath, content: '# Good' }
    })

    expect(result.documents).toEqual([{ path: '/tmp/good.md', content: '# Good' }])
    expect(result.errors).toEqual([{ path: '/tmp/bad.md', message: 'Binary file rejected' }])
  })

  it('bounds concurrent reads, file count, and retained batch content', async () => {
    let active = 0
    let peak = 0
    const result = await readDocumentsSettled(['/1.md', '/2.md', '/3.md', '/4.md'], async (filePath: string) => {
      active += 1
      peak = Math.max(peak, active)
      await Promise.resolve()
      active -= 1
      return { path: filePath, content: '1234' }
    }, { maxFiles: 3, concurrency: 2, maxTotalBytes: 8 })

    expect(peak).toBeLessThanOrEqual(2)
    expect(result.documents.map((document) => document.path)).toEqual(['/1.md', '/2.md'])
    expect(result.errors).toHaveLength(2)
    expect(result.errors[0].message).toContain('open-batch limit')
    expect(result.errors[1].message).toContain('1 additional document was skipped')
  })
})

describe('relative document links', () => {
  it('resolves Markdown and text files within the source folder', () => {
    expect(resolveLinkedDocumentPath('/notes/index.md', 'details/next.markdown#section')).toBe('/notes/details/next.markdown')
  })

  it('blocks parent traversal, absolute paths, and unsupported file types', () => {
    expect(() => resolveLinkedDocumentPath('/notes/index.md', '../private.md')).toThrow('outside this document folder')
    expect(() => resolveLinkedDocumentPath('/notes/index.md', '/tmp/other.md')).toThrow('relative document links')
    expect(() => resolveLinkedDocumentPath('/notes/index.md', 'script.html')).toThrow('Markdown or plain-text')
  })
})

describe('external open coordinator', () => {
  it('queues before renderer readiness, deduplicates, and preserves order', async () => {
    const delivered: unknown[] = []
    let attentionRequests = 0
    const target = {}
    const coordinator = createExternalOpenCoordinator({
      readDocument: async (filePath: string) => ({ path: filePath }),
      deliver: (_target: object, payload: unknown) => { delivered.push(payload) },
      requestAttention: () => { attentionRequests += 1 },
      debounceMs: 60_000,
    })

    coordinator.enqueue(['/tmp/one.md', '/tmp/two.md', '/tmp/one.md'])
    expect(coordinator.pendingCount()).toBe(2)
    expect(delivered).toEqual([])
    expect(attentionRequests).toBe(1)

    coordinator.setRendererReady(target)
    await coordinator.flush()
    expect(delivered).toEqual([{
      documents: [{ path: '/tmp/one.md' }, { path: '/tmp/two.md' }],
      errors: [],
    }])
    expect(coordinator.pendingCount()).toBe(0)
    coordinator.destroy()
  })

  it('bounds queued external file batches and reports skipped paths', async () => {
    const delivered: any[] = []
    const coordinator = createExternalOpenCoordinator({
      readDocument: async (filePath: string) => ({ path: filePath }),
      deliver: (_target: object, payload: unknown) => { delivered.push(payload) },
      debounceMs: 60_000,
      maxQueuedPaths: 2,
    })
    coordinator.enqueue(['/tmp/1.md', '/tmp/2.md', '/tmp/3.md'])
    expect(coordinator.pendingCount()).toBe(2)
    coordinator.setRendererReady({})
    await coordinator.flush()
    expect(delivered[0].documents).toHaveLength(2)
    expect(delivered[0].errors[0].message).toContain('1 additional document was skipped')
    coordinator.destroy()
  })

  it('requeues an in-flight batch when the renderer reloads', async () => {
    let releaseRead: (() => void) | undefined
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve })
    const oldTarget = {}
    const newTarget = {}
    const delivered: Array<{ target: object; payload: unknown }> = []
    const coordinator = createExternalOpenCoordinator({
      readDocument: async (filePath: string) => {
        await readGate
        return { path: filePath }
      },
      deliver: (target: object, payload: unknown) => { delivered.push({ target, payload }) },
      debounceMs: 60_000,
    })

    coordinator.enqueue(['/tmp/reload.md'])
    coordinator.setRendererReady(oldTarget)
    const firstFlush = coordinator.flush()
    coordinator.setRendererUnavailable(oldTarget)
    releaseRead?.()
    await firstFlush

    expect(delivered).toEqual([])
    expect(coordinator.pendingCount()).toBe(1)
    coordinator.setRendererReady(newTarget)
    await coordinator.flush()
    expect(delivered).toHaveLength(1)
    expect(delivered[0].target).toBe(newTarget)
    coordinator.destroy()
  })

  it('requeues a batch when delivery fails before renderer acknowledgement', async () => {
    let rejectDelivery: ((error: Error) => void) | undefined
    let shouldFail = true
    const firstTarget = {}
    const secondTarget = {}
    const delivered: object[] = []
    const coordinator = createExternalOpenCoordinator({
      readDocument: async (filePath: string) => ({ path: filePath }),
      deliver: (target: object) => {
        if (shouldFail) return new Promise<void>((_resolve, reject) => { rejectDelivery = reject })
        delivered.push(target)
      },
      debounceMs: 60_000,
    })

    coordinator.enqueue(['/tmp/ack.md'])
    coordinator.setRendererReady(firstTarget)
    const firstFlush = coordinator.flush()
    await vi.waitFor(() => expect(rejectDelivery).toBeTypeOf('function'))
    coordinator.setRendererUnavailable(firstTarget)
    rejectDelivery?.(new Error('renderer reloaded'))
    await expect(firstFlush).rejects.toThrow('renderer reloaded')
    expect(coordinator.pendingCount()).toBe(1)

    shouldFail = false
    coordinator.setRendererReady(secondTarget)
    await coordinator.flush()
    expect(delivered).toEqual([secondTarget])
    coordinator.destroy()
  })
})
