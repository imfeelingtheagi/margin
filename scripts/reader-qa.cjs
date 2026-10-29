// Non-AI regression QA. Only synthetic notes and a disposable profile are used.
const { _electron } = require('playwright')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')

async function run() {
  const project = path.resolve(__dirname, '..')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'margin-reader-qa-'))
  const profile = path.join(root, 'profile'), notes = path.join(root, 'notes')
  await fs.mkdir(profile)
  await fs.mkdir(notes)
  const unicodePath = path.join(notes, 'Café 日本語.md')
  const original = '# Café 日本語\n\nRead **deeply** today.\n\n[Details](#details) and note[^one].\n\n- [ ] First task\n- [x] Second task\n\n## Details\n\n' + 'Long line wraps without changing bytes. '.repeat(50) + '\n\n[^one]: Footnote text.\n'
  await fs.writeFile(unicodePath, '\uFEFF' + original.replace(/\n/g, '\r\n'))
  await fs.writeFile(path.join(notes, 'Other.md'), '# Other\n\nDisk search token.\n')
  await fs.writeFile(path.join(notes, 'Tasks.md'), '# Tasks\n\n> - [ ] Quoted task\n')
  await fs.writeFile(path.join(notes, 'binary.md'), Buffer.from([0, 1, 2, 3]))
  await fs.writeFile(path.join(notes, 'invalid.md'), Buffer.from([0xff, 0xfe, 0x41]))
  await fs.writeFile(path.join(notes, 'oversized.md'), Buffer.alloc(25 * 1024 * 1024 + 1, 0x61))
  const checks = [], errors = [], network = []
  const app = await _electron.launch({
    executablePath: process.env.MARGIN_SMOKE_EXECUTABLE || require('electron'),
    args: [...(process.env.MARGIN_SMOKE_EXECUTABLE ? [] : [project]), `--user-data-dir=${profile}`, ...(process.platform === 'linux' && process.env.MARGIN_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])],
    cwd: project, env: { ...process.env, NODE_ENV: 'test', MARGIN_TEST_USER_DATA: profile, VITE_DEV_SERVER_URL: '' },
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(12_000)
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => { if (/^https?:/i.test(request.url())) network.push(request.url()) })
  const key = process.platform === 'darwin' ? 'Meta' : 'Control'
  const send = (command, payload) => app.evaluate(({ BrowserWindow }, data) => BrowserWindow.getAllWindows()[0].webContents.send('app-command', ...data), [command, payload])
  const button = (name) => page.getByRole('button', { name, exact: true }).first()
  const editor = () => page.locator('.editor-pane.is-active .cm-content')
  // CodeMirror virtualizes lines; innerText is not the full source document.
  const source = () => editor().evaluate((node) => node.cmTile.root.view.state.doc.toString())
  const setSource = async (content) => { await editor().click(); await page.keyboard.press(`${key}+a`); await page.keyboard.insertText(content) }
  const choose = (state) => app.evaluate((_electron, value) => Object.assign(globalThis.__marginReaderQA, value), state)
  const open = async (filePath) => { await choose({ openPaths: [filePath] }); await send('open'); await page.locator('.tab-select[aria-selected="true"]').filter({ hasText: path.basename(filePath) }).waitFor() }
  const check = async (name, test) => { await test(); checks.push(name); console.log(`PASS ${name}`) }
  try {
    assert.equal(await fs.realpath(await app.evaluate(({ app }) => app.getPath('userData'))), await fs.realpath(profile))
    await app.evaluate(({ dialog }, folder) => {
      globalThis.__marginReaderQA = { folder, openPaths: [], savePath: null, closeChoice: 'Cancel', nodeRequests: [] }
      // No network server, fixture, model, or Ollama connection is used here.
      for (const name of ['node:http', 'node:https']) {
        const transport = process.getBuiltinModule(name)
        transport.request = transport.get = (...args) => {
          globalThis.__marginReaderQA.nodeRequests.push(String(args[0]))
          throw new Error('Network disabled during non-AI QA.')
        }
      }
      globalThis.fetch = async () => { globalThis.__marginReaderQA.nodeRequests.push('fetch'); throw new Error('Network disabled during non-AI QA.') }
      dialog.showOpenDialog = async (_parent, options) => ({ canceled: false, filePaths: options.properties.includes('openDirectory') ? [folder] : globalThis.__marginReaderQA.openPaths })
      dialog.showSaveDialog = async () => ({ canceled: !globalThis.__marginReaderQA.savePath, filePath: globalThis.__marginReaderQA.savePath })
      dialog.showMessageBox = async (_parent, options) => ({ response: Math.max(0, options.buttons.findIndex((label) => label === globalThis.__marginReaderQA.closeChoice)) })
    }, notes)
    await button('New document').waitFor()
    await send('appearance')
    await page.getByRole('switch', { name: 'Autosave files', exact: true }).click()
    await button('Close settings').click()

    await check('Unicode paths, UTF-8 BOM and CRLF round-trip', async () => {
      await open(unicodePath)
      await button('Edit').click()
      assert.equal(await source(), original)
      await choose({ savePath: unicodePath })
      await send('save')
      await page.getByText(`Saved ${path.basename(unicodePath)}`, { exact: true }).waitFor()
      assert.equal((await fs.readFile(unicodePath)).toString(), '\uFEFF' + original.replace(/\n/g, '\r\n'))
    })
    await check('Word wrap toggles without modifying source', async () => {
      assert.match(await editor().evaluate((node) => getComputedStyle(node).whiteSpace), /^(pre-wrap|break-spaces)$/)
      await send('setWordWrap', 'false')
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.editor-pane.is-active .cm-content')).whiteSpace === 'pre')
      await send('setWordWrap', 'true')
      await page.waitForFunction(() => /^(pre-wrap|break-spaces)$/.test(getComputedStyle(document.querySelector('.editor-pane.is-active .cm-content')).whiteSpace))
      assert.equal(await source(), original)
    })
    await check('First-ever checkbox edit in Read mode is undoable, including blockquotes', async () => {
      await open(path.join(notes, 'Tasks.md'))
      await page.getByRole('checkbox', { name: 'Quoted task', exact: true }).click()
      await button('Edit').click()
      await page.waitForFunction(() => document.querySelector('.editor-pane.is-active .cm-content')?.cmTile.root.view.state.doc.toString().includes('> - [x]'))
      await button('Undo').click()
      assert.equal(await source(), '# Tasks\n\n> - [ ] Quoted task\n')
      await page.getByRole('tab', { name: path.basename(unicodePath), exact: true }).click()
    })
    await check('Source edit, undo/redo and all four modes preserve text', async () => {
      await setSource('# Edited\n\nA new paragraph.')
      await button('Undo').click()
      assert.equal(await source(), original)
      await button('Redo').click()
      assert.equal(await source(), '# Edited\n\nA new paragraph.')
      for (const mode of ['Split', 'Live edit', 'Read', 'Edit']) await button(mode).click()
      assert.equal(await source(), '# Edited\n\nA new paragraph.')
      await setSource(original)
    })
    await check('Reader search crosses inline markup and excludes folded text', async () => {
      await button('Read').click()
      await send('find')
      await page.getByPlaceholder('Find in document', { exact: true }).fill('Read deeply')
      await page.locator('mark[data-margin-reader-find]').first().waitFor()
      assert.equal(await page.locator('mark[data-margin-reader-find]').count(), 2)
      await page.getByPlaceholder('Find in document', { exact: true }).fill('Long line')
      await page.locator('mark[data-margin-reader-find]').first().waitFor()
      await page.locator('[data-margin-fold="details"]').click({ force: true })
      await page.waitForFunction(() => !document.querySelector('mark[data-margin-reader-find]'))
      await page.keyboard.press('Escape')
      await page.locator('[data-margin-fold="details"]').click({ force: true })
    })
    await check('Task toggles modify only the intended source line and support undo', async () => {
      await page.getByRole('checkbox', { name: 'First task', exact: true }).click()
      await button('Edit').click()
      assert.match(await source(), /- \[x\] First task\n- \[x\] Second task/)
      await button('Undo').click()
      assert.match(await source(), /- \[ \] First task/)
    })
    await check('Save As refuses to overwrite another open tab', async () => {
      const other = path.join(notes, 'Other.md')
      await open(other)
      await page.getByRole('tab', { name: path.basename(unicodePath), exact: true }).click()
      await choose({ savePath: other })
      await send('saveAs')
      await page.getByText('Other.md is already open in another tab.', { exact: false }).waitFor()
      assert.equal(await fs.readFile(other, 'utf8'), '# Other\n\nDisk search token.\n')
    })
    await check('Export cannot overwrite an open source document', async () => {
      const before = await fs.readFile(unicodePath)
      await choose({ savePath: unicodePath })
      for (const command of ['exportHtml', 'exportPdf']) {
        const result = await page.evaluate(async (kind) => {
          try { await window.margin[kind]({ html: '<!doctype html><title>QA export</title><p>Export payload</p>', suggestedName: 'export.html' }); return 'unexpected success' }
          catch (error) { return error.message }
        }, command)
        assert.match(result, /already open|cannot export over/i)
        assert.equal((await fs.readFile(unicodePath)).equals(before), true)
      }
    })
    await check('Concurrent atomic exports remain complete and leave no temporary files', async () => {
      const target = path.join(root, 'concurrent.html')
      await choose({ savePath: target })
      await app.evaluate(() => { globalThis.__marginReaderQA.dateNow = Date.now; Date.now = () => 123456789 })
      const outcomes = await page.evaluate(async () => Promise.allSettled(Array.from({ length: 8 }, (_, i) => window.margin.exportHtml({ html: `<p>${String(i).repeat(4096)}</p>`, suggestedName: 'concurrent.html' }))))
      await app.evaluate(() => { Date.now = globalThis.__marginReaderQA.dateNow })
      assert.equal(outcomes.every((outcome) => outcome.status === 'fulfilled' && outcome.value.status === 'saved'), true)
      const output = await fs.readFile(target, 'utf8')
      assert.equal(Array.from({ length: 8 }, (_, i) => `<p>${String(i).repeat(4096)}</p>`).includes(output), true)
      assert.equal((await fs.readdir(root)).some((name) => name.endsWith('.tmp')), false)
    })
    await check('Failed atomic writes retain the previous file and clean up partial data', async () => {
      const target = path.join(root, 'Failure.html')
      await fs.writeFile(target, 'Previous export is intact.')
      await choose({ savePath: target })
      await app.evaluate(() => {
        const files = process.getBuiltinModule('node:fs/promises'), original = files.writeFile
        globalThis.__marginReaderQA.restoreWrite = () => { files.writeFile = original }
        files.writeFile = async (...args) => {
          if (!String(args[0]).includes('.Failure.html.')) return original(...args)
          await original(args[0], 'partial', args[2])
          throw Object.assign(new Error('QA simulated disk full'), { code: 'ENOSPC' })
        }
      })
      const outcome = await page.evaluate(async () => {
        try { await window.margin.exportHtml({ html: '<p>Replacement</p>', suggestedName: 'Failure.html' }); return 'unexpected success' }
        catch (error) { return error.message }
      })
      await app.evaluate(() => globalThis.__marginReaderQA.restoreWrite())
      assert.match(outcome, /disk full/)
      assert.equal(await fs.readFile(target, 'utf8'), 'Previous export is intact.')
      assert.equal((await fs.readdir(root)).some((name) => name.endsWith('.tmp')), false)
    })
    await check('Binary, invalid UTF-8 and oversized notes are rejected', async () => {
      await choose({ openPaths: ['binary.md', 'invalid.md', 'oversized.md'].map((name) => path.join(notes, name)) })
      const result = await page.evaluate(() => window.margin.openDocuments())
      assert.equal(result.documents.length, 0)
      assert.equal(result.errors.length, 3)
    })
    await check('Folder search sees unsaved buffers and blocks traversal', async () => {
      await send('openWorkspace')
      await page.getByRole('button', { name: 'Refresh workspace', exact: true }).waitFor()
      await page.getByRole('tab', { name: 'Other.md', exact: true }).click()
      await button('Edit').click()
      await setSource('# Other\n\nUnsaved unique needle.')
      const result = await page.evaluate(() => window.margin.searchWorkspace({ query: 'unique needle', caseSensitive: false, wholeWord: false, buffers: [{ relativePath: 'Other.md', content: '# Other\n\nUnsaved unique needle.' }], excludedPaths: [] }))
      assert.equal(result.matches.length, 1)
      assert.equal(result.matches[0].source, 'buffer')
      const denied = await page.evaluate(() => window.margin.openWorkspaceDocument('../outside.md'))
      assert.equal(denied.documents.length, 0)
      assert.equal(denied.errors.length, 1)
    })
    await check('Quick Open and command palette support keyboard-only selection', async () => {
      await send('quickOpen')
      await page.getByRole('dialog', { name: 'Quick Open', exact: true }).locator('input').fill('Café')
      await page.getByRole('option').filter({ hasText: 'Café' }).waitFor()
      await page.getByRole('dialog', { name: 'Quick Open', exact: true }).locator('input').press('Enter')
      await page.getByRole('dialog', { name: 'Quick Open', exact: true }).waitFor({ state: 'hidden' })
      await page.locator('.tab-select[aria-selected="true"]').filter({ hasText: path.basename(unicodePath) }).waitFor()
      await send('commandPalette')
      await page.getByRole('dialog', { name: 'Command palette', exact: true }).locator('input').fill('Read mode')
      await page.getByRole('option').filter({ hasText: 'Read mode' }).waitFor()
      for (let i = 0; i < 14 && !(await page.locator('[role="option"][aria-selected="true"]').innerText()).includes('Switch to Read mode'); i += 1) {
        await page.getByRole('dialog', { name: 'Command palette', exact: true }).locator('input').press('ArrowDown')
      }
      assert.match(await page.locator('[role="option"][aria-selected="true"]').innerText(), /Switch to Read mode/)
      await page.getByRole('dialog', { name: 'Command palette', exact: true }).locator('input').press('Enter')
      await page.locator('button[aria-label="Read"][aria-pressed="true"]').waitFor()
    })
    await check('Image imports verify actual bytes, preserve unique names and restrict asset paths', async () => {
      const png = Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=', 'base64'))
      const result = await page.evaluate(async ({ documentPath, png }) => {
        const image = { name: 'Café image.png', mimeType: 'image/png', data: new Uint8Array(png).buffer }
        const first = await window.margin.importImageData(documentPath, image)
        const second = await window.margin.importImageData(documentPath, image)
        const asset = await window.margin.readAsset(documentPath, first.relativePath)
        const blocked = await window.margin.readAsset(documentPath, '../outside.png')
        let invalid = ''
        try { await window.margin.importImageData(documentPath, { name: 'fake.png', mimeType: 'image/png', data: new TextEncoder().encode('not an image').buffer }) } catch (error) { invalid = error.message }
        return { first, second, asset, blocked, invalid }
      }, { documentPath: unicodePath, png })
      assert.notEqual(result.first.relativePath, result.second.relativePath)
      assert.match(result.asset, /^data:image\/png;base64,/)
      assert.equal(result.blocked, null)
      assert.match(result.invalid, /image|format/i)
    })
    await check('Malformed Mermaid and executable HTML fail safely without network access', async () => {
      await send('new')
      await setSource('# Safe rendering\n\n<script>window.qaInjected=true</script>\n\n<img src="https://example.test/pixel.png" onerror="window.qaInjected=true">\n\n```mermaid\nnot a valid diagram\n```\n\n```mermaid\nflowchart LR\nA --> B\n```')
      await button('Read').click()
      await page.locator('.mermaid-block.has-error').waitFor()
      await page.locator('.mermaid-block.is-rendered svg').waitFor()
      assert.equal(await page.evaluate(() => globalThis.qaInjected === true), false)
      assert.equal(await page.locator('.preview-pane script, .preview-pane [onerror], .preview-pane img[src^="https:"]').count(), 0)
      assert.match(await page.locator('.preview-pane').innerText(), /Remote image blocked/)
      await page.screenshot({ path: path.join(root, 'safe-rendering.png'), animations: 'disabled', caret: 'hide' })
      await choose({ closeChoice: 'Discard' }); await send('closeTab')
    })
    await check('Large documents use the source fallback in Live mode without changing bytes', async () => {
      const target = path.join(notes, 'Large.md'), content = '# Large\n\n' + 'Bounded local prose. '.repeat(16_000)
      await fs.writeFile(target, content)
      await open(target); await button('Live edit').click()
      await page.getByText('Large document: showing Markdown source to keep editing responsive.', { exact: true }).waitFor()
      assert.equal(await source(), content)
      await send('closeTab')
    })
    await check('Autosave, external clean reload, dirty conflicts and cancelled overwrite preserve bytes', async () => {
      const target = path.join(notes, 'External.md')
      await fs.writeFile(target, '# External\n\nOriginal.')
      await open(target); await button('Edit').click()
      await setSource('# External\n\nAutosaved.')
      await send('appearance')
      await page.getByRole('switch', { name: 'Autosave files', exact: true }).click()
      await button('Close settings').click()
      for (let i = 0; i < 100 && await fs.readFile(target, 'utf8') !== '# External\n\nAutosaved.'; i += 1) await page.waitForTimeout(40)
      assert.equal(await fs.readFile(target, 'utf8'), '# External\n\nAutosaved.')
      await send('appearance')
      await page.getByRole('switch', { name: 'Autosave files', exact: true }).click()
      await button('Close settings').click()
      await fs.writeFile(target, '# External\n\nChanged on disk.')
      let stat = await fs.stat(target); await fs.utimes(target, stat.atime, new Date(stat.mtimeMs + 1000))
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await page.waitForFunction(() => document.querySelector('.editor-pane.is-active .cm-content')?.cmTile.root.view.state.doc.toString().includes('Changed on disk.'))
      await setSource('# External\n\nUnsaved local work.')
      await fs.writeFile(target, '# External\n\nNewer disk work.')
      stat = await fs.stat(target); await fs.utimes(target, stat.atime, new Date(stat.mtimeMs + 2000))
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await page.locator('.save-indicator.state-conflict').waitFor()
      assert.match(await source(), /Unsaved local work/)
      await choose({ closeChoice: 'Cancel' }); await send('save')
      await page.locator('.save-indicator.state-conflict').waitFor()
      assert.equal(await fs.readFile(target, 'utf8'), '# External\n\nNewer disk work.')
    })
    await check('Dirty buffers and external-conflict warnings survive renderer restart', async () => {
      const snapshotPath = path.join(profile, 'recovery-session.json')
      for (let i = 0; i < 100; i += 1) {
        const snapshot = await fs.readFile(snapshotPath, 'utf8').catch(() => '')
        if (snapshot.includes('Unsaved local work.')) break
        await page.waitForTimeout(30)
      }
      await page.reload()
      await page.locator('.tab-select[aria-selected="true"]').filter({ hasText: 'External.md' }).waitFor()
      await editor().waitFor()
      assert.match(await source(), /Unsaved local work/)
      await page.locator('.save-indicator.state-conflict').waitFor()
      assert.equal(await fs.readFile(path.join(notes, 'External.md'), 'utf8'), '# External\n\nNewer disk work.')
    })
    await check('Concurrent typing during close-and-save never discards newer work', async () => {
      await send('new')
      await setSource('# Save race\n\nInitial text.')
      const racePath = path.join(notes, 'Race.md')
      await choose({ savePath: racePath, closeChoice: 'Save' })
      await app.evaluate(() => {
        const files = process.getBuiltinModule('node:fs/promises')
        const original = files.writeFile
        globalThis.__marginReaderQA.releaseWrite = null
        files.writeFile = async (...args) => {
          if (String(args[0]).includes('.Race.md.')) {
            await new Promise((resolve) => { globalThis.__marginReaderQA.releaseWrite = resolve })
            files.writeFile = original
          }
          return original(...args)
        }
      })
      await send('closeTab')
      for (let i = 0; i < 100; i += 1) {
        if (await app.evaluate(() => Boolean(globalThis.__marginReaderQA.releaseWrite))) break
        await page.waitForTimeout(20)
      }
      assert.equal(await app.evaluate(() => Boolean(globalThis.__marginReaderQA.releaseWrite)), true)
      await editor().click(); await page.keyboard.press(`${key}+End`); await page.keyboard.insertText(' Newer work must survive.')
      await app.evaluate(() => globalThis.__marginReaderQA.releaseWrite())
      await page.waitForTimeout(200)
      assert.equal(await page.locator('.tab-select').filter({ hasText: /Race.md|Untitled/ }).count(), 1)
      assert.match(await source(), /Newer work must survive/)
    })
    await check('Window close also preserves edits made during an in-flight save', async () => {
      await choose({ closeChoice: 'Discard' })
      // Isolate this check from deliberately dirty tabs in earlier scenarios.
      const raceTab = await page.locator('.tab-select[aria-selected="true"] span').textContent()
      for (const name of await page.locator('.tab-select span').allTextContents()) {
        if (name === raceTab) continue
        await page.getByRole('button', { name: `Close ${name}`, exact: true }).click()
      }
      await choose({ closeChoice: 'Save' })
      await app.evaluate(() => {
        const files = process.getBuiltinModule('node:fs/promises'), original = files.writeFile
        globalThis.__marginReaderQA.releaseWrite = null
        files.writeFile = async (...args) => {
          if (String(args[0]).includes('.Race.md.')) {
            await new Promise((resolve) => { globalThis.__marginReaderQA.releaseWrite = resolve })
            files.writeFile = original
          }
          return original(...args)
        }
      })
      await send('requestWindowClose')
      for (let i = 0; i < 100 && !await app.evaluate(() => Boolean(globalThis.__marginReaderQA.releaseWrite)); i += 1) await page.waitForTimeout(20)
      assert.equal(await app.evaluate(() => Boolean(globalThis.__marginReaderQA.releaseWrite)), true)
      await editor().click(); await page.keyboard.press(`${key}+End`); await page.keyboard.insertText(' Window-close work.')
      await app.evaluate(() => globalThis.__marginReaderQA.releaseWrite())
      await page.getByText('Newer edits arrived while saving. Margin remains open.', { exact: true }).waitFor()
      assert.match(await source(), /Window-close work/)
      assert.equal(page.isClosed(), false)
    })
    await check('Minimum-size layouts, focus mode, and settings retain usable controls', async () => {
      const window = await app.browserWindow(page)
      await window.evaluate((window) => window.setContentSize(760, 560))
      await button('Split').click()
      await page.screenshot({ path: path.join(root, 'minimum-split.png'), animations: 'disabled', caret: 'hide' })
      await send('focusMode')
      await page.waitForFunction(() => document.querySelector('.app-shell')?.classList.contains('focus-mode'))
      await send('focusMode')
      await button('Settings').waitFor()
      await send('appearance')
      await page.getByRole('switch', { name: 'Word wrap', exact: true }).waitFor()
      await page.screenshot({ path: path.join(root, 'minimum-settings.png'), animations: 'disabled', caret: 'hide' })
      await button('Close settings').click()
      await window.evaluate((window) => window.setContentSize(1280, 820))
    })
    await check('Storage quota errors do not crash the editor or block theme updates', async () => {
      await page.evaluate(() => {
        const original = Storage.prototype.setItem
        globalThis.__restoreStorage = () => { Storage.prototype.setItem = original }
        Storage.prototype.setItem = function (key, value) {
          if (key === 'margin:settings' || key === 'margin:active-tab') throw new DOMException('QA quota failure', 'QuotaExceededError')
          return original.call(this, key, value)
        }
      })
      await button('Settings').click()
      await button('Dark').click()
      await button('Close settings').click()
      await page.waitForFunction(() => document.documentElement.dataset.uiTheme === 'dark')
      await button('New document').click()
      await editor().waitFor()
      assert.equal(await page.locator('.main-toolbar').isVisible(), true)
      await page.evaluate(() => globalThis.__restoreStorage())
    })
    assert.deepEqual(errors, [])
    assert.deepEqual(network, [])
    assert.deepEqual(await app.evaluate(() => globalThis.__marginReaderQA.nodeRequests), [])
    checks.push('No renderer errors, HTTP/fetch calls, AI setup or model inference')
    console.log(JSON.stringify({ status: 'passed', platform: process.platform, checks, artifacts: root }, null, 2))
  } catch (error) {
    await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {})
    console.error(JSON.stringify({ status: 'failed', checks, errors, network, artifacts: root }, null, 2))
    throw error
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
