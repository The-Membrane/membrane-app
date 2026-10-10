import assert from 'node:assert/strict'
import test from 'node:test'
import {
  issueCashScenario,
  normalizeSample,
  scoreCashScenario,
  verifyIssue,
} from './aave-usde-prospective-cash.mjs'

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
const history = () => [
  sample(0, 24),
  sample(1, 23),
  sample(2, 22),
  sample(3, 21),
  sample(4, 20),
  sample(5, 19),
  sample(6, 18),
]
const issue = (rows = history(), options = {}) =>
  issueCashScenario(rows, {
    config,
    anchorId: 'sample-6',
    issuedAt: iso(base + 24 * 3600),
    amountUsd: 10_000_000,
    horizonSeconds: 24 * 3600,
    ...options,
  })

test('pre-anchor pair and both deterministic scenarios are sealed before future observations', () => {
  const rows = history()
  const receipt = issue([...rows, sample(7, 1)])
  assert.equal(receipt.scoreClass, 'fixed_grid')
  assert.equal(receipt.riskSet, 'at_risk')
  assert.equal(receipt.preAnchor.sample.id, 'sample-0')
  assert.equal(receipt.sourcePath.length, 7)
  assert.equal(receipt.preAnchor.elapsedSeconds, 24 * 3600)
  assert.equal(receipt.scenario.persistenceCashUsdAssumingPeg, 18_000_000)
  assert.equal(receipt.scenario.linearCashUsdAssumingPeg, 12_000_000)
  assert.equal(receipt.scenario.linearBelowAmount, false)
  assert.equal(verifyIssue(receipt), true)
  assert.equal(Object.isFrozen(receipt.anchor), true)
  assert.equal(issue(rows).sha256, receipt.sha256)
  assert.throws(() => verifyIssue({ ...receipt, claim: 'other' }), /seal mismatch/)
  assert.throws(
    () => verifyIssue({ ...receipt, targetAt: iso(base + 47 * 3600) }),
    /target or source-path invariant/,
  )
  const withoutInterior = issue(rows.filter((row) => row.id !== 'sample-2'))
  assert.equal(withoutInterior.preAnchor.sample.id, receipt.preAnchor.sample.id)
  assert.equal(
    withoutInterior.scenario.linearCashUsdAssumingPeg,
    receipt.scenario.linearCashUsdAssumingPeg,
  )
  assert.notEqual(withoutInterior.sha256, receipt.sha256)
})

test('horizon starts at issue time and records nonzero anchor age', () => {
  const receipt = issue(history(), { issuedAt: iso(base + 24 * 3600 + 60) })
  assert.equal(receipt.anchorAgeAtIssueSeconds, 60)
  assert.equal(receipt.targetAt, iso(base + 48 * 3600 + 60))
  const score = scoreCashScenario(
    receipt,
    [7, 8, 9, 10, 11, 12, 13].map((i) => sample(i, 5)),
    {
      scoredAt: iso(base + 53 * 3600),
      existingScore: null,
    },
  )
  assert.equal(score.outcomeSample.id, 'sample-13')
})

test('arbitrary caller amount and horizon remain descriptive and cannot be scored', () => {
  const receipt = issue(history(), { amountUsd: 7_000_000, horizonSeconds: 15 * 3600 })
  assert.equal(receipt.scoreClass, 'descriptive_only')
  assert.throws(
    () => scoreCashScenario(receipt, [], { scoredAt: receipt.targetAt, existingScore: null }),
    /Descriptive scenario/,
  )
})

test('fixed-grid preexisting shortage is retained but never credited as onset warning', () => {
  const receipt = issue(history(), { amountUsd: 50_000_000 })
  assert.equal(receipt.scoreClass, 'fixed_grid')
  assert.equal(receipt.riskSet, 'preexisting_shortage')
  assert.equal(receipt.scenario.persistenceBelowAmount, true)
  assert.equal(receipt.scenario.linearBelowAmount, true)
  const score = scoreCashScenario(
    receipt,
    [7, 8, 9, 10, 11, 12].map((i) => sample(i, 5)),
    { scoredAt: iso(base + 49 * 3600), existingScore: null },
  )
  assert.equal(score.status, 'observed')
  assert.equal(score.sampledCashBelowAmount, true)
  assert.equal(score.riskSet, 'preexisting_shortage')
  assert.equal(score.onsetEligible, false)
  assert.deepEqual(score.scenarioPredictions, { persistence: null, linear: null })
})

