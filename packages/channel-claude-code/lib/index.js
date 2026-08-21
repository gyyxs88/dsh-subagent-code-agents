/**
 * @dsh-subagent-code-agents/channel-claude-code
 *
 * Claude Code channel adapter for the multi-channel coding-agent core. Uses
 * Anthropic's official Agent SDK while pinning it to the user's installed
 * Claude Code executable, with:
 *   - per-call `--model` / `--effort`
 *   - `--resume <id>` / `--session-id <id>` for stored sessions
 *   - official listSessions / getSessionMessages read-only APIs
 *   - streaming-input managed sessions with owned-only interrupt/cancel
 *   - Full Access maps to `permissionMode: bypassPermissions` and
 *     `sandbox.enabled: false`; restricted modes use official SDK permissions
 *     and approval callbacks
 *
 * Claude Code exposes interrupt, not a true mid-turn steer primitive, so
 * steerActive remains unsupported and is refused explicitly.
 */

import { emptyCapabilities, executionPolicyFor, registry, supportsExecutionPolicy, tryRegister, unsupportedPermissionPolicy } from '@dsh-subagent-code-agents/core'

export const CHANNEL_ID = 'claude-code'
export const CLAUDE_FIXED_PERMISSION_ARGV = Object.freeze(['--permission-mode', 'bypassPermissions'])

export function claudeExecutionPolicyArgv(policy) {
  if (!policy || typeof policy.permission !== 'string') throw new Error(`${PREFIX}: execution policy is required`)
  if (policy.permission === 'danger-full-access') return [...CLAUDE_FIXED_PERMISSION_ARGV]
  if (policy.permission === 'read-only') return ['--permission-mode', 'plan']
  if (policy.permission === 'workspace-write') return ['--permission-mode', 'default']
  throw new Error(`${PREFIX}: unsupported permission policy ${policy.permission}`)
}

const PREFIX = 'channel-claude-code'
const MAX_HISTORY_CHARS = 12_000
const MAX_HISTORY_TURNS = 20
const TRUNC_MARKER = '…[truncated]'
const DEFAULT_MANAGED_INIT_TIMEOUT_MS = 60_000
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
let defaultSdkPromise

/** Sanitize a model id: non-empty, bounded, no control chars. */
export function normalizeModel(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${PREFIX}: model must be a string`)
  const model = value.trim()
  if (!model) throw new Error(`${PREFIX}: model must be a non-empty string`)
  if (model.length > 200 || /[\0\r\n]/u.test(model)) throw new Error(`${PREFIX}: model contains invalid characters`)
  return model
}

export function normalizeEffort(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${PREFIX}: effort must be a non-empty string`)
  }
  const effort = value.trim().toLowerCase()
  if (!CLAUDE_EFFORTS.has(effort)) {
    throw new Error(`${PREFIX}: effort must be one of low, medium, high, xhigh, max`)
  }
  return effort
}

/**
 * Build the complete `claude -p` argv from the inherited policy; per-call
 * model/effort are appended and the process is never started through a shell.
 */
export function claudePrintArgv({ argvPrefix, request, executionPolicy }) {
  const argv = [...argvPrefix]
  if (request.model !== undefined) argv.push('--model', request.model)
  if (request.reasoningEffort !== undefined) argv.push('--effort', request.reasoningEffort)
  argv.push(
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    ...claudeExecutionPolicyArgv(executionPolicy),
  )
  return argv
}

/**
 * Build the complete `claude -p --resume <id>` argv. The prompt is NOT passed
 * on the command line here — the channel sends it via stdin to keep argv free
 * of prompt-length limits and shell interpretation.
 */
export function claudeResumeArgv({ argvPrefix, sessionId, request, executionPolicy }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(`${PREFIX}: resume requires a non-empty session id`)
  }
  const argv = [...argvPrefix]
  if (request.model !== undefined) argv.push('--model', request.model)
  if (request.reasoningEffort !== undefined) argv.push('--effort', request.reasoningEffort)
  argv.push(
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    ...claudeExecutionPolicyArgv(executionPolicy),
    '--resume',
    sessionId,
  )
  return argv
}

