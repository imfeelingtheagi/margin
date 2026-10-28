const path = require('node:path')
const { fileURLToPath } = require('node:url')

function isAllowedAppRequest(rawUrl, assetRoot, developmentUrl = null, renderFile = null) {
  let url
  try { url = new URL(rawUrl) } catch { return false }
  if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return true
  if (url.protocol === 'file:') {
    try {
      const requested = fileURLToPath(url)
      if (renderFile && path.relative(path.resolve(renderFile), requested) === '') return true
      const relative = path.relative(path.resolve(assetRoot), requested)
      return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    } catch { return false }
  }
  if (!developmentUrl) return false
  if (url.protocol === 'devtools:') return true
  try {
    const development = new URL(developmentUrl)
    return ['http:', 'ws:'].includes(url.protocol) && development.protocol === 'http:'
      && development.hostname === '127.0.0.1' && url.hostname === development.hostname && url.port === development.port
  } catch { return false }
}

module.exports = { isAllowedAppRequest }
