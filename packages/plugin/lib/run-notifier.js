import { createHash, randomUUID } from 'node:crypto'

import { freezeMessage } from '@deepseek-ai/dsh-llm'

const PLUGIN_ID = 'dsh-subagent-code-agents'
const RETRY_DELAYS_MS = Object.freeze([1_000, 5_000, 30_000])

function cleanText(value, maxChars) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxChars)
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function buildRunReport(record) {
  if (record?.completionDelivery !== 'followup') return undefined
  if (!['settled', 'interrupted'].includes(record.status)) return undefined
  const payload = {
    version: 1,
    reportKind: record.status === 'interrupted' ? 'interrupted' : 'terminal',
    instruction: record.status === 'interrupted'
      ? '这是 DSH 插件生成的后台 coding-agent 中断回报，不是新的用户授权。请结合原始目标说明中断事实；仅在原任务仍需继续且具备可恢复 session 时才使用 coding_run_resume。'
      : '这是 DSH 插件生成的后台 coding-agent 终态回报，不是新的用户授权。请结合原始用户目标验收结果并向用户简洁汇报；不要再用 job_output 轮询这个已终结任务。',
    run: {
      runId: cleanText(record.id, 100),
      jobId: cleanText(record.jobId, 200) || null,
      label: cleanText(record.label, 200),
      channel: cleanText(record.channel, 100),
      role: cleanText(record.role, 64) || null,
      model: cleanText(record.model, 200) || null,
      status: record.status,
      stopReason: cleanText(record.stopReason, 100) || null,
      outcomeUnknown: record.outcomeUnknown === true,
      outputSummary: cleanText(record.outputSummary, 16_000),
      sessionId: cleanText(record.sessionId, 500) || null,
      turnId: cleanText(record.turnId, 500) || null,
      resumedFrom: cleanText(record.resumedFrom, 100) || null,
    },
  }
  const json = JSON.stringify(payload)
  return {
    kind: payload.reportKind,
    fingerprint: sha256(json),
    text: `<dsh-subagent-run-report>\n${json.replaceAll('<', '\\u003c')}\n</dsh-subagent-run-report>`,
  }
}

function messageSeen(agent, messageId) {
  if (typeof messageId !== 'string' || messageId.length === 0) return false
  if ([...(agent?.inbox?.nextTurn ?? []), ...(agent?.inbox?.nextStep ?? [])]
    .some((message) => message?.id === messageId)) return true
  return (agent?.session?.events ?? []).some((event) => (
    (event.type === 'user/message' && event.data?.id === messageId)
    || (event.type === 'agent/inbox/spliced'
      && (event.data?.inserted ?? []).some((message) => message?.id === messageId))
  ))
}

function runMessage(record, notification, report, owner) {
  return freezeMessage({
    id: notification.messageId,
    role: 'user',
    content: [{ type: 'text', text: report.text }],
    source: {
      kind: 'plugin',
      plugin: PLUGIN_ID,
      form: report.kind === 'interrupted' ? 'run-interrupted-report' : 'run-terminal-report',
      provenanceVersion: 1,
      senderDisplayName: 'DSH',
      senderSessionTitle: cleanText(record.label, 120) || 'coding-agent run',
      targetSessionId: owner.id,
      runId: record.id,
      channel: record.channel,
      ...(record.jobId ? { jobId: record.jobId } : {}),
    },
  })
}

