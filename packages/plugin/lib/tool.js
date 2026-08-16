/**
 * dsh-subagent-code-agents — tool layer.
 *
 * Exposes the `subagent_code` delegation tool plus the `coding_sessions_list /
 * coding_session_read / coding_session_start / coding_session_send` session
 * tools. Every tool REQUIRES a `channel` field; channels are looked up in the
 * shared registry (env-bound adapters registered by the provider layer).
 * Capability gaps produce an explicit structured `unsupported` refusal — never
 * a silent ignore, never a fallback. The legacy `subagent_codex` tool name is
 * intentionally not used.
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { settleRun } from '@deepseek-ai/dsh-subagent'
import { hasCapability, registry, unsupported } from '@dsh-subagent-code-agents/core'

export const name = 'tool-subagent-code-agents'
export const inject = ['tools', 'subagents']

export const Config = z.object({
  providerPrefix: z.string().default('coding-agent'),
  enableRunInBackground: z.boolean().default(true),
})

function outputValueText(values) {
  if (typeof values === 'string') return values
  if (!Array.isArray(values)) return String(values ?? '')
  return (values || [])
    .filter((v) => typeof v === 'object' && v !== null && v.type === 'text' && typeof v.text === 'string')
    .map((v) => v.text)
    .join('')
}

async function settleStart(start, signal) {
  try {
    return await settleRun(await start)
  } catch (error) {
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

function clampInt(value, min, max, fallback) {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function apply(ctx, config = {}) {
  const providerPrefix = config.providerPrefix ?? 'coding-agent'
  const backgroundEnabled = config.enableRunInBackground !== false
  const disposers = []

  const mountSubagentCode = () => {
    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'subagent_code',
          description:
            'Delegate a self-contained coding task to a coding-agent channel (codex | claude-code | grok-build). channel, description and prompt are required; model/reasoning_effort/resume_session_id are optional per-call overrides.' +
            (backgroundEnabled
              ? ' Set run_in_background to return a job id; collect with job_output and stop with job_kill.'
              : ' The call waits for the result.'),
          parameters: {
            channel: {
              type: 'string',
              required: true,
              description: 'Channel id: codex | claude-code | grok-build.',
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
              description: 'Optional per-call model override; unsupported by the channel → explicit refusal.',
            },
            reasoning_effort: {
              type: 'string',
              description: 'Optional per-call reasoning-effort override; unsupported by the channel → explicit refusal.',
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
                      ? `started background subagent task ${value.jobId}`
                      : outputValueText(value?.output) || JSON.stringify(value),
              },
            ],
          },
          isConcurrencySafe: () => true,
          async execute(args, exec) {
            if (!exec || !exec.agent) {
              throw new Error('subagent_code requires a calling agent')
            }
            const channel = channelFor(args, ctx.logger)
            // Capability gates — explicit refusal, never fallback.
            if (args.resume_session_id !== undefined && !hasCapability(channel, 'resume')) {
              return unsupported(channel.id, 'resume', channel.capabilities)
            }
            if (args.model !== undefined && !hasCapability(channel, 'modelOverride')) {
              return unsupported(channel.id, 'modelOverride', channel.capabilities)
            }
            if (args.reasoning_effort !== undefined && !hasCapability(channel, 'effortOverride')) {
              return unsupported(channel.id, 'effortOverride', channel.capabilities)
            }
            if (!hasCapability(channel, 'run')) {
              return unsupported(channel.id, 'run', channel.capabilities)
            }
            const request = {
              label: args.description,
              prompt: [{ type: 'text', text: args.prompt }],
              parent: exec.agent,
              model: args.model,
              reasoningEffort: args.reasoning_effort,
              resumeSessionId: args.resume_session_id,
              cwd: parentCwdOf(exec),
            }
            const providerName = `${providerPrefix}/${channel.id}`
            if (args.run_in_background === true) {
              if (!backgroundEnabled) throw new Error('run_in_background is disabled for subagent_code')
              const jobs = ctx.get('jobs')
              if (jobs === undefined) {
                throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
              }
              return {
                kind: 'background',
                jobId: jobs.start({
                  kind: 'subagent',
                  label: args.description,
                  owner: exec.agent,
                  run: () => {
                    const controller = new AbortController()
                    return {
                      cancel: (reason) => controller.abort(reason ?? 'background subagent task killed'),
                      done: settleStart(
                        ctx.subagents.start(providerName, { ...request, signal: controller.signal }),
                        controller.signal,
                      ),
                    }
                  },
                }),
              }
            }
            const run = await ctx.subagents.start(providerName, { ...request, signal: exec.signal })
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
          model: { type: 'string', description: 'Optional model override.' },
          reasoning_effort: { type: 'string', description: 'Optional reasoning-effort override.' },
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
            // coding_session_send is a shared read-decide-act mutation on a
            // session; keep it serial. The rest are read-only or create-only.
            isConcurrencySafe: () => toolName !== 'coding_session_send',
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

  mountSubagentCode()
  mountSessionTools()
  ctx.on('dispose', () => {
    const fns = disposers.splice(0)
    Promise.allSettled(fns.map((fn) => Promise.resolve().then(() => fn()))).catch(() => {})
  })
}
