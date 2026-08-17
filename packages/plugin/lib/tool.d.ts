/**
 * dsh-subagent-code-agents tool layer type declarations.
 */

export const name: string
export const inject: string[]
export const toolNames: readonly string[]
export const Config: import('@deepseek-ai/schemastery').Schemastery<any, any>
export function apply(
  ctx: Record<string, any>,
  config?: Record<string, unknown>,
  injected?: { subagents?: { start(name: string, request: Record<string, unknown>): Promise<any> } },
): () => Promise<void>
