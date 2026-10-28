// Offline documentation QA: no link crawling and no writes to the app profile.
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const MarkdownIt = require('markdown-it')
const anchorModule = require('markdown-it-anchor')
const anchor = anchorModule.default || anchorModule
const root = path.resolve(__dirname, '..')
// Keep aligned with src/lib/headings.ts so local guide anchors match Margin.
const slugify = (value) => value.trim().toLowerCase().replace(/<[^>]+>/g, '')
  .replace(/[`*_~[\](){}]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '')
  .replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'section'
const parser = new MarkdownIt({ html: true }).use(anchor, { slugify })

async function collect(directory) {
  const files = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collect(file))
    else if (entry.name.endsWith('.md')) files.push(file)
  }
  return files
}

async function check() {
  const files = [path.join(root, 'README.md'), ...await collect(__dirname)]
  const parsed = new Map()
  const parse = async (file) => {
    if (!parsed.has(file)) parsed.set(file, parser.parse(await fs.readFile(file, 'utf8'), {}))
    return parsed.get(file)
  }
  const problems = []
  let links = 0, diagrams = 0
  const images = new Set()
  for (const file of files) {
    for (const token of await parse(file)) {
      if (token.type === 'fence' && token.info.trim() === 'mermaid') diagrams += 1
      for (const child of token.children || []) {
        const attribute = child.type === 'link_open' ? 'href' : child.type === 'image' ? 'src' : null
        if (!attribute) continue
        const reference = child.attrGet(attribute)
        if (!reference || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)) continue
        links += 1
        const [pathname, ...fragmentParts] = reference.split('#')
        const target = pathname ? path.resolve(path.dirname(file), decodeURIComponent(pathname)) : file
        const fragment = decodeURIComponent(fragmentParts.join('#'))
        const label = `${path.relative(root, file)} -> ${reference}`
        try {
          const stat = await fs.stat(target)
          if (!stat.isFile()) throw new Error('not a regular file')
          if (child.type === 'image') images.add(target)
          if (fragment && target.endsWith('.md')) {
            const headings = (await parse(target)).filter((item) => item.type === 'heading_open').map((item) => item.attrGet('id'))
            if (!headings.includes(fragment)) problems.push(`${label}: missing heading anchor`)
          }
        } catch (error) { problems.push(`${label}: ${error.message}`) }
      }
    }
  }
  const dimensions = []
  let manifest = null
  try {
    manifest = JSON.parse(await fs.readFile(path.join(__dirname, 'assets', 'capture-manifest.json'), 'utf8'))
    if (manifest.formatVersion !== 1 || !manifest.captures || typeof manifest.captures !== 'object') throw new Error('Unsupported capture metadata')
  } catch (error) { problems.push(`docs/assets/capture-manifest.json: ${error.message}`) }
  const rendererBuilds = new Set()
  for (const file of images) {
    if (path.extname(file).toLowerCase() !== '.png') continue
    const data = await fs.readFile(file)
    if (data.length < 24 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') problems.push(`${file}: invalid PNG`)
    else {
      const width = data.readUInt32BE(16), height = data.readUInt32BE(20)
      dimensions.push({ file: path.relative(root, file), width, height, kib: Math.round(data.length / 1024) })
      const record = manifest?.captures?.[path.basename(file, '.png')]
      if (!record) problems.push(`${path.relative(root, file)}: missing capture metadata`)
      else {
        if (record.sha256 !== createHash('sha256').update(data).digest('hex')) problems.push(`${path.relative(root, file)}: screenshot checksum differs from the capture manifest`)
        if (record.width !== width || record.height !== height) problems.push(`${path.relative(root, file)}: capture dimensions differ`)
        if (record.networkRequests !== 0) problems.push(`${path.relative(root, file)}: capture did not confirm zero network requests`)
        if (!/^[a-f\d]{64}$/.test(record.rendererEntrySha256 || '')) problems.push(`${path.relative(root, file)}: invalid renderer fingerprint`)
        else rendererBuilds.add(record.rendererEntrySha256)
      }
    }
  }
  if (rendererBuilds.size > 1) problems.push('Documentation screenshots come from different renderer builds; refresh the full set.')
  console.log(JSON.stringify({ files: files.length, localLinks: links, mermaidDiagrams: diagrams, images: dimensions, problems }, null, 2))
  if (problems.length) process.exitCode = 1
}

check().catch((error) => { console.error(error); process.exitCode = 1 })
