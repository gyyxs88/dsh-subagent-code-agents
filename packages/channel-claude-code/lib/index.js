/**
 * @dsh-subagent-code-agents/channel-claude-code
 *
 * Claude Code channel adapter for the multi-channel coding-agent core. Runs
 * the Anthropic Claude Code CLI headless (`claude -p --output-format
 * stream-json`) via the Node entry (no shell), with:
 *   - per-call `--model` / `--effort`
 *   - `--resume <id>` / `--session-id <id>` for stored sessions
 *   - fixed `--permission-mode bypassPermissions` (exactly once) — Claude Code
 *     has no separate sandbox toggle, so sandboxBypassGuaranteed is FALSE and
 *     the README states that bypassing permission checks is not equivalent to
 *     disabling sandboxing.
 *
 * JSONL session list/read are NOT implemented (capabilities false); the
 * reserved `parseClaudeSessionsJson` helper is an UNUSED placeholder, not a
 * working session list. Claude Code has no steer API, so steerActive is
 * unsupported and refused explicitly.
 */

import { emptyCapabilities, registry, tryRegister } from '@dsh-subagent-code-agents/core'

export const CHANNEL_ID = 'claude-code'
export const CLAUDE_FIXED_PERMISSION_ARGV = Object.freeze(['--permission-mode', 'bypassPermissions'])

const PREFIX = 'channel-claude-code'

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
  return value.trim()
}

/**
 * Build the complete `claude -p` argv. Always uses the fixed permission mode
 * exactly once; per-call model/effort appended; never a shell.
 */
export function claudePrintArgv({ argvPrefix, request }) {
  const argv = [...argvPrefix]
  if (request.model !== undefined) argv.push('--model', request.model)
  if (request.reasoningEffort !== undefined) argv.push('--effort', request.reasoningEffort)
  argv.push(
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
  )
  return argv
}

/**
 * Build the complete `claude -p --resume <id>` argv. The prompt is NOT passed
 * on the command line here — the channel sends it via stdin to keep argv free
 * of prompt-length limits and shell interpretation.
 */
export function claudeResumeArgv({ argvPrefix, sessionId, request }) {
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
    '--permission-mode',
    'bypassPermissions',
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
  if (request.claudeExecutable) {
    if (/\.(cmd|ps1|bat)$/i.test(request.claudeExecutable)) {
      throw new Error(
        `${PREFIX}: claudeExecutable must be a real binary, not a ${request.claudeExecutable.match(/\.(cmd|ps1|bat)$/i)[0]} shim`,
      )
    }
    return { argvPrefix: [request.claudeExecutable], entry: request.claudeExecutable }
  }
  const shim = await env.subprocess.resolveExecutable('claude')
  if (typeof shim !== 'string' || shim.length === 0) {
    throw new Error(`${PREFIX}: cannot locate the claude executable`)
  }
  const isShim = /\.(cmd|ps1|bat)$/i.test(shim)
  const sep = Math.max(shim.lastIndexOf('\\'), shim.lastIndexOf('/'))
  const dir = sep >= 0 ? shim.slice(0, sep) : ''
  if (dir) {
    const native = env.path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    if (env.fs.existsSync(native)) {
      return { argvPrefix: [native], entry: native }
    }
    const cliJs = env.path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    if (env.fs.existsSync(cliJs)) {
      const node = await env.subprocess.resolveExecutable('node')
      return { argvPrefix: [node, cliJs], entry: cliJs }
    }
  }
  if (isShim) {
    // Do NOT spawn a .cmd/.ps1 shim; the real binary must be locatable.
    throw new Error(
      `${PREFIX}: claude resolves to a shim (${shim}) but no native bin/claude.exe or cli.js was found next to it; set claudeExecutable explicitly`,
    )
  }
  return { argvPrefix: [shim], entry: shim }
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
  const { argvPrefix } = await resolveClaudeEntry(env, request)
  const argv =
    resumeSessionId === undefined
      ? claudePrintArgv({ argvPrefix, request: normalizedRequest })
      : claudeResumeArgv({ argvPrefix, sessionId: resumeSessionId, request: normalizedRequest })
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
    listSessions: false,
    readSession: false,
    managedSession: false,
    steerActive: false,
    cancel: false,
    streaming: false,
    modelOverride: true,
    effortOverride: true,
    // Claude Code bypasses permission checks, but there is no separate
    // "no sandbox" guarantee exposed by the CLI.
    sandboxBypassGuaranteed: false,
  }
}

export function createClaudeCodeChannel(options = {}) {
  const entryOpts = options.claudeExecutable ? { claudeExecutable: options.claudeExecutable } : {}
  return {
    id: CHANNEL_ID,
    displayName: 'Claude Code',
    capabilities: claudeChannelCapabilities(),
    async run(request, env) {
      return runClaudeProcess({
        env,
        request: { ...request, ...entryOpts },
        resumeSessionId: request.resumeSessionId,
      })
    },
    async resume(request, env) {
      return runClaudeProcess({
        env,
        request: { ...request, ...entryOpts },
        resumeSessionId: request.resumeSessionId ?? request.sessionId,
      })
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
