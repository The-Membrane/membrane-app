// Pure, prospective sampled reserve-cash proxy. No DB, RPC, or delivery side effects.
import { createHash } from 'node:crypto'

export const STUDY = 'aave-v3-usde-prospective-sampled-cash-v1'
export const SCORE_AMOUNTS_USD = Object.freeze([1_000_000, 10_000_000, 50_000_000])
export const SCORE_HORIZONS_SECONDS = Object.freeze([8 * 3600, 24 * 3600, 7 * 86400])
export const MAX_GAP_SECONDS = 8 * 3600
export const MAX_ISSUE_LAG_SECONDS = 10 * 60
export const MAX_BLOCK_AGE_SECONDS = 2 * 3600
const MIN_TRAIL_SECONDS = 18 * 3600
const MAX_TRAIL_SECONDS = 30 * 3600
const TARGET_TRAIL_SECONDS = 24 * 3600
const HASH = /^0x[0-9a-f]{64}$/i
const ATOKEN = '0x4f5923fc5fd4a93352581b38b7cd26943012decf'
const UNDERLYING = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3'
const DECIMALS = 18

const fail = (message) => {
  throw new Error(message)
}
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const seconds = (value, name) => {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(ms)) fail(`Invalid ${name}`)
  return ms / 1000
}
const freezeDeep = (value) => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}
const address = (value) => (typeof value === 'string' ? value.toLowerCase() : '')
const raw = (value) => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) fail('Invalid raw underlying cash')
  return BigInt(value)
}

// The recorder's observed_at is the local first-observation clock. A chain
// block time alone cannot make a historical/backfilled row prospective.
export function normalizeSample(row) {
  const p = row?.params
  if (
    !row ||
    typeof row.id !== 'string' ||
    !row.id ||
    row.venue !== 'aave-v3-usde' ||
    row.chain !== 'ethereum' ||
    row.source !== 'observed' ||
    row.created_at === undefined ||
    p?.kind !== 'atoken-liquidity' ||
    p.read_block_finalized !== true ||
    p.read_block_pinned !== true ||
    !HASH.test(p.read_block_hash ?? '') ||
    !/^\d+$/.test(String(row.block ?? '')) ||
    String(row.block) !== String(p.read_block_number) ||
    !Number.isSafeInteger(p.read_block_time) ||
    address(p.aToken) !== ATOKEN ||
    address(p.underlying) !== UNDERLYING ||
    address(p.underlyingOnchain) !== UNDERLYING ||
    p.underlyingIdentity !== 'match' ||
    p.decimalsIdentity !== 'match' ||
    p.decimals !== DECIMALS ||
    p.underlyingDecimalsOnchain !== DECIMALS ||
    p.reads?.underlyingAsset !== true ||
    p.reads?.underlyingDecimals !== true ||
    p.reads?.underlyingBalance !== true ||
    p.priceAssumptionUsd !== 1
  )
    fail('Ineligible observed Aave USDe source or reserve identity')
  const firstLocalObservedAt = seconds(row.observed_at, 'first local observation')
  const blockTime = p.read_block_time
  if (blockTime > firstLocalObservedAt + 120) fail('Block time follows local observation')
  if (firstLocalObservedAt - blockTime > MAX_BLOCK_AGE_SECONDS)
    fail('Late or stale observed source')
  const createdAt = seconds(row.created_at, 'created time')
  if (createdAt < firstLocalObservedAt - 120 || createdAt > firstLocalObservedAt + 120)
    fail('Backdated local observation')
  const cashRaw = raw(p.underlyingBalance)
  const cashUsdAssumingPeg = Number(cashRaw) / 10 ** DECIMALS
  const instant = Number(row.instant_usd)
  if (
    !Number.isFinite(cashUsdAssumingPeg) ||
    !Number.isFinite(instant) ||
    row.instant_usd === null ||
    Math.abs(instant - cashUsdAssumingPeg) > Math.max(1e-6, cashUsdAssumingPeg * 1e-12)
  )
    fail('Sampled cash differs from verified raw balance under $1 assumption')
  return {
    id: row.id,
    recorderAtomicV1: row.recorder_atomic_v1 === true,
    block: String(row.block),
    blockHash: p.read_block_hash.toLowerCase(),
    blockTime,
    firstLocalObservedAt,
    createdAt,
    aToken: ATOKEN,
    underlying: UNDERLYING,
    decimals: DECIMALS,
    cashRaw: cashRaw.toString(),
    cashUsdAssumingPeg,
  }
}

