import { Check, X } from 'lucide-react'
import type { AppSettings, ReaderFont, ReaderTheme, UiTheme } from '../types'

interface AppearancePanelProps {
  settings: AppSettings
  onChange: (patch: Partial<AppSettings>) => void
  onClose: () => void
}

const choices = <T extends string>(values: Array<{ value: T; label: string }>, selected: T, onChange: (value: T) => void) => (
  <div className="choice-grid">
    {values.map(({ value, label }) => (
      <button key={value} className={selected === value ? 'is-selected' : ''} onClick={() => onChange(value)}>
        {label}{selected === value && <Check />}
      </button>
    ))}
  </div>
)

export function AppearancePanel({ settings, onChange, onClose }: AppearancePanelProps) {
  return (
    <aside className="appearance-panel" aria-label="Appearance settings">
      <header>
        <div><span className="eyebrow">Settings</span><h2>Appearance</h2></div>
        <button className="icon-button" aria-label="Close appearance" onClick={onClose}><X /></button>
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
              <button key={theme} className={`theme-swatch swatch-${theme} ${settings.readerTheme === theme ? 'is-selected' : ''}`} onClick={() => onChange({ readerTheme: theme })}>
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

        <section className="toggle-setting">
          <div><strong>Autosave files</strong><span>Save shortly after you stop typing.</span></div>
          <button role="switch" aria-checked={settings.autosave} className={settings.autosave ? 'is-on' : ''} onClick={() => onChange({ autosave: !settings.autosave })}><i /></button>
        </section>
      </div>
    </aside>
  )
}
