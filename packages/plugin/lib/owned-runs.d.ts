import type { ChannelRegistry } from '@dsh-subagent-code-agents/core'

export function defaultRunRegistryPath(
  config?: Record<string, unknown>,
  env?: Record<string, string | undefined>,
): string | undefined
export function jobOutcomeFor(result: unknown): { status: string; output?: string; detail?: string }

export class OwnedRunRegistry {
  readonly filePath?: string
  constructor(options?: { filePath?: string; logger?: any; now?: () => string; idFactory?: () => string })
  create(input: Record<string, unknown>): Record<string, unknown>
  attach(id: string, active: { controller: AbortController; jobId?: string }): void
  setJobId(id: string, jobId: string): void
  bind(id: string, binding?: { sessionId?: string; turnId?: string }): Record<string, unknown> | undefined
  updateProgress(id: string, update: { type?: string; text?: string }): Record<string, unknown> | undefined
  settle(id: string, result: unknown): Record<string, unknown> | undefined
  fail(id: string, error: unknown, aborted?: boolean): Record<string, unknown> | undefined
  list(options?: { ownerId?: string; channel?: string; status?: string; limit?: number; channelRegistry?: ChannelRegistry }): unknown
  read(id: string, channelRegistry?: ChannelRegistry): Record<string, unknown> | undefined
  readInternal(id: string): Record<string, unknown> | undefined
  setNotification(id: string, notification: Record<string, unknown>): Record<string, unknown> | undefined
  findByNotificationMessage(messageId: string): Record<string, unknown> | undefined
  pendingNotifications(ownerId: string): Record<string, unknown>[]
  cancel(id: string, reason?: string): Record<string, unknown>
  dispose(runIds?: Iterable<string>): Promise<void>
}
export function sharedOwnedRunRegistry(options?: {
  filePath?: string
  logger?: any
  now?: () => string
  idFactory?: () => string
}): OwnedRunRegistry
