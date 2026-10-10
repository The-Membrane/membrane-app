// Offline first locally sampled reserve-cash breach protocol. No RPC, DB, or alerts.
import { createHash } from 'node:crypto'
import {
  issueCashScenario,
  normalizeSample,
  MAX_GAP_SECONDS,
  SCORE_AMOUNTS_USD,
  SCORE_HORIZONS_SECONDS,
  STUDY as SOURCE_STUDY,
} from './aave-usde-prospective-cash.mjs'

export const STUDY = 'aave-v3-usde-first-sampled-cash-breach-by-h-v2'
export const OUTCOME_LAG_SECONDS = MAX_GAP_SECONDS
export const MAX_CREATE_LAG_SECONDS = 120

const fail = (message) => {
  throw new Error(message)
}
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const atSeconds = (value, name) => {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(ms)) fail(`Invalid ${name}`)
  return ms / 1000
}
const iso = (seconds) => new Date(seconds * 1000).toISOString()
const freezeDeep = (value) => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}
const pathEntry = (sample) => ({
  id: sample.id,
  block: sample.block,
  blockHash: sample.blockHash,
  blockTime: sample.blockTime,
  firstLocalObservedAt: sample.firstLocalObservedAt,
  createdAt: sample.createdAt,
  cashRaw: sample.cashRaw,
  cashUsdAssumingPeg: sample.cashUsdAssumingPeg,
})

// The v1 issuer supplies the same independently sealed source eligibility,
// chronology, fresh-anchor, and issue-time as-of checks. The v2 issue has a
// different study, risk set, target, and seal; it does not modify a v1 receipt.
export function issueFirstBreach(rows, options) {
  const source = issueCashScenario(rows, options)
  if (source.anchor.cashUsdAssumingPeg < source.amountUsd)
    fail('First-breach issue requires cash at or above the requested amount')
  const payload = {
    study: STUDY,
    status: 'issued',
    scoreClass: source.scoreClass,
    claim: 'first_locally_sampled_reserve_cash_breach_only',
    sourceProtocol: source.study,
    sourceIssueSha256: source.sha256,
    issuedAt: source.issuedAt,
    targetAt: source.targetAt,
    amountUsd: source.amountUsd,
    horizonSeconds: source.horizonSeconds,
    anchorAgeAtIssueSeconds: source.anchorAgeAtIssueSeconds,
    anchor: source.anchor,
    issueSourcePath: source.sourcePath,
  }
  return freezeDeep({ ...payload, sha256: sha(payload) })
}

export function verifyFirstBreachIssue(issue) {
  if (
    issue?.study !== STUDY ||
    issue.status !== 'issued' ||
    issue.claim !== 'first_locally_sampled_reserve_cash_breach_only' ||
    issue.sourceProtocol !== SOURCE_STUDY ||
    !/^[a-f0-9]{64}$/.test(issue.sha256) ||
    !/^[a-f0-9]{64}$/.test(issue.sourceIssueSha256) ||
    !Number.isFinite(issue.amountUsd) ||
    issue.amountUsd <= 0 ||
    !Number.isSafeInteger(issue.horizonSeconds) ||
    issue.horizonSeconds < 8 * 3600 ||
    issue.horizonSeconds > 30 * 86400 ||
    !Number.isFinite(issue.anchor?.cashUsdAssumingPeg) ||
    issue.anchor?.cashUsdAssumingPeg < issue.amountUsd ||
    issue.scoreClass !==
      (SCORE_AMOUNTS_USD.includes(issue.amountUsd) &&
      SCORE_HORIZONS_SECONDS.includes(issue.horizonSeconds)
        ? 'fixed_grid'
        : 'descriptive_only') ||
    atSeconds(issue.targetAt, 'target') !==
      atSeconds(issue.issuedAt, 'issue') + issue.horizonSeconds ||
    issue.anchorAgeAtIssueSeconds !==
      atSeconds(issue.issuedAt, 'issue') - issue.anchor?.firstLocalObservedAt ||
    issue.anchorAgeAtIssueSeconds < 0 ||
    issue.anchorAgeAtIssueSeconds > 600 ||
    !Array.isArray(issue.issueSourcePath) ||
    issue.issueSourcePath.at(-1)?.id !== issue.anchor?.id ||
    issue.issueSourcePath.at(-1)?.blockHash !== issue.anchor?.blockHash ||
    issue.issueSourcePath.at(-1)?.cashRaw !== issue.anchor?.cashRaw
  )
    fail('Invalid first-breach issue invariant')
  const { sha256, ...payload } = issue
  if (sha(payload) !== sha256) fail('First-breach issue seal mismatch')
  return true
}

