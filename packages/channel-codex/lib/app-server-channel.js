/**
 * @dsh-subagent-code-agents/channel-codex — app-server session integration.
 *
 * Long-lived `codex app-server` JSON-RPC client adapted from the legacy
 * dsh-subagent-codex plugin, re-injected via RuntimeEnv instead of DSH
 * services. Provides listSessions / readSession / startManagedSession /
 * steerActive for the codex channel.
 *
 * Protocol notes (verified against rust-v0.147.0 app-server README + local
 * generated JSON schema):
 *   - two-phase handshake: `initialize` request then `initialized` notification
 *   - bidirectional JSON-RPC: id+method messages are server REQUESTS, answered
 *     with an explicit method-not-found error so turns never hang
 *   - thread/start + turn/start ALWAYS use approvalPolicy:"never" +
 *     sandboxPolicy:{type:"dangerFullAccess"}
 *   - turn/steer requires expectedTurnId and only turns started by THIS client
 *     (ownedTurns) are steerable; notLoaded is NEVER auto-loaded.
 */

import { StringDecoder } from 'node:string_decoder'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_LINE_BUFFER_BYTES = 4 * 1024 * 1024
const MAX_PENDING_REQUESTS = 128

export const THREAD_STATUS = Object.freeze({
  NOT_LOADED: 'notLoaded',
  IDLE: 'idle',
  ACTIVE: 'active',
  SYSTEM_ERROR: 'systemError',
})

export class AppServerError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'AppServerError'
    this.code = code
    this.detail = detail
  }
}

class PendingRequest {
  constructor(id, method, resolve, reject, timer) {
    this.id = id
    this.method = method
    this.resolve = resolve
    this.reject = reject
    this.timer = timer
  }
}

export class AppServerClient {
  constructor({ spawn, argvPrefix, node, js, cwd, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, logger }) {
    if (typeof spawn !== 'function') throw new Error('AppServerClient: spawn is required')
    const prefix = Array.isArray(argvPrefix) ? argvPrefix : [node, js]
    if (prefix.length === 0 || prefix.some((part) => typeof part !== 'string' || part.length === 0)) {
      throw new Error('AppServerClient: argvPrefix or node and js are required')
    }
    this._spawn = spawn
    this._argvPrefix = [...prefix]
    this._cwd = cwd
    this._requestTimeoutMs = requestTimeoutMs
    this._logger = logger ?? { info() {}, warn() {}, error() {} }

    this._handle = undefined
    this._nextId = 1
    this._pending = new Map()
    this._decoder = new StringDecoder('utf8')
    this._lineBuffer = ''
    this._initialized = false
    this._closed = false
    this._disposePromise = undefined

    this._threads = new Map()
    this._ownedTurns = new Set()
    this._listeners = new Set()
  }

  get initialized() {
    return this._initialized
  }

  get closed() {
    return this._closed
  }

  onNotification(handler) {
    if (typeof handler !== 'function') throw new Error('AppServerClient: handler must be a function')
    this._listeners.add(handler)
    return () => this._listeners.delete(handler)
  }

  threadState(threadId) {
    const state = this._threads.get(threadId)
    return state === undefined ? undefined : { ...state }
  }

  isManaged(threadId) {
    const state = this._threads.get(threadId)
    return state !== undefined && state.managed === true
  }

  async ensureStarted() {
    if (this._initialized) return
    if (this._closed) throw new AppServerError(-32000, 'app-server client is closed')
    if (this._startPromise === undefined) {
      this._startPromise = this._startAndInitialize()
    }
    return this._startPromise
  }

