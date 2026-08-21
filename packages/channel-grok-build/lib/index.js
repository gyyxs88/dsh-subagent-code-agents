/**
 * @dsh-subagent-code-agents/channel-grok-build
 *
 * Grok Build channel adapter for the multi-channel coding-agent core. Runs
 * the Grok Build CLI (`grok -p --output-format streaming-json …`) as a native
 * executable + argv (no shell), with:
 *   - per-call `-m/--model` and `--reasoning-effort/--effort`
 *   - `-r/--resume <id>` for stored sessions
 *   - `--cwd` working directory
 *   - long prompts sent via a safe temp prompt file (cleaned up afterwards)
 *   - Full Access uses `--permission-mode bypassPermissions` and
 *     `--sandbox off`; Read Only uses the administrator-provided
 *     `read-only` profile plus an explicit read-tool allowlist
 *   - bounded session list/read from Grok's documented local session store
 *
 * IMPORTANT sandbox honesty: Grok Build documents `--sandbox off` as
 * unrestricted read/write/network access. Every run/resume argv therefore
 * carries both approval bypass and explicit sandbox off. The capability is
 * meaningful only for an explicitly inherited Full Access policy.
 *
 * `steerActive` is NOT supported — it would require real active mid-turn
 * steering semantics, which Grok's ACP surface does not currently expose.
 */

import os from 'node:os'

import { AcpClient } from '@dsh-subagent-code-agents/channel-acp'
import { emptyCapabilities, executionPolicyFor, registry, supportsExecutionPolicy, tryRegister, unsupportedPermissionPolicy } from '@dsh-subagent-code-agents/core'

export const CHANNEL_ID = 'grok-build'
export const GROK_FIXED_PERMISSION_ARGV = Object.freeze(['--permission-mode', 'bypassPermissions'])
export const GROK_FIXED_SANDBOX_ARGV = Object.freeze(['--sandbox', 'off'])
export const GROK_READ_ONLY_ARGV = Object.freeze([
  '--permission-mode', 'dontAsk',
  '--sandbox', 'read-only',
  '--tools', 'Read,Grep',
  '--disallowed-tools', 'Edit,Write,NotebookEdit,Bash,MCP,WebSearch,WebFetch',
  '--disable-web-search',
  '--no-subagents',
])

const PREFIX = 'channel-grok-build'
const PROMPT_FILE_MAX_BYTES = 256 * 1024
const PROMPT_FILE_ARGV_THRESHOLD = 4000
const MAX_SESSION_SCAN = 5000
const MAX_HISTORY_BYTES = 4 * 1024 * 1024
const MAX_HISTORY_CHARS = 12_000
const MAX_HISTORY_TURNS = 20
const TRUNC_MARKER = '…[truncated]'
const DEFAULT_MANAGED_REQUEST_TIMEOUT_MS = 10 * 60_000

export function grokExecutionPolicyArgv(policy) {
  if (!policy || typeof policy.permission !== 'string') throw new Error(`${PREFIX}: execution policy is required`)
  if (policy.permission === 'danger-full-access') return [...GROK_FIXED_PERMISSION_ARGV, ...GROK_FIXED_SANDBOX_ARGV]
  if (policy.permission === 'read-only') return [...GROK_READ_ONLY_ARGV]
  if (policy.permission === 'workspace-write') {
    const error = new Error(`${PREFIX}: Workspace Write has no target-session approval bridge`)
    error.code = 'UNSUPPORTED_PERMISSION_POLICY'
    throw error
  }
  throw new Error(`${PREFIX}: unsupported permission policy ${policy.permission}`)
}

function appendFixedRunArgs(argv, policy) {
  argv.push(...grokExecutionPolicyArgv(policy), '--no-auto-update')
}

function normalizeManagedTimeout(value) {
  if (value === undefined) return DEFAULT_MANAGED_REQUEST_TIMEOUT_MS
  if (!Number.isInteger(value) || value < 1_000 || value > 60 * 60_000) {
    throw new Error(`${PREFIX}: managedRequestTimeoutMs must be an integer between 1000 and 3600000`)
  }
  return value
}

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
  return value.trim()
}

/**
 * Build the complete `grok -p` argv for a SHORT prompt (rides as the `-p`
 * value). Policy-derived permission arguments and --no-auto-update disable
 * update checks; per-call model/effort; never a shell.
 */
