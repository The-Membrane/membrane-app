import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeGhoHolding } from './carry-route-summary.mjs'

const now = Date.parse('2026-09-26T19:00:00.000Z')
const holding = (raw, status = 'ok') => ({
  status,
  assetAddress: '0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f',
  assetDecimals: 18,
  assetBalanceRaw: raw,
})
const snapshot = (positions, asOf = '2026-09-26T18:55:00.000Z') => ({
  complete: positions.every((position) => position.status === 'ok'),
  positions,
  asOf,
  cohortId: 'aug-2026-ab-vault-routes',
  measurement: 'current_erc4626_holder_stock_not_route_attributed_tvl',
  cohortCoverage: 'fixed_seed_no_new_entrant_discovery',
  blockHash: `0x${'1'.repeat(64)}`,
  unknownCount: positions.filter((position) => position.status !== 'ok').length,
})

test('sums current GHO holder stock without calling it TVL or USD', () => {
  const result = summarizeGhoHolding(snapshot([holding('1200000000000000000'), holding('0')]), now)
  assert.equal(result.status, 'ok')
  assert.equal(result.data.holderStockRaw, '1200000000000000000')
  assert.equal(result.data.holderStockGho, 1.2)
  assert.equal(result.data.nonzeroHolderCount, 1)
  assert.equal(result.data.measurement, 'current_erc4626_holder_stock_not_route_attributed_tvl')
})

test('missing rows, wrong asset, and stale block publish no stock total', () => {
  assert.equal(
    summarizeGhoHolding(snapshot([holding(null, 'unknown')]), now).data.holderStockGho,
    null,
  )
  assert.equal(
    summarizeGhoHolding(
      snapshot([{ ...holding('1'), assetAddress: '0x0000000000000000000000000000000000000000' }]),
      now,
    ).data.holderStockGho,
    null,
  )
  assert.equal(
    summarizeGhoHolding(snapshot([holding('1')], '2026-09-26T16:00:00.000Z'), now).status,
    'incomplete',
  )
})
