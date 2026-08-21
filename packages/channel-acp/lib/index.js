/**
 * Generic Agent Client Protocol (ACP) channel.
 *
 * Each configured instance owns a stable `acp/<name>` channel id and launches
 * ACP agent processes over newline-delimited JSON-RPC 2.0. It implements the
 * stable v1 baseline plus runtime-negotiated session/list, load replay,
 * session/resume, session/close and session config options. Optional methods
 * return explicit unsupported when the configured agent omits its capability.
 */

import { StringDecoder } from 'node:string_decoder'
import { emptyCapabilities, executionPolicyFor, registry, supportsExecutionPolicy, tryRegister, unsupported, unsupportedPermissionPolicy } from '@dsh-subagent-code-agents/core'

const PREFIX = 'channel-acp'
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000
const MAX_LINE_BUFFER_BYTES = 4 * 1024 * 1024
const MAX_PENDING_REQUESTS = 128
const MAX_HISTORY_CHARS = 12_000
const MAX_HISTORY_TURNS = 20
const MAX_SESSION_PAGES = 100
const TRUNC_MARKER = '…[truncated]'
const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/u

export class AcpProtocolError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'AcpProtocolError'
    this.code = code
    this.detail = detail
  }
}

export function normalizeAcpChannelId(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${PREFIX}: id is required`)
  }
  const raw = value.trim().toLowerCase()
  const name = raw.startsWith('acp/') ? raw.slice(4) : raw
  if (!CHANNEL_NAME_RE.test(name)) {
    throw new Error(`${PREFIX}: id must match acp/[a-z0-9][a-z0-9._-]{0,63}`)
  }
  return `acp/${name}`
}

function normalizeCommand(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${PREFIX}: command is required`)
  }
  const command = value.trim()
  if (command.length > 1024 || /[\0\r\n]/u.test(command)) {
    throw new Error(`${PREFIX}: command contains invalid characters`)
  }
  if (/\.(?:cmd|ps1|bat)$/iu.test(command)) {
    throw new Error(`${PREFIX}: command must be a real executable, not a shell shim`)
  }
  return command
}

function normalizeArgs(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error(`${PREFIX}: args must be an array with at most 128 entries`)
  }
  return value.map((arg) => {
    if (typeof arg !== 'string' || arg.length > 8192 || /[\0\r\n]/u.test(arg)) {
      throw new Error(`${PREFIX}: args must contain bounded strings without control characters`)
    }
    return arg
  })
}

