import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  cleanupPromptFile,
  createGrokBuildChannel,
  grokExecutionPolicyArgv,
  grokAgentStdioArgv,
  grokPrintArgv,
  grokPromptFileArgv,
  grokResumeArgv,
  grokResumePromptFileArgv,
  listGrokSessions,
  parseGrokChatHistory,
  parseGrokSessions,
  parseGrokStreamLine,
  parseGrokUpdates,
  readGrokSession,
  resolveGrokHome,
  resolveGrok,
  writePromptFileIfNeeded,
} from '../lib/index.js'
import { unsupported } from '@dsh-subagent-code-agents/core'

const FULL_ACCESS_POLICY = Object.freeze({
  permission: 'danger-full-access',
  approvalOwner: 'full-access-controller',
  approvalMode: 'controller-verified',
  provenance: { authority: 'dsh-session-control', verified: true },
  workspaceRoot: 'C:/ws',
})

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
    executionPolicy: FULL_ACCESS_POLICY,
    ...overrides,
  }
}

function assertFixedFullAccess(argv) {
  assert.equal(argv.filter((a) => a === '--permission-mode').length, 1)
  assert.equal(argv.filter((a) => a === 'bypassPermissions').length, 1)
  assert.equal(argv.filter((a) => a === '--sandbox').length, 1)
  assert.equal(argv.filter((a) => a === 'off').length, 1)
}

test('grokPrintArgv is native argv (no shell), fixed full access exactly once', () => {
  const argv = grokPrintArgv({ grok: 'grok.exe', cwd: 'C:/ws', request: {}, prompt: 'hello', executionPolicy: FULL_ACCESS_POLICY })
  assert.equal(argv[0], 'grok.exe')
  assert.ok(argv.includes('-p'))
  assert.ok(argv.includes('hello'), 'short prompt must ride as the -p value')
  assert.ok(argv.includes('--output-format'))
  assert.ok(argv.includes('streaming-json'))
  assert.ok(argv.includes('--no-auto-update'), 'update checks must be disabled')
  assertFixedFullAccess(argv)
  assert.ok(!argv.some((a) => a.includes(';') || a.includes('&&') || a.includes('|')))
})

test('Grok declares Workspace Write unsupported and uses a read-only tool allowlist', () => {
  const readOnly = grokExecutionPolicyArgv({ permission: 'read-only' })
  assert.ok(readOnly.includes('--sandbox') && readOnly.includes('read-only'))
  assert.ok(readOnly.includes('--tools') && readOnly.includes('Read,Grep'))
  assert.ok(readOnly.includes('--disallowed-tools'))
  assert.ok(readOnly.includes('Edit,Write,NotebookEdit,Bash,MCP,WebSearch,WebFetch'))
  assert.throws(() => grokExecutionPolicyArgv({ permission: 'workspace-write' }), /no target-session approval bridge/)
  assert.equal(createGrokBuildChannel().capabilities.executionPolicies['workspace-write'], false)
})

test('grokPrintArgv supports model, effort and cwd', () => {
  const argv = grokPrintArgv({
    grok: 'grok.exe',
    cwd: 'C:/ws',
    request: { model: 'grok-3', reasoningEffort: 'high' },
    prompt: 'hi', executionPolicy: FULL_ACCESS_POLICY,
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
    promptFile: 'C:/tmp/prompt.txt', executionPolicy: FULL_ACCESS_POLICY,
  })
  assert.ok(!argv.includes('-p'), 'long prompts must not use -p')
  assert.ok(argv.includes('--prompt-file'))
  assert.ok(argv.includes('C:/tmp/prompt.txt'))
  assert.ok(argv.includes('--no-auto-update'))
  assertFixedFullAccess(argv)
})

test('grokResumeArgv carries resume id, prompt, no-auto-update and fixed permission', () => {
  const argv = grokResumeArgv({ grok: 'grok.exe', sessionId: 'grok-sess-1', cwd: 'C:/ws', request: {}, prompt: 'continue', executionPolicy: FULL_ACCESS_POLICY })
  assert.ok(argv.includes('--resume'))
  assert.ok(argv.includes('grok-sess-1'))
  assert.ok(argv.includes('continue'), 'resume must carry the prompt')
  assert.ok(argv.includes('--no-auto-update'))
  assertFixedFullAccess(argv)
  assert.throws(
    () => grokResumeArgv({ grok: 'grok.exe', sessionId: '', cwd: 'C:/ws', request: {}, prompt: 'hi', executionPolicy: FULL_ACCESS_POLICY }),
    /non-empty session id/,
  )
})

