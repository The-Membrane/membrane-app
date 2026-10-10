import assert from 'node:assert/strict'
import test from 'node:test'
import {
  issueFirstBreach,
  scoreFirstBreach,
  verifyFirstBreachIssue,
} from './aave-usde-first-breach.mjs'

const config = {
  name: 'aave-v3-usde',
  enabled: true,
  kind: 'atoken-liquidity',
  address: '0x4F5923Fc5FD4a93352581b38B7cD26943012DECF',
  underlying: '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3',
  decimals: 18,
}
const base = Date.parse('2026-09-28T00:00:00Z') / 1000
const iso = (at) => new Date(at * 1000).toISOString()
const sample = (i, cashMillions = 20, overrides = {}) => {
  const at = base + i * 4 * 3600
  const raw = BigInt(cashMillions * 1_000_000) * 10n ** 18n
  return {
    id: `sample-${i}`,
    venue: 'aave-v3-usde',
    chain: 'ethereum',
    source: 'observed',
    recorder_atomic_v1: true,
    block: String(100 + i),
    observed_at: iso(at),
    created_at: iso(at),
    instant_usd: cashMillions * 1_000_000,
    params: {
      kind: 'atoken-liquidity',
      read_block_finalized: true,
      read_block_pinned: true,
      read_block_number: String(100 + i),
      read_block_hash: `0x${(100 + i).toString(16).padStart(64, '0')}`,
      read_block_time: at - 600,
      aToken: config.address,
      underlying: config.underlying,
      underlyingOnchain: config.underlying,
      underlyingIdentity: 'match',
      decimalsIdentity: 'match',
      decimals: 18,
      underlyingDecimalsOnchain: 18,
      reads: { underlyingAsset: true, underlyingDecimals: true, underlyingBalance: true },
      underlyingBalance: raw.toString(),
      priceAssumptionUsd: 1,
    },
    ...overrides,
  }
}
const history = () => Array.from({ length: 7 }, (_, i) => sample(i, 20))
const issue = (options = {}, rows = history()) =>
  issueFirstBreach(rows, {
    config,
    anchorId: 'sample-6',
    issuedAt: iso(base + 24 * 3600),
    amountUsd: 10_000_000,
    horizonSeconds: 24 * 3600,
    ...options,
  })
const score = (receipt, rows, options = {}) =>
  scoreFirstBreach(receipt, rows, {
    scoredAt: iso(base + 56 * 3600 + 120),
    existingScore: null,
    ...options,
  })

test('v2 issue is sealed, fixed-grid, at risk, and independent of future rows', () => {
  const receipt = issue({}, [...history(), sample(7, 1)])
  assert.equal(receipt.scoreClass, 'fixed_grid')
  assert.equal(receipt.anchor.cashUsdAssumingPeg, 20_000_000)
  assert.equal(receipt.issueSourcePath.length, 7)
  assert.equal(receipt.sha256, issue().sha256)
  assert.equal(verifyFirstBreachIssue(receipt), true)
  assert.equal(Object.isFrozen(receipt.anchor), true)
  assert.throws(() => verifyFirstBreachIssue({ ...receipt, amountUsd: 1 }), /invariant|seal/)
  assert.throws(() => issue({ issuedAt: iso(base + 25 * 3600) }), /Late/)
  assert.throws(() => issue({ amountUsd: 50_000_000 }), /at or above/)
  assert.throws(() => issue({ config: { ...config, enabled: false } }), /disabled/)
  assert.throws(
    () => issue({}, [...history().slice(0, -1), sample(6, 20, { source: 'backfilled' })]),
    /Ineligible/,
  )
})

test('only the nine declared cells score; custom 8h–30d cells remain descriptive', () => {
  assert.equal(issue({ amountUsd: 1_000_000, horizonSeconds: 8 * 3600 }).scoreClass, 'fixed_grid')
  assert.equal(issue({ amountUsd: 10_000_000, horizonSeconds: 7 * 86400 }).scoreClass, 'fixed_grid')
  const custom = issue({ amountUsd: 7_000_000, horizonSeconds: 15 * 3600 })
  assert.equal(custom.scoreClass, 'descriptive_only')
  assert.throws(() => score(custom, []), /Descriptive/)
  assert.throws(() => issue({ horizonSeconds: 31 * 86400 }), /Horizon/)
})

test('first sampled breach by H is witnessed even after recovery; exact-H cash is separate', () => {
  const receipt = issue()
  const rows = [
    sample(7, 18),
    sample(8, 9),
    sample(9, 13),
    sample(10, 8),
    sample(11, 15),
    sample(12, 16),
  ]
  const result = score(receipt, rows)
  assert.equal(result.status, 'observed')
  assert.equal(result.breachedByH, true)
  assert.equal(result.firstBreachByH.id, 'sample-8')
  assert.equal(result.firstRecoveryAfterBreach.id, 'sample-9')
  assert.equal(result.targetWitness.id, 'sample-12')
  assert.equal(result.targetWitnessBelowAmount, false)
  assert.equal(result.exactHTargetBelowAmount, false)
  assert.equal(result.firstBreachOnlyAfterH, null)
  assert.equal(result.sourcePath.length, 7)
  assert.match(result.sourcePathSha256, /^[a-f0-9]{64}$/)
  assert.equal(result.issueSha256, receipt.sha256)
  assert.equal(result.sourceCompleteness, 'caller_unverified')
  assert.equal(result.prospectiveEligible, false)
  assert.equal(Object.isFrozen(result.sourcePath), true)
  const exact = score(
    receipt,
    rows.map((row) => (row.id === 'sample-12' ? sample(12, 7) : row)),
  )
  assert.equal(exact.exactHTargetBelowAmount, true)
})