function normalizeEnv(value) {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${PREFIX}: env must be an object`)
  }
  const out = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof raw !== 'string' || /[\0]/u.test(raw)) {
      throw new Error(`${PREFIX}: env contains an invalid entry`)
    }
    out[key] = raw
  }
  return out
}

function acpCapabilities(executionPolicies = {}) {
  return {
    ...emptyCapabilities(),
    run: true,
    resume: true,
    listSessions: true,
    readSession: true,
    managedSession: true,
    cancel: true,
    streaming: false,
    // These are negotiated per session through configOptions. The methods are
    // available, but return explicit unsupported when the agent omits them.
    modelOverride: true,
    effortOverride: true,
    sandboxBypassGuaranteed: false,
    executionPolicies: { 'read-only': executionPolicies['read-only'] === true, 'workspace-write': executionPolicies['workspace-write'] === true, 'danger-full-access': executionPolicies['danger-full-access'] === true },
  }
}

function normalizeTimeout(value) {
  if (value === undefined) return DEFAULT_REQUEST_TIMEOUT_MS
  if (!Number.isInteger(value) || value < 1_000 || value > 10 * 60_000) {
    throw new Error(`${PREFIX}: requestTimeoutMs must be an integer between 1000 and 600000`)
  }
  return value
}

async function resolveCommand(env, command, commandEnv, runtimeRequirement) {
  if (command.includes('/') || command.includes('\\')) {
    return env.path.isAbsolute(command) ? command : env.path.resolve(command)
  }
  if (env.runtimeManager?.resolveExecutable) {
    const requirement = runtimeRequirement ?? env.runtimeRequirement ?? { id: `acp/${command}`, version: env.runtimeVersion, executablePath: command }
    const resolved = await env.runtimeManager.resolveExecutable(requirement, { sourceSessionId: env.executionPolicy?.sourceSessionId, targetSessionId: env.executionPolicy?.targetSessionId })
    if (typeof resolved?.executable === 'string' && env.path.isAbsolute(resolved.executable)) return resolved.executable
  }
  throw new Error(`${PREFIX}: runtime manager must provide an absolute ACP executable; PATH resolution is disabled`)
}

export class AcpClient {
  constructor({ handle, requestTimeoutMs, logger, approvalHandler }) {
    if (!handle?.stdin || !handle?.stdout || typeof handle.done?.then !== 'function') {
      throw new AcpProtocolError(-32000, 'ACP spawn returned an invalid process handle')
    }
    this.handle = handle
    this.requestTimeoutMs = requestTimeoutMs
    this.logger = logger ?? { info() {}, warn() {}, error() {} }
    this.approvalHandler = approvalHandler
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    this.decoder = new StringDecoder('utf8')
    this.lineBuffer = ''
    this.closed = false
    handle.stdout.on('data', (chunk) => this.onData(chunk))
    handle.done.then(
      (outcome) => this.onExit(outcome?.exitCode),
      () => this.onExit(undefined),
    )
  }

  onNotification(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  write(message) {
    if (this.closed) throw new AcpProtocolError(-32000, 'ACP process is closed')
    this.handle.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new AcpProtocolError(-32000, 'ACP process is closed'))
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new AcpProtocolError(-32001, 'ACP has too many in-flight requests'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new AcpProtocolError(-32001, `ACP request timed out: ${method}`))
      }, this.requestTimeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      try {
        this.write({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  notify(method, params) {
    try {
      this.write({ method, params })
    } catch {}
  }

  onData(chunk) {
    this.lineBuffer += this.decoder.write(chunk)
    if (Buffer.byteLength(this.lineBuffer) > MAX_LINE_BUFFER_BYTES) {
      this.logger.warn?.('ACP line buffer exceeded limit; terminating process')
      this.handle.terminate?.()
      return
    }
    let index
    while ((index = this.lineBuffer.indexOf('\n')) >= 0) {
      const line = this.lineBuffer.slice(0, index).trim()
      this.lineBuffer = this.lineBuffer.slice(index + 1)
      if (line) this.onLine(line)
    }
  }

  onLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.logger.warn?.('ACP ignored a non-JSON line')
      return
    }
    if (!message || typeof message !== 'object') return
    const hasId = typeof message.id === 'number' || typeof message.id === 'string'
    const hasMethod = typeof message.method === 'string'
    if (hasId && hasMethod) {
      if (message.method === 'session/request_permission' && typeof this.approvalHandler === 'function') {
        Promise.resolve(this.approvalHandler({ channel: 'acp', method: message.method, params: message.params }))
          .then((result) => this.notifyResponse(message.id, { result }))
          .catch(() => this.notifyResponse(message.id, { error: { code: -32000, message: 'target-session approval was not granted' } }))
      } else {
        this.notifyResponse(message.id, { error: { code: -32601, message: `channel-acp does not support server request ${message.method}` } })
      }
      return
    }
    if (hasId) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error !== undefined) {
        pending.reject(new AcpProtocolError(
          message.error?.code ?? -32603,
          message.error?.message ?? `ACP request failed: ${pending.method}`,
          message.error,
        ))
      } else if ('result' in message) {
        pending.resolve(message.result)
      } else {
        pending.reject(new AcpProtocolError(-32603, 'ACP response is missing result/error'))
      }
      return
    }
    if (hasMethod) {
      for (const listener of this.listeners) {
        try {
          listener(message.method, message.params)
        } catch {}
      }
    }
  }

  setApprovalHandler(handler) {
    this.approvalHandler = typeof handler === 'function' ? handler : undefined
  }

  notifyResponse(id, body) {
    try {
      this.write({ id, ...body })
    } catch {}
  }

  onExit(code) {
    if (this.closed) return
    this.closed = true
    const error = new AcpProtocolError(-32000, `ACP process exited (code ${code})`)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  async dispose() {
    if (!this.closed) {
      try { this.handle.stdin.end?.() } catch {}
      this.handle.terminate?.()
    }
    try { await this.handle.done } catch {}
    this.onExit(undefined)
  }
}

async function openAcpConnection({ options, env, signal }) {
  const executable = await resolveCommand(env, options.command, options.env, options.runtimeRequirement)
  const handle = env.subprocess.spawn({
    argv: [executable, ...options.args],
    cwd: options.cwd ?? env.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    stdio: {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: { maxBytes: 65536 },
    },
    graceMs: 2000,
    ...(signal === undefined ? {} : { signal }),
  })
  const client = new AcpClient({
    handle,
    requestTimeoutMs: options.requestTimeoutMs,
    logger: env.logger,
    approvalHandler: options.approvalHandler,
  })
  let initialized
  try {
    initialized = await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        session: { configOptions: { boolean: {} } },
      },
      clientInfo: { name: 'dsh-subagent-code-agents', version: '0.1.0' },
    })
    if (initialized?.protocolVersion !== undefined && initialized.protocolVersion !== 1) {
      throw new AcpProtocolError(-32002, `ACP agent selected unsupported protocol version ${initialized.protocolVersion}`)
    }
  } catch (error) {
    await client.dispose().catch(() => {})
    throw error
  }
  return { client, handle, initialized }
}

function configOptionFor(configOptions, capability) {
  if (!Array.isArray(configOptions)) return undefined
  if (capability === 'modelOverride') {
    return configOptions.find((option) => option?.category === 'model' && option.type === 'select')
  }
  return configOptions.find((option) =>
    option?.type === 'select' && (
      option.category === 'thought_level' ||
      (option.category === 'model_config' && /(?:effort|reason|thought)/iu.test(`${option.id ?? ''} ${option.name ?? ''}`))
    ),
  )
}

async function applyConfigOverrides({ client, sessionId, configOptions, request }) {
  let current = Array.isArray(configOptions) ? configOptions : []
  for (const [capability, requested] of [
    ['modelOverride', request.model],
    ['effortOverride', request.reasoningEffort],
  ]) {
    if (requested === undefined) continue
    if (typeof requested !== 'string' || requested.trim() === '') {
      return { ok: false, capability, message: `${capability} must be a non-empty string` }
    }
    const value = requested.trim()
    const option = configOptionFor(current, capability)
    if (option === undefined) {
      return { ok: false, capability, message: `ACP agent does not advertise a ${capability} config option` }
    }
    const choices = Array.isArray(option.options) ? option.options : []
    if (!choices.some((choice) => choice?.value === value)) {
      return { ok: false, capability, message: `ACP agent does not offer ${capability} value "${value}"` }
    }
    if (option.currentValue === value) continue
    const updated = await client.request('session/set_config_option', {
      sessionId,
      configId: option.id,
      value,
    })
    current = Array.isArray(updated?.configOptions) ? updated.configOptions : current.map((item) =>
      item?.id === option.id ? { ...item, currentValue: value } : item,
    )
  }
  return { ok: true, configOptions: current }
}

async function setupAcpSession({ client, initialized, cwd, resumeSessionId }) {
  if (resumeSessionId === undefined) {
    const created = await client.request('session/new', { cwd, mcpServers: [] })
    if (typeof created?.sessionId !== 'string' || created.sessionId.length === 0) {
      throw new AcpProtocolError(-32603, 'ACP session/new returned no sessionId')
    }
    return { sessionId: created.sessionId, setup: created }
  }
  if (initialized?.agentCapabilities?.loadSession === true) {
    const loaded = await client.request('session/load', { sessionId: resumeSessionId, cwd, mcpServers: [] })
    return { sessionId: resumeSessionId, setup: loaded }
  }
  if (initialized?.agentCapabilities?.sessionCapabilities?.resume != null) {
    const resumed = await client.request('session/resume', { sessionId: resumeSessionId, cwd, mcpServers: [] })
    return { sessionId: resumeSessionId, setup: resumed }
  }
  return { unsupported: true, sessionId: resumeSessionId }
}

function extractReplayUpdate(method, params, sessionId) {
  if (method !== 'session/update' || params?.sessionId !== sessionId) return undefined
  const update = params.update
  const role = update?.sessionUpdate === 'user_message_chunk'
    ? 'user'
    : update?.sessionUpdate === 'agent_message_chunk'
      ? 'assistant'
      : undefined
  if (role === undefined || update.content?.type !== 'text' || typeof update.content.text !== 'string') return undefined
  return { role, text: update.content.text, messageId: typeof update.messageId === 'string' ? update.messageId : undefined }
}

function boundReplayMessages(messages, { maxTurns = MAX_HISTORY_TURNS, maxChars = MAX_HISTORY_CHARS } = {}) {
  const turnLimit = Math.max(1, Math.min(20, Number.isFinite(maxTurns) ? Math.trunc(maxTurns) : MAX_HISTORY_TURNS))
  const charLimit = Math.max(1, Math.min(MAX_HISTORY_CHARS, Number.isFinite(maxChars) ? Math.trunc(maxChars) : MAX_HISTORY_CHARS))
  const candidates = messages.slice(-turnLimit)
  const turns = []
  let used = 0
  let charTruncated = false
  for (let index = candidates.length - 1; index >= 0; index--) {
    const entry = candidates[index]
    const remaining = charLimit - used
    if (remaining <= 0) {
      charTruncated = true
      break
    }
    let text = entry.text
    if (text.length > remaining) {
      charTruncated = true
      text = remaining <= TRUNC_MARKER.length ? text.slice(0, remaining) : text.slice(0, remaining - TRUNC_MARKER.length) + TRUNC_MARKER
    }
    turns.unshift({ role: entry.role, text, chars: text.length, ...(entry.messageId ? { id: entry.messageId } : {}) })
    used += text.length
    if (charTruncated) break
  }
  return { turns, chars: used, truncated: messages.length > turnLimit || charTruncated }
}

function extractTextUpdate(method, params, sessionId) {
  if (method !== 'session/update' || params?.sessionId !== sessionId) return undefined
  const update = params.update
  if (update?.sessionUpdate !== 'agent_message_chunk') return undefined
  return update.content?.type === 'text' && typeof update.content.text === 'string'
    ? update.content.text
    : undefined
}

function stopReasonForAcp(value) {
  if (value === 'end_turn' || value === 'completed') return 'completed'
  if (value === 'cancelled') return 'aborted'
  if (value === 'refusal') return 'refused'
  return 'error'
}

export async function runAcpProcess({ options, env, request, resumeSessionId }) {
  const cwd = request.cwd ?? request.parentCwd ?? options.cwd ?? env.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new Error(`${PREFIX}: no working directory; set cwd or parentCwd`)
  }
  const prompt = typeof request.prompt === 'string' ? request.prompt : ''
  if (!prompt.trim()) throw new Error(`${PREFIX}: prompt is required`)
  const policy = executionPolicyFor(request, env, cwd)
  const capabilities = acpCapabilities(options.executionPolicies)
  if (!supportsExecutionPolicy({ capabilities }, policy)) return unsupportedPermissionPolicy(options.id, policy, capabilities, 'ACP agent did not declare the requested permission policy')
  const { client, handle, initialized } = await openAcpConnection({ options: { ...options, cwd, approvalHandler: policy.approvalHandler }, env, signal: env.signal })
  let text = ''
  let sessionId = resumeSessionId
  let abortRequested = false
  let collectingPromptOutput = false
  const removeUpdate = client.onNotification((method, params) => {
    if (!collectingPromptOutput) return
    const chunk = extractTextUpdate(method, params, sessionId)
    if (chunk !== undefined) {
      text += chunk
      env.onUpdate?.({ type: 'text-delta', text: chunk })
    }
  })
  const onAbort = () => {
    abortRequested = true
    if (sessionId) client.notify('session/cancel', { sessionId })
    handle.terminate?.()
  }
  if (env.signal) {
    if (env.signal.aborted) onAbort()
    else env.signal.addEventListener('abort', onAbort, { once: true })
  }

  const base = {
    channel: options.id,
    runId: `acp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    capabilities,
  }
  try {
    const setup = await setupAcpSession({ client, initialized, cwd, resumeSessionId })
    if (setup.unsupported === true) {
      return {
        ...base,
        sessionId: resumeSessionId,
        stopReason: 'unsupported',
        output: `ACP agent for "${options.id}" advertises neither session/load nor session/resume`,
        delivery: 'refused',
        mayBeConcurrent: false,
      }
    }
    sessionId = setup.sessionId
    const overrides = await applyConfigOverrides({
      client,
      sessionId,
      configOptions: setup.setup?.configOptions,
      request,
    })
    if (!overrides.ok) {
      return {
        ...base,
        sessionId,
        stopReason: 'unsupported',
        output: overrides.message,
        delivery: 'refused',
        mayBeConcurrent: false,
      }
    }
    collectingPromptOutput = true
    const result = await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: prompt }],
    })
    return {
      ...base,
      sessionId,
      stopReason: stopReasonForAcp(result?.stopReason),
      output: text,
      ...(resumeSessionId === undefined ? {} : { delivery: 'resume_unmanaged', mayBeConcurrent: true }),
    }
  } catch (error) {
    if (abortRequested || env.signal?.aborted) {
      return { ...base, ...(sessionId ? { sessionId } : {}), stopReason: 'aborted', output: text }
    }
    let stderrTail = ''
    try { stderrTail = handle.collected?.stderr?.readFrom(0)?.text ?? '' } catch {}
    const diagnostic = String(error?.message ?? error)
    const stderr = stderrTail.trim() ? `\n\n[ACP stderr]\n${stderrTail.trim().slice(-4000)}` : ''
    return {
      ...base,
      ...(sessionId ? { sessionId } : {}),
      stopReason: 'error',
      output: `${text}${text ? '\n\n' : ''}[ACP error] ${diagnostic}${stderr}`,
    }
  } finally {
    removeUpdate()
    if (env.signal) env.signal.removeEventListener('abort', onAbort)
    await client.dispose()
  }
}

