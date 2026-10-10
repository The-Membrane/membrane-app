// Read-only, fixed-holder prospective join. Internal seals and caller-supplied
// schedule/source hashes do not prove independent preregistration or first-known time.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { auditAsOf } from './venue-signal-asof-audit.mjs'
import { MARKETS } from './aave-core-forward-panel.mjs'
import { readCheckpoint as readBaseline } from './aave-core-holder-witness.mjs'
import { readCheckpoint as readFeatures } from './aave-core-anchor-features.mjs'
import { HORIZONS, readCheckpoint as readOutcomes } from './aave-core-holder-outcomes.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const shaPattern = /^[0-9a-f]{64}$/
const lower = (value) => String(value || '').toLowerCase()
const SIX_HOURS_MS = 6 * 3600 * 1000
const HORIZON_NAMES = Object.keys(HORIZONS)

export function scheduledSampleLeadFromLocalObservation({
  scheduledSampleAtMs,
  decisionAtMs,
  featureCompletedAtMs,
}) {
  if (
    !Number.isSafeInteger(scheduledSampleAtMs) ||
    !Number.isSafeInteger(decisionAtMs) ||
    !Number.isSafeInteger(featureCompletedAtMs)
  )
    return { seconds: null, atLeastSixHours: false }
  const milliseconds = scheduledSampleAtMs - Math.max(decisionAtMs, featureCompletedAtMs)
  return { seconds: milliseconds / 1000, atLeastSixHours: milliseconds >= SIX_HOURS_MS }
}

