// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
const require = createRequire(import.meta.url)
const { createAgentHost } = require('../../electron/agent-host.cjs')
const temporary: string[] = []
afterEach(async () => { for (const directory of temporary.splice(0)) await fs.rm(directory, { recursive: true, force: true }) })

async function setup(options: { failCheckpoint?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'margin-agent-broker-')); temporary.push(root)
  const profile = path.join(root, 'profile'); await fs.mkdir(profile)
  const documentPath = path.join(root, 'Note.md'); const original = '# Note\n\nOriginal text.'; await fs.writeFile(documentPath, original)
  const handlers = new Map<string, (...args: any[]) => any>(), events = new Map<string, (...args: any[]) => void>()
  const messages: any[] = []
  const sender = { send: (_channel: string, item: unknown) => messages.push(item), isDestroyed: () => false }
  const event = { sender }, tabId = randomUUID()
  const calls: string[] = []
  const client = {
    inspect: async () => { calls.push('inspect'); return { cloudDisabled: true, models: [] } },
    validateModel: async () => { calls.push('validate'); return { name: 'local', characters: 64000 } },
    chat: async (_model: unknown, input: any[]) => {
      calls.push('chat')
      expect(JSON.stringify(input)).not.toContain('NEVER_ALLOWED_SECRET')
      return { role: 'assistant', content: 'A clearer version.', tool_calls: [{ function: { name: 'propose_edit', arguments: { replacement: '# Note\n\nClearer text.', reason: 'Clarity' } } }] }
    },
  }
  const readDocument = async (file: string) => ({ path: file, name: path.basename(file), content: await fs.readFile(file, 'utf8'), mtimeMs: (await fs.stat(file)).mtimeMs })
  const host = createAgentHost({ ipcMain: { handle: (key: string, value: any) => handlers.set(key, value), on: (key: string, value: any) => events.set(key, value) },
    app: { getPath: () => profile }, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [documentPath] }) }, BrowserWindow: { fromWebContents: () => null },
    atomicWrite: async (file: string, content: string) => { if (options.failCheckpoint && file.includes('agent-restore-points')) throw new Error('Disk full'); await fs.writeFile(file, content) },
    readDocument, assertOpen: (_sender: unknown, file: string) => { if (file !== documentPath) throw new Error('Not explicitly open') },
    getWorkspace: () => null, readWorkspaceNotes: async () => { throw new Error('No folder capability') }, client,
  })
  host.register()
  const invoke = (name: string, ...args: any[]) => handlers.get(name)!(event, ...args)
  const current = async (content = original) => ({ tabId, path: documentPath, content, savedContent: (await readDocument(documentPath)).content, mtimeMs: (await fs.stat(documentPath)).mtimeMs })
  const request = async () => ({ taskId: randomUUID(), prompt: 'Make this clearer.', mode: 'revise', target: { ...await current(), name: 'Note.md', from: 0, to: original.length }, attachedIds: [], workspaceId: null, buffers: [] })
  return { root, profile, original, documentPath, invoke, events, event, sender, host, calls, messages, client, current, request }
}

describe('main-process agent permissions and approval', () => {
  it('starts disabled and never contacts the runtime until an explicit check/configuration/task', async () => {
    const f = await setup()
    expect(await f.invoke('agent:configuration')).toEqual({ enabled: false, model: '' })
    expect(f.calls).toEqual([])
    await expect(f.invoke('agent:run', await f.request())).rejects.toThrow('disabled')
    expect(f.calls).toEqual([])
  })
  it('never writes source during generation or proposal rejection, and blocks unapproved paths', async () => {
    const f = await setup()
    await f.invoke('agent:configure', { enabled: true, model: 'local' })
    const request = await f.request(), result = await f.invoke('agent:run', request)
    expect(result.proposal.after).toContain('Clearer')
    expect(await fs.readFile(f.documentPath, 'utf8')).toBe(f.original)
    expect(await f.invoke('agent:checkpoints')).toEqual([])
    await expect(f.invoke('agent:prepare-apply', 'not-a-task', result.proposal.id, await f.current())).rejects.toThrow('no longer available')
    const bad = await f.request(); bad.target.path = path.join(f.root, 'private.md'); bad.target.content = 'NEVER_ALLOWED_SECRET'
    const calls = f.calls.filter((call) => call === 'chat').length
    await expect(f.invoke('agent:run', bad)).rejects.toThrow('Not explicitly open')
    expect(f.calls.filter((call) => call === 'chat')).toHaveLength(calls)
    expect(await fs.readFile(f.documentPath, 'utf8')).toBe(f.original)
  })
  it('checkpoints approved edits, rejects stale buffers, and protects newer edits from undo', async () => {
    const f = await setup(); await f.invoke('agent:configure', { enabled: true, model: 'local' })
    const request = await f.request(), result = await f.invoke('agent:run', request)
    await expect(f.invoke('agent:prepare-apply', request.taskId, result.proposal.id, await f.current(f.original + ' new human text'))).rejects.toThrow('newer edits')
    const checkpoint = await f.invoke('agent:prepare-apply', request.taskId, result.proposal.id, await f.current())
    expect((await f.invoke('agent:checkpoints'))[0].id).toBe(checkpoint.id)
    expect(await fs.readFile(f.documentPath, 'utf8')).toBe(f.original)
    const applied = result.proposal.after
    expect(await f.invoke('agent:restore', checkpoint.id, await f.current(applied))).toBe(f.original)
    await expect(f.invoke('agent:restore', checkpoint.id, await f.current(applied + ' human edit'))).rejects.toThrow('newer edits')
    await fs.writeFile(f.documentPath, 'external editor')
    await expect(f.invoke('agent:restore', checkpoint.id, { ...await f.current(applied), savedContent: f.original })).rejects.toThrow('changed on disk')
    expect(await fs.readFile(f.documentPath, 'utf8')).toBe('external editor')
  })
  it('does not authorize an edit when its restore point cannot be stored', async () => {
    const f = await setup({ failCheckpoint: true }); await f.invoke('agent:configure', { enabled: true, model: 'local' })
    const request = await f.request(), result = await f.invoke('agent:run', request)
    await expect(f.invoke('agent:prepare-apply', request.taskId, result.proposal.id, await f.current())).rejects.toThrow('Disk full')
    expect(await fs.readFile(f.documentPath, 'utf8')).toBe(f.original)
  })
  it('requires the current folder capability and explicit attachment IDs', async () => {
    const f = await setup(); await f.invoke('agent:configure', { enabled: true, model: 'local' })
    const request = await f.request()
    await expect(f.invoke('agent:run', { ...request, attachedIds: ['invented'] })).rejects.toThrow('no longer permitted')
    await expect(f.invoke('agent:run', { ...request, workspaceId: 'old-folder' })).rejects.toThrow('folder changed')
  })
  it('cancels tasks on explicit Stop and on renderer teardown', async () => {
    const f = await setup(); await f.invoke('agent:configure', { enabled: true, model: 'local' })
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    f.client.chat = async (_model: unknown, _messages: any[], _tools?: unknown, signal?: AbortSignal) => new Promise((_resolve, reject) => { started(); signal!.addEventListener('abort', () => reject(Object.assign(new Error('Canceled'), { name: 'AbortError' })), { once: true }) }) as any
    const request = await f.request(), running = f.invoke('agent:run', request)
    const rejected = expect(running).rejects.toMatchObject({ name: 'AbortError' })
    await ready
    f.events.get('agent:cancel')!(f.event, request.taskId)
    await rejected
    expect(await fs.readFile(f.documentPath, 'utf8')).toBe(f.original)
    f.host.clear(f.sender)
  })
})
