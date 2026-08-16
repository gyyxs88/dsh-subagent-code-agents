import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  codexExecArgv,
  codexExecResumeArgv,
  codexInvocationArgs,
  createCodexChannel,
  CODEX_FIXED_SANDBOX_ARGV,
} from '../lib/index.js'
import {
  AppServerClient,
  classifyThreadStatus,
  createCodexAppServerChannel,
  THREAD_STATUS,
} from '../lib/app-server-channel.js'

const BYPASS = '--dangerously-bypass-approvals-and-sandbox'

function countOf(argv, needle) {
  return argv.filter((arg) => arg === needle).length
}

function makeEnv(overrides = {}) {
  return {
    subprocess: {
      async resolveExecutable(name) {
        if (name === 'node') return 'C:/fake/node.exe'
        return 'C:/fake/bin/codex.cmd'
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

// --- argv / capability tests (pure, no spawn) ---

test('codex argv keeps the fixed bypass flag exactly once', () => {
  const argv = codexExecArgv({ node: 'node', js: 'codex.js', cwd: 'C:/ws', request: {} })
  assert.equal(countOf(argv, BYPASS), 1)
  assert.equal(countOf(argv, '--approve-for-me'), 0)
  assert.equal(countOf(argv, '-s'), 0)
  assert.deepEqual(CODEX_FIXED_SANDBOX_ARGV, [BYPASS])
})

test('codex argv supports per-call model and effort', () => {
  const argv = codexExecArgv({
    node: 'node',
    js: 'codex.js',
    cwd: 'C:/ws',
    request: { model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' },
  })
  assert.deepEqual(argv, [
    'node',
    'codex.js',
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--color',
    'never',
    '-C',
    'C:/ws',
    '-m',
    'gpt-5.6-sol',
    '-c',
    'model_reasoning_effort="xhigh"',
    BYPASS,
  ])
})

test('codex resume argv uses resume subcommand, stdin prompt, fixed bypass', () => {
  const argv = codexExecResumeArgv({
    node: 'node',
    js: 'codex.js',
    sessionId: 'thr_abc',
    request: { model: 'gpt-5.6-sol' },
  })
  assert.deepEqual(argv, [
    'node',
    'codex.js',
    'exec',
    'resume',
    'thr_abc',
    '-',
    '--json',
    '--skip-git-repo-check',
    '-m',
    'gpt-5.6-sol',
    BYPASS,
  ])
  assert.throws(
    () => codexExecResumeArgv({ node: 'node', js: 'codex.js', sessionId: '', request: {} }),
    /non-empty session id/,
  )
})

test('codexInvocationArgs validates effort', () => {
  assert.throws(() => codexInvocationArgs({ reasoningEffort: 'impossible' }), /reasoning effort/)
  assert.deepEqual(codexInvocationArgs({}), [])
})

test('codex lightweight channel claims run/resume only; app-server channel claims sessions/steer', () => {
  // Lightweight createCodexChannel: honest run/resume-only capability.
  const light = createCodexChannel()
  assert.equal(light.id, 'codex')
  assert.equal(light.capabilities.run, true)
  assert.equal(light.capabilities.resume, true)
  assert.equal(light.capabilities.listSessions, false)
  assert.equal(light.capabilities.readSession, false)
  assert.equal(light.capabilities.managedSession, false)
  assert.equal(light.capabilities.steerActive, false)
  assert.equal(light.capabilities.cancel, false)
  assert.equal(light.capabilities.sandboxBypassGuaranteed, true)

  // Full app-server channel: sessions + steer + cancel, all with methods.
  const full = createCodexAppServerChannel({ codexJs: 'C:/fake/bin/codex.js' })
  assert.equal(full.capabilities.listSessions, true)
  assert.equal(full.capabilities.readSession, true)
  assert.equal(full.capabilities.managedSession, true)
  assert.equal(full.capabilities.steerActive, true)
  assert.equal(full.capabilities.cancel, true)
  assert.equal(typeof full.listSessions, 'function')
  assert.equal(typeof full.readSession, 'function')
  assert.equal(typeof full.startManagedSession, 'function')
  assert.equal(typeof full.steerActive, 'function')
  assert.equal(typeof full.cancel, 'function')
})

// --- JSONL parse / run via fake subprocess ---

function fakeHandle({ script, exitCode = 0, stderrText = '' }) {
  const state = { stdinData: undefined, stdoutHandler: undefined, terminated: false }
  const handle = {
    stdin: {
      write() {
        return true
      },
      end(data) {
        state.stdinData = data
      },
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
    terminate() {
      state.terminated = true
    },
  }
  return { handle, state }
}

test('run parses thread.started + agent_message and returns sessionId + completed', async () => {
  const env = makeEnv()
  let spawned
  env.subprocess.spawn = (spec) => {
    spawned = spec
    return fakeHandle({
      script: [
        JSON.stringify({ type: 'thread.started', thread_id: 'thr_1' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hello' } }),
        JSON.stringify({ type: 'turn.completed' }),
      ],
    }).handle
  }
  const channel = createCodexChannel({ codexJs: 'C:/fake/bin/codex.js', nodeExecutable: 'C:/fake/node.exe' })
  const result = await channel.run({ prompt: 'hi', cwd: 'C:/ws' }, env)
  assert.equal(result.stopReason, 'completed')
  assert.equal(result.output, 'hello')
  assert.equal(result.sessionId, 'thr_1')
  assert.equal(result.channel, 'codex')
  assert.ok(spawned.argv.includes(BYPASS))
})

test('run treats error event as hard failure even with collected text', async () => {
  const env = makeEnv()
  env.subprocess.spawn = () =>
    fakeHandle({
      script: [
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'partial' } }),
        JSON.stringify({ type: 'error', message: 'boom' }),
      ],
    }).handle
  const channel = createCodexChannel({ codexJs: 'C:/fake/bin/codex.js', nodeExecutable: 'C:/fake/node.exe' })
  const result = await channel.run({ prompt: 'hi', cwd: 'C:/ws' }, env)
  assert.equal(result.stopReason, 'error')
  assert.match(result.output, /boom/)
})

test('run with resumeSessionId builds resume argv and forwards stdin', async () => {
  const env = makeEnv()
  let spawned
  env.subprocess.spawn = (spec) => {
    spawned = spec
    return fakeHandle({
      script: [
        JSON.stringify({ type: 'thread.started', thread_id: 'thr_9' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'cont' } }),
        JSON.stringify({ type: 'turn.completed' }),
      ],
    }).handle
  }
  const channel = createCodexChannel({ codexJs: 'C:/fake/bin/codex.js', nodeExecutable: 'C:/fake/node.exe' })
  const result = await channel.run({ prompt: 'go', cwd: 'C:/ws', resumeSessionId: 'thr_9' }, env)
  assert.equal(result.stopReason, 'completed')
  assert.ok(spawned.argv.includes('resume'))
  assert.ok(spawned.argv.includes('thr_9'))
  assert.equal(result.delivery, 'resume_unmanaged')
  assert.equal(result.mayBeConcurrent, true)
})

test('lightweight run keeps lightweight capabilities; full app-server run reports full capabilities', async () => {
  const script = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thr_x' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
    JSON.stringify({ type: 'turn.completed' }),
  ]
  // Lightweight adapter run → sessions false.
  const envLight = makeEnv()
  envLight.subprocess.spawn = () => fakeHandle({ script }).handle
  const light = createCodexChannel({ codexJs: 'C:/fake/bin/codex.js', nodeExecutable: 'C:/fake/node.exe' })
  const lightResult = await light.run({ prompt: 'hi', cwd: 'C:/ws' }, envLight)
  assert.equal(lightResult.capabilities.listSessions, false)
  assert.equal(lightResult.capabilities.steerActive, false)

  // Full app-server adapter run → sessions + steer true (capabilities passed
  // through to runCodexExec, not the global lightweight defaults).
  const envFull = makeEnv()
  envFull.subprocess.spawn = () => fakeHandle({ script }).handle
  const full = createCodexAppServerChannel({ codexJs: 'C:/fake/bin/codex.js' })
  const fullResult = await full.run({ prompt: 'hi', cwd: 'C:/ws' }, envFull)
  assert.equal(fullResult.capabilities.listSessions, true)
  assert.equal(fullResult.capabilities.readSession, true)
  assert.equal(fullResult.capabilities.managedSession, true)
  assert.equal(fullResult.capabilities.steerActive, true)
  assert.equal(fullResult.capabilities.cancel, true)
})

// --- app-server client (fake JSON-RPC) ---

function makeScriptedSpawn(responder) {
  const captured = { argv: undefined, stdinWrites: [], terminated: false }
  const handle = {
    _data: undefined,
    stdin: {
      write(line) {
        captured.stdinWrites.push(line)
        // Respond asynchronously so the request settles after being recorded.
        try {
          const msg = JSON.parse(line)
          if (msg.id !== undefined && typeof msg.method === 'string') {
            setImmediate(() => responder(msg, handle, captured))
          }
        } catch {}
        return true
      },
    },
    stdout: {
      on(event, fn) {
        if (event === 'data') handle._data = fn
      },
    },
    stderr: { on() {} },
    collected: {},
    done: new Promise(() => {}),
    terminate() {
      captured.terminated = true
    },
    async waitForExit() {},
  }
  return { handle, captured }
}

function defaultResponder(msg, handle) {
  if (msg.method === 'initialize') {
    setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: {} }) + '\n')))
  } else if (msg.method === 'thread/list') {
    setImmediate(() =>
      handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: { data: [], nextCursor: null, backwardsCursor: null } }) + '\n')),
    )
  } else {
    setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: {} }) + '\n')))
  }
}

