import assert from 'node:assert/strict'
import test from 'node:test'

import { registry } from '@dsh-subagent-code-agents/core'
import {
  apply as applyPlugin,
  bindChannelEnv,
  mountChannel,
  providerFromChannel,
  providerNameFor,
  toSubagentStopReason,
} from '../lib/index.js'
import { apply as applyTool } from '../lib/tool.js'

function makeCtx(overrides = {}) {
  const state = {
    registeredProviders: [],
    registeredTools: new Map(),
    effects: [],
    disposed: false,
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    subagents: {
      registerProvider(p) {
        state.registeredProviders.push(p)
        // Simulate the real DSH API: registerProvider returns a disposer.
        return () => {
          state.registeredProviders = state.registeredProviders.filter((x) => x !== p)
        }
      },
      async start(name, request) {
        // Route to a registered provider synchronously (tests stub this).
        const provider = state.registeredProviders.find((p) => p.name === name)
        if (!provider) throw new Error(`provider ${name} not registered`)
        return provider.start(request)
      },
    },
    subprocess: {
      spawn(spec) {
        throw new Error('subprocess.spawn not stubbed')
      },
      async resolveExecutable(name) {
        if (name === 'node') return 'C:/fake/node.exe'
        if (name === 'codex') return 'C:/fake/bin/codex.cmd'
        if (name === 'claude') return 'C:/fake/bin/claude.cmd'
        if (name === 'grok') return 'C:/fake/grok.exe'
        return `C:/fake/${name}.exe`
      },
    },
    tools: {
      register(tool) {
        state.registeredTools.set(tool.name, tool)
        return () => {}
      },
    },
    on(event, fn) {
      if (event === 'dispose') {
        state.disposedHandler = fn
      }
    },
    get() {
      return undefined
    },
    effect(fn) {
      state.effects.push(fn)
      // Cordis runs effects during app startup; simulate immediate execution so
      // providers are usable synchronously in tests.
      fn()
    },
    ...overrides,
  }
  return { ctx, state }
}

test('providerNameFor uses the coding-agent/ prefix (coexists with legacy codex)', () => {
  assert.equal(providerNameFor('codex'), 'coding-agent/codex')
  assert.equal(providerNameFor('claude-code'), 'coding-agent/claude-code')
  assert.equal(providerNameFor('grok-build'), 'coding-agent/grok-build')
  assert.notEqual(providerNameFor('codex'), 'codex')
})

test('toSubagentStopReason maps channel stop reasons to DSH contract', () => {
  assert.equal(toSubagentStopReason({ stopReason: 'completed' }), 'completed')
  assert.equal(toSubagentStopReason({ stopReason: 'aborted' }), 'aborted')
  assert.equal(toSubagentStopReason({ stopReason: 'error' }), 'error')
  assert.equal(toSubagentStopReason({ stopReason: 'refused' }), 'error')
  assert.equal(toSubagentStopReason({ stopReason: 'unsupported' }), 'error')
})

test('mountChannel registers a coding-agent provider and env-bound registry adapter', () => {
  const { ctx, state } = makeCtx()
  const mounted = mountChannel(ctx, { channel: 'codex' })
  assert.ok(mounted)
  assert.equal(mounted.provider.name, 'coding-agent/codex')
  assert.equal(state.registeredProviders.length, 1)
  const bound = registry.get('codex')
  assert.ok(bound, 'env-bound adapter must be registered')
  assert.equal(bound.capabilities.run, true)
  registry.unregister('codex')
})

test('mounted codex adapter exposes every advertised capability as a function', () => {
  const { ctx } = makeCtx()
  mountChannel(ctx, { channel: 'codex' })
  const bound = registry.get('codex')
  assert.ok(bound, 'codex must be registered')
  // Every capability declared true must be callable — not just flagged.
  assert.equal(typeof bound.run, 'function')
  assert.equal(typeof bound.resume, 'function')
  assert.equal(typeof bound.listSessions, 'function')
  assert.equal(typeof bound.readSession, 'function')
  assert.equal(typeof bound.startManagedSession, 'function')
  assert.equal(typeof bound.steerActive, 'function')
  assert.equal(typeof bound.cancel, 'function')
  // Capability flags must match the methods that exist.
  assert.equal(bound.capabilities.listSessions, true)
  assert.equal(bound.capabilities.managedSession, true)
  assert.equal(bound.capabilities.steerActive, true)
  registry.unregister('codex')
})