export async function listAcpSessions({ options, env, opts }) {
  if (opts.includeAll !== true && (typeof opts.cwd !== 'string' || opts.cwd.trim() === '')) {
    throw new Error(`${PREFIX}: listSessions requires cwd unless includeAll is true`)
  }
  const limit = Math.max(1, Math.min(100, Number.isFinite(opts.limit) ? Math.trunc(opts.limit) : 50))
  const connection = await openAcpConnection({ options, env, signal: env.signal })
  const { client, initialized } = connection
  try {
    if (initialized?.agentCapabilities?.sessionCapabilities?.list == null) {
      return unsupported(options.id, 'listSessions (agent omitted sessionCapabilities.list)', acpCapabilities())
    }
    const sessions = []
    let cursor
    let nextCursor
    let pages = 0
    do {
      const result = await client.request('session/list', {
        ...(opts.includeAll === true ? {} : { cwd: opts.cwd }),
        ...(cursor === undefined ? {} : { cursor }),
      })
      const rows = Array.isArray(result?.sessions) ? result.sessions : []
      for (const row of rows) {
        if (typeof row?.sessionId !== 'string' || row.sessionId.length === 0) continue
        sessions.push({
          id: row.sessionId,
          preview: typeof row.title === 'string' ? row.title.slice(0, 200) : undefined,
          cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
          source: options.id,
          status: 'stored',
          updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : undefined,
          delivery: 'external_or_idle',
          steerable: false,
        })
        if (sessions.length > limit) break
      }
      nextCursor = typeof result?.nextCursor === 'string' && result.nextCursor.length > 0 ? result.nextCursor : undefined
      if (sessions.length > limit || nextCursor === undefined) break
      if (nextCursor === cursor) throw new AcpProtocolError(-32603, 'ACP session/list repeated the same cursor')
      cursor = nextCursor
      pages += 1
    } while (pages < MAX_SESSION_PAGES)
    return {
      sessions: sessions.slice(0, limit),
      truncated: sessions.length > limit || nextCursor !== undefined,
    }
  } finally {
    await client.dispose()
  }
}

