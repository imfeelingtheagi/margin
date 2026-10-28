import { useEffect, useId, useRef } from 'react'
import { Check, X } from 'lucide-react'
import type { AppSettings, EditorFont, ReaderFont, ReaderTheme, UiTheme } from '../types'

interface AppearancePanelProps {
  settings: AppSettings
  spellcheckAvailable: boolean
  onChange: (patch: Partial<AppSettings>) => void
  onClose: () => void
}

const choices = <T extends string>(values: Array<{ value: T; label: string }>, selected: T, onChange: (value: T) => void) => (
  <div className="choice-grid">
    {values.map(({ value, label }) => (
      <button key={value} aria-pressed={selected === value} className={selected === value ? 'is-selected' : ''} onClick={() => onChange(value)}>
        {label}{selected === value && <Check />}
      </button>
    ))}
  </div>
)

const ToggleSetting = ({ label, description, checked, disabled = false, onChange }: {
  label: string; description: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void
}) => {
  const descriptionId = useId()
  return (
    <section className="toggle-setting">
      <div><strong>{label}</strong><span id={descriptionId}>{description}</span></div>
      <button role="switch" aria-label={label} aria-describedby={descriptionId} aria-checked={checked} className={checked ? 'is-on' : ''} disabled={disabled} onClick={() => onChange(!checked)}><i /></button>
    </section>
  )
}

