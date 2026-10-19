import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const changes = []
const updates = []
for (const file of ['cz.data', 'gz.data']) {
  let count = 0
  const text = readFileSync(new URL(file, root), 'utf8')
  const output = text.split(/(?<=\n)/).map(line => {
    if (!line.trim()) return line
    const entry = JSON.parse(line)
    let changed = false
    for (const translation of entry.content.word.content.trans || []) {
      const before = translation.tranCn
      if (typeof before !== 'string') continue
      const after = before
        // Lower-case English form lists only: retain [C], [U], [H-], etc.
        .replace(/\[\s*[a-z]+(?:[\s,;\/-]+[a-z]+)*\s*\]/g, '')
        .replace(/[〔（(][^〕）()]*?(?:过去式|过去分词)[^〕）()]*[〕）)]/g, '')
      if (after === before) continue
      if (!after.trim()) throw new Error(`${file}: ${entry.headWord} 清理后释义为空`)
      translation.tranCn = after.trim()
      changes.push({ file, word: entry.headWord, before, after: translation.tranCn })
      changed = true
    }
    if (!changed) return line
    count++
    return JSON.stringify(entry) + (line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '')
  }).join('')
  updates.push({ file, output })
  console.log(`${file}：修改 ${count} 个词条，未删除词条`)
}
if (process.argv.includes('--apply') && changes.length) {
  const archive = new URL('docs/dictionary-cleanup/school-inflections-2026-10-19.json', root)
  if (existsSync(archive)) throw new Error('清理记录已存在，拒绝覆盖')
  mkdirSync(new URL('docs/dictionary-cleanup/', root), { recursive: true })
  writeFileSync(archive, JSON.stringify(changes, null, 2) + '\n')
  for (const { file, output } of updates) writeFileSync(new URL(file, root), output)
} else {
  console.log(JSON.stringify(changes, null, 2))
}
