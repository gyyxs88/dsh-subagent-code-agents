import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ChannelRegistry,
  emptyCapabilities,
  hasCapability,
  registry,
  tryRegister,
  unsupported,
} from '../lib/index.js'

function makeChannel(id = 'test') {
  return {
    id,
    displayName: `Test ${id}`,
    capabilities: { ...emptyCapabilities(), run: true },
    async run() {
      return {
        channel: id,
        runId: 'r1',
        stopReason: 'completed',
        output: 'ok',
        capabilities: this.capabilities,
      }
    },
  }
}

test('emptyCapabilities defaults every flag to false', () => {
  const caps = emptyCapabilities()
  for (const key of [
    'run',
    'resume',
    'listSessions',
    'readSession',
    'managedSession',
    'steerActive',
    'cancel',
    'streaming',
    'modelOverride',
    'effortOverride',
    'sandboxBypassGuaranteed',
  ]) {
    assert.equal(caps[key], false, `${key} must default false`)
  }
})

test('registry registers, lists and looks up channels', () => {
  const r = new ChannelRegistry()
  const a = makeChannel('a')
  const b = makeChannel('b')
  r.register(a)
  r.register(b)
  assert.equal(r.size, 2)
  assert.equal(r.get('a'), a)
  assert.equal(r.has('b'), true)
  assert.deepEqual(r.list().map((c) => c.id), ['a', 'b'])
})

test('registry rejects duplicate ids loudly', () => {
  const r = new ChannelRegistry()
  r.register(makeChannel('a'))
  assert.throws(() => r.register(makeChannel('a')), /already registered/)
})

test('registry isolates a malformed channel instead of throwing for others', () => {
  const r = new ChannelRegistry()
  // No run() → recorded as error, not thrown.
  r.register({ id: 'bad', displayName: 'Bad', capabilities: {} })
  assert.equal(r.size, 0)
  assert.ok(r.errors().has('bad'))
  // A good channel still registers fine afterwards.
  const good = makeChannel('good')
  r.register(good)
  assert.equal(r.size, 1)
  assert.equal(r.get('good'), good)
})

test('registry missing id throws but valid registration after works', () => {
  const r = new ChannelRegistry()
  assert.throws(() => r.register({}), /id/)
  const ok = makeChannel('ok')
  r.register(ok)
  assert.equal(r.size, 1)
})

test('unsupported produces an explicit structured refusal', () => {
  const caps = { ...emptyCapabilities() }
  const result = unsupported('codex', 'steerActive', caps)
  assert.equal(result.stopReason, 'unsupported')
  assert.equal(result.output, 'channel "codex" does not support steerActive')
  assert.equal(result.delivery, 'refused')
  assert.equal(result.mayBeConcurrent, false)
  assert.equal(result.capabilities, caps)
})

test('hasCapability reads flags without throwing on missing channel', () => {
  assert.equal(hasCapability(undefined, 'run'), false)
  const ch = { capabilities: { run: true } }
  assert.equal(hasCapability(ch, 'run'), true)
  assert.equal(hasCapability(ch, 'steerActive'), false)
})

test('shared registry: tryRegister swallows duplicate errors', () => {
  const before = registry.size
  const ch = makeChannel(`shared-${Date.now()}`)
  const result = tryRegister(ch)
  assert.equal(result, ch)
  assert.equal(registry.size, before + 1)
  const dup = tryRegister(ch)
  assert.ok(dup instanceof Error)
  assert.equal(registry.size, before + 1)
  registry.unregister(ch.id)
})

test('registry onRegister fires and unsubscribe works', () => {
  const r = new ChannelRegistry()
  const seen = []
  const off = r.onRegister((c) => seen.push(c.id))
  r.register(makeChannel('x'))
  assert.deepEqual(seen, ['x'])
  off()
  r.register(makeChannel('y'))
  assert.deepEqual(seen, ['x'])
})

test('registry rejects capability declared true without a matching method', () => {
  const r = new ChannelRegistry()
  // Declares listSessions=true but has no listSessions().
  r.register({
    id: 'liar',
    displayName: 'Liar',
    capabilities: { ...emptyCapabilities(), run: true, listSessions: true },
    async run() {},
  })
  assert.equal(r.size, 0)
  assert.ok(r.errors().has('liar'))
  assert.match(r.errors().get('liar').message, /declares listSessions but has no listSessions/)
  // A consistent channel still registers.
  const ok = {
    id: 'honest',
    displayName: 'Honest',
    capabilities: { ...emptyCapabilities(), run: true, listSessions: true },
    async run() {},
    async listSessions() {
      return { sessions: [], truncated: false }
    },
  }
  r.register(ok)
  assert.equal(r.size, 1)
  assert.ok(!r.errors().has('honest'))
})

test('successful re-registration clears a stale error', () => {
  const r = new ChannelRegistry()
  r.register({ id: 'bad', displayName: 'Bad', capabilities: {} })
  assert.ok(r.errors().has('bad'))
  const good = makeChannel('bad')
  r.register(good)
  assert.equal(r.size, 1)
  assert.ok(!r.errors().has('bad'), 'stale error must be cleared')
})
