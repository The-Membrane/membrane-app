import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./record-carry-cash-prospective-v2.mjs', import.meta.url))

test('native scheduler invocation uses the tsx loader and reaches the read-only verifier', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', script, '--verify'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).status, 'verified')
})