  async _startAndInitialize() {
    const handle = this._spawn(
      [...this._argvPrefix, 'app-server'],
      { cwd: this._cwd },
    )
    if (!handle || typeof handle.done?.then !== 'function' || !handle.stdout || typeof handle.stdout.on !== 'function') {
      throw new AppServerError(-32000, 'app-server spawn returned an invalid handle')
    }
    this._handle = handle

    handle.stdout.on('data', (chunk) => this._onData(chunk))
    if (handle.stderr && typeof handle.stderr.on === 'function') {
      handle.stderr.on('data', (chunk) => {
        const len = Buffer.byteLength(String(chunk))
        this._logger.warn?.(`[app-server stderr] ${len} bytes`)
      })
    }
    handle.done.then(
      (outcome) => this._onExit(outcome?.exitCode),
      (error) => {
        this._logger.error?.('app-server done rejected:', String(error?.message ?? error))
        this._onExit(undefined)
      },
    )

    try {
      await this.request('initialize', {
        clientInfo: {
          name: 'dsh-subagent-code-agents',
          title: 'Multi-channel coding-agent subagents',
          version: '0.1.0',
        },
      })
    } catch (error) {
      await this.dispose()
      throw error
    }
    try {
      this._handle.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
    } catch (error) {
      await this.dispose()
      throw new AppServerError(-32000, `app-server initialized notification failed: ${String(error.message ?? error)}`)
    }
    this._initialized = true
    this._logger.info?.('app-server initialized')
  }

  _onData(chunk) {
    this._lineBuffer += this._decoder.write(chunk)
    if (Buffer.byteLength(this._lineBuffer) > MAX_LINE_BUFFER_BYTES) {
      this._logger.warn?.('app-server: line buffer exceeded cap; dropping connection')
      this.dispose().catch(() => {})
      return
    }
    let idx
    while ((idx = this._lineBuffer.indexOf('\n')) >= 0) {
      const line = this._lineBuffer.slice(0, idx).trim()
      this._lineBuffer = this._lineBuffer.slice(idx + 1)
      if (line) this._onLine(line)
    }
  }

