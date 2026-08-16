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
export function claudeChannelCapabilities(): ChannelCapabilities
export function createClaudeCodeChannel(options?: { claudeExecutable?: string }): CodingAgentChannel
export function claudeCodeChannel(options?: { claudeExecutable?: string }): CodingAgentChannel
export function registerClaudeCodeChannel(options?: { claudeExecutable?: string }): CodingAgentChannel | Error
export function runClaudeProcess(opts: {
  env: RunEnv
  request: RunRequest
  resumeSessionId?: string
}): Promise<import('@dsh-subagent-code-agents/core').ChannelResult>
