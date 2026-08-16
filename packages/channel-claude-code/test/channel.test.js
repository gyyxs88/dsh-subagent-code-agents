import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  claudePrintArgv,
  claudeResumeArgv,
  createClaudeCodeChannel,
  parseClaudeSessionsJson,
  parseClaudeStreamLine,
  resolveClaudeEntry,
} from '../lib/index.js'
import { unsupported } from '@dsh-subagent-code-agents/core'

function makeEnv(overrides = {}) {
  return {
    subprocess: {
      async resolveExecutable(name) {
        if (name === 'claude') return 'C:/fake/bin/claude.cmd'
        return 'C:/fake/node.exe'
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

test('claudePrintArgv is safe argv (no shell), fixed permission exactly once', () => {
  const argv = claudePrintArgv({ argvPrefix: ['claude.exe'], request: {} })
  assert.equal(argv[0], 'claude.exe')
  assert.ok(argv.includes('-p'))
  assert.ok(argv.includes('--output-format'))
  assert.ok(argv.includes('stream-json'))
  assert.equal(argv.filter((a) => a === '--permission-mode').length, 1)
  assert.equal(argv.filter((a) => a === 'bypassPermissions').length, 1)
  assert.ok(!argv.some((a) => a.includes(';') || a.includes('&&') || a.includes('|')))
  assert.ok(!argv.includes('--cwd'), 'working dir comes from spawn cwd, not a --cwd flag')
})

test('claudePrintArgv supports per-call model and effort', () => {
  const argv = claudePrintArgv({
    argvPrefix: ['node', 'cli.js'],
    request: { model: 'claude-opus-4', reasoningEffort: 'high' },
  })
  assert.deepEqual(argv.slice(0, 2), ['node', 'cli.js'])
  assert.ok(argv.includes('--model'))
  assert.ok(argv.includes('claude-opus-4'))
  assert.ok(argv.includes('--effort'))
  assert.ok(argv.includes('high'))
})

test('claudeResumeArgv carries resume id and fixed permission', () => {
  const argv = claudeResumeArgv({ argvPrefix: ['claude.exe'], sessionId: 'abc-123', request: {} })
  assert.ok(argv.includes('--resume'))
  assert.ok(argv.includes('abc-123'))
  assert.equal(argv.filter((a) => a === 'bypassPermissions').length, 1)
  assert.throws(
    () => claudeResumeArgv({ argvPrefix: ['claude.exe'], sessionId: '', request: {} }),
    /non-empty session id/,
  )
})

test('parseClaudeStreamLine extracts session id, assistant blocks and result text', () => {
  const init = parseClaudeStreamLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-9', model: 'x' }))
  assert.equal(init.sessionId, 'sess-9')
  const msg = parseClaudeStreamLine(JSON.stringify({ type: 'assistant', message: { content: 'hello world' } }))
  assert.equal(msg.text, 'hello world')
  // content may be an array of text blocks (standard Messages shape).
  const blocks = parseClaudeStreamLine(
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'block one' }, { type: 'text', text: 'block two' }] } }),
  )
  assert.equal(blocks.text, 'block one\nblock two')
  // ResultMessage carries the final result + session_id.
  const result = parseClaudeStreamLine(
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'final answer', session_id: 'sess-r' }),
  )
  assert.equal(result.text, 'final answer')
  assert.equal(result.sessionId, 'sess-r')
  assert.equal(parseClaudeStreamLine('not json'), undefined)
  assert.equal(parseClaudeStreamLine(''), undefined)
})