/**
 * Resolve the Claude Code launch spec. Returns `{ argvPrefix, entry }`:
 *   - native `bin/claude.exe` (2.x) → prefix `[claude.exe]`
 *   - legacy `cli.js` layout → prefix `[node.exe, cli.js]`
 *   - never spawn a `.cmd`/`.ps1` shim directly (EINVAL under Node/DSH).
 * `request.claudeExecutable` wins when provided.
 */
export async function resolveClaudeEntry(env, request = {}) {
  if (env.runtimeManager?.resolveExecutable) {
    const resolved = await env.runtimeManager.resolveExecutable(request.runtimeRequirement ?? env.runtimeRequirement)
    if (typeof resolved?.executable !== 'string' || resolved.executable.length === 0) throw new Error(`${PREFIX}: Runtime Manager returned no absolute Claude executable`)
    return { argvPrefix: [resolved.executable], entry: resolved.executable, runtimeState: resolved.state }
  }
  if (request.claudeExecutable) {
    if (/\.(cmd|ps1|bat)$/i.test(request.claudeExecutable)) {
      throw new Error(
        `${PREFIX}: claudeExecutable must be a real binary, not a ${request.claudeExecutable.match(/\.(cmd|ps1|bat)$/i)[0]} shim`,
      )
    }
    return { argvPrefix: [request.claudeExecutable], entry: request.claudeExecutable }
  }
  throw new Error(`${PREFIX}: Runtime Manager must provide an absolute Claude executable; PATH resolution is disabled`)
}

/**
 * Parse a Claude Code stream-json line into { type, sessionId?, text? }.
 * - `system`/`init` lines carry session_id.
 * - `assistant` messages carry content as text blocks (array) — extract and
 *   join them.
 * - `result` lines carry the final result text plus session_id (the reliable
 *   success signal for -p mode).
 */
export function parseClaudeStreamLine(line) {
  if (!line) return undefined
  let event
  try {
    event = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!event || typeof event !== 'object') return undefined
  const type = typeof event.type === 'string' ? event.type : undefined
  let sessionId
  if (
    type === 'system' &&
    typeof event.subtype === 'string' &&
    /^init\b/.test(event.subtype) &&
    typeof event.session_id === 'string'
  ) {
    sessionId = event.session_id
  } else if (type === 'result' && typeof event.session_id === 'string') {
    sessionId = event.session_id
  }
  let text
  let isError = false
  if (type === 'assistant' && event.message && typeof event.message.content === 'string') {
    text = event.message.content
  } else if (type === 'assistant' && Array.isArray(event.message?.content)) {
    text = event.message.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
  } else if (type === 'result') {
    // ResultMessage: { type:'result', subtype:'success', is_error:false,
    //   result:'...', session_id:'...' }
    if (typeof event.result === 'string') text = event.result
    else if (typeof event.text === 'string') text = event.text
    if (event.is_error === true || /^(error|failure|failed)$/i.test(String(event.subtype ?? ''))) {
      isError = true
    }
  }
  return { type, sessionId, text, isError }
}

/**
 * Run one `claude -p [--resume]` process and resolve the unified ChannelResult.
 * Prompt is sent via stdin; stdout parsed as stream-json.
 */
