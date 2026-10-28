import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Check, ChevronDown, FilePlus2, Paperclip, Play, RefreshCw, Square, Undo2, X } from 'lucide-react'
import type { DocumentTab, WorkspaceDescriptor } from '../types'
import type { AgentAttachment, AgentCheckpoint, AgentConfiguration, AgentConnection, AgentMode, AgentProposal, AgentResult, AgentSelection, AgentSource } from '../agentTypes'
import type { NoteIndex } from '../lib/noteIndex'
import { agentAnswerHtml, agentLineDiff, agentLinkWarnings } from '../lib/agent'
import '../agent.css'

interface Props {
  activeTab: DocumentTab | null
  tabs: DocumentTab[]
  workspace: WorkspaceDescriptor | null
  notes: NoteIndex
  relativePath: string
  selection: AgentSelection | null
  autosave: boolean
  onCaptureSelection: () => void
  onClearSelection: () => void
  onClose: () => void
  onApply: (taskId: string, proposal: AgentProposal) => Promise<AgentCheckpoint>
  onDraft: (proposal: AgentProposal) => void
  onUndo: (checkpoint: AgentCheckpoint) => Promise<void>
  onSource: (source: AgentSource) => Promise<void>
}
const prompts: Record<AgentMode, string> = {
  ask: '', summarize: 'Summarize the important points. Cite supporting passages and say if coverage is partial.',
  extract: 'Extract decisions, action items, and unanswered questions. Cite their sources. Do not invent owners or deadlines.',
  revise: 'Make this passage clearer and more concise without changing its meaning. Preserve code, math, YAML, and links.',
  draft: 'Draft a useful Markdown brief from the attached notes. Link to source notes where appropriate.',
  connect: 'Suggest useful wiki links in this passage using notes in the permitted context. Preserve its wording otherwise.',
}
const labels: Record<AgentMode, string> = { ask: 'Ask', summarize: 'Summarize', extract: 'Extract decisions & tasks', revise: 'Revise passage', draft: 'Draft Markdown', connect: 'Suggest note links' }

