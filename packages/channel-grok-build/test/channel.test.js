import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  cleanupPromptFile,
  createGrokBuildChannel,
  grokPrintArgv,
  grokPromptFileArgv,
  grokResumeArgv,
  grokResumePromptFileArgv,
  parseGrokSessions,
  parseGrokStreamLine,
  resolveGrok,
  writePromptFileIfNeeded,
} from '../lib/index.js'
import { unsupported } from '@dsh-subagent-code-agents/core'

const TMP_DIRS = []

test.after(() => {
  for (const d of TMP_DIRS) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

function makeEnv(overrides = {}) {
  return {
    subprocess: {
      async resolveExecutable(name) {
        return name === 'grok' ? 'C:/fake/grok.exe' : 'C:/fake/node.exe'
      },
      spawn() {
        throw new Error('spawn not stubbed')
      },
    },
    fs,
    path,
    logger: { info() {}, warn() {}, error() {} },
    cwd: 'C:/ws',
    ...overrides,
  }
}

test('grokPrintArgv is native argv (no shell), fixed permission exactly once', () => {
  const argv = grokPrintArgv({ grok: 'grok.exe', cwd: 'C:/ws', request: {}, prompt: 'hello' })
  assert.equal(argv[0], 'grok.exe')
  assert.ok(argv.includes('-p'))
  assert.ok(argv.includes('hello'), 'short prompt must ride as the -p value')
  assert.ok(argv.includes('--output-format'))
  assert.ok(argv.includes('streaming-json'))
  assert.ok(argv.includes('--no-auto-update'), 'update checks must be disabled')
  assert.equal(argv.filter((a) => a === '--permission-mode').length, 1)
  assert.equal(argv.filter((a) => a === 'bypassPermissions').length, 1)
  assert.ok(!argv.some((a) => a.includes(';') || a.includes('&&') || a.includes('|')))
})

test('grokPrintArgv supports model, effort and cwd', () => {
  const argv = grokPrintArgv({
    grok: 'grok.exe',
    cwd: 'C:/ws',
    request: { model: 'grok-3', reasoningEffort: 'high' },
    prompt: 'hi',
  })
  assert.ok(argv.includes('-m'))
  assert.ok(argv.includes('grok-3'))
  assert.ok(argv.includes('--reasoning-effort'))
  assert.ok(argv.includes('high'))
  assert.ok(argv.includes('--cwd'))
  assert.ok(argv.includes('C:/ws'))
})

test('grokPromptFileArgv uses --prompt-file for long prompts (no -p)', () => {
  const argv = grokPromptFileArgv({
    grok: 'grok.exe',
    cwd: 'C:/ws',
    request: { model: 'grok-3' },
    promptFile: 'C:/tmp/prompt.txt',
  })
  assert.ok(!argv.includes('-p'), 'long prompts must not use -p')
  assert.ok(argv.includes('--prompt-file'))
  assert.ok(argv.includes('C:/tmp/prompt.txt'))
  assert.ok(argv.includes('--no-auto-update'))
  assert.equal(argv.filter((a) => a === 'bypassPermissions').length, 1)
})

test('grokResumeArgv carries resume id, prompt, no-auto-update and fixed permission', () => {
  const argv = grokResumeArgv({ grok: 'grok.exe', sessionId: 'grok-sess-1', cwd: 'C:/ws', request: {}, prompt: 'continue' })
  assert.ok(argv.includes('--resume'))
  assert.ok(argv.includes('grok-sess-1'))
  assert.ok(argv.includes('continue'), 'resume must carry the prompt')
  assert.ok(argv.includes('--no-auto-update'))
  assert.equal(argv.filter((a) => a === 'bypassPermissions').length, 1)
  assert.throws(
    () => grokResumeArgv({ grok: 'grok.exe', sessionId: '', cwd: 'C:/ws', request: {}, prompt: 'hi' }),
    /non-empty session id/,
  )
})

test('grokResumePromptFileArgv combines resume + prompt-file', () => {
  const argv = grokResumePromptFileArgv({
    grok: 'grok.exe',
    sessionId: 's1',
    cwd: 'C:/ws',
    request: {},
    promptFile: 'C:/tmp/p.txt',
  })
  assert.ok(argv.includes('--resume'))
  assert.ok(argv.includes('--prompt-file'))
  assert.ok(argv.includes('C:/tmp/p.txt'))
})

test('parseGrokStreamLine extracts text/data and end sessionId/stopReason', () => {
  const text = parseGrokStreamLine(JSON.stringify({ type: 'text', data: 'hello' }))
  assert.equal(text.text, 'hello')
  assert.equal(text.type, 'text')
  const end = parseGrokStreamLine(JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId: 's-1' }))
  assert.equal(end.sessionId, 's-1')
  assert.equal(end.stopReason, 'end_turn')
  const err = parseGrokStreamLine(JSON.stringify({ type: 'error', message: 'boom' }))
  assert.equal(err.type, 'error')
  assert.equal(parseGrokStreamLine('junk'), undefined)
})

