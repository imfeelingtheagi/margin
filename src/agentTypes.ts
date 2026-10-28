export type AgentMode = 'ask' | 'summarize' | 'extract' | 'revise' | 'draft' | 'connect'
export interface AgentConfiguration { enabled: boolean; model: string }
export interface AgentModel { name: string; size: number; local: boolean; digest: string }
export interface AgentConnection { cloudDisabled: boolean; models: AgentModel[] }
export interface AgentAttachment { id: string; name: string; path: string; characters: number }
export interface AgentSelection { tabId: string; text: string; from: number | null; to: number | null }
export interface AgentTarget {
  tabId: string; path: string | null; name: string; content: string; savedContent: string; mtimeMs: number | null
  from: number; to: number
}
export interface AgentRequest {
  taskId: string; prompt: string; mode: AgentMode; target: AgentTarget | null
  selectionText?: string
  attachedIds: string[]; workspaceId: string | null
  buffers: Array<{ path: string; content: string }>
}
export interface AgentSource {
  id: string; noteId: string; name: string; path: string | null; tabId: string | null; relativePath: string
  startLine: number; endLine: number; text: string; hash: string; selection: boolean
}
export interface AgentProposal {
  id: string; kind: 'edit' | 'draft'; name: string; before: string; after: string; reason: string
  tabId?: string; path?: string | null; from?: number; to?: number; baseHash?: string
}
export interface AgentResult {
  answer: string; proposal: AgentProposal | null; sources: AgentSource[]; warnings: string[]
  toolCalls: number; readFiles: number; characters: number
}
export type AgentEvent = { taskId: string } & (
  | { type: 'status'; message: string }
  | { type: 'text'; text: string }
  | { type: 'text-reset' }
  | { type: 'activity'; message: string; details: string }
)
export interface AgentCheckpoint { id: string; path: string | null; tabId: string; name: string; createdAt: number; afterHash: string }
export interface AgentCurrentDocument { tabId: string; path: string | null; content: string; savedContent: string; mtimeMs: number | null }
export interface AgentApi {
  getAgentConfiguration: () => Promise<AgentConfiguration>
  setAgentConfiguration: (configuration: AgentConfiguration) => Promise<AgentConfiguration>
  checkAgentConnection: () => Promise<AgentConnection>
  attachAgentNotes: () => Promise<AgentAttachment[]>
  detachAgentNote: (id: string) => void
  runAgentTask: (request: AgentRequest) => Promise<AgentResult>
  cancelAgentTask: (taskId: string) => void
  onAgentEvent: (callback: (event: AgentEvent) => void) => () => void
  prepareAgentApply: (taskId: string, proposalId: string, current: AgentCurrentDocument) => Promise<AgentCheckpoint>
  getAgentRestore: (checkpointId: string, current: AgentCurrentDocument) => Promise<string>
  listAgentCheckpoints: () => Promise<AgentCheckpoint[]>
}
