import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const cli = fileURLToPath(new URL('./record-carry-cash-local-model.mjs', import.meta.url))

test('CLI rejects an unknown mode with a stable machine-readable error', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', cli, '--unknown'], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'local_cash_model_mode\n')
})

test('CLI requires exactly one mode', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', cli], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'local_cash_model_exactly_one_mode\n')
})
