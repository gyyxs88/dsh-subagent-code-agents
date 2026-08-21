/**
 * dsh-subagent-code-agents — tool layer.
 *
 * Exposes the `subagent_code` delegation tool, session tools, and a small
 * persistent registry for background runs owned by this plugin. Channels are
 * looked up in the shared registry (env-bound adapters registered by the
 * provider layer).
 * Capability gaps produce an explicit structured `unsupported` refusal — never
 * a silent ignore, never a fallback. The legacy `subagent_codex` tool name is
 * intentionally not used.
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { hasCapability, normalizeExecutionPolicy, registry, unsupported } from '@dsh-subagent-code-agents/core'
import { loadRoleRegistry, resolveRoleInvocation } from './roles.js'
import { defaultRunRegistryPath, jobOutcomeFor, OwnedRunRegistry, sharedOwnedRunRegistry } from './owned-runs.js'

export const name = 'tool-subagent-code-agents'
export const inject = ['tools', 'subagents']

export const toolNames = Object.freeze([
  'subagent_code',
  'coding_sessions_list',
  'coding_session_read',
  'coding_session_start',
  'coding_session_send',
  'coding_session_cancel',
  'coding_runs_list',
  'coding_run_read',
  'coding_run_resume',
  'coding_run_cancel',
])

export const Config = z.object({
  providerPrefix: z.string().default('coding-agent'),
  enableRunInBackground: z.boolean().default(true),
  runRegistryPath: z.string(),
  rolesFile: z.string(),
  roles: z.array(z.object({
    id: z.string(),
    channel: z.string(),
    model: z.string(),
    reasoningEffort: z.string(),
    instructions: z.string(),
    allowDelegation: z.boolean().default(true),
  })).default([]),
})

function outputValueText(values) {
  if (typeof values === 'string') return values
  if (!Array.isArray(values)) return String(values ?? '')
  return (values || [])
    .filter((v) => typeof v === 'object' && v !== null && v.type === 'text' && typeof v.text === 'string')
    .map((v) => v.text)
    .join('')
}

async function settleOwnedStart(start, signal, ownedRuns, runId) {
  let run
  try {
    run = await start
    const result = await run.result
    try {
      await run.dispose()
    } catch (error) {
      ownedRuns.fail(runId, `dispose failed: ${String(error)}`, signal.aborted)
      return { status: 'failed', detail: `dispose failed: ${String(error)}` }
    }
    ownedRuns.settle(runId, result)
    return jobOutcomeFor(result)
  } catch (error) {
    try { await run?.dispose?.() } catch {}
    ownedRuns.fail(runId, error, signal.aborted)
    return signal.aborted ? { status: 'killed' } : { status: 'failed', detail: String(error) }
  }
}

async function settleForegroundRun(run) {
  const [execution] = await Promise.allSettled([run.result])
  // Always dispose the run handle, success or failure, to honor DSH's
  // cancellation/cleanup contract.
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    throw execution.reason
  }
  const result = execution.value
  if (result.stopReason !== 'completed') {
    const text = outputValueText(result.output)
    throw new Error(text || `subagent run failed (${result.stopReason})`)
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return result
}

/** Resolve the env-bound channel adapter for a tool call; throws on unknown. */
function channelFor(args, logger) {
  const channel = registry.get(args.channel)
  if (channel === undefined) {
    const known = registry.list().map((c) => c.id).join(', ')
    throw new Error(`unknown channel "${args.channel}" — registered: ${known || '(none)'}`)
  }
  return channel
}

/** Parent cwd from the exec agent (used for session tools' same-cwd default). */
function parentCwdOf(exec) {
  const agent = exec?.agent
  const session = agent && agent.session
  const header = session && session.header
  const meta = session && session.meta
  return (header && header.cwd) || (meta && meta.cwd)
}

function executionPolicyForAgent(exec, request, config) {
  const resolved = typeof config.executionPolicyResolver === 'function'
    ? config.executionPolicyResolver({ exec, request })
    : undefined
  if (resolved !== undefined) return normalizeExecutionPolicy(resolved, { cwd: request.cwd ?? parentCwdOf(exec) })
  const agent = exec?.agent
  const permission = agent?.permission?.preset
    ?? agent?.session?.permission?.preset
    ?? agent?.session?.permissionPreset
    ?? agent?.session?.meta?.permissionPreset
    ?? agent?.session?.header?.permissionPreset
  if (permission === undefined) return undefined
  return normalizeExecutionPolicy({
    permission,
    workspaceRoot: request.cwd ?? parentCwdOf(exec),
    approvalOwner: permission === 'danger-full-access' ? 'full-access-controller' : 'target-session',
    approvalMode: permission === 'danger-full-access' ? 'controller-fingerprint' : 'target-session',
    sourceSessionId: agent?.session?.id,
    targetSessionId: agent?.session?.id,
    approvalHandler: config.approvalHandler ?? agent?.approvalHandler,
  }, { cwd: request.cwd ?? parentCwdOf(exec) })
}