test('grokResumePromptFileArgv combines resume + prompt-file', () => {
  const argv = grokResumePromptFileArgv({
    grok: 'grok.exe',
    sessionId: 's1',
    cwd: 'C:/ws',
    request: {},
    promptFile: 'C:/tmp/p.txt', executionPolicy: FULL_ACCESS_POLICY,
  })
  assert.ok(argv.includes('--resume'))
  assert.ok(argv.includes('--prompt-file'))
  assert.ok(argv.includes('C:/tmp/p.txt'))
  assertFixedFullAccess(argv)
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
      { id: 'b', cwd: '/workspace/other' },
    ]),
    { cwd: 'C:/ws' },
  )
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].id, 'a')
  assert.ok(parsed[0].preview.length <= 200)
  assert.deepEqual(parseGrokSessions('garbage'), [])
})

test('grok channel capabilities: sessions + managed/cancel + fixed sandbox off, no true steer', () => {
  const channel = createGrokBuildChannel()
  assert.equal(channel.id, 'grok-build')
  assert.equal(channel.capabilities.run, true)
  assert.equal(channel.capabilities.resume, true)
  assert.equal(channel.capabilities.listSessions, true)
  assert.equal(channel.capabilities.readSession, true)
  assert.equal(channel.capabilities.managedSession, true)
  assert.equal(channel.capabilities.steerActive, false)
  assert.equal(channel.capabilities.cancel, true)
  assert.equal(channel.capabilities.sandboxBypassGuaranteed, true)
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

test('resolveGrok refuses PATH discovery and shell shims', async () => {
  const env = makeEnv({
    subprocess: {
      async resolveExecutable() {
        return 'C:/fake/grok.cmd'
      },
    },
  })
  await assert.rejects(resolveGrok(env, {}), /Runtime Manager.*PATH resolution is disabled/)
  await assert.rejects(resolveGrok(env, { grokExecutable: 'C:/fake/grok.ps1' }), /shim/)
})

test('grokResumePromptFileArgv includes --no-auto-update', () => {
  const argv = grokResumePromptFileArgv({
    grok: 'grok.exe',
    sessionId: 's1',
    cwd: 'C:/ws',
    request: {},
    promptFile: 'C:/tmp/p.txt',
    executionPolicy: FULL_ACCESS_POLICY,
  })
  assert.ok(argv.includes('--no-auto-update'))
  assert.equal(argv.filter((a) => a === '--no-auto-update').length, 1)
  assertFixedFullAccess(argv)
})

test('grokAgentStdioArgv is isolated, full-access and carries per-call model/effort', () => {
  const argv = grokAgentStdioArgv({
    grok: 'grok.exe',
    model: 'grok-code-fast-1',
    reasoningEffort: 'high',
    executionPolicy: FULL_ACCESS_POLICY,
  })
  assert.deepEqual(argv, [
    'grok.exe', '--permission-mode', 'bypassPermissions', '--sandbox', 'off', '--no-auto-update',
    'agent', '--always-approve', '--no-leader',
    '--model', 'grok-code-fast-1', '--reasoning-effort', 'high', 'stdio',
  ])
})

function writeSession(grokHome, { cwd, id, title, updatedAt, updates, chatHistory }) {
  const group = path.join(grokHome, 'sessions', encodeURIComponent(cwd))
  const dir = path.join(group, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'summary.json'),
    JSON.stringify({
      info: { id, cwd },
      generated_title: title,
      session_summary: `${title} summary`,
      created_at: '2026-08-01T00:00:00Z',
      updated_at: updatedAt,
      current_model_id: 'grok-code-fast-1',
    }),
  )
  if (updates !== undefined) fs.writeFileSync(path.join(dir, 'updates.jsonl'), updates.join('\n') + '\n')
  if (chatHistory !== undefined) fs.writeFileSync(path.join(dir, 'chat_history.jsonl'), chatHistory.join('\n') + '\n')
  return dir
}

test('resolveGrokHome honors explicit config', () => {
  const env = makeEnv()
  assert.equal(resolveGrokHome({ env, configuredHome: 'C:/custom-grok' }), path.resolve('C:/custom-grok'))
  assert.throws(() => resolveGrokHome({ env, configuredHome: '' }), /non-empty path/)
})

test('listGrokSessions reads documented summaries, filters cwd, sorts and bounds', () => {
  const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-home-test-'))
  TMP_DIRS.push(grokHome)
  writeSession(grokHome, { cwd: 'C:/ws', id: 'session-a', title: 'older', updatedAt: '2026-08-01T00:00:00Z' })
  writeSession(grokHome, { cwd: 'C:/ws', id: 'session-b', title: 'newer', updatedAt: '2026-08-02T00:00:00Z' })
  writeSession(grokHome, { cwd: '/workspace/other', id: 'session-c', title: 'other', updatedAt: '2026-08-03T00:00:00Z' })
  const env = makeEnv()

  const local = listGrokSessions({ env, grokHome, cwd: 'c:\\WS', limit: 1 })
  assert.deepEqual(local.sessions.map((s) => s.id), ['session-b'])
  assert.equal(local.sessions[0].preview, 'newer')
  assert.equal(local.sessions[0].delivery, 'external_or_idle')
  assert.equal(local.truncated, true)

  const all = listGrokSessions({ env, grokHome, includeAll: true, limit: 10 })
  assert.deepEqual(all.sessions.map((s) => s.id), ['session-c', 'session-b', 'session-a'])
  assert.equal(all.truncated, false)
  assert.throws(() => listGrokSessions({ env, grokHome, includeAll: false }), /requires cwd/)
})

test('parseGrokUpdates combines chunks and bounds recent messages', () => {
  const lines = [
    JSON.stringify({ params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } } } }),
    JSON.stringify({ params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'part ' } } } }),
    JSON.stringify({ params: { update: { sessionUpdate: 'tool_call', content: [] } } }),
    JSON.stringify({ params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'two' } } } }),
    JSON.stringify({ params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'next' } } } }),
  ]
  const parsed = parseGrokUpdates(lines.join('\n'), { maxTurns: 2 })
  assert.deepEqual(parsed.turns.map((t) => [t.role, t.text]), [['assistant', 'part two'], ['user', 'next']])
  assert.equal(parsed.truncated, true)
})

