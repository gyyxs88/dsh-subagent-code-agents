import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { createAcpChannel as createRawAcpChannel, normalizeAcpChannelId } from '../lib/index.js'

const FULL_ACCESS_POLICY = Object.freeze({
  permission: 'danger-full-access',
  approvalOwner: 'full-access-controller',
  approvalMode: 'controller-verified',
  provenance: { authority: 'dsh-session-control', verified: true },
  workspaceRoot: 'C:/workspace',
})

function createAcpChannel(config = {}) {
  return createRawAcpChannel({ executionPolicies: { 'danger-full-access': true }, ...config })
}

function makeHandle(script) {
  const state = { stdout: undefined, writes: [], ended: false }
  let resolveDone
  const handle = {
    state,
    stdin: {
      write(line) {
        const message = JSON.parse(line)
        state.writes.push(message)
        const responses = script(message)
        if (responses !== undefined) {
          for (const response of Array.isArray(responses) ? responses : [responses]) {
            setImmediate(() => state.stdout?.(Buffer.from(`${JSON.stringify(response)}\n`)))
          }
        }
        return true
      },
      end() { state.ended = true },
    },
    stdout: {
      on(event, listener) {
        if (event === 'data') state.stdout = listener
      },
    },
    collected: { stderr: { readFrom: () => ({ text: '' }) } },
    done: new Promise((resolve) => { resolveDone = resolve }),
    terminate() {
      resolveDone({ exitCode: 0, signal: null })
    },
  }
  return handle
}

function makeEnv(handle) {
  return {
    subprocess: {
      async resolveExecutable(name) { return `C:/tools/${name}.exe` },
      spawn(spec) {
        handle.state.spawnSpec = spec
        return handle
      },
    },
    fs,
    path,
    cwd: 'C:/workspace',
    executionPolicy: FULL_ACCESS_POLICY,
    runtimeManager: { async resolveExecutable(requirement) { return { executable: `C:/tools/${String(requirement?.id ?? 'acp/runtime').replace(/^acp\//u, '')}.exe`, state: 'installed-auth-unverified' } } },
    logger: { info() {}, warn() {}, error() {} },
  }
}

function standardScript({ loadSession = true, resumeSession = false, configOptions } = {}) {
  let sessionId = 'sess-new'
  let currentOptions = configOptions
  return (message) => {
    if (message.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession,
            executionPolicies: { 'danger-full-access': true },
            ...(resumeSession ? { sessionCapabilities: { resume: {} } } : {}),
          },
        },
      }
    }
    if (message.method === 'session/new') {
      return { jsonrpc: '2.0', id: message.id, result: { sessionId, ...(currentOptions ? { configOptions: currentOptions } : {}) } }
    }
    if (message.method === 'session/load') {
      sessionId = message.params.sessionId
      return { jsonrpc: '2.0', id: message.id, result: currentOptions ? { configOptions: currentOptions } : {} }
    }
    if (message.method === 'session/resume') {
      sessionId = message.params.sessionId
      return { jsonrpc: '2.0', id: message.id, result: currentOptions ? { configOptions: currentOptions } : {} }
    }
    if (message.method === 'session/set_config_option') {
      currentOptions = currentOptions.map((option) =>
        option.id === message.params.configId ? { ...option, currentValue: message.params.value } : option,
      )
      return { jsonrpc: '2.0', id: message.id, result: { configOptions: currentOptions } }
    }
    if (message.method === 'session/prompt') {
      return [
        {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
          },
        },
        { jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } },
      ]
    }
    return undefined
  }
}

test('normalizes an ACP instance to a stable namespaced id', () => {
  assert.equal(normalizeAcpChannelId('OpenCode'), 'acp/opencode')
  assert.equal(normalizeAcpChannelId('acp/custom-1'), 'acp/custom-1')
  assert.throws(() => normalizeAcpChannelId('../bad'), /id must match/)
})