function makeScriptedEnv(responder = defaultResponder) {
  const { handle, captured } = makeScriptedSpawn(responder)
  const env = makeEnv({
    subprocess: {
      async resolveExecutable(name) {
        if (name === 'node') return 'C:/fake/node.exe'
        return 'C:/fake/bin/codex.cmd'
      },
      spawn() {
        return handle
      },
    },
  })
  return { env, handle, captured }
}

test('app-server handshake sends initialize then initialized notification', async () => {
  const { env, handle, captured } = makeScriptedEnv()
  const client = new AppServerClient({
    spawn: () => handle,
    node: 'node',
    js: 'codex.js',
    logger: { info() {}, warn() {}, error() {} },
  })
  await client.ensureStarted()
  assert.equal(client.initialized, true)
  const methods = captured.stdinWrites.map((l) => JSON.parse(l).method).filter(Boolean)
  assert.ok(methods.includes('initialize'))
  assert.ok(methods.includes('initialized'), 'initialized notification must be sent')
})

test('classifyThreadStatus is honest about notLoaded and external active', () => {
  assert.equal(classifyThreadStatus('active', true), 'active_managed')
  assert.equal(classifyThreadStatus('idle', true), 'idle_managed')
  assert.equal(classifyThreadStatus('systemError', true), 'system_error')
  assert.equal(classifyThreadStatus('notLoaded', true), 'external_or_idle')
  assert.equal(classifyThreadStatus('active', false), 'external_or_idle')
  assert.equal(classifyThreadStatus('idle', false), 'external_or_idle')
  assert.equal(THREAD_STATUS.NOT_LOADED, 'notLoaded')
})

