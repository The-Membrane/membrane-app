import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { appendDirectAttempt } from './record-carry-direct-exit-v2-issues.mjs'
import { appendDurableAttempt } from './record-carry-morpho-exit-v2-issues.mjs'
import { appendSyncVaultAttempt } from './record-carry-sync-vault-exit-v2-issues.mjs'

test('each issuer mirrors only after its legacy attempt is fsynced', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'carry-exit-v2-attempt-wiring-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const cases = [
    ['morpho', appendDurableAttempt],
    ['direct', appendDirectAttempt],
    ['sync_vault', appendSyncVaultAttempt],
  ]
  for (const [source, append] of cases) {
    const record = {
      at: '2026-10-06T12:00:00.000Z',
      status: 'unavailable',
      reason: 'fixture',
    }
    const path = join(dir, `${source}.jsonl`)
    await append(record, path, async (observedSource, observedRecord) => {
      assert.equal(observedSource, source)
      assert.equal(observedRecord, record)
      assert.deepEqual(JSON.parse((await readFile(path, 'utf8')).trim()), record)
    })
  }
})
