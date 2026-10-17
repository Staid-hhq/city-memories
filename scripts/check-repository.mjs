// Read-only repository navigation/import checks; never walk private data directories.
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const tracked = execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/').replace(/\/$/, '')}`,
  'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
function isFile(file) {
  try { return statSync(path.join(root, file)).isFile() } catch { return false }
}
const files = [...new Set(tracked.split('\0').filter(Boolean))].filter(isFile)
const known = new Set(files)
const failures = []
const covered = new Set()
let links = 0
let imports = 0

for (const file of files) {
  if (!/\.(md|[cm]?js|tsx?)$/.test(file)) continue
  const source = readFileSync(path.join(root, file), 'utf8')
  if (file.endsWith('.md')) {
    for (const match of source.matchAll(/\]\(([^\s)]+)\)/g)) {
      const target = match[1]
      if (/^(?:[a-z][a-z\d+.-]*:|#|\/)/i.test(target)) continue
      const pathname = decodeURIComponent(target.split(/[?#]/)[0])
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), pathname))
      links++
      if (!known.has(resolved)) failures.push(`${file}: link is not a repository file: ${target}`)
      if (file === 'docs/file-guide.md') covered.add(resolved)
    }
  } else {
    for (const match of source.matchAll(/(?:\bfrom\s+|\bimport\s*)(['"])(\.[^'"]+)\1/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[2]))
      if (target.split('/').includes('node_modules')) continue // Installed third-party dependency, not repository source.
      imports++
      if (![target, ...['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx'].map(ext => target + ext)].some(p => known.has(p))) {
        failures.push(`${file}: unresolved local import: ${match[2]}`)
      }
    }
  }
}
for (const file of files) {
  if (!covered.has(file)) failures.push(`Missing file-guide entry: ${file}`)
}
if (failures.length) {
  console.error(failures.join('\n'))
  process.exitCode = 1
} else {
  console.log(`OK: ${files.length} files documented; ${links} local document links and ${imports} local imports resolve.`)
  console.log('Checks file targets only, not Markdown anchors, external sites, private files or runtime behavior.')
}
