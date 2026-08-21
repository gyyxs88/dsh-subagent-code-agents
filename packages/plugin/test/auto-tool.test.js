import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { emptyCapabilities, registry } from '@dsh-subagent-code-agents/core'
import * as AutoToolPlugin from '../lib/auto-tool.js'
import { toolNames } from '../lib/tool.js'

const { apply: applyAutoTool, presetAllowsAutoTools } = AutoToolPlugin

function makeAgent(presetId, initialTools = []) {
  const tools = new Map(initialTools.map((name) => [name, { name }]))
  const listeners = new Map()
  const ctx = {
    presetId,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    subagents: {},
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    get() {
      return undefined
    },
    on(event, listener) {
      const rows = listeners.get(event) ?? []
      rows.push(listener)
      listeners.set(event, rows)
      return () => {
        listeners.set(event, (listeners.get(event) ?? []).filter((row) => row !== listener))
      }
    },
    effect(callback) {
      const cleanup = callback()
      let active = true
      return async () => {
        if (!active) return
        active = false
        await cleanup?.()
      }
    },
  }
  return { ctx, tools }
}

function makeHost(existingAgents = []) {
  const listeners = new Map()
  const logs = { debug: [], warn: [] }
  let cleanup
  const ctx = {
    logger: {
      info() {},
      error() {},
      debug(message) { logs.debug.push(message) },
      warn(message) { logs.warn.push(message) },
    },
    agents: {
      list: () => [...existingAgents],
      get: (id) => existingAgents.find((agent) => agent.id === id),
    },
    agentPresets: { composedPreset: (agentCtx) => agentCtx.presetId },
    tools: { get: (name, agent) => agent.ctx.tools.get?.(name) ?? agent.tools?.get?.(name) },
    subagents: {},
    on(event, listener) {
      const rows = listeners.get(event) ?? []
      rows.push(listener)
      listeners.set(event, rows)
      return () => {
        listeners.set(event, (listeners.get(event) ?? []).filter((row) => row !== listener))
      }
    },
    effect(callback) {
      cleanup = callback()
      return cleanup
    },
  }
  return {
    ctx,
    logs,
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    },
    async dispose() {
      await cleanup?.()
    },
  }
}

function asRuntimeAgent(presetId, initialTools = []) {
  const fixture = makeAgent(presetId, initialTools)
  const agent = { ctx: fixture.ctx, tools: fixture.tools }
  fixture.ctx.tools.get = (name) => fixture.tools.get(name)
  return { agent, tools: fixture.tools }
}

test('preset policy includes composed presets and excludes minimal by default', () => {
  assert.equal(presetAllowsAutoTools('standard'), true)
  assert.equal(presetAllowsAutoTools('code'), true)
  assert.equal(presetAllowsAutoTools('cordis'), true)
  assert.equal(presetAllowsAutoTools('custom'), true)
  assert.equal(presetAllowsAutoTools('minimal'), false)
  assert.equal(presetAllowsAutoTools(undefined), false)
})

test('auto policy mounts existing and newly-created non-minimal agents only', async () => {
  const standard = asRuntimeAgent('standard')
  const minimal = asRuntimeAgent('minimal')
  const host = makeHost([standard.agent, minimal.agent])

  applyAutoTool(host.ctx)
  assert.deepEqual([...standard.tools.keys()].sort(), [...toolNames].sort())
  assert.equal(minimal.tools.size, 0)

  const code = asRuntimeAgent('code')
  const cordis = asRuntimeAgent('cordis')
  host.emit('agent/created', { agent: code.agent })
  host.emit('agent/created', { agent: cordis.agent })
  assert.deepEqual([...code.tools.keys()].sort(), [...toolNames].sort())
  assert.deepEqual([...cordis.tools.keys()].sort(), [...toolNames].sort())

  host.emit('agent/disposed', { agent: code.agent })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(code.tools.size, 0)

  await host.dispose()
  assert.equal(standard.tools.size, 0)
  assert.equal(cordis.tools.size, 0)
})

