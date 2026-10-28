// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
const require = createRequire(import.meta.url)
const { createOllamaClient, createAgentScope, runAgent, hash, remoteModel } = require('../../electron/agent.cjs')

const servers: http.Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))) })
async function fixture(handler: http.RequestListener) {
  const server = http.createServer(handler); servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return createOllamaClient({ port: (server.address() as AddressInfo).port, timeout: 2000 })
}
const source = (content = '# Notes\n\nThe deadline is Friday.') => ({ name: 'Notes.md', path: '/notes/Notes.md', content, initial: true })

describe('local-only Ollama transport', () => {
  it('verifies disabled cloud, installed weights and tool capability before use', async () => {
    const visited: string[] = []
    const client = await fixture((req, res) => {
      visited.push(req.url!)
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/api/status') res.end(JSON.stringify({ cloud: { disabled: true } }))
      else if (req.url === '/api/tags') res.end(JSON.stringify({ models: [{ name: 'local:8b', size: 12, digest: 'abc' }] }))
      else res.end(JSON.stringify({ capabilities: ['completion', 'tools'], model_info: { 'test.context_length': 32768 } }))
    })
    expect(await client.validateModel('local:8b')).toMatchObject({ name: 'local:8b', context: 32768, characters: 40960 })
    expect(visited).toEqual(['/api/status', '/api/tags', '/api/show'])
    await expect(client.request('/api/pull', {})).rejects.toThrow('not permitted')
  })
  it('fails closed when cloud is enabled, a model is remote, or metadata is unavailable', async () => {
    const client = await fixture((req, res) => { res.end(JSON.stringify(req.url === '/api/status' ? { cloud: { disabled: false } } : { models: [] })) })
    await expect(client.validateModel('anything')).rejects.toThrow('cloud features are enabled')
    expect(remoteModel({ name: 'x-cloud' })).toBe(true)
    expect(remoteModel({ remote_host: 'https://example.test' })).toBe(true)
    const old = await fixture((_req, res) => { res.statusCode = 404; res.end('{}') })
    await expect(old.inspect()).rejects.toThrow('Update Ollama')
  })
  it('does not follow redirects or accept arbitrary hosts/endpoints', async () => {
    const client = await fixture((_req, res) => { res.statusCode = 302; res.setHeader('Location', 'https://example.test'); res.end() })
    await expect(client.inspect()).rejects.toThrow('redirects are blocked')
    await expect(client.request('https://example.test', null)).rejects.toThrow('not permitted')
  })
  it('streams text and tool calls without exposing thinking and rejects incomplete output', async () => {
    const client = await fixture((_req, res) => {
      res.end([JSON.stringify({ message: { content: 'Hello ', thinking: 'private' } }), JSON.stringify({ message: { content: '[C1]', tool_calls: [{ function: { index: 0, name: 'read_note', arguments: { note_id: 'N1' } } }] } }), JSON.stringify({ done: true })].join('\n'))
    })
    const chunks: string[] = []
    const result = await client.chat({ name: 'local', context: 8192, output: 2048 }, [], [], undefined, (text: string) => chunks.push(text))
    expect(chunks).toEqual(['Hello ', '[C1]'])
    expect(result.tool_calls[0].function).toMatchObject({ name: 'read_note', arguments: { note_id: 'N1' } })
    const broken = await fixture((_req, res) => res.end(JSON.stringify({ message: { content: 'partial' } })))
    await expect(broken.chat({ name: 'local' }, [], [])).rejects.toThrow('before completion')
  })
  it('aborts an in-flight inference request', async () => {
    const client = await fixture((_req, res) => { res.writeHead(200); res.write(JSON.stringify({ message: { content: 'starting' } }) + '\n') })
    const controller = new AbortController()
    const result = client.chat({ name: 'local' }, [], [], controller.signal, () => controller.abort())
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('explicit scope, evidence, and proposals', () => {
  it('uses opaque note IDs, rejects unknown files/tools, and supplies source passages', () => {
    const scope = createAgentScope([source()])
    expect(scope.initial()[0]).toMatchObject({ id: 'C1', startLine: 1, endLine: 3 })
    expect(scope.call('read_note', { note_id: 'N1' }).id).toBe('C1')
    expect(() => scope.call('read_note', { note_id: '../../secret' })).toThrow('outside')
    for (const tool of ['exec', 'read_file', 'write_file', 'browse', 'delete']) expect(() => scope.call(tool, {})).toThrow('not allowed')
  })
  it('limits read evidence, duplicate reads, and literal search', () => {
    const scope = createAgentScope([source('line 1\nFriday\nline 3')], { maxCharacters: 100 })
    const found = scope.call('search_notes', { query: 'Friday' })
    expect(found.matches[0].text).toContain('Friday')
    const count = scope.characters
    scope.call('search_notes', { query: 'Friday' })
    expect(scope.characters).toBe(count)
    expect(() => scope.call('search_notes', { query: 'x'.repeat(129) })).toThrow('1–128')
    const bounded = createAgentScope([source('large')], { maxCharacters: 2 })
    expect(() => bounded.call('read_note', { note_id: 'N1' })).toThrow('budget')
  })
  it('proposes exactly one fixed-range edit without mutating the source', () => {
    const content = '# Note\nOld text\nEnd'
    const target = { content, before: 'Old text', tabId: 'tab', path: '/notes/Notes.md', name: 'Notes.md', from: 7, to: 15 }
    const scope = createAgentScope([source(content)], { target })
    scope.call('propose_edit', { replacement: 'Clearer text', reason: 'Clarity' })
    expect(scope.proposal).toMatchObject({ before: 'Old text', after: 'Clearer text', from: 7, to: 15, baseHash: hash(content) })
    expect(target.content).toBe(content)
    expect(() => scope.call('propose_draft', { title: 'Other', markdown: '# Other', reason: 'test' })).toThrow('already')
    expect(() => createAgentScope([source()]).call('propose_edit', { replacement: 'bad' })).toThrow('No editable target')
  })
  it('keeps drafts unsaved and rejects path-shaped names', () => {
    const scope = createAgentScope([])
    expect(() => scope.call('propose_draft', { title: '../secret', markdown: 'text', reason: '' })).toThrow('not a path')
    scope.call('propose_draft', { title: 'Brief', markdown: '# Brief', reason: 'From the notes' })
    expect(scope.proposal).toMatchObject({ kind: 'draft', name: 'Brief.md', after: '# Brief' })
  })
  it('runs bounded read-only tools and returns verified evidence with citation warnings', async () => {
    let turn = 0
    const client = { chat: async () => ++turn === 1 ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_note', arguments: { note_id: 'N1' } } }] } : { role: 'assistant', content: 'Friday [C1]. Invented [C99].', tool_calls: [] } }
    const result = await runAgent({ client, model: {}, prompt: 'When?', mode: 'ask', scope: createAgentScope([source()]) })
    expect(result.sources).toHaveLength(1)
    expect(result.toolCalls).toBe(1)
    expect(result.warnings.join(' ')).toContain('unknown citation')
  })
  it('does not publish a proposal after cancellation', async () => {
    const controller = new AbortController()
    const client = { chat: async () => { controller.abort(); return { content: 'late', tool_calls: [] } } }
    await expect(runAgent({ client, prompt: 'Task', mode: 'ask', scope: createAgentScope([source()]), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
