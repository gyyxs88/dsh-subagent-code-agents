// This contract is generated from the checked-in Codex 0.147.0 schema
// fixture under ../protocol/codex-0.147.0. Keep the method switch explicit;
// a broad "approval" substring match would accept future or unrelated
// server requests with an unreviewed response shape.
export const CODEX_APP_SERVER_PROTOCOL_VERSION = '0.147.0'

const REQUIRED_APPROVAL_FIELDS = Object.freeze(['itemId', 'threadId', 'turnId', 'startedAtMs'])
const DECISIONS = new Set(['accept', 'acceptForSession', 'decline', 'cancel'])

export function parseApprovalRequest(method, params) {
  let kind
  switch (method) {
    case 'item/commandExecution/requestApproval': kind = 'command'; break
    case 'item/fileChange/requestApproval': kind = 'file-change'; break
    case 'item/permissions/requestApproval': kind = 'permissions'; break
    default: return undefined
  }
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error(`Codex ${method} params are invalid`)
  for (const field of REQUIRED_APPROVAL_FIELDS) {
    if (field === 'startedAtMs' ? !Number.isSafeInteger(params[field]) : typeof params[field] !== 'string' || params[field].length === 0) {
      throw new Error(`Codex ${method} params.${field} is invalid`)
    }
  }
  if (kind === 'command' && params.command !== undefined && params.command !== null && typeof params.command !== 'string') throw new Error('Codex command approval command is invalid')
  return { kind, params: structuredClone(params) }
}

function decisionFromHandler(kind, decision) {
  if (decision && typeof decision === 'object' && decision.codexResponse !== undefined) return decision.codexResponse
  if (decision?.behavior === 'allow' || decision?.approved === true) return kind === 'permissions' ? undefined : 'accept'
  if (decision?.behavior === 'deny' || decision?.approved === false) return kind === 'permissions' ? undefined : 'decline'
  if (typeof decision === 'string' && DECISIONS.has(decision)) return kind === 'permissions' ? undefined : decision
  return undefined
}

export function approvalResponse(method, params, decision) {
  const request = parseApprovalRequest(method, params)
  if (!request) throw new Error(`Codex server request ${method} is not a supported approval request`)
  const kind = request.kind
  if (kind === 'permissions') {
    const response = decision?.codexResponse ?? decision
    if (!response || typeof response !== 'object' || Array.isArray(response) || !response.permissions || typeof response.permissions !== 'object') {
      throw new Error('Codex permissions approval requires a typed permissions response')
    }
    const permissions = response.permissions
    if (Object.keys(permissions).some((key) => !['fileSystem', 'network'].includes(key))) throw new Error('Codex permissions response contains an unknown field')
    return { permissions, ...(response.scope === 'session' || response.scope === 'turn' ? { scope: response.scope } : {}), ...(typeof response.strictAutoReview === 'boolean' ? { strictAutoReview: response.strictAutoReview } : {}) }
  }
  const value = decisionFromHandler(kind, decision)
  if (!value || !DECISIONS.has(value)) throw new Error(`Codex ${method} approval response is invalid`)
  return { decision: value }
}

export function assertThreadStartResponse(result) {
  if (!result || typeof result !== 'object' || !result.thread || typeof result.thread !== 'object' || typeof result.thread.id !== 'string' || result.thread.id.length === 0) throw new Error('Codex thread/start response is invalid')
  return result
}

export function assertTurnStartResponse(result) {
  if (!result || typeof result !== 'object' || !result.turn || typeof result.turn !== 'object' || typeof result.turn.id !== 'string' || result.turn.id.length === 0) throw new Error('Codex turn/start response is invalid')
  return result
}