test('ACP instance exposes negotiated methods while sandbox remains conservative', () => {
  const channel = createAcpChannel({ id: 'opencode', command: 'opencode-acp' })
  assert.equal(channel.id, 'acp/opencode')
  assert.equal(channel.capabilities.run, true)
  assert.equal(channel.capabilities.resume, true)
  assert.equal(channel.capabilities.listSessions, true)
  assert.equal(channel.capabilities.readSession, true)
  assert.equal(channel.capabilities.managedSession, true)
  assert.equal(channel.capabilities.cancel, true)
  assert.equal(channel.capabilities.modelOverride, true)
  assert.equal(channel.capabilities.effortOverride, true)
  assert.equal(channel.capabilities.steerActive, false)
  assert.equal(channel.capabilities.sandboxBypassGuaranteed, false)
  assert.throws(() => createAcpChannel({ id: 'x', command: 'x.cmd' }), /shell shim/)
})

test('fresh ACP run performs v1 initialize, session/new and session/prompt', async () => {
  const handle = makeHandle(standardScript())
  const channel = createAcpChannel({ id: 'opencode', command: 'opencode-acp', args: ['--stdio'] })
  const env = makeEnv(handle)
  const updates = []
  env.onUpdate = (update) => updates.push(update)
  const result = await channel.run({ prompt: 'fix it', cwd: 'C:/workspace' }, env)
  assert.equal(result.stopReason, 'completed')
  assert.equal(result.sessionId, 'sess-new')
  assert.equal(result.output, 'done')
  assert.deepEqual(handle.state.spawnSpec.argv, ['C:/tools/opencode-acp.exe', '--stdio'])
  assert.deepEqual(handle.state.writes.map((message) => message.method), [
    'initialize', 'session/new', 'session/prompt',
  ])
  assert.equal(handle.state.writes[0].params.protocolVersion, 1)
  assert.deepEqual(handle.state.writes[1].params.mcpServers, [])
  assert.deepEqual(updates, [{ type: 'text-delta', text: 'done' }])
})

test('ACP resume uses session/load and marks the delivery unmanaged/concurrent', async () => {
  const standard = standardScript()
  const handle = makeHandle((message) => {
    if (message.method === 'session/load') {
      const response = standard(message)
      return [
        {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: message.params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old-history' } },
          },
        },
        response,
      ]
    }
    return standard(message)
  })
  const channel = createAcpChannel({ id: 'custom', command: 'C:/tools/acp.exe' })
  const result = await channel.resume(
    { prompt: 'continue', cwd: 'C:/workspace', resumeSessionId: 'sess-old' },
    makeEnv(handle),
  )
  assert.equal(result.stopReason, 'completed')
  assert.equal(result.sessionId, 'sess-old')
  assert.equal(result.delivery, 'resume_unmanaged')
  assert.equal(result.mayBeConcurrent, true)
  assert.equal(result.output, 'done', 'session/load history replay must not leak into the new prompt output')
  assert.deepEqual(handle.state.writes.map((message) => message.method), [
    'initialize', 'session/load', 'session/prompt',
  ])
})

test('ACP resume refuses when the agent does not advertise session/load', async () => {
  const handle = makeHandle(standardScript({ loadSession: false }))
  const channel = createAcpChannel({ id: 'limited', command: 'C:/tools/acp.exe' })
  const result = await channel.resume(
    { prompt: 'continue', cwd: 'C:/workspace', resumeSessionId: 'sess-old' },
    makeEnv(handle),
  )
  assert.equal(result.stopReason, 'unsupported')
  assert.match(result.output, /neither session\/load nor session\/resume/)
  assert.deepEqual(handle.state.writes.map((message) => message.method), ['initialize'])
})

test('generic ACP returns negotiated unsupported when model config is absent', async () => {
  const handle = makeHandle(standardScript())
  const channel = createAcpChannel({ id: 'x', command: 'C:/tools/acp.exe' })
  const result = await channel.run({ prompt: 'hi', cwd: 'C:/workspace', model: 'anything' }, makeEnv(handle))
  assert.equal(result.stopReason, 'unsupported')
  assert.match(result.output, /does not advertise a modelOverride config option/)
  assert.equal(handle.state.writes.some((message) => message.method === 'session/prompt'), false)
})