export async function runClaudeProcess({ env, request, resumeSessionId }) {
  const cwd = request.cwd ?? request.parentCwd ?? env.cwd
  if (!cwd) throw new Error(`${PREFIX}: no working directory — set cwd or parentCwd`)
  // Normalize + validate per-call overrides so they actually enter the argv.
  const model = normalizeModel(request.model)
  const effort = normalizeEffort(request.reasoningEffort)
  const normalizedRequest = { ...request, model, reasoningEffort: effort }
  const policy = executionPolicyFor(normalizedRequest, env, cwd)
  const capabilities = claudeChannelCapabilities()
  if (!supportsExecutionPolicy({ capabilities }, policy)) return unsupportedPermissionPolicy(CHANNEL_ID, policy, capabilities)
  if (policy.permission === 'workspace-write' && typeof policy.approvalHandler !== 'function') return unsupportedPermissionPolicy(CHANNEL_ID, policy, capabilities, 'Claude CLI has no target-session approval bridge for Workspace Write')
  const { argvPrefix } = await resolveClaudeEntry(env, request)
  const argv =
    resumeSessionId === undefined
      ? claudePrintArgv({ argvPrefix, request: normalizedRequest, executionPolicy: policy })
      : claudeResumeArgv({ argvPrefix, sessionId: resumeSessionId, request: normalizedRequest, executionPolicy: policy })
  const prompt = typeof request.prompt === 'string' ? request.prompt : ''
  if (!prompt.trim()) throw new Error(`${PREFIX}: prompt is required`)

  const handle = env.subprocess.spawn({
    argv,
    cwd,
    stdio: {
      stdin: { data: prompt },
      stdout: 'pipe',
      stderr: { maxBytes: 65536 },
    },
    graceMs: 2000,
    signal: env.signal,
  })

  let assistantText = ''
  let resultText
  let sawError = false
  let sessionId
  let lineBuffer = ''
  let aborted = false

  const onLine = (line) => {
    const parsed = parseClaudeStreamLine(line)
    if (parsed === undefined) return
    if (parsed.sessionId !== undefined) sessionId = parsed.sessionId
    if (parsed.type === 'result') {
      // The final `result` line is authoritative: it carries the complete
      // answer (and may duplicate assistant blocks). It also marks failures.
      if (parsed.text !== undefined && parsed.text.length > 0) resultText = parsed.text
      if (parsed.isError === true) sawError = true
      return
    }
    if (parsed.text !== undefined && parsed.text.length > 0) {
      assistantText = assistantText ? `${assistantText}\n${parsed.text}` : parsed.text
    }
    if (parsed.type === 'error') sawError = true
  }

  if (handle.stdout) {
    handle.stdout.on('data', (chunk) => {
      lineBuffer += chunk.toString('utf8')
      let idx
      while ((idx = lineBuffer.indexOf('\n')) >= 0) {
        onLine(lineBuffer.slice(0, idx).trim())
        lineBuffer = lineBuffer.slice(idx + 1)
      }
    })
  }

  const onAbort = () => {
    aborted = true
    handle.terminate?.()
  }
  if (env.signal) {
    if (env.signal.aborted) onAbort()
    else env.signal.addEventListener('abort', onAbort, { once: true })
  }

  const outcome = await handle.done
  if (env.signal) env.signal.removeEventListener('abort', onAbort)
  if (lineBuffer.trim()) {
    onLine(lineBuffer.trim())
    lineBuffer = ''
  }
  let stderrTail = ''
  const reader = handle.collected && handle.collected.stderr
  if (reader) {
    try {
      stderrTail = reader.readFrom(0).text
    } catch {}
  }

  const finalText = resultText ?? assistantText
  const caps = claudeChannelCapabilities()
  const base = {
    channel: CHANNEL_ID,
    runId: `claude-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    capabilities: caps,
    ...(sessionId === undefined ? {} : { sessionId }),
  }
  if (aborted) return { ...base, stopReason: 'aborted', output: finalText }
  if (sawError) {
    const extra = (stderrTail || '').trim() ? `\n\n[claude stderr]\n${stderrTail.trim().slice(-4000)}` : ''
    return { ...base, stopReason: 'error', output: finalText + extra }
  }
  if (outcome.exitCode === 0 && finalText.length > 0) {
    // A resumed run is an unmanaged, potentially-concurrent send (the session
    // may be owned by another Claude process).
    return {
      ...base,
      stopReason: 'completed',
      output: finalText,
      ...(resumeSessionId === undefined ? {} : { delivery: 'resume_unmanaged', mayBeConcurrent: true }),
    }
  }
  const tail = (stderrTail || '').trim()
  const extra = tail ? `\n\n[claude stderr]\n${tail.slice(-4000)}` : ''
  return { ...base, stopReason: 'error', output: finalText + extra }
}

async function loadClaudeSdk(options = {}) {
  if (options.sdk !== undefined) return options.sdk
  defaultSdkPromise ??= import('@anthropic-ai/claude-agent-sdk')
  return defaultSdkPromise
}

function normalizeManagedInitTimeout(value) {
  if (value === undefined) return DEFAULT_MANAGED_INIT_TIMEOUT_MS
  if (!Number.isInteger(value) || value < 1_000 || value > 10 * 60_000) {
    throw new Error(`${PREFIX}: managedInitTimeoutMs must be an integer between 1000 and 600000`)
  }
  return value
}

function textFromContent(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
  }
  if (!value || typeof value !== 'object') return ''
  return textFromContent(value.content)
}

function assistantTextFromSdkMessage(message) {
  if (message?.type !== 'assistant' || message.parent_tool_use_id != null) return undefined
  const text = textFromContent(message.message)
  return text || undefined
}

function partialTextFromSdkMessage(message) {
  if (message?.type !== 'stream_event') return undefined
  const event = message.event
  if (event?.type !== 'content_block_delta' || event.delta?.type !== 'text_delta') return undefined
  return typeof event.delta.text === 'string' ? event.delta.text : undefined
}

function assertSdkInitPolicy(message, policy) {
  if (message?.type !== 'system' || message.subtype !== 'init') return
  const expected = policy.permission === 'danger-full-access' ? 'bypassPermissions' : policy.permission === 'read-only' ? 'plan' : 'default'
  if (message.permissionMode !== expected) throw new Error(`${PREFIX}: Claude Code did not enter the requested permission mode ${expected}`)
}

/** Build policy-derived Agent SDK options for one call. */
export async function claudeSdkOptions({ env, options, request, resumeSessionId, abortController }) {
  const cwd = request.cwd ?? request.parentCwd ?? env.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new Error(`${PREFIX}: no working directory — set cwd or parentCwd`)
  }
  const model = normalizeModel(request.model)
  const effort = normalizeEffort(request.reasoningEffort)
  const policy = executionPolicyFor(request, env, cwd)
  if (policy.permission === 'workspace-write' && typeof policy.approvalHandler !== 'function') throw new Error(`${PREFIX}: Workspace Write requires the target-session approval handler`)
  const entry = await resolveClaudeEntry(env, {
    ...(options.claudeExecutable ? { claudeExecutable: options.claudeExecutable } : {}),
    ...(options.runtimeRequirement ? { runtimeRequirement: options.runtimeRequirement } : {}),
  })
  return {
    cwd,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(resumeSessionId === undefined ? {} : { resume: resumeSessionId }),
    ...(abortController === undefined ? {} : { abortController }),
    pathToClaudeCodeExecutable: entry.entry,
    ...(/\.(?:m?js|cjs)$/iu.test(entry.entry) ? { executable: 'node' } : {}),
    permissionMode: policy.permission === 'danger-full-access' ? 'bypassPermissions' : policy.permission === 'read-only' ? 'plan' : 'default',
    ...(policy.permission === 'danger-full-access' ? { allowDangerouslySkipPermissions: true, sandbox: { enabled: false } } : { sandbox: { enabled: true } }),
    ...(typeof policy.approvalHandler === 'function' ? { canUseTool: policy.approvalHandler } : {}),
    persistSession: true,
    includePartialMessages: true,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
  }
}

export async function runClaudeSdk({ env, options, request, resumeSessionId }) {
  const prompt = typeof request.prompt === 'string' ? request.prompt : ''
  if (!prompt.trim()) throw new Error(`${PREFIX}: prompt is required`)
  const cwd = request.cwd ?? request.parentCwd ?? env.cwd
  const policy = executionPolicyFor(request, env, cwd)
  const capabilities = claudeChannelCapabilities()
  if (!supportsExecutionPolicy({ capabilities }, policy)) return unsupportedPermissionPolicy(CHANNEL_ID, policy, capabilities)
  if (policy.permission === 'workspace-write' && typeof policy.approvalHandler !== 'function') return unsupportedPermissionPolicy(CHANNEL_ID, policy, capabilities, 'Claude Code requires the target-session approval callback for Workspace Write')
  const sdk = await loadClaudeSdk(options)
  const abortController = new AbortController()
  const onAbort = () => abortController.abort(env.signal?.reason)
  if (env.signal) {
    if (env.signal.aborted) onAbort()
    else env.signal.addEventListener('abort', onAbort, { once: true })
  }
  const base = {
    channel: CHANNEL_ID,
    runId: `claude-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    capabilities: claudeChannelCapabilities(),
  }
  let query
  let sessionId
  let assistantText = ''
  let resultText
  let resultError
  let thrown
  let sawPartialText = false
  try {
    const sdkOptions = await claudeSdkOptions({ env, options, request, resumeSessionId, abortController })
    query = sdk.query({ prompt, options: sdkOptions })
    for await (const message of query) {
      assertSdkInitPolicy(message, policy)
      if (typeof message?.session_id === 'string') sessionId = message.session_id
      const partial = partialTextFromSdkMessage(message)
      if (partial !== undefined && partial.length > 0) {
        sawPartialText = true
        env.onUpdate?.({ type: 'text-delta', text: partial })
      }
      const text = assistantTextFromSdkMessage(message)
      if (text !== undefined) {
        assistantText = assistantText ? `${assistantText}\n${text}` : text
        if (!sawPartialText) env.onUpdate?.({ type: 'text-delta', text })
      }
      if (message?.type === 'result') {
        if (message.subtype === 'success' && typeof message.result === 'string') resultText = message.result
        else resultError = Array.isArray(message.errors) ? message.errors.join('\n') : `Claude result: ${message.subtype}`
      }
    }
  } catch (error) {
    thrown = error
  } finally {
    if (env.signal) env.signal.removeEventListener('abort', onAbort)
    try { query?.close?.() } catch {}
  }
  const output = resultText ?? assistantText
  if (abortController.signal.aborted || env.signal?.aborted) {
    return { ...base, ...(sessionId ? { sessionId } : {}), stopReason: 'aborted', output }
  }
  if (resultError !== undefined || thrown !== undefined) {
    const diagnostic = resultError ?? String(thrown?.message ?? thrown)
    return {
      ...base,
      ...(sessionId ? { sessionId } : {}),
      stopReason: 'error',
      output: `${output}${output ? '\n\n' : ''}[Claude SDK error] ${diagnostic}`,
    }
  }
  if (resultText === undefined) {
    return {
      ...base,
      ...(sessionId ? { sessionId } : {}),
      stopReason: 'error',
      output: `${output}${output ? '\n\n' : ''}[Claude SDK error] query ended without a result message`,
    }
  }
  return {
    ...base,
    ...(sessionId ? { sessionId } : {}),
    stopReason: 'completed',
    output,
    ...(resumeSessionId === undefined ? {} : { delivery: 'resume_unmanaged', mayBeConcurrent: true }),
  }
}

