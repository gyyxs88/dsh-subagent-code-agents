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

const VERSION = 1
const MAX_RUNS = 1000
const MAX_SUMMARY = 1000
const VALID_STATUS = new Set(['running', 'settled', 'interrupted'])
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

function safeRecord(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const id = cleanString(raw.id, 100)
  const channel = cleanString(raw.channel, 100)
  const createdAt = cleanString(raw.createdAt, 64)
  if (!id || !channel || !createdAt || !VALID_STATUS.has(raw.status)) return undefined
  return {
    id,
    channel,
    label: cleanString(raw.label, 200) ?? 'coding-agent run',
    status: raw.status,
    ...(cleanString(raw.role, 64) ? { role: cleanString(raw.role, 64) } : {}),
    ...(cleanString(raw.cwd, 4096) ? { cwd: cleanString(raw.cwd, 4096) } : {}),
    ...(cleanString(raw.model, 200) ? { model: cleanString(raw.model, 200) } : {}),
    ...(cleanString(raw.reasoningEffort, 100)
      ? { reasoningEffort: cleanString(raw.reasoningEffort, 100) }
      : {}),
    ...(cleanString(raw.sessionId, 500) ? { sessionId: cleanString(raw.sessionId, 500) } : {}),
    ...(cleanString(raw.stopReason, 100) ? { stopReason: cleanString(raw.stopReason, 100) } : {}),
    ...(cleanString(raw.outputSummary, MAX_SUMMARY)
      ? { outputSummary: cleanString(raw.outputSummary, MAX_SUMMARY) }
      : {}),
    ...(cleanString(raw.jobId, 200) ? { jobId: cleanString(raw.jobId, 200) } : {}),
    ...(cleanString(raw.resumedFrom, 100) ? { resumedFrom: cleanString(raw.resumedFrom, 100) } : {}),
    createdAt,
    updatedAt: cleanString(raw.updatedAt, 64) ?? createdAt,
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
    this.load()
  }

  load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return
    let parsed
    try {
      const stat = fs.statSync(this.filePath)
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('registry file is invalid or too large')
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      if (parsed?.version !== VERSION || !Array.isArray(parsed.runs)) throw new Error('unsupported registry format')
    } catch (error) {
      const quarantine = `${this.filePath}.corrupt-${Date.now()}.json`
      try { fs.renameSync(this.filePath, quarantine) } catch {}
      this.logger.warn?.(`dsh-subagent-code-agents: quarantined corrupt run registry: ${String(error?.message ?? error)}`)
      return
    }
    let changed = false
    for (const raw of parsed.runs.slice(-MAX_RUNS)) {
      const record = safeRecord(raw)
      if (!record) continue
      if (record.status === 'running') {
        record.status = 'interrupted'
        record.updatedAt = this.now()
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
      role: input.role,
      cwd: input.cwd,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      sessionId: input.sessionId,
      resumedFrom: input.resumedFrom,
      status: 'running',
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    if (!record) throw new Error('cannot create owned run record from invalid input')
    this.records.set(record.id, record)
    this.persist()
    return { ...record }
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

  settle(id, result) {
    const record = this.records.get(id)
    this.active.delete(id)
    if (!record) return
    if (this.interruptedByDispose.has(id) && record.status === 'interrupted') {
      this.interruptedByDispose.delete(id)
      return
    }
    record.status = 'settled'
    record.stopReason = cleanString(result?.stopReason, 100) ?? 'error'
    const sessionId = cleanString(result?.sessionId, 500)
    if (sessionId) record.sessionId = sessionId
    const summary = cleanString(outputText(result?.output).trim(), MAX_SUMMARY)
    if (summary) record.outputSummary = summary
    record.updatedAt = this.now()
    this.persist()
  }

  fail(id, error, aborted = false) {
    this.settle(id, {
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
      ...record,
      active: isActive,
      continuation: isActive ? 'active' : canResume ? 'resume_available' : 'unavailable',
    }
  }

  list({ channel, status, limit = 50, channelRegistry } = {}) {
    const rows = [...this.records.values()]
      .filter((record) => channel === undefined || record.channel === channel)
      .filter((record) => status === undefined || record.status === status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return {
      runs: rows.slice(0, limit).map((record) => this.view(record, channelRegistry)),
      truncated: rows.length > limit,
      persistence: this.filePath ? 'file' : 'memory',
    }
  }

  read(id, channelRegistry) {
    return this.view(this.records.get(id), channelRegistry)
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
        this.interruptedByDispose.add(id)
      }
      active.controller.abort('plugin disposed')
      this.active.delete(id)
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