test('a first below-q witness after H is not a breach by H', () => {
  const receipt = issue()
  const late = sample(13, 5)
  const rows = [7, 8, 9, 10, 11].map((i) => sample(i, 20)).concat(late)
  const result = score(receipt, rows)
  assert.equal(result.status, 'observed')
  assert.equal(result.breachedByH, false)
  assert.equal(result.firstBreachByH, null)
  assert.equal(result.firstBreachOnlyAfterH.id, late.id)
  assert.equal(result.exactHTargetBelowAmount, null)
})

test('8h closure, missing target, and gaps censor rather than credit an early breach', () => {
  const receipt = issue()
  assert.equal(score(receipt, [], { scoredAt: iso(base + 55 * 3600) }).status, 'pending')
  assert.equal(score(receipt, [], { scoredAt: iso(base + 56 * 3600) }).status, 'pending')
  assert.equal(score(receipt, [sample(7, 9)]).reason, 'missing_target_witness_within_8h')
  const gapped = score(receipt, [sample(7, 9), sample(12, 15)])
  assert.equal(gapped.status, 'censored')
  assert.equal(gapped.reason, 'source_gap_over_8h')
  assert.equal(gapped.breachedByH, null)
  assert.equal(gapped.firstBreachByH, null)
})

test('fixed create-lag cutoff gives identical labels and paths at all eligible score times', () => {
  const receipt = issue({ issuedAt: iso(base + 24 * 3600 + 60) })
  const target = base + 48 * 3600 + 60
  const witnessAt = target + 8 * 3600 - 60
  const witness = sample(14, 8, {
    observed_at: iso(witnessAt),
    created_at: iso(witnessAt + 120),
    params: { ...sample(14, 8).params, read_block_time: witnessAt - 600 },
  })
  const rows = [7, 8, 9, 10, 11, 12].map((i) => sample(i, 20)).concat(witness)
  const closesAt = target + 8 * 3600 + 120
  assert.equal(score(receipt, rows, { scoredAt: iso(closesAt - 1) }).status, 'pending')
  const atClosure = score(receipt, rows, { scoredAt: iso(closesAt) })
  const muchLater = score(receipt, rows, { scoredAt: iso(closesAt + 7 * 86400) })
  assert.equal(atClosure.status, 'observed')
  assert.equal(atClosure.targetWitness.id, witness.id)
  assert.equal(atClosure.breachedByH, false)
  assert.equal(atClosure.firstBreachOnlyAfterH.id, witness.id)
  assert.equal(atClosure.sourceAsOf, iso(closesAt))
  assert.deepEqual(atClosure.sourcePath, muchLater.sourcePath)
  assert.equal(atClosure.sourcePathSha256, muchLater.sourcePathSha256)
  assert.equal(atClosure.breachedByH, muchLater.breachedByH)
  assert.equal(atClosure.reason, muchLater.reason)
  assert.equal(muchLater.sourceAsOf, atClosure.sourceAsOf)
})

test('exact H+8h observed boundary with 120s create lag is included and stably censored on gap', () => {
  const receipt = issue({ issuedAt: iso(base + 24 * 3600 + 60) })
  const target = base + 48 * 3600 + 60
  const observedAt = target + 8 * 3600
  const witness = sample(14, 8, {
    observed_at: iso(observedAt),
    created_at: iso(observedAt + 120),
    params: { ...sample(14, 8).params, read_block_time: observedAt - 600 },
  })
  const rows = [7, 8, 9, 10, 11, 12].map((i) => sample(i, 20)).concat(witness)
  const closesAt = observedAt + 120
  const atClosure = score(receipt, rows, { scoredAt: iso(closesAt) })
  const later = score(receipt, rows, { scoredAt: iso(closesAt + 3600) })
  assert.equal(atClosure.status, 'censored')
  assert.equal(atClosure.reason, 'source_gap_over_8h')
  assert.equal(atClosure.sourceAsOf, iso(closesAt))
  assert.deepEqual(atClosure.sourcePath, later.sourcePath)
  assert.equal(atClosure.reason, later.reason)
})

test('ineligible row, identity drift, and duplicate block censor the whole path', () => {
  const receipt = issue()
  const baseRows = [
    sample(7, 20),
    sample(8, 9),
    sample(9, 20),
    sample(10, 20),
    sample(11, 20),
    sample(12, 20),
  ]
  for (const changed of [
    { source: 'backfilled' },
    { params: { ...baseRows[1].params, underlyingIdentity: 'mismatch' } },
    { block: '107', params: { ...baseRows[1].params, read_block_number: '107' } },
  ]) {
    const result = score(receipt, [
      baseRows[0],
      { ...baseRows[1], ...changed },
      ...baseRows.slice(2),
    ])
    assert.equal(result.status, 'censored')
    assert.equal(result.breachedByH, null)
  }
})

test('score as-of cutoff excludes later-created/backfilled rows and later observations', () => {
  const receipt = issue()
  const rows = [7, 8, 9, 10, 11, 12].map((i) => sample(i, 20))
  const baseline = score(receipt, rows)
  assert.equal(baseline.breachedByH, false)
  const afterScore = sample(8, 5, { created_at: iso(base + 57 * 3600) })
  const withLateInsert = score(receipt, [
    ...rows.filter((row) => row.id !== 'sample-8'),
    afterScore,
  ])
  assert.equal(withLateInsert.breachedByH, false)
  assert.equal(withLateInsert.sourcePath.length, 6)
  assert.equal(score(receipt, [...rows, sample(13, 5)]).sha256, baseline.sha256)
  assert.throws(
    () => scoreFirstBreach(receipt, rows, { scoredAt: iso(base + 56 * 3600 + 120) }),
    /lookup/,
  )
  assert.throws(() => score(receipt, rows, { existingScore: baseline }), /retroactive rescore/)
})
