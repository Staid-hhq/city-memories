import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const cli = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url))
const python = fileURLToPath(new URL('../../backend/.venv/Scripts/python.exe', import.meta.url))
const harness = fileURLToPath(new URL('../../validation/scale/harness.py', import.meta.url))
const frontend = fileURLToPath(new URL('../', import.meta.url))

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true })
  if (result.error) { console.error(result.error.message); process.exit(1) }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(process.execPath, [cli, 'test', '--config=playwright.scale.config.ts'], frontend)
// The server has stopped. The production OS lock still refuses a live writer.
run(python, [harness, 'maintenance'], root)
run(python, [harness, 'audit'], root)
