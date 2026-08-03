import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installBrowserPreviewApi } from './lib/browserPreviewApi'
import 'katex/dist/katex.min.css'
import 'highlight.js/styles/github.css'
import './styles.css'

installBrowserPreviewApi()
document.documentElement.dataset.platform = /Mac/i.test(navigator.platform) ? 'darwin' : 'other'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
