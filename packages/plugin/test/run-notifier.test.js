import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { OwnedRunRegistry } from '../lib/owned-runs.js'
import { createRunNotifier } from '../lib/run-notifier.js'

function tempRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-run-notifier-'))
  return { dir, file: path.join(dir, 'runs.json') }
}

function makeOwner() {
  const nextTurn = []
  return {
    id: 'owner',
    session: { id: 'owner', events: [] },
    inbox: { nextTurn, nextStep: [] },
    followup(message) { nextTurn.push(message) },
  }
}

test('settled background run follows up its owner exactly once', async () => {
  const { dir, file } = tempRegistry()
  try {
    const ownedRuns = new OwnedRunRegistry({ filePath: file, idFactory: () => 'run-1' })
    const owner = makeOwner()
    const notifier = createRunNotifier({
      ownedRuns,
      agents: { get: (id) => id === owner.id ? owner : undefined },
      sessions: { async flush() {} },
      logger: { warn() {} },
    })
    const record = ownedRuns.create({
      channel: 'codex',
      label: 'finish feature',
      ownerId: owner.id,
      completionDelivery: 'followup',
    })
    ownedRuns.setJobId(record.id, 'job-1')
    ownedRuns.settle(record.id, {
      stopReason: 'completed',
      sessionId: 'codex-session',
      output: [{ type: 'text', text: 'implemented and verified' }],
    })
    await notifier.request(record.id, owner)
    assert.equal(owner.inbox.nextTurn.length, 1)
    assert.equal(owner.inbox.nextTurn[0].source.plugin, 'dsh-subagent-code-agents')
    assert.equal(owner.inbox.nextTurn[0].source.form, 'run-terminal-report')
    assert.match(owner.inbox.nextTurn[0].content[0].text, /implemented and verified/u)
    assert.equal(ownedRuns.read(record.id).notification.state, 'delivered')

    await notifier.request(record.id, owner)
    assert.equal(owner.inbox.nextTurn.length, 1)
    await notifier.dispose()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('manual background run never auto-reports', async () => {
  const ownedRuns = new OwnedRunRegistry({ idFactory: () => 'run-manual' })
  const owner = makeOwner()
  const notifier = createRunNotifier({ ownedRuns, logger: { warn() {} } })
  const record = ownedRuns.create({
    channel: 'codex',
    label: 'manual',
    ownerId: owner.id,
    completionDelivery: 'manual',
  })
  ownedRuns.settle(record.id, { stopReason: 'completed', output: 'done' })
  await notifier.request(record.id, owner)
  assert.equal(owner.inbox.nextTurn.length, 0)
  await notifier.dispose()
})

test('flush uncertainty reuses the same run report identity', async () => {
  const ownedRuns = new OwnedRunRegistry({ idFactory: () => 'run-flush' })
  const owner = makeOwner()
  let flushError = new Error('temporary flush failure')
  const notifier = createRunNotifier({
    ownedRuns,
    agents: { get: () => owner },
    sessions: { async flush() { if (flushError) throw flushError } },
    logger: { warn() {} },
  })
  const record = ownedRuns.create({
    channel: 'codex',
    label: 'flush test',
    ownerId: owner.id,
    completionDelivery: 'followup',
  })
  ownedRuns.settle(record.id, { stopReason: 'completed', output: 'done' })
  await notifier.request(record.id, owner)
  assert.equal(ownedRuns.read(record.id).notification.state, 'delivery-unknown')
  assert.equal(owner.inbox.nextTurn.length, 1)
  const messageId = owner.inbox.nextTurn[0].id

  flushError = undefined
  await notifier.request(record.id, owner)
  assert.equal(ownedRuns.read(record.id).notification.state, 'delivered')
  assert.equal(owner.inbox.nextTurn.length, 1)
  assert.equal(owner.inbox.nextTurn[0].id, messageId)
  await notifier.dispose()
})

test('restart marks an active persisted run interrupted and reports it on owner remount', async () => {
  const { dir, file } = tempRegistry()
  try {
    const first = new OwnedRunRegistry({ filePath: file, idFactory: () => 'run-restart' })
    first.create({
      channel: 'codex',
      label: 'long task',
      ownerId: 'owner',
      completionDelivery: 'followup',
      sessionId: 'codex-session',
    })
    const reloaded = new OwnedRunRegistry({ filePath: file })
    const owner = makeOwner()
    const notifier = createRunNotifier({
      ownedRuns: reloaded,
      agents: { get: () => owner },
      sessions: { async flush() {} },
      logger: { warn() {} },
    })
    notifier.requestOwner(owner)
    await notifier.request('run-restart', owner)
    assert.equal(owner.inbox.nextTurn.length, 1)
    assert.equal(owner.inbox.nextTurn[0].source.form, 'run-interrupted-report')
    assert.match(owner.inbox.nextTurn[0].content[0].text, /"status":"interrupted"/u)
    await notifier.dispose()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
