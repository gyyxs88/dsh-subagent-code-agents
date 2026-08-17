/** Host-plane automatic tool policy for all non-excluded DSH agent presets. */

export const name: string
export const inject: string[]
export const Config: import('@deepseek-ai/schemastery').Schemastery<any, any>
export function presetAllowsAutoTools(presetId: unknown, excludedPresets?: readonly string[]): boolean
export function apply(ctx: Record<string, any>, config?: { excludedPresets?: string[] }): void