function boundSessionMessages(messages, { maxTurns = MAX_HISTORY_TURNS, maxChars = MAX_HISTORY_CHARS } = {}) {
  const turnLimit = Math.max(1, Math.min(20, Number.isFinite(maxTurns) ? Math.trunc(maxTurns) : MAX_HISTORY_TURNS))
  const charLimit = Math.max(1, Math.min(MAX_HISTORY_CHARS, Number.isFinite(maxChars) ? Math.trunc(maxChars) : MAX_HISTORY_CHARS))
  const normalized = []
  for (const entry of messages) {
    if (!entry || (entry.type !== 'user' && entry.type !== 'assistant')) continue
    if (entry.parent_tool_use_id != null) continue
    const text = textFromContent(entry.message)
    if (text) normalized.push({ role: entry.type, text })
  }
  const candidates = normalized.slice(-turnLimit)
  const turns = []
  let used = 0
  let charTruncated = false
  for (let i = candidates.length - 1; i >= 0; i--) {
    const entry = candidates[i]
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
    turns.unshift({ role: entry.role, text, chars: text.length })
    used += text.length
    if (charTruncated) break
  }
  return {
    turns,
    chars: used,
    truncated: normalized.length > turnLimit || charTruncated,
  }
}

class AsyncMessageQueue {
  constructor(initial) {
    this.values = [initial]
    this.waiters = []
    this.closed = false
  }