function strictSequence(samples) {
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]
    const b = samples[i]
    if (
      b.firstLocalObservedAt <= a.firstLocalObservedAt ||
      BigInt(b.block) <= BigInt(a.block) ||
      b.blockTime <= a.blockTime ||
      b.id === a.id ||
      b.blockHash === a.blockHash
    )
      fail('Nonmonotone or duplicate observed source sequence')
  }
}

function trailingPair(samples) {
  const anchor = samples.at(-1)
  let best = null
  for (let j = samples.length - 2; j >= 0; j--) {
    const elapsed = anchor.firstLocalObservedAt - samples[j].firstLocalObservedAt
    if (elapsed > MAX_TRAIL_SECONDS) break
    if (elapsed < MIN_TRAIL_SECONDS) continue
    const interval = samples.slice(j)
    if (
      interval.some(
        (sample, k) =>
          k > 0 &&
          sample.firstLocalObservedAt - interval[k - 1].firstLocalObservedAt > MAX_GAP_SECONDS,
      )
    )
      continue
    const distance = Math.abs(elapsed - TARGET_TRAIL_SECONDS)
    if (!best || distance < best.distance || (distance === best.distance && elapsed < best.elapsed))
      best = { prior: samples[j], elapsed, distance }
  }
  return best
}

export function issueCashScenario(rows, { config, anchorId, issuedAt, amountUsd, horizonSeconds }) {
  if (!Array.isArray(rows) || !rows.length) fail('Observed source rows required')
  if (
    config?.name !== 'aave-v3-usde' ||
    config.enabled !== true ||
    config.kind !== 'atoken-liquidity' ||
    address(config.address) !== ATOKEN ||
    address(config.underlying) !== UNDERLYING ||
    config.decimals !== DECIMALS
  )
    fail('Aave USDe venue config disabled or identity changed')
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) fail('Positive finite amountUsd required')
  if (
    !Number.isSafeInteger(horizonSeconds) ||
    horizonSeconds < 8 * 3600 ||
    horizonSeconds > 30 * 86400
  )
    fail('Horizon must be integer seconds from 8h through 30d')
  const issueTime = seconds(issuedAt, 'issue time')
  const seenByIssue = rows.filter(
    (row) =>
      seconds(row.observed_at, 'first local observation') <= issueTime &&
      seconds(row.created_at, 'created time') <= issueTime,
  )
  const anchorRow = seenByIssue.find((row) => row.id === anchorId)
  if (!anchorRow) fail('Anchor was not first-locally-observed by issue time')
  const anchorAt = seconds(anchorRow.observed_at, 'anchor first local observation')
  const known = seenByIssue
    .filter(
      (row) => seconds(row.observed_at, 'first local observation') >= anchorAt - MAX_TRAIL_SECONDS,
    )
    .map(normalizeSample)
    .sort((a, b) => a.firstLocalObservedAt - b.firstLocalObservedAt)
  strictSequence(known)
  const anchor = known.at(-1)
  if (!anchor || anchor.id !== anchorId) fail('Anchor is not latest first-locally-observed row')
  if (
    issueTime < anchor.firstLocalObservedAt ||
    issueTime - anchor.firstLocalObservedAt > MAX_ISSUE_LAG_SECONDS
  )
    fail('Late or future anchor')
  if (issueTime - anchor.blockTime > MAX_BLOCK_AGE_SECONDS)
    fail('Stale finalized block or later-discovered old block')
  const pair = trailingPair(known)
  const status = pair ? 'available' : 'unavailable'
  const slope = pair
    ? Math.max(0, pair.prior.cashUsdAssumingPeg - anchor.cashUsdAssumingPeg) / pair.elapsed
    : null
  const persistence = pair ? anchor.cashUsdAssumingPeg : null
  const linear = pair ? Math.max(0, anchor.cashUsdAssumingPeg - slope * horizonSeconds) : null
  const scoredCell =
    SCORE_AMOUNTS_USD.includes(amountUsd) && SCORE_HORIZONS_SECONDS.includes(horizonSeconds)
  const sourcePath = known.map((sample) => ({
    id: sample.id,
    block: sample.block,
    blockHash: sample.blockHash,
    firstLocalObservedAt: sample.firstLocalObservedAt,
    createdAt: sample.createdAt,
    cashRaw: sample.cashRaw,
  }))
  const payload = {
    study: STUDY,
    status: 'issued',
    scoreClass: scoredCell ? 'fixed_grid' : 'descriptive_only',
    riskSet: anchor.cashUsdAssumingPeg < amountUsd ? 'preexisting_shortage' : 'at_risk',
    issuedAt: new Date(issueTime * 1000).toISOString(),
    anchorAgeAtIssueSeconds: issueTime - anchor.firstLocalObservedAt,
    amountUsd,
    horizonSeconds,
    anchor,
    sourcePath,
    targetAt: new Date((issueTime + horizonSeconds) * 1000).toISOString(),
    preAnchor: pair
      ? { sample: pair.prior, elapsedSeconds: pair.elapsed, declineUsdPerSecond: slope }
      : null,
    scenario: {
      status,
      reason: pair ? null : 'incomplete_trailing_18_to_30h_interval',
      persistenceCashUsdAssumingPeg: persistence,
      linearCashUsdAssumingPeg: linear,
      persistenceBelowAmount: pair ? persistence < amountUsd : null,
      linearBelowAmount: pair ? linear < amountUsd : null,
    },
    claim: 'sampled_reserve_cash_proxy_only',
  }
  return freezeDeep({ ...payload, sha256: sha(payload) })
}

