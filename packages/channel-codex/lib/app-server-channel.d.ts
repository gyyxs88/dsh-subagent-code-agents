/**
 * @dsh-subagent-code-agents/channel-codex app-server session channel types.
 */

import type { CodingAgentChannel } from '@dsh-subagent-code-agents/core'

export const THREAD_STATUS: Readonly<{
  NOT_LOADED: 'notLoaded'
  IDLE: 'idle'
  ACTIVE: 'active'
  SYSTEM_ERROR: 'systemError'
}>

export class AppServerError extends Error {
  code: number
  detail?: unknown
  outcomeUnknown?: boolean
}

export interface AppServerClientOptions {
  spawn: (argv: string[], opts: { cwd?: string }) => object
  argvPrefix?: string[]
  node?: string
  js?: string
  cwd?: string
  requestTimeoutMs?: number
  logger?: { info: Function; warn: Function; error: Function }
}

export class AppServerClient {
  constructor(options: AppServerClientOptions)
  get initialized(): boolean
  get closed(): boolean
  onNotification(handler: (method: string, params?: unknown) => void): () => boolean
  threadState(threadId: string): { status?: string; activeTurnId?: string; managed?: boolean } | undefined
  isManaged(threadId: string): boolean
  ensureStarted(): Promise<void>
  request(method: string, params?: object, opts?: { timeoutMs?: number }): Promise<any>
  threadList(opts?: object): Promise<{ threads: any[]; nextCursor: string | null; backwardsCursor: string | null }>
  threadRead(threadId: string, opts?: { includeTurns?: boolean }): Promise<any>
  threadStart(opts?: { cwd?: string; model?: string }): Promise<any>
  threadResume(threadId: string, opts?: { model?: string }): Promise<any>
  turnStart(opts: object): Promise<any>
  turnSteer(opts: { threadId: string; input: unknown[]; expectedTurnId: string }): Promise<any>
  dispose(): Promise<void>
}

export function classifyThreadStatus(
  statusType: string | undefined,
  isManaged: boolean,
): 'active_managed' | 'idle_managed' | 'external_or_idle' | 'system_error'

export function createCodexAppServerChannel(options?: {
  codexExecutable?: string
  nodeExecutable?: string
  codexJs?: string
  appServerRequestTimeoutMs?: number
  logger?: { info: Function; warn: Function; error: Function }
  cwd?: string
}): CodingAgentChannel
