import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

function run(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 20_000, windowsHide: true })
}

const localSmoke = process.env.DSH_RUN_LOCAL_CLI_SMOKE === '1'

test('Codex 0.147.0 checked-in app-server schema fixture is present', () => {
  const root = new URL('../protocol/codex-0.147.0/', import.meta.url)
  const version = readFileSync(new URL('VERSION.txt', root), 'utf8')
  assert.match(version, /0\.147\.0/u)
  assert.equal(existsSync(new URL('json/ServerRequest.json', root)), true)
  assert.equal(existsSync(new URL('ts/v2/ThreadStartParams.ts', root)), true)
})

test('installed CLI parameter smoke uses current Codex/Grok/Claude help only', { skip: !localSmoke }, () => {
  const codex = run(process.env.CODEX_BIN ?? 'codex', ['exec', '--sandbox', 'read-only', '-c', 'approval_policy="on-request"', '--help'])
  assert.equal(codex.error, undefined, codex.error?.message)
  assert.equal(codex.status, 0, codex.stderr)
  const oldCodex = run(process.env.CODEX_BIN ?? 'codex', ['exec', '--sandbox', 'read-only', '--ask-for-approval', 'on-request', '--help'])
  assert.notEqual(oldCodex.status, 0)

  const grok = run(process.env.GROK_BIN ?? 'grok', ['--permission-mode', 'dontAsk', '--sandbox', 'read-only', '--tools', 'Read,Grep', '--disallowed-tools', 'Edit,Write,NotebookEdit,Bash,MCP,WebSearch,WebFetch', '--disable-web-search', '--help'])
  assert.equal(grok.error, undefined, grok.error?.message)
  assert.equal(grok.status, 0, grok.stderr)

  const claude = run(process.env.CLAUDE_BIN ?? 'claude', ['--permission-mode', 'plan', '--help'])
  assert.equal(claude.error, undefined, claude.error?.message)
  assert.equal(claude.status, 0, claude.stderr)
  const auth = run(process.env.CLAUDE_BIN ?? 'claude', ['auth', 'login', '--help'])
  assert.equal(auth.error, undefined, auth.error?.message)
  assert.equal(auth.status, 0, auth.stderr)
})