test('lightweight createCodexChannel claims only run/resume (honest capabilities)', async () => {
  const { createCodexChannel } = await import('@dsh-subagent-code-agents/channel-codex')
  const light = createCodexChannel()
  assert.equal(light.capabilities.run, true)
  assert.equal(light.capabilities.resume, true)
  assert.equal(light.capabilities.listSessions, false)
  assert.equal(light.capabilities.readSession, false)
  assert.equal(light.capabilities.managedSession, false)
  assert.equal(light.capabilities.steerActive, false)
  assert.equal(light.capabilities.cancel, false)
  assert.equal(typeof light.listSessions, 'undefined')
  assert.equal(typeof light.steerActive, 'undefined')
})

test('one failing channel does not block sibling channels (fault isolation)', () => {
  const { ctx, state } = makeCtx()
  const bad = mountChannel(ctx, { channel: 'does-not-exist' })
  assert.equal(bad, undefined)
  const good = mountChannel(ctx, { channel: 'claude-code' })
  assert.ok(good)
  assert.equal(state.registeredProviders.length, 1)
  registry.unregister('claude-code')
})

test('apply mounts multiple channels from config.channels', () => {
  const { ctx, state } = makeCtx()
  const result = applyPlugin(ctx, {
    channels: [
      { channel: 'codex' },
      { channel: 'claude-code' },
      { channel: 'grok-build' },
    ],
  })
  assert.equal(result.mounted.length, 3)
  assert.equal(state.registeredProviders.length, 3)
  const names = state.registeredProviders.map((p) => p.name)
  assert.ok(names.includes('coding-agent/codex'))
  assert.ok(names.includes('coding-agent/claude-code'))
  assert.ok(names.includes('coding-agent/grok-build'))
  for (const id of ['codex', 'claude-code', 'grok-build']) registry.unregister(id)
})

test('apply does not assign undeclared properties onto a strict Cordis context', async () => {
  const { ctx } = makeCtx()
  const strictCtx = new Proxy(ctx, {
    set(target, property, value) {
      if (!Reflect.has(target, property)) {
        throw new Error(`cannot set undeclared property ${String(property)}`)
      }
      return Reflect.set(target, property, value)
    },
  })
  const result = applyPlugin(strictCtx, { channels: [{ channel: 'grok-build' }] })
  assert.equal(result.mounted.length, 1)
  await result.mounted[0].unregister()
})

test('multiple ACP rows mount as independent namespaced channels', async () => {
  const { ctx, state } = makeCtx()
  const one = mountChannel(ctx, { channel: 'acp', id: 'one', command: 'C:/tools/one-acp.exe' })
  const two = mountChannel(ctx, { channel: 'acp', id: 'two', command: 'C:/tools/two-acp.exe' })
  assert.ok(one)
  assert.ok(two)
  assert.equal(one.channel.id, 'acp/one')
  assert.equal(two.channel.id, 'acp/two')
  assert.deepEqual(
    state.registeredProviders.map((provider) => provider.name),
    ['coding-agent/acp/one', 'coding-agent/acp/two'],
  )
  assert.ok(registry.has('acp/one'))
  assert.ok(registry.has('acp/two'))
  await one.unregister()
  await two.unregister()
})

test('unload/reload: dispose unregisters provider, disposes channel, cleans registry; reload works', async () => {
  const { ctx, state } = makeCtx()
  const first = mountChannel(ctx, { channel: 'codex' })
  assert.ok(first)
  assert.equal(state.registeredProviders.length, 1)
  // Simulate hot reload: dispose the first instance (await the cleanup).
  await first.unregister()
  assert.equal(state.registeredProviders.length, 0, 'provider must be unregistered on dispose')
  assert.ok(!registry.has('codex'), 'registry adapter must be removed on dispose')

  // Reload the same channel — must succeed (no duplicate error).
  const second = mountChannel(ctx, { channel: 'codex' })
  assert.ok(second)
  assert.equal(state.registeredProviders.length, 1)
  assert.ok(registry.has('codex'), 'reloaded adapter must be registered')
  await second.unregister()
  registry.unregister('codex')
})

