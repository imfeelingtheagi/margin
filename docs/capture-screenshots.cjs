// Documentation tooling only: captures the real production renderer with copied
// sample notes and a temporary profile. It never opens a normal user profile.
const { _electron } = require('playwright')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')

async function capture() {
  const project = path.resolve(__dirname, '..')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'margin-docs-'))
  const profile = path.join(root, 'profile')
  const notes = path.join(root, 'notes')
  const output = path.join(__dirname, 'assets')
  await fs.mkdir(profile)
  await fs.mkdir(output, { recursive: true })
  await fs.cp(path.join(__dirname, 'examples'), notes, { recursive: true })
  const app = await _electron.launch({
    executablePath: process.env.MARGIN_SMOKE_EXECUTABLE || require('electron'),
    args: [...(process.env.MARGIN_SMOKE_EXECUTABLE ? [] : [project]), `--user-data-dir=${profile}`],
    cwd: project,
    env: { ...process.env, NODE_ENV: 'test', MARGIN_TEST_USER_DATA: profile },
  })
  try {
    assert.equal(await fs.realpath(await app.evaluate(({ app }) => app.getPath('userData'))), await fs.realpath(profile))
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async (_parent, options) => ({ canceled: false, filePaths: [options.properties.includes('openDirectory') ? folder : pathForFile(folder)] })
      function pathForFile(root) { return `${root}/Welcome.md` }
    }, notes)
    const page = await app.firstWindow()
    page.setDefaultTimeout(20_000)
    const window = await app.browserWindow(page)
    await window.evaluate((window) => window.setContentSize(1440, 960))
    const shot = (name) => page.screenshot({ path: path.join(output, `${name}.png`), scale: 'css' })
    await page.getByRole('button', { name: 'Open folder', exact: true }).click()
    await page.getByRole('button', { name: 'Open file', exact: true }).click()
    await page.locator('.note-embed-body strong').waitFor()
    await page.locator('.mermaid-block.is-rendered svg').waitFor()
    if (process.env.MARGIN_CAPTURE_AGENT_SETUP_ONLY === '1') {
      await page.getByRole('button', { name: 'Agent desk', exact: true }).click()
      await page.getByText('Disabled · configure a local model', { exact: true }).waitFor()
      await page.getByText('Offline setup instructions', { exact: true }).click()
      await page.locator('.toast').waitFor({ state: 'hidden' })
      await shot('agent-setup')
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
    console.log(`Saved documentation screenshots to ${output}; isolated fixtures: ${root}`)
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app.close().catch(() => {})
  }
}

capture().catch((error) => { console.error(error); process.exitCode = 1 })
