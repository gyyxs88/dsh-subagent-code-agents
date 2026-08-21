import assert from 'node:assert/strict'
import test from 'node:test'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createSessionControlExecutionPolicyVerifier } from '../lib/index.js'

const sessionControlRoot = process.env.DSH_SESSION_CONTROL_ROOT
const remoteControlRoot = process.env.DSH_REMOTE_CONTROL_ROOT
if (sessionControlRoot !== undefined && !isAbsolute(sessionControlRoot)) throw new Error('DSH_SESSION_CONTROL_ROOT must be an absolute path')
if (remoteControlRoot !== undefined && !isAbsolute(remoteControlRoot)) throw new Error('DSH_REMOTE_CONTROL_ROOT must be an absolute path')
const { createRemoteProjectPort } = sessionControlRoot === undefined
  ? { createRemoteProjectPort: undefined }
  : await import(pathToFileURL(join(sessionControlRoot, 'lib', 'remote-project-bridge.js')).href)
const { DshSessionControlPort } = remoteControlRoot === undefined
  ? { DshSessionControlPort: undefined }
  : await import(pathToFileURL(join(remoteControlRoot, 'lib', 'session-control-port.mjs')).href)

test('subagent policy adapter consumes the formal dsh-session-control service contract', { skip: sessionControlRoot === undefined || remoteControlRoot === undefined }, async () => {
  const controller = { id: 'remote-controller', session: { header: { cwd: '/srv/controller' }, events: [] } }
  const target = { id: 'remote-target', status: 'idle', session: { header: { cwd: '/srv/project' }, events: [] } }
  const formalService = createRemoteProjectPort({
    hostId: 'remote-host',
    sourceAllowlist: [{ sourceHostId: 'local-host', sourceSessionId: 'local-controller', controllerSessionId: 'remote-controller' }],
    api: { async openProject() { throw new Error('not used') } },
    ctx: {
      agents: { get(id) { return id === controller.id ? controller : id === target.id ? target : undefined } },
      permissionPresets: { current() { return 'workspace-write' } },
    },
  })
  const port = new DshSessionControlPort(formalService)
  const verifier = createSessionControlExecutionPolicyVerifier({ service: port, sourceHostId: 'local-host', targetHostId: 'remote-host' })
  const result = await verifier.verifyTargetSessionPolicy({
    policy: { permission: 'workspace-write', workspaceRoot: '/srv/project', sourceSessionId: 'local-controller', targetSessionId: 'remote-target' },
  })
  assert.equal(result.verified, true)
  assert.equal(result.authority, 'dsh-session-control')
  assert.equal(result.targetSessionId, 'remote-target')
  await assert.rejects(verifier.verifyTargetSessionPolicy({
    policy: { permission: 'workspace-write', workspaceRoot: '/srv/other', sourceSessionId: 'local-controller', targetSessionId: 'remote-target' },
  }), /workspace root|execution policy/)
})
