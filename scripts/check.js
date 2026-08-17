/**
 * Syntax-check every JS file in the workspace (Windows-safe glob expansion).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const dirs = [
  'packages/core/lib',
  'packages/channel-codex/lib',
  'packages/channel-claude-code/lib',
  'packages/channel-grok-build/lib',
  'packages/channel-acp/lib',
  'packages/plugin/lib',
  'packages/core/test',
  'packages/channel-codex/test',
  'packages/channel-claude-code/test',
  'packages/channel-grok-build/test',
  'packages/channel-acp/test',
  'packages/plugin/test',
]

let failed = 0
for (const dir of dirs) {
  const full = path.join(root, dir)
  if (!fs.existsSync(full)) continue
  for (const file of fs.readdirSync(full).filter((f) => f.endsWith('.js'))) {
    const abs = path.join(full, file)
    // stdio: 'inherit' — the sandbox blocks capturing child stdout via pipes.
    const r = spawnSync(process.execPath, ['--check', abs], { stdio: 'inherit' })
    if (r.status !== 0) {
      failed++
      console.error(`✖ ${path.relative(root, abs)} (status ${r.status})`)
    } else {
      console.log(`✔ ${path.relative(root, abs)}`)
    }
  }
}
if (failed > 0) {
  console.error(`${failed} file(s) failed syntax check`)
  process.exit(1)
}
console.log('All files passed syntax check')
