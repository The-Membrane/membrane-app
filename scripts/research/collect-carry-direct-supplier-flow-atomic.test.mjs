import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { publishDirectSegmentAtomic } from './collect-carry-direct-supplier-flow.mjs'

test('publishes a complete direct segment exclusively at its final path', () => {
  const directory = mkdtempSync(join(tmpdir(), 'direct-flow-atomic-'))
  try {
    const path = join(directory, 'segment.json')
    publishDirectSegmentAtomic(path, { test: 'complete' })
    assert.equal(readFileSync(path, 'utf8'), '{"test":"complete"}\n')
    assert.deepEqual(readdirSync(directory), ['segment.json'])
    assert.throws(() => publishDirectSegmentAtomic(path, { test: 'changed' }), /EEXIST/)
    assert.equal(readFileSync(path, 'utf8'), '{"test":"complete"}\n')
    assert.deepEqual(readdirSync(directory), ['segment.json'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
