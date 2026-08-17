/**
 * dsh-subagent-code-agents plugin type declarations.
 */

import type { ChannelRegistry, CodingAgentChannel } from '@dsh-subagent-code-agents/core'

export const name: string
export const inject: string[]

export const CHANNEL_FACTORIES: Readonly<Record<string, (cfg: Record<string, unknown>) => CodingAgentChannel>>

export function providerNameFor(channelId: string): string
export function runtimeEnvFor(ctx: Record<string, any>, config?: Record<string, unknown>): any
export function toSubagentStopReason(result: { stopReason: string }): string
export function bindChannelEnv(channel: CodingAgentChannel, env: Record<string, unknown>): CodingAgentChannel
export function providerFromChannel(channel: CodingAgentChannel, env: Record<string, unknown>): any
export function createChannelAdapter(config?: Record<string, unknown>): CodingAgentChannel
export function mountChannel(
  ctx: Record<string, any>,
  config?: Record<string, unknown>,
): { provider: unknown; channel: CodingAgentChannel; unregister: () => Promise<void> } | undefined
export function apply(ctx: Record<string, any>, config?: Record<string, unknown>): { registry: ChannelRegistry; mounted: unknown[] }
