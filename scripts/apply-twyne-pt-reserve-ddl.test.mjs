import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from './apply-twyne-pt-reserve-ddl.mjs'

test('schema pins Twyne/PT/aToken/Pool and prospective DB receipt clock', async () => {
  const queries = []
  const sql = (parts) => {
    queries.push(parts.join('?'))
    return []
  }
  await apply(sql)
  const ddl = queries.join('\n')
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS twyne_pt_reserve_observations/)
  assert.match(ddl, /aave_pt_reserve_cash_raw numeric\(78,0\)/)
  assert.match(ddl, /first_local_receipt_at timestamptz NOT NULL DEFAULT clock_timestamp\(\)/)
  assert.match(ddl, /first_local_receipt_at - observed_at <= interval '1 hour'/)
  assert.match(ddl, /NEW\.first_local_receipt_at := clock_timestamp\(\)/)
  assert.match(ddl, /NEW\.observed_at < NEW\.first_local_receipt_at - interval '1 hour'/)
  assert.match(ddl, /BEFORE INSERT ON twyne_pt_reserve_observations/)
  for (const address of [
    '0x0af56afbddcb140323445bd7211ba90e54e5fd1c',
    '0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34',
    '0x01e69a58ca3ddc695820ce6f66fbdf3fa55d0545',
    '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
  ])
    assert.ok(ddl.includes(address))
  assert.match(ddl, /PRIMARY KEY \(wrapper, block\)/)
  assert.match(ddl, /ON CONFLICT \(wrapper, block\) DO NOTHING/)
  assert.match(ddl, /old\.aave_pt_reserve_cash_raw IS DISTINCT FROM/)
  assert.match(ddl, /BEFORE UPDATE OR DELETE/)
  assert.match(ddl, /BEFORE TRUNCATE/)
})
