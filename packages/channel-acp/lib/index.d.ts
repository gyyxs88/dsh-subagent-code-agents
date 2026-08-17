import type { CodingAgentChannel, RunEnv, RunRequest, ChannelResult } from '@dsh-subagent-code-agents/core'

export interface AcpChannelConfig {
  id: string
  displayName?: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  requestTimeoutMs?: number
}

export class AcpProtocolError extends Error {
  code: number
  detail?: unknown
  constructor(code: number, message: string, detail?: unknown)
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