function classifyMarketOutcome(base, outcome, marketName) {
  if (!outcome) return { status: 'missing', reason: 'horizon-not-recorded', witnesses: [] }
  const frozen = base.markets.find((row) => row.name === marketName)
  const measured = outcome.markets.find((row) => row.name === marketName)
  if (!frozen || !measured || !Array.isArray(measured.witnesses))
    return { status: 'censored', reason: 'market-record-unavailable', witnesses: [] }
  if (!Array.isArray(frozen.qualifyingHolders) || frozen.qualifyingHolders.length === 0)
    return { status: 'censored', reason: 'no-fixed-at-risk-holders', witnesses: [] }
  if (
    !Number.isSafeInteger(outcome.blockTimestamp) ||
    outcome.blockTimestamp < outcome.targetTimestamp ||
    !Number.isSafeInteger(outcome.observedAtMs) ||
    outcome.observedAtMs < outcome.blockTimestamp * 1000
  )
    return { status: 'censored', reason: 'outcome-timing-unverified', witnesses: [] }
  if (
    measured.quoteRaw !== frozen.quoteRaw ||
    lower(measured.underlying) !== lower(frozen.underlying) ||
    lower(measured.aToken) !== lower(frozen.aToken) ||
    measured.witnesses.length !== frozen.qualifyingHolders.length ||
    measured.witnesses.some(
      (witness, index) => lower(witness.holder) !== lower(frozen.qualifyingHolders[index]),
    )
  )
    return { status: 'censored', reason: 'fixed-holder-or-quote-mismatch', witnesses: [] }

  // The Sep 26 calendar baseline omitted the implementation. Mechanical
  // successes at +6h/+24h are therefore censored, never clean controls.
  const poolIdentityKnown =
    base.poolImplementation?.status === 'observed' &&
    outcome.baselineImplementation?.status === 'observed' &&
    outcome.poolImplementation?.status === 'observed' &&
    lower(base.poolImplementation.address) === lower(outcome.baselineImplementation.address) &&
    lower(base.poolImplementation.codeHash) === lower(outcome.baselineImplementation.codeHash) &&
    lower(outcome.baselineImplementation.address) === lower(outcome.poolImplementation.address) &&
    lower(outcome.baselineImplementation.codeHash) === lower(outcome.poolImplementation.codeHash)
  const aTokenIdentityKnown =
    measured.baselineATokenImplementation?.status === 'observed' &&
    measured.aTokenImplementation?.status === 'observed' &&
    lower(measured.baselineATokenImplementation.address) ===
      lower(measured.aTokenImplementation.address) &&
    lower(measured.baselineATokenImplementation.codeHash) ===
      lower(measured.aTokenImplementation.codeHash)
  const witnesses = measured.witnesses.map((witness) => {
    const reasons = Array.isArray(witness.censoring) ? [...witness.censoring] : ['censoring-absent']
    const frozenCandidate = frozen.candidates?.find(
      (candidate) => lower(candidate.address) === lower(witness.holder),
    )
    if (
      frozenCandidate?.withdraw !== 'success' ||
      frozenCandidate?.codeStatus !== 'eoa' ||
      !/^\d+$/.test(frozenCandidate?.aTokenBalanceRaw || '') ||
      BigInt(frozenCandidate.aTokenBalanceRaw) < BigInt(frozen.quoteRaw)
    )
      reasons.push('baseline-holder-not-attested')
    if (!poolIdentityKnown) reasons.push('pool-implementation-unresolved')
    if (!aTokenIdentityKnown) reasons.push('aToken-implementation-unresolved')
    if (
      lower(measured.reserveAToken) !== lower(frozen.aToken) ||
      measured.decimals !== frozen.decimals ||
      measured.flags?.active !== true ||
      measured.flags?.paused !== false ||
      measured.underlyingCodeHash !== frozen.underlyingCodeHash ||
      measured.aTokenCodeHash !== frozen.aTokenCodeHash ||
      outcome.poolCodeHash !== base.poolCodeHash ||
      !/^\d+$/.test(measured.cashRaw || '') ||
      !Array.isArray(measured.readErrors) ||
      measured.readErrors.length > 0
    )
      reasons.push('reserve-or-runtime-state-unverified')
    if (
      witness.codeStatus !== 'eoa' ||
      !/^\d+$/.test(witness.aTokenBalanceRaw || '') ||
      BigInt(witness.aTokenBalanceRaw) < BigInt(frozen.quoteRaw) ||
      !Array.isArray(witness.healthReadErrors) ||
      witness.healthReadErrors.length > 0 ||
      witness.readErrorStage !== null
    )
      reasons.push('holder-state-unverified')
    if (witness.call !== 'success' && witness.call !== 'revert') reasons.push('call-unresolved')
    if (witness.call === 'success' && witness.returnedRaw !== frozen.quoteRaw)
      reasons.push('withdraw-return-unverified')
    if (
      witness.deterioration !==
      (witness.call === 'revert' && witness.censoring?.length === 0
        ? 'baseline-success-to-unattributed-revert'
        : witness.censoring?.length > 0
          ? 'censored'
          : 'no-observed-revert')
    )
      reasons.push('deterioration-label-inconsistent')
    return {
      holder: lower(witness.holder),
      call: witness.call,
      status: reasons.length
        ? 'censored'
        : witness.call === 'revert'
          ? 'deterioration'
          : 'sampled_success',
      censoring: [...new Set(reasons)],
    }
  })
  const deterioration = witnesses.some((row) => row.status === 'deterioration')
  const censored = witnesses.some((row) => row.status === 'censored')
  return {
    status: deterioration ? 'deterioration' : censored ? 'censored' : 'sampled_success',
    reason: deterioration
      ? 'at-least-one-clean-fixed-holder-revert'
      : censored
        ? 'one-or-more-fixed-holders-censored'
        : 'all-fixed-holders-executed',
    witnesses,
  }
}

/**
 * A read-only join of existing verified checkpoints. Every frozen day, market,
 * and predeclared horizon remains in the output, including missing sources.
 * Caller hashes are checked against current bytes, not treated as independent
 * immutable-source or timestamp attestations.
 */