test('app-server channel refuses steer on unmanaged session (external_or_idle)', async () => {
  // thread/read reports notLoaded for an external session → refuse, never
  // claim steer, never auto-load.
  const responder = (msg, handle) => {
    if (msg.method === 'initialize') {
      setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: {} }) + '\n')))
    } else if (msg.method === 'thread/read') {
      setImmediate(() =>
        handle._data(
          Buffer.from(
            JSON.stringify({ id: msg.id, result: { thread: { id: 't1', status: { type: 'notLoaded' }, turns: [] } } }) + '\n',
          ),
        ),
      )
    } else {
      setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: {} }) + '\n')))
    }
  }
  const { env } = makeScriptedEnv(responder)
  const channel = createCodexAppServerChannel({ codexJs: 'C:/fake/bin/codex.js' })
  const result = await channel.steerActive({ sessionId: 't1', input: 'go' }, env)
  assert.equal(result.stopReason, 'refused')
  assert.match(result.output, /only active managed turns|status is notLoaded/)
  assert.equal(result.delivery, 'refused')
})

test('app-server channel lists sessions with honest delivery + bounded preview', async () => {
  const responder = (msg, handle) => {
    if (msg.method === 'initialize') {
      setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: {} }) + '\n')))
    } else if (msg.method === 'thread/list') {
      setImmediate(() =>
        handle._data(
          Buffer.from(
            JSON.stringify({
              id: msg.id,
              result: {
                data: [
                  { id: 'a', preview: 'A', status: { type: 'idle' } },
                  { id: 'b', preview: 'B'.repeat(500), status: { type: 'notLoaded' } },
                ],
                nextCursor: null,
                backwardsCursor: null,
              },
            }) + '\n',
          ),
        ),
      )
    } else {
      setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: {} }) + '\n')))
    }
  }
  const { env } = makeScriptedEnv(responder)
  const channel = createCodexAppServerChannel({ codexJs: 'C:/fake/bin/codex.js' })
  const { sessions } = await channel.listSessions({ cwd: 'C:/ws', limit: 50 }, env)
  assert.equal(sessions.length, 2)
  assert.equal(sessions[0].delivery, 'external_or_idle') // not managed
  assert.equal(sessions[1].preview.length <= 200 + '…[truncated]'.length, true)
  assert.equal(sessions[1].steerable, false)
})