export default function AgentDesk(props: Props) {
  const [configuration, setConfiguration] = useState<AgentConfiguration | null>(null)
  const [connection, setConnection] = useState<AgentConnection | null>(null)
  const [model, setModel] = useState('')
  const [setupOpen, setSetupOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [mode, setMode] = useState<AgentMode>('ask')
  const [prompt, setPrompt] = useState('')
  const [attachments, setAttachments] = useState<AgentAttachment[]>([])
  const [folder, setFolder] = useState(false)
  const [stream, setStream] = useState('')
  const [activity, setActivity] = useState<Array<{ message: string; details: string }>>([])
  const [result, setResult] = useState<AgentResult | null>(null)
  const [review, setReview] = useState(false)
  const [applied, setApplied] = useState(false)
  const [taskLabel, setTaskLabel] = useState('')
  const [checkpoints, setCheckpoints] = useState<AgentCheckpoint[]>([])
  const taskId = useRef<string | null>(null)
  const canceled = useRef(false)
  const streamBuffer = useRef('')
  const streamTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attachmentRef = useRef(attachments)
  attachmentRef.current = attachments
  const alive = useRef(true)
  const scroll = useRef<HTMLDivElement>(null)
  const selection = props.selection?.tabId === props.activeTab?.id ? props.selection : null
  const answer = result?.answer || stream
  const answerHtml = useMemo(() => ({ __html: agentAnswerHtml(answer, result?.sources || []) }), [answer, result?.sources])
  const proposal = result?.proposal
  const diff = useMemo(() => proposal ? agentLineDiff(proposal.before, proposal.after) : [], [proposal])
  const warnings = useMemo(() => proposal ? agentLinkWarnings(proposal, props.notes, props.relativePath) : [], [proposal, props.notes, props.relativePath])
  const restore = checkpoints.find((point) => props.activeTab && (point.path ? point.path === props.activeTab.path : point.tabId === props.activeTab.id))

  useEffect(() => {
    alive.current = true
    void window.margin.getAgentConfiguration().then((value) => { if (alive.current) { setConfiguration(value); setModel(value.model); setSetupOpen(!value.enabled) } }).catch((e) => { if (alive.current) setError(e.message) })
    void window.margin.listAgentCheckpoints().then((items) => { if (alive.current) setCheckpoints(items) }).catch(() => {})
    const unsubscribe = window.margin.onAgentEvent((event) => {
      if (!alive.current || canceled.current || event.taskId !== taskId.current) return
      if (event.type === 'status') setStatus(event.message)
      else if (event.type === 'text-reset') {
        if (streamTimer.current) clearTimeout(streamTimer.current)
        streamTimer.current = null; streamBuffer.current = ''; setStream('')
      } else if (event.type === 'text') {
        streamBuffer.current = (streamBuffer.current + event.text).slice(0, 64_000)
        if (!streamTimer.current) streamTimer.current = setTimeout(() => {
          streamTimer.current = null
          const chunk = streamBuffer.current; streamBuffer.current = ''
          if (alive.current && taskId.current === event.taskId) setStream((text) => (text + chunk).slice(0, 64_000))
        }, 100)
      }
      else if (event.type === 'activity') setActivity((items) => [...items.slice(-39), { message: event.message, details: event.details }])
    })
    return () => {
      alive.current = false
      if (streamTimer.current) clearTimeout(streamTimer.current)
      unsubscribe()
      if (taskId.current) window.margin.cancelAgentTask(taskId.current)
      attachmentRef.current.forEach((item) => window.margin.detachAgentNote(item.id))
    }
    // Attachment capabilities are cleared by the native host on window reload;
    // explicit removal is handled by its button without resubscribing this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => { setFolder(false) }, [props.workspace?.id])
  const guarded = async (operation: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await operation() } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'The operation failed.') }
    finally { if (alive.current) setBusy(false) }
  }
  const check = () => guarded(async () => {
    const value = await window.margin.checkAgentConnection()
    if (!alive.current) return
    setConnection(value)
    if (!value.models.some((item) => item.name === model && item.local)) setModel(value.models.find((item) => item.local)?.name || '')
    if (!value.cloudDisabled) throw new Error('Cloud features are enabled. Use the local-only setup below before enabling the Agent desk.')
  })
  const configure = (enabled: boolean) => guarded(async () => {
    const value = await window.margin.setAgentConfiguration({ enabled, model })
    if (alive.current) { setConfiguration(value); setSetupOpen(!enabled); setResult(null); setStream('') }
  })
  const run = async () => {
    if (!configuration?.enabled || running || busy) return
    const id = crypto.randomUUID()
    canceled.current = false
    if (streamTimer.current) clearTimeout(streamTimer.current)
    streamTimer.current = null; streamBuffer.current = ''
    taskId.current = id
    setRunning(true); setError(''); setResult(null); setStream(''); setActivity([]); setReview(false); setApplied(false)
    const tab = props.activeTab
    const from = selection?.from ?? 0, to = selection?.to ?? tab?.content.length ?? 0
    setTaskLabel(`${labels[mode]} · ${selection ? 'selected passage' : tab?.name || 'attached notes'}`)
    const normal = (value: string) => value.replace(/\\/g, '/').replace(/\/$/, '')
    try {
      const value = await window.margin.runAgentTask({ taskId: id, prompt: prompt.trim() || prompts[mode], mode,
        target: tab ? { tabId: tab.id, path: tab.path, name: tab.name, content: tab.content, savedContent: tab.savedContent, mtimeMs: tab.mtimeMs, from, to } : null,
        ...(selection ? { selectionText: selection.text } : {}), attachedIds: attachments.map((item) => item.id), workspaceId: folder ? props.workspace?.id || null : null,
        buffers: folder && props.workspace ? props.tabs.filter((item) => item.path && normal(item.path).startsWith(`${normal(props.workspace!.rootPath)}/`)).map((item) => ({ path: item.path!, content: item.content })) : [],
      })
      if (alive.current && taskId.current === id) {
        if (streamTimer.current) clearTimeout(streamTimer.current)
        streamTimer.current = null; streamBuffer.current = ''
        setResult(value); setStream(''); setStatus(value.proposal ? 'Proposal ready. No document has changed.' : 'Finished. Check the sources before relying on the answer.')
      }
    } catch (e) { if (alive.current && taskId.current === id) {
      if (streamTimer.current) clearTimeout(streamTimer.current)
      streamTimer.current = null; streamBuffer.current = ''
      setError(e instanceof Error ? e.message : 'The task failed.'); setStream('')
    } }
    finally { if (alive.current && taskId.current === id) setRunning(false) }
  }
  const stop = () => {
    if (!taskId.current) return
    canceled.current = true
    if (streamTimer.current) clearTimeout(streamTimer.current)
    streamTimer.current = null; streamBuffer.current = ''; setStream('')
    window.margin.cancelAgentTask(taskId.current)
    setStatus('Stopping… No proposal will be applied.'); setResult(null)
  }
  const apply = () => guarded(async () => {
    if (!proposal || !taskId.current) return
    if (proposal.kind === 'draft') props.onDraft(proposal)
    else {
      const checkpoint = await props.onApply(taskId.current, proposal)
      if (alive.current) setCheckpoints((items) => [checkpoint, ...items].slice(0, 20))
    }
    if (alive.current) { setApplied(true); setReview(false); setStatus(proposal.kind === 'draft' ? 'Created an unsaved draft. Choose Save when you want a file.' : 'Applied to the editor. Your normal autosave setting applies.') }
  })

  return <aside className="agent-desk" aria-label="Agent desk">
    <header><div><Bot /><strong>Agent desk</strong><span className="agent-local-label">Local only</span></div><button className="icon-button" aria-label="Close Agent desk" title="Closing cancels a running task" onClick={props.onClose}><X /></button></header>
    <div className="agent-desk-scroll" ref={scroll}>
      <p className="agent-intro">A private reading and writing helper. It proposes; you decide.</p>
      <button className="agent-setup-toggle" aria-expanded={setupOpen} onClick={() => setSetupOpen((value) => !value)}><span>{configuration?.enabled ? configuration.model : 'Disabled · configure a local model'}</span><ChevronDown /></button>
      {setupOpen && <section className="agent-setup" aria-label="Local model setup">
        <p>Margin never installs models or falls back to the cloud. Install Ollama separately and download a tool-capable model only when you choose to.</p>
        <details><summary>Offline setup instructions</summary>
          <ol><li>Install Ollama from its official website using your browser.</li><li>Quit its running server, disable cloud features, and start the local server:</li></ol>
          <pre>OLLAMA_NO_CLOUD=1 ollama serve</pre>
          <p>Alternatively set <code>{'"disable_ollama_cloud": true'}</code> in Ollama's server configuration and restart it. Margin checks <code>/api/status</code> before sending document text.</p>
          <p>Install a model that supports tools and at least 8K context. Downloading weights needs a one-time connection; reading and writing afterward can stay offline. Then use Check connection below. You may need to update older Ollama versions.</p>
          <p>The endpoint is fixed to <code>127.0.0.1:11434</code>. Margin does not control an independently installed runtime's updates or logs.</p>
        </details>
        <button className="secondary-button" disabled={busy || running} onClick={() => void check()}><RefreshCw />{busy ? 'Checking…' : 'Check connection'}</button>
        {connection && <p className={connection.cloudDisabled ? 'agent-success' : 'agent-warning'}>{connection.cloudDisabled ? 'Ollama reports cloud disabled.' : 'Cloud features must be disabled.'} {connection.models.filter((item) => item.local).length} local models found.</p>}
        <label>Installed model<select aria-label="Local agent model" value={model} disabled={!connection || busy || running} onChange={(event) => setModel(event.target.value)}><option value="">Choose a local model…</option>{connection?.models.map((item) => <option key={item.name} value={item.name} disabled={!item.local}>{item.name}{item.local ? '' : ' — remote/unsupported'}</option>)}</select></label>
        <div className="agent-button-row"><button className="primary-button" disabled={busy || running || !connection?.cloudDisabled || !model} onClick={() => void configure(true)}>Enable Agent desk</button>{configuration?.enabled && <button className="secondary-button" disabled={busy || running} onClick={() => void configure(false)}>Disable</button>}</div>
      </section>}
      {error && <p className="agent-error" role="alert">{error}</p>}
      {configuration?.enabled && <>
        <section className="agent-context" aria-label="Permitted context"><h3>Permitted context</h3>
          <div className="agent-context-chip">{selection ? `Selected passage in ${props.activeTab?.name}` : props.activeTab?.name || 'No active document'}{selection && <button aria-label="Use whole document instead" disabled={running} onClick={props.onClearSelection}><X /></button>}</div>
          <button className="agent-small-action" disabled={!props.activeTab || running} onMouseDown={(event) => event.preventDefault()} onClick={props.onCaptureSelection}>Use current selection</button>
          <button className="agent-small-action" disabled={busy || running || attachments.length >= 10} onClick={() => void guarded(async () => { const added = await window.margin.attachAgentNotes(); if (alive.current) setAttachments((items) => [...items, ...added]); else added.forEach((item) => window.margin.detachAgentNote(item.id)) })}><Paperclip /> Attach notes…</button>
          {attachments.map((item) => <div className="agent-context-chip" key={item.id} title={item.path}>{item.name}<button disabled={running} aria-label={`Remove ${item.name} from agent context`} onClick={() => { window.margin.detachAgentNote(item.id); setAttachments((items) => items.filter((other) => other.id !== item.id)) }}><X /></button></div>)}
          {props.workspace && <label className="agent-folder-permission"><input type="checkbox" checked={folder} disabled={running} onChange={(event) => setFolder(event.target.checked)} /> Allow search/read in “{props.workspace.name}”</label>}
          <small>No other folders, web access, or personal annotations. Context is snapshotted when you start.</small>
        </section>
        <section className="agent-composer"><label>Task<select aria-label="Agent task" value={mode} disabled={running} onChange={(event) => { const next = event.target.value as AgentMode; setMode(next); setPrompt((value) => !value || value === prompts[mode] ? prompts[next] : value) }}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <textarea aria-label="Ask the local agent" placeholder="What would you like to understand or improve?" maxLength={4000} value={prompt} disabled={running} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void run() } }} />
          <div className="agent-button-row">{running ? <button className="secondary-button" onClick={stop}><Square />Stop task</button> : <button className="primary-button" disabled={busy || (!prompt.trim() && !prompts[mode])} onClick={() => void run()}><Play />Start task</button>}<small>One task · bounded context</small></div>
        </section>
      </>}
      {status && <p className="agent-status" role="status">{status}</p>}
      {taskLabel && <h3 className="agent-task-label">{taskLabel}</h3>}
      {answer && <section className="agent-answer markdown-body" aria-label="Agent answer" dangerouslySetInnerHTML={answerHtml} onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest('a'); if (!anchor) return
        event.preventDefault(); const id = anchor.getAttribute('href')?.replace('#agent-source-', '')
        if (result?.sources.some((source) => source.id === id)) {
          const details = document.getElementById(`agent-source-${id}`) as HTMLDetailsElement | null
          if (details) { details.open = true; details.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }
        }
      }} />}
      {result?.warnings.map((warning) => <p className="agent-warning" key={warning}>{warning}</p>)}
      {proposal && !applied && <section className="agent-proposal"><h3>{proposal.kind === 'draft' ? 'Proposed draft' : 'Proposed edit'} · {proposal.name}</h3><p>{proposal.reason}</p><p className="agent-review-reminder">Nothing has changed. Review before accepting.</p>
        <button className="secondary-button" aria-expanded={review} onClick={() => setReview((value) => !value)}>Review Markdown diff</button>
        {review && <><div className="agent-diff" aria-label="Proposed Markdown diff">{diff.slice(0, 2000).map((line, index) => <div className={`agent-diff-line diff-${line.type}`} key={index}><span aria-hidden="true">{line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}</span><code>{line.text || ' '}</code></div>)}</div>{diff.length > 2000 && <p className="agent-warning">Showing the first 2,000 diff lines. Inspect the full proposed Markdown below.</p>}<details><summary>Full proposed Markdown</summary><textarea className="agent-full-proposal" readOnly aria-label="Full proposed Markdown" value={proposal.after} /></details>
          {warnings.map((warning) => <p className="agent-warning" key={warning}>{warning}</p>)}
          <p className="agent-review-reminder">{proposal.kind === 'draft' ? 'Creates an unsaved tab, not a file.' : props.autosave ? 'Accepting changes the editor. Autosave is on and will save normally.' : 'Accepting changes the editor. Save when you are ready.'}</p>
          <div className="agent-button-row"><button className="primary-button" disabled={busy || running} onClick={() => void apply()}>{proposal.kind === 'draft' ? <FilePlus2 /> : <Check />}{proposal.kind === 'draft' ? 'Create draft' : 'Accept edit'}</button><button className="secondary-button" disabled={busy} onClick={() => { setResult((value) => value ? { ...value, proposal: null } : value); setReview(false); setStatus('Proposal discarded. No document changed.') }}>Reject</button></div>
        </>}
      </section>}
      {restore && <button className="agent-undo secondary-button" disabled={busy || running} onClick={() => void guarded(async () => { await props.onUndo(restore); setCheckpoints((items) => items.filter((item) => item.id !== restore.id)); setStatus('Restored the text from before that agent edit. Normal saving still applies.') })}><Undo2 />Undo agent change in {restore.name}</button>}
      {!!result?.sources.length && <section className="agent-sources" aria-label="Agent sources"><h3>Sources actually read</h3><p>{result.readFiles} note snapshots · {result.characters.toLocaleString()} characters · {result.toolCalls} tool calls</p>{result.sources.map((source) => <details className="agent-source" id={`agent-source-${source.id}`} key={source.id}><summary>{source.id} · {source.name} · {source.selection ? 'selection' : `lines ${source.startLine}–${source.endLine}`}</summary><pre>{source.text}</pre><button className="agent-small-action" onClick={() => void guarded(() => props.onSource(source))}>Open source in editor</button></details>)}</section>}
      {!!activity.length && <details className="agent-activity"><summary>Activity · {activity.length} events</summary>{activity.map((item, index) => <details key={index}><summary>{item.message}</summary><pre>{item.details}</pre></details>)}</details>}
    </div>
  </aside>
}
