import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CARRY_EXIT_V2_FROZEN_ROUTES } from './carry-exit-v2-rpc-proof.mjs'
import {
  captureFreshSyncVaultBaseline,
  dedupeSyncVaultQEntries,
  discoverSyncVaultIssuerCandidate,
  freezeSyncVaultQLadder,
} from './carry-exit-v2-sync-vault-issuer-prep.mjs'

const route = CARRY_EXIT_V2_FROZEN_ROUTES.find((x) => x.kind === 'stusds')
const sgho = CARRY_EXIT_V2_FROZEN_ROUTES.find((x) => x.kind === 'sgho')
const h = (x) => `0x${x.repeat(64)}`
const a = (x) => `0x${x.repeat(40)}`
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`
const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const blocks = {
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
  selectedRoute = route,
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
    if (method === 'eth_getCode')
      return [selectedRoute.destination, selectedRoute.asset].includes(params[0]) ? '0x6000' : '0x'
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
      if (data === '0x18160ddd') return word(10_000_000_000_000n)
      if (data === '0x38d52e0f') return word(BigInt(selectedRoute.asset))
      if (data === '0x313ce567') return word(params[0].to === selectedRoute.asset ? 18 : 18)
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
async function baseline(request, selectedRoute = route) {
  return captureFreshSyncVaultBaseline({
    ...inputs,
    routeKey: selectedRoute.routeKey,
    destination: selectedRoute.destination,
    asset: selectedRoute.asset,
    request,
    now: () => new Date('2023-11-14T22:20:00.000Z'),
  })
}

test('sGHO baseline pins deployed vault and original GHO asset identity', async () => {
  const { request, requests } = fixture({ selectedRoute: sgho, logs: [] })
  const result = await baseline(request, sgho)
  assert.equal(result.destination, '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d')
  assert.equal(result.asset, '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f')
  assert.ok(
    requests.some(
      ([method, params]) =>
        method === 'eth_call' &&
        params[0].to === sgho.destination &&
        params[0].data === '0x38d52e0f',
    ),
  )
})
const candidate = (value, request) => discoverSyncVaultIssuerCandidate({ baseline: value, request })

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
    'largest_pinned_preview_redeem_claim_among_top_transfer_ranked_bounded_receipt_verified_eoas_tie_by_rank',
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

test('six Q labels retain zero and duplicate reasons without duplicate positive Q', () => {
  const ladder = freezeSyncVaultQLadder({ totalAssetsRaw: '100' })
  assert.equal(ladder.labels.length, 6)
  assert.equal(ladder.labels[0].reason, 'no_selected_holder')
  assert.equal(ladder.labels[1].reason, 'zero_sized')
  assert.equal(ladder.labels[2].reason, 'zero_sized')
  const positive = ladder.labels.filter((x) => x.assetsRaw).map((x) => x.assetsRaw)
  assert.equal(new Set(positive).size, positive.length)
  const large = freezeSyncVaultQLadder({ totalAssetsRaw: '10000000000000' })
  assert.equal(new Set(large.labels.map((x) => x.assetsRaw)).size, 6)
  assert.deepEqual(
    dedupeSyncVaultQEntries([
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
  const small = freezeSyncVaultQLadder({
    totalAssetsRaw: '10000000000000',
    selectedClaimRaw: '1000000',
  })
  assert.equal(small.labels.length, 6)
  assert.equal(small.labels[0].assetsRaw, '500000')
  assert.equal(small.labels[0].basis, 'selected_holder_claim_raw_and_frozen_vault_total_assets_raw')
  assert.equal(small.labels[1].assetsRaw, '100000000')
  assert.ok(BigInt(small.labels[0].assetsRaw) <= BigInt(small.selectedClaimRaw))

  const one = freezeSyncVaultQLadder({ totalAssetsRaw: '10000000000000', selectedClaimRaw: '1' })
  assert.equal(one.labels[0].assetsRaw, '1')
  assert.equal(one.labels[0].reason, null)

  const capped = freezeSyncVaultQLadder({
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

test('synchronous baseline seals supply and distinct share/asset decimals', async () => {
  const { request } = fixture()
  const result = await baseline(request)
  assert.equal(result.totalSupplyRaw, '10000000000000')
  assert.equal(result.totalAssetsRaw, '10000000000000')
  assert.equal(result.assetDecimals, 18)
  assert.equal(result.shareDecimals, 18)
  const selected = await candidate(result, request)
  assert.equal(selected.evidenceDoc.schema, 'carry_exit_v2_sync_vault_candidate_v1')
  assert.equal(selected.evidenceDoc.baselineState.totalSupplyRaw, result.totalSupplyRaw)
  assert.equal(selected.evidenceDoc.selectedClaimRaw, '20000000000')
})

test('asset identity mismatch fails before any holder discovery', async () => {
  const { request } = fixture()
  const wrong = async (method, params) =>
    method === 'eth_call' && params[0].data === '0x38d52e0f' ? word(1) : request(method, params)
  await assert.rejects(() => baseline(wrong), /baseline_asset_mismatch/)
})
