/**
 * @dsh-subagent-code-agents/core
 *
 * Multi-channel coding-agent subagent core. A channel is a small adapter that
 * runs ONE coding-agent CLI (Codex, Claude Code, Grok Build, …) behind a
 * minimal common interface. The core owns:
 *   - the `CodingAgentChannel` adapter contract,
 *   - capability flags per channel,
 *   - the channel registry (with per-channel failure isolation),
 *   - the unified `ChannelResult` shape,
 *   - the `RuntimeEnv` dependency injection bundle.
 *
 * Adding a NEW channel = publishing one package that implements the adapter
 * and registers itself with the shared registry. No core changes, no switch on
 * channel id anywhere in this package.
 */

/**
 * Capability flags a channel may declare. `false`/absent means the operation
 * is NOT supported and must be rejected explicitly by the caller (never
 * silently ignored, never a fallback).
 *
 * @typedef {{
 *   run: boolean,
 *   resume: boolean,
 *   listSessions: boolean,
 *   readSession: boolean,
 *   managedSession: boolean,
 *   steerActive: boolean,
 *   cancel: boolean,
 *   streaming: boolean,
 *   modelOverride: boolean,
 *   effortOverride: boolean,
 *   sandboxBypassGuaranteed: boolean,
 * }} ChannelCapabilities
 */

/**
 * Unified result shape returned by every channel operation.
 *
 * @typedef {{
 *   channel: string,
 *   runId: string,
 *   sessionId?: string,
 *   stopReason: 'completed'|'aborted'|'error'|'refused'|'unsupported',
 *   output: string,
 *   delivery?: 'managed_turn_started'|'steered'|'resume_unmanaged'|'external_or_idle'|'refused'|'failed',
 *   mayBeConcurrent?: boolean,
 *   capabilities: ChannelCapabilities,
 * }} ChannelResult
 */

/**
 * Best-effort observation emitted while a channel run is active. The final
 * ChannelResult remains authoritative; updates never mutate the parent model
 * context and may be coalesced by an embedding transport.
 * @typedef {{ type: 'text-delta', text: string }} ChannelUpdate
 */

/**
 * Per-channel adapter interface. Implementations must be pure adapters: they
 * receive `RuntimeEnv` at construction and must NOT depend on DSH/Cordis.
 *
 * @typedef {object} CodingAgentChannel
 * @property {string} id - stable channel id, e.g. 'codex' | 'claude-code' | 'grok-build'
 * @property {string} displayName - human name for tool descriptions
 * @property {ChannelCapabilities} capabilities
 * @property {(request: RunRequest, env: RunEnv) => Promise<ChannelResult>} run
 *   - fresh one-shot run (or resume when `request.resumeSessionId` is set)
 * @property {(request: RunRequest, env: RunEnv) => Promise<ChannelResult>} [resume]
 *   - explicit resume of a stored session (may be concurrent)
 * @property {(opts: ListSessionsOptions, env: RunEnv) => Promise<{ sessions: unknown[], truncated: boolean }>} [listSessions]
 * @property {(opts: ReadSessionOptions, env: RunEnv) => Promise<{ sessionId: string, status: string, turns: unknown[], truncated: boolean, delivery: string, capabilities: ChannelCapabilities }>} [readSession]
 * @property {(opts: StartManagedSessionOptions, env: RunEnv) => Promise<ChannelResult>} [startManagedSession]
 * @property {(opts: SteerOptions, env: RunEnv) => Promise<ChannelResult>} [steerActive]
 * @property {(opts: CancelOptions, env: RunEnv) => Promise<ChannelResult>} [cancel]
 * @property {() => Promise<void>} [dispose]
 */

/**
 * Runtime dependency injection bundle. Channels receive these instead of
 * reaching for globals, so tests can substitute fakes.
 *
 * @typedef {{
 *   subprocess: {
 *     spawn(spec: object): object,
 *     resolveExecutable(name: string, env?: Record<string, string>, signal?: AbortSignal): Promise<string>,
 *   },
 *   fs: typeof import('node:fs'),
 *   path: typeof import('node:path'),
 *   logger: { info: Function, warn: Function, error: Function },
 *   signal?: AbortSignal,
 *   onUpdate?: (update: ChannelUpdate) => void,
 *   cwd?: string,
 *   tmpdir?: string,
 * }} RuntimeEnv
 */

export const CAPABILITY_KEYS = Object.freeze([
  'run',
  'resume',
  'listSessions',
  'readSession',
  'managedSession',
  'steerActive',
  'cancel',
  'streaming',
  'modelOverride',
  'effortOverride',
  'sandboxBypassGuaranteed',
])

/** Build a capabilities record with every flag defaulting to false. */
export function emptyCapabilities() {
  const caps = {}
  for (const key of CAPABILITY_KEYS) caps[key] = false
  return caps
}

/** True when a capability flag is truthy. */
export function hasCapability(channel, name) {
  return Boolean(channel && channel.capabilities && channel.capabilities[name])
}

/**
 * Produce an explicit `unsupported` result for a capability a channel does not
 * declare. This is the ONLY way a missing capability surfaces — callers must
 * never silently skip or fall back.
 */
