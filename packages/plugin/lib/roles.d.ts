export interface CodeAgentRole {
  id: string
  channel: string
  model?: string
  reasoningEffort?: string
  instructions?: string
  allowDelegation: boolean
  backgroundOnly: boolean
  executionPermission?: 'read-only' | 'workspace-write' | 'danger-full-access'
}

export function normalizeRole(raw: Record<string, unknown>): Readonly<CodeAgentRole>
export function loadRoleRegistry(config?: Record<string, unknown>): Map<string, Readonly<CodeAgentRole>>
export function resolveRoleInvocation(
  args: Record<string, any>,
  roles: Map<string, Readonly<CodeAgentRole>>,
): {
  channel: string
  role?: string
  model?: string
  reasoningEffort?: string
  prompt: string
  backgroundOnly: boolean
  executionPermission?: 'read-only' | 'workspace-write' | 'danger-full-access'
}
