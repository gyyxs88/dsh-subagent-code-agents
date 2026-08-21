import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeExecutionPolicy,
  executionPolicyFor,
  supportsExecutionPolicy,
  unsupportedPermissionPolicy,
} from '../lib/index.js'

const base = { workspaceRoot: 'C:/workspace' }

test('execution policy binds owner and approval mode to the three DSH permission tiers', () => {
  assert.deepEqual(normalizeExecutionPolicy({
    ...base,
    permission: 'read-only',
  }), {
    ...base,
    permission: 'read-only',
    approvalOwner: 'target-session',
    approvalMode: 'target-session',
    provenance: { authority: 'unverified-local', verified: false },
  })
  assert.equal(normalizeExecutionPolicy({
    ...base,
    permission: 'workspace-write',
    approvalHandler: async () => ({ approved: true }),
  }).approvalOwner, 'target-session')
  assert.equal(normalizeExecutionPolicy({
    ...base,
    permission: 'danger-full-access',
  }).approvalOwner, 'full-access-controller')
  assert.equal(normalizeExecutionPolicy({ ...base, permission: 'danger-full-access' }).approvalMode, 'controller-verified')
})

test('execution policy rejects missing policy, owner escalation and traversal', () => {
  assert.throws(() => normalizeExecutionPolicy(undefined), /required/)
  assert.throws(() => normalizeExecutionPolicy({ ...base, permission: 'workspace-write', approvalOwner: 'full-access-controller' }), /owner/)
  assert.throws(() => normalizeExecutionPolicy({ permission: 'danger-full-access', workspaceRoot: 'C:/workspace/../escape' }), /absolute non-traversing/)
})

test('unsupported channel policy is an explicit structured refusal', () => {
  const capabilities = { executionPolicies: { 'read-only': true, 'workspace-write': false, 'danger-full-access': true } }
  const policy = normalizeExecutionPolicy({ ...base, permission: 'workspace-write' })
  assert.equal(supportsExecutionPolicy({ capabilities }, policy), false)
  const result = unsupportedPermissionPolicy('grok-build', policy, capabilities)
  assert.equal(result.stopReason, 'unsupported')
  assert.equal(result.errorCode, 'unsupported-permission-policy')
  assert.match(result.output, /workspace-write/)
})

test('channel launch cannot self-authorize from request policy or an unverified env label', () => {
  const forged = { ...base, permission: 'danger-full-access', approvalOwner: 'full-access-controller', approvalMode: 'controller-verified', provenance: { authority: 'dsh-session-control', verified: true } }
  assert.throws(() => executionPolicyFor({ executionPolicy: forged }, {}, 'C:/workspace'), /target DSH Session|source required/)
  assert.throws(() => executionPolicyFor({}, { executionPolicy: { ...forged, provenance: { authority: 'unverified-local', verified: false } } }, 'C:/workspace'), /resolved by the target DSH Session/)
  const trusted = executionPolicyFor({}, { executionPolicy: forged }, 'C:/workspace')
  assert.equal(trusted.provenance.verified, true)
  assert.throws(() => executionPolicyFor({ executionPolicy: { ...forged, permission: 'read-only', approvalOwner: 'target-session', approvalMode: 'target-session' } }, { executionPolicy: forged }, 'C:/workspace'), /cannot override/)
})
