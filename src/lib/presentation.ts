import { markdownBlocks } from './markdown'

export function presentationSlides(content: string) {
  const lines = content.split('\n')
  const breaks = markdownBlocks(content).flatMap((block) => {
    const line = lines[block.fromLine - 1] || ''
    return /^(?:#{1,2}\s|\s*(?:---+|\*\s*\*\s*\*|___+)\s*$)/.test(line)
      ? [{ line: block.fromLine - 1, separator: !/^#{1,2}\s/.test(line) }] : []
  })
  const slides: string[] = []
  let start = 0
  for (const point of breaks) {
    const before = lines.slice(start, point.line).join('\n').trim()
    if (before) slides.push(before)
    start = point.line + (point.separator ? 1 : 0)
  }
  const tail = lines.slice(start).join('\n').trim()
  if (tail) slides.push(tail)
  return slides.length ? slides : ['# Untitled']
}
