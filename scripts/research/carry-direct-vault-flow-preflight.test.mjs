import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FROZEN_ROUTES,
  MAX_CANDIDATE_BLOCKS,
  MAX_RPC_CALLS,
  TOPICS,
  compareOrigins,
  findHistoricalCandidates,
  normalizeLogs,
  preflight,
  selectOrigins,
  selectCandidateOrigins,
  verifyHeaderChain,
} from './carry-direct-vault-flow-preflight.mjs'

const blockHash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const word = (value) => value.slice(2).padStart(64, '0')
const addressWord = (value) => `0x${word(value)}`
const sampledHeaders = () =>
  Array.from({ length: 8 }, (_, i) => ({
    number: 93 + i,
    hash: blockHash(93 + i),
    parentHash: blockHash(92 + i),
    timestamp: 1_700_000_000 + (93 + i) * 12,
  }))
const log = (route, atBlock = 100) => ({
  address: route.vault,
  blockNumber: `0x${atBlock.toString(16)}`,
  blockHash: blockHash(atBlock),
  transactionHash: blockHash(999),
  logIndex: '0x0',
  topics: [TOPICS.deposit, addressWord(route.vault), addressWord(route.vault)],
  data: `0x${'0'.repeat(127)}1`,
  removed: false,
})

function fixtureFetch({
  logOrigin = null,
  malformedAsset = false,
  badParentAt = null,
  badLogBlockHash = false,
  eventBlock = 100,
} = {}) {
  const seen = []
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body)
    const host = new URL(url).hostname
    seen.push({ host, request })
    const [arg] = request.params
    let result
    if (request.method === 'eth_chainId') result = '0x1'
    else if (request.method === 'eth_getBlockByNumber') {
      const n = arg === 'finalized' ? 100 : Number(BigInt(arg))
      result = {
        number: `0x${n.toString(16)}`,
        hash: blockHash(n),
        parentHash: badParentAt === n && host === 'two.example' ? blockHash(1) : blockHash(n - 1),
        timestamp: `0x${(1_700_000_000 + n * 12).toString(16)}`,
      }
    } else if (request.method === 'eth_getCode') result = '0x60016000'
    else if (request.method === 'eth_call') {
      const route = FROZEN_ROUTES.find((item) => item.vault === arg.to)
      result = addressWord(
        malformedAsset && host === 'two.example' ? FROZEN_ROUTES[0].vault : route.asset,
      )
    } else if (request.method === 'eth_getStorageAt')
      result = addressWord(FROZEN_ROUTES[2].implementation)
    else if (request.method === 'eth_getLogs') {
      result =
        !logOrigin || logOrigin === host
          ? [
              badLogBlockHash
                ? { ...log(FROZEN_ROUTES[1], eventBlock), blockHash: blockHash(1) }
                : log(FROZEN_ROUTES[1], eventBlock),
            ]
          : []
      if (arg.address !== FROZEN_ROUTES[1].vault) result = []
      if (Number(BigInt(arg.toBlock)) < eventBlock || Number(BigInt(arg.fromBlock)) > eventBlock)
        result = []
    } else throw Error('unexpected_method')
    return {
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
    }
  }
  return { fetchImpl, seen }
}

test('pins the three route identities and distinct HTTPS origins', () => {
  assert.deepEqual(
    FROZEN_ROUTES.map((row) => row.routeKey),
    ['USDS → StUsds [USDS]', 'GHO → sGho [GHO]', 'USDC → USD3 [USDC]'],
  )
  assert.equal(FROZEN_ROUTES[2].implementation, '0xd1f1c3f485063712873285bf4ef25ab068f13893')
  assert.deepEqual(
    selectOrigins(['https://one.example/a', 'https://one.example/b', 'https://two.example/c']).map(
      (x) => x.host,
    ),
    ['one.example', 'two.example'],
  )
  assert.throws(
    () => selectOrigins(['https://one.example', 'https://one.example/x']),
    /two_origins/,
  )
})

