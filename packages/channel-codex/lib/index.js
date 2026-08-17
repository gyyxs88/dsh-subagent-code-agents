/**
 * @dsh-subagent-code-agents/channel-codex
 *
 * Codex channel adapter for the multi-channel coding-agent core. Runs the
 * OpenAI Codex CLI (`codex exec` / `codex exec resume`) plus a long-lived
 * `codex app-server` for managed sessions, behind the shared
 * `CodingAgentChannel` interface. No DSH/Cordis dependency — everything is
 * injected via `RuntimeEnv` (`subprocess`, `fs`, `path`, `logger`, `signal`).
 *
 * Security policy (inherited from the legacy dsh-subagent-codex plugin and
 * kept identical): every CLI run passes `--dangerously-bypass-approvals-and-sandbox`
 * exactly once; `thread/start` / `turn/start` on the app-server always use
 * `approvalPolicy: "never"` + `sandboxPolicy: { type: "dangerFullAccess" }`.
 * sandboxBypassGuaranteed is therefore true for CLI runs; the app-server
 * managed path uses the same fixed policy.
 */

import { emptyCapabilities, registry, tryRegister } from '@dsh-subagent-code-agents/core'

export const CHANNEL_ID = 'codex'
export const CODEX_REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'ultra', 'max'])
export const CODEX_FIXED_SANDBOX_ARGV = Object.freeze(['--dangerously-bypass-approvals-and-sandbox'])

const PREFIX = 'channel-codex'
const WINDOWS_SHELL_SHIM_RE = /\.(?:cmd|ps1|bat)$/iu

export function normalizeModel(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${PREFIX}: model must be a string`)
  const model = value.trim()
  if (!model) throw new Error(`${PREFIX}: model must be a non-empty string`)
  if (model.length > 200 || /[\0\r\n]/u.test(model)) throw new Error(`${PREFIX}: model contains invalid characters`)
  return model
}

export function normalizeReasoningEffort(value) {
  if (value === undefined) return undefined
  if (!CODEX_REASONING_EFFORTS.includes(value)) {
    throw new Error(`${PREFIX}: reasoning effort must be one of ${CODEX_REASONING_EFFORTS.join(', ')}`)
  }
  return value
}

/** Build per-call Codex CLI overrides without using a shell. */
export function codexInvocationArgs(request) {
  const model = normalizeModel(request?.codexOptions?.model ?? request?.agentOptions?.model ?? request?.model)
  const reasoningEffort = normalizeReasoningEffort(request?.codexOptions?.reasoningEffort ?? request?.reasoningEffort)
  return [
    ...(model === undefined ? [] : ['-m', model]),
    ...(reasoningEffort === undefined
      ? []
      : ['-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`]),
  ]
}

function codexArgvPrefix({ argvPrefix, node, js }) {
  const prefix = Array.isArray(argvPrefix) ? argvPrefix : [node, js]
  if (prefix.length === 0 || prefix.some((part) => typeof part !== 'string' || part.length === 0)) {
    throw new Error(`${PREFIX}: Codex argv prefix is invalid`)
  }
  return [...prefix]
}

/**
 * Build the complete `codex exec` argv deterministically. The sandbox portion
 * is always exactly `CODEX_FIXED_SANDBOX_ARGV`.
 */
export function codexExecArgv({ argvPrefix, node, js, cwd, request }) {
  return codexArgvPrefix({ argvPrefix, node, js })
    .concat('exec', '--json', '--skip-git-repo-check', '--color', 'never', '-C', cwd)
    .concat(codexInvocationArgs(request), CODEX_FIXED_SANDBOX_ARGV)
}

/**
 * Build the complete `codex exec resume` argv. `resume` has its own option set:
 * no `--color`, no `-C`; prompt is sent on stdin (`-`).
 */
export function codexExecResumeArgv({ argvPrefix, node, js, sessionId, request }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(`${PREFIX}: resume requires a non-empty session id`)
  }
  return codexArgvPrefix({ argvPrefix, node, js })
    .concat('exec', 'resume', sessionId, '-', '--json', '--skip-git-repo-check')
    .concat(codexInvocationArgs(request), CODEX_FIXED_SANDBOX_ARGV)
}