export function grokPrintArgv({ grok, cwd, request, prompt, executionPolicy }) {
  const argv = [grok, '-p', prompt]
  if (request.model !== undefined) argv.push('-m', request.model)
  if (request.reasoningEffort !== undefined) argv.push('--reasoning-effort', request.reasoningEffort)
  argv.push('--output-format', 'streaming-json')
  appendFixedRunArgs(argv, executionPolicy)
  if (cwd) argv.push('--cwd', cwd)
  return argv
}

/**
 * Build the complete `grok` argv for a LONG prompt delivered via
 * `--prompt-file <path>`. The `-p/--single` flag is NOT used (the file carries
 * the prompt).
 */
export function grokPromptFileArgv({ grok, cwd, request, promptFile, executionPolicy }) {
  const argv = [grok]
  if (request.model !== undefined) argv.push('-m', request.model)
  if (request.reasoningEffort !== undefined) argv.push('--reasoning-effort', request.reasoningEffort)
  argv.push('--output-format', 'streaming-json')
  appendFixedRunArgs(argv, executionPolicy)
  argv.push('--prompt-file', promptFile)
  if (cwd) argv.push('--cwd', cwd)
  return argv
}

/** Build the complete `grok -p -r <id>` argv (short prompt). */
export function grokResumeArgv({ grok, sessionId, cwd, request, prompt, executionPolicy }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(`${PREFIX}: resume requires a non-empty session id`)
  }
  const argv = [grok, '-p', prompt]
  if (request.model !== undefined) argv.push('-m', request.model)
  if (request.reasoningEffort !== undefined) argv.push('--reasoning-effort', request.reasoningEffort)
  argv.push('--output-format', 'streaming-json')
  appendFixedRunArgs(argv, executionPolicy)
  argv.push('--resume', sessionId)
  if (cwd) argv.push('--cwd', cwd)
  return argv
}

/** Build the complete `grok -r <id>` argv (long prompt via file). */
export function grokResumePromptFileArgv({ grok, sessionId, cwd, request, promptFile, executionPolicy }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(`${PREFIX}: resume requires a non-empty session id`)
  }
  const argv = [grok]
  if (request.model !== undefined) argv.push('-m', request.model)
  if (request.reasoningEffort !== undefined) argv.push('--reasoning-effort', request.reasoningEffort)
  argv.push('--output-format', 'streaming-json')
  appendFixedRunArgs(argv, executionPolicy)
  argv.push('--resume', sessionId, '--prompt-file', promptFile)
  if (cwd) argv.push('--cwd', cwd)
  return argv
}

/** Build the official isolated `grok agent stdio` managed-session argv. */
export function grokAgentStdioArgv({ grok, model, reasoningEffort, executionPolicy }) {
  const argv = [grok, ...grokExecutionPolicyArgv(executionPolicy), '--no-auto-update', 'agent', ...(executionPolicy.permission === 'danger-full-access' ? ['--always-approve'] : []), '--no-leader']
  if (model !== undefined) argv.push('--model', model)
  if (reasoningEffort !== undefined) argv.push('--reasoning-effort', reasoningEffort)
  argv.push('stdio')
  return argv
}

/** Resolve the grok executable (native binary; reject shims like .cmd/.ps1). */
export async function resolveGrok(env, request = {}) {
  const managed = env.runtimeManager?.resolveExecutable
    ? await env.runtimeManager.resolveExecutable(request.runtimeRequirement ?? env.runtimeRequirement, { sourceSessionId: env.executionPolicy?.sourceSessionId, targetSessionId: env.executionPolicy?.targetSessionId })
    : null
  const exe = managed?.executable ?? request.grokExecutable
  if (typeof exe !== 'string' || exe.length === 0) {
    throw new Error(`${PREFIX}: Runtime Manager must provide an absolute Grok executable; PATH resolution is disabled`)
  }
  if (/\.(cmd|ps1|bat)$/i.test(exe)) {
    throw new Error(`${PREFIX}: grokExecutable must be a real binary, not a ${exe.match(/\.(cmd|ps1|bat)$/i)[0]} shim`)
  }
  return exe
}