test('two-origin finalized preflight distinguishes observed events from quiet ranges', async () => {
  const { fetchImpl, seen } = fixtureFetch()
  const result = await preflight({
    fetchImpl,
    urls: ['https://one.example', 'https://two.example'],
  })
  assert.equal(result.range.from, 93)
  assert.equal(result.range.to, 100)
  assert.equal(result.routes[0].status, 'no_events_in_sampled_range')
  assert.equal(result.routes[1].status, 'standard_events_observed')
  assert.equal(result.routes[1].depositCount, 1)
  assert.equal(result.routes[1].withdrawCount, 0)
  assert.equal(result.routes[1].earlierUnverifiedEventCount, 0)
  assert.equal(result.routes[1].witnesses[0].logs[0].identityAtPinnedBlock, 'verified')
  assert.equal(result.routes[2].status, 'no_events_in_sampled_range')
  assert.equal(result.limits.actual.calls, 40)
  assert.ok(result.limits.actual.calls <= MAX_RPC_CALLS)
  assert.equal(result.receipts.length, 40)
  assert.equal(result.headerChains[0].headers.length, 8)
  assert.deepEqual(result.headerChains[0].headers, result.headerChains[1].headers)
  assert.equal(seen.filter((row) => row.request.method === 'eth_getLogs').length, 6)
  assert.equal(
    seen
      .filter((row) => ['eth_getCode', 'eth_call', 'eth_getStorageAt'].includes(row.request.method))
      .every((row) => row.request.params.at(-1).blockHash === blockHash(100)),
    true,
  )
})

test('an earlier-window event remains context until its own block is pinned', async () => {
  const { fetchImpl } = fixtureFetch({ eventBlock: 99 })
  const earlier = await preflight({
    fetchImpl,
    urls: ['https://one.example', 'https://two.example'],
    toBlock: 100,
  })
  assert.equal(earlier.routes[1].status, 'earlier_events_unverified_identity')
  assert.equal(earlier.routes[1].depositCount, 0)
  assert.equal(earlier.routes[1].withdrawCount, 0)
  assert.equal(earlier.routes[1].earlierUnverifiedEventCount, 1)
  assert.equal(
    earlier.routes[1].witnesses[0].logs[0].identityAtPinnedBlock,
    'unverified_earlier_block',
  )
  const pinned = await preflight({
    fetchImpl,
    urls: ['https://one.example', 'https://two.example'],
    toBlock: 99,
  })
  assert.equal(pinned.routes[1].status, 'standard_events_observed')
  assert.equal(pinned.routes[1].depositCount, 1)
  assert.equal(pinned.routes[1].earlierUnverifiedEventCount, 0)
})

test('historical target uses exact eight blocks and rejects unfinalized targets', async () => {
  const { fetchImpl } = fixtureFetch()
  const result = await preflight({
    fetchImpl,
    urls: ['https://one.example', 'https://two.example'],
    toBlock: 98,
  })
  assert.deepEqual(result.range, {
    from: 91,
    to: 98,
    fromHash: blockHash(91),
    toHash: blockHash(98),
  })
  assert.equal(
    result.routes.every((route) => route.status === 'no_events_in_sampled_range'),
    true,
  )
  await assert.rejects(
    preflight({ fetchImpl, urls: ['https://one.example', 'https://two.example'], toBlock: 101 }),
    /target_not_finalized/,
  )
})

test('bounded historical discovery preserves single-origin candidates without verified claims', async () => {
  const seen = []
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body)
    seen.push({ host: new URL(url).hostname, request })
    const result = FROZEN_ROUTES.map((route, i) => ({
      ...log(route),
      logIndex: `0x${i.toString(16)}`,
      transactionHash: blockHash(1000 + i),
    }))
    return {
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
    }
  }
  const result = await findHistoricalCandidates({
    fromBlock: 93,
    toBlock: 100,
    urls: ['https://one.example'],
    fetchImpl,
  })
  assert.equal(result.sourceAgreement, 'single_hostname_unverified')
  assert.equal(
    result.routes.every((route) => route.status === 'unverified_candidate'),
    true,
  )
  assert.deepEqual(
    result.routes.map((route) => route.candidateBlocks),
    [[100], [100], [100]],
  )
  assert.equal(result.receipts.length, 1)
  assert.equal(result.limits.actual.calls, 1)
  assert.equal(seen[0].request.method, 'eth_getLogs')
  assert.equal(seen[0].request.params[0].address.length, 3)
  assert.equal(seen[0].request.params[0].topics[0].length, 2)
  assert.throws(
    () => selectCandidateOrigins(['https://one.example', 'https://one.example/x']),
    /candidate_origins_invalid/,
  )
  await assert.rejects(
    findHistoricalCandidates({
      fromBlock: 1,
      toBlock: MAX_CANDIDATE_BLOCKS + 1,
      urls: ['https://one.example'],
      fetchImpl,
    }),
    /candidate_range_invalid/,
  )
})

