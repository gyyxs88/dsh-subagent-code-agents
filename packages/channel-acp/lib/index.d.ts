import type { CodingAgentChannel, RunEnv, RunRequest, ChannelResult, RuntimeRequirement } from '@dsh-subagent-code-agents/core'

export interface AcpChannelConfig {
  id: string
  displayName?: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  requestTimeoutMs?: number
  runtimeId?: string
  runtimeRequirement?: RuntimeRequirement
  executionPolicies?: Record<string, boolean>
}

export class AcpProtocolError extends Error {
  code: number
  detail?: unknown
  constructor(code: number, message: string, detail?: unknown)
}

export class AcpClient {
  constructor(opts: { handle: unknown; requestTimeoutMs: number; logger?: RunEnv['logger']; approvalHandler?: NonNullable<import('@dsh-subagent-code-agents/core').ChannelExecutionPolicy['approvalHandler']> })
  readonly closed: boolean
  onNotification(listener: (method: string, params: unknown) => void): () => void
  request(method: string, params: unknown): Promise<unknown>
  notify(method: string, params: unknown): void
  dispose(): Promise<void>
}

export function normalizeAcpChannelId(value: string): string
export function createAcpChannel(config: AcpChannelConfig): CodingAgentChannel
export function registerAcpChannel(config: AcpChannelConfig): CodingAgentChannel | Error
export function runAcpProcess(opts: {
  options: Required<Pick<AcpChannelConfig, 'id' | 'command' | 'args' | 'requestTimeoutMs'>> & AcpChannelConfig
  env: RunEnv
  request: RunRequest
  resumeSessionId?: string
}): Promise<ChannelResult>
export function listAcpSessions(opts: {
  options: Required<Pick<AcpChannelConfig, 'id' | 'command' | 'args' | 'requestTimeoutMs'>> & AcpChannelConfig
  env: RunEnv
  opts: { cwd?: string; includeAll?: boolean; limit?: number }
}): Promise<unknown>
export function readAcpSession(opts: {
  options: Required<Pick<AcpChannelConfig, 'id' | 'command' | 'args' | 'requestTimeoutMs'>> & AcpChannelConfig
  env: RunEnv
  opts: { sessionId: string; maxTurns?: number; maxChars?: number }
}): Promise<unknown>