async function sessionCwdForRead({ client, initialized, sessionId, fallbackCwd }) {
  if (initialized?.agentCapabilities?.sessionCapabilities?.list == null) return fallbackCwd
  let cursor
  for (let page = 0; page < MAX_SESSION_PAGES; page++) {
    const result = await client.request('session/list', cursor === undefined ? {} : { cursor })
    const rows = Array.isArray(result?.sessions) ? result.sessions : []
    const found = rows.find((row) => row?.sessionId === sessionId)
    if (typeof found?.cwd === 'string' && found.cwd.length > 0) return found.cwd
    const next = typeof result?.nextCursor === 'string' && result.nextCursor.length > 0 ? result.nextCursor : undefined
    if (next === undefined) break
    if (next === cursor) throw new AcpProtocolError(-32603, 'ACP session/list repeated the same cursor')
    cursor = next
  }
  return fallbackCwd
}

export async function readAcpSession({ options, env, opts }) {
  if (typeof opts.sessionId !== 'string' || opts.sessionId.length === 0) {
    throw new Error(`${PREFIX}: readSession requires a session id`)
  }
  const connection = await openAcpConnection({ options, env, signal: env.signal })
  const { client, initialized } = connection
  const messages = []
  const remove = client.onNotification((method, params) => {
    const update = extractReplayUpdate(method, params, opts.sessionId)
    if (update === undefined) return
    const latest = messages.at(-1)
    if (
      latest?.role === update.role &&
      ((latest.messageId !== undefined && latest.messageId === update.messageId) ||
        (latest.messageId === undefined && update.messageId === undefined))
    ) {
      latest.text += update.text
    } else {
      messages.push(update)
    }
  })
  try {
    if (initialized?.agentCapabilities?.loadSession !== true) {
      return unsupported(options.id, 'readSession (agent omitted loadSession replay)', acpCapabilities())
    }
    const cwd = await sessionCwdForRead({
      client,
      initialized,
      sessionId: opts.sessionId,
      fallbackCwd: options.cwd ?? env.cwd,
    })
    if (typeof cwd !== 'string' || cwd.trim() === '') {
      throw new Error(`${PREFIX}: cannot determine cwd for session ${opts.sessionId}`)
    }
    await client.request('session/load', { sessionId: opts.sessionId, cwd, mcpServers: [] })
    const bounded = boundReplayMessages(messages, { maxTurns: opts.maxTurns, maxChars: opts.maxChars })
    return {
      sessionId: opts.sessionId,
      status: 'stored',
      turns: bounded.turns,
      truncated: bounded.truncated,
      chars: bounded.chars,
      delivery: 'external_or_idle',
      steerable: false,
      capabilities: acpCapabilities(),
    }
  } finally {
    remove()
    if (initialized?.agentCapabilities?.sessionCapabilities?.close != null) {
      await client.request('session/close', { sessionId: opts.sessionId }).catch(() => {})
    }
    await client.dispose()
  }
}

