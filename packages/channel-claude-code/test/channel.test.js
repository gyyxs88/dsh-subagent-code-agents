import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  claudePrintArgv,
  claudeExecutionPolicyArgv,
  claudeResumeArgv,
  createClaudeCodeChannel,
  normalizeEffort,
  parseClaudeSessionsJson,
  parseClaudeStreamLine,
  resolveClaudeEntry,
} from '../lib/index.js'
import { unsupported } from '@dsh-subagent-code-agents/core'

const FULL_ACCESS_POLICY = Object.freeze({
  permission: 'danger-full-access',
  approvalOwner: 'full-access-controller',
  approvalMode: 'controller-fingerprint',
  workspaceRoot: 'C:/ws',
})

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
    executionPolicy: FULL_ACCESS_POLICY,
    ...overrides,
  }
}

test('claudePrintArgv is safe argv (no shell), fixed permission exactly once', () => {
  const argv = claudePrintArgv({ argvPrefix: ['claude.exe'], request: {}, executionPolicy: FULL_ACCESS_POLICY })
  assert.equal(argv[0], 'claude.exe')
  assert.ok(argv.includes('-p'))
  assert.ok(argv.includes('--output-format'))
  assert.ok(argv.includes('stream-json'))
  assert.equal(argv.filter((a) => a === '--permission-mode').length, 1)
  assert.equal(argv.filter((a) => a === 'bypassPermissions').length, 1)
  assert.ok(!argv.some((a) => a.includes(';') || a.includes('&&') || a.includes('|')))
  assert.ok(!argv.includes('--cwd'), 'working dir comes from spawn cwd, not a --cwd flag')
})

test('Claude restricted policies map to official modes instead of bypass', () => {
  assert.deepEqual(claudeExecutionPolicyArgv({ permission: 'read-only' }), ['--permission-mode', 'plan'])
  assert.deepEqual(claudeExecutionPolicyArgv({ permission: 'workspace-write' }), ['--permission-mode', 'default'])
})

test('claudePrintArgv supports per-call model and effort', () => {
  const argv = claudePrintArgv({
    argvPrefix: ['node', 'cli.js'],
    request: { model: 'claude-opus-4', reasoningEffort: 'high' }, executionPolicy: FULL_ACCESS_POLICY,
  })
  assert.deepEqual(argv.slice(0, 2), ['node', 'cli.js'])
  assert.ok(argv.includes('--model'))
  assert.ok(argv.includes('claude-opus-4'))
  assert.ok(argv.includes('--effort'))
  assert.ok(argv.includes('high'))
})

