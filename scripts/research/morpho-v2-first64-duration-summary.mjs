// Offline description of sampled first64 treated withdrawal outcomes. No RPC or writes.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  N,
  STUDY as OUTCOME_STUDY,
  loadPlan,
  verifySnapshot,
} from './morpho-v2-first64-treated-outcomes.mjs'
import { FACTORY_SHA, MANIFEST_SHA } from './morpho-v2-full-cohort-baseline.mjs'
import { STAGE1_SHA } from './morpho-v2-exit-baseline-pilot.mjs'

export const STUDY = 'morpho-v2-first64-duration-summary-v1'
const HORIZONS = ['plus24h', 'plus7d']
const HORIZON_SECONDS = { plus24h: 86400, plus7d: 604800 }
const baseDir = 'data/research/venue-signals/'
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const assert = (ok, message) => {
  if (!ok) throw new Error(message)
}

function calendar(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10)
}

function ratioStratum(ratio) {
  if (!ratio) return 'unclassified'
  const numerator = BigInt(ratio.numerator) * 10000n
  const denominator = BigInt(ratio.denominator)
  if (denominator <= 0n) return 'unclassified'
  if (numerator <= denominator) return 'at-most-1bp'
  if (numerator <= denominator * 5n) return 'over-1-to-5bp'
  if (numerator <= denominator * 10n) return 'over-5-to-10bp'
  return 'over-10bp'
}

function summariseRow(row, asset) {
  const concurrentEligibleSchedules = row.coInterventionTimes.filter(
    (timestamp) => timestamp === row.executableAt,
  ).length
  const identity = {
    index: row.index,
    proposalIndex: row.proposalIndex,
    vault: row.vault,
    holder: row.holder,
    qAssets: row.qAssets,
    asset: asset ?? row.baseline?.asset ?? null,
    assetEvidence: asset
      ? 'pinned-manifest'
      : row.baseline?.asset
        ? 'verified-baseline'
        : 'unclassified',
    qOverVaultAssets: row.qOverVaultAssets,
    qOverVaultAssetsStratum: ratioStratum(row.qOverVaultAssets),
    anchorBlock: row.anchorBlock,
    anchorCalendarUtc: calendar(row.anchorTimestamp),
    anchorTimestamp: row.anchorTimestamp,
    executableAtTimestamp: row.executableAt,
    otherEligibleScheduledActionTimes: row.coInterventionTimes,
    eligibleScheduledActionCountAtFirstExecutableAt: 1 + concurrentEligibleSchedules,
    otherEligibleScheduledActionCountAfterFirstExecutableAt:
      row.coInterventionTimes.length - concurrentEligibleSchedules,
    singleActionAttribution: {
      status: 'unavailable',
      reason: concurrentEligibleSchedules
        ? 'multiple-actions-eligible-at-first-executable-at-execution-unverified'
        : 'scheduled-action-execution-unverified',
    },
    scheduledTargets: Object.fromEntries(
      HORIZONS.map((horizon) => [horizon, row.executableAt + HORIZON_SECONDS[horizon]]),
    ),
    baselineStatus: row.baselineStatus,
  }
  if (row.baselineStatus !== 'baseline-success')
    return { ...identity, classification: 'baseline-ineligible', episode: null }
  if (!row.baseline)
    return { ...identity, classification: 'pending-baseline', episode: null, samples: [] }

  const start = row.baseline.timestamp
  let lastCleanSuccess = start
  let firstObservedRevert = null
  let comparable = true
  let stopReason = null
  const samples = []
  for (const horizon of HORIZONS) {
    const probe = row.outcomes[horizon]
    let kind
    if (!probe) kind = 'missing'
    else if (probe.status === 'not-finalized') kind = 'not-finalized'
    else if (probe.status === 'success' && probe.call === 'success' && probe.censoring.length === 0)
      kind = 'clean-success'
    else if (
      probe.status === 'evm-revert' &&
      probe.call === 'evm-revert' &&
      probe.censoring.length === 0
    )
      kind = 'clean-simulated-revert'
    else kind = 'ambiguous-censor'
    samples.push({
      horizon,
      kind,
      comparableAtSample: comparable,
      targetTimestamp: row.executableAt + HORIZON_SECONDS[horizon],
      targetElapsedFromExecutableSeconds: HORIZON_SECONDS[horizon],
      timestamp: probe?.timestamp ?? null,
      observedElapsedFromExecutableSeconds: probe?.timestamp
        ? probe.timestamp - row.executableAt
        : null,
      observedElapsedFromPreBlockBaselineSeconds: probe?.timestamp ? probe.timestamp - start : null,
      block: probe?.block ?? null,
      call: probe?.call ?? null,
      censoring: probe?.censoring ?? [],
    })
    if (kind === 'clean-simulated-revert' && comparable) {
      firstObservedRevert = {
        afterCleanSuccessSeconds: lastCleanSuccess - start,
        byObservedRevertSeconds: probe.timestamp - start,
        afterTimestamp: lastCleanSuccess,
        byTimestamp: probe.timestamp,
        afterExecutableSeconds: lastCleanSuccess - row.executableAt,
        byExecutableSeconds: probe.timestamp - row.executableAt,
        horizon,
      }
      comparable = false
      stopReason = 'first-clean-simulated-revert'
    } else if (kind === 'clean-success' && comparable) {
      lastCleanSuccess = probe.timestamp
    } else if (comparable) {
      comparable = false
      stopReason = kind
    }
  }
  const classification = firstObservedRevert
    ? 'first-observed-revert-interval'
    : stopReason === 'missing' || stopReason === 'not-finalized'
      ? 'pending-follow-up'
      : stopReason === 'ambiguous-censor'
        ? 'ambiguous-right-censor'
        : 'observed-success-right-censor'
  return {
    ...identity,
    classification,
    episode: {
      startTimestamp: start,
      startBasis: 'pre-block-baseline',
      executableAtTimestamp: row.executableAt,
      preExecutableGapSeconds: row.executableAt - start,
      lastCleanSuccessTimestamp: lastCleanSuccess,
      observedCleanSuccessSeconds: lastCleanSuccess - start,
      observedCleanSuccessFromExecutableSeconds: lastCleanSuccess - row.executableAt,
      stopReason,
      firstObservedRevert,
    },
    samples,
  }
}

