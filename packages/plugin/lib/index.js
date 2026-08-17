/**
 * dsh-subagent-code-agents — multi-channel coding-agent subagent plugin.
 *
 * Bridges the channel adapters from @dsh-subagent-code-agents/channel-*
 * (which know nothing about DSH) onto the DSH `subagents` registry as
 * `SubagentProvider`s named `coding-agent/<channel>`. One row per channel,
 * each with its own executable/config. The legacy dsh-subagent-codex plugin
 * registers plain `codex`, so these prefixed names coexist with it.
 *
 * Design notes:
 *   - Channels are pure adapters; this package owns the DSH-facing RuntimeEnv
 *     injection (subprocess/fs/path/logger/signal/cwd).
 *   - One channel failing to mount never blocks the others: registration
 *     errors are recorded per channel and surfaced in the registry.
 *   - Capability gaps are explicit structured refusals — never silent, never
 *     fallback.
 */

import fs from 'node:fs'
import path from 'node:path'
import { registry, tryRegister } from '@dsh-subagent-code-agents/core'
import { createCodexChannel } from '@dsh-subagent-code-agents/channel-codex'
import { createCodexAppServerChannel } from '@dsh-subagent-code-agents/channel-codex/app-server'
import { createClaudeCodeChannel } from '@dsh-subagent-code-agents/channel-claude-code'
import { createGrokBuildChannel } from '@dsh-subagent-code-agents/channel-grok-build'
import { createAcpChannel } from '@dsh-subagent-code-agents/channel-acp'

export const name = 'dsh-subagent-code-agents'
export const inject = ['subagents', 'subprocess']

export const CHANNEL_FACTORIES = Object.freeze({
  // Codex uses the full app-server adapter (run + resume + sessions + steer).
  codex: (cfg) =>
    createCodexAppServerChannel({
      nodeExecutable: cfg.nodeExecutable,
      codexJs: cfg.codexJs,
      appServerRequestTimeoutMs: cfg.appServerRequestTimeoutMs,
      cwd: cfg.cwd,
    }),
  'claude-code': (cfg) => createClaudeCodeChannel({ claudeExecutable: cfg.claudeExecutable }),
  'grok-build': (cfg) => createGrokBuildChannel({ grokExecutable: cfg.grokExecutable }),
  acp: (cfg) => createAcpChannel({
    id: cfg.id ?? cfg.name,
    displayName: cfg.displayName,
    command: cfg.command,
    args: cfg.args,
    env: cfg.env,
    cwd: cfg.cwd,
    requestTimeoutMs: cfg.requestTimeoutMs,
  }),
})

/** Provider name for a channel id: `coding-agent/<id>`. */
export function providerNameFor(channelId) {
  return `coding-agent/${channelId}`
}

/** Build the DSH-facing RuntimeEnv from a Cordis ctx. */
export function runtimeEnvFor(ctx, config = {}) {
  return {
    subprocess: {
      spawn: (spec) => ctx.subprocess.spawn(spec),
      resolveExecutable: (name, env, signal) => ctx.subprocess.resolveExecutable(name, env, signal),
    },
    fs,
    path,
    logger: ctx.logger,
    cwd: config.cwd,
  }
}

/** Map a ChannelResult stopReason onto the DSH subagent contract. */
export function toSubagentStopReason(result) {
  switch (result.stopReason) {
    case 'completed':
      return 'completed'
    case 'aborted':
      return 'aborted'
    case 'unsupported':
    case 'refused':
    case 'error':
    default:
      return 'error'
  }
}

/**
 * Bind a channel's env-dependent methods so the tool layer can call them
 * without passing RuntimeEnv. Methods take (opts) instead of (opts, env).
 */
export function bindChannelEnv(channel, env) {
  const bound = { ...channel }
  if (typeof channel.listSessions === 'function') {
    bound.listSessions = (opts) => channel.listSessions(opts, env)
  }
  if (typeof channel.readSession === 'function') {
    bound.readSession = (opts) => channel.readSession(opts, env)
  }
  if (typeof channel.startManagedSession === 'function') {
    bound.startManagedSession = (opts) => channel.startManagedSession(opts, env)
  }
  if (typeof channel.steerActive === 'function') {
    bound.steerActive = (opts) => channel.steerActive(opts, env)
  }
  if (typeof channel.cancel === 'function') {
    bound.cancel = (opts) => channel.cancel(opts, env)
  }
  return bound
}

