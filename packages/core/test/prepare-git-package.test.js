import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { INTERNAL_PACKAGES, materializeInternalPackages } from '../../../scripts/prepare-git-package.js'

test('Git prepare materializes missing internal packages and preserves existing entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-code-agents-prepare-'))
  try {
    for (const [sourceName] of INTERNAL_PACKAGES) {
      const source = path.join(root, 'packages', sourceName)
      fs.mkdirSync(path.join(source, 'lib'), { recursive: true })
      fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: sourceName }))
      fs.writeFileSync(path.join(source, 'LICENSE'), 'MIT')
      fs.writeFileSync(path.join(source, 'lib', 'index.js'), `export const name = '${sourceName}'\n`)
    }
    const preserved = path.join(root, 'node_modules', '@dsh-subagent-code-agents', 'core')
    fs.mkdirSync(preserved, { recursive: true })
    fs.writeFileSync(path.join(preserved, 'marker.txt'), 'keep')

    const copied = materializeInternalPackages(root)
    assert.equal(copied.includes('core'), false)
    assert.equal(fs.readFileSync(path.join(preserved, 'marker.txt'), 'utf8'), 'keep')
    assert.equal(copied.length, INTERNAL_PACKAGES.length - 1)
    assert.equal(
      fs.existsSync(path.join(root, 'node_modules', '@dsh-subagent-code-agents', 'channel-acp', 'lib', 'index.js')),
      true,
    )
    assert.deepEqual(materializeInternalPackages(root), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
