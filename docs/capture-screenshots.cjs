// Documentation tooling only: captures the real production renderer with copied
// sample notes and a temporary profile. It never opens a normal user profile.
const { _electron } = require('playwright')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')

async function capture() {
  const project = path.resolve(__dirname, '..')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'margin-docs-'))
  const profile = path.join(root, 'profile')
  const notes = path.join(root, 'notes')
  const output = path.join(__dirname, 'assets')
  const manifestFile = path.join(output, 'capture-manifest.json')
  const sha256 = (value) => createHash('sha256').update(value).digest('hex')
  let repositoryRevision = null
  try { repositoryRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim() } catch { /* Git metadata is optional for local captures. */ }
  let previous = {}
  try { previous = JSON.parse(await fs.readFile(manifestFile, 'utf8')).captures || {} } catch { /* First capture. */ }
  const captures = {}
  await fs.mkdir(profile)
  await fs.mkdir(output, { recursive: true })
  await fs.cp(path.join(__dirname, 'examples'), notes, { recursive: true })
  const app = await _electron.launch({
    executablePath: process.env.MARGIN_SMOKE_EXECUTABLE || require('electron'),
    args: [...(process.env.MARGIN_SMOKE_EXECUTABLE ? [] : [project]), `--user-data-dir=${profile}`],
    cwd: project,
    env: { ...process.env, NODE_ENV: 'test', MARGIN_TEST_USER_DATA: profile, VITE_DEV_SERVER_URL: '' },
  })
  try {
    assert.equal(await fs.realpath(await app.evaluate(({ app }) => app.getPath('userData'))), await fs.realpath(profile))
    const build = await app.evaluate(({ app }) => {
      // This process is private to the capture. Block Node HTTP as well as the
      // app's existing renderer filter, so screenshots cannot invoke a model.
      globalThis.marginDocumentationNetworkAttempts = 0
      const blocked = () => {
        globalThis.marginDocumentationNetworkAttempts += 1
        throw new Error('Documentation capture forbids network/model requests.')
      }
      for (const name of ['node:http', 'node:https']) {
        const module = process.getBuiltinModule(name)
        module.request = blocked; module.get = blocked
      }
      globalThis.fetch = blocked
      const entry = process.getBuiltinModule('fs').readFileSync(process.getBuiltinModule('path').join(app.getAppPath(), 'dist', 'index.html'))
      return { appVersion: app.getVersion(), electronVersion: process.versions.electron, platform: process.platform,
        architecture: process.arch, packaged: app.isPackaged, rendererEntrySha256: process.getBuiltinModule('crypto').createHash('sha256').update(entry).digest('hex') }
    })
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async (_parent, options) => ({ canceled: false, filePaths: [options.properties.includes('openDirectory') ? folder : pathForFile(folder)] })
      function pathForFile(root) { return `${root}/Welcome.md` }
    }, notes)
    const page = await app.firstWindow()
    const webRequests = []
    page.on('request', (request) => { if (/^(?:https?|wss?):/.test(request.url())) webRequests.push(request.url()) })
    await page.waitForURL(/^file:/)
    await page.waitForFunction(() => Boolean(window.margin?.getAgentConfiguration))
    assert.ok(page.url().startsWith('file:'), 'Capture requires a built renderer, not a development server.')
    assert.equal((await page.evaluate(() => window.margin.getAgentConfiguration())).enabled, false, 'Capture must keep the Agent desk disabled.')
    page.setDefaultTimeout(20_000)
    const window = await app.browserWindow(page)
    await window.evaluate((window) => window.setContentSize(1440, 960))
    const shot = async (name) => {
      await page.evaluate(async () => { await document.fonts.ready; await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
      const data = await page.screenshot({ path: path.join(output, `${name}.png`), scale: 'css', animations: 'disabled', caret: 'hide' })
      assert.equal(await app.evaluate(() => globalThis.marginDocumentationNetworkAttempts), 0)
      assert.deepEqual(webRequests, [])
      captures[name] = { file: `${name}.png`, capturedAtUtc: new Date().toISOString(), repositoryRevision, ...build,
        width: data.readUInt32BE(16), height: data.readUInt32BE(20), sha256: sha256(data), networkRequests: 0 }
    }
    const writeManifest = () => fs.writeFile(manifestFile, JSON.stringify({ formatVersion: 1, captures: { ...previous, ...captures } }, null, 2) + '\n')
    const captureAgentSetup = async () => {
      await page.getByRole('button', { name: 'Agent desk', exact: true }).click()
      await page.getByText('Disabled · configure a local model', { exact: true }).waitFor()
      await page.getByText('Offline setup instructions', { exact: true }).click()
      await page.locator('.toast').waitFor({ state: 'hidden' })
      await shot('agent-setup')
    }
    await page.getByRole('button', { name: 'Open folder', exact: true }).click()
    await page.getByRole('button', { name: 'Open file', exact: true }).click()
    await page.locator('.note-embed-body strong').waitFor()
    await page.locator('.mermaid-block.is-rendered svg').waitFor()
    if (process.env.MARGIN_CAPTURE_AGENT_SETUP_ONLY === '1') {
      await captureAgentSetup()
      await writeManifest()
      console.log(`Saved disabled Agent desk screenshot to ${output}; no runtime check or inference was requested.`)
      return
    }
    await page.getByRole('button', { name: 'Reading tools and connections', exact: true }).click()
    await page.getByRole('button', { name: 'Bookmark document', exact: true }).click()
    await page.evaluate(() => {
      const text = document.querySelector('.preview-pane article > p strong').firstChild
      const range = document.createRange()
      range.selectNodeContents(text)
      const selection = window.getSelection()
      selection.removeAllRanges(); selection.addRange(range)
      document.querySelector('.preview-pane article').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await page.getByRole('button', { name: 'Add note', exact: true }).click()
    await page.getByRole('textbox', { name: 'Annotation note', exact: true }).fill('The source stays portable. My reading notes stay private and local.')
    await page.locator('.preview-pane').evaluate((pane) => { pane.scrollTop = 0 })
    await page.mouse.click(700, 135)
    await page.locator('.toast').waitFor({ state: 'hidden' })
    await shot('reading')
    await captureAgentSetup()
    await page.getByRole('button', { name: 'Close Agent desk', exact: true }).click()
    await page.getByRole('button', { name: 'Reading tools and connections', exact: true }).click()
    await page.getByRole('link', { name: 'The quiet workspace', exact: true }).click()
    await page.getByRole('tab', { name: 'Links', exact: true }).click()
    await page.getByRole('button', { name: 'Live edit', exact: true }).click()
    await page.locator('.live-editor.is-active .cm-live-block table').waitFor()
    await page.locator('.live-editor.is-active .cm-live-block p').filter({ hasText: /^A folder becomes/ }).click()
    await shot('live')
    await page.getByRole('button', { name: 'Split', exact: true }).click()
    await page.locator('.document-stack.mode-split').waitFor()
    await page.getByRole('button', { name: 'Close reading tools', exact: true }).click()
    await shot('split')
    await page.getByRole('button', { name: 'Note graph', exact: true }).click()
    await page.locator('.graph-node').first().waitFor()
    for (let i = 0; i < 3; i += 1) await page.getByRole('button', { name: 'Zoom graph in', exact: true }).click()
    await shot('graph')
    await page.getByRole('button', { name: 'Close graph', exact: true }).click()
    await page.getByRole('button', { name: 'Read', exact: true }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Dark', exact: true }).click()
    await page.getByRole('button', { name: 'Midnight', exact: true }).click()
    await page.getByRole('button', { name: 'Close settings', exact: true }).click()
    await page.getByRole('button', { name: 'Reading tools and connections', exact: true }).click()
    await page.getByRole('tab', { name: 'Reading', exact: true }).click()
    await page.locator('.preview-pane').evaluate((pane) => { pane.scrollTop = 0 })
    await shot('dark')
    await writeManifest()
    console.log(`Saved ${Object.keys(captures).length} documentation screenshots to ${output}; isolated fixtures: ${root}; no network/model requests.`)
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app.close().catch(() => {})
  }
}

capture().catch((error) => { console.error(error); process.exitCode = 1 })