function tally(rows, key) {
  const groups = {}
  for (const row of rows) {
    const id = row[key]
    const group = (groups[id] ??= { rows: 0, eligible: 0, pending: 0, firstObservedRevert: 0 })
    group.rows++
    if (row.baselineStatus === 'baseline-success') group.eligible++
    if (row.classification.startsWith('pending')) group.pending++
    if (row.classification === 'first-observed-revert-interval') group.firstObservedRevert++
  }
  return groups
}

export function summarizeVerified(
  snapshot,
  plan,
  { outcomePhysicalSha256 = null, assetsByIndex = null } = {},
) {
  verifySnapshot(snapshot, plan)
  assert(snapshot.study === OUTCOME_STUDY && snapshot.rows.length === N, 'Wrong outcome cohort')
  if (assetsByIndex) assert(assetsByIndex.length === N, 'Pinned asset roster length changed')
  const rows = snapshot.rows.map((row, i) => {
    const asset = assetsByIndex?.[i] ?? null
    if (asset && row.baseline?.asset)
      assert(asset === row.baseline.asset, `Pinned asset/baseline mismatch at row ${i}`)
    return summariseRow(row, asset)
  })
  const eligible = rows.filter((r) => r.baselineStatus === 'baseline-success')
  assert(eligible.length === 58, 'Frozen eligible denominator changed')
  const counts = {
    frozenRows: rows.length,
    baselineEligible: eligible.length,
    baselineIneligible: rows.length - eligible.length,
    pairsWithConcurrentEligibleScheduledActions: eligible.filter(
      (r) => r.eligibleScheduledActionCountAtFirstExecutableAt > 1,
    ).length,
    pairsWithSingleEligibleScheduledActionAtFirstExecutableAt: eligible.filter(
      (r) => r.eligibleScheduledActionCountAtFirstExecutableAt === 1,
    ).length,
    concurrentEligibleScheduledActionSlots: eligible.reduce(
      (sum, row) => sum + row.eligibleScheduledActionCountAtFirstExecutableAt - 1,
      0,
    ),
    pairsWithLaterEligibleScheduledActions: eligible.filter(
      (r) => r.otherEligibleScheduledActionCountAfterFirstExecutableAt > 0,
    ).length,
    materialityUnclassified: eligible.filter(
      (r) => !r.asset || r.qOverVaultAssetsStratum === 'unclassified',
    ).length,
    scheduledOutcomeSlots: eligible.length * HORIZONS.length,
    missingBaseline: eligible.filter((r) => r.classification === 'pending-baseline').length,
    pendingFollowUp: eligible.filter((r) => r.classification === 'pending-follow-up').length,
    pairsWithPendingSamples: eligible.filter(
      (r) =>
        !r.episode || r.samples.some((s) => s.kind === 'missing' || s.kind === 'not-finalized'),
    ).length,
    firstObservedRevertIntervals: eligible.filter(
      (r) => r.classification === 'first-observed-revert-interval',
    ).length,
    observedSuccessRightCensors: eligible.filter(
      (r) => r.classification === 'observed-success-right-censor',
    ).length,
    ambiguousRightCensors: eligible.filter((r) => r.classification === 'ambiguous-right-censor')
      .length,
    cleanSuccessSamples: eligible
      .flatMap((r) => r.samples)
      .filter((s) => s.kind === 'clean-success').length,
    cleanRevertSamples: eligible
      .flatMap((r) => r.samples)
      .filter((s) => s.kind === 'clean-simulated-revert').length,
    ambiguousSamples: eligible
      .flatMap((r) => r.samples)
      .filter((s) => s.kind === 'ambiguous-censor').length,
    missingSamples: eligible.reduce(
      (count, row) =>
        count +
        (row.episode
          ? row.samples.filter((sample) => sample.kind === 'missing').length
          : HORIZONS.length),
      0,
    ),
    notFinalizedSamples: eligible
      .flatMap((r) => r.samples)
      .filter((s) => s.kind === 'not-finalized').length,
  }
  assert(
    counts.missingBaseline +
      counts.pendingFollowUp +
      counts.firstObservedRevertIntervals +
      counts.observedSuccessRightCensors +
      counts.ambiguousRightCensors ===
      58,
    'Eligible classification partition lost',
  )
  assert(
    counts.cleanSuccessSamples +
      counts.cleanRevertSamples +
      counts.ambiguousSamples +
      counts.missingSamples +
      counts.notFinalizedSamples ===
      counts.scheduledOutcomeSlots,
    'Scheduled outcome slots partition lost',
  )
  const byVault = tally(eligible, 'vault')
  const byHolder = tally(eligible, 'holder')
  const byAnchorCalendarUtc = tally(eligible, 'anchorCalendarUtc')
  const byAsset = tally(eligible, 'asset')
  const byAssetAndRawQ = tally(
    eligible.map((row) => ({
      ...row,
      assetAndRawQ: `${row.asset ?? 'unclassified'}:${row.qAssets}`,
    })),
    'assetAndRawQ',
  )
  const byQOverVaultAssetsStratum = tally(eligible, 'qOverVaultAssetsStratum')
  const byEligibleScheduledActionCountAtFirstExecutableAt = tally(
    eligible.map((row) => ({
      ...row,
      eligibleScheduledActionCountAtFirstExecutableAt: String(
        row.eligibleScheduledActionCountAtFirstExecutableAt,
      ),
    })),
    'eligibleScheduledActionCountAtFirstExecutableAt',
  )
  return {
    study: STUDY,
    sourceStudy: OUTCOME_STUDY,
    sourceStatus: snapshot.status,
    sourcePhysicalSha256: snapshot.sourcePhysicalSha256,
    outcomePhysicalSha256,
    retrospective: true,
    forecast: {
      status: 'unavailable',
      reason: 'retrospective-treated-prevalence-not-prospective-calibration',
    },
    singleActionAttribution: {
      status: 'unavailable',
      reason: 'eligible-schedules-are-not-verified-executions-and-concurrent-eligibility-is-common',
    },
    interpretation:
      'Episodes start at the pre-block baseline. Scheduled +24h/+7d targets start at executableAt, a separate later clock. Concurrent eligible scheduled actions are not verified executions; same-holder withdrawal outcomes remain valid observations but cannot be attributed to one scheduled action. A clean simulated revert bounds a first sampled observed loss only if every prior sample is clean; missing, unresolved, gas, source, route, and holder changes stop comparability. Later raw statuses remain in denominators. No sample proves continuous exit ability, future duration, or a probability.',
    counts,
    dependence: {
      uniqueVaults: Object.keys(byVault).length,
      uniqueHolders: Object.keys(byHolder).length,
      uniqueAnchorCalendarsUtc: Object.keys(byAnchorCalendarUtc).length,
      byVault,
      byHolder,
      byAnchorCalendarUtc,
      byEligibleScheduledActionCountAtFirstExecutableAt,
    },
    materiality: {
      rawQUnits: 'asset base units; not cross-asset normalized',
      byAsset,
      byAssetAndRawQ,
      byQOverVaultAssetsStratum,
    },
    rows,
  }
}