test('unload of one channel does not affect sibling channels', async () => {
  const { ctx, state } = makeCtx()
  const codex = mountChannel(ctx, { channel: 'codex' })
  const claude = mountChannel(ctx, { channel: 'claude-code' })
  assert.equal(state.registeredProviders.length, 2)
  await codex.unregister()
  assert.equal(state.registeredProviders.length, 1)
  assert.equal(state.registeredProviders[0].name, 'coding-agent/claude-code')
  assert.ok(!registry.has('codex'))
  assert.ok(registry.has('claude-code'), 'sibling channel must survive')
  await claude.unregister()
})

test('reload overlap: old cleanup must not delete the new adapter', async () => {
  const { ctx, state } = makeCtx()
  const first = mountChannel(ctx, { channel: 'codex' })
  // Capture the FIRST instance's bound adapter before the reload replaces it.
  const firstBound = registry.get('codex')
  assert.ok(firstBound)
  // New instance atomically replaces the registry adapter (hot reload).
  const second = mountChannel(ctx, { channel: 'codex' })
  assert.ok(second)
  assert.equal(state.registeredProviders.length, 2, 'both providers registered (effect runs twice)')
  const secondBound = registry.get('codex')
  assert.notEqual(secondBound, firstBound, 'reload must install a NEW adapter')
  // Old cleanup runs; the registry adapter is now the SECOND instance's, so it
  // must survive (identity check in the old cleanup prevents deletion).
  await first.unregister()
  assert.ok(registry.has('codex'), 'new adapter must survive old cleanup')
  assert.equal(registry.get('codex'), secondBound, 'registry must hold the NEW adapter, not the old one')
  await second.unregister()
  assert.ok(!registry.has('codex'))
})

test('providerFromChannel wraps channel.run into DSH provider result shape', async () => {
  const fakeChannel = {
    id: 'codex',
    displayName: 'X',
    capabilities: { run: true },
    async run(request) {
      return {
        channel: 'codex',
        runId: 'r1',
        stopReason: 'completed',
        output: 'hello ' + request.prompt,
        sessionId: 's1',
        capabilities: { run: true },
      }
    },
  }
  const provider = providerFromChannel(fakeChannel, {})
  const run = await provider.start({
    prompt: [{ type: 'text', text: 'world' }],
  })
  const result = await run.result
  assert.equal(result.stopReason, 'completed')
  assert.equal(result.sessionId, 's1')
  assert.equal(result.output[0].text, 'hello world')
})

test('providerFromChannel maps channel errors to error stop reason', async () => {
  const fakeChannel = {
    id: 'grok-build',
    displayName: 'Grok',
    capabilities: { run: true },
    async run() {
      throw new Error('boom')
    },
  }
  const provider = providerFromChannel(fakeChannel, {})
  const run = await provider.start({ prompt: [{ type: 'text', text: 'x' }] })
  const result = await run.result
  assert.equal(result.stopReason, 'error')
  assert.match(result.output[0].text, /boom/)
})

test('bindChannelEnv binds session methods to the env (no env param needed)', async () => {
  const calls = []
  const channel = {
    id: 'codex',
    displayName: 'X',
    capabilities: {},
    async run() {},
    async listSessions(opts, env) {
      calls.push(['listSessions', opts, env])
      return { sessions: [], truncated: false }
    },
    async readSession(opts, env) {
      calls.push(['readSession', opts, env])
      return {}
    },
    async steerActive(opts, env) {
      calls.push(['steerActive', opts, env])
      return {}
    },
  }
  const env = { marker: true }
  const bound = bindChannelEnv(channel, env)
  await bound.listSessions({ cwd: 'C:/ws' })
  await bound.readSession({ sessionId: 's1' })
  await bound.steerActive({ sessionId: 's1', input: 'x' })
  assert.equal(calls.length, 3)
  for (const [, , e] of calls) assert.equal(e.marker, true)
})

test('tool layer registers subagent_code and coding_sessions_* tools', () => {
  const { ctx, state } = makeCtx()
  applyTool(ctx, {})
  for (const n of [
    'subagent_code',
    'coding_sessions_list',
    'coding_session_read',
    'coding_session_start',
    'coding_session_send',
    'coding_runs_list',
    'coding_run_read',
    'coding_run_resume',
    'coding_run_cancel',
  ]) {
    assert.ok(state.registeredTools.has(n), `${n} must be registered`)
  }
  // The old plural aliases must NOT be exposed.
  assert.ok(!state.registeredTools.has('coding_sessions_read'))
  assert.ok(!state.registeredTools.has('coding_sessions_start'))
  assert.ok(!state.registeredTools.has('coding_sessions_send'))
})

