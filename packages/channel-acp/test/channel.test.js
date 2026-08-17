import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { createAcpChannel, normalizeAcpChannelId } from '../lib/index.js'

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
    logger: { info() {}, warn() {}, error() {} },
  }
}

function standardScript({ loadSession = true } = {}) {
  let sessionId = 'sess-new'
  return (message) => {
    if (message.method === 'initialize') {
      return { jsonrpc: '2.0', id: message.id, result: { agentCapabilities: { loadSession } } }
    }
    if (message.method === 'session/new') {
      return { jsonrpc: '2.0', id: message.id, result: { sessionId } }
    }
    if (message.method === 'session/load') {
      sessionId = message.params.sessionId
      return { jsonrpc: '2.0', id: message.id, result: {} }
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

test('ACP instance exposes conservative capabilities and rejects shell shims', () => {
  const channel = createAcpChannel({ id: 'opencode', command: 'opencode-acp' })
  assert.equal(channel.id, 'acp/opencode')
  assert.equal(channel.capabilities.run, true)
  assert.equal(channel.capabilities.resume, true)
  assert.equal(channel.capabilities.modelOverride, false)
  assert.equal(channel.capabilities.sandboxBypassGuaranteed, false)
  assert.throws(() => createAcpChannel({ id: 'x', command: 'x.cmd' }), /shell shim/)
})

test('fresh ACP run performs v1 initialize, session/new and session/prompt', async () => {
  const handle = makeHandle(standardScript())
  const channel = createAcpChannel({ id: 'opencode', command: 'opencode-acp', args: ['--stdio'] })
  const result = await channel.run({ prompt: 'fix it', cwd: 'C:/workspace' }, makeEnv(handle))
  assert.equal(result.stopReason, 'completed')
  assert.equal(result.sessionId, 'sess-new')
  assert.equal(result.output, 'done')
  assert.deepEqual(handle.state.spawnSpec.argv, ['C:/tools/opencode-acp.exe', '--stdio'])
  assert.deepEqual(handle.state.writes.map((message) => message.method), [
    'initialize', 'session/new', 'session/prompt',
  ])
  assert.equal(handle.state.writes[0].params.protocolVersion, 1)
  assert.deepEqual(handle.state.writes[1].params.mcpServers, [])
})

test('ACP resume uses session/load and marks the delivery unmanaged/concurrent', async () => {
  const standard = standardScript()
  const handle = makeHandle((message) => {
    if (message.method === 'session/load') {
      return [
        {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: message.params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old-history' } },
          },
        },
        { jsonrpc: '2.0', id: message.id, result: {} },
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
  assert.match(result.output, /does not advertise session\/load/)
  assert.deepEqual(handle.state.writes.map((message) => message.method), ['initialize'])
})

test('generic ACP rejects model and effort overrides explicitly', async () => {
  const handle = makeHandle(standardScript())
  const channel = createAcpChannel({ id: 'x', command: 'C:/tools/acp.exe' })
  await assert.rejects(
    channel.run({ prompt: 'hi', cwd: 'C:/workspace', model: 'anything' }, makeEnv(handle)),
    /do not support model or effort overrides/,
  )
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
