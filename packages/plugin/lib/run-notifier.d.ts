import type { OwnedRunRegistry } from './owned-runs.js'

export function createRunNotifier(options: {
  ownedRuns: OwnedRunRegistry
  agents?: { get(id: string): any }
  sessions?: { flush(session: any): Promise<void> }
  logger?: any
}): {
  request(runId: string, owner?: any): Promise<void>
  requestOwner(owner: any): void
  observeMessage(session: any, message: any): boolean
  dispose(): Promise<void>
}
export function buildRunReport(record: Record<string, unknown>): Record<string, string> | undefined
export function runReportMessageSeen(agent: any, messageId: string): boolean
