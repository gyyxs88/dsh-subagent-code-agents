import assert from 'node:assert/strict'
import test from 'node:test'

import { apply as applyAutoTool, presetAllowsAutoTools } from '../lib/auto-tool.js'
import { toolNames } from '../lib/tool.js'

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
    agents: { list: () => [...existingAgents] },
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
