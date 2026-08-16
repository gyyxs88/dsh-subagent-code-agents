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
 *   - fixed `--permission-mode bypassPermissions` (exactly once)
 *
 * IMPORTANT sandbox honesty: `--permission-mode bypassPermissions` (or
 * `--always-approve`) bypasses permission APPROVAL only; Grok Build 1.0.3's
 * `--help` exposes no verified off/unrestricted sandbox mode, so
 * `sandboxBypassGuaranteed` is FALSE. The README states explicitly that
 * bypassing permissions is NOT equivalent to disabling sandboxing.
 *
 * Session list/read are NOT implemented (capabilities false; the stored
 * sessions are SQLite, not a JSON array). `steerActive` is NOT supported — it
 * would require a managed transport (ACP grok agent stdio) with real active
 * mid-turn steering semantics, which is not implemented.
 */

import os from 'node:os'

import { emptyCapabilities, registry, tryRegister } from '@dsh-subagent-code-agents/core'

export const CHANNEL_ID = 'grok-build'
export const GROK_FIXED_PERMISSION_ARGV = Object.freeze(['--permission-mode', 'bypassPermissions'])

const PREFIX = 'channel-grok-build'
const PROMPT_FILE_MAX_BYTES = 256 * 1024
const PROMPT_FILE_ARGV_THRESHOLD = 4000

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
 * value). Fixed permission mode exactly once; --no-auto-update disables update
 * checks; per-call model/effort; never a shell.
 */
export function grokPrintArgv({ grok, cwd, request, prompt }) {
  const argv = [grok, '-p', prompt]
  if (request.model !== undefined) argv.push('-m', request.model)
  if (request.reasoningEffort !== undefined) argv.push('--reasoning-effort', request.reasoningEffort)
  argv.push('--output-format', 'streaming-json', '--permission-mode', 'bypassPermissions', '--no-auto-update')
  if (cwd) argv.push('--cwd', cwd)
  return argv
}

/**
 * Build the complete `grok` argv for a LONG prompt delivered via
 * `--prompt-file <path>`. The `-p/--single` flag is NOT used (the file carries
 * the prompt).
 */
export function grokPromptFileArgv({ grok, cwd, request, promptFile }) {
  const argv = [grok]
  if (request.model !== undefined) argv.push('-m', request.model)
  if (request.reasoningEffort !== undefined) argv.push('--reasoning-effort', request.reasoningEffort)
  argv.push('--output-format', 'streaming-json', '--permission-mode', 'bypassPermissions', '--no-auto-update', '--prompt-file', promptFile)
  if (cwd) argv.push('--cwd', cwd)
  return argv
}

/** Build the complete `grok -p -r <id>` argv (short prompt). */
export function grokResumeArgv({ grok, sessionId, cwd, request, prompt }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(`${PREFIX}: resume requires a non-empty session id`)
  }
  const argv = [grok, '-p', prompt]
  if (request.model !== undefined) argv.push('-m', request.model)
  if (request.reasoningEffort !== undefined) argv.push('--reasoning-effort', request.reasoningEffort)
  argv.push('--output-format', 'streaming-json', '--permission-mode', 'bypassPermissions', '--no-auto-update', '--resume', sessionId)
  if (cwd) argv.push('--cwd', cwd)
  return argv
}

/** Build the complete `grok -r <id>` argv (long prompt via file). */
export function grokResumePromptFileArgv({ grok, sessionId, cwd, request, promptFile }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(`${PREFIX}: resume requires a non-empty session id`)
  }
  const argv = [grok]
  if (request.model !== undefined) argv.push('-m', request.model)
  if (request.reasoningEffort !== undefined) argv.push('--reasoning-effort', request.reasoningEffort)
  argv.push('--output-format', 'streaming-json', '--permission-mode', 'bypassPermissions', '--no-auto-update', '--resume', sessionId, '--prompt-file', promptFile)
  if (cwd) argv.push('--cwd', cwd)
  return argv
}

/** Resolve the grok executable (native binary; reject shims like .cmd/.ps1). */
export async function resolveGrok(env, request = {}) {
  const exe = request.grokExecutable ?? (await env.subprocess.resolveExecutable('grok'))
  if (typeof exe !== 'string' || exe.length === 0) {
    throw new Error(`${PREFIX}: cannot locate the grok executable`)
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
          ? grokPrintArgv({ grok, cwd, request: normalizedRequest, prompt })
          : grokResumeArgv({ grok, sessionId: resumeSessionId, cwd, request: normalizedRequest, prompt })
    } else {
      argv =
        resumeSessionId === undefined
          ? grokPromptFileArgv({ grok, cwd, request: normalizedRequest, promptFile })
          : grokResumePromptFileArgv({ grok, sessionId: resumeSessionId, cwd, request: normalizedRequest, promptFile })
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

/**
 * Bounded JSON-array session parser — UNUSED placeholder, NOT an implemented
 * capability. Grok's real session store is SQLite (`grok sessions`), so this
 * parser is NOT wired to listSessions (capability stays false). It exists only
 * as a bounded, same-cwd-filtered helper for future work; do not treat it as a
 * working session list.
 */
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
    listSessions: false,
    readSession: false,
    managedSession: false,
    steerActive: false,
    cancel: false,
    streaming: false,
    modelOverride: true,
    effortOverride: true,
    // Permission bypass ≠ sandbox disable; no verified off/unrestricted mode.
    sandboxBypassGuaranteed: false,
  }
}

export function createGrokBuildChannel(options = {}) {
  return {
    id: CHANNEL_ID,
    displayName: 'Grok Build',
    capabilities: grokChannelCapabilities(),
    async run(request, env) {
      return runGrokProcess({
        env,
        request: { ...request, ...(options.grokExecutable ? { grokExecutable: options.grokExecutable } : {}) },
        resumeSessionId: request.resumeSessionId,
      })
    },
    async resume(request, env) {
      return runGrokProcess({
        env,
        request: { ...request, ...(options.grokExecutable ? { grokExecutable: options.grokExecutable } : {}) },
        resumeSessionId: request.resumeSessionId ?? request.sessionId,
      })
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
