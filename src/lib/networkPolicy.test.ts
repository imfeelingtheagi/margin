import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const { isAllowedAppRequest } = createRequire(import.meta.url)('../../electron/network-policy.cjs') as {
  isAllowedAppRequest: (url: string, root: string, developmentUrl?: string | null, renderFile?: string | null) => boolean
}
const root = path.resolve('dist')
describe('desktop offline requests', () => {
  it('allows packaged app assets and in-memory rendering while blocking web and unrelated local files', () => {
    expect(isAllowedAppRequest(pathToFileURL(path.join(root, 'assets', 'index.js')).href, root)).toBe(true)
    expect(isAllowedAppRequest('data:image/png;base64,eA==', root)).toBe(true)
    expect(isAllowedAppRequest('blob:null/isolated-render', root)).toBe(true)
    for (const url of ['https://example.test/image.png', 'http://127.0.0.1:5173/', 'ws://127.0.0.1:5173/', 'file://remote-server/share/private.md', pathToFileURL(path.resolve('private.md')).href, pathToFileURL(`${root}-other/private.md`).href]) {
      expect(isAllowedAppRequest(url, root), url).toBe(false)
    }
  })
  it('limits development network access to the configured Vite origin and its local HMR socket', () => {
    const development = 'http://127.0.0.1:5173'
    expect(isAllowedAppRequest(`${development}/@vite/client`, root, development)).toBe(true)
    expect(isAllowedAppRequest('ws://127.0.0.1:5173/?token=local', root, development)).toBe(true)
    for (const url of ['https://example.test', 'http://127.0.0.1:5174/', 'http://localhost:5173/', 'http://127.0.0.1.evil.test:5173/']) expect(isAllowedAppRequest(url, root, development)).toBe(false)
  })
  it('permits only the exact temporary file explicitly granted to a PDF window', () => {
    const renderFile = path.resolve('temporary-export', 'document.html')
    expect(isAllowedAppRequest(pathToFileURL(renderFile).href, root, null, renderFile)).toBe(true)
    expect(isAllowedAppRequest(pathToFileURL(path.resolve('temporary-export', 'private.md')).href, root, null, renderFile)).toBe(false)
    expect(isAllowedAppRequest(pathToFileURL(renderFile).href, root)).toBe(false)
  })
})