  _onLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      this._logger.warn?.('app-server: ignoring non-JSON line')
      return
    }
    if (!msg || typeof msg !== 'object') return

    const hasId = typeof msg.id === 'number' || typeof msg.id === 'string'
    const hasMethod = typeof msg.method === 'string'

    if (hasId && hasMethod) {
      this._answerServerRequest(msg.id, msg.method)
    } else if (hasId && 'result' in msg) {
      this._settle(msg.id, msg.result)
    } else if (hasId && msg.error !== undefined) {
      this._reject(msg.id, msg.error)
    } else if (hasId) {
      this._reject(msg.id, { code: -32603, message: 'app-server response missing result/error' })
    } else if (hasMethod) {
      this._emitNotification(msg.method, msg.params)
    }
  }

  _answerServerRequest(id, method) {
    const line = JSON.stringify({
      id,
      error: { code: -32601, message: `channel-codex does not support server request ${method}` },
    })
    try {
      this._handle.stdin.write(line + '\n')
    } catch {}
  }

  _settle(id, result) {
    const pending = this._pending.get(id)
    if (!pending) return
    this._pending.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(result)
  }

  _reject(id, error) {
    const pending = this._pending.get(id)
    if (!pending) return
    this._pending.delete(id)
    clearTimeout(pending.timer)
    pending.reject(new AppServerError(
      error?.code ?? -32603,
      error?.message ?? 'app-server request failed',
      error,
    ))
  }

  _emitNotification(method, params) {
    if (method === 'thread/status/changed' && params && typeof params.threadId === 'string') {
      this._updateThreadStatus(params.threadId, params.status)
    } else if (method === 'turn/started' && params && params.turn && typeof params.turn.id === 'string') {
      if (this._ownedTurns.has(params.turn.id)) {
        this._markTurnStarted(params.turn.threadId ?? params.threadId, params.turn.id)
      }
    } else if (method === 'turn/completed' && params && params.turn && typeof params.turn.id === 'string') {
      this._markTurnEnded(params.turn.threadId ?? params.threadId, params.turn.id)
    }
    for (const handler of this._listeners) {
      try {
        handler(method, params)
      } catch (error) {
        this._logger.warn?.('app-server notification handler failed:', String(error.message ?? error))
      }
    }
  }

  _updateThreadStatus(threadId, status) {
    const type = status?.type
    const existing = this._threads.get(threadId) ?? { managed: false, activeTurnId: undefined }
    existing.status = type
    if (type !== THREAD_STATUS.ACTIVE) existing.activeTurnId = undefined
    this._threads.set(threadId, existing)
  }

  _markTurnStarted(threadId, turnId) {
    if (!threadId) return
    const existing = this._threads.get(threadId) ?? { managed: false }
    existing.status = THREAD_STATUS.ACTIVE
    existing.activeTurnId = turnId
    this._threads.set(threadId, existing)
  }

  _markTurnEnded(threadId, turnId) {
    if (!threadId) return
    this._ownedTurns.delete(turnId)
    const existing = this._threads.get(threadId) ?? { managed: false }
    if (existing.activeTurnId === turnId) {
      existing.activeTurnId = undefined
      if (existing.status === THREAD_STATUS.ACTIVE) existing.status = THREAD_STATUS.IDLE
      this._threads.set(threadId, existing)
    }
  }

  _markManaged(threadId) {
    const existing = this._threads.get(threadId) ?? {}
    existing.managed = true
    this._threads.set(threadId, existing)
  }

  _onExit(code) {
    this._closed = true
    const error = new AppServerError(-32000, `app-server process exited (code ${code})`)
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this._pending.clear()
  }

  request(method, params, { timeoutMs } = {}) {
    if (this._closed) {
      return Promise.reject(new AppServerError(-32000, 'app-server client is closed'))
    }
    if (this._pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new AppServerError(-32001, 'app-server too many in-flight requests'))
    }
    const id = this._nextId++
    const timeout = timeoutMs ?? this._requestTimeoutMs
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this._pending.get(id)
        if (!pending) return
        this._pending.delete(id)
        const err = new AppServerError(-32001, `app-server request timed out: ${method}`)
        err.outcomeUnknown = true
        reject(err)
      }, timeout)
      this._pending.set(id, new PendingRequest(id, method, resolve, reject, timer))
      const line = JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })
      try {
        this._handle.stdin.write(line + '\n')
      } catch (error) {
        clearTimeout(timer)
        this._pending.delete(id)
        reject(new AppServerError(-32000, `app-server stdin write failed: ${String(error.message ?? error)}`))
      }
    })
  }

  async threadList({ cwd, limit = 50, sourceKinds, sortKey = 'created_at', cursor } = {}) {
    const params = {
      limit,
      sortKey,
      ...(cursor === undefined || cursor === null ? {} : { cursor }),
      ...(cwd === undefined || cwd === null || cwd === '' ? {} : { cwd }),
      ...(sourceKinds === undefined ? { sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentOther', 'unknown'] } : { sourceKinds }),
    }
    const result = await this.request('thread/list', params)
    return {
      threads: Array.isArray(result?.data) ? result.data : [],
      nextCursor: result?.nextCursor ?? null,
      backwardsCursor: result?.backwardsCursor ?? null,
    }
  }

  async threadRead(threadId, { includeTurns = true } = {}) {
    const result = await this.request('thread/read', { threadId, includeTurns })
    const thread = result?.thread
    if (!thread || typeof thread.id !== 'string') {
      throw new AppServerError(-32602, `app-server thread/read returned no thread for ${threadId}`)
    }
    this._updateThreadStatus(thread.id, thread.status)
    return thread
  }

  async threadStart({ cwd, model } = {}) {
    const params = {
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      threadSource: 'dsh-subagent-code-agents',
    }
    if (cwd !== undefined) params.cwd = cwd
    if (model !== undefined) params.model = model
    const result = await this.request('thread/start', params)
    const thread = result?.thread
    if (!thread || typeof thread.id !== 'string') {
      throw new AppServerError(-32602, 'app-server thread/start returned no thread')
    }
    this._markManaged(thread.id)
    this._updateThreadStatus(thread.id, thread.status)
    return result
  }

  async threadResume(threadId, { model } = {}) {
    const params = {
      threadId,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    }
    if (model !== undefined) params.model = model
    const result = await this.request('thread/resume', params)
    this._markManaged(threadId)
    const thread = result?.thread
    if (thread && typeof thread.status?.type === 'string') {
      this._updateThreadStatus(threadId, thread.status)
    }
    return result
  }

  async turnStart({ threadId, input, model, effort, cwd } = {}) {
    if (typeof threadId !== 'string') throw new AppServerError(-32602, 'turnStart: threadId is required')
    if (!Array.isArray(input) || input.length === 0) {
      throw new AppServerError(-32602, 'turnStart: input is required')
    }
    const params = {
      threadId,
      input,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    }
    if (model !== undefined) params.model = model
    if (effort !== undefined) params.effort = effort
    if (cwd !== undefined) params.cwd = cwd
    const result = await this.request('turn/start', params)
    const turn = result?.turn
    if (turn && typeof turn.id === 'string') {
      this._ownedTurns.add(turn.id)
      this._markManaged(threadId)
      this._markTurnStarted(threadId, turn.id)
    }
    return result
  }

  async turnSteer({ threadId, input, expectedTurnId } = {}) {
    if (typeof threadId !== 'string' || typeof expectedTurnId !== 'string') {
      throw new AppServerError(-32602, 'turnSteer: threadId and expectedTurnId are required')
    }
    if (!Array.isArray(input) || input.length === 0) {
      throw new AppServerError(-32602, 'turnSteer: input is required')
    }
    if (!this._ownedTurns.has(expectedTurnId)) {
      throw new AppServerError(-32602, 'turnSteer: refusing to steer a turn this channel did not start')
    }
    return this.request('turn/steer', { threadId, input, expectedTurnId })
  }

  async dispose() {
    if (this._disposePromise !== undefined) return this._disposePromise
    this._disposePromise = this._doDispose()
    return this._disposePromise
  }

  async _doDispose() {
    this._closed = true
    const error = new AppServerError(-32000, 'app-server client disposed')
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this._pending.clear()
    const handle = this._handle
    this._handle = undefined
    if (handle) {
      try {
        handle.terminate?.()
      } catch {}
      if (typeof handle.waitForExit === 'function') {
        try {
          await handle.waitForExit()
        } catch {}
      }
    }
  }
}

export function classifyThreadStatus(statusType, isManaged) {
  switch (statusType) {
    case THREAD_STATUS.ACTIVE:
      return isManaged ? 'active_managed' : 'external_or_idle'
    case THREAD_STATUS.IDLE:
      return isManaged ? 'idle_managed' : 'external_or_idle'
    case THREAD_STATUS.SYSTEM_ERROR:
      return 'system_error'
    case THREAD_STATUS.NOT_LOADED:
    default:
      return 'external_or_idle'
  }
}

const MAX_HISTORY_CHARS = 12_000
const MAX_HISTORY_TURNS = 20
const TRUNC_MARKER = '…[truncated]'

function truncate(text, max = MAX_HISTORY_CHARS) {
  if (typeof text !== 'string') return ''
  if (text.length <= max) return text
  return `${text.slice(0, max)}${TRUNC_MARKER}`
}

function summarizeThread(thread) {
  if (!thread || typeof thread !== 'object') return undefined
  return {
    id: typeof thread.id === 'string' ? thread.id : undefined,
    name: typeof thread.name === 'string' && thread.name ? thread.name : undefined,
    preview: truncate(typeof thread.preview === 'string' ? thread.preview : '', 200),
    cwd: typeof thread.cwd === 'string' ? thread.cwd : undefined,
    source: typeof thread.source === 'string' ? thread.source : undefined,
    status: thread.status?.type ?? 'notLoaded',
    activeFlags: Array.isArray(thread.status?.activeFlags) ? thread.status.activeFlags : undefined,
    updatedAt: typeof thread.updatedAt === 'number' ? thread.updatedAt : undefined,
    createdAt: typeof thread.createdAt === 'number' ? thread.createdAt : undefined,
  }
}

/**
 * Session-facing part of the codex channel. `createCodexAppServerChannel`
 * returns an adapter that shares run/resume with `createCodexChannel` and adds
 * list/read/start/send via the app-server.
 */
export function createCodexAppServerChannel(options = {}) {
  const clientOptions = {
    spawn: undefined, // filled lazily from env
    argvPrefix: undefined,
    requestTimeoutMs: options.appServerRequestTimeoutMs,
    logger: options.logger,
  }
  let clientSingleton

  const base = {
    id: 'codex',
    displayName: 'OpenAI Codex',
    capabilities: {
      ...emptyCapsForCodex(),
    },
  }

  async function getClient(env) {
    if (clientSingleton !== undefined && clientSingleton.initialized) {
      return clientSingleton
    }
    if (clientSingleton !== undefined && !clientSingleton.closed) {
      // In-flight initialization: wait for it (single-flight), don't start a
      // second child.
      await clientSingleton.ensureStarted()
      if (!clientSingleton.initialized) {
        throw new Error('app-server client failed to initialize')
      }
      return clientSingleton
    }
    if (clientOptions.spawn === undefined) {
      const { resolveCodexEntry } = await import('./index.js')
      const { argvPrefix } = await resolveCodexEntry(env, options)
      clientOptions.argvPrefix = argvPrefix
      clientOptions.spawn = (argv, opts) =>
        env.subprocess.spawn({
          argv,
          cwd: opts?.cwd,
          stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
          graceMs: 2000,
        })
      clientOptions.logger = clientOptions.logger ?? env.logger
      clientOptions.cwd = options.cwd ?? env.cwd
    }
    const client = new AppServerClient(clientOptions)
    clientSingleton = client
    try {
      await client.ensureStarted()
    } catch (error) {
      await client.dispose().catch(() => {})
      clientSingleton = undefined
      throw error
    }
    return client
  }

  return {
    ...base,
    async run(request, env) {
      const { runCodexExec } = await import('./index.js')
      return runCodexExec({
        env,
        request: { ...request, ...(options.codexExecutable ? { codexExecutable: options.codexExecutable } : {}), ...(options.codexJs ? { codexJs: options.codexJs } : {}), ...(options.nodeExecutable ? { nodeExecutable: options.nodeExecutable } : {}) },
        resumeSessionId: request.resumeSessionId,
        capabilities: base.capabilities,
      })
    },
    async resume(request, env) {
      const { runCodexExec } = await import('./index.js')
      return runCodexExec({
        env,
        request: { ...request, ...(options.codexExecutable ? { codexExecutable: options.codexExecutable } : {}), ...(options.codexJs ? { codexJs: options.codexJs } : {}), ...(options.nodeExecutable ? { nodeExecutable: options.nodeExecutable } : {}) },
        resumeSessionId: request.resumeSessionId ?? request.sessionId,
        capabilities: base.capabilities,
      })
    },
    async listSessions(opts, env) {
      const client = await getClient(env)
      const result = await client.threadList({
        ...(opts.includeAll ? {} : { cwd: opts.cwd }),
        limit: opts.limit ?? 50,
      })
      const sessions = result.threads
        .map((raw) => {
          const s = summarizeThread(raw)
          if (s === undefined) return undefined
          const state = client.threadState(s.id)
          return {
            ...s,
            delivery: classifyThreadStatus(s.status, client.isManaged(s.id)),
            steerable: s.status === 'active' && client.isManaged(s.id) && typeof state?.activeTurnId === 'string',
          }
        })
        .filter(Boolean)
      return { sessions, truncated: result.nextCursor != null }
    },
    async readSession(opts, env) {
      const client = await getClient(env)
      const thread = await client.threadRead(opts.sessionId, { includeTurns: true })
      const rawTurns = Array.isArray(thread.turns) ? thread.turns : []
      const candidateTurns = rawTurns.slice(-(opts.maxTurns ?? MAX_HISTORY_TURNS))
      const budget = opts.maxChars ?? MAX_HISTORY_CHARS
      let used = 0
      let charTruncated = false
      const turns = []
      for (let i = candidateTurns.length - 1; i >= 0; i--) {
        const turn = candidateTurns[i]
        const items = Array.isArray(turn.items) ? turn.items : []
        const texts = items
          .map((item) => {
            if (item && item.type === 'userMessage' && Array.isArray(item.content)) {
              return item.content
                .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
                .map((block) => block.text)
                .join(' ')
            }
            if (item && item.type === 'agentMessage' && typeof item.text === 'string') return item.text
            return undefined
          })
          .filter((text) => typeof text === 'string' && text.length > 0)
        const fullText = texts.join('\n')
        const remaining = budget - used
        if (fullText.length > remaining) {
          charTruncated = true
          if (remaining > 0) {
            let text
            if (remaining <= TRUNC_MARKER.length) {
              text = fullText.slice(0, remaining)
            } else {
              text = fullText.slice(0, remaining - TRUNC_MARKER.length) + TRUNC_MARKER
            }
            turns.unshift({
              id: typeof turn.id === 'string' ? turn.id : undefined,
              status: typeof turn.status === 'string' ? turn.status : undefined,
              text,
              chars: text.length,
            })
            used += text.length
          }
          break
        }
        turns.unshift({
          id: typeof turn.id === 'string' ? turn.id : undefined,
          status: typeof turn.status === 'string' ? turn.status : undefined,
          text: fullText,
          chars: fullText.length,
        })
        used += fullText.length
      }
      const statusType = thread.status?.type ?? 'notLoaded'
      const managed = client.isManaged(thread.id)
      const state = client.threadState(thread.id)
      return {
        sessionId: thread.id,
        status: statusType,
        turns,
        truncated: rawTurns.length > (opts.maxTurns ?? MAX_HISTORY_TURNS) || charTruncated,
        chars: turns.reduce((sum, turn) => sum + turn.chars, 0),
        delivery: classifyThreadStatus(statusType, managed),
        steerable: statusType === 'active' && managed && typeof state?.activeTurnId === 'string',
        capabilities: base.capabilities,
      }
    },
    async startManagedSession(opts, env) {
      // Validate BEFORE creating a thread so a bad call never leaves an orphan.
      if (typeof opts?.prompt !== 'string' || opts.prompt.trim() === '') {
        return {
          channel: 'codex',
          runId: `codex-start-${Date.now().toString(36)}`,
          stopReason: 'error',
          output: 'startManagedSession: prompt is required',
          capabilities: base.capabilities,
        }
      }
      const { normalizeModel, normalizeReasoningEffort } = await import('./index.js')
      let model
      let effort
      try {
        model = normalizeModel(opts.model)
        effort = normalizeReasoningEffort(opts.reasoningEffort)
      } catch (error) {
        return {
          channel: 'codex',
          runId: `codex-start-${Date.now().toString(36)}`,
          stopReason: 'error',
          output: `startManagedSession: ${String(error?.message ?? error)}`,
          capabilities: base.capabilities,
        }
      }
      const client = await getClient(env)
      const started = await client.threadStart({ cwd: opts.cwd, model })
      const threadId = started?.thread?.id
      if (typeof threadId !== 'string') {
        return {
          channel: 'codex',
          runId: `codex-start-${Date.now().toString(36)}`,
          stopReason: 'error',
          output: 'thread/start returned no thread id',
          capabilities: base.capabilities,
        }
      }
      const turn = await client.turnStart({
        threadId,
        input: [{ type: 'text', text: opts.prompt }],
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      })
      return {
        channel: 'codex',
        runId: `codex-managed-${Date.now().toString(36)}`,
        sessionId: threadId,
        turnId: typeof turn?.turn?.id === 'string' ? turn.turn.id : undefined,
        stopReason: 'completed',
        output: `managed codex session started: ${threadId}`,
        delivery: 'managed_turn_started',
        mayBeConcurrent: false,
        capabilities: base.capabilities,
      }
    },
    async steerActive(opts, env) {
      const client = await getClient(env)
      const thread = await client.threadRead(opts.sessionId, { includeTurns: false })
      const statusType = thread.status?.type ?? 'notLoaded'
      // systemError is a HARD failure (mirrors the legacy plugin semantics) —
      // never a soft refusal, never an auto-continuation.
      if (statusType === 'systemError') {
        return {
          channel: 'codex',
          runId: `codex-steer-${Date.now().toString(36)}`,
          sessionId: opts.sessionId,
          stopReason: 'error',
          output: 'cannot steer: thread is in systemError',
          delivery: 'failed',
          capabilities: base.capabilities,
        }
      }
      if (statusType !== 'active') {
        return {
          channel: 'codex',
          runId: `codex-steer-${Date.now().toString(36)}`,
          sessionId: opts.sessionId,
          stopReason: 'refused',
          output: `cannot steer: thread status is ${statusType} (only active managed turns are steerable)`,
          delivery: 'refused',
          capabilities: base.capabilities,
        }
      }
      if (!client.isManaged(opts.sessionId)) {
        return {
          channel: 'codex',
          runId: `codex-steer-${Date.now().toString(36)}`,
          sessionId: opts.sessionId,
          stopReason: 'refused',
          output: 'cannot steer: session is not managed by this channel (external process)',
          delivery: 'external_or_idle',
          capabilities: base.capabilities,
        }
      }
      const state = client.threadState(opts.sessionId)
      const expectedTurnId = opts.expectedTurnId ?? state?.activeTurnId
      if (typeof expectedTurnId !== 'string') {
        return {
          channel: 'codex',
          runId: `codex-steer-${Date.now().toString(36)}`,
          sessionId: opts.sessionId,
          stopReason: 'refused',
          output: 'cannot steer: no known owned active turn id',
          delivery: 'refused',
          capabilities: base.capabilities,
        }
      }
      await client.turnSteer({
        threadId: opts.sessionId,
        input: [{ type: 'text', text: opts.input }],
        expectedTurnId,
      })
      return {
        channel: 'codex',
        runId: `codex-steer-${Date.now().toString(36)}`,
        sessionId: opts.sessionId,
        stopReason: 'completed',
        output: `steered codex session ${opts.sessionId}`,
        delivery: 'steered',
        mayBeConcurrent: false,
        capabilities: base.capabilities,
      }
    },
    async cancel(opts, env) {
      const client = await getClient(env)
      const state = client.threadState(opts.sessionId)
      const turnId = opts.runId ?? state?.activeTurnId
      if (typeof turnId !== 'string') {
        return {
          channel: 'codex',
          runId: `codex-cancel-${Date.now().toString(36)}`,
          sessionId: opts.sessionId,
          stopReason: 'refused',
          output: 'cannot cancel: no active turn id known',
          capabilities: base.capabilities,
        }
      }
      await client.request('turn/interrupt', { threadId: opts.sessionId, turnId })
      return {
        channel: 'codex',
        runId: `codex-cancel-${Date.now().toString(36)}`,
        sessionId: opts.sessionId,
        stopReason: 'completed',
        output: `cancelled turn ${turnId}`,
        capabilities: base.capabilities,
      }
    },
    async dispose() {
      if (clientSingleton !== undefined) {
        await clientSingleton.dispose().catch(() => {})
        clientSingleton = undefined
      }
    },
  }
}

function emptyCapsForCodex() {
  return {
    run: true,
    resume: true,
    listSessions: true,
    readSession: true,
    managedSession: true,
    steerActive: true,
    cancel: true,
    streaming: false,
    modelOverride: true,
    effortOverride: true,
    sandboxBypassGuaranteed: true,
  }
}
