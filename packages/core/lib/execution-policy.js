const PERMISSIONS = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])
const APPROVAL_OWNERS = Object.freeze(['target-session', 'full-access-controller'])
const PROVENANCE_AUTHORITIES = Object.freeze(['dsh-session-control', 'unverified-local'])
export const TRUSTED_EXECUTION_POLICY = Symbol.for('dsh.trusted-execution-policy')

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
  const approvalMode = value.approvalMode ?? (permission === 'danger-full-access' ? 'controller-verified' : 'target-session')
  if (permission === 'danger-full-access' && approvalMode !== 'controller-verified') invalid('Full Access requires controller-verified approval mode')
  if (permission !== 'danger-full-access' && approvalMode !== 'target-session') invalid('restricted modes require target-session approval mode')
  const provenanceValue = value.provenance && typeof value.provenance === 'object' ? value.provenance : {}
  const provenance = {
    authority: provenanceValue.authority ?? 'unverified-local',
    verified: provenanceValue.verified === true,
  }
  if (!PROVENANCE_AUTHORITIES.includes(provenance.authority)) invalid('execution policy provenance authority is invalid')
  if (provenance.verified && provenance.authority !== 'dsh-session-control') invalid('verified execution policy provenance must come from DSH Session Control')
  return {
    permission,
    approvalOwner,
    approvalMode,
    workspaceRoot,
    provenance,
    ...(typeof value.sourceSessionId === 'string' ? { sourceSessionId: value.sourceSessionId } : {}),
    ...(typeof value.targetSessionId === 'string' ? { targetSessionId: value.targetSessionId } : {}),
    ...(typeof value.operationId === 'string' ? { operationId: value.operationId } : {}),
    ...(typeof value.requestFingerprint === 'string' ? { requestFingerprint: value.requestFingerprint } : {}),
    ...(typeof value.approvalHandler === 'function' ? { approvalHandler: value.approvalHandler } : {}),
  }
}

export function executionPolicyFor(request, env, cwd) {
  const source = env?.executionPolicy ?? request?.[TRUSTED_EXECUTION_POLICY]
  if (source === undefined) invalid('channel launch requires an execution policy from the target DSH Session', 'EXECUTION_POLICY_SOURCE_REQUIRED')
  const authoritative = normalizeExecutionPolicy(source, { cwd })
  if (request?.executionPolicy !== undefined) {
    const requested = normalizeExecutionPolicy(request.executionPolicy, { cwd })
    const keys = ['permission', 'approvalOwner', 'approvalMode', 'workspaceRoot', 'sourceSessionId', 'targetSessionId', 'operationId']
    if (keys.some((key) => authoritative[key] !== requested[key])) invalid('request executionPolicy cannot override the target Session policy', 'EXECUTION_POLICY_OVERRIDE')
  }
  return assertTrustedExecutionPolicy(authoritative)
}

export function assertTrustedExecutionPolicy(policy, { permission } = {}) {
  const normalized = normalizeExecutionPolicy(policy, { cwd: policy?.workspaceRoot })
  if (permission !== undefined && normalized.permission !== permission) invalid('execution policy permission changed at launch', 'EXECUTION_POLICY_OVERRIDE')
  if (!normalized.provenance.verified || normalized.provenance.authority !== 'dsh-session-control') {
    invalid('channel launch requires a policy resolved by the target DSH Session', 'EXECUTION_POLICY_UNTRUSTED')
  }
  return normalized
}

/**
 * Adapt the formal DSH Session Control verifier port to the plugin's async
 * policy hook. The port is injected by the Host; the plugin never constructs
 * a verified policy from request data.
 */
export function createSessionControlExecutionPolicyVerifier({ service, sourceHostId, targetHostId } = {}) {
  if (!service || typeof service.verifyTargetSessionPolicy !== 'function') {
    const error = new Error('formal DSH Session Control policy verifier is required')
    error.code = 'EXECUTION_POLICY_VERIFIER_REQUIRED'
    throw error
  }
  return {
    async verifyTargetSessionPolicy({ policy } = {}) {
      const result = await service.verifyTargetSessionPolicy({
        targetSessionId: policy?.targetSessionId,
        permission: policy?.permission,
        workspaceRoot: policy?.workspaceRoot,
      }, {
        sourceHostId,
        sourceSessionId: policy?.sourceSessionId,
        targetHostId,
      })
      if (!result || result.verified !== true || result.authority !== 'dsh-session-control') {
        const error = new Error('formal DSH Session Control did not verify the target Session policy')
        error.code = 'EXECUTION_POLICY_UNTRUSTED'
        throw error
      }
      return result
    },
  }
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
export const EXECUTION_POLICY_PROVENANCE_AUTHORITIES = PROVENANCE_AUTHORITIES