  next() {
    if (this.values.length > 0) return Promise.resolve({ value: this.values.shift(), done: false })
    if (this.closed) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  close() {
    if (this.closed) return
    this.closed = true
    for (const resolve of this.waiters.splice(0)) resolve({ value: undefined, done: true })
  }

  [Symbol.asyncIterator]() {
    return this
  }
}

function sdkUserMessage(prompt) {
  return {
    type: 'user',
    message: { role: 'user', content: prompt },
    parent_tool_use_id: null,
  }
}

async function startManagedClaude({ env, options, managed, request }) {
  const caps = claudeChannelCapabilities()
  const base = {
    channel: CHANNEL_ID,
    runId: `claude-managed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    capabilities: caps,
  }
  let query
  let queue
  let timer
  try {
    const prompt = typeof request.prompt === 'string' ? request.prompt : ''
    if (!prompt.trim()) throw new Error('startManagedSession requires a prompt')
    if (env.signal?.aborted) throw new Error('startManagedSession was aborted before launch')
    const policy = executionPolicyFor(request, env, request.cwd ?? env.cwd)
    if (!supportsExecutionPolicy({ capabilities: caps }, policy)) return unsupportedPermissionPolicy(CHANNEL_ID, policy, caps)
    if (policy.permission === 'workspace-write' && typeof policy.approvalHandler !== 'function') return unsupportedPermissionPolicy(CHANNEL_ID, policy, caps, 'Claude Code requires the target-session approval callback for Workspace Write')
    const sdk = await loadClaudeSdk(options)
    const abortController = new AbortController()
    const sdkOptions = await claudeSdkOptions({ env, options, request, abortController })
    queue = new AsyncMessageQueue(sdkUserMessage(prompt))
    query = sdk.query({ prompt: queue, options: sdkOptions })
    let resolveReady
    let rejectReady
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const state = {
      runId: base.runId,
      sessionId: undefined,
      query,
      queue,
      abortController,
      status: 'starting',
      text: '',
      forceTimer: undefined,
      settlement: undefined,
    }
    state.settlement = (async () => {
      try {
        for await (const message of query) {
          assertSdkInitPolicy(message, policy)
          if (typeof message?.session_id === 'string' && state.sessionId === undefined) {
            state.sessionId = message.session_id
            state.status = 'active'
            managed.set(state.sessionId, state)
            resolveReady(state.sessionId)
          }
          const text = assistantTextFromSdkMessage(message)
          if (text !== undefined) state.text = state.text ? `${state.text}\n${text}` : text
          if (message?.type === 'result') {
            state.status = state.status === 'cancelling' ? 'cancelled' : message.subtype === 'success' ? 'completed' : 'failed'
            break
          }
        }
        if (state.sessionId === undefined) rejectReady(new Error('Claude SDK ended before session initialization'))
      } catch (error) {
        state.status = state.status === 'cancelling' ? 'cancelled' : 'failed'
        rejectReady(error)
        env.logger?.warn?.(`${PREFIX}: managed Claude turn ${state.runId} ended: ${String(error?.message ?? error)}`)
      } finally {
        if (state.forceTimer !== undefined) clearTimeout(state.forceTimer)
        queue.close()
        try { query.close?.() } catch {}
        if (state.sessionId !== undefined && managed.get(state.sessionId) === state) managed.delete(state.sessionId)
      }
    })()
    void state.settlement.catch(() => {})
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Claude SDK managed session initialization timed out')), options.managedInitTimeoutMs)
      timer.unref?.()
    })
    const sessionId = await Promise.race([ready, timeout])
    clearTimeout(timer)
    return {
      ...base,
      sessionId,
      stopReason: 'completed',
      output: `managed Claude Code session started: ${sessionId}`,
      delivery: 'managed_turn_started',
      mayBeConcurrent: false,
    }
  } catch (error) {
    if (timer !== undefined) clearTimeout(timer)
    queue?.close?.()
    try { query?.close?.() } catch {}
    return {
      ...base,
      stopReason: env.signal?.aborted ? 'aborted' : 'error',
      output: `startManagedSession: ${String(error?.message ?? error)}`,
      delivery: 'failed',
      mayBeConcurrent: false,
    }
  }
}

async function cancelManagedClaude({ managed, opts }) {
  const caps = claudeChannelCapabilities()
  const base = {
    channel: CHANNEL_ID,
    runId: `claude-cancel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: opts.sessionId,
    capabilities: caps,
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
  try {
    if (state.status === 'active') {
      state.status = 'cancelling'
      await state.query.interrupt()
      state.queue.close()
      state.forceTimer = setTimeout(() => state.query.close?.(), 2000)
      state.forceTimer.unref?.()
    }
    return {
      ...base,
      stopReason: 'completed',
      output: `cancellation requested for managed Claude Code run ${state.runId}`,
      delivery: 'managed_turn_started',
      mayBeConcurrent: false,
    }
  } catch (error) {
    return {
      ...base,
      stopReason: 'error',
      output: `cancel failed: ${String(error?.message ?? error)}`,
      delivery: 'failed',
      mayBeConcurrent: false,
    }
  }
}

/**
 * Bounded JSON-array session parser — UNUSED placeholder, NOT an implemented
 * capability. Claude Code's official session listing/transcript formats are
 * not wired to listSessions (capability stays false). Exists only as a bounded
 * helper for future work; do not treat it as a working session list.
 */
export function parseClaudeSessionsJson(text) {
  const sessions = []
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) {
      for (const s of parsed) {
        sessions.push({
          id: typeof s.session_id === 'string' ? s.session_id : typeof s.id === 'string' ? s.id : undefined,
          preview: typeof s.summary === 'string' ? s.summary.slice(0, 200) : undefined,
          cwd: typeof s.cwd === 'string' ? s.cwd : undefined,
          updatedAt: typeof s.last_timestamp === 'number' ? s.last_timestamp : undefined,
        })
      }
    }
  } catch {}
  return sessions.filter((s) => s.id !== undefined)
}