/** Wrap a channel adapter as a DSH SubagentProvider (unbound, env passed in). */
export function providerFromChannel(channel, env, providerName) {
  return {
    name: providerName ?? providerNameFor(channel.id),
    capabilities: {
      outputSchema: false,
      depthLimit: false,
      toolFilter: false,
      persona: false,
    },
    inheritsParentContext: false,
    async start(request) {
      const prompt = textOf(request.prompt)
      const runRequest = {
        prompt,
        model: request.model,
        reasoningEffort: request.reasoningEffort,
        resumeSessionId: request.resumeSessionId,
        cwd: request.cwd,
        parentCwd: parentCwdOf(request),
        background: request.background === true,
      }
      const signal = request.signal
      const envWithSignal = { ...env, signal }
      const result = channel
        .run(runRequest, envWithSignal)
        .then((r) => ({
          output: [{ type: 'text', text: r.output }],
          stopReason: toSubagentStopReason(r),
          ...(r.sessionId === undefined ? {} : { sessionId: r.sessionId }),
          ...(r.delivery === undefined ? {} : { delivery: r.delivery }),
          ...(r.mayBeConcurrent === undefined ? {} : { mayBeConcurrent: r.mayBeConcurrent }),
          channel: r.channel,
          capabilities: r.capabilities,
        }))
        .catch((error) => ({
          output: [{ type: 'text', text: `channel ${channel.id} run failed: ${String(error?.message ?? error)}` }],
          stopReason: 'error',
          channel: channel.id,
          capabilities: channel.capabilities,
        }))
      return {
        id: `${channel.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        localAgent: undefined,
        result,
        async dispose() {},
      }
    },
    async dispose() {
      await channel.dispose?.()
    },
  }
}

function textOf(blocks) {
  return (blocks || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

function parentCwdOf(request) {
  // cwd may be passed directly (tool layer) or derived from request.parent.
  if (typeof request.cwd === 'string' && request.cwd.length > 0) return request.cwd
  const session = request.parent && request.parent.session
  const header = session && session.header
  const meta = session && session.meta
  return (header && header.cwd) || (meta && meta.cwd)
}

/**
 * Create one channel adapter from config. Unknown channels throw so the caller
 * can record the failure without blocking other channels.
 */
export function createChannelAdapter(config = {}) {
  const factory = CHANNEL_FACTORIES[config.channel]
  if (!factory) {
    throw new Error(`channel "${config.channel}" is unknown — supported: ${Object.keys(CHANNEL_FACTORIES).join(', ')}`)
  }
  return factory(config)
}

/**
 * Mount one provider row for a single channel and register its env-bound
 * adapter in the shared registry. Returns `{ provider, channel, unregister }`
 * on success; records the error and returns undefined on failure so sibling
 * channels still mount.
 *
 * Lifecycle (Cordis/HMR-safe):
 *   - The provider is registered inside `ctx.effect(...)`; the effect callback
 *     RETURNS an async idempotent cleanup that calls the disposer returned by
 *     `registerProvider`, removes the registry adapter only if it is still
 *     THIS instance's, and awaits `channel.dispose()`.
 *   - `mountChannel().unregister` is the SAME cleanup function, so explicit
 *     unload and effect teardown share one code path.
 *   - A reloading instance atomically REPLACES the registry adapter via
 *     `registry.replace(...)`; the old instance's cleanup identity check can
 *     never delete the new adapter.
 *   - We do NOT rely on `ctx.subagents.unregisterProvider` (its existence is
 *     not part of the verified API).
 */
export function mountChannel(ctx, config = {}) {
  const channelType = config.channel
  if (typeof channelType !== 'string' || channelType.length === 0) {
    ctx.logger.error?.('dsh-subagent-code-agents: row missing `channel`')
    return undefined
  }
  try {
    const channel = createChannelAdapter(config)
    const channelId = channel.id
    const providerName = config.providerName ?? providerNameFor(channelId)
    const env = runtimeEnvFor(ctx, config)
    const provider = providerFromChannel(channel, env, providerName)
    const boundAdapter = bindChannelEnv(channel, env)

    let providerDisposer
    let disposed = false
    let cleanupPromise

    const unregister = () => {
      // Idempotent, awaitable cleanup shared by effect teardown and explicit
      // unload. Runs exactly once.
      if (disposed) return cleanupPromise ?? Promise.resolve()
      disposed = true
      cleanupPromise = (async () => {
        if (typeof providerDisposer === 'function') {
          try {
            await providerDisposer()
          } catch {}
        }
        // Only remove the registry adapter if it is still THIS instance's
        // adapter (a later reload may have replaced it).
        const current = registry.get(channelId)
        if (current !== undefined && current === boundAdapter) {
          registry.unregister(channelId)
        }
        try {
          await channel.dispose?.()
        } catch {}
      })()
      return cleanupPromise
    }

    // Cordis runs effects during startup; the callback MUST return a cleanup.
    ctx.effect(() => {
      providerDisposer = ctx.subagents.registerProvider(provider)
      return unregister
    })

    // Register the env-bound adapter so the tool layer can call session
    // methods without threading RuntimeEnv through every call. Hot reload uses
    // replace() so the new instance atomically takes over the id; a stale
    // cleanup identity check can never remove the new adapter.
    const reg = registry.has(channelId) ? registry.replace(boundAdapter) : tryRegister(boundAdapter)
    if (reg instanceof Error) {
      ctx.logger.warn?.(`dsh-subagent-code-agents: channel ${channelId} registry error: ${reg.message}`)
    }

    // Register the cleanup so dispose/hot-reload tears down this instance.
    if (typeof ctx.on === 'function') {
      ctx.on('dispose', () => {
        unregister().catch(() => {})
      })
    }

    ctx.logger.info?.(`dsh-subagent-code-agents: registered provider ${providerName}`)
    return { provider, channel, unregister }
  } catch (error) {
    ctx.logger.error?.(`dsh-subagent-code-agents: channel ${channelType} failed to mount: ${String(error?.message ?? error)}`)
    return undefined
  }
}

/**
 * Cordis plugin apply(): mounts every configured channel row and exposes the
 * registry for the tool layer.
 */
export function apply(ctx, config = {}) {
  registry.setLogger(ctx.logger)
  const channels = Array.isArray(config.channels) ? config.channels : config.channel ? [config] : []
  const mounted = []
  for (const row of channels) {
    const result = mountChannel(ctx, row)
    if (result !== undefined) mounted.push(result)
  }
  ctx.registry = registry
  ctx.mountedChannels = mounted
  return { registry, mounted }
}
