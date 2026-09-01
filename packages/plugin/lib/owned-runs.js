/**
 * Persistent registry for background runs created by this plugin.
 *
 * Prompts and credentials are never stored. A process restart turns every
 * persisted `running` record into `interrupted`; it is never represented as
 * still active. Continuation is available only when a session id survived and
 * the currently registered channel still advertises resume support.
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { hasCapability } from '@dsh-subagent-code-agents/core'

const VERSION = 2
const READABLE_VERSIONS = new Set([1, VERSION])
const MAX_RUNS = 100
const MAX_SUMMARY = 16_000
const MAX_PROGRESS_PREVIEW = 4_096
const MAX_LIST_PROGRESS_PREVIEW = 500
const PROGRESS_PERSIST_DELAY_MS = 1_000
const VALID_STATUS = new Set(['running', 'settled', 'interrupted'])
const VALID_NOTIFICATION_STATE = new Set(['reserved', 'delivering', 'retryable', 'delivery-unknown', 'delivered'])
const VALID_PROGRESS_PHASE = new Set(['starting', 'bound', 'working', 'settled', 'interrupted'])
const VALID_PROGRESS_AVAILABILITY = new Set(['not-yet', 'available', 'temporarily-unavailable'])
const VALID_PROGRESS_SOURCE = new Set(['lifecycle', 'channel-update', 'final-output'])
const VALID_INTERRUPTION_REASON = new Set(['plugin-disposed', 'owner-disposed', 'process-restart-or-crash', 'unknown'])
const SHARED_FILE_REGISTRIES = new Map()

function cleanString(value, max) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined
}

function outputText(output) {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return ''
  return output
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function safeNotification(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const messageId = cleanString(raw.messageId, 100)
  const fingerprint = cleanString(raw.fingerprint, 64)
  if (!messageId || !/^[a-f0-9]{64}$/u.test(fingerprint ?? '') || !VALID_NOTIFICATION_STATE.has(raw.state)) return undefined
  return {
    kind: raw.kind === 'interrupted' ? 'interrupted' : 'terminal',
    fingerprint,
    messageId,
    state: raw.state,
    attempts: Number.isSafeInteger(raw.attempts) && raw.attempts >= 0 ? raw.attempts : 0,
    ...(cleanString(raw.reservedAt, 64) ? { reservedAt: cleanString(raw.reservedAt, 64) } : {}),
    ...(cleanString(raw.lastAttemptAt, 64) ? { lastAttemptAt: cleanString(raw.lastAttemptAt, 64) } : {}),
    ...(cleanString(raw.deliveredAt, 64) ? { deliveredAt: cleanString(raw.deliveredAt, 64) } : {}),
    ...(cleanString(raw.lastError, 500) ? { lastError: cleanString(raw.lastError, 500) } : {}),
  }
}

function safeProgress(raw, fallbackAt) {
  if (!raw || typeof raw !== 'object') return undefined
  const updatedAt = cleanString(raw.updatedAt, 64) ?? fallbackAt
  const preview = cleanString(raw.preview, MAX_PROGRESS_PREVIEW)
  return {
    revision: Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
    phase: VALID_PROGRESS_PHASE.has(raw.phase) ? raw.phase : 'starting',
    availability: preview
      ? 'available'
      : VALID_PROGRESS_AVAILABILITY.has(raw.availability) ? raw.availability : 'not-yet',
    ...(preview ? { preview } : {}),
    source: VALID_PROGRESS_SOURCE.has(raw.source) ? raw.source : 'lifecycle',
    updatedAt,
    truncated: raw.truncated === true,
  }
}

function safeInterruption(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const at = cleanString(raw.at, 64)
  if (!at) return undefined
  return {
    reason: VALID_INTERRUPTION_REASON.has(raw.reason) ? raw.reason : 'unknown',
    at,
  }
}

function appendProgressPreview(previous, delta) {
  const combined = `${previous ?? ''}${delta}`
  if (combined.length <= MAX_PROGRESS_PREVIEW) return { preview: combined, truncated: false }
  return { preview: combined.slice(-MAX_PROGRESS_PREVIEW), truncated: true }
}

function internalCopy(record) {
  if (!record) return undefined
  return {
    ...record,
    ...(record.progress ? { progress: { ...record.progress } } : {}),
    ...(record.interruption ? { interruption: { ...record.interruption } } : {}),
    ...(record.notification ? { notification: { ...record.notification } } : {}),
  }
}

function safeRecord(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const id = cleanString(raw.id, 100)
  const channel = cleanString(raw.channel, 100)
  const createdAt = cleanString(raw.createdAt, 64)
  const notification = safeNotification(raw.notification)
  if (!id || !channel || !createdAt || !VALID_STATUS.has(raw.status)) return undefined
  const updatedAt = cleanString(raw.updatedAt, 64) ?? createdAt
  const progress = safeProgress(raw.progress, updatedAt) ?? {
    revision: 0,
    phase: raw.status === 'running' ? 'starting' : raw.status === 'settled' ? 'settled' : 'interrupted',
    availability: 'not-yet',
    source: 'lifecycle',
    updatedAt,
    truncated: false,
  }
  const interruption = safeInterruption(raw.interruption)
  return {
    id,
    channel,
    label: cleanString(raw.label, 200) ?? 'coding-agent run',
    status: raw.status,
    ...(cleanString(raw.ownerId, 200) ? { ownerId: cleanString(raw.ownerId, 200) } : {}),
    completionDelivery: raw.completionDelivery === 'followup' ? 'followup' : 'manual',
    ...(cleanString(raw.role, 64) ? { role: cleanString(raw.role, 64) } : {}),
    ...(cleanString(raw.cwd, 4096) ? { cwd: cleanString(raw.cwd, 4096) } : {}),
    ...(cleanString(raw.model, 200) ? { model: cleanString(raw.model, 200) } : {}),
    ...(cleanString(raw.reasoningEffort, 100)
      ? { reasoningEffort: cleanString(raw.reasoningEffort, 100) }
      : {}),
    ...(cleanString(raw.sessionId, 500) ? { sessionId: cleanString(raw.sessionId, 500) } : {}),
    ...(cleanString(raw.turnId, 500) ? { turnId: cleanString(raw.turnId, 500) } : {}),
    ...(raw.foreground === true ? { foreground: true } : {}),
    ...(raw.outcomeUnknown === true ? { outcomeUnknown: true } : {}),
    ...(cleanString(raw.stopReason, 100) ? { stopReason: cleanString(raw.stopReason, 100) } : {}),
    ...(cleanString(raw.outputSummary, MAX_SUMMARY)
      ? { outputSummary: cleanString(raw.outputSummary, MAX_SUMMARY) }
      : {}),
    ...(cleanString(raw.jobId, 200) ? { jobId: cleanString(raw.jobId, 200) } : {}),
    ...(cleanString(raw.resumedFrom, 100) ? { resumedFrom: cleanString(raw.resumedFrom, 100) } : {}),
    ...(notification ? { notification } : {}),
    createdAt,
    updatedAt,
    progress,
    ...(interruption ? { interruption } : {}),
  }
}

export function defaultRunRegistryPath(config = {}, env = process.env) {
  if (typeof config.runRegistryPath === 'string' && config.runRegistryPath.trim()) {
    return path.resolve(config.runRegistryPath.trim())
  }
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim()) {
    return path.join(env.DSH_HOME.trim(), 'dsh-subagent-code-agents', 'owned-runs.json')
  }
  return undefined
}

export class OwnedRunRegistry {
  constructor({ filePath, logger, now, idFactory } = {}) {
    this.filePath = filePath ? path.resolve(filePath) : undefined
    this.logger = logger ?? { info() {}, warn() {}, error() {} }
    this.now = now ?? (() => new Date().toISOString())
    this.idFactory = idFactory ?? (() => `run-${randomUUID()}`)
    this.records = new Map()
    this.active = new Map()
    this.interruptedByDispose = new Set()
    this.progressTimers = new Map()
    this.load()
  }

  load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return
    let parsed
    try {
      const stat = fs.statSync(this.filePath)
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('registry file is invalid or too large')
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      if (!READABLE_VERSIONS.has(parsed?.version) || !Array.isArray(parsed.runs)) throw new Error('unsupported registry format')
    } catch (error) {
      const quarantine = `${this.filePath}.corrupt-${Date.now()}.json`
      try { fs.renameSync(this.filePath, quarantine) } catch {}
      this.logger.warn?.(`dsh-subagent-code-agents: quarantined corrupt run registry: ${String(error?.message ?? error)}`)
      return
    }
    let changed = parsed.version !== VERSION
    for (const raw of parsed.runs.slice(-MAX_RUNS)) {
      const record = safeRecord(raw)
      if (!record) continue
      if (record.status === 'running') {
        record.status = 'interrupted'
        record.updatedAt = this.now()
        record.interruption = { reason: 'process-restart-or-crash', at: record.updatedAt }
        record.progress = {
          ...(record.progress ?? {
            revision: 0,
            availability: 'not-yet',
            source: 'lifecycle',
            truncated: false,
          }),
          revision: (record.progress?.revision ?? 0) + 1,
          phase: 'interrupted',
          updatedAt: record.updatedAt,
        }
        changed = true
      }
      this.records.set(record.id, record)
    }
    if (changed) this.persist()
  }

  persist() {
    if (!this.filePath) return
    const dir = path.dirname(this.filePath)
    fs.mkdirSync(dir, { recursive: true })
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    const payload = `${JSON.stringify({ version: VERSION, runs: [...this.records.values()] }, null, 2)}\n`
    try {
      fs.writeFileSync(temp, payload, { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(temp, this.filePath)
    } finally {
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp) } catch {}
    }
  }

  scheduleProgressPersist(id) {
    if (!this.filePath || this.progressTimers.has(id)) return
    const timer = setTimeout(() => {
      this.progressTimers.delete(id)
      try { this.persist() } catch (error) {
        this.logger.warn?.(`dsh-subagent-code-agents: progress persistence failed for ${id}: ${String(error?.message ?? error)}`)
      }
    }, PROGRESS_PERSIST_DELAY_MS)
    timer.unref?.()
    this.progressTimers.set(id, timer)
  }

  flushProgress(id) {
    const timer = this.progressTimers.get(id)
    if (timer !== undefined) clearTimeout(timer)
    this.progressTimers.delete(id)
  }

  prune() {
    if (this.records.size < MAX_RUNS) return
    for (const [id, record] of this.records) {
      if (record.status !== 'running' && !this.active.has(id)) this.records.delete(id)
      if (this.records.size < MAX_RUNS) return
    }
    throw new Error(`owned run registry is full (${MAX_RUNS} active records)`)
  }

  create(input) {
    this.prune()
    const timestamp = this.now()
    const record = safeRecord({
      id: this.idFactory(),
      channel: input.channel,
      label: input.label,
      ownerId: input.ownerId,
      completionDelivery: input.completionDelivery,
      role: input.role,
      cwd: input.cwd,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      sessionId: input.sessionId,
      foreground: input.foreground === true,
      resumedFrom: input.resumedFrom,
      status: 'running',
      createdAt: timestamp,
      updatedAt: timestamp,
      progress: {
        revision: 0,
        phase: 'starting',
        availability: 'not-yet',
        source: 'lifecycle',
        updatedAt: timestamp,
        truncated: false,
      },
    })
    if (!record) throw new Error('cannot create owned run record from invalid input')
    this.records.set(record.id, record)
    this.persist()
    return internalCopy(record)
  }

  attach(id, active) {
    if (!this.records.has(id)) throw new Error(`unknown owned run "${id}"`)
    this.active.set(id, active)
  }

  setJobId(id, jobId) {
    const record = this.records.get(id)
    if (!record) return
    record.jobId = String(jobId)
    record.updatedAt = this.now()
    const active = this.active.get(id)
    if (active) active.jobId = String(jobId)
    this.persist()
  }

  bind(id, binding = {}) {
    const record = this.records.get(id)
    if (!record) return undefined
    const sessionId = cleanString(binding.sessionId, 500)
    const turnId = cleanString(binding.turnId, 500)
    if (sessionId) record.sessionId = sessionId
    if (turnId) record.turnId = turnId
    record.updatedAt = this.now()
    record.progress = {
      ...(record.progress ?? {
        revision: 0,
        availability: 'not-yet',
        source: 'lifecycle',
        truncated: false,
      }),
      revision: (record.progress?.revision ?? 0) + 1,
      phase: record.progress?.phase === 'working' ? 'working' : 'bound',
      updatedAt: record.updatedAt,
    }
    this.flushProgress(id)
    this.persist()
    return internalCopy(record)
  }

  updateProgress(id, update) {
    const record = this.records.get(id)
    const text = cleanString(update?.text, 65_536)
    if (!record || record.status !== 'running' || !text) return undefined
    const appended = appendProgressPreview(record.progress?.preview, text)
    const updatedAt = this.now()
    record.progress = {
      revision: (record.progress?.revision ?? 0) + 1,
      phase: 'working',
      availability: 'available',
      preview: appended.preview,
      source: 'channel-update',
      updatedAt,
      truncated: record.progress?.truncated === true || appended.truncated,
    }
    record.updatedAt = updatedAt
    this.scheduleProgressPersist(id)
    return internalCopy(record.progress)
  }

  settle(id, result) {
    const record = this.records.get(id)
    this.active.delete(id)
    this.flushProgress(id)
    if (!record) return undefined
    if (this.interruptedByDispose.has(id) && record.status === 'interrupted') {
      this.interruptedByDispose.delete(id)
      return internalCopy(record)
    }
    record.status = 'settled'
    record.stopReason = cleanString(result?.stopReason, 100) ?? 'error'
    const sessionId = cleanString(result?.sessionId, 500)
    if (sessionId) record.sessionId = sessionId
    const turnId = cleanString(result?.turnId, 500)
    if (turnId) record.turnId = turnId
    record.outcomeUnknown = result?.outcomeUnknown === true
    const summary = cleanString(outputText(result?.output).trim(), MAX_SUMMARY)
    if (summary) record.outputSummary = summary
    record.updatedAt = this.now()
    const finalPreview = !record.progress?.preview && summary
      ? appendProgressPreview(undefined, summary)
      : undefined
    record.progress = {
      ...(record.progress ?? {
        revision: 0,
        availability: 'not-yet',
        source: 'lifecycle',
        truncated: false,
      }),
      revision: (record.progress?.revision ?? 0) + 1,
      phase: 'settled',
      updatedAt: record.updatedAt,
      ...(finalPreview
        ? {
            availability: 'available',
            preview: finalPreview.preview,
            source: 'final-output',
            truncated: finalPreview.truncated,
          }
        : {}),
    }
    this.persist()
    return internalCopy(record)
  }

  fail(id, error, aborted = false) {
    return this.settle(id, {
      stopReason: aborted ? 'aborted' : 'error',
      output: String(error?.message ?? error ?? ''),
    })
  }

  view(record, channelRegistry) {
    if (!record) return undefined
    const isActive = record.status === 'running' && this.active.has(record.id)
    const channel = channelRegistry?.get(record.channel)
    const canResume = !isActive && Boolean(record.sessionId) && hasCapability(channel, 'resume')
    return {
      id: record.id,
      channel: record.channel,
      label: record.label,
      status: record.status,
      completionDelivery: record.completionDelivery,
      ...(record.role ? { role: record.role } : {}),
      ...(record.cwd ? { cwd: record.cwd } : {}),
      ...(record.model ? { model: record.model } : {}),
      ...(record.reasoningEffort ? { reasoningEffort: record.reasoningEffort } : {}),
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      ...(record.turnId ? { turnId: record.turnId } : {}),
      ...(record.foreground === true ? { foreground: true } : {}),
      ...(record.outcomeUnknown === true ? { outcomeUnknown: true } : {}),
      ...(record.stopReason ? { stopReason: record.stopReason } : {}),
      ...(record.outputSummary ? { outputSummary: record.outputSummary } : {}),
      ...(record.jobId ? { jobId: record.jobId } : {}),
      ...(record.resumedFrom ? { resumedFrom: record.resumedFrom } : {}),
      ...(record.progress ? { progress: { ...record.progress } } : {}),
      ...(record.interruption ? { interruption: { ...record.interruption } } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      active: isActive,
      continuation: isActive ? 'active' : canResume ? 'resume_available' : 'unavailable',
    }
  }

  list({ ownerId, channel, status, limit = 50, channelRegistry } = {}) {
    const rows = [...this.records.values()]
      .filter((record) => ownerId === undefined || record.ownerId === ownerId)
      .filter((record) => channel === undefined || record.channel === channel)
      .filter((record) => status === undefined || record.status === status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return {
      runs: rows.slice(0, limit).map((record) => {
        const view = this.view(record, channelRegistry)
        if ((view.progress?.preview?.length ?? 0) <= MAX_LIST_PROGRESS_PREVIEW) return view
        return {
          ...view,
          progress: {
            ...view.progress,
            preview: view.progress.preview.slice(-MAX_LIST_PROGRESS_PREVIEW),
            truncated: true,
          },
        }
      }),
      truncated: rows.length > limit,
      persistence: this.filePath ? 'file' : 'memory',
    }
  }

  read(id, channelRegistry) {
    return this.view(this.records.get(id), channelRegistry)
  }

  readInternal(id) {
    return internalCopy(this.records.get(id))
  }

  setNotification(id, notification) {
    const record = this.records.get(id)
    if (!record) return undefined
    const safe = safeNotification(notification)
    if (!safe) throw new Error('owned run notification is invalid')
    record.notification = safe
    record.updatedAt = this.now()
    this.persist()
    return internalCopy(record)
  }

  findByNotificationMessage(messageId) {
    return [...this.records.values()].find((record) => record.notification?.messageId === messageId)
  }

  pendingNotifications(ownerId) {
    return [...this.records.values()].filter((record) => (
      record.ownerId === ownerId
      && record.completionDelivery === 'followup'
      && ['settled', 'interrupted'].includes(record.status)
      && record.notification?.state !== 'delivered'
    ))
  }

  cancel(id, reason) {
    const record = this.records.get(id)
    if (!record) throw new Error(`unknown owned run "${id}"`)
    const active = this.active.get(id)
    if (!active || record.status !== 'running') {
      return { accepted: false, runId: id, status: record.status, reason: 'run is not active in this process' }
    }
    active.controller.abort(reason ?? 'cancelled by coding_run_cancel')
    return { accepted: true, runId: id, status: 'cancelling', jobId: record.jobId }
  }

  async dispose(runIds) {
    const selected = runIds === undefined ? new Set(this.active.keys()) : new Set(runIds)
    const timestamp = this.now()
    for (const id of selected) {
      const active = this.active.get(id)
      if (!active) continue
      const record = this.records.get(id)
      if (record?.status === 'running') {
        record.status = 'interrupted'
        record.updatedAt = timestamp
        record.interruption = { reason: 'plugin-disposed', at: timestamp }
        record.progress = {
          ...(record.progress ?? {
            revision: 0,
            availability: 'not-yet',
            source: 'lifecycle',
            truncated: false,
          }),
          revision: (record.progress?.revision ?? 0) + 1,
          phase: 'interrupted',
          updatedAt: timestamp,
        }
        this.interruptedByDispose.add(id)
      }
      active.controller.abort('plugin disposed')
      this.active.delete(id)
      this.flushProgress(id)
    }
    this.persist()
  }
}

/**
 * Reuse one file-backed registry inside a DSH process. Agent presets may mount
 * the tool plugin more than once; sharing prevents same-process writers from
 * overwriting each other's records or misclassifying sibling active runs.
 */
export function sharedOwnedRunRegistry(options = {}) {
  if (!options.filePath) return new OwnedRunRegistry(options)
  const key = path.resolve(options.filePath)
  let registry = SHARED_FILE_REGISTRIES.get(key)
  if (!registry) {
    registry = new OwnedRunRegistry({ ...options, filePath: key })
    SHARED_FILE_REGISTRIES.set(key, registry)
  }
  return registry
}

export function jobOutcomeFor(result) {
  if (result?.stopReason === 'completed') {
    return { status: 'completed', output: outputText(result.output) }
  }
  if (result?.stopReason === 'aborted') return { status: 'killed' }
  return { status: 'failed', detail: String(result?.stopReason ?? 'error') }
}