test('historical candidate empty and two-origin disagreement remain unverified/fail closed', async () => {
  const emptyFetch = async (_url, options) => {
    const request = JSON.parse(options.body)
    return {
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result: [] }),
    }
  }
  const empty = await findHistoricalCandidates({
    fromBlock: 93,
    toBlock: 100,
    urls: ['https://one.example'],
    fetchImpl: emptyFetch,
  })
  assert.equal(
    empty.routes.every((route) => route.status === 'no_candidate_in_sampled_range'),
    true,
  )
  assert.equal(empty.sourceAgreement, 'single_hostname_unverified')
  const divergentFetch = async (url, options) => {
    const request = JSON.parse(options.body)
    const result = new URL(url).hostname === 'one.example' ? [log(FROZEN_ROUTES[1])] : []
    return {
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
    }
  }
  await assert.rejects(
    findHistoricalCandidates({
      fromBlock: 93,
      toBlock: 100,
      urls: ['https://one.example', 'https://two.example'],
      fetchImpl: divergentFetch,
    }),
    /origin_disagreement/,
  )
})

test('origin disagreement or wrong asset fails closed', async () => {
  const divergent = fixtureFetch({ logOrigin: 'one.example' })
  await assert.rejects(
    preflight({
      fetchImpl: divergent.fetchImpl,
      urls: ['https://one.example', 'https://two.example'],
    }),
    /origin_disagreement/,
  )
  const wrong = fixtureFetch({ malformedAsset: true })
  await assert.rejects(
    preflight({ fetchImpl: wrong.fetchImpl, urls: ['https://one.example', 'https://two.example'] }),
    /asset_identity_mismatch/,
  )
  assert.throws(() => compareOrigins({ a: 1 }, { a: 2 }), /origin_disagreement/)
  const brokenChain = fixtureFetch({ badParentAt: 97 })
  await assert.rejects(
    preflight({
      fetchImpl: brokenChain.fetchImpl,
      urls: ['https://one.example', 'https://two.example'],
    }),
    /header_chain_invalid/,
  )
  const wrongBlock = fixtureFetch({ badLogBlockHash: true })
  await assert.rejects(
    preflight({
      fetchImpl: wrongBlock.fetchImpl,
      urls: ['https://one.example', 'https://two.example'],
    }),
    /log_block_mismatch/,
  )
})

test('rejects malformed or out-of-range log responses', () => {
  const route = FROZEN_ROUTES[1]
  const receipt = (rows) => ({ response: { result: rows } })
  const headers = sampledHeaders()
  const decoded = normalizeLogs(receipt([log(route)]), route.vault, 93, 100, headers)
  assert.equal(decoded.length, 1)
  assert.equal(decoded[0].eventName, 'Deposit')
  assert.equal(decoded[0].sender, route.vault)
  assert.equal(decoded[0].sharesRaw, '1')
  const withdraw = {
    ...log(route),
    topics: [
      TOPICS.withdraw,
      addressWord(route.vault),
      addressWord(route.asset),
      addressWord(route.vault),
    ],
  }
  const decodedWithdraw = normalizeLogs(receipt([withdraw]), route.vault, 93, 100, headers)
  assert.equal(decodedWithdraw[0].eventName, 'Withdraw')
  assert.equal(decodedWithdraw[0].receiver, route.asset)
  assert.throws(
    () =>
      normalizeLogs(
        receipt([{ ...log(route), blockNumber: '0x65' }]),
        route.vault,
        93,
        100,
        headers,
      ),
    /outside_range/,
  )
  assert.throws(
    () => normalizeLogs(receipt([log(route), log(route)]), route.vault, 93, 100, headers),
    /duplicate_log/,
  )
  assert.throws(
    () =>
      normalizeLogs(
        receipt([{ ...log(route), topics: [blockHash(1)] }]),
        route.vault,
        93,
        100,
        headers,
      ),
    /logs_invalid/,
  )
  assert.throws(
    () =>
      normalizeLogs(
        receipt([
          {
            ...log(route),
            topics: [
              TOPICS.deposit,
              `0x${'f'.repeat(24)}${'1'.repeat(40)}`,
              addressWord(route.vault),
            ],
          },
        ]),
        route.vault,
        93,
        100,
        headers,
      ),
    /logs_invalid/,
  )
  assert.throws(
    () =>
      normalizeLogs(
        receipt([{ ...log(route), data: `0x${'f'.repeat(126)}` }]),
        route.vault,
        93,
        100,
        headers,
      ),
    /event_decode_invalid|logs_invalid/,
  )
  assert.throws(() => verifyHeaderChain([headers[0]], 93, 100), /header_chain_invalid/)
})
