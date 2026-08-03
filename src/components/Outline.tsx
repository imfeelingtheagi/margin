import { BookOpenText, FileText } from 'lucide-react'
import type { DocumentTab, OutlineItem } from '../types'

interface OutlineProps {
  tabs: DocumentTab[]
  activeId: string | null
  items: OutlineItem[]
  onSelectTab: (id: string) => void
  onHeading: (item: OutlineItem) => void
}

export function Outline({ tabs, activeId, items, onSelectTab, onHeading }: OutlineProps) {
  return (
    <aside className="outline-sidebar">
      <section className="sidebar-section open-documents">
        <h2><FileText /> Open documents</h2>
        {tabs.length === 0 ? <p className="sidebar-empty">No open documents</p> : (
          <div className="sidebar-tabs">
            {tabs.map((tab) => (
              <button key={tab.id} className={tab.id === activeId ? 'is-active' : ''} onClick={() => onSelectTab(tab.id)}>
                <span>{tab.name}</span>
                {tab.content !== tab.savedContent && <i aria-label="Unsaved changes" />}
              </button>
            ))}
          </div>
        )}
      </section>
      <section className="sidebar-section document-outline">
        <h2><BookOpenText /> Outline</h2>
        {items.length === 0 ? <p className="sidebar-empty">Headings will appear here.</p> : (
          <nav aria-label="Document outline">
            {items.map((item) => (
              <button
                key={`${item.id}-${item.line}`}
                onClick={() => onHeading(item)}
                style={{ '--heading-depth': item.level } as React.CSSProperties}
                title={`Line ${item.line}`}
              >
                {item.text}
              </button>
            ))}
          </nav>
        )}
      </section>
    </aside>
  )
}
