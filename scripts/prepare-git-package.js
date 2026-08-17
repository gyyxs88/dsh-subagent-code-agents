/**
 * Materialize bundled workspace packages for Git-hosted installs.
 *
 * npm pack already honors bundleDependencies. pnpm installs a Git source tree
 * differently: it expects bundled dependencies to exist before its pack step,
 * but workspace links are not created for a package consumed as a Git
 * dependency. This prepare hook copies only missing internal packages. In a
 * normal workspace install the destinations are symlinks and remain untouched.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const INTERNAL_PACKAGES = Object.freeze([
  ['core', 'core'],
  ['channel-codex', 'channel-codex'],
  ['channel-claude-code', 'channel-claude-code'],
  ['channel-grok-build', 'channel-grok-build'],
  ['channel-acp', 'channel-acp'],
  ['plugin', 'plugin'],
])

export function materializeInternalPackages(root) {
  const scope = path.join(root, 'node_modules', '@dsh-subagent-code-agents')
  fs.mkdirSync(scope, { recursive: true })
  const copied = []
  for (const [sourceName, packageName] of INTERNAL_PACKAGES) {
    const source = path.join(root, 'packages', sourceName)
    const destination = path.join(scope, packageName)
    if (fs.existsSync(destination)) continue
    if (!fs.existsSync(path.join(source, 'package.json')) || !fs.existsSync(path.join(source, 'lib'))) {
      throw new Error(`prepare-git-package: missing workspace source packages/${sourceName}`)
    }
    fs.mkdirSync(destination, { recursive: true })
    fs.cpSync(path.join(source, 'lib'), path.join(destination, 'lib'), { recursive: true })
    for (const file of ['package.json', 'LICENSE']) {
      const from = path.join(source, file)
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(destination, file))
    }
    copied.push(packageName)
  }
  if (copied.length > 0) {
    process.stdout.write(`prepared bundled workspaces: ${copied.join(', ')}\n`)
  }
  return copied
}

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  materializeInternalPackages(root)
}