test('createCodexAppServerChannel run delegates to codex exec with bypass', async () => {
  const { env } = makeScriptedEnv()
  let spawned
  env.subprocess.spawn = (spec) => {
    spawned = spec
    return fakeHandle({
      script: [
        JSON.stringify({ type: 'thread.started', thread_id: 'thr_x' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
        JSON.stringify({ type: 'turn.completed' }),
      ],
    }).handle
  }
  const channel = createCodexAppServerChannel({ codexJs: 'C:/fake/bin/codex.js' })
  const result = await channel.run({ prompt: 'hi', cwd: 'C:/ws' }, env)
  assert.equal(result.stopReason, 'completed')
  assert.equal(result.sessionId, 'thr_x')
  assert.ok(spawned.argv.includes(BYPASS))
})

// --- app-server managed-session semantics (fake JSON-RPC, no real provider) ---

function makeAppServerEnv() {
  const { handle, captured } = makeScriptedSpawn(defaultResponder)
  const env = makeEnv({
    subprocess: {
      async resolveExecutable(name) {
        if (name === 'node') return 'C:/fake/node.exe'
        return 'C:/fake/bin/codex.cmd'
      },
      spawn() {
        return handle
      },
    },
  })
  return { env, handle, captured }
}

test('app-server channel startManagedSession uses fixed no-approval policy and returns managed delivery', async () => {
  const responder = (msg, handle) => {
    if (msg.method === 'initialize') {
      setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: {} }) + '\n')))
    } else if (msg.method === 'thread/start') {
      assert.equal(msg.params.approvalPolicy, 'never')
      assert.equal(msg.params.sandbox, 'danger-full-access')
      setImmediate(() =>
        handle._data(
          Buffer.from(JSON.stringify({ id: msg.id, result: { thread: { id: 'thr_new', status: { type: 'idle' } } } }) + '\n'),
        ),
      )
    } else if (msg.method === 'turn/start') {
      assert.equal(msg.params.approvalPolicy, 'never')
      assert.deepEqual(msg.params.sandboxPolicy, { type: 'dangerFullAccess' })
      assert.equal(msg.params.model, 'gpt-5.6-sol')
      assert.equal(msg.params.effort, 'high')
      setImmediate(() =>
        handle._data(
          Buffer.from(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress', items: [], error: null } } }) + '\n'),
        ),
      )
    } else {
      setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: {} }) + '\n')))
    }
  }
  const { handle } = makeScriptedSpawn(responder)
  const env = makeEnv({
    subprocess: {
      async resolveExecutable(name) {
        return name === 'node' ? 'C:/fake/node.exe' : 'C:/fake/bin/codex.cmd'
      },
      spawn() {
        return handle
      },
    },
  })
  const channel = createCodexAppServerChannel({ codexJs: 'C:/fake/bin/codex.js' })
  const result = await channel.startManagedSession(
    { cwd: 'C:/ws', prompt: 'hello', model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    env,
  )
  assert.equal(result.delivery, 'managed_turn_started')
  assert.equal(result.sessionId, 'thr_new')
  assert.equal(result.turnId, 'turn_1')
})

