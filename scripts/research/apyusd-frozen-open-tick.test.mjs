import assert from 'node:assert/strict'
import test from 'node:test'

import { boundedCurrentObserver, runApyUsdFrozenOpen } from './apyusd-frozen-open-tick.mjs'

const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`
const ZERO = word(0)
const holder = word(1)
const mint = (tokenId) => ({ topics: [word(9), ZERO, holder, word(tokenId)] })
const burn = (tokenId) => ({ topics: [word(9), holder, ZERO, word(tokenId)] })
const source = { mints: [mint(881), mint(891)] }
const transfers = {
  cohort: { openIds: ['881', '891'] },
  transfers: [mint(881), mint(891)],
}
const rows = [{ transfers: [burn(881), burn(891)] }]
const base = {
  continuity: async () => ({ status: 'captured' }),
  scan: async () => ({ status: 'captured' }),
  scanLoader: async () => rows,
  sourceLoader: async () => source,
  transfersLoader: async () => transfers,
  observer: async () => null,
  storedPayout: async () => false,
  freeBytes: () => 4_000_000_000,
  clock: () => 0,
}

test('one campaign lane orders continuity, one scan window and at most one mined payout', async () => {
  const calls = []
  const result = await runApyUsdFrozenOpen({
    ...base,
    continuity: async () => {
      calls.push('continuity')
      return { status: 'captured' }
    },
    scan: async ({ maxWindows }) => {
      calls.push(`scan:${maxWindows}`)
      return { status: 'captured' }
    },
    payout: async (tokenId) => calls.push(`payout:${tokenId}`),
  })
  assert.deepEqual(calls, ['continuity', 'scan:1', 'payout:881'])
  assert.equal(result.payout, 'captured:881')
  assert.deepEqual(result.errors, [])
})

test('no verified burn avoids payout source and RPC reads', async () => {
  let sourceReads = 0
  let payouts = 0
  const result = await runApyUsdFrozenOpen({
    ...base,
    scanLoader: async () => [{ transfers: [] }],
    sourceLoader: async () => {
      sourceReads++
      return source
    },
    payout: async () => {
      payouts++
    },
  })
  assert.equal(result.payout, 'no_burn')
  assert.equal(sourceReads, 0)
  assert.equal(payouts, 0)
})

test('current-stage failure cannot stop the independent scan or first pending payout', async () => {
  const calls = []
  const result = await runApyUsdFrozenOpen({
    ...base,
    continuity: async () => {
      calls.push('continuity')
      throw Error('current_rpc_failed')
    },
    scan: async () => {
      calls.push('scan')
      throw Error('scan_rpc_failed')
    },
    storedPayout: async (id) => id === '881',
    payout: async (id) => calls.push(`payout:${id}`),
  })
  assert.deepEqual(calls, ['continuity', 'scan', 'payout:891'])
  assert.deepEqual(result.errors, ['continuity', 'scan'])
})

test('a failed first payout cannot starve the next burned ID on later ticks', async () => {
  const calls = []
  const options = {
    ...base,
    payout: async (tokenId) => {
      calls.push(tokenId)
      if (tokenId === '881') throw Error('temporary_rpc_failure')
    },
  }
  const first = await runApyUsdFrozenOpen(options)
  const second = await runApyUsdFrozenOpen({ ...options, clock: () => 2 * 3_600_000 })
  assert.deepEqual(calls, ['881', '891'])
  assert.deepEqual(first.errors, ['payout'])
  assert.equal(second.payout, 'captured:891')
})

test('an invalid stored proof is visible and cannot hide a later valid burn', async () => {
  const calls = []
  const result = await runApyUsdFrozenOpen({
    ...base,
    storedPayout: async (tokenId) => {
      if (tokenId === '881') throw Error('local_artifact_invalid')
      return false
    },
    payout: async (tokenId) => calls.push(tokenId),
  })
  assert.deepEqual(calls, ['891'])
  assert.deepEqual(result.errors, ['saved_payout_invalid'])
  assert.equal(result.payout, 'captured:891')
})

test('saved payouts receive one rotating live recheck when no new burn is pending', async () => {
  const calls = []
  const options = {
    ...base,
    storedPayout: async () => true,
    liveVerifier: async (tokenId) => calls.push(tokenId),
    payout: async () => {
      throw Error('unexpected_new_capture')
    },
  }
  const first = await runApyUsdFrozenOpen(options)
  const second = await runApyUsdFrozenOpen({ ...options, clock: () => 2 * 3_600_000 })
  assert.deepEqual(calls, ['881', '891'])
  assert.equal(first.payout, 'reverified:881')
  assert.equal(second.payout, 'reverified:891')
})

test('disk and elapsed-time gates stop work before unsafe stages', async () => {
  let calls = 0
  await assert.rejects(
    runApyUsdFrozenOpen({
      ...base,
      freeBytes: () => 0,
      continuity: async () => {
        calls++
      },
    }),
    /apyusd_frozen_disk_reserve/,
  )
  assert.equal(calls, 0)
  const light = await runApyUsdFrozenOpen({
    ...base,
    freeBytes: () => 1_200_000_000,
    scanLoader: async () => [],
  })
  assert.equal(light.payout, 'no_burn')
  let clockMs = 0
  const result = await runApyUsdFrozenOpen({
    ...base,
    clock: () => clockMs,
    continuity: async () => {
      clockMs = 400_000
      return { status: 'captured' }
    },
    scan: async () => {
      calls++
    },
    payout: async () => {
      calls++
    },
  })
  assert.equal(result.scan, 'skipped')
  assert.equal(result.payout, 'deferred')
  assert.equal(calls, 0)
})

test('bounded current observation refuses requests after its cap', async () => {
  const observer = boundedCurrentObserver({
    urls: ['a', 'b'],
    clientsForUrls: () => [{ request: async () => null, send: async () => null }],
    observer: async ({ clientsForUrls }) => {
      const [origin] = clientsForUrls(['a', 'b'])
      for (let index = 0; index < 111; index++) await origin.request('eth_test', [])
      return { status: 'unsealed' }
    },
    clock: () => 0,
  })
  await assert.rejects(observer({ sourceLoader: async () => null }), /apyusd_frozen_current_budget/)
})
