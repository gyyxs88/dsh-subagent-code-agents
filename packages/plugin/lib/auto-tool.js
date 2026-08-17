/**
 * Host-plane policy that contributes the coding-agent tools to every composed
 * agent preset except explicitly excluded presets (minimal by default).
 *
 * DSH's shipped preset root has precedence over user roots, so shadowing each
 * built-in preset is both ineffective and update-fragile. Agent-scoped effects
 * are the native lifecycle boundary: registrations are present before the
 * first post-publication turn and are removed with either the agent or this
 * policy plugin.
 */

import z from '@deepseek-ai/schemastery'
import { apply as applyTool, toolNames } from './tool.js'

export const name = 'auto-tool-subagent-code-agents'
export const inject = ['agents', 'agentPresets', 'tools', 'subagents']

export const Config = z.object({
  excludedPresets: z.array(z.string()).default(['minimal']),
})

export function presetAllowsAutoTools(presetId, excludedPresets = ['minimal']) {
  return typeof presetId === 'string'
    && presetId.length > 0
    && !new Set(excludedPresets).has(presetId)
}

function visiblePluginTools(ctx, agent) {
  return toolNames.filter((toolName) => ctx.tools.get(toolName, agent) !== undefined)
}

export function apply(ctx, config = {}) {
  const excludedPresets = Array.isArray(config.excludedPresets)
    ? config.excludedPresets
    : ['minimal']
  const mounted = new Map()
  let stopping = false

  const mount = (agent) => {
    if (stopping || mounted.has(agent)) return false
    const presetId = ctx.agentPresets.composedPreset(agent.ctx)
    if (!presetAllowsAutoTools(presetId, excludedPresets)) return false

    const existing = visiblePluginTools(ctx, agent)
    if (existing.length > 0) {
      if (existing.length !== toolNames.length) {
        ctx.logger.warn(
          `coding-agent tools: preset "${presetId}" has a partial conflicting tool set (${existing.join(', ')}); automatic mount skipped`,
        )
      } else {
        ctx.logger.debug(`coding-agent tools: preset "${presetId}" already mounts the tool plugin`)
      }
      return false
    }

    // The effect body runs synchronously, matching DSH's own agent-scoped tool
    // policies. This avoids a first-turn race that a deferred child plugin
    // activation could introduce after agent/created.
    const cleanup = agent.ctx.effect(
      () => applyTool(agent.ctx),
      'coding-agent-tools.auto-mount()',
    )
    mounted.set(agent, cleanup)
    ctx.logger.debug(`coding-agent tools: auto-mounted for preset "${presetId}"`)
    return true
  }

  ctx.effect(() => {
    const stopCreated = ctx.on('agent/created', ({ agent }) => {
      mount(agent)
    })
    const stopDisposed = ctx.on('agent/disposed', ({ agent }) => {
      const cleanup = mounted.get(agent)
      mounted.delete(agent)
      cleanup?.()
    })

    // Covers hot-loading the bundle while sessions are already live.
    for (const agent of ctx.agents.list()) mount(agent)

    return async () => {
      stopping = true
      stopCreated()
      stopDisposed()
      const cleanups = [...mounted.values()]
      mounted.clear()
      await Promise.allSettled(cleanups.map((cleanup) => Promise.resolve().then(() => cleanup())))
    }
  }, 'coding-agent-tools.lifecycle()')
}
