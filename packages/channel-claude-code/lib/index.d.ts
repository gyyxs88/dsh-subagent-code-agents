/**
 * @dsh-subagent-code-agents/channel-claude-code type declarations.
 */

import type { ChannelCapabilities, CodingAgentChannel, RunEnv, RunRequest } from '@dsh-subagent-code-agents/core'

export const CHANNEL_ID: 'claude-code'
export const CLAUDE_FIXED_PERMISSION_ARGV: readonly ['--permission-mode', 'bypassPermissions']

export function normalizeModel(value: string | undefined): string | undefined
export function normalizeEffort(value: string | undefined): string | undefined
export function claudePrintArgv(opts: { argvPrefix: string[]; request: unknown }): string[]
export function claudeResumeArgv(opts: { argvPrefix: string[]; sessionId: string; request: unknown }): string[]
export function resolveClaudeEntry(env: RunEnv, request?: unknown): Promise<{ argvPrefix: string[]; entry: string }>
export function parseClaudeStreamLine(line: string): { type?: string; sessionId?: string; text?: string; isError?: boolean } | undefined
export function parseClaudeSessionsJson(text: string): Array<{ id?: string; preview?: string; cwd?: string; updatedAt?: number }>
export interface ClaudeCodeChannelOptions {
  claudeExecutable?: string
  managedInitTimeoutMs?: number
  /** Test/embedding override; production loads @anthropic-ai/claude-agent-sdk. */
  sdk?: Record<string, (...args: any[]) => any>
}
export function claudeSdkOptions(opts: {
  env: RunEnv
  options: ClaudeCodeChannelOptions
  request: RunRequest
  resumeSessionId?: string
  abortController?: AbortController
}): Promise<Record<string, unknown>>
export function claudeChannelCapabilities(): ChannelCapabilities
export function createClaudeCodeChannel(options?: ClaudeCodeChannelOptions): CodingAgentChannel
export function claudeCodeChannel(options?: ClaudeCodeChannelOptions): CodingAgentChannel
export function registerClaudeCodeChannel(options?: ClaudeCodeChannelOptions): CodingAgentChannel | Error
export function runClaudeProcess(opts: {
  env: RunEnv
  request: RunRequest
  resumeSessionId?: string
}): Promise<import('@dsh-subagent-code-agents/core').ChannelResult>
export function runClaudeSdk(opts: {
  env: RunEnv
  options: ClaudeCodeChannelOptions
  request: RunRequest
  resumeSessionId?: string
}): Promise<import('@dsh-subagent-code-agents/core').ChannelResult>