test('readGrokSession reads updates without resuming and falls back to old chat history', () => {
  const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-home-test-'))
  TMP_DIRS.push(grokHome)
  const updates = [
    JSON.stringify({ params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'question' } } } }),
    JSON.stringify({ params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } } } }),
  ]
  writeSession(grokHome, { cwd: 'C:/ws', id: 'session-new', title: 'new', updatedAt: '2026-08-02T00:00:00Z', updates })
  writeSession(grokHome, {
    cwd: 'C:/ws',
    id: 'session-old',
    title: 'old',
    updatedAt: '2026-08-01T00:00:00Z',
    chatHistory: [
      JSON.stringify({ type: 'system', content: 'hidden' }),
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'old question' }] }),
      JSON.stringify({ type: 'assistant', content: 'old answer' }),
    ],
  })
  const env = makeEnv()
  const current = readGrokSession({ env, grokHome, sessionId: 'session-new' })
  assert.deepEqual(current.turns.map((t) => [t.role, t.text]), [['user', 'question'], ['assistant', 'answer']])
  assert.equal(current.delivery, 'external_or_idle')
  assert.equal(current.capabilities.readSession, true)

  const old = readGrokSession({ env, grokHome, sessionId: 'session-old' })
  assert.deepEqual(old.turns.map((t) => [t.role, t.text]), [['user', 'old question'], ['assistant', 'old answer']])
  assert.throws(() => readGrokSession({ env, grokHome, sessionId: '../escape' }), /invalid session id/)
})

test('parseGrokChatHistory excludes system and synthetic messages', () => {
  const parsed = parseGrokChatHistory([
    JSON.stringify({ type: 'system', content: 'system' }),
    JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'synthetic' }], synthetic_reason: 'tool' }),
    JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'visible' }] }),
  ].join('\n'))
  assert.deepEqual(parsed.turns.map((t) => t.text), ['visible'])
})

