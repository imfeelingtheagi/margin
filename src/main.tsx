import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installBrowserPreviewApi } from './lib/browserPreviewApi'
import 'katex/dist/katex.min.css'
import 'highlight.js/styles/github.css'
import './styles.css'
import './features.css'

const isLocalBrowserPreview = /^https?:$/.test(window.location.protocol) && ['127.0.0.1', 'localhost'].includes(window.location.hostname)
if (import.meta.env.DEV || isLocalBrowserPreview) installBrowserPreviewApi()
document.documentElement.dataset.platform = /Mac/i.test(navigator.platform)
  ? 'darwin'
  : /Win/i.test(navigator.platform) ? 'win32' : 'other'

const root = createRoot(document.getElementById('root')!)

root.render(window.margin ? (
  <StrictMode>
    <App />
  </StrictMode>
) : (
  <main className="integration-error" role="alert">
    <h1>Margin could not start safely.</h1>
    <p>The secure desktop bridge did not load. Quit Margin and reopen it; if the problem continues, reinstall the app.</p>
  </main>
))