test('resolveClaudeEntry prefers native bin/claude.exe next to a .cmd shim', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-native-test-'))
  try {
    const bin = path.join(tmp, 'bin')
    const pkg = path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code', 'bin')
    fs.mkdirSync(pkg, { recursive: true })
    fs.writeFileSync(path.join(pkg, 'claude.exe'), 'native')
    fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo off')
    const env = makeEnv({
      subprocess: {
        async resolveExecutable(name) {
          if (name === 'node') return 'C:/fake/node.exe'
          return path.join(bin, 'claude.cmd')
        },
      },
    })
    const spec = await resolveClaudeEntry(env, {})
    assert.deepEqual(spec.argvPrefix, [path.join(pkg, 'claude.exe')])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('resolveClaudeEntry uses node+cli.js for legacy JS layouts', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-js-test-'))
  try {
    const bin = path.join(tmp, 'bin')
    const pkg = path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code')
    fs.mkdirSync(pkg, { recursive: true })
    fs.writeFileSync(path.join(pkg, 'cli.js'), 'legacy')
    fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo off')
    const env = makeEnv({
      subprocess: {
        async resolveExecutable(name) {
          if (name === 'node') return 'C:/fake/node.exe'
          return path.join(bin, 'claude.cmd')
        },
      },
    })
    const spec = await resolveClaudeEntry(env, {})
    assert.deepEqual(spec.argvPrefix, ['C:/fake/node.exe', path.join(pkg, 'cli.js')])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('resolveClaudeEntry refuses a bare .cmd shim with no adjacent binary', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-shim-test-'))
  try {
    fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'bin', 'claude.cmd'), '@echo off')
    const env = makeEnv({
      subprocess: {
        async resolveExecutable(name) {
          return name === 'node' ? 'C:/fake/node.exe' : path.join(tmp, 'bin', 'claude.cmd')
        },
      },
    })
    await assert.rejects(resolveClaudeEntry(env, {}), /shim.*claudeExecutable/)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('resolveClaudeEntry honors an explicit claudeExecutable', async () => {
  const env = makeEnv()
  const spec = await resolveClaudeEntry(env, { claudeExecutable: 'D:/tools/claude.exe' })
  assert.deepEqual(spec.argvPrefix, ['D:/tools/claude.exe'])
})

test('parseClaudeSessionsJson is bounded and cwd-aware', () => {
  const parsed = parseClaudeSessionsJson(
    JSON.stringify([
      { session_id: 'a', summary: 'A'.repeat(500), cwd: 'C:/ws' },
      { id: 'b', cwd: 'D:/other' },
    ]),
  )
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].id, 'a')
  assert.ok(parsed[0].preview.length <= 200)
  assert.equal(parsed[1].id, 'b')
  assert.deepEqual(parseClaudeSessionsJson('garbage'), [])
})

test('claude channel capabilities: no sessions/steer, no sandbox guarantee', () => {
  const channel = createClaudeCodeChannel()
  assert.equal(channel.id, 'claude-code')
  assert.equal(channel.capabilities.run, true)
  assert.equal(channel.capabilities.resume, true)
  assert.equal(channel.capabilities.listSessions, false)
  assert.equal(channel.capabilities.readSession, false)
  assert.equal(channel.capabilities.managedSession, false)
  assert.equal(channel.capabilities.steerActive, false)
  assert.equal(channel.capabilities.sandboxBypassGuaranteed, false)
})

test('unsupported capability produces explicit structured refusal (no fallback)', () => {
  const channel = createClaudeCodeChannel()
  const result = unsupported(channel.id, 'steerActive', channel.capabilities)
  assert.equal(result.stopReason, 'unsupported')
  assert.match(result.output, /does not support steerActive/)
  assert.equal(result.delivery, 'refused')
})

function fakeHandle({ script, exitCode = 0, stderrText = '' }) {
  const state = { stdoutHandler: undefined }
  const handle = {
    stdin: { write() { return true }, end() {} },
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

test('run parses stream-json and returns sessionId + completed', async () => {
  const env = makeEnv()
  let spawned
  env.subprocess.spawn = (spec) => {
    spawned = spec
    return fakeHandle({
      script: [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
        JSON.stringify({ type: 'assistant', message: { content: 'hi there' } }),
        // ResultMessage carries the final result text (may duplicate assistant
        // output in real streams — we concatenate both).
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'hi there', session_id: 'sess-1' }),
      ],
    })
  }
  const channel = createClaudeCodeChannel({ claudeExecutable: 'C:/fake/bin/claude.exe' })
  const result = await channel.run({ prompt: 'hello', cwd: 'C:/ws' }, env)
  assert.equal(result.stopReason, 'completed')
  // The final `result` line is authoritative; the assistant block is NOT
  // duplicated into the output.
  assert.equal(result.output, 'hi there')
  assert.equal(result.sessionId, 'sess-1')
  assert.equal(result.channel, 'claude-code')
  assert.ok(spawned.argv.includes('bypassPermissions'))
  assert.equal(spawned.argv[0], 'C:/fake/bin/claude.exe')
})

test('run treats a result line with is_error=true as an error', async () => {
  const env = makeEnv()
  env.subprocess.spawn = () =>
    fakeHandle({
      script: [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-e' }),
        JSON.stringify({ type: 'assistant', message: { content: 'partial' } }),
        JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'failed to run', session_id: 'sess-e' }),
      ],
      exitCode: 0,
    })
  const channel = createClaudeCodeChannel({ claudeExecutable: 'C:/fake/bin/claude.exe' })
  const result = await channel.run({ prompt: 'hi', cwd: 'C:/ws' }, env)
  assert.equal(result.stopReason, 'error')
  assert.match(result.output, /failed to run/)
})

test('run with resumeSessionId uses --resume argv and marks resume_unmanaged + concurrent', async () => {
  const env = makeEnv()
  let spawned
  env.subprocess.spawn = (spec) => {
    spawned = spec
    return fakeHandle({
      script: [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-2' }),
        JSON.stringify({ type: 'assistant', message: { content: 'cont' } }),
      ],
    })
  }
  const channel = createClaudeCodeChannel({ claudeExecutable: 'C:/fake/bin/claude.exe' })
  const result = await channel.run({ prompt: 'go', cwd: 'C:/ws', resumeSessionId: 'sess-2' }, env)
  assert.equal(result.stopReason, 'completed')
  assert.ok(spawned.argv.includes('--resume'))
  assert.ok(spawned.argv.includes('sess-2'))
  assert.equal(result.delivery, 'resume_unmanaged')
  assert.equal(result.mayBeConcurrent, true)
})

test('run with nonzero exit and no text returns error with stderr', async () => {
  const env = makeEnv()
  env.subprocess.spawn = () =>
    fakeHandle({ script: [], exitCode: 1, stderrText: 'boom happened' })
  const channel = createClaudeCodeChannel({ claudeExecutable: 'C:/fake/bin/claude.exe' })
  const result = await channel.run({ prompt: 'hi', cwd: 'C:/ws' }, env)
  assert.equal(result.stopReason, 'error')
  assert.match(result.output, /boom happened/)
})