test('generic ACP applies advertised model and thought-level config before prompt', async () => {
  const configOptions = [
    {
      id: 'model', category: 'model', type: 'select', currentValue: 'fast',
      options: [{ value: 'fast', name: 'Fast' }, { value: 'strong', name: 'Strong' }],
    },
    {
      id: 'effort', category: 'thought_level', type: 'select', currentValue: 'low',
      options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }],
    },
  ]
  const handle = makeHandle(standardScript({ configOptions }))
  const channel = createAcpChannel({ id: 'configured', command: 'C:/tools/acp.exe' })
  const result = await channel.run({
    prompt: 'hi', cwd: 'C:/workspace', model: 'strong', reasoningEffort: 'high',
  }, makeEnv(handle))
  assert.equal(result.stopReason, 'completed')
  const methods = handle.state.writes.map((message) => message.method)
  assert.deepEqual(methods, [
    'initialize', 'session/new', 'session/set_config_option', 'session/set_config_option', 'session/prompt',
  ])
  assert.deepEqual(handle.state.writes[2].params, { sessionId: 'sess-new', configId: 'model', value: 'strong' })
  assert.deepEqual(handle.state.writes[3].params, { sessionId: 'sess-new', configId: 'effort', value: 'high' })
})

test('ACP resume falls back to stable session/resume without history replay', async () => {
  const handle = makeHandle(standardScript({ loadSession: false, resumeSession: true }))
  const channel = createAcpChannel({ id: 'resume-cap', command: 'C:/tools/acp.exe' })
  const result = await channel.resume({
    prompt: 'continue', cwd: 'C:/workspace', resumeSessionId: 'sess-old',
  }, makeEnv(handle))
  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(handle.state.writes.map((message) => message.method), [
    'initialize', 'session/resume', 'session/prompt',
  ])
})

test('ACP session/list is capability-gated, paginated and bounded', async () => {
  const handle = makeHandle((message) => {
    if (message.method === 'initialize') {
      return {
        jsonrpc: '2.0', id: message.id,
        result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {} } } },
      }
    }
    if (message.method === 'session/list' && message.params.cursor === undefined) {
      return {
        jsonrpc: '2.0', id: message.id,
        result: {
          sessions: [{ sessionId: 's2', cwd: 'C:/workspace', title: 'newer', updatedAt: '2026-08-02T00:00:00Z' }],
          nextCursor: 'next',
        },
      }
    }
    if (message.method === 'session/list' && message.params.cursor === 'next') {
      return {
        jsonrpc: '2.0', id: message.id,
        result: { sessions: [{ sessionId: 's1', cwd: 'C:/workspace', title: 'older' }] },
      }
    }
    return undefined
  })
  const channel = createAcpChannel({ id: 'listed', command: 'C:/tools/acp.exe' })
  const result = await channel.listSessions({ cwd: 'C:/workspace', limit: 1 }, makeEnv(handle))
  assert.deepEqual(result.sessions.map((session) => session.id), ['s2'])
  assert.equal(result.truncated, true)
  assert.equal(result.sessions[0].delivery, 'external_or_idle')
  assert.deepEqual(handle.state.writes[1].params, { cwd: 'C:/workspace' })
  assert.deepEqual(handle.state.writes[2].params, { cwd: 'C:/workspace', cursor: 'next' })
})

test('ACP session/list returns explicit unsupported when agent omits capability', async () => {
  const handle = makeHandle(standardScript())
  const channel = createAcpChannel({ id: 'unlisted', command: 'C:/tools/acp.exe' })
  const result = await channel.listSessions({ cwd: 'C:/workspace' }, makeEnv(handle))
  assert.equal(result.stopReason, 'unsupported')
  assert.match(result.output, /sessionCapabilities\.list/)
  assert.deepEqual(handle.state.writes.map((message) => message.method), ['initialize'])
})