/**
 * Decide how to deliver the prompt: pass in argv for short prompts, or write a
 * temp prompt file (returned for cleanup) for long ones. Never shell-quote.
 * The temp dir is created under `env.tmpdir ?? os.tmpdir()` (never inside the
 * project cwd), the file is written with mode 0600, and a failed write cleans
 * up the created directory.
 */
export async function writePromptFileIfNeeded({ env, prompt }) {
  if (prompt.length <= PROMPT_FILE_ARGV_THRESHOLD) return undefined
  if (Buffer.byteLength(prompt, 'utf8') > PROMPT_FILE_MAX_BYTES) {
    throw new Error(`${PREFIX}: prompt exceeds ${PROMPT_FILE_MAX_BYTES} bytes`)
  }
  const base = env.tmpdir ?? os.tmpdir()
  const dir = env.fs.mkdtempSync(env.path.join(base, 'grok-prompt-'))
  const file = env.path.join(dir, 'prompt.txt')
  try {
    env.fs.writeFileSync(file, prompt, { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    try {
      env.fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
    throw error
  }
  return file
}

export function cleanupPromptFile({ fs: _fs, path: _path, file }) {
  if (!file) return
  try {
    _fs.rmSync(_path.dirname(file), { recursive: true, force: true })
  } catch {}
}

/** Resolve GROK_HOME with the same precedence as the CLI. */
export function resolveGrokHome({ env, configuredHome } = {}) {
  const value = configuredHome ?? process.env.GROK_HOME ?? env?.path?.join(os.homedir(), '.grok')
  if (typeof value !== 'string' || value.trim() === '' || /[\0\r\n]/u.test(value)) {
    throw new Error(`${PREFIX}: grokHome must be a non-empty path`)
  }
  return env.path.resolve(value)
}

function safeReadJson(_fs, file) {
  try {
    return JSON.parse(_fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function normalizedCwd(value, _path) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  let result
  try {
    result = _path.resolve(value).replace(/\\/g, '/').replace(/\/+$/u, '')
  } catch {
    return undefined
  }
  if (process.platform === 'win32' || /^[a-z]:\//iu.test(result)) result = result.toLowerCase()
  return result
}

function sameCwd(a, b, _path) {
  const left = normalizedCwd(a, _path)
  const right = normalizedCwd(b, _path)
  return left !== undefined && right !== undefined && left === right
}

function previewOfSummary(summary) {
  const value =
    typeof summary?.generated_title === 'string' && summary.generated_title.trim()
      ? summary.generated_title
      : typeof summary?.session_summary === 'string'
        ? summary.session_summary
        : undefined
  return value === undefined ? undefined : value.trim().slice(0, 200)
}

function summaryEntry(summary, fallbackId) {
  const id = typeof summary?.info?.id === 'string' ? summary.info.id : fallbackId
  const cwd = typeof summary?.info?.cwd === 'string' ? summary.info.cwd : undefined
  if (typeof id !== 'string' || id.length === 0) return undefined
  return {
    id,
    preview: previewOfSummary(summary),
    cwd,
    source: 'grok-build',
    status: 'stored',
    updatedAt: typeof summary.updated_at === 'string' ? summary.updated_at : undefined,
    createdAt: typeof summary.created_at === 'string' ? summary.created_at : undefined,
    model: typeof summary.current_model_id === 'string' ? summary.current_model_id : undefined,
    delivery: 'external_or_idle',
    steerable: false,
  }
}

/**
 * Walk Grok's documented `sessions/<encoded-cwd>/<session-id>` layout.
 * Symlinks are ignored and the total number of inspected session directories
 * is bounded so a damaged or unexpectedly huge store cannot monopolize DSH.
 */
function walkSessionDirectories({ env, grokHome, visit }) {
  const root = env.path.join(grokHome, 'sessions')
  let scanned = 0
  let scanTruncated = false
  let groups
  try {
    groups = env.fs.readdirSync(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { scanned, scanTruncated }
    throw error
  }
  outer: for (const group of groups) {
    if (!group.isDirectory()) continue
    const groupDir = env.path.join(root, group.name)
    let sessions
    try {
      sessions = env.fs.readdirSync(groupDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      if (scanned >= MAX_SESSION_SCAN) {
        scanTruncated = true
        break outer
      }
      scanned += 1
      const sessionDir = env.path.join(groupDir, session.name)
      if (visit({ sessionDir, fallbackId: session.name }) === false) return { scanned, scanTruncated }
    }
  }
  return { scanned, scanTruncated }
}

export function listGrokSessions({ env, grokHome, cwd, includeAll = false, limit = 50 }) {
  const boundedLimit = Math.max(1, Math.min(100, Number.isFinite(limit) ? Math.trunc(limit) : 50))
  if (!includeAll && (typeof cwd !== 'string' || cwd.length === 0)) {
    throw new Error(`${PREFIX}: listSessions requires cwd unless includeAll is true`)
  }
  const matches = []
  const scan = walkSessionDirectories({
    env,
    grokHome,
    visit({ sessionDir, fallbackId }) {
      const summary = safeReadJson(env.fs, env.path.join(sessionDir, 'summary.json'))
      const entry = summaryEntry(summary, fallbackId)
      if (entry === undefined || (!includeAll && !sameCwd(entry.cwd, cwd, env.path))) return
      matches.push(entry)
    },
  })
  matches.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
  return {
    sessions: matches.slice(0, boundedLimit),
    truncated: scan.scanTruncated || matches.length > boundedLimit,
  }
}

function validSessionId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/iu.test(value)
}

function findSessionDirectory({ env, grokHome, sessionId }) {
  if (!validSessionId(sessionId)) throw new Error(`${PREFIX}: invalid session id`)
  let found
  walkSessionDirectories({
    env,
    grokHome,
    visit({ sessionDir, fallbackId }) {
      if (fallbackId === sessionId) {
        found = sessionDir
        return false
      }
      const summary = safeReadJson(env.fs, env.path.join(sessionDir, 'summary.json'))
      if (summary?.info?.id === sessionId) {
        found = sessionDir
        return false
      }
    },
  })
  if (found === undefined) throw new Error(`${PREFIX}: session not found: ${sessionId}`)
  return found
}

function readUtf8Tail(_fs, file, maxBytes = MAX_HISTORY_BYTES) {
  let fd
  try {
    fd = _fs.openSync(file, 'r')
    const size = _fs.fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const buffer = Buffer.alloc(size - start)
    _fs.readSync(fd, buffer, 0, buffer.length, start)
    let text = buffer.toString('utf8')
    if (start > 0) {
      const newline = text.indexOf('\n')
      text = newline < 0 ? '' : text.slice(newline + 1)
    }
    return { text, truncated: start > 0 }
  } finally {
    if (fd !== undefined) _fs.closeSync(fd)
  }
}

function contentText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('')
  if (!value || typeof value !== 'object') return ''
  if (typeof value.text === 'string') return value.text
  return contentText(value.content)
}

function boundedTurns(messages, { maxTurns = MAX_HISTORY_TURNS, maxChars = MAX_HISTORY_CHARS } = {}) {
  const turnLimit = Math.max(1, Math.min(20, Number.isFinite(maxTurns) ? Math.trunc(maxTurns) : MAX_HISTORY_TURNS))
  const charLimit = Math.max(1, Math.min(MAX_HISTORY_CHARS, Number.isFinite(maxChars) ? Math.trunc(maxChars) : MAX_HISTORY_CHARS))
  const candidates = messages.slice(-turnLimit)
  const turns = []
  let used = 0
  let charTruncated = false
  for (let i = candidates.length - 1; i >= 0; i--) {
    const message = candidates[i]
    const remaining = charLimit - used
    if (remaining <= 0) {
      charTruncated = true
      break
    }
    let text = message.text
    if (text.length > remaining) {
      charTruncated = true
      text = remaining <= TRUNC_MARKER.length ? text.slice(0, remaining) : text.slice(0, remaining - TRUNC_MARKER.length) + TRUNC_MARKER
    }
    turns.unshift({ role: message.role, text, chars: text.length })
    used += text.length
    if (charTruncated) break
  }
  return {
    turns,
    chars: used,
    truncated: messages.length > turnLimit || charTruncated,
  }
}

export function parseGrokUpdates(text, limits = {}) {
  const messages = []
  for (const line of String(text).split(/\r?\n/u)) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const update = event?.params?.update
    const role = update?.sessionUpdate === 'user_message_chunk' ? 'user' : update?.sessionUpdate === 'agent_message_chunk' ? 'assistant' : undefined
    if (role === undefined) continue
    const chunk = contentText(update.content)
    if (!chunk) continue
    const latest = messages.at(-1)
    if (latest?.role === role) latest.text += chunk
    else messages.push({ role, text: chunk })
  }
  return boundedTurns(messages, limits)
}

export function parseGrokChatHistory(text, limits = {}) {
  const messages = []
  for (const line of String(text).split(/\r?\n/u)) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event?.synthetic_reason !== undefined) continue
    const role = event?.type === 'user' ? 'user' : event?.type === 'assistant' ? 'assistant' : undefined
    if (role === undefined) continue
    const value = contentText(event.content)
    if (value) messages.push({ role, text: value })
  }
  return boundedTurns(messages, limits)
}

export function readGrokSession({ env, grokHome, sessionId, maxTurns, maxChars }) {
  const sessionDir = findSessionDirectory({ env, grokHome, sessionId })
  const summary = safeReadJson(env.fs, env.path.join(sessionDir, 'summary.json'))
  let parsed
  let sourceTruncated = false
  try {
    const tail = readUtf8Tail(env.fs, env.path.join(sessionDir, 'updates.jsonl'))
    parsed = parseGrokUpdates(tail.text, { maxTurns, maxChars })
    sourceTruncated = tail.truncated
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (parsed === undefined || parsed.turns.length === 0) {
    try {
      const tail = readUtf8Tail(env.fs, env.path.join(sessionDir, 'chat_history.jsonl'))
      parsed = parseGrokChatHistory(tail.text, { maxTurns, maxChars })
      sourceTruncated ||= tail.truncated
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  parsed ??= { turns: [], chars: 0, truncated: false }
  return {
    sessionId: typeof summary?.info?.id === 'string' ? summary.info.id : sessionId,
    status: 'stored',
    turns: parsed.turns,
    truncated: sourceTruncated || parsed.truncated,
    chars: parsed.chars,
    delivery: 'external_or_idle',
    steerable: false,
    capabilities: grokChannelCapabilities(),
  }
}

function extractManagedText(method, params, sessionId) {
  if (method !== 'session/update' || params?.sessionId !== sessionId) return undefined
  const update = params.update
  if (update?.sessionUpdate !== 'agent_message_chunk') return undefined
  return update.content?.type === 'text' && typeof update.content.text === 'string' ? update.content.text : undefined
}

async function startManagedGrok({ env, options, managed, request }) {
  const caps = grokChannelCapabilities()
  const base = {
    channel: CHANNEL_ID,
    runId: `grok-managed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    capabilities: caps,
  }
  let handle
  let client
  try {
    const cwd = request.cwd ?? env.cwd
    if (typeof cwd !== 'string' || cwd.trim() === '') throw new Error('startManagedSession requires cwd')
    const prompt = typeof request.prompt === 'string' ? request.prompt : ''
    if (!prompt.trim()) throw new Error('startManagedSession requires a prompt')
    if (env.signal?.aborted) throw new Error('startManagedSession was aborted before launch')
    const policy = executionPolicyFor(request, env, cwd)
    if (!supportsExecutionPolicy({ capabilities: caps }, policy)) return unsupportedPermissionPolicy(CHANNEL_ID, policy, caps)
    if (policy.permission === 'workspace-write') return unsupportedPermissionPolicy(CHANNEL_ID, policy, caps, 'Grok ACP has no target-session approval bridge for Workspace Write')
    const model = normalizeModel(request.model)
    const reasoningEffort = normalizeEffort(request.reasoningEffort)
    const grok = await resolveGrok(env, {
      ...(options.grokExecutable ? { grokExecutable: options.grokExecutable } : {}),
      ...(options.runtimeRequirement ? { runtimeRequirement: options.runtimeRequirement } : {}),
    })
    handle = env.subprocess.spawn({
      argv: grokAgentStdioArgv({ grok, model, reasoningEffort, executionPolicy: policy }),
      cwd,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: 65536 },
      },
      graceMs: 2000,
    })
    client = new AcpClient({
      handle,
      requestTimeoutMs: options.managedRequestTimeoutMs,
      logger: env.logger,
    })
    await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'dsh-subagent-code-agents', version: '0.1.0' },
    })
    const created = await client.request('session/new', {
      cwd,
      mcpServers: [],
      _meta: { yoloMode: true },
    })
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('session/new returned no sessionId')
    }
    const state = {
      sessionId,
      runId: base.runId,
      client,
      handle,
      status: 'active',
      text: '',
      cancelTimer: undefined,
      settlement: undefined,
    }
    const removeUpdate = client.onNotification((method, params) => {
      const chunk = extractManagedText(method, params, sessionId)
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
        state.status = result?.stopReason === 'cancelled' ? 'cancelled' : 'completed'
      } catch (error) {
        state.status = state.status === 'cancelling' ? 'cancelled' : 'failed'
        env.logger?.warn?.(`${PREFIX}: managed Grok turn ${state.runId} ended: ${String(error?.message ?? error)}`)
      } finally {
        if (state.cancelTimer !== undefined) clearTimeout(state.cancelTimer)
        removeUpdate()
        if (managed.get(sessionId) === state) managed.delete(sessionId)
        await client.dispose().catch(() => {})
      }
    })()
    void state.settlement.catch(() => {})
    return {
      ...base,
      sessionId,
      stopReason: 'completed',
      output: `managed Grok Build session started: ${sessionId}`,
      delivery: 'managed_turn_started',
      mayBeConcurrent: false,
    }
  } catch (error) {
    if (client !== undefined) await client.dispose().catch(() => {})
    else handle?.terminate?.()
    let stderrTail = ''
    try { stderrTail = handle?.collected?.stderr?.readFrom(0)?.text ?? '' } catch {}
    const stderr = stderrTail.trim() ? `\n\n[grok agent stderr]\n${stderrTail.trim().slice(-4000)}` : ''
    return {
      ...base,
      stopReason: env.signal?.aborted ? 'aborted' : 'error',
      output: `startManagedSession: ${String(error?.message ?? error)}${stderr}`,
      delivery: 'failed',
      mayBeConcurrent: false,
    }
  }
}

function managedCancelResult({ managed, opts }) {
  const caps = grokChannelCapabilities()
  const base = {
    channel: CHANNEL_ID,
    runId: `grok-cancel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
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
      output: `cannot cancel: runId does not match the owned active turn`,
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
    output: `cancellation requested for managed Grok Build run ${state.runId}`,
    delivery: 'managed_turn_started',
    mayBeConcurrent: false,
  }
}

/**
 * Parse a Grok streaming-json line into { type, sessionId?, text? }.
 * Verified against the local 1.0.3 docs: text events are
 * `{"type":"text","data":"..."}`, the final event is
 * `{"type":"end","stopReason":"end_turn","sessionId":"..."}`, errors are
 * `{"type":"error","message":"..."}`.
 */
export function parseGrokStreamLine(line) {
  if (!line) return undefined
  let event
  try {
    event = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!event || typeof event !== 'object') return undefined
  const type = typeof event.type === 'string' ? event.type : undefined
  const sessionId = typeof event.sessionId === 'string' ? event.sessionId : undefined
  const stopReason = typeof event.stopReason === 'string' ? event.stopReason : undefined
  let text
  if (type === 'text' && typeof event.data === 'string') text = event.data
  return { type, sessionId, text, stopReason }
}

/**
 * Run one `grok -p [--resume]` process and resolve the unified ChannelResult.
 * Short prompts ride as the `-p` value; long prompts use `--prompt-file`.
 * The `end` event's stopReason is honored; `error` events carry the message.
 */
export async function runGrokProcess({ env, request, resumeSessionId }) {
  const cwd = request.cwd ?? request.parentCwd ?? env.cwd
  if (!cwd) throw new Error(`${PREFIX}: no working directory — set cwd or parentCwd`)
  const policy = executionPolicyFor(request, env, cwd)
  const capabilities = grokChannelCapabilities()
  if (!supportsExecutionPolicy({ capabilities }, policy)) return unsupportedPermissionPolicy(CHANNEL_ID, policy, capabilities)
  if (policy.permission === 'workspace-write') return unsupportedPermissionPolicy(CHANNEL_ID, policy, capabilities, 'Grok headless mode has no target-session approval bridge for Workspace Write')
  const grok = await resolveGrok(env, request)
  const prompt = typeof request.prompt === 'string' ? request.prompt : ''
  if (!prompt.trim()) throw new Error(`${PREFIX}: prompt is required`)
  // Normalize + validate per-call overrides so they actually enter the argv.
  const model = normalizeModel(request.model)
  const effort = normalizeEffort(request.reasoningEffort)
  const normalizedRequest = { ...request, model, reasoningEffort: effort }

  const promptFile = await writePromptFileIfNeeded({ env, prompt })
  let argv
  try {
    // Short prompt → `-p "<prompt>"`; long prompt → `--prompt-file <path>`.
    if (promptFile === undefined) {
      argv =
        resumeSessionId === undefined
          ? grokPrintArgv({ grok, cwd, request: normalizedRequest, prompt, executionPolicy: policy })
          : grokResumeArgv({ grok, sessionId: resumeSessionId, cwd, request: normalizedRequest, prompt, executionPolicy: policy })
    } else {
      argv =
        resumeSessionId === undefined
          ? grokPromptFileArgv({ grok, cwd, request: normalizedRequest, promptFile, executionPolicy: policy })
          : grokResumePromptFileArgv({ grok, sessionId: resumeSessionId, cwd, request: normalizedRequest, promptFile, executionPolicy: policy })
    }
  } catch (error) {
    cleanupPromptFile({ fs: env.fs, path: env.path, file: promptFile })
    throw error
  }

  let handle
  try {
    handle = env.subprocess.spawn({
      argv,
      cwd,
      stdio: {
        // Grok headless does NOT read the prompt from stdin; the prompt is in
        // argv (`-p` value) or in the `--prompt-file`. stdin stays empty.
        stdin: { data: '' },
        stdout: 'pipe',
        stderr: { maxBytes: 65536 },
      },
      graceMs: 2000,
      signal: env.signal,
    })
  } catch (error) {
    cleanupPromptFile({ fs: env.fs, path: env.path, file: promptFile })
    throw error
  }

  let finalText = ''
  let sawError = false
  let errorMessage = ''
  let sessionId
  let stopReason
  let lineBuffer = ''
  let aborted = false

  const onLine = (line) => {
    const parsed = parseGrokStreamLine(line)
    if (parsed === undefined) return
    if (parsed.sessionId !== undefined) sessionId = parsed.sessionId
    if (parsed.text !== undefined && parsed.text.length > 0) {
      // streaming-json text events are chunks of ONE response — concatenate
      // them without inserting artificial newlines.
      finalText += parsed.text
      env.onUpdate?.({ type: 'text-delta', text: parsed.text })
    }
    if (parsed.type === 'error') {
      sawError = true
      try {
        const raw = JSON.parse(line)
        if (typeof raw.message === 'string') errorMessage = raw.message
      } catch {}
    }
    if (parsed.type === 'end' && typeof parsed.stopReason === 'string') {
      stopReason = parsed.stopReason
    }
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

  let outcome
  try {
    outcome = await handle.done
  } finally {
    if (env.signal) env.signal.removeEventListener('abort', onAbort)
    if (lineBuffer.trim()) {
      onLine(lineBuffer.trim())
      lineBuffer = ''
    }
    cleanupPromptFile({ fs: env.fs, path: env.path, file: promptFile })
  }
  let stderrTail = ''
  const reader = handle.collected && handle.collected.stderr
  if (reader) {
    try {
      stderrTail = reader.readFrom(0).text
    } catch {}
  }

  const caps = grokChannelCapabilities()
  const base = {
    channel: CHANNEL_ID,
    runId: `grok-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    capabilities: caps,
    ...(sessionId === undefined ? {} : { sessionId }),
  }
  if (aborted) return { ...base, stopReason: 'aborted', output: finalText }
  if (sawError) {
    const msg = errorMessage ? `\n\n[grok error] ${errorMessage}` : ''
    const extra = (stderrTail || '').trim() ? `\n\n[grok stderr]\n${stderrTail.trim().slice(-4000)}` : ''
    return { ...base, stopReason: 'error', output: finalText + msg + extra }
  }
  // A clean `end` event (any exit code) is success. The official stop reason
  // may be snake_case (`end_turn`) or PascalCase (`EndTurn`) — normalize by
  // stripping non-alphanumerics and lowercasing. Other reasons (refusal /
  // max_tokens / cancelled) are surfaced as errors.
  const normalizedStop = typeof stopReason === 'string' ? stopReason.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() : undefined
  if (typeof stopReason === 'string' && normalizedStop !== 'endturn') {
    return { ...base, stopReason: 'error', output: `${finalText}\n\n[grok stop reason] ${stopReason}` }
  }
  if (outcome.exitCode === 0 && finalText.length > 0) {
    return {
      ...base,
      stopReason: 'completed',
      output: finalText,
      ...(resumeSessionId === undefined ? {} : { delivery: 'resume_unmanaged', mayBeConcurrent: true }),
    }
  }
  const tail = (stderrTail || '').trim()
  const extra = tail ? `\n\n[grok stderr]\n${tail.slice(-4000)}` : ''
  return { ...base, stopReason: 'error', output: finalText + extra }
}

/** Backward-compatible parser for integrations that already consume JSON. */
export function parseGrokSessions(text, { cwd } = {}) {
  const sessions = []
  try {
    const parsed = JSON.parse(text)
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.sessions) ? parsed.sessions : []
    for (const s of list) {
      const id = typeof s.id === 'string' ? s.id : typeof s.session_id === 'string' ? s.session_id : undefined
      if (id === undefined) continue
      const scwd = typeof s.cwd === 'string' ? s.cwd : undefined
      if (cwd && scwd && scwd !== cwd) continue
      sessions.push({
        id,
        preview: typeof s.title === 'string' ? s.title.slice(0, 200) : typeof s.summary === 'string' ? s.summary.slice(0, 200) : undefined,
        cwd: scwd,
        updatedAt: typeof s.updated_at === 'number' ? s.updated_at : undefined,
      })
    }
  } catch {}
  return sessions
}

export function grokChannelCapabilities() {
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
    executionPolicies: { 'read-only': true, 'workspace-write': false, 'danger-full-access': true },
    // Only Full Access uses always-approve + sandbox off; read-only uses dontAsk + strict sandbox.
    sandboxBypassGuaranteed: true,
  }
}

export function createGrokBuildChannel(options = {}) {
  const normalizedOptions = {
    ...options,
    managedRequestTimeoutMs: normalizeManagedTimeout(options.managedRequestTimeoutMs),
  }
  const managed = new Map()
  const homeFor = (env) => resolveGrokHome({ env, configuredHome: normalizedOptions.grokHome })
  return {
    id: CHANNEL_ID,
    displayName: 'Grok Build',
    capabilities: grokChannelCapabilities(),
    async run(request, env) {
      return runGrokProcess({
        env,
        request: { ...request, ...(normalizedOptions.grokExecutable ? { grokExecutable: normalizedOptions.grokExecutable } : {}), ...(normalizedOptions.runtimeRequirement ? { runtimeRequirement: normalizedOptions.runtimeRequirement } : {}) },
        resumeSessionId: request.resumeSessionId,
      })
    },
    async resume(request, env) {
      return runGrokProcess({
        env,
        request: { ...request, ...(normalizedOptions.grokExecutable ? { grokExecutable: normalizedOptions.grokExecutable } : {}), ...(normalizedOptions.runtimeRequirement ? { runtimeRequirement: normalizedOptions.runtimeRequirement } : {}) },
        resumeSessionId: request.resumeSessionId ?? request.sessionId,
      })
    },
    async listSessions(opts, env) {
      const result = listGrokSessions({
        env,
        grokHome: homeFor(env),
        cwd: opts.cwd ?? env.cwd,
        includeAll: opts.includeAll === true,
        limit: opts.limit,
      })
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
      const result = readGrokSession({
        env,
        grokHome: homeFor(env),
        sessionId: opts.sessionId,
        maxTurns: opts.maxTurns,
        maxChars: opts.maxChars,
      })
      return managed.has(result.sessionId)
        ? { ...result, status: 'active', delivery: 'managed_turn_started', cancelable: true }
        : result
    },
    async startManagedSession(request, env) {
      return startManagedGrok({ env, options: normalizedOptions, managed, request })
    },
    async cancel(opts) {
      return managedCancelResult({ managed, opts })
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
}

let _sharedChannel
export function grokBuildChannel(options = {}) {
  if (_sharedChannel === undefined) _sharedChannel = createGrokBuildChannel(options)
  return _sharedChannel
}

export function registerGrokBuildChannel(options = {}) {
  return tryRegister(createGrokBuildChannel(options))
}

void registry
