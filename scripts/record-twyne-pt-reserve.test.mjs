import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TWYNE_PT_RESERVE,
  collectTwynePtReserveObservation,
  persistTwynePtReserveObservation,
} from './record-twyne-pt-reserve.mjs'

const BLOCK = 26_080_000n
const HASH = `0x${'a'.repeat(64)}`
const CHANGED_HASH = `0x${'b'.repeat(64)}`
const AT = 1_780_000_000n
function fixture({ historical = false, change = {}, changedHash = false } = {}) {
  const calls = []
  let numericReads = 0
  const nowMs = Number(AT) * 1000 + 60_000
  const client = {
    getChainId: async () => 1,
    getBlock: async ({ blockTag, blockNumber }) => {
      if (blockTag === 'finalized') return { number: BLOCK, hash: HASH, timestamp: AT }
      numericReads++
      return {
        number: blockNumber,
        hash: changedHash && numericReads === 2 ? CHANGED_HASH : HASH,
        timestamp: historical ? AT - 86_400n : AT,
      }
    },
    readContract: async ({ address, functionName, args, blockNumber }) => {
      calls.push({ address, functionName, args, blockNumber })
      const defaults = {
        asset: TWYNE_PT_RESERVE.pt,
        aToken: TWYNE_PT_RESERVE.aToken,
        UNDERLYING_ASSET_ADDRESS: TWYNE_PT_RESERVE.pt,
        POOL: TWYNE_PT_RESERVE.pool,
        getReserveData: { aTokenAddress: TWYNE_PT_RESERVE.aToken },
        decimals: 18,
        balanceOf: 123_456n,
      }
      return functionName in change ? change[functionName] : defaults[functionName]
    },
  }
  return { client, calls, nowMs }
}

test('same finalized block verifies identities before PT reserve cash read', async () => {
  const { client, calls, nowMs } = fixture()
  const row = await collectTwynePtReserveObservation(client, { clock: () => nowMs })
  assert.equal(row.routeKey, TWYNE_PT_RESERVE.routeKey)
  assert.equal(row.block, String(BLOCK))
  assert.equal(row.blockHash, HASH)
  assert.equal(row.ptDecimals, 18)
  assert.equal(row.aavePtReserveCashRaw, '123456')
  assert.equal('cashRaw' in row, false)
  assert.ok(calls.every((call) => call.blockNumber === BLOCK))
  const reserve = calls.findIndex((call) => call.functionName === 'getReserveData')
  const balance = calls.findIndex((call) => call.functionName === 'balanceOf')
  assert.ok(reserve >= 0 && reserve < balance)
  assert.deepEqual(calls[balance].args, [TWYNE_PT_RESERVE.aToken])
  assert.equal(calls[balance].address, TWYNE_PT_RESERVE.pt)
})

test('explicit historical block reads same identities but remains separate from prospective freshness', async () => {
  const { client, calls, nowMs } = fixture({ historical: true })
  const row = await collectTwynePtReserveObservation(client, {
    blockNumber: BLOCK - 100n,
    clock: () => nowMs,
  })
  assert.equal(row.block, String(BLOCK - 100n))
  assert.ok(calls.every((call) => call.blockNumber === BLOCK - 100n))
  assert.equal('captureKind' in row, false)
  await assert.rejects(
    () => collectTwynePtReserveObservation(client, { clock: () => nowMs }),
    /finalized_head_stale/,
  )
})

test('identity failures prevent the PT balance read', async () => {
  const cases = [
    [{ asset: TWYNE_PT_RESERVE.aToken }, 'wrapper_asset_mismatch'],
    [{ aToken: TWYNE_PT_RESERVE.pt }, 'wrapper_atoken_mismatch'],
    [{ UNDERLYING_ASSET_ADDRESS: TWYNE_PT_RESERVE.aToken }, 'atoken_underlying_mismatch'],
    [{ POOL: TWYNE_PT_RESERVE.pt }, 'atoken_pool_mismatch'],
    [{ getReserveData: { aTokenAddress: TWYNE_PT_RESERVE.pt } }, 'reserve_atoken_mismatch'],
  ]
  for (const [change, reason] of cases) {
    const { client, calls, nowMs } = fixture({ change })
    await assert.rejects(
      () => collectTwynePtReserveObservation(client, { clock: () => nowMs }),
      new RegExp(reason),
    )
    assert.equal(
      calls.some((call) => call.functionName === 'balanceOf'),
      false,
    )
  }
})

test('future or reorged blocks and invalid token values fail closed', async () => {
  const { client, nowMs } = fixture({ changedHash: true })
  await assert.rejects(
    () => collectTwynePtReserveObservation(client, { clock: () => nowMs }),
    /block_hash_changed/,
  )
  await assert.rejects(
    () => collectTwynePtReserveObservation(client, { blockNumber: BLOCK + 1n }),
    /block_not_finalized/,
  )
  for (const change of [{ decimals: 37 }, { balanceOf: -1n }]) {
    const source = fixture({ change })
    await assert.rejects(
      () =>
        collectTwynePtReserveObservation(source.client, {
          clock: () => source.nowMs,
        }),
      /invalid_decimals|invalid_cash/,
    )
  }
})

test('persistence passes exact row to DB function and requires a boolean receipt', async () => {
  const source = fixture()
  const row = await collectTwynePtReserveObservation(source.client, {
    clock: () => source.nowMs,
  })
  const captured = []
  const sql = (parts, ...values) => {
    captured.push({ text: parts.join('?'), payload: JSON.parse(values[0]) })
    return [{ inserted: true }]
  }
  assert.deepEqual(await persistTwynePtReserveObservation(sql, row), { inserted: true })
  assert.match(captured[0].text, /twyne_pt_reserve_record/)
  assert.deepEqual(captured[0].payload, row)
  await assert.rejects(
    () => persistTwynePtReserveObservation(() => [], row),
    /persistence_receipt_missing/,
  )
  await assert.rejects(
    () => persistTwynePtReserveObservation(sql, { ...row, wrapper: TWYNE_PT_RESERVE.pt }),
    /invalid_observation/,
  )
})
