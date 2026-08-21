const PERMISSIONS = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])
const APPROVAL_OWNERS = Object.freeze(['target-session', 'full-access-controller'])

function invalid(message, code = 'UNSUPPORTED_PERMISSION_POLICY') {
  const error = new Error(message)
  error.code = code
  throw error
}

function absoluteWorkspaceRoot(value, fallback) {
  const root = value ?? fallback
  if (typeof root !== 'string' || root.length === 0 || !isAbsolutePath(root) || root.split(/[\\/]/u).includes('..') || /[\0\r\n]/u.test(root)) invalid('execution policy workspaceRoot must be an absolute non-traversing path')
  return root
}

function isAbsolutePath(value) {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value)
}

export function normalizeExecutionPolicy(value, { cwd } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('channel execution policy is required')
  const permission = value.permission
  if (!PERMISSIONS.includes(permission)) invalid('channel execution policy permission is invalid')
  const expectedOwner = permission === 'danger-full-access' ? 'full-access-controller' : 'target-session'
  const approvalOwner = value.approvalOwner ?? expectedOwner
  if (!APPROVAL_OWNERS.includes(approvalOwner) || approvalOwner !== expectedOwner) invalid('channel execution policy approval owner does not match permission')
  const workspaceRoot = absoluteWorkspaceRoot(value.workspaceRoot, cwd)
  const approvalMode = value.approvalMode ?? (permission === 'danger-full-access' ? 'controller-fingerprint' : 'target-session')
  if (permission === 'danger-full-access' && approvalMode !== 'controller-fingerprint') invalid('Full Access requires controller-fingerprint approval mode')
  if (permission !== 'danger-full-access' && approvalMode !== 'target-session') invalid('restricted modes require target-session approval mode')
  return {
    permission,
    approvalOwner,
    approvalMode,
    workspaceRoot,
    ...(typeof value.sourceSessionId === 'string' ? { sourceSessionId: value.sourceSessionId } : {}),
    ...(typeof value.targetSessionId === 'string' ? { targetSessionId: value.targetSessionId } : {}),
    ...(typeof value.operationId === 'string' ? { operationId: value.operationId } : {}),
    ...(typeof value.requestFingerprint === 'string' ? { requestFingerprint: value.requestFingerprint } : {}),
    ...(typeof value.approvalHandler === 'function' ? { approvalHandler: value.approvalHandler } : {}),
  }
}

export function executionPolicyFor(request, env, cwd) {
  return normalizeExecutionPolicy(request?.executionPolicy ?? env?.executionPolicy, { cwd })
}

export function supportsExecutionPolicy(channel, policy) {
  return channel?.capabilities?.executionPolicies?.[policy.permission] === true
}

export function unsupportedPermissionPolicy(channelId, policy, capabilities, detail = 'channel cannot satisfy the requested DSH permission policy') {
  return {
    channel: channelId,
    runId: `unsupported-permission-${Date.now().toString(36)}`,
    stopReason: 'unsupported',
    output: `${detail}: ${policy?.permission ?? 'unknown'}`,
    errorCode: 'unsupported-permission-policy',
    delivery: 'refused',
    mayBeConcurrent: false,
    capabilities,
  }
}

export const EXECUTION_PERMISSIONS = PERMISSIONS
export const EXECUTION_APPROVAL_OWNERS = APPROVAL_OWNERS
