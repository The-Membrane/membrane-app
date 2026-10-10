import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { indexFromSources, readIndex } from './exit-route-evidence-index.mjs'

const asOfUtc = '2026-09-28T04:00:00.000Z'
const hash = (digit) => `0x${digit.repeat(64)}`
const ref = (digit) => ({ filename: `${digit}.json`, physicalSha256: digit.repeat(64) })
const scrvRow = ({
  vault = '0xvault-a',
  q = '100',
  assayRoute = 'direct_erc4626_withdraw',
  holder = '0xholder',
  block = 100,
  status = 'right_censored',
} = {}) => ({
  venue: { chainId: 1, vault, asset: '0xasset', route: assayRoute },
  route: assayRoute,
  rawAssetAmount: q,
  holder,
  anchor: { block: { number: block, hash: hash(String(block % 10)) } },
  future: {
    observation: { status },
    horizons: [{ seconds: 86400, class: 'right_censored_before_horizon' }],
  },
  sourceRefs: { durationIssue: ref('a'), flowContextIssue: ref('b'), latestScore: ref('c') },
})
const scrvusd = (rows) => ({
  schema: 'scrvusd-exit-evidence-panel-v1',
  asOfUtc,
  horizonsSeconds: [86400],
  dependence: {
    dependentPairCount: rows.length,
    anchorCount: new Set(rows.map((row) => row.anchor.block.hash)).size,
    distinctHolderCount: new Set(rows.map((row) => row.holder)).size,
    overlappingAnchorWindowClusterCount: 1,
    independentEpisodeCount: null,
  },
  rows,
})
const morphoRow = ({
  vault = '0xvault-a',
  q = '100',
  holder = '0xmorpho-holder',
  anchorBlock = 100,
  classification = 'pending-baseline',
} = {}) => ({
  vault,
  asset: '0xasset',
  qAssets: q,
  holder,
  anchorBlock,
  classification,
})
const morpho = (rows) => ({
  filename: 'snapshot-v3.json',
  physicalSha256: 'd'.repeat(64),
  receipt: {
    study: 'morpho-exit-panel-snapshot-v3',
    issuedAtUtc: '2026-09-28T03:00:00.000Z',
    evidenceScope: { chainId: 1, route: 'simulated-same-holder-fixed-q-erc4626-withdraw' },
    summary: {
      rows,
      counts: {
        baselineEligible: rows.filter((row) => row.classification !== 'baseline-ineligible').length,
      },
      dependence: {
        uniqueVaults: new Set(rows.map((row) => row.vault)).size,
        uniqueHolders: new Set(rows.map((row) => row.holder)).size,
      },
    },
  },
})

test('same timestamp across vaults and assays stays separate; no pooled independent count', () => {
  const result = indexFromSources({
    asOfUtc,
    scrvusd: scrvusd([scrvRow(), scrvRow({ vault: '0xvault-b' })]),
    morpho: morpho([morphoRow()]),
  })
  assert.equal(result.strata.length, 3)
  assert.equal(result.sources.scrvusd.dependentRowCount, 2)
  assert.equal(result.sources.morpho.dependentRowCount, 1)
  assert.equal(result.sources.scrvusd.dependence.independentEpisodeCount, null)
  assert.ok(result.strata.every((row) => row.independentEpisodeCount === null))
  assert.ok(result.strata.every((row) => row.implementationIdentity === 'unverified'))
  assert.equal(result.forecast.status, 'unavailable')
  assert.equal(result.sources.morpho.baselineClock, 'pre-block-B-minus-1')
  assert.match(result.sources.morpho.scheduledClock, /executableAt/)
})

test('same vault with different raw q and assay creates distinct route strata', () => {
  const result = indexFromSources({
    asOfUtc,
    scrvusd: scrvusd([scrvRow(), scrvRow({ q: '200' })]),
    morpho: morpho([morphoRow(), morphoRow({ q: '200' })]),
  })
  assert.equal(result.strata.length, 4)
  assert.deepEqual(
    result.strata.map((row) => row.dependentRowCount),
    [1, 1, 1, 1],
  )
  assert.deepEqual(new Set(result.strata.map((row) => row.rawAssetAmount)), new Set(['100', '200']))
})

