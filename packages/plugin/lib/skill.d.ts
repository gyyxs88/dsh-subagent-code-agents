export const name: string
export const inject: string[]
export const BUNDLED_SKILL_URL: URL
export function parseBundledSkill(source: string, skillPath?: string): Record<string, unknown>
export function loadBundledSkill(): Promise<Record<string, unknown>>
export function apply(ctx: Record<string, any>): Promise<() => void>
