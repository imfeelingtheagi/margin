import {
  Bold, Braces, CheckSquare, Code2, Columns2, Eye, FilePlus2, FolderOpen, FolderTree, Heading1, Heading2,
  Image, Italic, Link, List, ListOrdered, PanelLeft, Palette, PencilLine, Quote,
  Redo2, Save, Search, Sigma, Strikethrough, Table2, Undo2, Workflow, Sparkles, BookMarked, Network, Presentation, ArrowLeft, ArrowRight, Bot,
} from 'lucide-react'
import type { DocumentMode } from '../types'

export type FormatAction =
  | 'undo' | 'redo' | 'bold' | 'italic' | 'strike' | 'heading1' | 'heading2' | 'link'
  | 'heading3'
  | 'image' | 'code' | 'codeblock' | 'quote' | 'list' | 'ordered' | 'task' | 'table'
  | 'math' | 'mermaid'

interface ToolbarProps {
  mode: DocumentMode
  hasDocument: boolean
  outlineOpen: boolean
  workspaceOpen: boolean
  onNew: () => void
  onOpen: () => void
  onOpenWorkspace: () => void
  onSave: () => void
  onMode: (mode: DocumentMode) => void
  onOutline: () => void
  onFind: () => void
  onAppearance: () => void
  onFormat: (action: FormatAction) => void
  onReadingTools: () => void
  readingToolsOpen: boolean
  onGraph: () => void
  onPresent: () => void
  onBack: () => void
  onForward: () => void
  canBack: boolean
  canForward: boolean
  agentOpen: boolean
  onAgent: () => void
}

const IconButton = ({ label, children, onClick, disabled = false }: {
  label: string; children: React.ReactNode; onClick: () => void; disabled?: boolean
}) => (
  <button className="icon-button" type="button" title={label} aria-label={label} onClick={onClick} disabled={disabled}>
    {children}
  </button>
)

export function Toolbar(props: ToolbarProps) {
  const formatButtons: Array<[FormatAction, string, React.ReactNode]> = [
    ['undo', 'Undo', <Undo2 />], ['redo', 'Redo', <Redo2 />],
    ['bold', 'Bold', <Bold />], ['italic', 'Italic', <Italic />], ['strike', 'Strikethrough', <Strikethrough />],
    ['heading1', 'Heading 1', <Heading1 />], ['heading2', 'Heading 2', <Heading2 />],
    ['link', 'Link', <Link />], ['image', 'Image', <Image />], ['quote', 'Blockquote', <Quote />],
    ['list', 'Bullet list', <List />], ['ordered', 'Numbered list', <ListOrdered />], ['task', 'Task list', <CheckSquare />],
    ['code', 'Inline code', <Code2 />], ['codeblock', 'Code block', <Braces />], ['table', 'Insert or format table', <Table2 />],
    ['math', 'Math', <Sigma />], ['mermaid', 'Mermaid diagram', <Workflow />],
  ]

  return (
    <>
      <header className="main-toolbar app-drag-region">
        <div className="traffic-light-space" />
        <div className="toolbar-group no-drag">
          <IconButton label="Back" disabled={!props.canBack} onClick={props.onBack}><ArrowLeft /></IconButton>
          <IconButton label="Forward" disabled={!props.canForward} onClick={props.onForward}><ArrowRight /></IconButton>
          <IconButton label={props.outlineOpen ? 'Hide sidebar' : 'Show sidebar'} onClick={props.onOutline}>
            <PanelLeft />
          </IconButton>
          <span className="toolbar-divider" />
          <IconButton label="New document" onClick={props.onNew}><FilePlus2 /></IconButton>
          <IconButton label="Open file" onClick={props.onOpen}><FolderOpen /></IconButton>
          <IconButton label={props.workspaceOpen ? 'Choose another folder' : 'Open folder'} onClick={props.onOpenWorkspace}><FolderTree /></IconButton>
          <IconButton label="Save" onClick={props.onSave} disabled={!props.hasDocument}><Save /></IconButton>
        </div>

        <div className="mode-switch no-drag" role="group" aria-label="Document mode">
          <button aria-label="Read" aria-pressed={props.mode === 'read'} className={props.mode === 'read' ? 'is-active' : ''} onClick={() => props.onMode('read')} disabled={!props.hasDocument}>
            <Eye /> <span>Read</span>
          </button>
          <button aria-label="Edit" aria-pressed={props.mode === 'edit'} className={props.mode === 'edit' ? 'is-active' : ''} onClick={() => props.onMode('edit')} disabled={!props.hasDocument}>
            <PencilLine /> <span>Edit</span>
          </button>
          <button aria-label="Live edit" aria-pressed={props.mode === 'live'} className={props.mode === 'live' ? 'is-active' : ''} onClick={() => props.onMode('live')} disabled={!props.hasDocument}>
            <Sparkles /> <span>Live</span>
          </button>
          <button aria-label="Split" aria-pressed={props.mode === 'split'} className={props.mode === 'split' ? 'is-active' : ''} onClick={() => props.onMode('split')} disabled={!props.hasDocument}>
            <Columns2 /> <span>Split</span>
          </button>
        </div>

        <div className="toolbar-group toolbar-group-end no-drag">
          <button className={`icon-button ${props.agentOpen ? 'is-active' : ''}`} title="Agent desk · local reading and writing helper" aria-label="Agent desk" aria-pressed={props.agentOpen} onClick={props.onAgent}><Bot /></button>
          <IconButton label="Present document" onClick={props.onPresent} disabled={!props.hasDocument}><Presentation /></IconButton>
          <IconButton label="Note graph" onClick={props.onGraph}><Network /></IconButton>
          <button className={`icon-button ${props.readingToolsOpen ? 'is-active' : ''}`} title="Reading tools and connections" aria-label="Reading tools and connections" aria-pressed={props.readingToolsOpen} onClick={props.onReadingTools}><BookMarked /></button>
          <IconButton label="Find" onClick={props.onFind} disabled={!props.hasDocument}><Search /></IconButton>
          <IconButton label="Settings" onClick={props.onAppearance}><Palette /></IconButton>
        </div>
      </header>

      {props.mode !== 'read' && props.hasDocument && (
        <div className="format-toolbar" role="toolbar" aria-label="Markdown formatting">
          {formatButtons.map(([action, label, icon], index) => (
            <span className={(index === 2 || index === 5 || index === 7 || index === 13 || index === 15) ? 'format-break' : ''} key={action}>
              <IconButton label={label} onClick={() => props.onFormat(action)}>{icon}</IconButton>
            </span>
          ))}
        </div>
      )}
    </>
  )
}