test('startManagedSession validates prompt/model/effort BEFORE creating a thread', async () => {
  let spawnCount = 0
  const { handle } = makeScriptedSpawn((msg) => {
    spawnCount++
    setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: {} }) + '\n')))
  })
  const env = makeEnv({
    subprocess: {
      async resolveExecutable(name) {
        return name === 'node' ? 'C:/fake/node.exe' : 'C:/fake/bin/codex.cmd'
      },
      spawn() {
        return handle
      },
    },
  })
  const channel = createCodexAppServerChannel({ codexJs: 'C:/fake/bin/codex.js' })
  // Empty prompt → refused before any spawn.
  const empty = await channel.startManagedSession({ cwd: 'C:/ws', prompt: '   ' }, env)
  assert.equal(empty.stopReason, 'error')
  assert.match(empty.output, /prompt is required/)
  assert.equal(spawnCount, 0, 'no thread/start may happen for an empty prompt')
  // Invalid effort → refused before any spawn.
  const badEffort = await channel.startManagedSession({ cwd: 'C:/ws', prompt: 'hi', reasoningEffort: 'impossible' }, env)
  assert.equal(badEffort.stopReason, 'error')
  assert.match(badEffort.output, /reasoning effort/)
  assert.equal(spawnCount, 0, 'no thread/start may happen for invalid effort')
})

test('app-server channel steers a managed active turn and drops it after completion', async () => {
  const messages = []
  const responder = (msg, handle) => {
    messages.push(msg.method)
    if (msg.method === 'initialize') {
      setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: {} }) + '\n')))
    } else if (msg.method === 'thread/start') {
      setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: { thread: { id: 't1', status: { type: 'idle' } } } }) + '\n')))
    } else if (msg.method === 'turn/start') {
      setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } }) + '\n')))
    } else if (msg.method === 'thread/read') {
      setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: { thread: { id: 't1', status: { type: 'active' }, turns: [] } } }) + '\n')))
    } else if (msg.method === 'turn/steer') {
      assert.equal(msg.params.expectedTurnId, 'turn_1')
      setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: { turnId: 'turn_1' } }) + '\n')))
    } else if (msg.method === 'turn/interrupt') {
      setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: {} }) + '\n')))
    } else {
      setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: {} }) + '\n')))
    }
  }
  const { handle } = makeScriptedSpawn(responder)
  const env = makeEnv({
    subprocess: {
      async resolveExecutable(name) {
        return name === 'node' ? 'C:/fake/node.exe' : 'C:/fake/bin/codex.cmd'
      },
      spawn() {
        return handle
      },
    },
  })
  const channel = createCodexAppServerChannel({ codexJs: 'C:/fake/bin/codex.js' })
  await channel.startManagedSession({ cwd: 'C:/ws', prompt: 'hi' }, env)
  // Turn completed notification arrives; steer after must still work because
  // thread/read reports active (owned turn is tracked).
  const steer = await channel.steerActive({ sessionId: 't1', input: 'more' }, env)
  assert.equal(steer.delivery, 'steered')
  assert.ok(messages.includes('turn/steer'))
})