test('blank-session preset switches unmount minimal and remount non-minimal', async () => {
  const fixture = asRuntimeAgent('standard')
  fixture.agent.id = 'session-switch'
  const host = makeHost([fixture.agent])

  applyAutoTool(host.ctx)
  assert.deepEqual([...fixture.tools.keys()].sort(), [...toolNames].sort())

  fixture.agent.ctx.presetId = 'minimal'
  host.emit('agent-preset/selected', 'session-switch', 'minimal')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fixture.tools.size, 0)

  fixture.agent.ctx.presetId = 'cordis'
  host.emit('agent-preset/selected', 'session-switch', 'cordis')
  assert.deepEqual([...fixture.tools.keys()].sort(), [...toolNames].sort())

  await host.dispose()
})

test('manual complete tool row wins and partial conflicts fail closed', () => {
  const manual = asRuntimeAgent('codex', toolNames)
  const partial = asRuntimeAgent('standard', ['subagent_code'])
  const host = makeHost([manual.agent, partial.agent])

  applyAutoTool(host.ctx)

  assert.deepEqual([...manual.tools.keys()].sort(), [...toolNames].sort())
  assert.deepEqual([...partial.tools.keys()], ['subagent_code'])
  assert.equal(host.logs.debug.some((message) => message.includes('already mounts')), true)
  assert.equal(host.logs.warn.some((message) => message.includes('partial conflicting')), true)
})

test('auto-mounted subagent_code uses the host-injected service across agent isolation', async () => {
  const ctx = new Context()
  const registeredTools = new Map()
  const starts = []
  const agents = []
  const serviceDisposers = [
    ctx.provide('tools', {
      register(definition) {
        registeredTools.set(definition.name, definition)
        return () => registeredTools.delete(definition.name)
      },
      get(name) {
        return registeredTools.get(name)
      },
    }),
    ctx.provide('subagents', {
      async start(name, request) {
        starts.push({ name, request })
        return {
          result: Promise.resolve({
            output: [{ type: 'text', text: 'AUTO_INJECT_OK' }],
            stopReason: 'completed',
          }),
          async dispose() {},
        }
      },
    }),
    ctx.provide('agents', {
      list: () => [...agents],
      get: (id) => agents.find((agent) => agent.id === id),
    }),
    ctx.provide('agentPresets', {
      composedPreset: () => 'standard',
    }),
  ]
  const channelId = 'auto-inject-test'
  registry.replace({
    id: channelId,
    displayName: 'Auto Inject Test',
    capabilities: { ...emptyCapabilities(), run: true },
    async run() {
      throw new Error('channel.run must be owned by the registered subagent provider')
    },
  })

  let agentCtx
  const agentFiber = ctx.isolate('subagents').plugin({
    inject: ['tools'],
    apply(scope) {
      agentCtx = scope
    },
  })
  let autoFiber
  try {
    await agentFiber
    const agent = {
      id: 'isolated-agent',
      ctx: agentCtx,
      session: { header: { cwd: '/workspace/test' } },
    }
    agents.push(agent)
    assert.throws(() => agentCtx.subagents, /cannot get property "subagents" without inject/)

    autoFiber = ctx.plugin(AutoToolPlugin)
    await autoFiber
    const tool = registeredTools.get('subagent_code')
    assert.ok(tool, 'subagent_code must be auto-mounted')

    const result = await tool.execute(
      {
        channel: channelId,
        description: 'verify injected service',
        prompt: 'Return the marker.',
        run_in_background: false,
      },
      { agent, signal: new AbortController().signal },
    )
    assert.equal(result.output[0].text, 'AUTO_INJECT_OK')
    assert.equal(starts.length, 1)
    assert.equal(starts[0].name, `coding-agent/${channelId}`)
  } finally {
    await autoFiber?.dispose()
    await agentFiber.dispose()
    registry.unregister(channelId)
    await Promise.allSettled(serviceDisposers.reverse().map((dispose) => dispose()))
  }
})
