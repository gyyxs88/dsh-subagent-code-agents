/**
 * pack-check.js — reproducible packaging verification.
 *
 * 1. Runs a REAL `npm pack` of each workspace package into the
 *    temp dir and asserts the tgz contains the key files (tar -tzf listing
 *    read from disk, no child-pipe capture).
 * 2. Runs a REAL `npm pack` of the ROOT package into the temp dir, creates a
 *    throwaway consumer, `npm install`s the root tgz
 *    (--ignore-scripts --legacy-peer-deps), and verifies that
 *    `dsh-subagent-code-agents` and `dsh-subagent-code-agents/tool` can be
 *    imported and that the bundled internal deps physically exist under the
 *    consumer's node_modules.
 * 3. Always cleans up the temp dir and the tgz.
 *
 * The bundled internal packages mean a root tarball install does NOT require
 * the scoped packages to be published first.
 *
 * NOTE: all child processes run with INHERITED stdio (no pipe capture), which
 * is the only mode that works under sandboxes that block child stdout piping.
 * File listings are read from disk instead of parsing child stdout.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const isWin = process.platform === 'win32'
const npm = isWin ? 'npm.cmd' : 'npm'

/**
 * Resolve the npm CLI as `node <npm-cli.js>` — spawning npm.cmd directly fails
 * under sandboxes (status null). Derives the cli.js from the npm.cmd location.
 */
function npmCli() {
  const probe = spawnSync(isWin ? 'npm.cmd' : 'npm', ['config', 'get', 'prefix'], { encoding: 'utf8' })
  let prefix
  if (probe.status === 0 && probe.stdout) {
    prefix = probe.stdout.trim()
  } else {
    // Fall back to the runtime node dir (DSH layout).
    prefix = path.dirname(process.execPath)
  }
  const candidates = [
    path.join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(prefix, 'node_modules', 'npm', 'cli.js'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return [process.execPath, c]
  }
  throw new Error('cannot locate npm-cli.js')
}

/** Run npm via `node npm-cli.js` with inherited stdio (sandbox-safe). */
function runNpm(args, { cwd } = {}) {
  const cli = npmCli()
  // Always use a fresh per-run cache under the OS temp dir: the global npm
  // cache may be blocked by the sandbox, and we clean up afterwards anyway.
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-check-cache-'))
  try {
    const full = ['--cache', cacheDir, ...args]
    const r = spawnSync(cli[0], [...cli.slice(1), ...full], { cwd, stdio: 'inherit' })
    return r.status
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true })
  }
}

const WORKSPACE_EXPECT = {
  'packages/core': ['lib/index.js', 'lib/index.d.ts', 'LICENSE'],
  'packages/channel-codex': ['lib/index.js', 'lib/index.d.ts', 'lib/app-server-channel.js', 'lib/app-server-channel.d.ts', 'LICENSE'],
  'packages/channel-claude-code': ['lib/index.js', 'lib/index.d.ts', 'LICENSE'],
  'packages/channel-grok-build': ['lib/index.js', 'lib/index.d.ts', 'LICENSE'],
  'packages/channel-acp': ['lib/index.js', 'lib/index.d.ts', 'LICENSE'],
  'packages/plugin': [
    'lib/index.js',
    'lib/index.d.ts',
    'lib/tool.js',
    'lib/tool.d.ts',
    'lib/auto-tool.js',
    'lib/auto-tool.d.ts',
    'lib/roles.js',
    'lib/roles.d.ts',
    'lib/owned-runs.js',
    'lib/owned-runs.d.ts',
    'cordis.patch.yml',
    'README.md',
    'LICENSE',
  ],
}

const ROOT_EXPECT = [
  'package/package.json',
  'package/packages/plugin/lib/index.js',
  'package/packages/plugin/lib/index.d.ts',
  'package/packages/plugin/lib/tool.js',
  'package/packages/plugin/lib/tool.d.ts',
  'package/packages/plugin/lib/auto-tool.js',
  'package/packages/plugin/lib/auto-tool.d.ts',
  'package/packages/plugin/lib/roles.js',
  'package/packages/plugin/lib/owned-runs.js',
  'package/packages/plugin/cordis.patch.yml',
  'package/README.md',
  'package/LICENSE',
]