test('late, backfilled, stale and config-drifted anchors are refused; legacy observed remains eligible', () => {
  const rows = history()
  assert.throws(() => issue(rows, { issuedAt: iso(base + 25 * 3600) }), /Late/)
  assert.throws(() => issue(rows, { config: { ...config, enabled: false } }), /disabled/)
  assert.throws(() => issue(rows, { config: { ...config, underlying: config.address } }), /changed/)
  assert.throws(
    () => issue([...rows.slice(0, -1), { ...rows.at(-1), source: 'backfilled' }]),
    /Ineligible/,
  )
  const legacy = issue([...rows.slice(0, -1), { ...rows.at(-1), recorder_atomic_v1: null }])
  assert.equal(legacy.anchor.recorderAtomicV1, false)
  assert.throws(
    () =>
      issue([
        ...rows.slice(0, -1),
        { ...rows.at(-1), params: { ...rows.at(-1).params, read_block_time: base + 20 * 3600 } },
      ]),
    /stale/,
  )
  assert.throws(
    () =>
      issue([...rows.slice(0, -1), { ...rows.at(-1), created_at: iso(base + 24 * 3600 + 300) }], {
        issuedAt: iso(base + 24 * 3600 + 600),
      }),
    /Backdated/,
  )
  assert.throws(
    () => issue([...rows.slice(0, -1), { ...rows.at(-1), created_at: iso(base + 24 * 3600 + 90) }]),
    /Anchor was not first-locally-observed/,
  )
})

test('raw cash, block seal and underlying/decimals identity must all agree', () => {
  const row = sample(0)
  for (const params of [
    { underlyingIdentity: 'unknown' },
    { decimalsIdentity: 'mismatch' },
    { read_block_finalized: false },
    { read_block_hash: 'bad' },
    { underlyingBalance: '-1' },
  ])
    assert.throws(() => normalizeSample({ ...row, params: { ...row.params, ...params } }))
  assert.throws(() => normalizeSample({ ...row, instant_usd: 123 }), /differs/)
  assert.throws(() => normalizeSample({ ...row, block: '999' }), /Ineligible/)
})

test('incomplete 18–30h prior interval abstains without inventing a slope', () => {
  const short = [sample(3, 21), sample(4, 20), sample(5, 19), sample(6, 18)]
  const receipt = issue(short)
  assert.equal(receipt.scenario.status, 'unavailable')
  assert.equal(receipt.scenario.reason, 'incomplete_trailing_18_to_30h_interval')
  assert.equal(receipt.scenario.linearCashUsdAssumingPeg, null)
  assert.equal(receipt.anchor.cashRaw, (18_000_000n * 10n ** 18n).toString())
  const gapped = [sample(0, 24), sample(1, 23), sample(6, 18)]
  assert.equal(issue(gapped).scenario.status, 'unavailable')
})

test('duplicate block, hash, or local time and reversed chronology fail issuance', () => {
  const rows = history()
  for (const changed of [
    { block: rows.at(-2).block },
    { observed_at: rows.at(-2).observed_at },
    { params: { ...rows.at(-1).params, read_block_hash: rows.at(-2).params.read_block_hash } },
  ]) {
    const last = { ...rows.at(-1), ...changed }
    if (changed.block) last.params = { ...last.params, read_block_number: changed.block }
    assert.throws(() => issue([...rows.slice(0, -1), last]))
  }
})

test('first bounded target observation is scored and later observations cannot replace it', () => {
  const receipt = issue()
  assert.throws(
    () => scoreCashScenario(receipt, [], { scoredAt: iso(base + 48 * 3600) }),
    /Existing-score lookup/,
  )
  const future = [
    sample(7, 15),
    sample(8, 12),
    sample(9, 9),
    sample(10, 8),
    sample(11, 7),
    sample(12, 6),
    sample(13, 5),
  ]
  const score = scoreCashScenario(receipt, future, {
    scoredAt: iso(base + 49 * 3600),
    existingScore: null,
  })
  assert.equal(score.status, 'observed')
  assert.equal(score.outcomeSample.id, 'sample-12')
  assert.equal(score.sampledCashBelowAmount, true)
  assert.equal(score.targetLagSeconds, 0)
  assert.equal(score.scenarioPredictions.linear, false)
  assert.equal(
    scoreCashScenario(receipt, [...future, sample(14, 20)], {
      scoredAt: iso(base + 57 * 3600),
      existingScore: null,
    }).outcomeSample.id,
    'sample-12',
  )
  assert.throws(
    () =>
      scoreCashScenario(receipt, future, { scoredAt: iso(base + 50 * 3600), existingScore: score }),
    /rescore refused/,
  )
})