test('subagent_code rejects unknown channel explicitly', async () => {
  const { ctx, state } = makeCtx()
  applyTool(ctx, {})
  const tool = state.registeredTools.get('subagent_code')
  await assert.rejects(
    tool.execute(
      { channel: 'nope', description: 'x', prompt: 'hi' },
      { agent: { id: 'a' }, signal: new AbortController().signal },
    ),
    /unknown channel "nope"/,
  )
})

test('subagent_code rejects unsupported capability with structured refusal (no fallback)', async () => {
  const { ctx, state } = makeCtx()
  // claude-code channel has resume=true so resume works; but grok lacks
  // listSessions — use a channel stub without resume to test the refusal.
  registry.register({
    id: 'noresume',
    displayName: 'NoResume',
    capabilities: { run: true, resume: false },
    async run() {
      return { channel: 'noresume', runId: 'r', stopReason: 'completed', output: 'ok', capabilities: { run: true, resume: false } }
    },
  })
  applyTool(ctx, {})
  const tool = state.registeredTools.get('subagent_code')
  const result = await tool.execute(
    { channel: 'noresume', description: 'x', prompt: 'hi', resume_session_id: 's1' },
    { agent: { id: 'a' }, signal: new AbortController().signal },
  )
  assert.equal(result.stopReason, 'unsupported')
  assert.match(result.output, /does not support resume/)
  // The renderer must handle the unsupported result whose output is a STRING
  // (not a ContentBlock array) without crashing.
  const rendered = tool.output.render({}, result)
  assert.ok(Array.isArray(rendered))
  assert.equal(rendered[0].text, result.output)
  registry.unregister('noresume')
})

test('subagent_code rejects a call with no calling agent', async () => {
  const { ctx, state } = makeCtx()
  registry.register({
    id: 'agent-req',
    displayName: 'AgentReq',
    capabilities: { run: true },
    async run() {
      return { channel: 'agent-req', runId: 'r', stopReason: 'completed', output: 'ok', capabilities: { run: true } }
    },
  })
  applyTool(ctx, {})
  const tool = state.registeredTools.get('subagent_code')
  await assert.rejects(
    tool.execute({ channel: 'agent-req', description: 'x', prompt: 'hi' }, { signal: new AbortController().signal }),
    /requires a calling agent/,
  )
  registry.unregister('agent-req')
})

test('coding_session_send is NOT concurrency-safe (shared read-decide-act mutation)', async () => {
  const { ctx, state } = makeCtx()
  registry.register({
    id: 'send-chan',
    displayName: 'SendChan',
    capabilities: { run: true, steerActive: true },
    async run() {
      return { channel: 'send-chan', runId: 'r', stopReason: 'completed', output: 'ok', capabilities: {} }
    },
    async steerActive() {
      return { channel: 'send-chan', runId: 'r', stopReason: 'completed', output: 'steered', capabilities: {} }
    },
  })
  applyTool(ctx, {})
  // isConcurrencySafe(args) is validated against the tool schema; pass valid
  // args so the tool's own decision (not schema validation) is observed.
  assert.equal(
    state.registeredTools.get('coding_session_send').isConcurrencySafe({ channel: 'send-chan', session_id: 's1', prompt: 'x' }),
    false,
    'coding_session_send must be serial (read-decide-act on a shared session)',
  )
  assert.equal(
    state.registeredTools.get('coding_sessions_list').isConcurrencySafe({ channel: 'send-chan' }),
    true,
    'list is read-only and parallel-safe',
  )
  assert.equal(
    state.registeredTools.get('coding_session_read').isConcurrencySafe({ channel: 'send-chan', session_id: 's1' }),
    true,
    'read is parallel-safe',
  )
  registry.unregister('send-chan')
})

test('coding_sessions_list refuses when channel lacks listSessions', async () => {
  const { ctx, state } = makeCtx()
  registry.register({
    id: 'nolist',
    displayName: 'NoList',
    capabilities: { run: true, listSessions: false },
    async run() {
      return { channel: 'nolist', runId: 'r', stopReason: 'completed', output: 'ok', capabilities: { run: true, listSessions: false } }
    },
  })
  applyTool(ctx, {})
  const tool = state.registeredTools.get('coding_sessions_list')
  const result = await tool.execute(
    { channel: 'nolist' },
    { agent: { id: 'a' }, signal: new AbortController().signal },
  )
  assert.equal(result.stopReason, 'unsupported')
  assert.match(result.output, /does not support listSessions/)
  registry.unregister('nolist')
})