test('app-server channel steerActive on systemError is a hard failure', async () => {
  const responder = (msg, handle) => {
    if (msg.method === 'initialize') {
      setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: {} }) + '\n')))
    } else if (msg.method === 'thread/read') {
      setImmediate(() =>
        handle._data(
          Buffer.from(
            JSON.stringify({ id: msg.id, result: { thread: { id: 't1', status: { type: 'systemError' }, turns: [] } } }) + '\n',
          ),
        ),
      )
    } else {
      setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: {} }) + '\n')))
    }
  }
  const { handle } = makeScriptedSpawn(responder)
  const env = makeEnv({
    subprocess: {
      async resolveExecutable(name) {
        return name === 'node' ? 'C:/fake/node.exe' : 'C:/fake/bin/codex.cmd'
      },
      spawn() {
        return handle
      },
    },
  })
  const channel = createCodexAppServerChannel({ codexJs: 'C:/fake/bin/codex.js' })
  const result = await channel.steerActive({ sessionId: 't1', input: 'x' }, env)
  assert.equal(result.stopReason, 'error')
  assert.equal(result.delivery, 'failed')
  assert.match(result.output, /systemError/)
})

test('app-server readSession enforces a global char budget across turns', async () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({
    id: `turn_${i}`,
    items: [{ type: 'userMessage', content: [{ type: 'text', text: 'X'.repeat(100) }] }],
  }))
  const responder = (msg, handle) => {
    if (msg.method === 'initialize') {
      setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: {} }) + '\n')))
    } else if (msg.method === 'thread/read') {
      setImmediate(() =>
        handle._data(
          Buffer.from(
            JSON.stringify({ id: msg.id, result: { thread: { id: 't1', status: { type: 'idle' }, turns } } }) + '\n',
          ),
        ),
      )
    } else {
      setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: {} }) + '\n')))
    }
  }
  const { handle } = makeScriptedSpawn(responder)
  const env = makeEnv({
    subprocess: {
      async resolveExecutable(name) {
        return name === 'node' ? 'C:/fake/node.exe' : 'C:/fake/bin/codex.cmd'
      },
      spawn() {
        return handle
      },
    },
  })
  const channel = createCodexAppServerChannel({ codexJs: 'C:/fake/bin/codex.js' })
  const result = await channel.readSession({ sessionId: 't1', maxChars: 250, maxTurns: 20 }, env)
  const total = result.turns.reduce((s, t) => s + t.chars, 0)
  assert.ok(total <= 250, `global budget exceeded: ${total}`)
  assert.equal(result.truncated, true)
  assert.equal(result.turns[result.turns.length - 1].id, 'turn_9')
})

test('app-server answers server-initiated requests with -32601 (never hangs)', async () => {
  const responder = (msg, handle, captured) => {
    if (msg.method === 'initialize') {
      setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: {} }) + '\n')))
    } else if (msg.method === 'thread/list') {
      setImmediate(() =>
        handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: { data: [], nextCursor: null, backwardsCursor: null } }) + '\n')),
      )
    } else {
      setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: {} }) + '\n')))
    }
  }
  const { handle, captured } = makeScriptedSpawn(responder)
  const env = makeEnv({
    subprocess: {
      async resolveExecutable(name) {
        return name === 'node' ? 'C:/fake/node.exe' : 'C:/fake/bin/codex.cmd'
      },
      spawn() {
        return handle
      },
    },
  })
  const channel = createCodexAppServerChannel({ codexJs: 'C:/fake/bin/codex.js' })
  await channel.listSessions({ cwd: 'C:/ws' }, env)
  // Now a server-initiated request arrives (id + method, no result).
  handle._data(Buffer.from(JSON.stringify({ id: 999, method: 'item/tool/requestUserInput', params: { threadId: 't1' } }) + '\n'))
  await new Promise((r) => setImmediate(r))
  const reply = captured.stdinWrites
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return undefined
      }
    })
    .find((m) => m && m.id === 999 && m.error)
  assert.ok(reply, 'server request must be answered')
  assert.equal(reply.error.code, -32601)
})

