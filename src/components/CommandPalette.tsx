import { useEffect, useMemo, useRef, useState } from 'react'
import { Command, Search } from 'lucide-react'

export interface PaletteCommand {
  id: string
  label: string
  group: string
  shortcut?: string
  disabled?: boolean
  run: () => void
}

interface CommandPaletteProps {
  commands: PaletteCommand[]
  onClose: () => void
  label?: string
  placeholder?: string
  emptyMessage?: string
}

export function CommandPalette({
  commands,
  onClose,
  label = 'Command palette',
  placeholder = 'Type a command or open tab…',
  emptyMessage = 'No matching commands',
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const optionRefs = useRef(new Map<string, HTMLButtonElement>())
  const filtered = useMemo(() => {
    const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
    return commands
      .map((command, index) => ({ command, index, score: fuzzyScore(`${command.label} ${command.group}`.toLocaleLowerCase(), terms) }))
      .filter((entry) => !entry.command.disabled && entry.score != null)
      .sort((left, right) => (left.score! - right.score!) || left.index - right.index)
      .map((entry) => entry.command)
      .slice(0, 14)
  }, [commands, query])

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    inputRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('input, button:not(:disabled):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'))
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
  }, [])

  useEffect(() => {
    setSelected(0)
  }, [query])

  const activeIndex = filtered.length ? Math.min(selected, filtered.length - 1) : 0
  const activeCommand = filtered[activeIndex]

  useEffect(() => {
    if (selected !== activeIndex) setSelected(activeIndex)
    optionRefs.current.get(activeCommand?.id ?? '')?.scrollIntoView?.({ block: 'nearest' })
  }, [activeCommand?.id, activeIndex, selected])

  const execute = (command: PaletteCommand | undefined) => {
    if (!command) return
    onClose()
    command.run()
  }

  return (
    <div className="command-palette-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={dialogRef} className="command-palette" role="dialog" aria-modal="true" aria-label={label}>
        <div className="command-search"><Search /><input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
            if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((value) => filtered.length ? (value + 1) % filtered.length : 0); return }
            if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((value) => filtered.length ? (value - 1 + filtered.length) % filtered.length : 0); return }
            if (event.key === 'Enter') { event.preventDefault(); execute(activeCommand) }
          }}
          placeholder={placeholder}
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls="command-palette-results"
          aria-activedescendant={activeCommand ? `command-${activeCommand.id}` : undefined}
        /></div>
        <div className="command-results" id="command-palette-results" role="listbox">
          {filtered.map((command, index) => (
            <button
              id={`command-${command.id}`}
              ref={(node) => {
                if (node) optionRefs.current.set(command.id, node)
                else optionRefs.current.delete(command.id)
              }}
              role="option"
              tabIndex={-1}
              aria-selected={index === activeIndex}
              className={index === activeIndex ? 'is-selected' : ''}
              key={command.id}
              onMouseEnter={() => setSelected(index)}
              onClick={() => execute(command)}
            >
              <Command />
              <span><strong>{command.label}</strong><small>{command.group}</small></span>
              {command.shortcut && <kbd>{command.shortcut}</kbd>}
            </button>
          ))}
          {!filtered.length && <p className="command-empty">{emptyMessage}</p>}
        </div>
      </section>
    </div>
  )
}

function fuzzyScore(value: string, terms: string[]): number | null {
  let total = 0
  for (const term of terms) {
    const exact = value.indexOf(term)
    if (exact >= 0) {
      total += exact
      continue
    }
    let cursor = 0
    let start = -1
    let gaps = 0
    for (const character of term) {
      const next = value.indexOf(character, cursor)
      if (next < 0) return null
      if (start < 0) start = next
      else gaps += next - cursor
      cursor = next + 1
    }
    total += 100 + start + gaps * 2
  }
  return total
}