async function startManagedAcp({ options, env, managed, request }) {
  const base = {
    channel: options.id,
    runId: `acp-managed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    capabilities: acpCapabilities(options.executionPolicies),
  }
  let connection
  try {
    const cwd = request.cwd ?? options.cwd ?? env.cwd
    const prompt = typeof request.prompt === 'string' ? request.prompt : ''
    if (typeof cwd !== 'string' || cwd.trim() === '') throw new Error('startManagedSession requires cwd')
    if (!prompt.trim()) throw new Error('startManagedSession requires a prompt')
    if (env.signal?.aborted) throw new Error('startManagedSession was aborted before launch')
    const policy = executionPolicyFor(request, env, cwd)
    if (!supportsExecutionPolicy({ capabilities: base.capabilities }, policy)) return unsupportedPermissionPolicy(options.id, policy, base.capabilities, 'ACP agent did not declare the requested permission policy')
    connection = await openAcpConnection({ options: { ...options, cwd, approvalHandler: policy.approvalHandler }, env })
    const { client, handle, initialized } = connection
    const setup = await setupAcpSession({ client, initialized, cwd })
    const sessionId = setup.sessionId
    const overrides = await applyConfigOverrides({
      client,
      sessionId,
      configOptions: setup.setup?.configOptions,
      request,
    })
    if (!overrides.ok) {
      await client.dispose()
      return {
        ...base,
        sessionId,
        stopReason: 'unsupported',
        output: overrides.message,
        delivery: 'refused',
        mayBeConcurrent: false,
      }
    }
    const state = {
      sessionId,
      runId: base.runId,
      client,
      handle,
      initialized,
      status: 'active',
      text: '',
      cancelTimer: undefined,
      settlement: undefined,
    }
    const remove = client.onNotification((method, params) => {
      const chunk = extractTextUpdate(method, params, sessionId)
      if (chunk !== undefined) state.text += chunk
    })
    managed.set(sessionId, state)
    const promptResult = client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: prompt }],
    })
    state.settlement = (async () => {
      try {
        const result = await promptResult
        state.status = state.status === 'cancelling' || result?.stopReason === 'cancelled' ? 'cancelled' : 'completed'
      } catch (error) {
        state.status = state.status === 'cancelling' ? 'cancelled' : 'failed'
        env.logger?.warn?.(`${PREFIX}: managed ACP turn ${state.runId} ended: ${String(error?.message ?? error)}`)
      } finally {
        if (state.cancelTimer !== undefined) clearTimeout(state.cancelTimer)
        remove()
        if (managed.get(sessionId) === state) managed.delete(sessionId)
        if (initialized?.agentCapabilities?.sessionCapabilities?.close != null) {
          await client.request('session/close', { sessionId }).catch(() => {})
        }
        await client.dispose().catch(() => {})
      }
    })()
    void state.settlement.catch(() => {})
    return {
      ...base,
      sessionId,
      stopReason: 'completed',
      output: `managed ACP session started: ${sessionId}`,
      delivery: 'managed_turn_started',
      mayBeConcurrent: false,
    }
  } catch (error) {
    await connection?.client?.dispose?.().catch(() => {})
    return {
      ...base,
      stopReason: env.signal?.aborted ? 'aborted' : 'error',
      output: `startManagedSession: ${String(error?.message ?? error)}`,
      delivery: 'failed',
      mayBeConcurrent: false,
    }
  }
}

function cancelManagedAcp({ options, managed, opts }) {
  const base = {
    channel: options.id,
    runId: `acp-cancel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: opts.sessionId,
    capabilities: acpCapabilities(),
  }
  const state = managed.get(opts.sessionId)
  if (state === undefined) {
    return {
      ...base,
      stopReason: 'refused',
      output: 'cannot cancel: session has no active turn owned by this channel',
      delivery: 'external_or_idle',
      mayBeConcurrent: false,
    }
  }
  if (opts.runId !== undefined && opts.runId !== state.runId) {
    return {
      ...base,
      stopReason: 'refused',
      output: 'cannot cancel: runId does not match the owned active turn',
      delivery: 'refused',
      mayBeConcurrent: false,
    }
  }
  if (state.status === 'active') {
    state.status = 'cancelling'
    state.client.notify('session/cancel', { sessionId: state.sessionId })
    state.cancelTimer = setTimeout(() => state.handle.terminate?.(), 2000)
    state.cancelTimer.unref?.()
  }
  return {
    ...base,
    stopReason: 'completed',
    output: `cancellation requested for managed ACP run ${state.runId}`,
    delivery: 'managed_turn_started',
    mayBeConcurrent: false,
  }
}

