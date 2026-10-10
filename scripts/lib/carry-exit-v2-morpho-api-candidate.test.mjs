import assert from 'node:assert/strict'
import test from 'node:test'

import {
  discoverMorphoApiIssuerCandidate,
  fetchMorphoV2CandidatePage,
  fetchMorphoV2CandidatePageV2,
  validateMorphoApiCandidateEvidence,
  discoverMorphoApiIssuerCandidateV2,
  validateMorphoApiCandidateEvidenceV2,
} from './carry-exit-v2-morpho-api-candidate.mjs'
import { BOARD_ROUTES } from '../research/carry-local-morpho-holder-v2.mjs'

const route = BOARD_ROUTES[13]
const holder = `0x${'1'.repeat(40)}`
const hash = `0x${'a'.repeat(64)}`
const parent = `0x${'b'.repeat(64)}`
const w = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`
const baseline = {
  ...route,
  targetBlock: '1000',
  targetHash: hash,
  targetParentHash: parent,
  totalAssetsRaw: '1000000',
  assetDecimals: 18,
  canonicalityEvidenceDoc: {
    schema: 'carry_exit_v2_headers_v1',
    targetHeader: { hash, number: '1000', parentHash: parent },
  },
}
const page = (apiSharesRaw = '999999') => ({
  fetchedAtUtc: '2026-10-02T02:00:00.000Z',
  querySha256: 'c'.repeat(64),
  totalSupplyRaw: '1000000',
  pageInfo: { count: 1, countTotal: 109, skip: 0, limit: 10 },
  items: [{ address: holder, apiSharesRaw }],
})
function rpc({ shares = 100n, claim = 90n, code = '0x' } = {}) {
  return async (method, params) => {
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_getBlockByNumber') return { hash, parentHash: parent }
    if (method === 'eth_getCode') return params[0] === holder ? code : '0x1234'
    if (method === 'eth_call') {
      assert.deepEqual(params[1], { blockHash: hash, requireCanonical: true })
      const selector = params[0].data.slice(0, 10)
      if (selector === '0x38d52e0f') return `0x${route.asset.slice(2).padStart(64, '0')}`
      if (selector === '0x01e1d114') return w(1000000)
      if (selector === '0x70a08231') return w(shares)
      if (selector === '0x4cdad506') return w(claim)
    }
    throw Error('unexpected_rpc')
  }
}
const peers = (first = {}, second = {}) => ({
  primary: { provider: 'https://one.example/rpc', request: rpc(first) },
  secondary: { provider: 'https://two.example/rpc', request: rpc(second) },
})

test('forged API shares do not determine the pinned claim or Q ladder', async () => {
  const candidate = await discoverMorphoApiIssuerCandidate({
    baseline,
    ...peers(),
    fetchPage: async () => page('999999999999999999999999'),
  })
  assert.equal(candidate.holder, holder)
  assert.equal(candidate.evidenceDoc.selectedSharesRaw, '100')
  assert.equal(candidate.evidenceDoc.selectedClaimRaw, '90')
  assert.equal(candidate.evidenceDoc.ladder.selectedClaimRaw, '90')
  assert.equal(candidate.evidenceDoc.screenedCandidates[0].status, 'eligible_holder')
  assert.match(candidate.evidenceDoc.screenedCandidates[0].pinnedProofSha256, /^[0-9a-f]{64}$/)
  assert.equal(JSON.stringify(candidate.evidenceDoc).includes(holder), false)
  assert.equal(candidate.evidenceDoc.discovery.exhaustiveHolderSearch, false)
  assert.equal(candidate.evidenceDoc.discovery.historicalHolderProof, false)
})

test('RPC host disagreement prevents selection', async () => {
  const candidate = await discoverMorphoApiIssuerCandidate({
    baseline,
    ...peers({ shares: 100n }, { shares: 101n }),
    fetchPage: async () => page(),
  })
  assert.equal(candidate.holder, null)
  assert.equal(candidate.evidenceDoc.screenedCandidates[0].status, 'rpc_disagreement')
})

test('zero pinned shares prevents selection despite positive API shares', async () => {
  const candidate = await discoverMorphoApiIssuerCandidate({
    baseline,
    ...peers({ shares: 0n }, { shares: 0n }),
    fetchPage: async () => page(),
  })
  assert.equal(candidate.holder, null)
  assert.equal(candidate.evidenceDoc.screenedCandidates[0].status, 'no_pinned_shares')
})

test('a contract address or same RPC host cannot become a holder proof', async () => {
  const contract = await discoverMorphoApiIssuerCandidate({
    baseline,
    ...peers({ code: '0x1234' }, { code: '0x1234' }),
    fetchPage: async () => page(),
  })
  assert.equal(contract.holder, null)
  await assert.rejects(
    () =>
      discoverMorphoApiIssuerCandidate({
        baseline,
        primary: peers().primary,
        secondary: { provider: 'https://one.example/other', request: rpc() },
        fetchPage: async () => page(),
      }),
    /morpho_api_input_invalid/,
  )
})

test('malformed API page and GraphQL errors fail without selecting a holder', async () => {
  for (const bad of [
    { ...page(), pageInfo: { count: 1, countTotal: 0, skip: 0, limit: 10 } },
    { ...page(), items: [{ address: 'not-an-address', apiSharesRaw: '4' }] },
  ])
    await assert.rejects(
      () => discoverMorphoApiIssuerCandidate({ baseline, ...peers(), fetchPage: async () => bad }),
      /morpho_api_response_invalid/,
    )
  const fetcher = async () =>
    new Response(JSON.stringify({ errors: [{ message: 'unavailable' }], data: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  await assert.rejects(
    () => fetchMorphoV2CandidatePage(route.destination, { fetcher }),
    /morpho_api_response_invalid/,
  )
})

test('API request is fixed to first page of 10 and caps response body', async () => {
  let inspected = false
  const fetcher = async (url, options) => {
    assert.equal(url, 'https://api.morpho.org/graphql')
    const request = JSON.parse(options.body)
    assert.equal(request.variables.address, route.destination)
    assert.match(request.query, /positions\(first: 10, skip: 0\)/)
    inspected = true
    return new Response('x'.repeat(32_769), { status: 200 })
  }
  await assert.rejects(
    () => fetchMorphoV2CandidatePage(route.destination, { fetcher }),
    /morpho_api_response_too_large/,
  )
  assert.equal(inspected, true)
})

test('valid fetched page seals a self-consistent two-host candidate evidence document', async () => {
  const fetcher = async () =>
    new Response(
      JSON.stringify({
        data: {
          vaultV2ByAddress: {
            address: route.destination,
            totalSupply: '1000000',
            positions: {
              items: [{ user: { address: holder }, shares: '999999' }],
              pageInfo: { count: 1, countTotal: 109, skip: 0, limit: 10 },
            },
          },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  const candidate = await discoverMorphoApiIssuerCandidate({
    baseline,
    ...peers(),
    fetchPage: (address, options) => fetchMorphoV2CandidatePage(address, { ...options, fetcher }),
  })
  assert.equal(validateMorphoApiCandidateEvidence(candidate.evidenceDoc), candidate.evidenceDoc)
  const forged = structuredClone(candidate.evidenceDoc)
  forged.selectedClaimRaw = '999999'
  assert.throws(
    () => validateMorphoApiCandidateEvidence(forged),
    /morpho_api_candidate_evidence_invalid/,
  )
  for (const mutate of [
    (doc) => {
      doc.discovery.attempted = 0
    },
    (doc) => {
      doc.discovery.candidateCommitments.push('f'.repeat(64))
    },
    (doc) => {
      doc.screenedCandidates[0].status = 'invented_status'
    },
    (doc) => {
      doc.screenedCandidates[0].pinnedProof.first.claimRaw = '999999'
    },
    (doc) => {
      doc.ladder.labels[0].assetsRaw = '999999'
    },
    (doc) => {
      doc.baselineState.totalAssetsRaw = '2000000'
    },
  ]) {
    const tampered = structuredClone(candidate.evidenceDoc)
    mutate(tampered)
    assert.throws(
      () => validateMorphoApiCandidateEvidence(tampered),
      /morpho_api_candidate_evidence_invalid/,
    )
  }
})

const pageV2 = (skip = 0, count = 8, total = 17) => ({
  fetchedAtUtc: '2026-10-02T02:00:00.000Z',
  // Real fetch below supplies the query digest; this fixture receives it from one fetch.
  totalSupplyRaw: '1000000',
  pageInfo: { count, countTotal: total, skip, limit: 8 },
  items: Array.from({ length: count }, (_, index) => ({
    address: `0x${(index + skip + 1).toString(16).padStart(40, '0')}`,
    apiSharesRaw: '999',
  })),
})
const responseV2 = (page) =>
  new Response(
    JSON.stringify({
      data: {
        vaultV2ByAddress: {
          address: route.destination,
          totalSupply: page.totalSupplyRaw,
          positions: {
            items: page.items.map((item) => ({
              user: { address: item.address },
              shares: item.apiSharesRaw,
            })),
            pageInfo: page.pageInfo,
          },
        },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
const v2Fetch =
  (fixture, inspect = () => {}) =>
  async (url, options) => {
    assert.equal(url, 'https://api.morpho.org/graphql')
    const request = JSON.parse(options.body)
    inspect(request)
    return responseV2(fixture)
  }
const v2Rpc = ({ failHolder = null, holderCode = '0x', shares = 100n, claim = 90n } = {}) => {
  const screened = []
  const request = async (method, params) => {
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_getBlockByNumber') return { hash, parentHash: parent }
    if (method === 'eth_getCode') {
      if (params[0] !== route.destination) {
        screened.push(params[0])
        if (params[0] === failHolder) throw Error('transport_timeout')
        return holderCode
      }
      return '0x1234'
    }
    if (method === 'eth_call') {
      assert.deepEqual(params[1], { blockHash: hash, requireCanonical: true })
      const selector = params[0].data.slice(0, 10)
      if (selector === '0x38d52e0f') return `0x${route.asset.slice(2).padStart(64, '0')}`
      if (selector === '0x01e1d114') return w(1000000)
      if (selector === '0x70a08231') return w(shares)
      if (selector === '0x4cdad506') return w(claim)
    }
    throw Error('unexpected_rpc')
  }
  return { request, screened }
}
const v2Peers = (first = {}, second = {}) => {
  const one = v2Rpc(first)
  const two = v2Rpc(second)
  return {
    primary: { provider: 'https://one.example/rpc', request: one.request },
    secondary: { provider: 'https://two.example/rpc', request: two.request },
    screened: [one.screened, two.screened],
  }
}

test('V2 fetch commits skip zero or nonzero with fixed eight-item query', async () => {
  for (const skip of [0, 8]) {
    const fixture = pageV2(skip)
    const fetched = await fetchMorphoV2CandidatePageV2(route.destination, {
      skip,
      fetcher: v2Fetch(fixture, (request) => {
        assert.equal(request.variables.skip, skip)
        assert.match(request.query, /positions\(first: 8, skip: \$skip\)/)
      }),
    })
    assert.equal(fetched.pageInfo.skip, skip)
    assert.equal(fetched.items.length, 8)
    assert.match(fetched.querySha256, /^[0-9a-f]{64}$/)
  }
  await assert.rejects(
    () => fetchMorphoV2CandidatePageV2(route.destination, { skip: 9, fetcher: v2Fetch(pageV2()) }),
    /morpho_api_input_invalid/,
  )
  await assert.rejects(
    () => fetchMorphoV2CandidatePageV2(route.destination, { fetcher: v2Fetch(pageV2(8)) }),
    /morpho_api_response_invalid/,
  )
  await assert.rejects(
    () =>
      fetchMorphoV2CandidatePageV2(route.destination, {
        fetcher: async () => new Response('x'.repeat(32769)),
      }),
    /morpho_api_response_too_large/,
  )
})

test('V2 discovery screens all eight returned positions and seals the offset', async () => {
  const fixture = pageV2(8)
  const peers = v2Peers()
  const result = await discoverMorphoApiIssuerCandidateV2({
    baseline,
    primary: peers.primary,
    secondary: peers.secondary,
    pageSkip: 8,
    fetchPage: (address, options) =>
      fetchMorphoV2CandidatePageV2(address, { ...options, fetcher: v2Fetch(fixture) }),
  })
  assert.equal(result.holder, fixture.items[0].address)
  assert.equal(result.evidenceDoc.discovery.pageSkip, 8)
  assert.equal(result.evidenceDoc.screenedCandidates.length, 8)
  assert.deepEqual(peers.screened, [
    fixture.items.map((x) => x.address),
    fixture.items.map((x) => x.address),
  ])
  assert.equal(validateMorphoApiCandidateEvidenceV2(result.evidenceDoc), result.evidenceDoc)
  assert.equal(JSON.stringify(result.evidenceDoc).includes(result.holder), false)
  assert.equal(result.evidenceDoc.discovery.historicalHolderProof, false)
  assert.equal(result.evidenceDoc.discovery.exhaustiveHolderSearch, false)
  const mutations = [
    (doc) => {
      doc.discovery.pageSkip = 0
    },
    (doc) => {
      doc.discovery.pageSkip = 16
      doc.discovery.pageInfo.skip = 16
      doc.discovery.pageInfo.countTotal = 24
    },
    (doc) => {
      doc.discovery.querySha256 = 'a'.repeat(64)
    },
    (doc) => {
      doc.discovery.candidateCommitments[0] = 'f'.repeat(64)
    },
    (doc) => {
      doc.screenedCandidates.pop()
    },
    (doc) => {
      doc.screenedCandidates[0].pinnedProof.parentHash = hash
    },
    (doc) => {
      doc.screenedCandidates[0].pinnedProof.first.claimRaw = '999'
    },
    (doc) => {
      doc.selectedClaimRaw = '999'
    },
  ]
  for (const mutate of mutations) {
    const tampered = structuredClone(result.evidenceDoc)
    mutate(tampered)
    assert.throws(
      () => validateMorphoApiCandidateEvidenceV2(tampered),
      /morpho_api_candidate_evidence_invalid/,
    )
  }
})

test('V2 tail and transient RPC failure stay bounded and cannot assert no holder', async () => {
  const fixture = pageV2(16, 1, 17)
  const rpcPeers = v2Peers({ failHolder: fixture.items[0].address })
  const result = await discoverMorphoApiIssuerCandidateV2({
    baseline,
    primary: rpcPeers.primary,
    secondary: rpcPeers.secondary,
    pageSkip: 16,
    fetchPage: (address, options) =>
      fetchMorphoV2CandidatePageV2(address, { ...options, fetcher: v2Fetch(fixture) }),
  })
  assert.equal(result.holder, null)
  assert.equal(result.evidenceDoc.discovery.pageInfo.count, 1)
  assert.equal(result.evidenceDoc.screenedCandidates[0].status, 'rpc_unavailable')
  assert.equal(result.evidenceDoc.discovery.historicalHolderProof, false)
  validateMorphoApiCandidateEvidenceV2(result.evidenceDoc)
  const bad = structuredClone(result.evidenceDoc)
  bad.screenedCandidates[0].pinnedProof = { first: { status: 'eligible_holder' } }
  assert.throws(
    () => validateMorphoApiCandidateEvidenceV2(bad),
    /morpho_api_candidate_evidence_invalid/,
  )
  // The earlier V1 receipt test remains an independent legacy validation check.
})

test('V2 accepts an empty out-of-range page when live holder count shrank', async () => {
  const fixture = pageV2(8, 0, 5)
  const peers = v2Peers()
  const result = await discoverMorphoApiIssuerCandidateV2({
    baseline,
    primary: peers.primary,
    secondary: peers.secondary,
    pageSkip: 8,
    fetchPage: (address, options) =>
      fetchMorphoV2CandidatePageV2(address, { ...options, fetcher: v2Fetch(fixture) }),
  })
  assert.equal(result.holder, null)
  assert.deepEqual(result.evidenceDoc.screenedCandidates, [])
  assert.equal(result.evidenceDoc.discovery.pageInfo.countTotal, 5)
  assert.equal(result.evidenceDoc.discovery.pageInfo.skip, 8)
  assert.deepEqual(peers.screened, [[], []])
  validateMorphoApiCandidateEvidenceV2(result.evidenceDoc)
  // A nonempty page still cannot claim fewer total holders than its offset.
  const inconsistent = pageV2(8, 1, 5)
  await assert.rejects(
    () =>
      fetchMorphoV2CandidatePageV2(route.destination, { skip: 8, fetcher: v2Fetch(inconsistent) }),
    /morpho_api_response_invalid/,
  )
})

test('malformed holder code from either pinned peer cannot become contract-holder evidence', async () => {
  const fixture = pageV2(16, 1, 17)
  for (const malformed of [null, '0x0', '0xGG']) {
    for (const peer of ['first', 'second']) {
      const peers = v2Peers(
        peer === 'first' ? { holderCode: malformed } : {},
        peer === 'second' ? { holderCode: malformed } : {},
      )
      const result = await discoverMorphoApiIssuerCandidateV2({
        baseline,
        primary: peers.primary,
        secondary: peers.secondary,
        pageSkip: 16,
        fetchPage: (address, options) =>
          fetchMorphoV2CandidatePageV2(address, { ...options, fetcher: v2Fetch(fixture) }),
      })
      assert.equal(result.holder, null)
      assert.equal(result.evidenceDoc.screenedCandidates[0].status, 'rpc_unavailable')
      assert.equal(result.evidenceDoc.screenedCandidates[0].pinnedProof, undefined)
      validateMorphoApiCandidateEvidenceV2(result.evidenceDoc)
    }
  }
  const uppercase = v2Peers({ holderCode: '0X' }, { holderCode: '0x' })
  const valid = await discoverMorphoApiIssuerCandidateV2({
    baseline,
    primary: uppercase.primary,
    secondary: uppercase.secondary,
    pageSkip: 16,
    fetchPage: (address, options) =>
      fetchMorphoV2CandidatePageV2(address, { ...options, fetcher: v2Fetch(fixture) }),
  })
  assert.equal(valid.evidenceDoc.screenedCandidates[0].status, 'eligible_holder')
})
