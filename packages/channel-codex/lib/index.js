/**
 * @dsh-subagent-code-agents/channel-codex
 *
 * Codex channel adapter for the multi-channel coding-agent core. Runs the
 * OpenAI Codex CLI (`codex exec` / `codex exec resume`) plus a long-lived
 * `codex app-server` for managed sessions, behind the shared
 * `CodingAgentChannel` interface. No DSH/Cordis dependency — everything is
 * injected via `RuntimeEnv` (`subprocess`, `fs`, `path`, `logger`, `signal`).
 *
 * Security policy is inherited from the target DSH Session. Only Full Access
 * emits bypass/dangerFullAccess arguments; restricted requests use the
 * channel's official approval and sandbox profiles and fail closed when the
 * target-session approval bridge is unavailable.
 */

import { emptyCapabilities, executionPolicyFor, registry, supportsExecutionPolicy, tryRegister, unsupportedPermissionPolicy } from '@dsh-subagent-code-agents/core'

export const CHANNEL_ID = 'codex'
export const CODEX_REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'ultra', 'max'])
export const CODEX_FIXED_SANDBOX_ARGV = Object.freeze(['--dangerously-bypass-approvals-and-sandbox'])

export function codexExecutionPolicyArgv(policy) {
  if (!policy || typeof policy.permission !== 'string') throw new Error(`${PREFIX}: execution policy is required`)
  if (policy.permission === 'danger-full-access') return [...CODEX_FIXED_SANDBOX_ARGV]
  if (policy.permission === 'read-only') return ['--sandbox', 'read-only', '--ask-for-approval', 'on-request']
  if (policy.permission === 'workspace-write') return ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request']
  throw new Error(`${PREFIX}: unsupported permission policy ${policy.permission}`)
}

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
 * Build the complete `codex exec` argv deterministically from the inherited
 * execution policy. The bypass constant is only valid for Full Access.
 */
export function codexExecArgv({ argvPrefix, node, js, cwd, request, executionPolicy }) {
  return codexArgvPrefix({ argvPrefix, node, js })
    .concat('exec', '--json', '--skip-git-repo-check', '--color', 'never', '-C', cwd)
    .concat(codexInvocationArgs(request), codexExecutionPolicyArgv(executionPolicy))
}

/**
 * Build the complete `codex exec resume` argv. `resume` has its own option set:
 * no `--color`, no `-C`; prompt is sent on stdin (`-`).
 */
export function codexExecResumeArgv({ argvPrefix, node, js, sessionId, request, executionPolicy }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(`${PREFIX}: resume requires a non-empty session id`)
  }
  return codexArgvPrefix({ argvPrefix, node, js })
    .concat('exec', 'resume', sessionId, '-', '--json', '--skip-git-repo-check')
    .concat(codexInvocationArgs(request), codexExecutionPolicyArgv(executionPolicy))
}

/**
 * Run one `codex exec [resume]` process and resolve the unified ChannelResult.
 * Parses the JSONL event stream from stdout (thread.started / item.completed /
 * turn.completed / turn.failed / error) and collects stderr for diagnostics.
 */
export async function runCodexExec({ env, request, resumeSessionId, capabilities: capabilitiesOverride }) {
  const cwd = request.cwd ?? request.parentCwd ?? env.cwd
  if (!cwd) throw new Error(`${PREFIX}: no working directory — set cwd or parentCwd`)
  const policy = executionPolicyFor(request, env, cwd)
  const capabilities = capabilitiesOverride ?? codexChannel().capabilities
  if (!supportsExecutionPolicy({ capabilities }, policy)) return unsupportedPermissionPolicy(CHANNEL_ID, policy, capabilities)
  if (policy.permission === 'workspace-write' && typeof policy.approvalHandler !== 'function') return unsupportedPermissionPolicy(CHANNEL_ID, policy, capabilities, 'Codex CLI has no target-session approval bridge for Workspace Write')
  const { argvPrefix } = await resolveCodexEntry(env, request)
  const argv =
    resumeSessionId === undefined
      ? codexExecArgv({ argvPrefix, cwd, request, executionPolicy: policy })
      : codexExecResumeArgv({ argvPrefix, sessionId: resumeSessionId, request, executionPolicy: policy })
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
      env.onUpdate?.({ type: 'text-delta', text: event.item.text })
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
  if (typeof configured !== 'string' || configured.length === 0 || !/^(?:[A-Za-z]:[\\/]|\/)/u.test(configured) || /[\0\r\n]/u.test(configured)) {
    throw new Error(`${PREFIX}: codexJs requires an absolute nodeExecutable; PATH resolution is disabled`)
  }
  return configured
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

  if (env.runtimeManager?.resolveExecutable) {
    const resolved = await env.runtimeManager.resolveExecutable(request.runtimeRequirement ?? env.runtimeRequirement)
    if (typeof resolved?.executable !== 'string' || resolved.executable.length === 0) throw new Error(`${PREFIX}: Runtime Manager returned no absolute Codex executable`)
    return { argvPrefix: [resolved.executable], executable: resolved.executable, runtimeState: resolved.state }
  }

  if (request.codexJs !== undefined) {
    const node = await resolveNode(env, request.nodeExecutable)
    return { argvPrefix: [node, request.codexJs], node, js: request.codexJs }
  }

  throw new Error(`${PREFIX}: Runtime Manager must provide an absolute Codex executable; PATH resolution is disabled`)
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
      executionPolicies: { 'read-only': true, 'workspace-write': true, 'danger-full-access': true },
    },
    async run(request, env) {
      return runCodexExec({
        env,
        request: { ...request, ...(options.codexExecutable ? { codexExecutable: options.codexExecutable } : {}), ...(options.nodeExecutable ? { nodeExecutable: options.nodeExecutable } : {}), ...(options.codexJs ? { codexJs: options.codexJs } : {}), ...(options.runtimeRequirement ? { runtimeRequirement: options.runtimeRequirement } : {}) },
        resumeSessionId: request.resumeSessionId,
      })
    },
    async resume(request, env) {
      return runCodexExec({
        env,
        request: { ...request, ...(options.codexExecutable ? { codexExecutable: options.codexExecutable } : {}), ...(options.nodeExecutable ? { nodeExecutable: options.nodeExecutable } : {}), ...(options.codexJs ? { codexJs: options.codexJs } : {}), ...(options.runtimeRequirement ? { runtimeRequirement: options.runtimeRequirement } : {}) },
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