let failed = 0

/** Run a command with inherited stdio; capture is NOT used (sandbox-safe). */
function runInherit(cmdAndArgs, { cwd } = {}) {
  const r = spawnSync(cmdAndArgs[0], cmdAndArgs.slice(1), { cwd, stdio: 'inherit' })
  return r.status
}

/** List the entries of a tgz by extracting to a dir and reading the tree. */
function extractTgz(tgz, dest) {
  fs.mkdirSync(dest, { recursive: true })
  const status = runInherit(['tar', '-xzf', tgz, '-C', dest])
  if (status !== 0) return undefined
  const names = []
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel)
      else names.push(rel)
    }
  }
  walk(dest, '')
  return names
}

function checkWorkspacePacks() {
  console.log('--- workspace packs (real tgz, entries verified from disk) ---')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-check-ws-'))
  try {
    for (const [pkg, expect] of Object.entries(WORKSPACE_EXPECT)) {
      const dest = path.join(tmp, pkg.replace('/', '-'))
      fs.mkdirSync(dest, { recursive: true })
      const status = runNpm(['pack', '--ignore-scripts', '--pack-destination', dest, '--workspace', pkg], { cwd: root })
      if (status !== 0) {
        failed++
        console.error(`✖ ${pkg} npm pack failed (status ${status})`)
        continue
      }
      const tgz = fs.readdirSync(dest).find((f) => f.endsWith('.tgz'))
      if (!tgz) {
        failed++
        console.error(`✖ ${pkg} no tgz produced`)
        continue
      }
      const extractDir = path.join(dest, 'x')
      const names = extractTgz(path.join(dest, tgz), extractDir)
      if (!names) {
        failed++
        console.error(`✖ ${pkg} tar extraction failed`)
        continue
      }
      const missing = expect.filter((f) => !names.some((n) => n.endsWith(f)))
      if (missing.length === 0) {
        console.log(`✔ ${pkg} (${names.length} entries)`)
      } else {
        failed++
        console.error(`✖ ${pkg} missing: ${missing.join(', ')} (entries: ${names.join(', ')})`)
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function checkRootTarball() {
  console.log('--- root tarball install smoke ---')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-check-root-'))
  try {
    const dest = path.join(tmp, 'pkg')
    fs.mkdirSync(dest, { recursive: true })
    const pack = runNpm(['pack', '--ignore-scripts', '--pack-destination', dest], { cwd: root })
    if (pack !== 0) {
      failed++
      console.error(`✖ root npm pack failed (status ${pack})`)
      return
    }
    const tgz = fs.readdirSync(dest).find((f) => f.endsWith('.tgz'))
    if (!tgz) {
      failed++
      console.error('✖ root no tgz produced')
      return
    }
    const tgzPath = path.join(dest, tgz)

    // Verify the tarball physically contains the key entries.
    const names = extractTgz(tgzPath, path.join(dest, 'x'))
    if (!names) {
      failed++
      console.error('✖ root tgz extraction failed')
      return
    }
    const missing = ROOT_EXPECT.filter((f) => !names.includes(f))
    if (missing.length > 0) {
      failed++
      console.error(`✖ root tgz missing entries: ${missing.join(', ')}`)
      return
    }
    console.log(`✔ root tgz contains all key entries (${names.length} files)`)

    // Throwaway consumer: install the tgz. The root's peerDependencies are
    // DSH/Cordis host packages — a plain Node consumer does not have them, so
    // we install them as explicit deps from the workspace's own node_modules
    // (mirroring a real DSH host that provides them). `--legacy-peer-deps`
    // prevents npm from auto-resolving peers, so explicit deps are required.
    const consumer = path.join(tmp, 'consumer')
    fs.mkdirSync(consumer)
    const peerPaths = {
      '@deepseek-ai/dsh-tools': path.join(root, 'node_modules', '@deepseek-ai', 'dsh-tools'),
      '@deepseek-ai/dsh-subagent': path.join(root, 'node_modules', '@deepseek-ai', 'dsh-subagent'),
      '@deepseek-ai/cordis': path.join(root, 'node_modules', '@deepseek-ai', 'cordis'),
      '@deepseek-ai/schemastery': path.join(root, 'node_modules', '@deepseek-ai', 'schemastery'),
    }
    const consumerPkg = {
      name: 'consumer',
      version: '1.0.0',
      private: true,
      type: 'module',
      dependencies: Object.fromEntries(
        Object.entries(peerPaths).map(([name, p]) => [name, `file:${p.replace(/\\/g, '/')}`]),
      ),
    }
    fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify(consumerPkg, null, 2))
    const install = runNpm(
      ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--legacy-peer-deps', tgzPath],
      { cwd: consumer },
    )
    if (install !== 0) {
      failed++
      console.error(`✖ consumer npm install failed (status ${install})`)
      return
    }

    // Verify imports resolve (node -e writing results to a file, no piping).
    const verifyFile = path.join(consumer, 'verify.mjs')
    fs.writeFileSync(
      verifyFile,
      `
        const a = await import('dsh-subagent-code-agents');
        const b = await import('dsh-subagent-code-agents/tool');
        const c = await import('dsh-subagent-code-agents/auto-tool');
        console.log('root export apply:', typeof a.apply);
        console.log('tool export apply:', typeof b.apply);
        console.log('auto-tool export apply:', typeof c.apply);
      `,
    )
    const verify = runInherit([process.execPath, verifyFile], { cwd: consumer })
    if (verify !== 0) {
      failed++
      console.error('✖ consumer import failed')
      return
    }
    console.log('✔ consumer imports dsh-subagent-code-agents, /tool and /auto-tool OK')

    // Verify the bundled internal deps physically exist. bundleDependencies
    // are placed under the root package's own node_modules (nested), so check
    // both the top-level and the nested location.
    const bundled = [
      '@dsh-subagent-code-agents/core',
      '@dsh-subagent-code-agents/channel-codex',
      '@dsh-subagent-code-agents/channel-claude-code',
      '@dsh-subagent-code-agents/channel-grok-build',
      '@dsh-subagent-code-agents/channel-acp',
      '@dsh-subagent-code-agents/plugin',
    ]
    const nmRoot = path.join(consumer, 'node_modules')
    const nestedRoot = path.join(nmRoot, 'dsh-subagent-code-agents', 'node_modules')
    const missingBundled = bundled.filter((name) => {
      const rel = name.split('/')
      const top = path.join(nmRoot, ...rel, 'package.json')
      const nested = path.join(nestedRoot, ...rel, 'package.json')
      return !fs.existsSync(top) && !fs.existsSync(nested)
    })
    if (missingBundled.length > 0) {
      failed++
      console.error(`✖ bundled internal deps missing in consumer: ${missingBundled.join(', ')}`)
      return
    }
    console.log(`✔ all ${bundled.length} bundled internal deps present in consumer (top-level or nested)`)
    // Also assert the BUNDLED flag was honored: the tgz must have bundled them
    // (the root package.json in the consumer copy lists bundleDependencies).
    const installedRootPkg = JSON.parse(
      fs.readFileSync(path.join(nmRoot, 'dsh-subagent-code-agents', 'package.json'), 'utf8'),
    )
    if (!Array.isArray(installedRootPkg.bundleDependencies) || installedRootPkg.bundleDependencies.length === 0) {
      failed++
      console.error('✖ installed root package.json missing bundleDependencies')
      return
    }
    console.log(`✔ root bundleDependencies honored (${installedRootPkg.bundleDependencies.length} bundled)`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

checkWorkspacePacks()
checkRootTarball()

if (failed > 0) {
  console.error(`pack-check: ${failed} failure(s)`)
  process.exit(1)
}
console.log('pack-check: all checks passed')