test('duplicate route, holder, amount and anchor rejects instead of inflating evidence', () => {
  assert.throws(
    () =>
      indexFromSources({
        asOfUtc,
        scrvusd: scrvusd([scrvRow(), scrvRow()]),
        morpho: null,
      }),
    /Duplicate route/,
  )
  assert.throws(
    () =>
      indexFromSources({
        asOfUtc,
        scrvusd: scrvusd([]),
        morpho: morpho([morphoRow(), morphoRow()]),
      }),
    /Duplicate route/,
  )
})

test('dependent rows can share holder and anchor without being called independent episodes', () => {
  const result = indexFromSources({
    asOfUtc,
    scrvusd: scrvusd([
      scrvRow(),
      scrvRow({ holder: '0xother' }),
      scrvRow({ block: 101, status: 'pending_followup' }),
    ]),
    morpho: null,
  })
  assert.equal(result.strata[0].dependentRowCount, 3)
  assert.equal(result.strata[0].distinctHolderCount, 2)
  assert.equal(result.strata[0].distinctAnchorCount, 2)
  assert.equal(result.strata[0].independentEpisodeCount, null)
  assert.equal(result.sources.scrvusd.classifications.pending_followup, 1)
  assert.equal(result.sources.scrvusd.classifications.right_censored, 2)
  assert.equal(result.strata[0].horizonClasses['86400'].right_censored_before_horizon, 3)
  assert.equal(result.strata[0].sourceRefs.length, 3)
})

test('future Morpho receipt is rejected; absent v3 stays absent', () => {
  const source = morpho([morphoRow()])
  assert.throws(
    () =>
      indexFromSources({
        asOfUtc: '2026-09-28T02:00:00.000Z',
        scrvusd: { ...scrvusd([]), asOfUtc: '2026-09-28T02:00:00.000Z' },
        morpho: source,
      }),
    /future evidence/,
  )
  const absent = indexFromSources({ asOfUtc, scrvusd: scrvusd([]), morpho: null })
  assert.deepEqual(absent.sources.morpho, {
    status: 'absent',
    reason: 'no_v3_receipt_at_as_of_cutoff',
  })
})

test('baseline-ineligible Morpho rows without selected holder or q remain explicit', () => {
  const unavailable = {
    ...morphoRow({ classification: 'baseline-ineligible' }),
    holder: null,
    qAssets: null,
    proposalIndex: 42,
  }
  const result = indexFromSources({
    asOfUtc,
    scrvusd: scrvusd([]),
    morpho: morpho([unavailable]),
  })
  assert.equal(result.sources.morpho.dependentRowCount, 1)
  assert.equal(result.sources.morpho.baselineEligible, 0)
  assert.equal(result.strata[0].rawAssetAmount, null)
  assert.equal(result.strata[0].holderPolicy, 'holder_unavailable_baseline_ineligible')
  assert.equal(result.strata[0].distinctHolderCount, 0)
})

test(
  'real sealed replay preserves separate source denominators and as-of v3 absence',
  {
    skip:
      process.env.MEMBRANE_TEST_NO_LOCAL_CORPUS === '1' ||
      !existsSync(resolve('data/research/venue-signals/morpho-exit-panel-snapshots')),
  },
  () => {
    const before = readIndex({ asOfUtc: '2026-09-28T02:00:00.000Z', horizons: [86400] })
    assert.equal(before.sources.scrvusd.dependentRowCount, 48)
    assert.equal(before.sources.morpho.status, 'absent')
    const after = readIndex({ asOfUtc, horizons: [86400, 604800] })
    assert.equal(after.sources.scrvusd.dependentRowCount, 48)
    assert.equal(after.sources.scrvusd.dependence.distinctHolderCount, 5)
    assert.equal(after.sources.scrvusd.dependence.overlappingAnchorWindowClusterCount, 1)
    assert.equal(after.sources.morpho.dependentRowCount, 64)
    assert.equal(after.sources.morpho.baselineEligible, 58)
    assert.equal(after.sources.morpho.dependence.uniqueVaults, 44)
    assert.equal(after.sources.morpho.dependence.uniqueHolders, 48)
    assert.equal(after.sources.morpho.classifications['pending-baseline'], 57)
    assert.equal(after.sources.morpho.prospectiveLead, 'unavailable')
  },
)
