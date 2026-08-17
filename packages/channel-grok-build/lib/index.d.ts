/**
 * @dsh-subagent-code-agents/channel-grok-build type declarations.
 */

import type { ChannelCapabilities, CodingAgentChannel, RunEnv, RunRequest } from '@dsh-subagent-code-agents/core'

export const CHANNEL_ID: 'grok-build'
export const GROK_FIXED_PERMISSION_ARGV: readonly ['--permission-mode', 'bypassPermissions']
export const GROK_FIXED_SANDBOX_ARGV: readonly ['--sandbox', 'off']

export function normalizeModel(value: string | undefined): string | undefined
export function normalizeEffort(value: string | undefined): string | undefined
export function grokPrintArgv(opts: { grok: string; cwd?: string; request: unknown; prompt: string }): string[]
export function grokPromptFileArgv(opts: { grok: string; cwd?: string; request: unknown; promptFile: string }): string[]
export function grokResumeArgv(opts: { grok: string; sessionId: string; cwd?: string; request: unknown; prompt: string }): string[]
export function grokResumePromptFileArgv(opts: { grok: string; sessionId: string; cwd?: string; request: unknown; promptFile: string }): string[]
export function grokAgentStdioArgv(opts: { grok: string; model?: string; reasoningEffort?: string }): string[]
export function resolveGrok(env: RunEnv, request?: unknown): Promise<string>
export function writePromptFileIfNeeded(opts: { env: RunEnv; prompt: string }): Promise<string | undefined>
export function cleanupPromptFile(opts: { fs: unknown; path: unknown; file?: string }): void
export function resolveGrokHome(opts: { env: RunEnv; configuredHome?: string }): string
export function parseGrokStreamLine(line: string): { type?: string; sessionId?: string; text?: string; stopReason?: string } | undefined
export function parseGrokSessions(text: string, opts?: { cwd?: string }): Array<{ id: string; preview?: string; cwd?: string; updatedAt?: number }>
export function listGrokSessions(opts: { env: RunEnv; grokHome: string; cwd?: string; includeAll?: boolean; limit?: number }): Promise<{ sessions: unknown[]; truncated: boolean }> | { sessions: unknown[]; truncated: boolean }
export function parseGrokUpdates(text: string, limits?: { maxTurns?: number; maxChars?: number }): { turns: unknown[]; chars: number; truncated: boolean }
export function parseGrokChatHistory(text: string, limits?: { maxTurns?: number; maxChars?: number }): { turns: unknown[]; chars: number; truncated: boolean }
export function readGrokSession(opts: { env: RunEnv; grokHome: string; sessionId: string; maxTurns?: number; maxChars?: number }): unknown
export function grokChannelCapabilities(): ChannelCapabilities
export interface GrokBuildChannelOptions {
  grokExecutable?: string
  grokHome?: string
  managedRequestTimeoutMs?: number
}
export function createGrokBuildChannel(options?: GrokBuildChannelOptions): CodingAgentChannel
export function grokBuildChannel(options?: GrokBuildChannelOptions): CodingAgentChannel
export function registerGrokBuildChannel(options?: GrokBuildChannelOptions): CodingAgentChannel | Error
export function runGrokProcess(opts: {
  env: RunEnv
  request: RunRequest
  resumeSessionId?: string
}): Promise<import('@dsh-subagent-code-agents/core').ChannelResult>
