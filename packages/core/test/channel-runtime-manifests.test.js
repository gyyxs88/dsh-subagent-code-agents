import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const channels = ['channel-codex', 'channel-claude-code', 'channel-grok-build', 'channel-acp']
const expectedVersions = new Map([
  ['channel-codex', '0.1.7'],
  ['channel-claude-code', '0.1.4'],
  ['channel-grok-build', '0.1.4'],
  ['channel-acp', '0.1.4'],
])

test('channel runtime manifests are versioned and cover the validated DSH 0.1.2-rc.1 ceiling', async () => {
  for (const channel of channels) {
    const manifest = JSON.parse(await readFile(path.join(root, 'packages', channel, 'package.json'), 'utf8'))
    assert.equal(manifest.version, expectedVersions.get(channel))
    assert.deepEqual(manifest.dsh.remote.channelRuntime.compatibility.dsh, {
      min: '0.1.0-rc.6',
      max: '0.1.2-rc.1',
    })
  }
})
