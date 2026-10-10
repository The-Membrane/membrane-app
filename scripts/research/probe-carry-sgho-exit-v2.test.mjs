import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { probeCarrySghoExitV2 } from './probe-carry-sgho-exit-v2.mjs'

const holder = `0x${'a'.repeat(40)}`
const vault = '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d'
const gho = '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f'
const routeKey = 'GHO → sGho [GHO]'
const q = ['123456789012345678901', '223456789012345678901', '323456789012345678901']
const primary = {
  url: 'https://one.example/private-path',
  provider: 'https://one.example',
  send: async () => {
    throw Error('mock measure must not send')
  },
}
const secondary = {
  url: 'https://two.example/private-path',
  provider: 'https://two.example',
  send: async () => {
    throw Error('mock measure must not send')
  },
}
const baseline = {
  routeKey,
  destination: vault,
  asset: gho,
  targetBlock: '5000',
  targetHash: `0x${'b'.repeat(64)}`,
}

function candidate() {
  const evidenceDoc = {
    ladder: {
      labels: [
        ...q.map((assetsRaw, index) => ({ label: `q${index}`, assetsRaw, reason: null })),
        ...[0, 1, 2].map((index) => ({
          label: `omitted${index}`,
          assetsRaw: null,
          reason: 'zero_sized',
        })),
      ],
    },
  }
  return {
    holder,
    evidenceDoc,
    digest: createHash('sha256').update(JSON.stringify(evidenceDoc)).digest('hex'),
  }
}

const clock = () => new Date('2026-09-30T01:12:00.000Z')

test('public-chain holder and six Qs stay in memory; output contains aggregate counts only', async () => {
  const seen = []
  const result = await probeCarrySghoExitV2({
    urls: [primary.url],
    verifyUrl: secondary.url,
    now: clock,
    transport: (url) => {
      assert.equal(url, secondary.url)
      return secondary
    },
    prepare: async (input) => {
      assert.equal(input.route.routeKey, routeKey)
      assert.equal(input.route.asset, gho)
      assert.equal(Object.hasOwn(input, 'sql'), false)
      return { primary, baseline, candidate: candidate() }
    },
    measure: async (input) => {
      seen.push(input.assetsRaw)
      assert.equal(input.holder, holder)
      assert.equal(input.asset, gho)
      assert.equal(input.target, baseline)
      return { status: 'verified', callEvidenceDoc: { schema: 'fixture' } }
    },
    decode: ({ assetsRaw }) => {
      const index = q.indexOf(assetsRaw)
      return {
        routeKind: 'sgho',
        holderCoverageRaw: index === 2 ? '5' : '120',
        requiredCoverageRaw: '80',
        actualConsumedRaw: index === 0 ? '70' : null,
        simulationStatus: index === 0 ? 'success' : 'evm_revert',
        coveredRevert: index === 1,
      }
    },
  })
  assert.deepEqual(seen, q)
  assert.deepEqual(result.counts, {
    success: 1,
    ineligible: 0,
    covered_revert: 1,
    inconclusive: 1,
    unavailable: 0,
  })
  assert.equal(result.candidateCount, 1)
  assert.equal(result.plannedCases, 6)
  assert.equal(result.positiveCases, 3)
  assert.equal(result.omittedCases, 3)
  assert.equal(result.verifiedCases, 3)
  const output = JSON.stringify(result)
  for (const secret of [holder, ...q, primary.url, secondary.url])
    assert.equal(output.includes(secret), false)
})

test('no public candidate returns an empty safe summary before measurement', async () => {
  const result = await probeCarrySghoExitV2({
    urls: [primary.url],
    verifyUrl: secondary.url,
    now: clock,
    prepare: async () => ({ primary, baseline, candidate: null }),
    transport: () => {
      throw Error('no secondary needed')
    },
    measure: async () => {
      throw Error('no Q to measure')
    },
  })
  assert.equal(result.candidateCount, 0)
  assert.equal(result.positiveCases, 0)
  assert.equal(result.verifiedCases, 0)
})

test('same-host replay origin and altered baseline identity fail closed', async () => {
  const common = {
    urls: [primary.url],
    verifyUrl: 'https://one.example/another-path',
    now: clock,
    prepare: async () => ({ primary, baseline, candidate: candidate() }),
    transport: (url) => ({ ...secondary, url }),
  }
  await assert.rejects(() => probeCarrySghoExitV2(common), /probe_independent_origin_missing/)
  await assert.rejects(
    () =>
      probeCarrySghoExitV2({
        ...common,
        verifyUrl: secondary.url,
        prepare: async () => ({
          primary,
          baseline: { ...baseline, asset: primary.url },
          candidate: candidate(),
        }),
      }),
    /probe_baseline_identity_invalid/,
  )
})

test('unverified public Q remains unavailable without exposing proof or amounts', async () => {
  const result = await probeCarrySghoExitV2({
    urls: [primary.url],
    verifyUrl: secondary.url,
    now: clock,
    prepare: async () => ({ primary, baseline, candidate: candidate() }),
    transport: () => secondary,
    measure: async () => ({ status: 'unavailable', reason: 'rpc_failed', secret: holder }),
  })
  assert.equal(result.counts.unavailable, 3)
  assert.equal(result.verifiedCases, 0)
  assert.equal(JSON.stringify(result).includes(holder), false)
})