test('parseGrokSessions filters by cwd and is bounded', () => {
  const parsed = parseGrokSessions(
    JSON.stringify([
      { id: 'a', title: 'A'.repeat(500), cwd: 'C:/ws' },
      { id: 'b', cwd: 'D:/other' },
    ]),
    { cwd: 'C:/ws' },
  )
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].id, 'a')
  assert.ok(parsed[0].preview.length <= 200)
  assert.deepEqual(parseGrokSessions('garbage'), [])
})

test('grok channel capabilities: no sessions/steer, sandboxBypassGuaranteed FALSE', () => {
  const channel = createGrokBuildChannel()
  assert.equal(channel.id, 'grok-build')
  assert.equal(channel.capabilities.run, true)
  assert.equal(channel.capabilities.resume, true)
  assert.equal(channel.capabilities.listSessions, false)
  assert.equal(channel.capabilities.readSession, false)
  assert.equal(channel.capabilities.managedSession, false)
  assert.equal(channel.capabilities.steerActive, false)
  assert.equal(channel.capabilities.sandboxBypassGuaranteed, false)
})

test('unsupported capability produces explicit structured refusal (no fallback)', () => {
  const channel = createGrokBuildChannel()
  const result = unsupported(channel.id, 'steerActive', channel.capabilities)
  assert.equal(result.stopReason, 'unsupported')
  assert.match(result.output, /does not support steerActive/)
})

test('writePromptFileIfNeeded writes temp file only for long prompts, mode 0600, cleans up', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-prompt-test-'))
  TMP_DIRS.push(tmpRoot)
  const env = makeEnv({ cwd: tmpRoot, tmpdir: tmpRoot })
  const short = await writePromptFileIfNeeded({ env, prompt: 'short' })
  assert.equal(short, undefined)
  const long = 'x'.repeat(5000)
  const file = await writePromptFileIfNeeded({ env, prompt: long })
  assert.ok(file, 'long prompt must produce a temp file')
  assert.ok(file.startsWith(tmpRoot), 'temp file must live under env.tmpdir')
  assert.equal(fs.readFileSync(file, 'utf8'), long)
  // mode 0600 → owner rw only (POSIX; Windows masks this away).
  if (process.platform !== 'win32') {
    const stat = fs.statSync(file)
    assert.equal(stat.mode & 0o777, 0o600, 'prompt file must be 0600')
  }
  cleanupPromptFile({ fs, path, file })
  assert.ok(!fs.existsSync(file), 'temp prompt dir must be cleaned up')
})

test('writePromptFileIfNeeded cleans up the dir when the write fails', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-prompt-test-'))
  TMP_DIRS.push(tmpRoot)
  const env = makeEnv({ cwd: tmpRoot, tmpdir: tmpRoot })
  // A fs whose writeFileSync throws.
  const badFs = {
    ...fs,
    mkdtempSync: (p) => fs.mkdtempSync(p),
    writeFileSync() {
      throw new Error('disk full')
    },
    rmSync: (p, opts) => fs.rmSync(p, opts),
  }
  await assert.rejects(
    writePromptFileIfNeeded({ env: { ...env, fs: badFs }, prompt: 'x'.repeat(5000) }),
    /disk full/,
  )
  const leftovers = fs.readdirSync(tmpRoot).filter((n) => n.startsWith('grok-prompt-'))
  assert.deepEqual(leftovers, [], 'failed write must remove the created dir')
})

