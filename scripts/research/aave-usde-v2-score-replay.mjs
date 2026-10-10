// Pure, bounded replay of one stored v2 score. Caller-supplied source-row
// completeness and chronological availability remain unverified here.
import { isDeepStrictEqual } from 'node:util'
import { scoreFirstBreach, verifyFirstBreachIssue } from './aave-usde-first-breach.mjs'

export const MAX_REPLAY_ROWS = 4096
export const MAX_SCORE_PAYLOAD_BYTES = 1_048_576

const fail = (message) => {
  throw new Error(message)
}
const time = (value, name) => {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(ms)) fail(`Invalid ${name}`)
  return ms
}
const result = (classification, reason, extra = {}) => ({
  classification,
  reason,
  sourceCompleteness: 'caller_unverified',
  prospectiveEligible: false,
  ...extra,
})

// The persisted score's clock is replayed exactly. The caller must provide
// the complete projected observed-source query result, including rows that
// normalizeSample will censor; this function cannot prove that premise.
export function replayAaveUsdeV2Score({ issue, storedScorePayload, observedRows }) {
  verifyFirstBreachIssue(issue)
  if (typeof storedScorePayload !== 'string') fail('Stored score payload bytes required')
  if (Buffer.byteLength(storedScorePayload, 'utf8') > MAX_SCORE_PAYLOAD_BYTES)
    fail('Stored score payload exceeds replay bound')
  if (!Array.isArray(observedRows) || observedRows.length > MAX_REPLAY_ROWS)
    fail('Complete projected observed rows required within replay bound')
  let stored
  try {
    stored = JSON.parse(storedScorePayload)
  } catch {
    fail('Invalid stored score JSON')
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored))
    fail('Stored score object required')
  const scoredAt = time(stored.scoredAt, 'stored score time')
  const targetAt = time(issue.targetAt, 'issue target')
  const observationClosesAt = targetAt + 8 * 3_600_000
  const sourceAsOf = observationClosesAt + 120_000
  const anchorAt = issue.anchor.firstLocalObservedAt * 1000

  // The scorer's only row inclusion gates are created_at and observed_at.
  // Do not prefilter on recorder_atomic_v1 or source: an in-window row whose
  // source is not `observed` causes its normalizer to censor the outcome.
  // Equal observation times are order-sensitive because the scorer sorts only
  // by that timestamp and then applies its nonmonotonicity gate.
  const seenTimes = new Set()
  for (const row of observedRows) {
    const createdAt = time(row?.created_at, 'source created time')
    const observedAt = time(row?.observed_at, 'source observation time')
    if (createdAt > sourceAsOf || observedAt <= anchorAt || observedAt > observationClosesAt)
      continue
    if (seenTimes.has(observedAt))
      return result('ambiguous', 'equal_observation_time_order_unproven', {
        issueSha256: issue.sha256,
        storedScoreSha256: stored.sha256 ?? null,
      })
    seenTimes.add(observedAt)
  }

  const expected = scoreFirstBreach(issue, observedRows, {
    existingScore: null,
    scoredAt: new Date(scoredAt).toISOString(),
  })
  if (expected.status === 'pending')
    return result('mismatch', 'stored_score_before_source_cutoff', {
      issueSha256: issue.sha256,
      storedScoreSha256: stored.sha256 ?? null,
      replayedScoreSha256: null,
    })
  const matches = isDeepStrictEqual(stored, expected)
  return result(
    matches ? 'match' : 'mismatch',
    matches ? null : 'stored_score_differs_from_replay',
    {
      issueSha256: issue.sha256,
      storedScoreSha256: stored.sha256 ?? null,
      replayedScoreSha256: expected.sha256,
      replayedStatus: expected.status,
    },
  )
}
