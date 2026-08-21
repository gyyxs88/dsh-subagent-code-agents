import assert from 'node:assert/strict'
import test from 'node:test'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createClaudeCanUseTool } from '../../channel-claude-code/lib/index.js'
const sessionControlRoot = process.env.DSH_SESSION_CONTROL_ROOT
if (sessionControlRoot !== undefined && !isAbsolute(sessionControlRoot)) throw new Error('DSH_SESSION_CONTROL_ROOT must be an absolute path')
const { createSessionControlExecutionPolicyServices } = sessionControlRoot === undefined
  ? { createSessionControlExecutionPolicyServices: undefined }
  : await import(pathToFileURL(join(sessionControlRoot, 'lib', 'execution-policy-service.js')).href)

test('formal Session Control resolver reaches the Claude channel callback with the target child identity', { skip: sessionControlRoot === undefined }, async () => {
  const target = { id: 'target-child', status: 'idle', session: { header: { cwd: 'C:/workspace' }, events: [] } }
  const approvals = []
  const ctx = {
    agents: { get(id) { return id === target.id ? target : undefined } },
    permissionPresets: { current() { return 'workspace-write' } },
    approval: { async request(request) { approvals.push(request); return 'allowed-once' } },
  }
  const { resolver } = createSessionControlExecutionPolicyServices({ ctx, approvalTimeoutMs: 1000 })
  const resolved = await resolver({ exec: { agent: target } })
  const policy = { ...resolved, provenance: { authority: 'dsh-session-control', verified: true } }
  const canUseTool = createClaudeCanUseTool(policy)
  const decision = await canUseTool('Write', { file_path: 'not forwarded' }, { toolUseID: 'tool-1' })
  assert.deepEqual(decision, { behavior: 'allow' })
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].agent, target)
  assert.equal(approvals[0].toolName, 'coding-agent/claude/Write')
})
