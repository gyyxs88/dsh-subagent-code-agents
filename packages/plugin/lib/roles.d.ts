export interface CodeAgentRole {
  id: string
  channel: string
  model?: string
  reasoningEffort?: string
  instructions?: string
  allowDelegation: boolean
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
}
