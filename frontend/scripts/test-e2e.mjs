import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Each default group starts its own temporary DB/server. The enlarged suite
// exceeds the real 60 logins/source window if all files share one server.
// Do not weaken production limits or clear limit records through a test API.
const cli = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url))
const tests = readdirSync(new URL('../tests/e2e/', import.meta.url)).filter(name => name.endsWith('.spec.ts')).sort()
const args = process.argv.slice(2)
const groups = args.length ? [args] : [
  tests.filter(name => !name.startsWith('map') && !name.startsWith('journey') && !name.startsWith('library') && !name.startsWith('home-sidebar')).map(name => `tests/e2e/${name}`),
  tests.filter(name => name.startsWith('map')).map(name => `tests/e2e/${name}`),
  tests.filter(name => name.startsWith('journey')).map(name => `tests/e2e/${name}`),
  tests.filter(name => name.startsWith('library') || name.startsWith('home-sidebar')).map(name => `tests/e2e/${name}`),
]
for (const group of groups) {
  if (!group.length) continue
  // Keep screenshots from earlier groups instead of erasing them on each run.
  const output = args.length ? [] : [`--output=test-results/group-${groups.indexOf(group) + 1}`]
  const result = spawnSync(process.execPath, [cli, 'test', ...group, ...output], { stdio: 'inherit' })
  if (result.error) { console.error(result.error.message); process.exit(1) }
  if (result.status !== 0) process.exit(result.status ?? 1)
}