export function unsupported(channelId, operation, capabilities) {
  return {
    channel: channelId,
    runId: `unsupported-${Date.now().toString(36)}`,
    stopReason: 'unsupported',
    output: `channel "${channelId}" does not support ${operation}`,
    delivery: 'refused',
    mayBeConcurrent: false,
    capabilities: capabilities ?? emptyCapabilities(),
  }
}

/**
 * Channel registry with per-channel failure isolation: one channel's
 * registration error or runtime failure never blocks others.
 */
export class ChannelRegistry {
  constructor() {
    /** @type {Map<string, CodingAgentChannel>} */
    this._channels = new Map()
    /** @type {Map<string, Error>} */
    this._errors = new Map()
    this._listeners = new Set()
  }

  /**
   * Register a channel adapter. Throws only if the id is taken; adapter shape
   * problems are recorded as a channel error instead of throwing, so one bad
   * package cannot break the whole registry.
   */
  register(channel) {
    if (!channel || typeof channel.id !== 'string' || channel.id.length === 0) {
      const err = new Error('channel registration: id (non-empty string) is required')
      throw err
    }
    if (this._channels.has(channel.id)) {
      throw new Error(`channel "${channel.id}" is already registered`)
    }
    if (typeof channel.run !== 'function') {
      this._recordError(channel.id, new Error(`channel "${channel.id}" has no run()`))
      return undefined
    }
    if (!channel.capabilities || typeof channel.capabilities !== 'object') {
      this._recordError(channel.id, new Error(`channel "${channel.id}" has no capabilities object`))
      return undefined
    }
    // A capability declared true must have a matching method — otherwise the
    // channel would advertise behavior it cannot deliver.
    const methodForCapability = {
      resume: 'resume',
      listSessions: 'listSessions',
      readSession: 'readSession',
      managedSession: 'startManagedSession',
      steerActive: 'steerActive',
      cancel: 'cancel',
    }
    for (const [cap, method] of Object.entries(methodForCapability)) {
      if (channel.capabilities[cap] === true && typeof channel[method] !== 'function') {
        this._recordError(
          channel.id,
          new Error(`channel "${channel.id}" declares ${cap} but has no ${method}()`),
        )
        return undefined
      }
    }
    this._channels.set(channel.id, channel)
    // A successful registration clears any stale error for this id.
    this._errors.delete(channel.id)
    for (const listener of this._listeners) {
      try {
        listener(channel)
      } catch {}
    }
    return channel
  }

  /**
   * Atomically replace an existing adapter for `channel.id` (hot reload).
   * Works whether or not the id is currently registered; validation is the
   * same as register(). The replaced adapter is returned, or `undefined` when
   * there was none. Unlike register(), this never throws on an existing id.
   */
  replace(channel) {
    if (!channel || typeof channel.id !== 'string' || channel.id.length === 0) {
      throw new Error('channel registration: id (non-empty string) is required')
    }
    if (typeof channel.run !== 'function') {
      this._recordError(channel.id, new Error(`channel "${channel.id}" has no run()`))
      return undefined
    }
    if (!channel.capabilities || typeof channel.capabilities !== 'object') {
      this._recordError(channel.id, new Error(`channel "${channel.id}" has no capabilities object`))
      return undefined
    }
    const methodForCapability = {
      resume: 'resume',
      listSessions: 'listSessions',
      readSession: 'readSession',
      managedSession: 'startManagedSession',
      steerActive: 'steerActive',
      cancel: 'cancel',
    }
    for (const [cap, method] of Object.entries(methodForCapability)) {
      if (channel.capabilities[cap] === true && typeof channel[method] !== 'function') {
        this._recordError(
          channel.id,
          new Error(`channel "${channel.id}" declares ${cap} but has no ${method}()`),
        )
        return undefined
      }
    }
    const previous = this._channels.get(channel.id)
    this._channels.set(channel.id, channel)
    this._errors.delete(channel.id)
    for (const listener of this._listeners) {
      try {
        listener(channel)
      } catch {}
    }
    return previous
  }

  _recordError(id, error) {
    this._errors.set(id, error)
    this._logger?.error?.(`channel ${id} registration failed: ${error.message}`)
  }

  setLogger(logger) {
    this._logger = logger ?? { info() {}, warn() {}, error() {} }
    return this
  }

  get(id) {
    return this._channels.get(id)
  }

  has(id) {
    return this._channels.has(id)
  }

  /** All successfully registered channels (adapter objects). */
  list() {
    return [...this._channels.values()]
  }

  /** Channel ids that FAILED registration, with their errors. */
  errors() {
    return new Map(this._errors)
  }

  onRegister(listener) {
    this._listeners.add(listener)
    return () => this._listeners.delete(listener)
  }

  /** Remove a channel (used by tests / hot reload). */
  unregister(id) {
    const channel = this._channels.get(id)
    this._channels.delete(id)
    this._errors.delete(id)
    return channel
  }

  get size() {
    return this._channels.size
  }
}

/**
 * A default registry shared by the workspace; channel packages import this to
 * register themselves and the plugin package reads it to mount tools. This is
 * the single integration point — new channels register here, nothing else
 * changes.
 */
export const registry = new ChannelRegistry()

/**
 * Convenience: register a channel, swallowing only duplicate-id errors.
 * Used by channel packages at import time; returns the channel or the error.
 */
export function tryRegister(channel) {
  try {
    return registry.register(channel)
  } catch (error) {
    registry._recordError(channel?.id ?? '?', error)
    return error
  }
}