export function buildProspectiveSignalOutcomePanel({
  schedule,
  requiredFeature = 'rawCashProxy',
  asOfMs,
} = {}) {
  if (!Array.isArray(schedule) || schedule.length === 0) throw new Error('Schedule required')
  if (!Number.isSafeInteger(asOfMs)) throw new Error('Explicit as-of clock required')
  for (const slot of schedule) {
    if (slot?.baselinePath !== null && (!slot?.baselinePath || !slot?.featurePath))
      throw new Error('Explicit daily baseline and feature paths required')
  }
  const audit = auditAsOf({ schedule, requiredFeature })
  const rows = []
  for (const [dayIndex, slot] of schedule.entries()) {
    const source =
      slot.baselinePath === null
        ? null
        : (() => {
            const baselineBytes = readFileSync(slot.baselinePath)
            const featureBytes = readFileSync(slot.featurePath)
            const baselinePhysicalSha256 = sha(baselineBytes)
            const featurePhysicalSha256 = sha(featureBytes)
            const baseline = readBaseline(slot.baselinePath)
            const features = readFeatures(slot.featurePath, slot.baselinePath)
            const outcomeFilePresent =
              typeof slot.outcomePath === 'string' && existsSync(slot.outcomePath)
            const outcomePhysicalSha256 = outcomeFilePresent
              ? sha(readFileSync(slot.outcomePath))
              : null
            const outcomes = outcomeFilePresent
              ? readOutcomes(slot.outcomePath, slot.baselinePath)
              : null
            if (
              sha(readFileSync(slot.baselinePath)) !== baselinePhysicalSha256 ||
              sha(readFileSync(slot.featurePath)) !== featurePhysicalSha256 ||
              (outcomeFilePresent &&
                (!existsSync(slot.outcomePath) ||
                  sha(readFileSync(slot.outcomePath)) !== outcomePhysicalSha256))
            )
              throw new Error('Checkpoint changed during panel read')
            return {
              baseline,
              features,
              outcomes,
              baselinePhysicalSha256,
              featurePhysicalSha256,
              outcomePhysicalSha256,
            }
          })()
    for (const [marketIndex, market] of MARKETS.entries()) {
      const audited = audit.rows[dayIndex * MARKETS.length + marketIndex]
      const base = source?.baseline.baselines.find(
        (item) =>
          item.block === slot.expectedBlock &&
          lower(item.blockHash) === lower(slot.expectedBlockHash),
      )
      const feature = source?.features.rows.find(
        (item) => item.block === base?.block && lower(item.blockHash) === lower(base?.blockHash),
      )
      const sourceIdentity = source
        ? {
            baselinePhysicalSha256: source.baselinePhysicalSha256,
            featurePhysicalSha256: source.featurePhysicalSha256,
            outcomePhysicalSha256: source.outcomePhysicalSha256,
            outcomeExpectedPhysicalShaMatched:
              source.outcomePhysicalSha256 !== null &&
              shaPattern.test(slot.outcomePhysicalSha256) &&
              slot.outcomePhysicalSha256 === source.outcomePhysicalSha256,
            baselineRowSha256: base?.rowSha256 ?? null,
            featureRowSha256: feature?.rowSha256 ?? null,
            baselineExpectedPhysicalShaMatched:
              shaPattern.test(slot.baselinePhysicalSha256) &&
              slot.baselinePhysicalSha256 === source.baselinePhysicalSha256,
            featureExpectedPhysicalShaMatched:
              shaPattern.test(slot.featurePhysicalSha256) &&
              slot.featurePhysicalSha256 === source.featurePhysicalSha256,
          }
        : null
      const sourceLinked =
        sourceIdentity?.baselineExpectedPhysicalShaMatched === true &&
        sourceIdentity?.featureExpectedPhysicalShaMatched === true &&
        feature?.sourcePhysicalSha256 === sourceIdentity.baselinePhysicalSha256 &&
        feature?.baselineRowSha256 === base?.rowSha256 &&
        feature?.baselineObservedAtMs === base?.observedAtMs &&
        feature?.blockTimestamp === base?.blockTimestamp
      for (const horizon of HORIZON_NAMES) {
        const savedOutcome = source?.outcomes?.outcomes.find(
          (item) => item.baselineBlock === base?.block && item.horizon === horizon,
        )
        const outcome = savedOutcome?.observedAtMs <= asOfMs ? savedOutcome : null
        const targetTimestamp = base ? base.blockTimestamp + HORIZONS[horizon] : null
        const measured = base
          ? !outcome && targetTimestamp * 1000 > asOfMs
            ? { status: 'pending', reason: 'horizon-not-yet-due', witnesses: [] }
            : classifyMarketOutcome(base, outcome, market.name)
          : { status: 'missing', reason: 'baseline-anchor-unavailable', witnesses: [] }
        const sampleLead = scheduledSampleLeadFromLocalObservation({
          scheduledSampleAtMs: targetTimestamp === null ? null : targetTimestamp * 1000,
          decisionAtMs: slot.decisionAtMs,
          featureCompletedAtMs: feature?.observedAtMs,
        })
        const signalStatus =
          slot.decisionAtMs > asOfMs
            ? 'not-yet-issued-asof'
            : audited.status !== 'asof_available_at_caller_clock'
              ? audited.status
              : !sourceLinked
                ? 'source-identity-unproven'
                : !sampleLead.atLeastSixHours
                  ? 'insufficient-scheduled-sample-lead'
                  : 'asof-available-reported'
        rows.push({
          day: slot.day,
          market: market.name,
          horizon,
          expectedBlock: slot.expectedBlock ?? null,
          expectedBlockHash: slot.expectedBlockHash ?? null,
          baselineBlock: base?.block ?? null,
          baselineBlockHash: base?.blockHash ?? null,
          decisionAtMs: slot.decisionAtMs,
          featureCompletedAtMs: feature?.observedAtMs ?? null,
          scheduledSampleAtMs: targetTimestamp === null ? null : targetTimestamp * 1000,
          scheduledSampleLeadSeconds: sampleLead.seconds,
          scheduledSampleLeadAtLeastSixHours:
            sampleLead.seconds === null ? null : sampleLead.atLeastSixHours,
          onsetLeadSeconds: null,
          onsetLeadAtLeastSixHours: null,
          onsetTimingStatus:
            measured.status === 'deterioration'
              ? 'unproven-interval-censored-between-baseline-and-sample'
              : 'no-deterioration-onset-observed',
          sourceIdentity,
          signalStatus,
          auditStatus: audited.status,
          auditReason: audited.reason,
          outcomeStatus: measured.status,
          outcomeReason: measured.reason,
          outcomeBlock: outcome?.block ?? null,
          outcomeBlockHash: outcome?.blockHash ?? null,
          outcomeObservedAtMs: outcome?.observedAtMs ?? null,
          outcomeRowSha256: outcome?.rowSha256 ?? null,
          outcomeSourceStatus: !outcome
            ? 'no-asof-outcome-source'
            : sourceIdentity?.outcomeExpectedPhysicalShaMatched
              ? 'current-bytes-match-caller-expected; immutability-unproven'
              : 'caller-expected-physical-sha-missing-or-mismatched',
          witnesses: measured.witnesses,
          sampledObservationReady:
            signalStatus === 'asof-available-reported' &&
            sourceIdentity?.outcomeExpectedPhysicalShaMatched === true &&
            (measured.status === 'sampled_success' || measured.status === 'deterioration'),
          exploratoryScoringReady: false,
          sampledQuietControlReady: false,
          eventLeadReady: false,
          predictiveEligibility: 'unproven',
        })
      }
    }
  }
  return {
    study: 'prospective-signal-outcome-panel-v1',
    scheduleLogicalSha256: sha(JSON.stringify(schedule)),
    scheduleProvenance: 'caller-supplied; independent freeze/first-known proof unavailable',
    requiredFeature,
    asOfMs,
    horizons: HORIZON_NAMES,
    caveat:
      'Exploratory fixed-holder join only. Scheduled sample lead is not deterioration-onset lead: a first revert at the scheduled sample is interval-censored after baseline, so event lead remains unproven without earlier brackets. A sampled success does not prove a quiet interval or valid negative control; failure and recovery between samples remain possible. Current-byte SHA equality and local reported clocks do not prove immutable preregistration or first-known time. Missing days are not controls; censored calls are not controls. No predictive alert eligibility.',
    rows,
  }
}
