/** Strict, optional role profiles for subagent_code. */

import fs from 'node:fs'
import path from 'node:path'

const PREFIX = 'dsh-subagent-code-agents roles'
const MAX_FILE_BYTES = 256 * 1024
const MAX_ROLES = 100
const ROLE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/u

function boundedString(value, field, { required = false, max = 16_000 } = {}) {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${PREFIX}: ${field} must be a non-empty string`)
  }
  const text = value.trim()
  if (text.length > max || /\0/u.test(text)) {
    throw new Error(`${PREFIX}: ${field} is invalid or too long`)
  }
  return text
}

export function normalizeRole(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${PREFIX}: each role must be an object`)
  }
  const id = boundedString(raw.id, 'id', { required: true, max: 64 }).toLowerCase()
  if (!ROLE_ID_RE.test(id)) {
    throw new Error(`${PREFIX}: role id "${id}" must match [a-z0-9][a-z0-9._-]{0,63}`)
  }
  const channel = boundedString(raw.channel, `role "${id}" channel`, { required: true, max: 100 })
  if (raw.allowDelegation !== undefined && typeof raw.allowDelegation !== 'boolean') {
    throw new Error(`${PREFIX}: role "${id}" allowDelegation must be boolean`)
  }
  return Object.freeze({
    id,
    channel,
    model: boundedString(raw.model, `role "${id}" model`, { max: 200 }),
    reasoningEffort: boundedString(
      raw.reasoningEffort ?? raw.reasoning_effort,
      `role "${id}" reasoningEffort`,
      { max: 100 },
    ),
    instructions: boundedString(raw.instructions, `role "${id}" instructions`, { max: 16_000 }),
    allowDelegation: raw.allowDelegation !== false,
  })
}

function readRoleFile(file) {
  const absolute = path.resolve(file)
  const stat = fs.statSync(absolute)
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
    throw new Error(`${PREFIX}: rolesFile must be a JSON file no larger than ${MAX_FILE_BYTES} bytes`)
  }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'))
  } catch (error) {
    throw new Error(`${PREFIX}: cannot parse rolesFile ${absolute}: ${String(error?.message ?? error)}`)
  }
  const roles = Array.isArray(parsed) ? parsed : parsed?.roles
  if (!Array.isArray(roles)) {
    throw new Error(`${PREFIX}: rolesFile must contain an array or { "roles": [...] }`)
  }
  return roles
}

export function loadRoleRegistry(config = {}) {
  const entries = []
  if (config.roles !== undefined) {
    if (!Array.isArray(config.roles)) throw new Error(`${PREFIX}: roles must be an array`)
    entries.push(...config.roles)
  }
  if (config.rolesFile !== undefined) {
    const file = boundedString(config.rolesFile, 'rolesFile', { required: true, max: 4096 })
    entries.push(...readRoleFile(file))
  }
  if (entries.length > MAX_ROLES) throw new Error(`${PREFIX}: at most ${MAX_ROLES} roles are allowed`)
  const roles = new Map()
  for (const entry of entries) {
    const role = normalizeRole(entry)
    if (roles.has(role.id)) throw new Error(`${PREFIX}: duplicate role id "${role.id}"`)
    roles.set(role.id, role)
  }
  return roles
}

function rolePrompt(role, prompt) {
  const instructions = []
  if (role.instructions) instructions.push(role.instructions)
  if (!role.allowDelegation) {
    instructions.push('Do not delegate this task to another agent or subagent; perform the work yourself.')
  }
  if (instructions.length === 0) return prompt
  return `[Configured role: ${role.id}]\n${instructions.join('\n\n')}\n[End configured role]\n\n${prompt}`
}

/** Resolve a tool invocation. Explicit model/effort override role defaults. */
export function resolveRoleInvocation(args, roles) {
  const roleId = args.role === undefined
    ? undefined
    : boundedString(args.role, 'role', { required: true, max: 64 }).toLowerCase()
  if (roleId === undefined) {
    const channel = boundedString(args.channel, 'channel', { required: true, max: 100 })
    return {
      channel,
      role: undefined,
      model: args.model,
      reasoningEffort: args.reasoning_effort,
      prompt: args.prompt,
    }
  }
  const role = roles.get(roleId)
  if (role === undefined) {
    throw new Error(`${PREFIX}: unknown role "${roleId}"`)
  }
  if (args.channel !== undefined && args.channel !== role.channel) {
    throw new Error(
      `${PREFIX}: role "${roleId}" requires channel "${role.channel}", not "${args.channel}"`,
    )
  }
  return {
    channel: role.channel,
    role: role.id,
    model: args.model ?? role.model,
    reasoningEffort: args.reasoning_effort ?? role.reasoningEffort,
    prompt: rolePrompt(role, args.prompt),
  }
}
