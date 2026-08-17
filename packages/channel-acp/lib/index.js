/**
 * Generic Agent Client Protocol (ACP) channel.
 *
 * Each configured instance owns a stable `acp/<name>` channel id and launches
 * one ACP agent process per call over newline-delimited JSON-RPC 2.0. The
 * adapter deliberately advertises only the stable v1 operations it uses:
 * initialize, session/new or session/load, session/prompt and session/cancel.
 */

import { StringDecoder } from 'node:string_decoder'
import { emptyCapabilities, registry, tryRegister } from '@dsh-subagent-code-agents/core'

const PREFIX = 'channel-acp'
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_LINE_BUFFER_BYTES = 4 * 1024 * 1024
const MAX_PENDING_REQUESTS = 128
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

function acpCapabilities() {
  return {
    ...emptyCapabilities(),
    run: true,
    resume: true,
    streaming: false,
    modelOverride: false,
    effortOverride: false,
    sandboxBypassGuaranteed: false,
  }
}

function normalizeTimeout(value) {
  if (value === undefined) return DEFAULT_REQUEST_TIMEOUT_MS
  if (!Number.isInteger(value) || value < 1_000 || value > 10 * 60_000) {
    throw new Error(`${PREFIX}: requestTimeoutMs must be an integer between 1000 and 600000`)
  }
  return value
}

async function resolveCommand(env, command, commandEnv) {
  if (command.includes('/') || command.includes('\\')) {
    return env.path.isAbsolute(command) ? command : env.path.resolve(command)
  }
  const resolved = await env.subprocess.resolveExecutable(command, commandEnv, env.signal)
  if (typeof resolved !== 'string' || resolved.length === 0) {
    throw new Error(`${PREFIX}: cannot locate executable ${command}`)
  }
  if (/\.(?:cmd|ps1|bat)$/iu.test(resolved)) {
    throw new Error(`${PREFIX}: ${command} resolves to a shell shim; configure a real executable`)
  }
  return resolved
}

class AcpClient {
  constructor({ handle, requestTimeoutMs, logger }) {
    if (!handle?.stdin || !handle?.stdout || typeof handle.done?.then !== 'function') {
      throw new AcpProtocolError(-32000, 'ACP spawn returned an invalid process handle')
    }
    this.handle = handle
    this.requestTimeoutMs = requestTimeoutMs
    this.logger = logger ?? { info() {}, warn() {}, error() {} }
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
      this.notifyResponse(message.id, {
        error: { code: -32601, message: `channel-acp does not support server request ${message.method}` },
      })
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
  if (request.model !== undefined || request.reasoningEffort !== undefined) {
    throw new Error(`${PREFIX}: generic ACP instances do not support model or effort overrides`)
  }

  const executable = await resolveCommand(env, options.command, options.env)
  const handle = env.subprocess.spawn({
    argv: [executable, ...options.args],
    cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    stdio: {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: { maxBytes: 65536 },
    },
    graceMs: 2000,
    signal: env.signal,
  })
  const client = new AcpClient({
    handle,
    requestTimeoutMs: options.requestTimeoutMs,
    logger: env.logger,
  })
  let text = ''
  let sessionId = resumeSessionId
  let abortRequested = false
  const removeUpdate = client.onNotification((method, params) => {
    const chunk = extractTextUpdate(method, params, sessionId)
    if (chunk !== undefined) text += chunk
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
    capabilities: acpCapabilities(),
  }
  try {
    const initialized = await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'dsh-subagent-code-agents', version: '0.1.0' },
    })
    if (resumeSessionId !== undefined) {
      if (initialized?.agentCapabilities?.loadSession !== true) {
        return {
          ...base,
          sessionId: resumeSessionId,
          stopReason: 'unsupported',
          output: `ACP agent for "${options.id}" does not advertise session/load`,
          delivery: 'refused',
          mayBeConcurrent: false,
        }
      }
      await client.request('session/load', { sessionId: resumeSessionId, cwd, mcpServers: [] })
    } else {
      const created = await client.request('session/new', { cwd, mcpServers: [] })
      if (typeof created?.sessionId !== 'string' || created.sessionId.length === 0) {
        throw new AcpProtocolError(-32603, 'ACP session/new returned no sessionId')
      }
      sessionId = created.sessionId
    }
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
  }
  const channel = {
    id: options.id,
    displayName: options.displayName,
    capabilities: acpCapabilities(),
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
  }
  return channel
}

export function registerAcpChannel(config = {}) {
  return tryRegister(createAcpChannel(config))
}

// Keep the shared registry import explicit: callers may register many ACP
// instances, each under its own `acp/<name>` id.
void registry
