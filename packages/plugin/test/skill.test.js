import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, loadBundledSkill, parseBundledSkill } from '../lib/skill.js'

test('bundled coding-agent skill teaches asynchronous auto-reporting', async () => {
  const skill = await loadBundledSkill()
  assert.equal(skill.name, 'dsh-code-agents')
  assert.equal(skill.provider, 'dsh-subagent-code-agents')
  assert.match(skill.description, /subagent_code/u)
  assert.match(skill.content, /默认后台运行/u)
  assert.match(skill.content, /role=action-advisor/u)
  assert.match(skill.content, /run_in_background=false/u)
  assert.match(skill.content, /completion_delivery/u)
  assert.match(skill.content, /不要持续调用 `job_output`/u)
  assert.match(skill.content, /先用 `coding_run_read`/u)
  assert.match(skill.content, /不要因为一次 `job_output` 返回空文本/u)
})

test('bundled coding-agent skill rejects malformed frontmatter', () => {
  assert.throws(() => parseBundledSkill('missing'), /frontmatter/u)
  assert.throws(() => parseBundledSkill('---\nname: x\n---\nbody'), /description/u)
})

test('skill plugin registers the skill and system-level report trust boundary', async () => {
  let registered
  let section
  const disposer = () => {}
  const result = await apply({
    skills: { register(skill) { registered = skill; return disposer } },
    systemPrompt: { section(value) { section = value } },
  })
  assert.equal(result, disposer)
  assert.equal(registered.name, 'dsh-code-agents')
  assert.equal(section.name, 'security:dsh-subagent-run-report')
  assert.match(section.text, /outputSummary.*untrusted/u)
})
