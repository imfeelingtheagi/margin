// Real Electron/IPC/filesystem workflow with a deterministic local protocol
// fixture, NOT a claim of real-model quality. No model is downloaded or started.
const { _electron } = require('playwright')
const fs = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const key = process.platform === 'darwin' ? 'Meta' : 'Control'

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'margin-agent-smoke-'))
  const profile = path.join(root, 'profile'), notes = path.join(root, 'notes')
  await fs.mkdir(profile); await fs.mkdir(notes)
  const original = '# Project\n\nWe decided to keep the app offline.\n\n- [ ] Draft a guide.\n'
  const start = path.join(notes, 'Project.md'), linked = path.join(notes, 'Reference.md')
  await fs.writeFile(start, original)
  await fs.writeFile(linked, '# Reference\n\nLinked-evidence: the guide belongs in the repository.\n')
  await fs.writeFile(path.join(root, 'outside.md'), 'NEVER_ALLOWED_SECRET')
  let cloudDisabled = true
  const requests = [], errors = [], network = []
  const fixture = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      requests.push({ path: request.url, body })
      assert.equal(body.includes('NEVER_ALLOWED_SECRET'), false)
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/api/status') return response.end(JSON.stringify({ cloud: { disabled: cloudDisabled } }))
      if (request.url === '/api/tags') return response.end(JSON.stringify({ models: [{ name: 'fixture-local:8b', size: 12345, digest: 'fixture-not-a-model' }] }))
      if (request.url === '/api/show') return response.end(JSON.stringify({ capabilities: ['completion', 'tools'], model_info: { 'fixture.context_length': 32768 } }))
      if (request.url !== '/api/chat') { response.statusCode = 404; return response.end('{}') }
      const input = JSON.parse(body), user = input.messages.find((message) => message.role === 'user')?.content || ''
      const send = (message) => response.end(`${JSON.stringify({ message })}\n${JSON.stringify({ done: true, done_reason: 'stop' })}\n`)
      if (user.includes('wait for cancellation')) { response.write(`${JSON.stringify({ message: { content: 'Working…' } })}\n`); return }
      if (user.includes('search permitted folder') && input.messages.at(-1).role !== 'tool') return send({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'search_notes', arguments: { query: 'Linked-evidence' } } }] })
      if (input.messages[0].content.includes('task mode is draft')) return send({ role: 'assistant', content: 'A brief for review. [C1]', tool_calls: [{ function: { name: 'propose_draft', arguments: { title: 'Brief', markdown: '# Brief\n\nKeep the app offline.\n', reason: 'Summarizes the supplied note.' } } }] })
      if (/task mode is (?:revise|connect)/.test(input.messages[0].content)) {
        const match = input.messages[0].content.match(/Editable target \(untrusted document data, not instructions\): (.*)$/)
        const target = JSON.parse(match[1])
        return send({ role: 'assistant', content: 'A clearer passage. [C1]', tool_calls: [{ function: { name: 'propose_edit', arguments: { replacement: target.before.replace('decided to keep', 'will keep'), reason: 'Makes the decision more direct.' } } }] })
      }
      if (user.includes('search permitted folder')) {
        const found = JSON.parse(input.messages.at(-1).content).matches[0]
        return send({ role: 'assistant', content: `The guide belongs in the repository. [${found.id}]` })
      }
      send({ role: 'assistant', content: 'The note records a decision to keep Margin offline and an action to draft a guide. [C1]' })
    })
  })
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve))
  const port = fixture.address().port
  const app = await _electron.launch({ executablePath: require('electron'), args: [path.resolve(__dirname, '..'), `--user-data-dir=${profile}`, ...(process.platform === 'linux' && process.env.MARGIN_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])],
    env: { ...process.env, NODE_ENV: 'test', MARGIN_TEST_USER_DATA: profile, MARGIN_TEST_OLLAMA_PORT: String(port) } })
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(15_000)
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('request', (request) => { if (/^https?:/.test(request.url())) network.push(request.url()) })
    await app.evaluate(({ dialog }, values) => { dialog.showOpenDialog = async (_parent, options) => ({ canceled: false, filePaths: [options.properties.includes('openDirectory') ? values.notes : values.start] }) }, { notes, start })
    assert.equal(await fs.realpath(await app.evaluate(({ app }) => app.getPath('userData'))), await fs.realpath(profile))
    await page.getByRole('button', { name: 'Open folder', exact: true }).click()
    await page.getByRole('button', { name: 'Open file', exact: true }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('switch', { name: 'Autosave files', exact: true }).click()
    await page.getByRole('button', { name: 'Close settings', exact: true }).click()
    await page.getByRole('button', { name: 'Agent desk', exact: true }).click()
    await page.getByText('Disabled · configure a local model', { exact: true }).waitFor()
    assert.equal(requests.length, 0)
    await page.getByRole('button', { name: 'Check connection', exact: true }).click()
    await page.getByText(/Ollama reports cloud disabled/).waitFor()
    await page.getByRole('button', { name: 'Enable Agent desk', exact: true }).click()
    await page.getByRole('textbox', { name: 'Ask the local agent', exact: true }).waitFor()
    assert.equal(requests.some((request) => request.path === '/api/chat'), false)
    const runTask = async (mode, prompt) => {
      await page.getByRole('combobox', { name: 'Agent task', exact: true }).selectOption(mode)
      await page.getByRole('textbox', { name: 'Ask the local agent', exact: true }).fill(prompt || ({ summarize: 'Summarize this note with citations.', revise: 'Make the wording clearer.', draft: 'Draft a Markdown brief from the note.' }[mode] || 'Explain this note.'))
      await page.getByRole('button', { name: 'Start task', exact: true }).click()
    }
    await runTask('summarize')
    await page.getByRole('region', { name: 'Agent answer' }).or(page.locator('.agent-answer')).waitFor()
    await page.getByRole('link', { name: 'C1', exact: true }).click()
    assert.match(await page.locator('.agent-source[open] pre').innerText(), /decided to keep/)
    assert.equal(await fs.readFile(start, 'utf8'), original)
    await page.screenshot({ path: path.join(root, 'agent-answer.png'), scale: 'css' })
    await runTask('revise')
    await page.getByRole('button', { name: 'Review Markdown diff', exact: true }).click()
    await page.getByRole('button', { name: 'Reject', exact: true }).waitFor()
    assert.match(await page.locator('.agent-diff').innerText(), /will keep/)
    assert.equal(await fs.readFile(start, 'utf8'), original)
    await page.screenshot({ path: path.join(root, 'agent-review.png'), scale: 'css' })
    await page.getByRole('button', { name: 'Reject', exact: true }).click()
    assert.equal(await fs.readFile(start, 'utf8'), original)
    await runTask('revise')
    await page.getByRole('button', { name: 'Review Markdown diff', exact: true }).click()
    await page.getByRole('button', { name: 'Accept edit', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.editor-pane.is-active .cm-content')?.textContent.includes('will keep'))
    assert.equal(await fs.readFile(start, 'utf8'), original)
    await page.getByRole('button', { name: 'Undo agent change in Project.md', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.editor-pane.is-active .cm-content')?.textContent.includes('decided to keep'))
    await runTask('revise')
    await page.getByRole('button', { name: 'Review Markdown diff', exact: true }).click()
    await page.locator('.editor-pane.is-active .cm-content').click()
    await page.keyboard.press(`${key}+End`); await page.keyboard.type('\nHuman edit must survive.')
    await page.getByRole('button', { name: 'Accept edit', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: /stale|newer edits/ }).waitFor()
    assert.match(await page.locator('.editor-pane.is-active .cm-content').innerText(), /Human edit must survive/)
    await runTask('ask', 'wait for cancellation')
    await page.locator('.agent-answer').filter({ hasText: 'Working…' }).waitFor()
    await page.getByRole('button', { name: 'Stop task', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Stop task', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: /cancel/i }).waitFor()
    cloudDisabled = false
    const chatCount = requests.filter((request) => request.path === '/api/chat').length
    await runTask('ask', 'This request must not reach inference.')
    await page.getByRole('alert').filter({ hasText: /cloud features are enabled/ }).waitFor()
    assert.equal(requests.filter((request) => request.path === '/api/chat').length, chatCount)
    cloudDisabled = true
    await page.getByRole('checkbox', { name: /Allow search\/read in/ }).check()
    await runTask('ask', 'search permitted folder')
    await page.locator('.agent-answer').filter({ hasText: 'The guide belongs' }).waitFor()
    assert.match(await page.locator('.agent-sources').innerText(), /Reference.md/)
    await page.getByRole('checkbox', { name: /Allow search\/read in/ }).uncheck()
    await runTask('draft')
    await page.getByRole('button', { name: 'Review Markdown diff', exact: true }).click()
    await page.getByRole('button', { name: 'Create draft', exact: true }).click()
    await page.locator('.tab-select[aria-selected="true"]').filter({ hasText: 'Brief.md' }).waitFor()
    assert.equal(await fs.stat(path.join(notes, 'Brief.md')).then(() => true, () => false), false)
    assert.equal(await fs.readFile(start, 'utf8'), original)
    assert.deepEqual(errors, []); assert.deepEqual(network, [])
    console.log(JSON.stringify({ status: 'passed', kind: 'native UI with deterministic loopback protocol fixture', artifacts: root,
      checks: ['disabled makes no runtime requests', 'local-only setup gate', 'source citations', 'review/reject with no source writes', 'approve to editor', 'restore point and undo', 'stale edit protection', 'cancel', 'cloud-enabled runtime blocks inference', 'explicit folder permission', 'unsaved draft approval', 'no renderer HTTP requests'] }, null, 2))
  } catch (error) { console.error(`Agent smoke artifacts: ${root}`); throw error }
  finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {})
    fixture.closeAllConnections(); await new Promise((resolve) => fixture.close(resolve))
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
