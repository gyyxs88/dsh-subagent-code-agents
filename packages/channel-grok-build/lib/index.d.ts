/**
 * @dsh-subagent-code-agents/channel-grok-build type declarations.
 */

import type { ChannelCapabilities, CodingAgentChannel, RunEnv, RunRequest } from '@dsh-subagent-code-agents/core'

export const CHANNEL_ID: 'grok-build'
export const GROK_FIXED_PERMISSION_ARGV: readonly ['--permission-mode', 'bypassPermissions']

export function normalizeModel(value: string | undefined): string | undefined
export function normalizeEffort(value: string | undefined): string | undefined
export function grokPrintArgv(opts: { grok: string; cwd?: string; request: unknown; prompt: string }): string[]
export function grokPromptFileArgv(opts: { grok: string; cwd?: string; request: unknown; promptFile: string }): string[]
export function grokResumeArgv(opts: { grok: string; sessionId: string; cwd?: string; request: unknown; prompt: string }): string[]
export function grokResumePromptFileArgv(opts: { grok: string; sessionId: string; cwd?: string; request: unknown; promptFile: string }): string[]
export function resolveGrok(env: RunEnv, request?: unknown): Promise<string>
export function writePromptFileIfNeeded(opts: { env: RunEnv; prompt: string }): Promise<string | undefined>
export function cleanupPromptFile(opts: { fs: unknown; path: unknown; file?: string }): void
export function parseGrokStreamLine(line: string): { type?: string; sessionId?: string; text?: string; stopReason?: string } | undefined
export function parseGrokSessions(text: string, opts?: { cwd?: string }): Array<{ id: string; preview?: string; cwd?: string; updatedAt?: number }>
export function grokChannelCapabilities(): ChannelCapabilities
export function createGrokBuildChannel(options?: { grokExecutable?: string }): CodingAgentChannel
export function grokBuildChannel(options?: { grokExecutable?: string }): CodingAgentChannel
export function registerGrokBuildChannel(options?: { grokExecutable?: string }): CodingAgentChannel | Error
export function runGrokProcess(opts: {
  env: RunEnv
  request: RunRequest
  resumeSessionId?: string
}): Promise<import('@dsh-subagent-code-agents/core').ChannelResult>