export function verifyIssue(issue) {
  if (issue?.study !== STUDY || issue.status !== 'issued' || !/^[a-f0-9]{64}$/.test(issue.sha256))
    fail('Invalid issue receipt')
  if (
    seconds(issue.targetAt, 'target time') !==
      seconds(issue.issuedAt, 'issue time') + issue.horizonSeconds ||
    issue.anchorAgeAtIssueSeconds !==
      seconds(issue.issuedAt, 'issue time') - issue.anchor?.firstLocalObservedAt ||
    !Array.isArray(issue.sourcePath) ||
    issue.sourcePath.at(-1)?.id !== issue.anchor?.id ||
    issue.sourcePath.at(-1)?.blockHash !== issue.anchor?.blockHash ||
    issue.sourcePath.at(-1)?.cashRaw !== issue.anchor?.cashRaw
  )
    fail('Issue target or source-path invariant mismatch')
  if (
    issue.riskSet !==
      (issue.anchor?.cashUsdAssumingPeg < issue.amountUsd ? 'preexisting_shortage' : 'at_risk') ||
    issue.scoreClass !==
      (SCORE_AMOUNTS_USD.includes(issue.amountUsd) &&
      SCORE_HORIZONS_SECONDS.includes(issue.horizonSeconds)
        ? 'fixed_grid'
        : 'descriptive_only')
  )
    fail('Issue grid or at-risk classification mismatch')
  const { sha256, ...payload } = issue
  if (sha(payload) !== sha256) fail('Issue receipt seal mismatch')
  return true
}