test('ACP readSession uses load replay, message IDs and optional session/close', async () => {
  const handle = makeHandle((message) => {
    if (message.method === 'initialize') {
      return {
        jsonrpc: '2.0', id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } },
        },
      }
    }
    if (message.method === 'session/list') {
      return {
        jsonrpc: '2.0', id: message.id,
        result: { sessions: [{ sessionId: 'history-1', cwd: '/workspace/actual' }] },
      }
    }
    if (message.method === 'session/load') {
      return [
        {
          jsonrpc: '2.0', method: 'session/update',
          params: {
            sessionId: 'history-1',
            update: { sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'question' } },
          },
        },
        {
          jsonrpc: '2.0', method: 'session/update',
          params: {
            sessionId: 'history-1',
            update: { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'ans' } },
          },
        },
        {
          jsonrpc: '2.0', method: 'session/update',
          params: {
            sessionId: 'history-1',
            update: { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'wer' } },
          },
        },
        { jsonrpc: '2.0', id: message.id, result: {} },
      ]
    }
    if (message.method === 'session/close') {
      return { jsonrpc: '2.0', id: message.id, result: {} }
    }
    return undefined
  })
  const channel = createAcpChannel({ id: 'reader', command: 'C:/tools/acp.exe' })
  const result = await channel.readSession({ sessionId: 'history-1', maxTurns: 20 }, makeEnv(handle))
  assert.deepEqual(result.turns.map((turn) => [turn.role, turn.text]), [['user', 'question'], ['assistant', 'answer']])
  assert.equal(result.delivery, 'external_or_idle')
  const load = handle.state.writes.find((message) => message.method === 'session/load')
  assert.equal(load.params.cwd, '/workspace/actual')
  assert.ok(handle.state.writes.some((message) => message.method === 'session/close'))
})

test('ACP managed session owns cancel and refuses mismatched or external run IDs', async () => {
  let promptId
  const standard = standardScript()
  const handle = makeHandle((message) => {
    if (message.method === 'session/prompt') {
      promptId = message.id
      return undefined
    }
    if (message.method === 'session/cancel') {
      return { jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } }
    }
    return standard(message)
  })
  const channel = createAcpChannel({ id: 'managed', command: 'C:/tools/acp.exe', requestTimeoutMs: 5000 })
  const env = makeEnv(handle)
  const started = await channel.startManagedSession({ prompt: 'work', cwd: 'C:/workspace' }, env)
  assert.equal(started.stopReason, 'completed')
  assert.equal(started.delivery, 'managed_turn_started')
  assert.equal(started.sessionId, 'sess-new')
  assert.equal('signal' in handle.state.spawnSpec, false, 'managed process must outlive the tool-call signal')

  const wrong = await channel.cancel({ sessionId: started.sessionId, runId: 'wrong' }, env)
  assert.equal(wrong.stopReason, 'refused')
  const cancelled = await channel.cancel({ sessionId: started.sessionId, runId: started.runId }, env)
  assert.equal(cancelled.stopReason, 'completed')
  assert.deepEqual(handle.state.writes.find((message) => message.method === 'session/cancel')?.params, {
    sessionId: 'sess-new',
  })
  await new Promise((resolve) => setImmediate(resolve))
  const external = await channel.cancel({ sessionId: 'external' }, env)
  assert.equal(external.stopReason, 'refused')
  assert.equal(external.delivery, 'external_or_idle')
  await channel.dispose()
})

test('aborting an active ACP prompt sends session/cancel and reports aborted', async () => {
  const controller = new AbortController()
  const script = standardScript()
  const handle = makeHandle((message) => {
    if (message.method === 'session/prompt') {
      setImmediate(() => controller.abort('stop'))
      return undefined
    }
    return script(message)
  })
  const env = makeEnv(handle)
  env.signal = controller.signal
  const channel = createAcpChannel({ id: 'cancel', command: 'C:/tools/acp.exe' })
  const result = await channel.run({ prompt: 'wait', cwd: 'C:/workspace' }, env)
  assert.equal(result.stopReason, 'aborted')
  const cancel = handle.state.writes.find((message) => message.method === 'session/cancel')
  assert.deepEqual(cancel.params, { sessionId: 'sess-new' })
})