export function AppearancePanel({ settings, spellcheckAvailable, onChange, onClose }: AppearancePanelProps) {
  const panelRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const headingId = useId()

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key !== 'Tab' || !panelRef.current) return
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'))
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
  }, [onClose])

  return (
    <aside ref={panelRef} className="appearance-panel" role="dialog" aria-modal="true" aria-labelledby={headingId}>
      <header>
        <div><span className="eyebrow">Preferences</span><h2 id={headingId}>Settings</h2></div>
        <button ref={closeRef} className="icon-button" aria-label="Close settings" onClick={onClose}><X /></button>
      </header>

      <div className="settings-scroll">
        <section>
          <label className="settings-label">Interface</label>
          {choices<UiTheme>([
            { value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' },
          ], settings.uiTheme, (uiTheme) => onChange({ uiTheme }))}
        </section>

        <section>
          <label className="settings-label">Reading surface</label>
          <div className="theme-swatches">
            {(['paper', 'snow', 'sepia', 'midnight', 'custom'] as ReaderTheme[]).map((theme) => (
              <button key={theme} aria-pressed={settings.readerTheme === theme} className={`theme-swatch swatch-${theme} ${settings.readerTheme === theme ? 'is-selected' : ''}`} onClick={() => onChange({ readerTheme: theme })}>
                <i /><span>{theme[0].toUpperCase() + theme.slice(1)}</span>{settings.readerTheme === theme && <Check />}
              </button>
            ))}
          </div>
        </section>

        {settings.readerTheme === 'custom' && (
          <section className="color-settings">
            <label>Background <input type="color" value={settings.customBackground} onChange={(e) => onChange({ customBackground: e.target.value })} /></label>
            <label>Text <input type="color" value={settings.customText} onChange={(e) => onChange({ customText: e.target.value })} /></label>
            <label>Accent <input type="color" value={settings.customAccent} onChange={(e) => onChange({ customAccent: e.target.value })} /></label>
          </section>
        )}

        <section>
          <label className="settings-label">Reading typeface</label>
          {choices<ReaderFont>([
            { value: 'serif', label: 'Serif' }, { value: 'sans', label: 'Sans' }, { value: 'mono', label: 'Mono' },
          ], settings.readerFont, (readerFont) => onChange({ readerFont }))}
        </section>

        <section className="range-settings">
          <label><span>Text size <b>{settings.fontSize}px</b></span><input type="range" min="14" max="26" value={settings.fontSize} onChange={(e) => onChange({ fontSize: Number(e.target.value) })} /></label>
          <label><span>Line height <b>{settings.lineHeight.toFixed(2)}</b></span><input type="range" min="1.3" max="2.1" step="0.05" value={settings.lineHeight} onChange={(e) => onChange({ lineHeight: Number(e.target.value) })} /></label>
          <label><span>Page width <b>{settings.contentWidth}px</b></span><input type="range" min="560" max="1040" step="20" value={settings.contentWidth} onChange={(e) => onChange({ contentWidth: Number(e.target.value) })} /></label>
        </section>

        <section className="settings-group-heading">
          <h3 className="eyebrow">Editor</h3>
          <p>Source-view behavior and typography.</p>
        </section>

        <section>
          <label className="settings-label">Editor typeface</label>
          {choices<EditorFont>([
            { value: 'mono', label: 'Mono' }, { value: 'sans', label: 'Sans' },
          ], settings.editorFont, (editorFont) => onChange({ editorFont }))}
        </section>

        <section className="range-settings">
          <label><span>Editor size <b>{settings.editorFontSize}px</b></span><input type="range" min="12" max="24" value={settings.editorFontSize} onChange={(e) => onChange({ editorFontSize: Number(e.target.value) })} /></label>
          <label><span>Editor line height <b>{settings.editorLineHeight.toFixed(2)}</b></span><input type="range" min="1.2" max="2.2" step="0.05" value={settings.editorLineHeight} onChange={(e) => onChange({ editorLineHeight: Number(e.target.value) })} /></label>
          <label><span>Editor width <b>{settings.editorContentWidth}px</b></span><input type="range" min="560" max="1400" step="20" value={settings.editorContentWidth} onChange={(e) => onChange({ editorContentWidth: Number(e.target.value) })} /></label>
          <label><span>Tab width <b>{settings.editorTabSize}</b></span><input type="range" min="2" max="8" step="1" value={settings.editorTabSize} onChange={(e) => onChange({ editorTabSize: Number(e.target.value) })} /></label>
        </section>

        <section><label className="settings-label">Writing focus</label>{choices<AppSettings['editorFocus']>([
          { value: 'off', label: 'Off' }, { value: 'sentence', label: 'Sentence' }, { value: 'paragraph', label: 'Paragraph' },
        ], settings.editorFocus, (editorFocus) => onChange({ editorFocus }))}</section>
        <ToggleSetting label="Word wrap" description="Wrap long lines without changing the file." checked={settings.editorWordWrap} onChange={(editorWordWrap) => onChange({ editorWordWrap })} />
        <ToggleSetting label="Line numbers" description="Show source line numbers in the gutter." checked={settings.editorLineNumbers} onChange={(editorLineNumbers) => onChange({ editorLineNumbers })} />
        <ToggleSetting
          label="Spellcheck"
          description={spellcheckAvailable ? 'Use the operating system’s on-device spelling service.' : 'Unavailable without a bundled local dictionary; Margin will not download one.'}
          checked={spellcheckAvailable && settings.editorSpellcheck}
          disabled={!spellcheckAvailable}
          onChange={(editorSpellcheck) => onChange({ editorSpellcheck })}
        />
        <ToggleSetting label="Visible whitespace" description="Reveal spaces and tabs while editing." checked={settings.editorShowWhitespace} onChange={(editorShowWhitespace) => onChange({ editorShowWhitespace })} />
        <ToggleSetting label="Code folding" description="Show controls for folding Markdown sections." checked={settings.editorCodeFolding} onChange={(editorCodeFolding) => onChange({ editorCodeFolding })} />
        <ToggleSetting label="Typewriter mode" description="Keep the current line near the center." checked={settings.editorTypewriterMode} onChange={(editorTypewriterMode) => onChange({ editorTypewriterMode })} />
        <ToggleSetting label="Indent with tabs" description="Use tab characters instead of spaces." checked={settings.editorIndentWithTabs} onChange={(editorIndentWithTabs) => onChange({ editorIndentWithTabs })} />

        <section className="settings-group-heading">
          <h3 className="eyebrow">Files</h3>
          <p>Saving and local recovery behavior.</p>
        </section>

        <ToggleSetting label="Autosave files" description="Save after you stop typing." checked={settings.autosave} onChange={(autosave) => onChange({ autosave })} />
      </div>
    </aside>
  )
}