// The caller must persist returned scores insert-once keyed by issue.sha256.
// Passing an existing score refuses a second evaluation, even with later data.
export function scoreCashScenario(issue, rows, options) {
  if (!Object.hasOwn(options ?? {}, 'existingScore'))
    fail('Existing-score lookup result is required before scoring')
  const { scoredAt, existingScore } = options
  verifyIssue(issue)
  if (existingScore) fail('Issue already scored; retroactive rescore refused')
  if (issue.scoreClass !== 'fixed_grid') fail('Descriptive scenario cannot enter fixed-grid score')
  if (!Array.isArray(rows)) fail('Outcome rows required')
  const scoreTime = seconds(scoredAt, 'score time')
  const target = seconds(issue.targetAt, 'target time')
  if (scoreTime < target) fail('Score time precedes target')
  const known = rows
    .filter(
      (row) =>
        seconds(row.observed_at, 'first local observation') <= scoreTime &&
        seconds(row.created_at, 'created time') <= scoreTime,
    )
    .sort(
      (a, b) =>
        seconds(a.observed_at, 'first local observation') -
        seconds(b.observed_at, 'first local observation'),
    )
  let previous = issue.anchor
  let selected = null
  let reason = null
  for (const row of known) {
    const at = seconds(row.observed_at, 'first local observation')
    if (at <= issue.anchor.firstLocalObservedAt) continue
    if (at > target + MAX_GAP_SECONDS) {
      reason = 'target_sample_first_seen_after_8h'
      break
    }
    let sample
    try {
      sample = normalizeSample(row)
    } catch {
      reason = 'invalid_or_identity_drifted_future_sample'
      break
    }
    if (
      sample.firstLocalObservedAt <= previous.firstLocalObservedAt ||
      BigInt(sample.block) <= BigInt(previous.block) ||
      sample.blockTime <= previous.blockTime ||
      sample.id === previous.id ||
      sample.blockHash === previous.blockHash
    ) {
      reason = 'duplicate_or_nonmonotone_future_sample'
      break
    }
    if (sample.firstLocalObservedAt - previous.firstLocalObservedAt > MAX_GAP_SECONDS) {
      reason = 'prospective_sample_gap_over_8h'
      break
    }
    if (sample.createdAt > target + MAX_GAP_SECONDS) {
      reason = 'target_sample_created_after_8h'
      break
    }
    previous = sample
    if (at >= target) {
      selected = sample
      break
    }
  }
  if (!selected && !reason)
    reason =
      scoreTime < target + MAX_GAP_SECONDS
        ? 'pending_target_window'
        : 'missing_target_sample_within_8h'
  const status = selected ? 'observed' : reason === 'pending_target_window' ? 'pending' : 'censored'
  if (status === 'pending')
    return freezeDeep({
      study: STUDY,
      issueSha256: issue.sha256,
      status,
      reason,
      targetWindowClosesAt: new Date((target + MAX_GAP_SECONDS) * 1000).toISOString(),
    })
  const outcome = {
    study: STUDY,
    issueSha256: issue.sha256,
    scoredAt: new Date(scoreTime * 1000).toISOString(),
    scoreLagFromTargetSeconds: scoreTime - target,
    scoreDelayBeyondTargetWindowSeconds: Math.max(0, scoreTime - target - MAX_GAP_SECONDS),
    status,
    reason,
    outcomeSample: selected,
    outcomeSampleSha256: selected ? sha(selected) : null,
    targetLagSeconds: selected ? selected.firstLocalObservedAt - target : null,
    sampledCashBelowAmount: selected ? selected.cashUsdAssumingPeg < issue.amountUsd : null,
    riskSet: issue.riskSet,
    onsetEligible: issue.riskSet === 'at_risk',
    scenarioPredictions:
      issue.riskSet === 'at_risk' && issue.scenario.status === 'available'
        ? {
            persistence: issue.scenario.persistenceBelowAmount,
            linear: issue.scenario.linearBelowAmount,
          }
        : { persistence: null, linear: null },
  }
  return freezeDeep({ ...outcome, sha256: sha(outcome) })
}