// A caller must query the insert-once score store by issue SHA and pass that
// result here. Re-evaluation with a later source cutoff is forbidden.
export function scoreFirstBreach(issue, rows, options) {
  if (!Object.hasOwn(options ?? {}, 'existingScore')) fail('Existing-score lookup result required')
  verifyFirstBreachIssue(issue)
  if (options.existingScore) fail('Issue already scored; retroactive rescore refused')
  if (issue.scoreClass !== 'fixed_grid') fail('Descriptive issue cannot enter fixed-grid score')
  if (!Array.isArray(rows)) fail('Outcome rows required')
  const target = atSeconds(issue.targetAt, 'target')
  const scoreTime = atSeconds(options.scoredAt, 'score time')
  const observationClosesAt = target + OUTCOME_LAG_SECONDS
  const sourceAsOf = observationClosesAt + MAX_CREATE_LAG_SECONDS
  if (scoreTime < sourceAsOf)
    return freezeDeep({
      study: STUDY,
      issueSha256: issue.sha256,
      status: 'pending',
      reason: 'outcome_window_open',
      outcomeWindowClosesAt: iso(sourceAsOf),
      sourceCompleteness: 'caller_unverified',
      prospectiveEligible: false,
    })

  // Freeze availability at one source cutoff, regardless of the later call
  // time. A row observed at the window edge may legitimately be created up
  // to 120 seconds later. Completeness of the supplied feed is not verified.
  const known = rows
    .filter(
      (row) =>
        atSeconds(row.created_at, 'created time') <= sourceAsOf &&
        atSeconds(row.observed_at, 'local observation') > issue.anchor.firstLocalObservedAt &&
        atSeconds(row.observed_at, 'local observation') <= observationClosesAt,
    )
    .sort(
      (a, b) =>
        atSeconds(a.observed_at, 'local observation') -
        atSeconds(b.observed_at, 'local observation'),
    )
  const path = [pathEntry(issue.anchor)]
  let previous = issue.anchor
  let firstBreach = null
  let firstRecovery = null
  let targetWitness = null
  let reason = null
  for (const row of known) {
    let sample
    try {
      sample = normalizeSample(row)
    } catch {
      reason = 'ineligible_or_identity_drifted_source'
      break
    }
    if (
      sample.firstLocalObservedAt <= previous.firstLocalObservedAt ||
      BigInt(sample.block) <= BigInt(previous.block) ||
      sample.blockTime <= previous.blockTime ||
      sample.id === previous.id ||
      sample.blockHash === previous.blockHash
    ) {
      reason = 'duplicate_or_nonmonotone_source'
      break
    }
    if (sample.firstLocalObservedAt - previous.firstLocalObservedAt > MAX_GAP_SECONDS) {
      reason = 'source_gap_over_8h'
      break
    }
    path.push(pathEntry(sample))
    previous = sample
    if (sample.firstLocalObservedAt <= target && sample.cashUsdAssumingPeg < issue.amountUsd)
      firstBreach ??= pathEntry(sample)
    if (
      firstBreach &&
      !firstRecovery &&
      sample.firstLocalObservedAt > firstBreach.firstLocalObservedAt &&
      sample.cashUsdAssumingPeg >= issue.amountUsd
    )
      firstRecovery = pathEntry(sample)
    if (sample.firstLocalObservedAt >= target) {
      targetWitness = pathEntry(sample)
      break
    }
  }
  if (!reason && !targetWitness) reason = 'missing_target_witness_within_8h'
  const status = reason ? 'censored' : 'observed'
  const payload = {
    study: STUDY,
    issueSha256: issue.sha256,
    sourceIssueSha256: issue.sourceIssueSha256,
    status,
    reason,
    scoredAt: iso(scoreTime),
    sourceAsOf: iso(sourceAsOf),
    targetAt: issue.targetAt,
    outcomeWindowClosesAt: iso(sourceAsOf),
    observationWindowClosesAt: iso(observationClosesAt),
    sourceCompleteness: 'caller_unverified',
    prospectiveEligible: false,
    amountUsd: issue.amountUsd,
    horizonSeconds: issue.horizonSeconds,
    sourcePath: path,
    sourcePathSha256: sha(path),
    firstBreachByH: status === 'observed' ? firstBreach : null,
    firstRecoveryAfterBreach: status === 'observed' ? firstRecovery : null,
    targetWitness: status === 'observed' ? targetWitness : null,
    breachedByH: status === 'observed' ? Boolean(firstBreach) : null,
    targetWitnessBelowAmount:
      status === 'observed' ? targetWitness.cashUsdAssumingPeg < issue.amountUsd : null,
    exactHTargetBelowAmount:
      status === 'observed' && targetWitness.firstLocalObservedAt === target
        ? targetWitness.cashUsdAssumingPeg < issue.amountUsd
        : null,
    firstBreachOnlyAfterH:
      status === 'observed' && !firstBreach && targetWitness.cashUsdAssumingPeg < issue.amountUsd
        ? targetWitness
        : null,
    claim: 'first_locally_sampled_reserve_cash_breach_only',
  }
  return freezeDeep({ ...payload, sha256: sha(payload) })
}
