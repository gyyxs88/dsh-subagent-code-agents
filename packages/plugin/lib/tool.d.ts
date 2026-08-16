/**
 * dsh-subagent-code-agents tool layer type declarations.
 */

export const name: string
export const inject: string[]
export const Config: import('@deepseek-ai/schemastery').Schemastery<any, any>
export function apply(ctx: Record<string, any>, config?: Record<string, unknown>): void