export function createAcpChannel(config = {}) {
  const options = {
    id: normalizeAcpChannelId(config.id),
    displayName: typeof config.displayName === 'string' && config.displayName.trim()
      ? config.displayName.trim().slice(0, 100)
      : `ACP (${normalizeAcpChannelId(config.id).slice(4)})`,
    command: normalizeCommand(config.command),
    args: normalizeArgs(config.args),
    env: normalizeEnv(config.env),
    cwd: config.cwd,
    requestTimeoutMs: normalizeTimeout(config.requestTimeoutMs),
    runtimeId: config.runtimeId ?? normalizeAcpChannelId(config.id),
    runtimeRequirement: config.runtimeRequirement,
    executionPolicies: config.executionPolicies ?? {},
  }
  const managed = new Map()
  const channel = {
    id: options.id,
    displayName: options.displayName,
    capabilities: acpCapabilities(options.executionPolicies),
    run(request, env) {
      return runAcpProcess({ options, env, request, resumeSessionId: request.resumeSessionId })
    },
    resume(request, env) {
      const sessionId = request.resumeSessionId ?? request.sessionId
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error(`${PREFIX}: resume requires a session id`)
      }
      return runAcpProcess({ options, env, request, resumeSessionId: sessionId })
    },
    async listSessions(opts, env) {
      const result = await listAcpSessions({ options, env, opts })
      if (!Array.isArray(result?.sessions)) return result
      return {
        ...result,
        sessions: result.sessions.map((session) =>
          managed.has(session.id)
            ? { ...session, status: 'active', delivery: 'managed_turn_started', cancelable: true }
            : session,
        ),
      }
    },
    async readSession(opts, env) {
      const result = await readAcpSession({ options, env, opts })
      if (result?.sessionId === undefined || result?.turns === undefined) return result
      return managed.has(result.sessionId)
        ? { ...result, status: 'active', delivery: 'managed_turn_started', cancelable: true }
        : result
    },
    startManagedSession(request, env) {
      return startManagedAcp({ options, env, managed, request })
    },
    cancel(opts) {
      return cancelManagedAcp({ options, managed, opts })
    },
    async dispose() {
      const states = [...managed.values()]
      managed.clear()
      for (const state of states) {
        state.client.notify('session/cancel', { sessionId: state.sessionId })
        state.handle.terminate?.()
      }
      await Promise.allSettled(states.map((state) => state.settlement))
    },
  }
  return channel
}

export function registerAcpChannel(config = {}) {
  return tryRegister(createAcpChannel(config))
}

// Keep the shared registry import explicit: callers may register many ACP
// instances, each under its own `acp/<name>` id.
void registry