test('app-server request timeout marks outcomeUnknown (mutation may have applied)', async () => {
  const { handle } = makeScriptedSpawn((msg) => {
    if (msg.method === 'initialize') {
      setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: {} }) + '\n')))
    }
    // thread/read never answered → timeout
  })
  const env = makeEnv({
    subprocess: {
      async resolveExecutable(name) {
        return name === 'node' ? 'C:/fake/node.exe' : 'C:/fake/bin/codex.cmd'
      },
      spawn() {
        return handle
      },
    },
  })
  const channel = createCodexAppServerChannel({
    codexJs: 'C:/fake/bin/codex.js',
    appServerRequestTimeoutMs: 25,
  })
  await assert.rejects(
    (async () => {
      await channel.readSession({ sessionId: 't1' }, env)
    })(),
    /timed out/,
  )
  // Verify the underlying AppServerError carries outcomeUnknown.
  const client = new AppServerClient({
    spawn: () => handle,
    node: 'node',
    js: 'codex.js',
    requestTimeoutMs: 25,
    logger: { info() {}, warn() {}, error() {} },
  })
  const initP = client.ensureStarted()
  await new Promise((r) => setImmediate(r))
  handle._data(Buffer.from(JSON.stringify({ id: 1, result: {} }) + '\n'))
  await initP
  const err = await client.request('thread/read', { threadId: 't1' }).catch((e) => e)
  assert.equal(err.outcomeUnknown, true)
})

test('steer failure is NOT auto-fallen back to resume', async () => {
  const responder = (msg, handle) => {
    if (msg.method === 'initialize') {
      setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: {} }) + '\n')))
    } else if (msg.method === 'thread/start') {
      setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: { thread: { id: 't1', status: { type: 'idle' } } } }) + '\n')))
    } else if (msg.method === 'turn/start') {
      setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } }) + '\n')))
    } else if (msg.method === 'thread/read') {
      setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: { thread: { id: 't1', status: { type: 'active' }, turns: [] } } }) + '\n')))
    } else if (msg.method === 'turn/steer') {
      // Server rejects the steer (e.g. expectedTurnId mismatch).
      setImmediate(() =>
        handle._data(
          Buffer.from(JSON.stringify({ id: msg.id, error: { code: -32602, message: 'expectedTurnId mismatch' } }) + '\n'),
        ),
      )
    } else {
      setImmediate(() => handle._data(Buffer.from(JSON.stringify({ id: msg.id, result: {} }) + '\n')))
    }
  }
  const { handle } = makeScriptedSpawn(responder)
  const env = makeEnv({
    subprocess: {
      async resolveExecutable(name) {
        return name === 'node' ? 'C:/fake/node.exe' : 'C:/fake/bin/codex.cmd'
      },
      spawn() {
        return handle
      },
    },
  })
  const channel = createCodexAppServerChannel({ codexJs: 'C:/fake/bin/codex.js' })
  await channel.startManagedSession({ cwd: 'C:/ws', prompt: 'hi' }, env)
  await assert.rejects(
    channel.steerActive({ sessionId: 't1', input: 'more' }, env),
    /expectedTurnId mismatch/,
  )
})

test('app-server dispose is idempotent', async () => {
  const { handle } = makeScriptedSpawn(defaultResponder)
  const env = makeEnv({
    subprocess: {
      async resolveExecutable(name) {
        return name === 'node' ? 'C:/fake/node.exe' : 'C:/fake/bin/codex.cmd'
      },
      spawn() {
        return handle
      },
    },
  })
  const channel = createCodexAppServerChannel({ codexJs: 'C:/fake/bin/codex.js' })
  await channel.listSessions({ cwd: 'C:/ws' }, env)
  await channel.dispose()
  await channel.dispose() // second dispose must not throw
})