function managedAcpHandle(script) {
  const state = { stdoutHandler: undefined, writes: [], spawnSpec: undefined, terminated: false }
  let resolveDone
  const emit = (message) => setImmediate(() => state.stdoutHandler?.(Buffer.from(`${JSON.stringify(message)}\n`)))
  const handle = {
    state,
    stdin: {
      write(line) {
        const message = JSON.parse(line)
        state.writes.push(message)
        const responses = script(message)
        if (responses !== undefined) {
          for (const response of Array.isArray(responses) ? responses : [responses]) emit(response)
        }
        return true
      },
      end() {},
    },
    stdout: {
      on(event, listener) {
        if (event === 'data') state.stdoutHandler = listener
      },
    },
    collected: { stderr: { readFrom: () => ({ text: '' }) } },
    done: new Promise((resolve) => { resolveDone = resolve }),
    terminate() {
      if (state.terminated) return
      state.terminated = true
      resolveDone({ exitCode: 0, signal: null })
    },
  }
  return handle
}

test('managed Grok session uses official isolated ACP, per-call model/effort and owned cancel', async () => {
  let promptRequestId
  const handle = managedAcpHandle((message) => {
    if (message.method === 'initialize') {
      return { jsonrpc: '2.0', id: message.id, result: { agentCapabilities: { loadSession: true, executionPolicies: { 'danger-full-access': true } } } }
    }
    if (message.method === 'session/new') {
      return { jsonrpc: '2.0', id: message.id, result: { sessionId: 'managed-session-1' } }
    }
    if (message.method === 'session/prompt') {
      promptRequestId = message.id
      return {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'managed-session-1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } },
        },
      }
    }
    if (message.method === 'session/cancel') {
      return { jsonrpc: '2.0', id: promptRequestId, result: { stopReason: 'cancelled' } }
    }
    return undefined
  })
  const env = makeEnv()
  env.subprocess.spawn = (spec) => {
    handle.state.spawnSpec = spec
    return handle
  }
  const channel = createGrokBuildChannel({
    grokExecutable: 'C:/fake/grok.exe',
    managedRequestTimeoutMs: 5000,
  })
  const started = await channel.startManagedSession({
    cwd: 'C:/ws',
    prompt: 'fix it',
    model: 'grok-code-fast-1',
    reasoningEffort: 'high',
  }, env)
  assert.equal(started.stopReason, 'completed')
  assert.equal(started.sessionId, 'managed-session-1')
  assert.equal(started.delivery, 'managed_turn_started')
  assert.equal(started.mayBeConcurrent, false)
  assert.deepEqual(handle.state.spawnSpec.argv, [
    'C:/fake/grok.exe', '--permission-mode', 'bypassPermissions', '--sandbox', 'off', '--no-auto-update',
    'agent', '--always-approve', '--no-leader',
    '--model', 'grok-code-fast-1', '--reasoning-effort', 'high', 'stdio',
  ])
  assert.equal('signal' in handle.state.spawnSpec, false, 'managed process must outlive the tool-call signal')
  assert.deepEqual(handle.state.writes.map((message) => message.method), [
    'initialize', 'session/new', 'session/prompt',
  ])
  assert.deepEqual(handle.state.writes[1].params._meta, { yoloMode: true })

  const wrong = await channel.cancel({ sessionId: started.sessionId, runId: 'wrong-run' }, env)
  assert.equal(wrong.stopReason, 'refused')
  assert.equal(handle.state.writes.some((message) => message.method === 'session/cancel'), false)

  const cancelled = await channel.cancel({ sessionId: started.sessionId, runId: started.runId }, env)
  assert.equal(cancelled.stopReason, 'completed')
  assert.deepEqual(handle.state.writes.find((message) => message.method === 'session/cancel')?.params, {
    sessionId: 'managed-session-1',
  })
  await new Promise((resolve) => setImmediate(resolve))
  await channel.dispose()
  assert.equal(handle.state.terminated, true)
})

test('Grok cancel refuses external or idle sessions', async () => {
  const channel = createGrokBuildChannel()
  const result = await channel.cancel({ sessionId: 'external-session' }, makeEnv())
  assert.equal(result.stopReason, 'refused')
  assert.equal(result.delivery, 'external_or_idle')
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
  const updates = []
  env.onUpdate = (update) => updates.push(update)
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
  assertFixedFullAccess(spawned.argv)
  assert.ok(spawned.argv.includes('--no-auto-update'))
  assert.ok(spawned.argv.includes('hello'), 'short prompt must be in argv')
  assert.ok(!spawned.argv.some((a) => a.includes('&&')))
  assert.deepEqual(updates.map((update) => update.text), ['hello ', 'from ', 'grok'])
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
