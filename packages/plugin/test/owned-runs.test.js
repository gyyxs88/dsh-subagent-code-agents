import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { isJsonValue } from '@deepseek-ai/dsh-session'

import {
  OwnedRunRegistry,
  defaultRunRegistryPath,
  jobOutcomeFor,
  sharedOwnedRunRegistry,
} from '../lib/owned-runs.js'

function tempRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-owned-runs-'))
  return { dir, file: path.join(dir, 'runs.json') }
}

const resumableChannels = {
  get(id) {
    return id === 'codex' ? { capabilities: { resume: true } } : undefined
  },
}

test('default registry path follows explicit config, then DSH_HOME, otherwise memory', () => {
  assert.equal(defaultRunRegistryPath({}, {}), undefined)
  assert.equal(
    defaultRunRegistryPath({}, { DSH_HOME: 'C:/dsh-home' }),
    path.join('C:/dsh-home', 'dsh-subagent-code-agents', 'owned-runs.json'),
  )
  assert.equal(defaultRunRegistryPath({ runRegistryPath: './custom.json' }, {}), path.resolve('./custom.json'))
})

test('settled run persists bounded metadata without the prompt', () => {
  const { dir, file } = tempRegistry()
  try {
    let id = 0
    const owned = new OwnedRunRegistry({ filePath: file, idFactory: () => `run-${++id}` })
    const record = owned.create({
      channel: 'codex',
      label: 'fix bug',
      cwd: 'C:/ws',
      model: 'gpt-x',
      sessionId: 'session-1',
      prompt: 'must never be saved',
    })
    owned.setJobId(record.id, 'job-1')
    owned.settle(record.id, {
      stopReason: 'completed',
      sessionId: 'session-1',
      turnId: 'turn-1',
      outcomeUnknown: true,
      output: [{ type: 'text', text: 'A'.repeat(20_000) }],
    })
    const raw = fs.readFileSync(file, 'utf8')
    assert.ok(!raw.includes('must never be saved'))
    const reloaded = new OwnedRunRegistry({ filePath: file })
    const view = reloaded.read(record.id, resumableChannels)
    assert.equal(view.status, 'settled')
    assert.equal(view.continuation, 'resume_available')
    assert.equal(view.outputSummary.length, 16_000)
    assert.equal(view.jobId, 'job-1')
    assert.equal(view.turnId, 'turn-1')
    assert.equal(view.outcomeUnknown, true)
    assert.equal(view.progress.phase, 'settled')
    assert.equal(view.progress.source, 'final-output')
    assert.equal(isJsonValue(view), true)
    assert.equal(Object.hasOwn(view, 'ownerId'), false)
    assert.equal(Object.hasOwn(view, 'notification'), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('restart turns running into interrupted and never claims process activity', () => {
  const { dir, file } = tempRegistry()
  try {
    const first = new OwnedRunRegistry({ filePath: file, idFactory: () => 'run-live' })
    first.create({ channel: 'codex', label: 'continue', sessionId: 'session-1' })
    const second = new OwnedRunRegistry({ filePath: file })
    const view = second.read('run-live', resumableChannels)
    assert.equal(view.status, 'interrupted')
    assert.equal(view.active, false)
    assert.equal(view.continuation, 'resume_available')
    assert.equal(view.interruption.reason, 'process-restart-or-crash')
    assert.equal(view.progress.phase, 'interrupted')
    const cancel = second.cancel('run-live')
    assert.equal(cancel.accepted, false)
    assert.match(cancel.reason, /not active in this process/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('interrupted run without session is honestly unavailable', () => {
  const owned = new OwnedRunRegistry({ idFactory: () => 'run-no-session' })
  const record = owned.create({ channel: 'codex', label: 'fresh run' })
  const controller = new AbortController()
  owned.attach(record.id, { controller })
  assert.equal(owned.read(record.id, resumableChannels).continuation, 'active')
  return owned.dispose().then(() => {
    const view = owned.read(record.id, resumableChannels)
    assert.equal(view.status, 'interrupted')
    assert.equal(view.active, false)
    assert.equal(view.continuation, 'unavailable')
    assert.equal(controller.signal.aborted, true)
  })
})

test('active cancel aborts only the current process controller', () => {
  const owned = new OwnedRunRegistry({ idFactory: () => 'run-active' })
  const record = owned.create({ channel: 'codex', label: 'active' })
  const controller = new AbortController()
  owned.attach(record.id, { controller })
  const result = owned.cancel(record.id, 'stop now')
  assert.equal(result.accepted, true)
  assert.equal(controller.signal.aborted, true)
  assert.equal(controller.signal.reason, 'stop now')
})

test('progress is bounded, persisted on settlement, and remains lossless JSON', () => {
  const { dir, file } = tempRegistry()
  try {
    const owned = new OwnedRunRegistry({ filePath: file, idFactory: () => 'run-progress' })
    const record = owned.create({ channel: 'codex', label: 'progress' })
    owned.updateProgress(record.id, { type: 'text-delta', text: 'first update\n' })
    owned.updateProgress(record.id, { type: 'text-delta', text: 'Z'.repeat(8_000) })
    const active = owned.read(record.id, resumableChannels)
    assert.equal(active.progress.phase, 'working')
    assert.equal(active.progress.availability, 'available')
    assert.equal(active.progress.preview.length, 4_096)
    assert.equal(active.progress.truncated, true)
    assert.equal(isJsonValue(active), true)
    const listed = owned.list({ channelRegistry: resumableChannels })
    assert.equal(listed.runs[0].progress.preview.length, 500)
    assert.equal(isJsonValue(listed), true)
    owned.settle(record.id, { stopReason: 'completed', output: [{ type: 'text', text: 'done' }] })
    const reloaded = new OwnedRunRegistry({ filePath: file })
    const settled = reloaded.read(record.id, resumableChannels)
    assert.equal(settled.progress.phase, 'settled')
    assert.equal(settled.progress.preview.length, 4_096)
    assert.equal(isJsonValue(settled), true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('v1 registry and notification with missing optional fields migrate without undefined output', () => {
  const { dir, file } = tempRegistry()
  try {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      runs: [{
        id: 'run-v1',
        channel: 'codex',
        label: 'legacy',
        ownerId: 'owner',
        completionDelivery: 'followup',
        status: 'settled',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:01:00.000Z',
        notification: {
          kind: 'terminal',
          fingerprint: 'a'.repeat(64),
          messageId: 'message-1',
          state: 'delivered',
          attempts: 1,
          deliveredAt: '2026-01-01T00:01:00.000Z',
        },
      }],
    }))
    const owned = new OwnedRunRegistry({ filePath: file })
    const internal = owned.readInternal('run-v1')
    assert.equal(Object.hasOwn(internal.notification, 'lastError'), false)
    const view = owned.read('run-v1', resumableChannels)
    assert.equal(Object.hasOwn(view, 'notification'), false)
    assert.equal(Object.hasOwn(view, 'ownerId'), false)
    assert.equal(view.progress.availability, 'not-yet')
    assert.equal(isJsonValue(view), true)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('job outcome mapping keeps completed output and treats abort as killed', () => {
  assert.deepEqual(
    jobOutcomeFor({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] }),
    { status: 'completed', output: 'done' },
  )
  assert.deepEqual(jobOutcomeFor({ stopReason: 'aborted' }), { status: 'killed' })
  assert.deepEqual(jobOutcomeFor({ stopReason: 'error' }), { status: 'failed', detail: 'error' })
})

test('file-backed registries are shared within one process', () => {
  const { dir, file } = tempRegistry()
  try {
    const first = sharedOwnedRunRegistry({ filePath: file })
    const second = sharedOwnedRunRegistry({ filePath: file })
    assert.equal(first, second)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