test('tool session tools call the env-bound channel with clamped params', async () => {
  const { ctx, state } = makeCtx()
  let listCalls = 0
  registry.register({
    id: 'sessions-ok',
    displayName: 'OK',
    capabilities: { run: true, listSessions: true, readSession: true },
    async run() {
      return { channel: 'sessions-ok', runId: 'r', stopReason: 'completed', output: 'ok', capabilities: {} }
    },
    async listSessions(opts) {
      listCalls++
      return { sessions: [{ id: 'a' }], truncated: false }
    },
    async readSession(opts) {
      return { sessionId: opts.sessionId, turns: [], truncated: false }
    },
  })
  applyTool(ctx, {})
  const listTool = state.registeredTools.get('coding_sessions_list')
  const result = await listTool.execute(
    { channel: 'sessions-ok', limit: 99999 },
    { agent: { id: 'a', session: { header: { cwd: 'C:/ws' } } }, signal: new AbortController().signal },
  )
  assert.equal(listCalls, 1)
  assert.equal(result.sessions.length, 1)
  registry.unregister('sessions-ok')
})

test('subagent_code end-to-end: tool → provider → channel with correct DSH request shape', async () => {
  const { ctx, state } = makeCtx()
  let receivedStart
  // Stub subagents.start to capture the request shape a real DSH host sends.
  ctx.subagents.start = async (name, request) => {
    receivedStart = { name, request }
    return {
      id: 'run-1',
      result: Promise.resolve({
        stopReason: 'completed',
        output: [{ type: 'text', text: 'done' }],
        channel: 'codex',
        capabilities: { run: true },
      }),
      async dispose() {},
    }
  }
  // Register a channel so channelFor() resolves.
  registry.register({
    id: 'e2e-codex',
    displayName: 'E2E',
    capabilities: { run: true, resume: true, modelOverride: true, effortOverride: true },
    async run(request) {
      return { channel: 'e2e-codex', runId: 'r', stopReason: 'completed', output: 'ran:' + request.prompt, capabilities: { run: true } }
    },
    async resume(request) {
      return { channel: 'e2e-codex', runId: 'r', stopReason: 'completed', output: 'resumed:' + request.prompt, capabilities: { run: true } }
    },
  })
  applyTool(ctx, { providerPrefix: 'coding-agent' })
  const tool = state.registeredTools.get('subagent_code')
  const exec = {
    agent: { id: 'agent-1', session: { header: { cwd: 'C:/ws' } } },
    signal: new AbortController().signal,
  }
  const result = await tool.execute(
    { channel: 'e2e-codex', description: 'do thing', prompt: 'please work', model: 'gpt-x', resume_session_id: 's1' },
    exec,
  )
  assert.equal(result.output[0].text, 'done')
  // The DSH request must use ContentBlock prompt, parent, label and overrides.
  assert.deepEqual(receivedStart.request.prompt, [{ type: 'text', text: 'please work' }])
  assert.equal(receivedStart.request.parent, exec.agent)
  assert.equal(receivedStart.request.label, 'do thing')
  assert.equal(receivedStart.request.model, 'gpt-x')
  assert.equal(receivedStart.request.resumeSessionId, 's1')
  assert.equal(receivedStart.name, 'coding-agent/e2e-codex')
  registry.unregister('e2e-codex')
})