/**
 * Run one `codex exec [resume]` process and resolve the unified ChannelResult.
 * Parses the JSONL event stream from stdout (thread.started / item.completed /
 * turn.completed / turn.failed / error) and collects stderr for diagnostics.
 */
export async function runCodexExec({ env, request, resumeSessionId, capabilities: capabilitiesOverride }) {
  const cwd = request.cwd ?? request.parentCwd ?? env.cwd
  if (!cwd) throw new Error(`${PREFIX}: no working directory — set cwd or parentCwd`)
  const { argvPrefix } = await resolveCodexEntry(env, request)
  const argv =
    resumeSessionId === undefined
      ? codexExecArgv({ argvPrefix, cwd, request })
      : codexExecResumeArgv({ argvPrefix, sessionId: resumeSessionId, request })
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

  let finalText = ''
  let sawTurnCompleted = false
  let sawTurnFailed = false
  let sawError = false
  let startedThreadId
  let lineBuffer = ''
  let aborted = false

  const parseLine = (line) => {
    if (!line) return
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return
    }
    if (!event || typeof event !== 'object') return
    if (event.type === 'item.completed' && event.item && event.item.type === 'agent_message' && typeof event.item.text === 'string') {
      finalText = finalText ? `${finalText}\n${event.item.text}` : event.item.text
    } else if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      startedThreadId = event.thread_id
    } else if (event.type === 'turn.completed' || event.type === 'thread.completed') {
      sawTurnCompleted = true
    } else if (event.type === 'turn.failed') {
      sawTurnFailed = true
    } else if (event.type === 'error') {
      sawError = true
      const message =
        (typeof event.message === 'string' && event.message) ||
        (event.error && String(event.error)) ||
        'codex reported an error'
      finalText = finalText ? `${finalText}\n[codex error] ${message}` : `[codex error] ${message}`
    }
  }

  if (handle.stdout) {
    handle.stdout.on('data', (chunk) => {
      lineBuffer += chunk.toString('utf8')
      let idx
      while ((idx = lineBuffer.indexOf('\n')) >= 0) {
        parseLine(lineBuffer.slice(0, idx).trim())
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
    parseLine(lineBuffer.trim())
    lineBuffer = ''
  }
  let stderrTail = ''
  const reader = handle.collected && handle.collected.stderr
  if (reader) {
    try {
      stderrTail = reader.readFrom(0).text
    } catch {}
  }

  const capabilities = capabilitiesOverride ?? codexChannel().capabilities
  const base = {
    channel: CHANNEL_ID,
    runId: `codex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    capabilities,
    ...(startedThreadId === undefined ? {} : { sessionId: startedThreadId }),
  }
  if (aborted) {
    return { ...base, stopReason: 'aborted', output: finalText }
  }
  if (sawError || sawTurnFailed) {
    const tail = (stderrTail || '').trim()
    const extra = tail ? `\n\n[codex stderr]\n${tail.slice(-4000)}` : ''
    return { ...base, stopReason: 'error', output: finalText + extra }
  }
  if (outcome.exitCode === 0 && (sawTurnCompleted || finalText.length > 0)) {
    return {
      ...base,
      stopReason: 'completed',
      output: finalText,
      ...(resumeSessionId === undefined ? {} : { delivery: 'resume_unmanaged', mayBeConcurrent: true }),
    }
  }
  const tail = (stderrTail || '').trim()
  const extra = tail ? `\n\n[codex stderr]\n${tail.slice(-4000)}` : ''
  return { ...base, stopReason: 'error', output: finalText + extra }
}

async function resolveNode(env, configured) {
  if (configured) return configured
  return env.subprocess.resolveExecutable('node').catch(() => {
    throw new Error(`${PREFIX}: cannot locate node`)
  })
}

function validateCodexExecutable(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new Error(`${PREFIX}: codexExecutable must be a non-empty path`)
  }
  if (WINDOWS_SHELL_SHIM_RE.test(value)) {
    throw new Error(`${PREFIX}: codexExecutable must be a real executable, not a shell shim`)
  }
  return value
}

/**
 * Resolve a Codex launch prefix.
 *
 * Native executables and POSIX shebang/symlink launchers are invoked directly,
 * which supports the official macOS installer, Homebrew-style links and Unix
 * npm bin links. Windows npm shell shims remain unsupported by no-shell spawn,
 * so they are translated to the adjacent bin/codex.js entry as before.
 */
export async function resolveCodexEntry(env, request = {}) {
  if (request.codexExecutable !== undefined && request.codexJs !== undefined) {
    throw new Error(`${PREFIX}: configure codexExecutable or codexJs, not both`)
  }

  if (request.codexExecutable !== undefined) {
    const executable = validateCodexExecutable(request.codexExecutable)
    return { argvPrefix: [executable], executable }
  }

  if (request.codexJs !== undefined) {
    const node = await resolveNode(env, request.nodeExecutable)
    return { argvPrefix: [node, request.codexJs], node, js: request.codexJs }
  }

  let executable
  try {
    executable = await env.subprocess.resolveExecutable('codex')
  } catch {}
  if (typeof executable !== 'string' || executable.length === 0) {
    throw new Error(
      `${PREFIX}: cannot locate the Codex CLI — install it or set codexExecutable/codexJs`,
    )
  }

  if (!WINDOWS_SHELL_SHIM_RE.test(executable)) {
    return { argvPrefix: [executable], executable }
  }

  const sep = Math.max(executable.lastIndexOf('\\'), executable.lastIndexOf('/'))
  const dir = sep >= 0 ? executable.slice(0, sep) : ''
  const js = dir ? env.path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : undefined
  if (js !== undefined && env.fs.existsSync(js)) {
    const node = await resolveNode(env, request.nodeExecutable)
    return { argvPrefix: [node, js], node, js }
  }
  throw new Error(
    `${PREFIX}: codex resolves to a Windows shell shim (${executable}) but bin/codex.js was not found; set codexExecutable or codexJs`,
  )
}

/**
 * Create the LIGHTWEIGHT codex channel adapter: run + resume only, via
 * `codex exec` / `codex exec resume`. Session capabilities (list/read/
 * managed/steer/cancel) live in `createCodexAppServerChannel` (import
 * `@dsh-subagent-code-agents/channel-codex/app-server`); this lightweight
 * adapter does NOT claim them, so capability flags always match methods.
 */
export function createCodexChannel(options = {}) {
  /** @type {import('@dsh-subagent-code-agents/core').CodingAgentChannel} */
  const channel = {
    id: CHANNEL_ID,
    displayName: 'OpenAI Codex',
    capabilities: {
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
      sandboxBypassGuaranteed: true,
    },
    async run(request, env) {
      return runCodexExec({
        env,
        request: { ...request, ...(options.codexExecutable ? { codexExecutable: options.codexExecutable } : {}), ...(options.nodeExecutable ? { nodeExecutable: options.nodeExecutable } : {}), ...(options.codexJs ? { codexJs: options.codexJs } : {}) },
        resumeSessionId: request.resumeSessionId,
      })
    },
    async resume(request, env) {
      return runCodexExec({
        env,
        request: { ...request, ...(options.codexExecutable ? { codexExecutable: options.codexExecutable } : {}), ...(options.nodeExecutable ? { nodeExecutable: options.nodeExecutable } : {}), ...(options.codexJs ? { codexJs: options.codexJs } : {}) },
        resumeSessionId: request.resumeSessionId ?? request.sessionId,
      })
    },
  }
  return channel
}

// Deferred app-server import (session tools) — loaded lazily to keep the
// run/resume path free of the app-server dependency.
let appServerChannelPromise
function getAppServerChannel(options) {
  if (appServerChannelPromise === undefined) {
    appServerChannelPromise = import('./app-server-channel.js').then((m) =>
      m.createCodexAppServerChannel(options),
    )
  }
  return appServerChannelPromise
}

/**
 * Register the codex channel (run/resume only) on the shared registry.
 * Session tools (list/read/start/send/steer) are attached by the plugin via
 * `createCodexAppServerChannel` when the app-server integration is mounted.
 */
export function registerCodexChannel(options = {}) {
  const channel = createCodexChannel(options)
  return tryRegister(channel)
}

let _sharedChannel
/** Get or create the shared codex channel used by tool mounting. */
export function codexChannel(options = {}) {
  if (_sharedChannel === undefined) {
    _sharedChannel = createCodexChannel(options)
  }
  return _sharedChannel
}