export function claudeChannelCapabilities() {
  return {
    ...emptyCapabilities(),
    run: true,
    resume: true,
    listSessions: true,
    readSession: true,
    managedSession: true,
    steerActive: false,
    cancel: true,
    streaming: false,
    modelOverride: true,
    effortOverride: true,
    executionPolicies: { 'read-only': true, 'workspace-write': true, 'danger-full-access': true },
    // Full Access uses bypassPermissions; restricted modes use official permission modes and SDK approval callbacks.
    sandboxBypassGuaranteed: true,
  }
}

export function createClaudeCodeChannel(options = {}) {
  const normalizedOptions = {
    ...options,
    managedInitTimeoutMs: normalizeManagedInitTimeout(options.managedInitTimeoutMs),
  }
  const managed = new Map()
  return {
    id: CHANNEL_ID,
    displayName: 'Claude Code',
    capabilities: claudeChannelCapabilities(),
    async run(request, env) {
      return runClaudeSdk({
        env,
        options: normalizedOptions,
        request: { ...request, ...(normalizedOptions.runtimeRequirement ? { runtimeRequirement: normalizedOptions.runtimeRequirement } : {}) },
        resumeSessionId: request.resumeSessionId,
      })
    },
    async resume(request, env) {
      return runClaudeSdk({
        env,
        options: normalizedOptions,
        request: { ...request, ...(normalizedOptions.runtimeRequirement ? { runtimeRequirement: normalizedOptions.runtimeRequirement } : {}) },
        resumeSessionId: request.resumeSessionId ?? request.sessionId,
      })
    },
    async listSessions(opts) {
      const sdk = await loadClaudeSdk(normalizedOptions)
      if (opts.includeAll !== true && (typeof opts.cwd !== 'string' || opts.cwd.trim() === '')) {
        throw new Error(`${PREFIX}: listSessions requires cwd unless includeAll is true`)
      }
      const limit = Math.max(1, Math.min(100, Number.isFinite(opts.limit) ? Math.trunc(opts.limit) : 50))
      const rows = await sdk.listSessions({
        ...(opts.includeAll === true ? {} : { dir: opts.cwd }),
        limit: limit + 1,
      })
      const sessions = rows.slice(0, limit).map((session) => {
        const active = managed.has(session.sessionId)
        return {
          id: session.sessionId,
          preview: typeof session.summary === 'string' ? session.summary.slice(0, 200) : undefined,
          cwd: session.cwd,
          source: 'claude-code',
          status: active ? 'active' : 'stored',
          updatedAt: session.lastModified,
          createdAt: session.createdAt,
          delivery: active ? 'managed_turn_started' : 'external_or_idle',
          steerable: false,
          ...(active ? { cancelable: true } : {}),
        }
      })
      return { sessions, truncated: rows.length > limit }
    },
    async readSession(opts) {
      const sdk = await loadClaudeSdk(normalizedOptions)
      const messages = await sdk.getSessionMessages(opts.sessionId)
      const bounded = boundSessionMessages(messages, {
        maxTurns: opts.maxTurns,
        maxChars: opts.maxChars,
      })
      const active = managed.has(opts.sessionId)
      return {
        sessionId: opts.sessionId,
        status: active ? 'active' : 'stored',
        turns: bounded.turns,
        truncated: bounded.truncated,
        chars: bounded.chars,
        delivery: active ? 'managed_turn_started' : 'external_or_idle',
        steerable: false,
        ...(active ? { cancelable: true } : {}),
        capabilities: claudeChannelCapabilities(),
      }
    },
    async startManagedSession(request, env) {
      return startManagedClaude({ env, options: normalizedOptions, managed, request })
    },
    async cancel(opts) {
      return cancelManagedClaude({ managed, opts })
    },
    async dispose() {
      const states = [...managed.values()]
      managed.clear()
      for (const state of states) {
        try { await state.query.interrupt() } catch {}
        state.queue.close()
        try { state.query.close?.() } catch {}
      }
      await Promise.allSettled(states.map((state) => state.settlement))
    },
  }
}

let _sharedChannel
export function claudeCodeChannel(options = {}) {
  if (_sharedChannel === undefined) _sharedChannel = createClaudeCodeChannel(options)
  return _sharedChannel
}

export function registerClaudeCodeChannel(options = {}) {
  return tryRegister(createClaudeCodeChannel(options))
}

// Keep registry import referenced for tree-shaking clarity in tool mounting.
void registry