test('oversized prompt is rejected before spawn', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-prompt-test-'))
  TMP_DIRS.push(tmpRoot)
  const env = makeEnv({ cwd: tmpRoot, tmpdir: tmpRoot })
  await assert.rejects(
    writePromptFileIfNeeded({ env, prompt: 'x'.repeat(300 * 1024) }),
    /exceeds 262144 bytes/,
  )
})

test('resolveGrok rejects .cmd/.ps1 shims', async () => {
  const env = makeEnv({
    subprocess: {
      async resolveExecutable() {
        return 'C:/fake/grok.cmd'
      },
    },
  })
  await assert.rejects(resolveGrok(env, {}), /shim/)
  await assert.rejects(resolveGrok(env, { grokExecutable: 'C:/fake/grok.ps1' }), /shim/)
})

test('grokResumePromptFileArgv includes --no-auto-update', () => {
  const argv = grokResumePromptFileArgv({
    grok: 'grok.exe',
    sessionId: 's1',
    cwd: 'C:/ws',
    request: {},
    promptFile: 'C:/tmp/p.txt',
  })
  assert.ok(argv.includes('--no-auto-update'))
  assert.equal(argv.filter((a) => a === '--no-auto-update').length, 1)
  assert.equal(argv.filter((a) => a === 'bypassPermissions').length, 1)
})

function fakeHandle({ script, exitCode = 0, stderrText = '' }) {
  const state = { stdoutHandler: undefined, stdinData: undefined }
  const handle = {
    stdin: {
      write() { return true },
      end(data) { state.stdinData = data },
    },
    stdout: {
      on(event, fn) {
        if (event === 'data') state.stdoutHandler = fn
      },
    },
    stderr: { on() {} },
    collected: { stderr: { readFrom: () => ({ text: stderrText }) } },
    done: new Promise((resolve) => {
      setImmediate(() => {
        for (const line of script) {
          state.stdoutHandler?.(Buffer.from(line + '\n'))
        }
        resolve({ exitCode, signal: null })
      })
    }),
    terminate() {},
  }
  return handle
}

test('run parses streaming-json and returns sessionId + completed', async () => {
  const env = makeEnv()
  let spawned
  env.subprocess.spawn = (spec) => {
    spawned = spec
    return fakeHandle({
      script: [
        JSON.stringify({ type: 'text', data: 'hello ' }),
        JSON.stringify({ type: 'text', data: 'from ' }),
        JSON.stringify({ type: 'text', data: 'grok' }),
        JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId: 'grok-1' }),
      ],
    })
  }
  const channel = createGrokBuildChannel({ grokExecutable: 'C:/fake/grok.exe' })
  const result = await channel.run({ prompt: 'hello', cwd: 'C:/ws' }, env)
  assert.equal(result.stopReason, 'completed')
  assert.equal(result.output, 'hello from grok', 'text chunks must concatenate without artificial newlines')
  assert.equal(result.sessionId, 'grok-1')
  assert.equal(result.channel, 'grok-build')
  assert.ok(spawned.argv.includes('bypassPermissions'))
  assert.ok(spawned.argv.includes('--no-auto-update'))
  assert.ok(spawned.argv.includes('hello'), 'short prompt must be in argv')
  assert.ok(!spawned.argv.some((a) => a.includes('&&')))
})

test('run with resumeSessionId uses --resume argv and marks resume_unmanaged + concurrent', async () => {
  const env = makeEnv()
  let spawned
  env.subprocess.spawn = (spec) => {
    spawned = spec
    return fakeHandle({
      script: [
        JSON.stringify({ type: 'text', data: 'cont' }),
        JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId: 'grok-2' }),
      ],
    })
  }
  const channel = createGrokBuildChannel({ grokExecutable: 'C:/fake/grok.exe' })
  const result = await channel.run({ prompt: 'go', cwd: 'C:/ws', resumeSessionId: 'grok-2' }, env)
  assert.equal(result.stopReason, 'completed')
  assert.ok(spawned.argv.includes('--resume'))
  assert.ok(spawned.argv.includes('grok-2'))
  assert.ok(spawned.argv.includes('go'), 'resume must carry the prompt in argv')
  assert.equal(result.delivery, 'resume_unmanaged')
  assert.equal(result.mayBeConcurrent, true)
})