test('subagent_code role supplies channel/instructions and explicit overrides', async () => {
  const { ctx, state } = makeCtx()
  let received
  ctx.subagents.start = async (name, request) => {
    received = { name, request }
    return {
      id: 'role-run',
      result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] }),
      async dispose() {},
    }
  }
  registry.register({
    id: 'role-channel',
    displayName: 'Role Channel',
    capabilities: { run: true, modelOverride: true, effortOverride: true },
    async run() {},
  })
  applyTool(ctx, {
    roles: [{
      id: 'maintainer',
      channel: 'role-channel',
      model: 'role-default',
      reasoningEffort: 'high',
      instructions: 'Keep the patch minimal.',
      allowDelegation: false,
    }],
  })
  const result = await state.registeredTools.get('subagent_code').execute(
    {
      role: 'maintainer',
      description: 'fix issue',
      prompt: 'Implement it.',
      model: 'explicit-model',
      reasoning_effort: 'xhigh',
    },
    { agent: { id: 'a' }, signal: new AbortController().signal },
  )
  assert.equal(result.stopReason, 'completed')
  assert.equal(received.name, 'coding-agent/role-channel')
  assert.equal(received.request.model, 'explicit-model')
  assert.equal(received.request.reasoningEffort, 'xhigh')
  assert.match(received.request.prompt[0].text, /Keep the patch minimal\./)
  assert.match(received.request.prompt[0].text, /Do not delegate/)
  registry.unregister('role-channel')
})

test('background owned run settles, remains inspectable, and resumes as a linked new run', async () => {
  const tasks = []
  let nextJob = 0
  const jobs = {
    start(spec) {
      const task = spec.run()
      tasks.push(task)
      return `job-${++nextJob}`
    },
  }
  const { ctx, state } = makeCtx({
    get(name) { return name === 'jobs' ? jobs : undefined },
  })
  const starts = []
  ctx.subagents.start = async (name, request) => {
    starts.push({ name, request })
    return {
      id: `child-${starts.length}`,
      result: Promise.resolve({
        stopReason: 'completed',
        output: [{ type: 'text', text: `done-${starts.length}` }],
        sessionId: 'session-owned',
      }),
      async dispose() {},
    }
  }
  registry.register({
    id: 'owned-channel',
    displayName: 'Owned',
    capabilities: { run: true, resume: true },
    async run() {},
    async resume() {},
  })
  applyTool(ctx, {})
  const started = await state.registeredTools.get('subagent_code').execute(
    {
      channel: 'owned-channel',
      description: 'background work',
      prompt: 'secret prompt not persisted',
      run_in_background: true,
    },
    { agent: { id: 'owner' }, signal: new AbortController().signal },
  )
  assert.equal(started.kind, 'background')
  assert.equal(started.jobId, 'job-1')
  assert.match(started.runId, /^run-/)
  const renderedStart = state.registeredTools.get('subagent_code').output.render({}, started)[0].text
  assert.match(renderedStart, /job-1/)
  assert.match(renderedStart, new RegExp(started.runId))
  assert.deepEqual(await tasks[0].done, { status: 'completed', output: 'done-1' })

  const read = await state.registeredTools.get('coding_run_read').execute(
    { run_id: started.runId },
    { agent: { id: 'owner' } },
  )
  assert.equal(read.status, 'settled')
  assert.equal(read.continuation, 'resume_available')
  assert.equal(read.sessionId, 'session-owned')
  assert.ok(!Object.hasOwn(read, 'prompt'))

  const resumed = await state.registeredTools.get('coding_run_resume').execute(
    { run_id: started.runId, prompt: 'continue now' },
    { agent: { id: 'owner' } },
  )
  assert.equal(resumed.jobId, 'job-2')
  assert.equal(starts[1].request.resumeSessionId, 'session-owned')
  assert.deepEqual(await tasks[1].done, { status: 'completed', output: 'done-2' })
  const resumedRead = await state.registeredTools.get('coding_run_read').execute(
    { run_id: resumed.runId },
    { agent: { id: 'owner' } },
  )
  assert.equal(resumedRead.resumedFrom, started.runId)
  registry.unregister('owned-channel')
})

test('providerFromChannel parses ContentBlock prompt and derives cwd from parent', async () => {
  const seen = {}
  const channel = {
    id: 'codex',
    displayName: 'X',
    capabilities: { run: true },
    async run(request) {
      seen.prompt = request.prompt
      seen.cwd = request.cwd
      seen.parentCwd = request.parentCwd
      return { channel: 'codex', runId: 'r', stopReason: 'completed', output: 'ok', capabilities: { run: true } }
    },
  }
  const provider = providerFromChannel(channel, {})
  const run = await provider.start({
    label: 'l',
    prompt: [{ type: 'text', text: 'hello world' }],
    parent: { session: { header: { cwd: 'C:/parent' } } },
  })
  await run.result
  assert.equal(seen.prompt, 'hello world')
  assert.equal(seen.parentCwd, 'C:/parent')
})
