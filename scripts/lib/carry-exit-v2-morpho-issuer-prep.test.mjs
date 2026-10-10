import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CARRY_EXIT_V2_FROZEN_ROUTES } from './carry-exit-v2-rpc-proof.mjs'
import {
  captureFreshMorphoBaseline,
  dedupeMorphoQEntries,
  discoverMorphoIssuerCandidate,
  freezeMorphoQLadder,
} from './carry-exit-v2-morpho-issuer-prep.mjs'

const route = CARRY_EXIT_V2_FROZEN_ROUTES.find((x) => x.kind === 'morpho')
const h = (x) => `0x${x.repeat(64)}`
const a = (x) => `0x${x.repeat(40)}`
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`
const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const blocks = {
  50: { number: '0x32', hash: h('5'), parentHash: h('4'), timestamp: '0x6553f000' },
  98: { number: '0x62', hash: h('8'), parentHash: h('7'), timestamp: '0x6553f098' },
  99: { number: '0x63', hash: h('9'), parentHash: h('8'), timestamp: '0x6553f09f' },
  100: { number: '0x64', hash: h('a'), parentHash: h('9'), timestamp: '0x6553f0a0' },
}

function log(owner, index, shares = 2n) {
  return {
    address: route.destination,
    topics: [transfer, word(1), word(BigInt(owner))],
    data: word(shares),
    blockNumber: '0x62',
    blockHash: h('8'),
    transactionHash: h(index === 1 ? 'b' : index === 2 ? 'c' : index.toString(16)),
    transactionIndex: `0x${index.toString(16)}`,
    logIndex: `0x${index.toString(16)}`,
  }
}

function fixture({
  logs = [log(a('1'), 1)],
  forged = false,
  forgedTxHashes = new Set(),
  reorg = false,
  shares = new Map(),
  claims = new Map(),
  maxLogSpan = null,
} = {}) {
  let baselineReads = 0
  const requests = []
  const request = async (method, params) => {
    requests.push([method, params])
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_getBlockByNumber') {
      const n = params[0] === 'finalized' ? 100 : Number(BigInt(params[0]))
      if (n === 100 && ++baselineReads > 1 && reorg) return { ...blocks[100], hash: h('d') }
      return blocks[n]
    }
    if (method === 'eth_getCode') return params[0] === route.destination ? '0x6000' : '0x'
    if (method === 'eth_getLogs') {
      const from = BigInt(params[0].fromBlock)
      const through = BigInt(params[0].toBlock)
      if (maxLogSpan != null && through - from + 1n > BigInt(maxLogSpan))
        throw Error('rpc_http_400')
      return logs.filter(
        (entry) => BigInt(entry.blockNumber) >= from && BigInt(entry.blockNumber) <= through,
      )
    }
    if (method === 'eth_getTransactionReceipt') {
      const found = logs.find((x) => x.transactionHash === params[0])
      return {
        transactionHash: found.transactionHash,
        blockHash: found.blockHash,
        blockNumber: found.blockNumber,
        status: '0x1',
        logs: [
          forged || forgedTxHashes.has(found.transactionHash)
            ? { ...found, data: word(99) }
            : found,
        ],
      }
    }
    if (method === 'eth_call') {
      const data = params[0].data
      if (data === '0x01e1d114') return word(10_000_000_000_000n)
      if (data === '0x38d52e0f') return word(BigInt(route.asset))
      if (data === '0x313ce567') return word(6)
      if (data.startsWith('0x70a08231')) return word(shares.get(`0x${data.slice(-40)}`) ?? 10n)
      if (data.startsWith('0x4cdad506'))
        return word(claims.get(BigInt(`0x${data.slice(-64)}`)) ?? 20_000_000_000n)
    }
    throw Error(`unexpected_${method}`)
  }
  return { request, requests }
}

const inputs = {
  routeKey: route.routeKey,
  destination: route.destination,
  asset: route.asset,
  provider: 'fixture',
  source: 'issuer',
}
async function baseline(request) {
  return captureFreshMorphoBaseline({
    ...inputs,
    request,
    now: () => new Date('2023-11-14T22:20:00.000Z'),
  })
}
const candidate = (value, request) => discoverMorphoIssuerCandidate({ baseline: value, request })

test('fresh baseline has collector-compatible headers and EIP-1898 pinned reads', async () => {
  const { request, requests } = fixture()
  const result = await baseline(request)
  assert.equal(result.canonicalityEvidenceDoc.schema, 'carry_exit_v2_headers_v1')
  assert.equal(result.targetHash, h('a'))
  assert.equal(result.targetParentHash, h('9'))
  assert.ok(
    requests
      .filter(([m]) => m === 'eth_call' || m === 'eth_getCode')
      .every(([, p]) => p[1].blockHash === h('a') && p[1].requireCanonical === true),
  )
})

test('default candidate discovery clips above genesis and records the scanned window', async () => {
  const { request, requests } = fixture()
  const result = await candidate(await baseline(request), request)
  assert.equal(result.evidenceDoc.candidateWindow.fromBlock, '1')
  assert.equal(result.evidenceDoc.candidateWindow.throughBlock, '99')
  assert.equal(requests.find(([method]) => method === 'eth_getLogs')[1][0].fromBlock, '0x1')
})

test('short discovery scans only its recorded window and can omit an older holder', async () => {
  const old = { ...log(a('1'), 1, 1_000n), blockNumber: '0x32', blockHash: h('5') }
  const recent = log(a('2'), 2, 1n)
  const full = fixture({ logs: [old, recent] })
  const fullResult = await candidate(await baseline(full.request), full.request)
  assert.equal(fullResult.holder, a('1'))
  const short = fixture({ logs: [old, recent] })
  const shortResult = await discoverMorphoIssuerCandidate({
    baseline: await baseline(short.request),
    request: short.request,
    lookbackBlocks: 32,
  })
  assert.equal(shortResult.holder, a('2'))
  assert.equal(shortResult.evidenceDoc.candidateWindow.fromBlock, '68')
  assert.equal(shortResult.evidenceDoc.candidateWindow.throughBlock, '99')
  assert.equal(
    shortResult.evidenceDoc.candidateWindow.scope,
    'bounded_recent_transfer_recipient_sample',
  )
  assert.equal(shortResult.evidenceDoc.candidateWindow.exhaustiveHolderSearch, false)
  assert.ok(
    short.requests
      .filter(([method]) => method === 'eth_getLogs')
      .every(([, params]) => BigInt(params[0].fromBlock) >= 68n),
  )
})

test('short window with only older transfers reports discovery sampling, not exit inability', async () => {
  const old = { ...log(a('1'), 1), blockNumber: '0x32', blockHash: h('5') }
  const { request } = fixture({ logs: [old] })
  const result = await discoverMorphoIssuerCandidate({
    baseline: await baseline(request),
    request,
    lookbackBlocks: 32,
  })
  assert.equal(result.holder, null)
  assert.equal(result.evidenceDoc.unavailableReason, 'no_transfer_recipient_in_bounded_window')
  assert.equal(result.evidenceDoc.candidateWindow.fromBlock, '68')
  assert.equal(result.evidenceDoc.candidateWindow.exhaustiveHolderSearch, false)
})

test('invalid candidate lookbacks fail before any discovery RPC', async () => {
  const { request, requests } = fixture()
  const frozen = await baseline(request)
  const prior = requests.length
  for (const lookbackBlocks of [0, 31, 4_097, 32.5, NaN, '512']) {
    await assert.rejects(
      () => discoverMorphoIssuerCandidate({ baseline: frozen, request, lookbackBlocks }),
      /candidate_input_invalid/,
    )
  }
  assert.equal(requests.length, prior)
})

test('baseline reorg is rejected before candidate discovery', async () => {
  await assert.rejects(() => baseline(fixture({ reorg: true }).request), /baseline_reorg/)
})

test('forged receipt cannot establish a holder', async () => {
  const { request } = fixture({ forged: true })
  const result = await candidate(await baseline(request), request)
  assert.equal(result.holder, null)
  assert.equal(result.evidenceDoc.screenedCandidates[0].status, 'receipt_or_header_mismatch')
  assert.equal(result.evidenceDoc.unavailableReason, 'no_pre_baseline_eoa_with_positive_claim')
})

test('candidate attrition skips zero-share recipient and chooses next receipt-verified EOA', async () => {
  const newest = a('2')
  const older = a('1')
  const { request } = fixture({
    logs: [log(older, 1), log(newest, 2)],
    shares: new Map([
      [newest, 0n],
      [older, 10n],
    ]),
  })
  const result = await candidate(await baseline(request), request)
  assert.equal(result.holder, older)
  assert.deepEqual(
    result.evidenceDoc.screenedCandidates.map((x) => x.status),
    ['no_baseline_shares', 'eligible_holder'],
  )
  assert.ok(!JSON.stringify(result.evidenceDoc).includes(older))
  assert.ok(!JSON.stringify(result.evidenceDoc).includes(newest))
  assert.equal(result.digest.length, 64)
})

test('candidate selects the largest claim among the bounded verified EOAs', async () => {
  const newer = a('2')
  const larger = a('1')
  const { request } = fixture({
    logs: [log(larger, 1), log(newer, 2)],
    shares: new Map([
      [newer, 10n],
      [larger, 20n],
    ]),
    claims: new Map([
      [10n, 10_000_000n],
      [20n, 50_000_000n],
    ]),
  })
  const result = await candidate(await baseline(request), request)
  assert.equal(result.holder, larger)
  assert.equal(result.evidenceDoc.candidateWindow.attempted, 2)
  assert.equal(result.evidenceDoc.ladder.selectedClaimRaw, result.evidenceDoc.selectedClaimRaw)
  assert.ok(
    BigInt(result.evidenceDoc.ladder.labels[0].assetsRaw) <=
      BigInt(result.evidenceDoc.selectedClaimRaw),
  )
  assert.equal(
    result.evidenceDoc.selectionRule,
    'largest_pinned_claim_among_top_transfer_ranked_bounded_receipt_verified_eoas_tie_by_rank',
  )
})

test('large observed incoming transfer enters bounded screen ahead of eight newer small transfers', async () => {
  const large = a('1')
  const logs = [log(large, 1, 1_000n)]
  for (let index = 2; index <= 9; index++) logs.push(log(a(index.toString(16)), index, 1n))
  const { request } = fixture({ logs })
  const result = await candidate(await baseline(request), request)
  assert.equal(result.holder, large)
  assert.equal(result.evidenceDoc.candidateWindow.distinctRecipients, 9)
  assert.equal(result.evidenceDoc.candidateWindow.attempted, 8)
  assert.equal(result.evidenceDoc.screenedCandidates[0].discoveryTransactionHash, h('b'))
  assert.equal(result.evidenceDoc.screenedCandidates[0].observedIncomingSharesRaw, '1000')
  assert.equal(
    result.evidenceDoc.candidateWindow.rankingRule,
    'largest_single_pre_baseline_incoming_share_transfer_then_recency_then_owner',
  )
  assert.ok(!JSON.stringify(result.evidenceDoc).includes(large))
})

test('largest transfer still needs its exact receipt before a smaller verified candidate can win', async () => {
  const largest = log(a('1'), 1, 1_000n)
  const smaller = log(a('2'), 2, 100n)
  const { request } = fixture({
    logs: [largest, smaller],
    forgedTxHashes: new Set([largest.transactionHash]),
  })
  const result = await candidate(await baseline(request), request)
  assert.equal(result.holder, a('2'))
  assert.deepEqual(
    result.evidenceDoc.screenedCandidates.map((row) => row.status),
    ['receipt_or_header_mismatch', 'eligible_holder'],
  )
})

test('equal transfer size and claim use recency, independent of log response order', async () => {
  const older = log(a('1'), 1, 20n)
  const newer = log(a('2'), 2, 20n)
  const first = fixture({ logs: [older, newer] })
  const second = fixture({ logs: [newer, older] })
  const aResult = await candidate(await baseline(first.request), first.request)
  const bResult = await candidate(await baseline(second.request), second.request)
  assert.equal(aResult.holder, a('2'))
  assert.equal(bResult.holder, a('2'))
  assert.deepEqual(aResult.evidenceDoc.screenedCandidates, bResult.evidenceDoc.screenedCandidates)
  assert.equal(aResult.digest, bResult.digest)
})

test('repeated recipient is attested from its newest pre-baseline Transfer', async () => {
  const owner = a('1')
  const older = log(owner, 1)
  const newest = {
    ...older,
    blockNumber: '0x63',
    blockHash: h('9'),
    transactionHash: h('d'),
    transactionIndex: '0x0',
    logIndex: '0x0',
  }
  const { request, requests } = fixture({ logs: [older, newest] })
  const result = await candidate(await baseline(request), request)
  assert.equal(result.holder, owner)
  assert.equal(result.evidenceDoc.candidateWindow.distinctRecipients, 1)
  assert.equal(result.evidenceDoc.screenedCandidates[0].discoveryBlock, '99')
  assert.equal(result.evidenceDoc.screenedCandidates[0].discoveryTransactionHash, h('d'))
  assert.deepEqual(
    requests
      .filter(([method]) => method === 'eth_getTransactionReceipt')
      .map(([, params]) => params[0]),
    [h('d')],
  )
})

test('repeated recipient is attested from its largest incoming Transfer when that is older', async () => {
  const owner = a('1')
  const largest = log(owner, 1, 100n)
  const newer = {
    ...log(owner, 2, 1n),
    blockNumber: '0x63',
    blockHash: h('9'),
  }
  const { request, requests } = fixture({ logs: [newer, largest] })
  const result = await candidate(await baseline(request), request)
  assert.equal(result.holder, owner)
  assert.equal(result.evidenceDoc.screenedCandidates[0].observedIncomingSharesRaw, '100')
  assert.equal(
    result.evidenceDoc.screenedCandidates[0].discoveryTransactionHash,
    largest.transactionHash,
  )
  assert.deepEqual(
    requests
      .filter(([method]) => method === 'eth_getTransactionReceipt')
      .map(([, params]) => params[0]),
    [largest.transactionHash],
  )
})

test('provider log span limit shrinks the query on the same request origin', async () => {
  const { request, requests } = fixture({ maxLogSpan: 32 })
  const result = await candidate(await baseline(request), request)
  assert.equal(result.evidenceDoc.screenedCandidates[0].status, 'eligible_holder')
  const logCalls = requests.filter(([method]) => method === 'eth_getLogs')
  assert.ok(
    logCalls.some(
      ([, params]) => BigInt(params[0].toBlock) - BigInt(params[0].fromBlock) + 1n > 32n,
    ),
  )
  assert.ok(
    logCalls.some(
      ([, params]) => BigInt(params[0].toBlock) - BigInt(params[0].fromBlock) + 1n === 32n,
    ),
  )
  assert.ok(logCalls.length <= 136)
})

test('provider unable to serve minimum log span is explicitly unavailable', async () => {
  const { request, requests } = fixture({ maxLogSpan: 1 })
  const captured = await baseline(request)
  await assert.rejects(() => candidate(captured, request), /candidate_logs_unavailable/)
  assert.ok(requests.filter(([method]) => method === 'eth_getLogs').length <= 136)
})

test('candidate discovery retries a throttled chunk on the same request origin', async () => {
  const { request } = fixture()
  const captured = await baseline(request)
  const candidateLog = { ...log(a('1'), 1), blockNumber: '0xbb6' }
  const wideBaseline = {
    ...captured,
    targetBlock: '3000',
    canonicalityEvidenceDoc: {
      ...captured.canonicalityEvidenceDoc,
      targetHeader: { ...captured.canonicalityEvidenceDoc.targetHeader, number: '3000' },
    },
  }
  let logCalls = 0
  const waits = []
  const throttledRequest = async (method, params) => {
    if (method === 'eth_getLogs' && ++logCalls === 6) throw Error('rpc_http_429')
    if (method === 'eth_getLogs') {
      const from = BigInt(params[0].fromBlock)
      const to = BigInt(params[0].toBlock)
      return from <= 2998n && to >= 2998n ? [candidateLog] : []
    }
    if (method === 'eth_getBlockByNumber' && params[0] !== 'finalized') {
      const number = BigInt(params[0])
      if (number === 3000n) return { ...blocks[100], number: '0xbb8' }
      if (number === 2999n) return { ...blocks[99], number: '0xbb7' }
      if (number === 2998n) return { ...blocks[98], number: '0xbb6' }
    }
    if (method === 'eth_getTransactionReceipt') {
      return {
        transactionHash: candidateLog.transactionHash,
        blockHash: candidateLog.blockHash,
        blockNumber: candidateLog.blockNumber,
        status: '0x1',
        logs: [candidateLog],
      }
    }
    return request(method, params)
  }
  const result = await discoverMorphoIssuerCandidate({
    baseline: wideBaseline,
    request: throttledRequest,
    wait: async (ms) => waits.push(ms),
  })
  assert.equal(result.holder, a('1'))
  assert.equal(logCalls, 7)
  assert.deepEqual(waits, [150])
})

test('persistent candidate throttle has a typed, bounded exhaustion reason', async () => {
  const { request } = fixture()
  const captured = await baseline(request)
  let logCalls = 0
  const waits = []
  const throttledRequest = async (method, params) => {
    if (method === 'eth_getLogs') {
      logCalls++
      throw Error('rpc_http_429')
    }
    return request(method, params)
  }
  await assert.rejects(
    () =>
      discoverMorphoIssuerCandidate({
        baseline: captured,
        request: throttledRequest,
        wait: async (ms) => waits.push(ms),
      }),
    /candidate_log_throttle_exhausted/,
  )
  assert.equal(logCalls, 3)
  assert.deepEqual(waits, [150, 300])
})

test('six Q labels retain zero and duplicate reasons without duplicate positive Q', () => {
  const ladder = freezeMorphoQLadder({ totalAssetsRaw: '100' })
  assert.equal(ladder.labels.length, 6)
  assert.equal(ladder.labels[0].reason, 'no_selected_holder')
  assert.equal(ladder.labels[1].reason, 'zero_sized')
  assert.equal(ladder.labels[2].reason, 'zero_sized')
  const positive = ladder.labels.filter((x) => x.assetsRaw).map((x) => x.assetsRaw)
  assert.equal(new Set(positive).size, positive.length)
  const large = freezeMorphoQLadder({ totalAssetsRaw: '10000000000000' })
  assert.equal(new Set(large.labels.map((x) => x.assetsRaw)).size, 6)
  assert.deepEqual(
    dedupeMorphoQEntries([
      { label: 'one', fractionDenominator: '2', assetsRaw: '5' },
      { label: 'two', fractionDenominator: '4', assetsRaw: '5' },
    ])[1],
    {
      label: 'two',
      fractionDenominator: '4',
      assetsRaw: null,
      reason: 'duplicate_q',
      duplicateOf: 'one',
    },
  )
})

test('holder-relative Q is positive and never exceeds the pinned claim', () => {
  const small = freezeMorphoQLadder({
    totalAssetsRaw: '10000000000000',
    selectedClaimRaw: '1000000',
  })
  assert.equal(small.labels.length, 6)
  assert.equal(small.labels[0].assetsRaw, '500000')
  assert.equal(small.labels[0].basis, 'selected_holder_claim_raw_and_frozen_vault_total_assets_raw')
  assert.equal(small.labels[1].assetsRaw, '100000000')
  assert.ok(BigInt(small.labels[0].assetsRaw) <= BigInt(small.selectedClaimRaw))

  const one = freezeMorphoQLadder({ totalAssetsRaw: '10000000000000', selectedClaimRaw: '1' })
  assert.equal(one.labels[0].assetsRaw, '1')
  assert.equal(one.labels[0].reason, null)

  const capped = freezeMorphoQLadder({
    totalAssetsRaw: '10000000000000',
    selectedClaimRaw: '20000000000',
  })
  assert.equal(capped.labels[0].assetsRaw, '100000000')
  assert.equal(capped.labels[1].assetsRaw, null)
  assert.equal(capped.labels[1].reason, 'duplicate_q')
  assert.equal(capped.labels[1].duplicateOf, capped.labels[0].label)
  assert.ok(
    capped.labels.every((entry) => entry.assetsRaw === null || BigInt(entry.assetsRaw) > 0n),
  )
})

test('no-holder window produces explicit unavailable evidence without an address', async () => {
  const { request } = fixture({ logs: [] })
  const result = await candidate(await baseline(request), request)
  assert.equal(result.holder, null)
  assert.equal(result.evidenceDoc.unavailableReason, 'no_pre_baseline_transfer_recipient')
  assert.equal(result.evidenceDoc.candidateWindow.attempted, 0)
  assert.equal(result.evidenceDoc.ladder.labels[0].reason, 'no_selected_holder')
})

test('candidate evidence refuses caller-altered baseline assets', async () => {
  const { request } = fixture({ logs: [] })
  const captured = await baseline(request)
  await assert.rejects(
    () => candidate({ ...captured, totalAssetsRaw: '1' }, request),
    /baseline_state_mismatch/,
  )
})