function clampInt(value, min, max, fallback) {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function apply(ctx, config = {}, injected = {}) {
  // Explicit Cordis mounts resolve this through the plugin's own injected
  // context. The host auto-mount policy passes its already-injected service
  // because an agent scope may intentionally isolate `subagents`.
  const subagents = injected.subagents ?? ctx.subagents
  const providerPrefix = config.providerPrefix ?? 'coding-agent'
  const backgroundEnabled = config.enableRunInBackground !== false
  const roles = loadRoleRegistry(config)
  const runRegistryPath = defaultRunRegistryPath(config)
  const ownedRuns = runRegistryPath ? sharedOwnedRunRegistry({
    filePath: runRegistryPath,
    logger: ctx.logger,
  }) : new OwnedRunRegistry({ logger: ctx.logger })
  const ownedRunIds = new Set()
  const disposers = []

  const requireJobs = () => {
    const jobs = ctx.get('jobs')
    if (jobs === undefined) {
      throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
    }
    return jobs
  }

  const startOwnedBackground = ({
    jobs,
    providerName,
    request,
    owner,
    channel,
    label,
    role,
    model,
    reasoningEffort,
    sessionId,
    resumedFrom,
  }) => {
    const record = ownedRuns.create({
      channel: channel.id,
      label,
      role,
      cwd: request.cwd,
      model,
      reasoningEffort,
      sessionId,
      resumedFrom,
    })
    const controller = new AbortController()
    ownedRunIds.add(record.id)
    ownedRuns.attach(record.id, { controller })
    let jobId
    try {
      jobId = jobs.start({
        kind: 'subagent',
        label,
        owner,
        run: () => ({
          cancel: (reason) => controller.abort(reason ?? 'background subagent task killed'),
          done: settleOwnedStart(
            subagents.start(providerName, { ...request, signal: controller.signal }),
            controller.signal,
            ownedRuns,
            record.id,
          ),
        }),
      })
    } catch (error) {
      ownedRuns.fail(record.id, error)
      throw error
    }
    ownedRuns.setJobId(record.id, jobId)
    return { kind: 'background', jobId, runId: record.id }
  }

  const mountSubagentCode = () => {
    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'subagent_code',
          description:
            'Delegate a self-contained coding task to a registered coding-agent channel. Supply channel directly, or a configured role that fixes the channel and may provide model/effort/instructions. Explicit model/reasoning_effort override role defaults; a role/channel mismatch is rejected.' +
            (backgroundEnabled
              ? ' Set run_in_background to return a job id; collect with job_output and stop with job_kill.'
              : ' The call waits for the result.'),
          parameters: {
            channel: {
              type: 'string',
              description: 'Registered channel id. Required without role; omit it when role supplies the channel. Never put a role id here.',
            },
            role: {
              type: 'string',
              description: 'Optional configured role id. When set, normally omit channel; unknown roles and mismatched explicit channels are rejected.',
            },
            description: {
              type: 'string',
              required: true,
              description: 'A short (3-5 word) description of the delegated task, for display.',
            },
            prompt: {
              type: 'string',
              required: true,
              description: 'The complete, self-contained task. It does not share this conversation, so include everything it needs.',
            },
            model: {
              type: 'string',
              description: 'Optional exact per-call model id; for Codex use the full id (for example gpt-5.6-sol), never an abbreviation such as sol. Unsupported by the channel → explicit refusal.',
            },
            reasoning_effort: {
              type: 'string',
              description: 'Optional per-call reasoning-effort override (for example xhigh); unsupported by the channel → explicit refusal.',
            },
            resume_session_id: {
              type: 'string',
              description: 'Optional session/thread id to resume instead of a fresh run.',
            },
            ...(backgroundEnabled
              ? {
                  run_in_background: {
                    type: 'boolean',
                    description: 'Whether to run as a background job and return its id.',
                  },
                }
              : {}),
          },
          output: {
            schema: { type: 'json' },
            render: (_args, value) => [
              {
                type: 'text',
                text:
                  typeof value === 'string'
                    ? value
                    : value?.kind === 'background'
                      ? `started background subagent task ${value.jobId} (owned run ${value.runId})`
                      : outputValueText(value?.output) || JSON.stringify(value),
              },
            ],
          },
          isConcurrencySafe: () => true,
          async execute(args, exec) {
            if (!exec || !exec.agent) {
              throw new Error('subagent_code requires a calling agent')
            }
            const invocation = resolveRoleInvocation(args, roles)
            const channel = channelFor({ channel: invocation.channel }, ctx.logger)
            // Capability gates — explicit refusal, never fallback.
            if (args.resume_session_id !== undefined && !hasCapability(channel, 'resume')) {
              return unsupported(channel.id, 'resume', channel.capabilities)
            }
            if (invocation.model !== undefined && !hasCapability(channel, 'modelOverride')) {
              return unsupported(channel.id, 'modelOverride', channel.capabilities)
            }
            if (invocation.reasoningEffort !== undefined && !hasCapability(channel, 'effortOverride')) {
              return unsupported(channel.id, 'effortOverride', channel.capabilities)
            }
            if (!hasCapability(channel, 'run')) {
              return unsupported(channel.id, 'run', channel.capabilities)
            }
            const request = {
              label: args.description,
              prompt: [{ type: 'text', text: invocation.prompt }],
              parent: exec.agent,
              model: invocation.model,
              reasoningEffort: invocation.reasoningEffort,
              resumeSessionId: args.resume_session_id,
              cwd: parentCwdOf(exec),
              executionPolicy: executionPolicyForAgent(exec, { cwd: parentCwdOf(exec) }, config),
            }
            const providerName = `${providerPrefix}/${channel.id}`
            if (args.run_in_background === true) {
              if (!backgroundEnabled) throw new Error('run_in_background is disabled for subagent_code')
              return startOwnedBackground({
                jobs: requireJobs(),
                providerName,
                request,
                owner: exec.agent,
                channel,
                label: args.description,
                role: invocation.role,
                model: invocation.model,
                reasoningEffort: invocation.reasoningEffort,
                sessionId: args.resume_session_id,
              })
            }
            const run = await subagents.start(providerName, { ...request, signal: exec.signal })
            return settleForegroundRun(run)
          },
        }),
      ),
    )
  }

  const mountSessionTools = () => {
    const definitions = {
      coding_sessions_list: {
        description:
          'List coding-agent sessions for a channel. Defaults to the caller cwd; pass include_all to span projects. Returns bounded id/preview/cwd/source/status/updatedAt plus honest delivery state and capabilities.',
        parameters: {
          channel: { type: 'string', required: true, description: 'Channel id: codex | claude-code | grok-build.' },
          include_all: { type: 'boolean', description: 'List across all projects (defaults to caller cwd only).' },
          limit: { type: 'number', description: 'Max sessions to return (default 50).' },
        },
        async execute(args, _exec, channel) {
          if (!hasCapability(channel, 'listSessions') || typeof channel.listSessions !== 'function') {
            return unsupported(channel.id, 'listSessions', channel.capabilities)
          }
          return channel.listSessions({
            cwd: parentCwdOf(_exec),
            includeAll: args.include_all === true,
            limit: clampInt(args.limit, 1, 100, 50),
          })
        },
      },
      coding_session_read: {
        description:
          'Read a stored coding-agent session via the channel (never resumes). Returns bounded recent history, honest delivery state and capabilities.',
        parameters: {
          channel: { type: 'string', required: true, description: 'Channel id.' },
          session_id: { type: 'string', required: true, description: 'Session/thread id to read.' },
          max_turns: { type: 'number', description: 'Max recent turns to return (default 20).' },
        },
        async execute(args, _exec, channel) {
          if (!hasCapability(channel, 'readSession') || typeof channel.readSession !== 'function') {
            return unsupported(channel.id, 'readSession', channel.capabilities)
          }
          return channel.readSession({
            sessionId: args.session_id,
            maxTurns: clampInt(args.max_turns, 1, 20, undefined),
          })
        },
      },
      coding_session_start: {
        description:
          'Start a NEW managed coding-agent session on the channel. Returns sessionId/turnId with managed delivery.',
        parameters: {
          channel: { type: 'string', required: true, description: 'Channel id.' },
          prompt: { type: 'string', required: true, description: 'First message text.' },
          model: { type: 'string', description: 'Optional exact model id; for Codex use the full id such as gpt-5.6-sol, never sol.' },
          reasoning_effort: { type: 'string', description: 'Optional reasoning-effort override, for example xhigh.' },
          cwd: { type: 'string', description: 'Optional working directory; defaults to caller cwd.' },
        },
        async execute(args, exec, channel) {
          if (!hasCapability(channel, 'managedSession') || typeof channel.startManagedSession !== 'function') {
            return unsupported(channel.id, 'managedSession', channel.capabilities)
          }
          if (args.model !== undefined && !hasCapability(channel, 'modelOverride')) {
            return unsupported(channel.id, 'modelOverride', channel.capabilities)
          }
          if (args.reasoning_effort !== undefined && !hasCapability(channel, 'effortOverride')) {
            return unsupported(channel.id, 'effortOverride', channel.capabilities)
          }
          return channel.startManagedSession({
            cwd: args.cwd ?? parentCwdOf(exec),
            prompt: args.prompt,
            model: args.model,
            reasoningEffort: args.reasoning_effort,
            executionPolicy: executionPolicyForAgent(exec, { cwd: args.cwd ?? parentCwdOf(exec) }, config),
          })
        },
      },
      coding_session_send: {
        description:
          'Send a message to a coding-agent session. Managed sessions are steered in place while active; unmanaged/not-loaded sessions are refused (use resume_session_id on subagent_code instead). Never auto-falls back.',
        parameters: {
          channel: { type: 'string', required: true, description: 'Channel id.' },
          session_id: { type: 'string', required: true, description: 'Session/thread id to send to.' },
          prompt: { type: 'string', required: true, description: 'Message text.' },
        },
        async execute(args, _exec, channel) {
          if (!hasCapability(channel, 'steerActive') || typeof channel.steerActive !== 'function') {
            return unsupported(channel.id, 'steerActive', channel.capabilities)
          }
          return channel.steerActive({ sessionId: args.session_id, input: args.prompt })
        },
      },
      coding_session_cancel: {
        description:
          'Cancel the active turn of a managed coding-agent session. Only a turn owned by this live plugin process can be cancelled; external, idle and mismatched runs are refused.',
        parameters: {
          channel: { type: 'string', required: true, description: 'Channel id.' },
          session_id: { type: 'string', required: true, description: 'Managed session/thread id.' },
          run_id: { type: 'string', description: 'Optional active run id for strict ownership matching.' },
          reason: { type: 'string', description: 'Optional cancellation reason.' },
        },
        async execute(args, _exec, channel) {
          if (!hasCapability(channel, 'cancel') || typeof channel.cancel !== 'function') {
            return unsupported(channel.id, 'cancel', channel.capabilities)
          }
          return channel.cancel({
            sessionId: args.session_id,
            runId: args.run_id,
            reason: args.reason,
          })
        },
      },
    }

    for (const [toolName, def] of Object.entries(definitions)) {
      disposers.push(
        ctx.tools.register(
          defineTool({
            name: toolName,
            description: def.description,
            parameters: def.parameters,
            output: {
              schema: { type: 'json' },
              render: (_args, value) => [
                { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
              ],
            },
            // Send and cancel are shared read-decide-act mutations on a
            // managed session; keep them serial. The rest are read-only or
            // create-only.
            isConcurrencySafe: () =>
              toolName !== 'coding_session_send' && toolName !== 'coding_session_cancel',
            async execute(args, exec) {
              if (!exec || !exec.agent) {
                throw new Error(`${toolName} requires a calling agent`)
              }
              const channel = channelFor(args, ctx.logger)
              return def.execute(args, exec, channel)
            },
          }),
        ),
      )
    }
  }

  const mountRunTools = () => {
    const definitions = {
      coding_runs_list: {
        description:
          'List background coding-agent runs owned by this plugin. Restarted running records are shown as interrupted, never active. continuation is resume_available only when a stored session and a resumable channel both exist.',
        parameters: {
          channel: { type: 'string', description: 'Optional exact channel id filter.' },
          status: { type: 'string', description: 'Optional status filter: running | settled | interrupted.' },
          limit: { type: 'number', description: 'Maximum rows (default 50, max 100).' },
        },
        execute(args) {
          return ownedRuns.list({
            channel: args.channel,
            status: args.status,
            limit: clampInt(args.limit, 1, 100, 50),
            channelRegistry: registry,
          })
        },
      },
      coding_run_read: {
        description: 'Read one plugin-owned background run record. Prompts are intentionally never persisted.',
        parameters: {
          run_id: { type: 'string', required: true, description: 'Owned run id returned by subagent_code.' },
        },
        execute(args) {
          const record = ownedRuns.read(args.run_id, registry)
          if (!record) throw new Error(`unknown owned run "${args.run_id}"`)
          return record
        },
      },
      coding_run_resume: {
        description:
          'Continue a settled/interrupted plugin-owned run as a NEW background run. Requires a stored session id and current channel resume support; never pretends an old process survived restart.',
        parameters: {
          run_id: { type: 'string', required: true, description: 'Prior owned run id.' },
          prompt: { type: 'string', required: true, description: 'New continuation message; never persisted.' },
          description: { type: 'string', description: 'Optional short job label.' },
          model: { type: 'string', description: 'Optional model override for this continuation.' },
          reasoning_effort: { type: 'string', description: 'Optional reasoning-effort override for this continuation.' },
        },
        execute(args, exec) {
          const previous = ownedRuns.read(args.run_id, registry)
          if (!previous) throw new Error(`unknown owned run "${args.run_id}"`)
          if (previous.continuation !== 'resume_available') {
            return {
              accepted: false,
              runId: args.run_id,
              status: previous.status,
              continuation: previous.continuation,
              reason: 'stored run cannot be resumed by the current channel',
            }
          }
          const roleArgs = previous.role
            ? {
                role: previous.role,
                channel: previous.channel,
                prompt: args.prompt,
                model: args.model ?? previous.model,
                reasoning_effort: args.reasoning_effort ?? previous.reasoningEffort,
              }
            : {
                channel: previous.channel,
                prompt: args.prompt,
                model: args.model ?? previous.model,
                reasoning_effort: args.reasoning_effort ?? previous.reasoningEffort,
              }
          const invocation = resolveRoleInvocation(roleArgs, roles)
          const channel = channelFor({ channel: invocation.channel }, ctx.logger)
          if (!hasCapability(channel, 'resume')) return unsupported(channel.id, 'resume', channel.capabilities)
          if (invocation.model !== undefined && !hasCapability(channel, 'modelOverride')) {
            return unsupported(channel.id, 'modelOverride', channel.capabilities)
          }
          if (invocation.reasoningEffort !== undefined && !hasCapability(channel, 'effortOverride')) {
            return unsupported(channel.id, 'effortOverride', channel.capabilities)
          }
          const label = args.description ?? `resume ${previous.label}`
          const request = {
            label,
            prompt: [{ type: 'text', text: invocation.prompt }],
            parent: exec.agent,
            model: invocation.model,
            reasoningEffort: invocation.reasoningEffort,
            resumeSessionId: previous.sessionId,
            cwd: previous.cwd ?? parentCwdOf(exec),
            executionPolicy: executionPolicyForAgent(exec, { cwd: previous.cwd ?? parentCwdOf(exec) }, config),
          }
          return startOwnedBackground({
            jobs: requireJobs(),
            providerName: `${providerPrefix}/${channel.id}`,
            request,
            owner: exec.agent,
            channel,
            label,
            role: invocation.role,
            model: invocation.model,
            reasoningEffort: invocation.reasoningEffort,
            sessionId: previous.sessionId,
            resumedFrom: previous.id,
          })
        },
      },
      coding_run_cancel: {
        description:
          'Cancel a plugin-owned run only when it is active in this process. Persisted runs from an earlier process are refused explicitly.',
        parameters: {
          run_id: { type: 'string', required: true, description: 'Owned run id.' },
          reason: { type: 'string', description: 'Optional cancellation reason.' },
        },
        execute(args) {
          return ownedRuns.cancel(args.run_id, args.reason)
        },
      },
    }
    for (const [toolName, def] of Object.entries(definitions)) {
      disposers.push(
        ctx.tools.register(
          defineTool({
            name: toolName,
            description: def.description,
            parameters: def.parameters,
            output: {
              schema: { type: 'json' },
              render: (_args, value) => [
                { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
              ],
            },
            isConcurrencySafe: () => toolName !== 'coding_run_resume' && toolName !== 'coding_run_cancel',
            async execute(args, exec) {
              if (!exec || !exec.agent) throw new Error(`${toolName} requires a calling agent`)
              return def.execute(args, exec)
            },
          }),
        ),
      )
    }
  }

  mountSubagentCode()
  mountSessionTools()
  mountRunTools()
  let disposal
  const dispose = () => disposal ??= (async () => {
    const fns = disposers.splice(0)
    const toolDisposals = fns.map((fn) => {
      try {
        return fn()
      } catch (error) {
        return Promise.reject(error)
      }
    })
    await Promise.allSettled([
      ownedRuns.dispose(ownedRunIds),
      ...toolDisposals,
    ])
  })()
  ctx.on('dispose', dispose)
  return dispose
}
