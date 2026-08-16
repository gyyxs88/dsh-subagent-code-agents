/**
 * @dsh-subagent-code-agents/channel-codex type declarations.
 */

import type { ChannelCapabilities, CodingAgentChannel, RunEnv, RunRequest } from '@dsh-subagent-code-agents/core'

export const CHANNEL_ID: 'codex'
export const CODEX_REASONING_EFFORTS: readonly ['low', 'medium', 'high', 'xhigh', 'ultra', 'max']
export const CODEX_FIXED_SANDBOX_ARGV: readonly ['--dangerously-bypass-approvals-and-sandbox']

export function normalizeModel(value: string | undefined): string | undefined
export function normalizeReasoningEffort(value: string | undefined): string | undefined
export function codexInvocationArgs(request: unknown): string[]
export function codexExecArgv(opts: { node: string; js: string; cwd: string; request: unknown }): string[]
export function codexExecResumeArgv(opts: { node: string; js: string; sessionId: string; request: unknown }): string[]
export function resolveCodexEntry(env: RunEnv, request?: unknown): Promise<{ node: string; js: string }>
export function runCodexExec(opts: {
  env: RunEnv
  request: RunRequest
  resumeSessionId?: string
  capabilities?: import('@dsh-subagent-code-agents/core').ChannelCapabilities
}): Promise<import('@dsh-subagent-code-agents/core').ChannelResult>

export function createCodexChannel(options?: {
  nodeExecutable?: string
  codexJs?: string
}): CodingAgentChannel

export function codexChannel(options?: {
  nodeExecutable?: string
  codexJs?: string
}): CodingAgentChannel

export function registerCodexChannel(options?: {
  nodeExecutable?: string
  codexJs?: string
}): CodingAgentChannel | Error
