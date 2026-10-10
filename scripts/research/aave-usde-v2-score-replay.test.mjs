import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { issueFirstBreach, scoreFirstBreach } from './aave-usde-first-breach.mjs'
import {
  MAX_REPLAY_ROWS,
  MAX_SCORE_PAYLOAD_BYTES,
  replayAaveUsdeV2Score,
} from './aave-usde-v2-score-replay.mjs'

const base = Date.parse('2026-09-28T00:00:00Z')
const hour = 3_600_000
const at = (h, ms = 0) => new Date(base + h * hour + ms).toISOString()
const config = {
  name: 'aave-v3-usde',
  enabled: true,
  kind: 'atoken-liquidity',
  address: '0x4F5923Fc5FD4a93352581b38B7cD26943012DECF',
  underlying: '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3',
  decimals: 18,
}
const sample = (i, cashMillions = 20, overrides = {}) => ({
  id: `sample-${i}`,
  venue: 'aave-v3-usde',
  chain: 'ethereum',
  source: 'observed',
  recorder_atomic_v1: true,
  block: String(100 + i),
  observed_at: at(i * 4),
  created_at: at(i * 4),
  instant_usd: cashMillions * 1_000_000,
  params: {
    kind: 'atoken-liquidity',
    read_block_finalized: true,
    read_block_pinned: true,
    read_block_number: String(100 + i),
    read_block_hash: `0x${(100 + i).toString(16).padStart(64, '0')}`,
    read_block_time: (base + i * 4 * hour) / 1000 - 600,
    aToken: config.address,
    underlying: config.underlying,
    underlyingOnchain: config.underlying,
    underlyingIdentity: 'match',
    decimalsIdentity: 'match',
    decimals: 18,
    underlyingDecimalsOnchain: 18,
    reads: { underlyingAsset: true, underlyingDecimals: true, underlyingBalance: true },
    underlyingBalance: (BigInt(cashMillions * 1_000_000) * 10n ** 18n).toString(),
    priceAssumptionUsd: 1,
  },
  ...overrides,
})
const issue = issueFirstBreach(
  Array.from({ length: 7 }, (_, i) => sample(i)),
  {
    config,
    anchorId: 'sample-6',
    issuedAt: at(24),
    amountUsd: 10_000_000,
    horizonSeconds: 8 * 3600,
  },
)
const scoredAt = at(40, 120_000)
const rows = () => [sample(7, 20), sample(8, 9), sample(9, 13), sample(10, 14)]
const score = (sourceRows = rows(), clock = scoredAt) =>
  scoreFirstBreach(issue, sourceRows, { scoredAt: clock, existingScore: null })
const replay = (stored, sourceRows = rows()) =>
  replayAaveUsdeV2Score({
    issue,
    storedScorePayload: typeof stored === 'string' ? stored : JSON.stringify(stored),
    observedRows: sourceRows,
  })
const sha = (value) => createHash('sha256').update(value).digest('hex')

test('replays all logical fields using the exact stored score time', () => {
  const stored = score(rows(), at(41))
  const result = replay(stored)
  assert.equal(result.classification, 'match')
  assert.equal(result.reason, null)
  assert.equal(result.replayedScoreSha256, stored.sha256)
  assert.equal(result.sourceCompleteness, 'caller_unverified')
  assert.equal(result.prospectiveEligible, false)
})

test('a logically and physically self-sealed but false score mismatches source replay', () => {
  const genuine = score()
  assert.equal(genuine.breachedByH, true)
  const { sha256: ignored, ...body } = genuine
  void ignored
  body.breachedByH = false
  const forged = { ...body, sha256: sha(JSON.stringify(body)) }
  const payload = JSON.stringify(forged)
  const physicalSha256 = sha(payload)
  assert.equal(sha(JSON.stringify(body)), forged.sha256)
  assert.match(physicalSha256, /^[0-9a-f]{64}$/)
  const result = replay(payload)
  assert.equal(result.classification, 'mismatch')
  assert.equal(result.reason, 'stored_score_differs_from_replay')
  assert.equal(result.storedScoreSha256, forged.sha256)
  assert.equal(result.replayedScoreSha256, genuine.sha256)
})

test('as-of and observation-window limits match the scorer', () => {
  const sourceRows = [
    sample(7, 5, { created_at: at(41) }),
    sample(8, 20),
    sample(9, 20),
    sample(10, 20),
    sample(11, 5),
  ]
  const stored = score(sourceRows)
  assert.equal(stored.status, 'observed')
  assert.equal(stored.breachedByH, false)
  assert.equal(replay(stored, sourceRows).classification, 'match')
})

test('equal in-window observation times abstain rather than trusting input order', () => {
  const tied = sample(8, 9, {
    observed_at: at(28),
    created_at: at(28),
    params: { ...sample(8, 9).params, read_block_time: (base + 28 * hour) / 1000 - 600 },
  })
  const sourceRows = [sample(7, 20), tied, sample(9, 20), sample(10, 20)]
  const result = replay(score(sourceRows), sourceRows)
  assert.equal(result.classification, 'ambiguous')
  assert.equal(result.reason, 'equal_observation_time_order_unproven')
  assert.equal(result.prospectiveEligible, false)
})

test('source policy is replayed without a misleading atomic-marker prefilter', () => {
  const unmarked = [sample(7, 20, { recorder_atomic_v1: false }), ...rows().slice(1)]
  assert.equal(replay(score(unmarked), unmarked).classification, 'match')
  const drifted = [sample(7, 20, { source: 'backfilled' }), ...rows().slice(1)]
  assert.equal(score(drifted).reason, 'ineligible_or_identity_drifted_source')
  assert.equal(replay(score(drifted), drifted).classification, 'match')
})

test('rejects malformed and unbounded input and exposes a too-early stored score', () => {
  assert.throws(() => replay('{'), /Invalid stored score JSON/)
  assert.throws(() => replay('x'.repeat(MAX_SCORE_PAYLOAD_BYTES + 1)), /exceeds replay bound/)
  assert.throws(() => replay(score(), Array(MAX_REPLAY_ROWS + 1).fill(sample(7))), /bound/)
  const early = { ...score(), scoredAt: at(40, 119_000) }
  assert.equal(replay(early).reason, 'stored_score_before_source_cutoff')
})