test('claudeResumeArgv carries resume id and fixed permission', () => {
  const argv = claudeResumeArgv({ argvPrefix: ['claude.exe'], sessionId: 'abc-123', request: {}, executionPolicy: FULL_ACCESS_POLICY })
  assert.ok(argv.includes('--resume'))
  assert.ok(argv.includes('abc-123'))
  assert.equal(argv.filter((a) => a === 'bypassPermissions').length, 1)
  assert.throws(
    () => claudeResumeArgv({ argvPrefix: ['claude.exe'], sessionId: '', request: {}, executionPolicy: FULL_ACCESS_POLICY }),
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

test('resolveClaudeEntry uses the injected absolute Runtime Manager executable', async () => {
  const env = makeEnv({ runtimeManager: { async resolveExecutable() { return { executable: '/opt/claude/bin/claude', state: 'installed-auth-unverified' } } } })
  const spec = await resolveClaudeEntry(env, { runtimeRequirement: { id: 'claude-code', version: '1.0.0' } })
  assert.deepEqual(spec.argvPrefix, ['/opt/claude/bin/claude'])
})

test('resolveClaudeEntry refuses PATH and shell-shim discovery without Runtime Manager', async () => {
  const env = makeEnv({ subprocess: { async resolveExecutable() { return 'C:/fake/bin/claude.cmd' } } })
  await assert.rejects(resolveClaudeEntry(env, {}), /Runtime Manager.*PATH resolution is disabled/)
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
    await assert.rejects(resolveClaudeEntry(env, {}), /Runtime Manager.*PATH resolution is disabled/)
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

test('claude channel capabilities: SDK sessions + managed/cancel + sandbox off, no true steer', () => {
  const channel = createClaudeCodeChannel()
  assert.equal(channel.id, 'claude-code')
  assert.equal(channel.capabilities.run, true)
  assert.equal(channel.capabilities.resume, true)
  assert.equal(channel.capabilities.listSessions, true)
  assert.equal(channel.capabilities.readSession, true)
  assert.equal(channel.capabilities.managedSession, true)
  assert.equal(channel.capabilities.steerActive, false)
  assert.equal(channel.capabilities.cancel, true)
  assert.equal(channel.capabilities.sandboxBypassGuaranteed, true)
})

test('Claude effort is restricted to SDK-supported values', () => {
  assert.equal(normalizeEffort(' XHIGH '), 'xhigh')
  assert.throws(() => normalizeEffort('extreme'), /low, medium, high, xhigh, max/)
})

test('unsupported capability produces explicit structured refusal (no fallback)', () => {
  const channel = createClaudeCodeChannel()
  const result = unsupported(channel.id, 'steerActive', channel.capabilities)
  assert.equal(result.stopReason, 'unsupported')
  assert.match(result.output, /does not support steerActive/)
  assert.equal(result.delivery, 'refused')
})

function staticSdk(messages, capture = {}) {
  return {
    query(params) {
      capture.query = params
      return {
        async *[Symbol.asyncIterator]() {
          for (const message of messages) yield message
        },
        close() { capture.closed = true },
      }
    },
    async listSessions(opts) {
      capture.listOptions = opts
      return capture.sessions ?? []
    },
    async getSessionMessages(sessionId, opts) {
      capture.read = { sessionId, opts }
      return capture.messages ?? []
    },
  }
}

test('SDK run fixes approval/sandbox policy and returns authoritative result', async () => {
  const env = makeEnv()
  const updates = []
  env.onUpdate = (update) => updates.push(update)
  const capture = {}
  const sdk = staticSdk([
    { type: 'system', subtype: 'init', permissionMode: 'bypassPermissions', session_id: 'sess-1' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hi there' }] }, parent_tool_use_id: null, session_id: 'sess-1' },
    { type: 'result', subtype: 'success', is_error: false, result: 'hi there', session_id: 'sess-1' },
  ], capture)
  const channel = createClaudeCodeChannel({ claudeExecutable: 'C:/fake/bin/claude.exe', sdk })
  const result = await channel.run({ prompt: 'hello', cwd: 'C:/ws', model: 'claude-opus-4', reasoningEffort: 'high' }, env)
  assert.equal(result.stopReason, 'completed')
  assert.equal(result.output, 'hi there')
  assert.equal(result.sessionId, 'sess-1')
  assert.equal(result.channel, 'claude-code')
  assert.equal(capture.query.prompt, 'hello')
  assert.equal(capture.query.options.pathToClaudeCodeExecutable, 'C:/fake/bin/claude.exe')
  assert.equal(capture.query.options.permissionMode, 'bypassPermissions')
  assert.equal(capture.query.options.allowDangerouslySkipPermissions, true)
  assert.deepEqual(capture.query.options.sandbox, { enabled: false })
  assert.equal(capture.query.options.model, 'claude-opus-4')
  assert.equal(capture.query.options.effort, 'high')
  assert.deepEqual(capture.query.options.systemPrompt, { type: 'preset', preset: 'claude_code' })
  assert.deepEqual(updates, [{ type: 'text-delta', text: 'hi there' }])
})

test('SDK run treats error result as error and fails closed on permission policy drift', async () => {
  const env = makeEnv()
  const sdk = staticSdk([
    { type: 'system', subtype: 'init', permissionMode: 'bypassPermissions', session_id: 'sess-e' },
    { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['failed to run'], session_id: 'sess-e' },
  ])
  const channel = createClaudeCodeChannel({ claudeExecutable: 'C:/fake/bin/claude.exe', sdk })
  const result = await channel.run({ prompt: 'hi', cwd: 'C:/ws' }, env)
  assert.equal(result.stopReason, 'error')
  assert.match(result.output, /failed to run/)

  const drift = createClaudeCodeChannel({
    claudeExecutable: 'C:/fake/bin/claude.exe',
    sdk: staticSdk([{ type: 'system', subtype: 'init', permissionMode: 'default', session_id: 'sess-drift' }]),
  })
  const drifted = await drift.run({ prompt: 'hi', cwd: 'C:/ws' }, env)
  assert.equal(drifted.stopReason, 'error')
  assert.match(drifted.output, /did not enter the requested permission mode bypassPermissions/)
})

test('SDK resume passes session id and marks resume unmanaged/concurrent', async () => {
  const env = makeEnv()
  const capture = {}
  const sdk = staticSdk([
    { type: 'system', subtype: 'init', permissionMode: 'bypassPermissions', session_id: 'sess-2' },
    { type: 'result', subtype: 'success', is_error: false, result: 'cont', session_id: 'sess-2' },
  ], capture)
  const channel = createClaudeCodeChannel({ claudeExecutable: 'C:/fake/bin/claude.exe', sdk })
  const result = await channel.run({ prompt: 'go', cwd: 'C:/ws', resumeSessionId: 'sess-2' }, env)
  assert.equal(result.stopReason, 'completed')
  assert.equal(capture.query.options.resume, 'sess-2')
  assert.equal(result.delivery, 'resume_unmanaged')
  assert.equal(result.mayBeConcurrent, true)
})

test('SDK list/read are bounded and preserve external-or-idle delivery honesty', async () => {
  const capture = {
    sessions: [
      { sessionId: 's1', summary: 'A'.repeat(300), cwd: 'C:/ws', lastModified: 2, createdAt: 1 },
      { sessionId: 's2', summary: 'second', cwd: 'C:/ws', lastModified: 1 },
    ],
    messages: [
      { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'question' } },
      { type: 'assistant', parent_tool_use_id: 'subagent', message: { role: 'assistant', content: 'nested hidden' } },
      { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
    ],
  }
  const channel = createClaudeCodeChannel({ sdk: staticSdk([], capture) })
  const listed = await channel.listSessions({ cwd: 'C:/ws', limit: 1 }, makeEnv())
  assert.equal(listed.sessions.length, 1)
  assert.equal(listed.sessions[0].id, 's1')
  assert.equal(listed.sessions[0].preview.length, 200)
  assert.equal(listed.sessions[0].delivery, 'external_or_idle')
  assert.equal(listed.truncated, true)
  assert.deepEqual(capture.listOptions, { dir: 'C:/ws', limit: 2 })

  const read = await channel.readSession({ sessionId: 's1', maxTurns: 20 }, makeEnv())
  assert.deepEqual(read.turns.map((turn) => [turn.role, turn.text]), [['user', 'question'], ['assistant', 'answer']])
  assert.equal(read.delivery, 'external_or_idle')
  assert.equal(read.capabilities.readSession, true)
})

function managedSdk(capture) {
  return {
    query(params) {
      capture.query = params
      let release
      const interrupted = new Promise((resolve) => { release = resolve })
      return {
        async *[Symbol.asyncIterator]() {
          const first = await params.prompt[Symbol.asyncIterator]().next()
          capture.firstInput = first.value
          yield { type: 'system', subtype: 'init', permissionMode: 'bypassPermissions', session_id: 'managed-claude-1' }
          await interrupted
          yield { type: 'result', subtype: 'success', is_error: false, result: 'stopped', session_id: 'managed-claude-1' }
        },
        async interrupt() {
          capture.interrupts = (capture.interrupts ?? 0) + 1
          release()
          return { still_queued: [] }
        },
        close() {
          capture.closed = true
          release()
        },
      }
    },
    async listSessions(opts) {
      capture.listOptions = opts
      return [{ sessionId: 'managed-claude-1', summary: 'active', cwd: 'C:/ws', lastModified: 1 }]
    },
    async getSessionMessages() { return [] },
  }
}

test('managed SDK session uses streaming input and owned-only interrupt cancel', async () => {
  const capture = {}
  const sdk = managedSdk(capture)
  const channel = createClaudeCodeChannel({
    claudeExecutable: 'C:/fake/bin/claude.exe',
    sdk,
    managedInitTimeoutMs: 5000,
  })
  const env = makeEnv()
  const started = await channel.startManagedSession({
    prompt: 'fix it',
    cwd: 'C:/ws',
    model: 'claude-opus-4',
    reasoningEffort: 'xhigh',
  }, env)
  assert.equal(started.stopReason, 'completed')
  assert.equal(started.sessionId, 'managed-claude-1')
  assert.equal(started.delivery, 'managed_turn_started')
  assert.equal(started.mayBeConcurrent, false)
  assert.equal(capture.firstInput.message.content, 'fix it')
  assert.equal(capture.query.options.permissionMode, 'bypassPermissions')
  assert.deepEqual(capture.query.options.sandbox, { enabled: false })
  assert.equal(capture.query.options.model, 'claude-opus-4')
  assert.equal(capture.query.options.effort, 'xhigh')

  const listed = await channel.listSessions({ cwd: 'C:/ws', limit: 10 }, env)
  assert.equal(listed.sessions[0].status, 'active')
  assert.equal(listed.sessions[0].cancelable, true)

  const wrong = await channel.cancel({ sessionId: started.sessionId, runId: 'wrong' }, env)
  assert.equal(wrong.stopReason, 'refused')
  assert.equal(capture.interrupts, undefined)
  const cancelled = await channel.cancel({ sessionId: started.sessionId, runId: started.runId }, env)
  assert.equal(cancelled.stopReason, 'completed')
  assert.equal(capture.interrupts, 1)
  await new Promise((resolve) => setImmediate(resolve))
  await channel.dispose()
  assert.equal(capture.closed, true)
})

test('Claude cancel refuses external or idle sessions', async () => {
  const channel = createClaudeCodeChannel({ sdk: staticSdk([]) })
  const result = await channel.cancel({ sessionId: 'external' }, makeEnv())
  assert.equal(result.stopReason, 'refused')
  assert.equal(result.delivery, 'external_or_idle')
})
