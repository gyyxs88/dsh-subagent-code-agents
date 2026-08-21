/**
 * @dsh-subagent-code-agents/core type declarations.
 */

export interface ChannelCapabilities {
  run: boolean
  resume: boolean
  listSessions: boolean
  readSession: boolean
  managedSession: boolean
  steerActive: boolean
  cancel: boolean
  streaming: boolean
  modelOverride: boolean
  effortOverride: boolean
  sandboxBypassGuaranteed: boolean
  executionPolicies: Record<string, boolean>
}

export interface ChannelResult {
  channel: string
  runId: string
  sessionId?: string
  turnId?: string
  stopReason: 'completed' | 'aborted' | 'error' | 'refused' | 'unsupported'
  output: string
  delivery?:
    | 'managed_turn_started'
    | 'steered'
    | 'resume_unmanaged'
    | 'external_or_idle'
    | 'refused'
    | 'failed'
  mayBeConcurrent?: boolean
  capabilities: ChannelCapabilities
  errorCode?: string
}

export interface ChannelUpdate {
  type: 'text-delta'
  text: string
}

export interface RunEnv {
  subprocess: {
    spawn(spec: object): object
    resolveExecutable(name: string, env?: Record<string, string>, signal?: AbortSignal): Promise<string>
  }
  fs: typeof import('node:fs')
  path: typeof import('node:path')
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
  signal?: AbortSignal
  /** Best-effort observation only; ChannelResult remains the authoritative final value. */
  onUpdate?: (update: ChannelUpdate) => void
  cwd?: string
  /** Temp directory override (channels default to os.tmpdir()). */
  tmpdir?: string
  executionPolicy?: ChannelExecutionPolicy
  runtimeManager?: RuntimeManager
}

export interface RunRequest {
  description?: string
  prompt: string
  model?: string
  reasoningEffort?: string
  resumeSessionId?: string
  cwd?: string
  parentCwd?: string
  /** Background job id when run via the jobs service. */
  background?: boolean
  executionPolicy?: ChannelExecutionPolicy
  runtimeRequirement?: RuntimeRequirement
}

export interface RuntimeRequirement {
  id: string
  version: string
  placement?: 'remote' | 'both'
  target?: string
  executablePath?: string
  driver?: string
  [key: string]: unknown
}

export interface RuntimeManager {
  inspect(requirements: RuntimeRequirement[]): Promise<unknown>
  ensure(requirements: RuntimeRequirement[], options?: { runtimeSync?: unknown }): Promise<unknown>
  resolveExecutable(requirement: RuntimeRequirement): Promise<{ executable: string; state: string; auth?: unknown; runtime?: RuntimeRequirement }>
  authChallenge(requirement: RuntimeRequirement, options?: { output?: string | null }): Promise<unknown>
}

export interface ListSessionsOptions {
  cwd?: string
  includeAll?: boolean
  limit?: number
}

export interface ReadSessionOptions {
  sessionId: string
  maxTurns?: number
  maxChars?: number
}

export interface StartManagedSessionOptions {
  cwd?: string
  prompt: string
  model?: string
  reasoningEffort?: string
}

export interface SteerOptions {
  sessionId: string
  input: string
  expectedTurnId?: string
}

export interface CancelOptions {
  sessionId: string
  runId?: string
  reason?: string
}

export interface CodingAgentChannel {
  id: string
  displayName: string
  capabilities: ChannelCapabilities
  run(request: RunRequest, env: RunEnv): Promise<ChannelResult>
  resume?(request: RunRequest, env: RunEnv): Promise<ChannelResult>
  listSessions?(opts: ListSessionsOptions, env: RunEnv): Promise<{ sessions: unknown[]; truncated: boolean }>
  readSession?(opts: ReadSessionOptions, env: RunEnv): Promise<unknown>
  startManagedSession?(opts: StartManagedSessionOptions, env: RunEnv): Promise<ChannelResult>
  steerActive?(opts: SteerOptions, env: RunEnv): Promise<ChannelResult>
  cancel?(opts: CancelOptions, env: RunEnv): Promise<ChannelResult>
  dispose?(): Promise<void>
}

export const CAPABILITY_KEYS: readonly string[]

export function emptyCapabilities(): ChannelCapabilities
export function hasCapability(channel: CodingAgentChannel | undefined, name: string): boolean
export function unsupported(
  channelId: string,
  operation: string,
  capabilities?: ChannelCapabilities,
): ChannelResult

export class ChannelRegistry {
  constructor()
  register(channel: CodingAgentChannel): CodingAgentChannel | undefined
  replace(channel: CodingAgentChannel): CodingAgentChannel | undefined
  setLogger(logger: { info: Function; warn: Function; error: Function }): this
  get(id: string): CodingAgentChannel | undefined
  has(id: string): boolean
  list(): CodingAgentChannel[]
  errors(): Map<string, Error>
  onRegister(listener: (channel: CodingAgentChannel) => void): () => boolean
  unregister(id: string): CodingAgentChannel | undefined
  get size(): number
}

export const registry: ChannelRegistry
export function tryRegister(channel: CodingAgentChannel): CodingAgentChannel | Error

export interface ChannelExecutionPolicy {
  permission: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalOwner: 'target-session' | 'full-access-controller'
  approvalMode?: 'target-session' | 'controller-fingerprint'
  workspaceRoot: string
  sourceSessionId?: string
  targetSessionId?: string
  operationId?: string
  requestFingerprint?: string
  approvalHandler?: (request: unknown) => Promise<unknown> | unknown
}

export function normalizeExecutionPolicy(value: unknown, options?: { cwd?: string }): ChannelExecutionPolicy
export function executionPolicyFor(request: unknown, env: RunEnv, cwd?: string): ChannelExecutionPolicy
export function supportsExecutionPolicy(channel: CodingAgentChannel, policy: ChannelExecutionPolicy): boolean
export function unsupportedPermissionPolicy(channelId: string, policy: ChannelExecutionPolicy | undefined, capabilities: ChannelCapabilities, detail?: string): ChannelResult & { errorCode: string }
export const EXECUTION_PERMISSIONS: readonly string[]
export const EXECUTION_APPROVAL_OWNERS: readonly string[]