export function readSummary({ treatedPath, manifestPath, factoryPath, stage1Path, out }) {
  const plan = loadPlan({ treatedPath, manifestPath, factoryPath, stage1Path })
  const manifestBytes = readFileSync(manifestPath)
  assert(sha(manifestBytes) === MANIFEST_SHA, 'Pinned manifest physical SHA changed')
  const manifest = JSON.parse(manifestBytes)
  assert(manifest.rows?.length >= N, 'Pinned manifest missing first64 rows')
  const assetsByIndex = plan.map((row, i) => {
    const source = manifest.rows[i]
    assert(
      source.proposalIndex === row.proposalIndex && source.vault === row.vault,
      'Asset source row drift',
    )
    return source.asset
  })
  const bytes = readFileSync(out)
  const snapshot = JSON.parse(bytes)
  return summarizeVerified(snapshot, plan, { outcomePhysicalSha256: sha(bytes), assetsByIndex })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {}
  for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i]
    assert(
      ['--treated', '--manifest', '--factory', '--stage1', '--out'].includes(key),
      'Unknown option',
    )
    assert(process.argv[i + 1] && !process.argv[i + 1].startsWith('--'), 'Missing option value')
    options[key.slice(2)] = process.argv[++i]
  }
  const summary = readSummary({
    treatedPath: resolve(options.treated || `${baseDir}morpho-v2-signer-baseline-v2.json`),
    manifestPath: resolve(options.manifest || `${baseDir}morpho-v2-full-cohort-manifest.json`),
    factoryPath: resolve(options.factory || `${baseDir}${FACTORY_SHA}.json`),
    stage1Path: resolve(options.stage1 || `${baseDir}${STAGE1_SHA}.json`),
    out: resolve(options.out || `${baseDir}morpho-v2-first64-treated-outcomes-v1.json`),
  })
  process.stdout.write(`${JSON.stringify(summary)}\n`)
}
