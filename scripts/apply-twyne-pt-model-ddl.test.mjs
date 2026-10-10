import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from './apply-twyne-pt-model-ddl.mjs'

test('H1 ledger binds archive, source receipt, target clock, and immutable score', async () => {
  const queries = []
  const sql = (parts) => {
    queries.push(parts.join('?'))
    return []
  }
  await apply(sql)
  const ddl = queries.join('\n')
  for (const table of [
    'twyne_pt_model_artifacts',
    'twyne_pt_model_issues',
    'twyne_pt_model_scores',
  ]) {
    assert.match(ddl, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`))
  }
  for (const trigger of ['artifact_insert', 'issue_insert', 'score_insert'])
    assert.match(ddl, new RegExp(`DROP TRIGGER IF EXISTS twyne_pt_model_${trigger}`))
  assert.match(ddl, /metric = 'aave_pt_reserve_cash_raw'/)
  assert.match(ddl, /horizon_hours = 1/)
  assert.match(ddl, /sha256 = encode\(sha256\(convert_to\(payload_bytes, 'UTF8'\)\), 'hex'\)/)
  assert.match(ddl, /NEW\.issued_at := stamp/)
  assert.match(ddl, /ADD CONSTRAINT twyne_pt_model_issues_slot_15m_check/)
  assert.match(ddl, /NEW\.slot_at := date_bin\('15 minutes'/)
  assert.match(ddl, /s\.first_local_receipt_at < stamp - interval '5 minutes'/)
  assert.match(ddl, /NEW\.source_first_local_receipt_at := s\.first_local_receipt_at/)
  assert.match(ddl, /s\.pt_decimals <> a\.asset_decimals/)
  assert.match(ddl, /NEW\.target_at := s\.observed_at \+ interval '1 hour'/)
  assert.match(ddl, /s\.observed_at < stamp - interval '30 minutes'/)
  assert.match(ddl, /NEW\.target_low_at := NEW\.target_at - interval '15 minutes'/)
  assert.match(ddl, /NEW\.score_after_at := NEW\.target_at \+ interval '1 hour'/)
  assert.match(ddl, /NEW\.scored_at < i\.score_after_at/)
  assert.match(ddl, /o\.first_local_receipt_at <= i\.score_after_at/)
  assert.match(ddl, /FOREIGN KEY \(wrapper, candidate_block\)/)
  assert.match(ddl, /BEFORE UPDATE OR DELETE/)
  assert.match(ddl, /BEFORE TRUNCATE/)
})
