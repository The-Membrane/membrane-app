import assert from 'node:assert/strict'
import test from 'node:test'

import { TOPICS } from './carry-direct-vault-flow-preflight.mjs'
import {
  MAX_EXPECTED_RPC_CALLS,
  MAX_CANDIDATE_BLOCKS,
  ROUTES,
  findSecondaryHistoricalCandidates,
  preflightSecondaryVaultEvents,
} from './carry-secondary-vault-event-preflight.mjs'

const URLS = ['https://one.example', 'https://two.example']
const blockHash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const addressWord = (address) => `0x${address.slice(2).padStart(64, '0')}`
const data = `0x${'0'.repeat(63)}5${'0'.repeat(63)}1`

function fixture({
  eventRoute = null,
  eventBlock = 100,
  disagree = false,
  malformed = false,
  badAsset = false,
} = {}) {
  const requests = []
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body)
    requests.push({ url, request })
    const [arg] = request.params
    let result
    if (request.method === 'eth_chainId') result = '0x1'
    else if (request.method === 'eth_getBlockByNumber') {
      const number = arg === 'finalized' ? 100 : Number(BigInt(arg))
      result = {
        number: `0x${number.toString(16)}`,
        hash: blockHash(number),
        parentHash: blockHash(number - 1),
        timestamp: '0x1',
      }
    } else if (request.method === 'eth_getCode') result = '0x6001'
    else if (request.method === 'eth_call') {
      const route = ROUTES.find((item) => item.vault === arg.to)
      result = addressWord(badAsset && route === ROUTES[0] ? ROUTES[1].asset : route.asset)
    } else if (request.method === 'eth_getStorageAt') {
      const route = ROUTES.find((item) => item.vault === arg)
      result = addressWord(route.implementation)
    } else if (request.method === 'eth_getLogs') {
      result = []
      if (
        eventRoute !== null &&
        (arg.address === ROUTES[eventRoute].vault ||
          arg.address.includes?.(ROUTES[eventRoute].vault))
      ) {
        result = [
          {
            address: ROUTES[eventRoute].vault,
            blockNumber: `0x${eventBlock.toString(16)}`,
            blockHash: blockHash(eventBlock),
            transactionHash: blockHash(999),
            logIndex: '0x0',
            removed: false,
            topics: [
              TOPICS.deposit,
              addressWord(ROUTES[eventRoute].vault),
              addressWord(ROUTES[eventRoute].vault),
            ],
            data: malformed ? '0x1' : data,
          },
        ]
        if (disagree && url === URLS[1]) result = []
      }
    } else throw Error(`unexpected_method_${request.method}`)
    return {
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
    }
  }
  return { fetchImpl, requests }
}

test('four distinct addresses with two Fluid route labels and exact assets', async () => {
  const source = fixture({ eventRoute: 0 })
  const result = await preflightSecondaryVaultEvents({ urls: URLS, ...source })
  assert.equal(result.routes.length, 4)
  assert.equal(result.routes[0].routeKeys.length, 2)
  assert.equal(result.routes[0].flowUnit, 'USDC')
  assert.equal(result.routes[1].flowUnit, 'PT-srUSDe-22OCT2026')
  assert.equal(result.routes[0].status, 'standard_events_observed')
  assert.equal(result.routes[0].pinnedDepositCount, 1)
  assert.equal(result.routes[0].pinnedWithdrawCount, 0)
  assert.equal(result.routes[1].status, 'no_events_in_sampled_range')
  assert.equal(result.limits.actual.calls, MAX_EXPECTED_RPC_CALLS)
  assert.equal(result.receipts.length, MAX_EXPECTED_RPC_CALLS)
  assert.equal(source.requests.filter((entry) => entry.request.method === 'eth_getLogs').length, 8)
})

test('earlier event is context, not pinned identity proof', async () => {
  const result = await preflightSecondaryVaultEvents({
    urls: URLS,
    ...fixture({ eventRoute: 2, eventBlock: 99 }),
  })
  assert.equal(result.routes[2].status, 'earlier_events_unverified_identity')
  assert.equal(result.routes[2].pinnedDepositCount, 0)
  assert.equal(result.routes[2].earlierUnverifiedEventCount, 1)
})

test('strict decoding and cross-origin agreement reject false event proof', async () => {
  await assert.rejects(
    preflightSecondaryVaultEvents({ urls: URLS, ...fixture({ eventRoute: 3, malformed: true }) }),
    /direct_flow_logs_invalid/,
  )
  await assert.rejects(
    preflightSecondaryVaultEvents({ urls: URLS, ...fixture({ eventRoute: 3, disagree: true }) }),
    /direct_flow_origin_disagreement/,
  )
})

test('asset mismatch and unfinalized target fail closed', async () => {
  await assert.rejects(
    preflightSecondaryVaultEvents({ urls: URLS, ...fixture({ badAsset: true }) }),
    /secondary_flow_asset_mismatch/,
  )
  await assert.rejects(
    preflightSecondaryVaultEvents({ urls: URLS, toBlock: 101, ...fixture() }),
    /secondary_flow_target_not_finalized/,
  )
})

test('a frozen vault can be selected without duplicating Fluid labels', async () => {
  const result = await preflightSecondaryVaultEvents({
    urls: URLS,
    vaults: [ROUTES[0].vault],
    ...fixture(),
  })
  assert.equal(result.routes.length, 1)
  assert.deepEqual(result.routes[0].routeKeys, ROUTES[0].routeKeys)
  assert.equal(result.limits.actual.calls, 20)
  await assert.rejects(
    preflightSecondaryVaultEvents({ urls: URLS, vaults: [ROUTES[0].vault, ROUTES[0].vault] }),
    /secondary_flow_selection_invalid/,
  )
})

test('single-origin historical hit remains an unverified lead', async () => {
  const source = fixture({ eventRoute: 0 })
  const result = await findSecondaryHistoricalCandidates({
    urls: [URLS[0]],
    fromBlock: 99,
    toBlock: 100,
    ...source,
  })
  assert.equal(result.sourceAgreement, 'single_hostname_unverified')
  assert.equal(result.routes[0].status, 'unverified_candidate')
  assert.deepEqual(result.routes[0].candidateBlocks, [100])
  assert.equal(result.routes[0].routeKeys.length, 2)
  assert.equal(result.receipts.length, 1)
  assert.equal(result.receipts[0].origin, 'one.example')
  assert.deepEqual(result.receipts[0].response.result[0].topics[0], TOPICS.deposit)
  assert.equal(result.routes[0].pinnedDepositCount, undefined)
})

test('empty two-origin historical range does not claim event absence beyond the sample', async () => {
  const result = await findSecondaryHistoricalCandidates({
    urls: URLS,
    fromBlock: 99,
    toBlock: 100,
    ...fixture(),
  })
  assert.equal(result.sourceAgreement, 'two_hostname_agreed_unverified')
  assert.equal(result.limits.actual.calls, 2)
  assert.ok(result.routes.every((route) => route.status === 'no_candidate_in_sampled_range'))
})

test('historical provider disagreement and out-of-bound range fail closed', async () => {
  await assert.rejects(
    findSecondaryHistoricalCandidates({
      urls: URLS,
      fromBlock: 99,
      toBlock: 100,
      ...fixture({ eventRoute: 3, disagree: true }),
    }),
    /direct_flow_origin_disagreement/,
  )
  await assert.rejects(
    findSecondaryHistoricalCandidates({
      urls: [URLS[0]],
      fromBlock: 0,
      toBlock: MAX_CANDIDATE_BLOCKS,
      ...fixture(),
    }),
    /secondary_flow_candidate_range_invalid/,
  )
})