test('future leakage is excluded and pending becomes named missing after target window', () => {
  const receipt = issue()
  const notYetKnown = sample(12, 0, { observed_at: iso(base + 49 * 3600) })
  const pending = scoreCashScenario(receipt, [notYetKnown], {
    scoredAt: iso(base + 48 * 3600),
    existingScore: null,
  })
  assert.equal(pending.status, 'pending')
  assert.equal(pending.sha256, undefined)
  const missing = scoreCashScenario(receipt, [], {
    scoredAt: iso(base + 56 * 3600),
    existingScore: null,
  })
  assert.equal(missing.status, 'censored')
  assert.equal(missing.reason, 'missing_target_sample_within_8h')
  const timelyPath = [7, 8, 9, 10, 11, 12].map((i) => sample(i, 0))
  const delayedScore = scoreCashScenario(receipt, timelyPath, {
    scoredAt: iso(base + 59 * 3600),
    existingScore: null,
  })
  assert.equal(delayedScore.status, 'observed')
  assert.equal(delayedScore.outcomeSample.id, 'sample-12')
  assert.equal(delayedScore.scoreLagFromTargetSeconds, 11 * 3600)
  assert.equal(delayedScore.scoreDelayBeyondTargetWindowSeconds, 3 * 3600)
  const lateSource = scoreCashScenario(receipt, [...timelyPath.slice(0, -1), sample(15, 0)], {
    scoredAt: iso(base + 61 * 3600),
    existingScore: null,
  })
  assert.equal(lateSource.status, 'censored')
  assert.equal(lateSource.reason, 'target_sample_first_seen_after_8h')
  const preTarget = sample(12, 0, {
    observed_at: iso(base + 48 * 3600 - 30),
    created_at: iso(base + 48 * 3600 - 30),
    params: {
      ...sample(12, 0).params,
      read_block_time: base + 48 * 3600 - 630,
    },
  })
  const createdLate = sample(13, 0, {
    observed_at: iso(base + 56 * 3600 - 30),
    created_at: iso(base + 56 * 3600 + 30),
    params: {
      ...sample(13, 0).params,
      read_block_time: base + 56 * 3600 - 630,
    },
  })
  const lateCreation = scoreCashScenario(
    receipt,
    [...timelyPath.slice(0, -1), preTarget, createdLate],
    { scoredAt: iso(base + 57 * 3600), existingScore: null },
  )
  assert.equal(lateCreation.reason, 'target_sample_created_after_8h')
  const postScoreCreated = sample(12, 0, { created_at: iso(base + 48 * 3600 + 90) })
  const beforeCreation = scoreCashScenario(receipt, [postScoreCreated], {
    scoredAt: iso(base + 48 * 3600),
    existingScore: null,
  })
  assert.equal(beforeCreation.status, 'pending')
})

test('gap, future identity drift, and duplicate timing are explicitly censored', () => {
  const receipt = issue()
  assert.equal(
    scoreCashScenario(receipt, [sample(9, 9)], {
      scoredAt: iso(base + 49 * 3600),
      existingScore: null,
    }).reason,
    'prospective_sample_gap_over_8h',
  )
  const bad = sample(7, 15)
  bad.params.underlyingOnchain = config.address
  assert.equal(
    scoreCashScenario(receipt, [bad], {
      scoredAt: iso(base + 49 * 3600),
      existingScore: null,
    }).reason,
    'invalid_or_identity_drifted_future_sample',
  )
  assert.equal(
    scoreCashScenario(receipt, [sample(7, 15, { block: '106' })], {
      scoredAt: iso(base + 49 * 3600),
      existingScore: null,
    }).reason,
    'invalid_or_identity_drifted_future_sample',
  )
})