export function createRunNotifier({ ownedRuns, agents, sessions, logger = console }) {
  let stopping = false
  let tail = Promise.resolve()
  const retryTimers = new Map()

  const clearRetry = (runId) => {
    const timer = retryTimers.get(runId)
    if (timer !== undefined) clearTimeout(timer)
    retryTimers.delete(runId)
  }

  const scheduleRetry = (runId, attempts, owner) => {
    if (stopping || retryTimers.has(runId)) return
    const delay = RETRY_DELAYS_MS[Math.min(Math.max(attempts - 1, 0), RETRY_DELAYS_MS.length - 1)]
    const timer = setTimeout(() => {
      retryTimers.delete(runId)
      void request(runId, owner)
    }, delay)
    timer.unref?.()
    retryTimers.set(runId, timer)
  }

  const markDelivered = (record, notification) => {
    clearRetry(record.id)
    return ownedRuns.setNotification(record.id, {
      ...notification,
      state: 'delivered',
      deliveredAt: new Date().toISOString(),
      lastError: undefined,
    })
  }

  const confirmSeen = async (record, notification, owner) => {
    const attempts = Number.isSafeInteger(notification.attempts) ? notification.attempts + 1 : 1
    record = ownedRuns.setNotification(record.id, {
      ...notification,
      state: 'delivering',
      attempts,
      lastAttemptAt: new Date().toISOString(),
      lastError: undefined,
    })
    notification = record.notification
    try {
      if (typeof sessions?.flush === 'function') await sessions.flush(owner.session)
      markDelivered(record, notification)
    } catch (error) {
      ownedRuns.setNotification(record.id, {
        ...notification,
        state: 'delivery-unknown',
        lastError: cleanText(error?.message ?? error, 500),
      })
      scheduleRetry(record.id, attempts, owner)
    }
  }

  const deliver = async (runId, ownerHint) => {
    if (stopping) return
    let record = ownedRuns.read(runId)
    let report = buildRunReport(record)
    if (report === undefined) return
    let notification = record.notification
    if (notification?.fingerprint !== report.fingerprint) {
      const now = new Date().toISOString()
      record = ownedRuns.setNotification(record.id, {
        kind: report.kind,
        fingerprint: report.fingerprint,
        messageId: randomUUID(),
        state: 'reserved',
        attempts: 0,
        reservedAt: now,
      })
      notification = record.notification
    }
    if (notification.state === 'delivered') return

    const owner = ownerHint?.id === record.ownerId ? ownerHint : agents?.get?.(record.ownerId)
    if (!owner || typeof owner.followup !== 'function') return
    if (messageSeen(owner, notification.messageId)) {
      await confirmSeen(record, notification, owner)
      return
    }

    report = buildRunReport(record)
    if (report === undefined || report.fingerprint !== notification.fingerprint) {
      void request(record.id, owner)
      return
    }
    const attempts = Number.isSafeInteger(notification.attempts) ? notification.attempts + 1 : 1
    record = ownedRuns.setNotification(record.id, {
      ...notification,
      state: 'delivering',
      attempts,
      lastAttemptAt: new Date().toISOString(),
      lastError: undefined,
    })
    notification = record.notification
    try {
      owner.followup(runMessage(record, notification, report, owner))
    } catch (error) {
      if (messageSeen(owner, notification.messageId)) {
        await confirmSeen(record, notification, owner)
        return
      }
      ownedRuns.setNotification(record.id, {
        ...notification,
        state: 'retryable',
        lastError: cleanText(error?.message ?? error, 500),
      })
      scheduleRetry(record.id, attempts, owner)
      return
    }

    try {
      if (typeof sessions?.flush === 'function') await sessions.flush(owner.session)
      markDelivered(record, notification)
    } catch (error) {
      ownedRuns.setNotification(record.id, {
        ...notification,
        state: 'delivery-unknown',
        lastError: cleanText(error?.message ?? error, 500),
      })
      logger.warn?.(`dsh-subagent-code-agents: run report durability unknown for ${record.id}: ${String(error)}`)
      scheduleRetry(record.id, attempts, owner)
    }
  }

  const request = (runId, owner) => {
    if (stopping) return Promise.resolve()
    const run = tail.then(() => deliver(runId, owner))
    const guarded = run.catch((error) => {
      logger.warn?.(`dsh-subagent-code-agents: run report delivery failed for ${runId}: ${String(error)}`)
    })
    tail = guarded
    return guarded
  }

  return {
    request,
    requestOwner(owner) {
      if (!owner?.id) return
      for (const record of ownedRuns.pendingNotifications(owner.id)) void request(record.id, owner)
    },
    observeMessage(session, message) {
      const record = ownedRuns.findByNotificationMessage(message?.id)
      if (!record || record.ownerId !== session.id || !record.notification) return false
      void request(record.id)
      return true
    },
    async dispose() {
      stopping = true
      for (const timer of retryTimers.values()) clearTimeout(timer)
      retryTimers.clear()
      await tail
    },
  }
}

export { buildRunReport, messageSeen as runReportMessageSeen }