test('non-end_turn stop reason is surfaced as error', async () => {
  const env = makeEnv()
  env.subprocess.spawn = () =>
    fakeHandle({
      script: [
        JSON.stringify({ type: 'text', data: 'partial' }),
        JSON.stringify({ type: 'end', stopReason: 'refusal', sessionId: 'grok-r' }),
      ],
    })
  const channel = createGrokBuildChannel({ grokExecutable: 'C:/fake/grok.exe' })
  const result = await channel.run({ prompt: 'hi', cwd: 'C:/ws' }, env)
  assert.equal(result.stopReason, 'error')
  assert.match(result.output, /refusal/)
})

test('EndTurn (PascalCase) is accepted as a successful stop reason', async () => {
  const env = makeEnv()
  env.subprocess.spawn = () =>
    fakeHandle({
      script: [
        JSON.stringify({ type: 'text', data: 'ok text' }),
        JSON.stringify({ type: 'end', stopReason: 'EndTurn', sessionId: 'grok-e' }),
      ],
    })
  const channel = createGrokBuildChannel({ grokExecutable: 'C:/fake/grok.exe' })
  const result = await channel.run({ prompt: 'hi', cwd: 'C:/ws' }, env)
  assert.equal(result.stopReason, 'completed')
  assert.equal(result.output, 'ok text')
  assert.equal(result.sessionId, 'grok-e')
})

test('error event carries the message into the result', async () => {
  const env = makeEnv()
  env.subprocess.spawn = () =>
    fakeHandle({
      script: [JSON.stringify({ type: 'error', message: 'could not start session' })],
    })
  const channel = createGrokBuildChannel({ grokExecutable: 'C:/fake/grok.exe' })
  const result = await channel.run({ prompt: 'hi', cwd: 'C:/ws' }, env)
  assert.equal(result.stopReason, 'error')
  assert.match(result.output, /could not start session/)
})

test('long prompt run uses --prompt-file and cleans it up', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-run-test-'))
  TMP_DIRS.push(tmpRoot)
  const env = makeEnv({ cwd: tmpRoot })
  let spawned
  env.subprocess.spawn = (spec) => {
    spawned = spec
    return fakeHandle({
      script: [
        JSON.stringify({ type: 'text', data: 'long ok' }),
        JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId: 'grok-3' }),
      ],
    })
  }
  const channel = createGrokBuildChannel({ grokExecutable: 'C:/fake/grok.exe' })
  const result = await channel.run({ prompt: 'x'.repeat(5000), cwd: tmpRoot }, env)
  assert.equal(result.stopReason, 'completed')
  // Long prompt rides on --prompt-file, NOT -p; the temp file is cleaned up.
  assert.ok(!spawned.argv.includes('-p'), 'long prompts must not use -p')
  const promptFileArgIdx = spawned.argv.indexOf('--prompt-file')
  assert.ok(promptFileArgIdx >= 0, 'long prompt must use --prompt-file')
  const promptPath = spawned.argv[promptFileArgIdx + 1]
  assert.ok(!fs.existsSync(promptPath), 'temp prompt file must be cleaned up after run')
})

test('spawn failure cleans up the temp prompt file', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-spawn-test-'))
  TMP_DIRS.push(tmpRoot)
  const env = makeEnv({ cwd: tmpRoot })
  env.subprocess.spawn = () => {
    throw new Error('spawn failed')
  }
  const channel = createGrokBuildChannel({ grokExecutable: 'C:/fake/grok.exe' })
  await assert.rejects(channel.run({ prompt: 'x'.repeat(5000), cwd: tmpRoot }, env), /spawn failed/)
  // No leftover temp dirs under the OS temp dir with the run-prefix
  // (grok-prompt-, NOT grok-prompt-test- which is our own fixture).
  const leftovers = fs.readdirSync(os.tmpdir()).filter((n) => /^grok-prompt-[0-9a-zA-Z]+$/.test(n))
  assert.deepEqual(leftovers, [], 'temp prompt dir must be cleaned up when spawn fails')
})
