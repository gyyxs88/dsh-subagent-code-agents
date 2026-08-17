import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadRoleRegistry, resolveRoleInvocation } from '../lib/roles.js'

test('role supplies channel/defaults/instructions while explicit model and effort win', () => {
  const roles = loadRoleRegistry({
    roles: [{
      id: 'reviewer',
      channel: 'codex',
      model: 'role-model',
      reasoningEffort: 'high',
      instructions: 'Review before changing files.',
      allowDelegation: false,
    }],
  })
  const invocation = resolveRoleInvocation({
    role: 'reviewer',
    prompt: 'Fix the bug.',
    model: 'explicit-model',
    reasoning_effort: 'xhigh',
  }, roles)
  assert.equal(invocation.channel, 'codex')
  assert.equal(invocation.role, 'reviewer')
  assert.equal(invocation.model, 'explicit-model')
  assert.equal(invocation.reasoningEffort, 'xhigh')
  assert.match(invocation.prompt, /Review before changing files\./)
  assert.match(invocation.prompt, /Do not delegate/)
  assert.match(invocation.prompt, /Fix the bug\./)
})

test('role/channel mismatch and unknown role fail without fallback', () => {
  const roles = loadRoleRegistry({ roles: [{ id: 'builder', channel: 'claude-code' }] })
  assert.throws(
    () => resolveRoleInvocation({ role: 'builder', channel: 'codex', prompt: 'x' }, roles),
    /requires channel "claude-code"/,
  )
  assert.throws(
    () => resolveRoleInvocation({ role: 'missing', prompt: 'x' }, roles),
    /unknown role "missing"/,
  )
  assert.throws(
    () => resolveRoleInvocation({ prompt: 'x' }, roles),
    /channel must be a non-empty string/,
  )
})

test('invalid and duplicate roles are rejected eagerly', () => {
  assert.throws(
    () => loadRoleRegistry({ roles: [{ id: 'bad role', channel: 'codex' }] }),
    /role id/,
  )
  assert.throws(
    () => loadRoleRegistry({
      roles: [
        { id: 'same', channel: 'codex' },
        { id: 'same', channel: 'claude-code' },
      ],
    }),
    /duplicate role id "same"/,
  )
})

test('rolesFile accepts an array and merges strictly with inline roles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-code-agent-roles-'))
  const file = path.join(dir, 'roles.json')
  try {
    fs.writeFileSync(file, JSON.stringify([{ id: 'from-file', channel: 'acp/opencode' }]))
    const roles = loadRoleRegistry({
      rolesFile: file,
      roles: [{ id: 'inline', channel: 'codex' }],
    })
    assert.deepEqual([...roles.keys()], ['inline', 'from-file'])
    assert.equal(roles.get('from-file').channel, 'acp/opencode')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
