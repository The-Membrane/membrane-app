// Pure projection of the two verified FluidBridge holder/Q ledgers. Both lanes
// assay a USDC vault withdraw eth_call, never a mined or full-route payout.
import { createHash } from 'node:crypto'

const VAULT = '0x273da948aca9261043fbdb2a857bc255ecc29012'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const HORIZONS = Object.freeze([1, 4, 24, 48, 168])
const HOUR_MS = 3_600_000
const SHA = /^[0-9a-f]{64}$/
const HASH = /^0x[0-9a-f]{64}$/i
const ADDRESS = /^0x[0-9a-f]{40}$/i
const DECIMAL = /^(0|[1-9][0-9]*)$/
const MAX_ISSUES_PER_LANE = 2_000
const MAX_SCORES_PER_LANE = 10_000
const MAX_ATTEMPTS_PER_LANE = 100_000
const MAX_EPISODES = 20_000
const USDT_ISSUE_FAILURE_STAGES = new Set([
  'common_finalized',
  'holder_discovery',
  'holder_primary_logs',
  'holder_secondary_logs',
  'holder_secondary_receipt',
  'holder_log_disagreement',
  'holder_pinned_state',
  'frozen_seed_read',
  'frozen_seed_pinned_state',
  'withdraw_assay',
  'completion_finality',
  'completion_slot',
])

export const FLUID_BRIDGE_SUBJECTS = Object.freeze([
  Object.freeze({
    route_key: 'USDC → FluidBridgeAggregatorProxy [USDC]',
    destination: VAULT,
    asset: USDC,
  }),
  Object.freeze({
    route_key: 'USDT → FluidBridgeAggregatorProxy [USDC]',
    destination: VAULT,
    asset: USDC,
  }),
])

const ROUTES = Object.freeze({
  usdc: Object.freeze({
    subject: FLUID_BRIDGE_SUBJECTS[0],
    study: 'carry_fluid_bridge_usdc_holder_v1',
    stageScope: 'fluid_bridge_usdc_first_leg_eth_call',
    originalAsset: USDC,
    vaultKind: 'fluid_bridge_usdc',
    payoutAssessment: 'first_leg_simulation_only',
  }),
  usdt: Object.freeze({
    subject: FLUID_BRIDGE_SUBJECTS[1],
    study: 'carry_fluid_bridge_usdt_holder_v1',
    stageScope: 'fluid_bridge_usdt_first_leg_eth_call',
    originalAsset: USDT,
    vaultKind: 'fluid_bridge_usdc_first_leg',
    payoutAssessment: 'usdc_first_leg_only_usdt_unassessed',
  }),
})

const sha = (value) => createHash('sha256').update(value).digest('hex')
const key = (route, destination, asset) =>
  `${route}\0${destination.toLowerCase()}\0${asset.toLowerCase()}`
const check = (ok, reason) => {
  if (!ok) throw Error(`holder_episode_panel_fluid_bridge_${reason}`)
}
const utcMs = (value) => {
  const ms = Date.parse(value)
  check(Number.isSafeInteger(ms) && new Date(ms).toISOString() === value, 'clock_invalid')
  return ms
}
const sealed = (row) => {
  if (!row || typeof row !== 'object' || !SHA.test(row.sha256 ?? '')) return false
  const { sha256, ...payload } = row
  return sha(JSON.stringify(payload)) === sha256
}
const raw = (value) => typeof value === 'string' && DECIMAL.test(value)
const positiveRaw = (value) => raw(value) && BigInt(value) > 0n
function qLadder(maxWithdrawRaw) {
  const max = BigInt(maxWithdrawRaw)
  const values = [1n, 10n, 25n, 50n, 100n].map((pct) => (max * pct) / 100n)
  return [...new Set(values.filter((q) => q > 0n).map(String))]
}

function chain(rows, study, kind) {
  let previous = null
  for (const [index, row] of rows.entries()) {
    check(
      row?.study === study &&
        row.kind === kind &&
        row.sequence === index + 1 &&
        row.previousSha256 === previous &&
        sealed(row),
      `${kind}_unsealed_or_unbound`,
    )
    previous = row.sha256
  }
}

function measurementValid(measurement, route, holder, qRaw, blockNumber, blockHash) {
  const status = measurement?.simulation?.status
  return (
    measurement?.routeKey === route.subject.route_key &&
    measurement.blockNumber === blockNumber &&
    measurement.blockHash === blockHash &&
    measurement.assayOwner === holder &&
    measurement.vault?.address === VAULT &&
    measurement.vault.assetAddress === USDC &&
    measurement.vault.assetDecimals === 6 &&
    measurement.vault.kind === route.vaultKind &&
    measurement.request?.assetsRaw === qRaw &&
    measurement.request.assetUnit === 'USDC' &&
    raw(measurement.position?.holderSharesRaw) &&
    raw(measurement.position?.maxWithdrawAssetsRaw) &&
    ['success', 'evm_revert', 'position_insufficient'].includes(status) &&
    (status !== 'success' || positiveRaw(measurement.simulation.sharesBurnedRaw)) &&
    (status !== 'evm_revert' ||
      (measurement.position.holderSharesRaw !== '0' &&
        measurement.simulation.reason === 'unknown_execution_constraint' &&
        ['preview_covered_not_proven', 'inconclusive_preview_gap'].includes(
          measurement.simulation.holderCoverage,
        ))) &&
    (status !== 'position_insufficient' ||
      (measurement.position.holderSharesRaw === '0' &&
        measurement.simulation.reason === 'holder_has_no_shares')) &&
    (route.originalAsset === USDC ||
      (measurement.routeLeg?.checked === 'same_holder_usdc_vault_withdrawal_simulation' &&
        measurement.routeLeg.usdcToUsdtConversion === 'unassessed' &&
        measurement.routeLeg.usdtReceipt === 'unassessed'))
  )
}

function baselineOf(measurement) {
  const status = measurement.simulation.status
  if (status === 'success') return { baseline: 'simulated_callable', reason: null }
  if (status === 'position_insufficient')
    return { baseline: 'unavailable', reason: 'holder_position_insufficient' }
  return {
    baseline: 'inconclusive',
    reason:
      measurement.simulation.holderCoverage === 'inconclusive_preview_gap'
        ? 'holder_coverage_unconfirmed'
        : 'revert_cause_unknown',
  }
}

function outcomeOf(baseline, score, scoreCase, deadlineMs, nowMs) {
  if (baseline.baseline === 'unavailable' || baseline.baseline === 'inconclusive')
    return { status: 'not_at_risk', reason: `baseline_${baseline.reason}` }
  if (!score)
    return nowMs <= deadlineMs
      ? { status: 'pending', reason: null }
      : { status: 'missing', reason: 'no_verified_score_after_deadline' }
  if (score.status === 'missed_window')
    return { status: 'censored', reason: 'capture_window_missed' }
  if (scoreCase.outcome === 'unavailable')
    return { status: 'inconclusive', reason: 'assay_unavailable' }
  const simulation = scoreCase.measurement.simulation
  if (simulation.status === 'position_insufficient')
    return { status: 'censored', reason: 'holder_attrition' }
  if (simulation.status === 'success') return { status: 'simulated_callable', reason: null }
  return {
    status: 'inconclusive',
    reason:
      simulation.holderCoverage === 'inconclusive_preview_gap'
        ? 'holder_coverage_unconfirmed'
        : 'revert_cause_unknown',
  }
}

export function fluidBridgeBoardSubjects(manifest) {
  check(Array.isArray(manifest?.subjects), 'manifest_invalid')
  const board = new Map()
  for (const subject of FLUID_BRIDGE_SUBJECTS) {
    const matches = manifest.subjects.filter(
      (row) =>
        row.route_key === subject.route_key &&
        row.destination?.toLowerCase() === subject.destination &&
        row.asset?.toLowerCase() === subject.asset,
    )
    check(matches.length === 1, 'frozen_subject_invalid')
    board.set(key(subject.route_key, subject.destination, subject.asset), matches[0])
  }
  return board
}

/** Accept only caller-supplied results of both FluidBridge verifyLedgers calls. */
export function buildFluidBridgeEpisodes({
  manifest,
  routeLedgers,
  featuresBySubject = new Map(),
  selectAsOfFeatures,
  nowMs,
}) {
  const board = fluidBridgeBoardSubjects(manifest)
  check(
    Array.isArray(routeLedgers) &&
      routeLedgers.length === 2 &&
      featuresBySubject instanceof Map &&
      typeof selectAsOfFeatures === 'function' &&
      Number.isSafeInteger(nowMs) &&
      nowMs >= 0,
    'inputs_invalid',
  )
  const diagnostics = new Map()
  const episodes = []
  const seenLanes = new Set()
  for (const entry of routeLedgers) {
    const route = ROUTES[entry?.lane]
    check(route && !seenLanes.has(entry.lane), 'lane_invalid_or_duplicate')
    seenLanes.add(entry.lane)
    const { issues, scores, attempts } = entry.ledger ?? {}
    check(
      Array.isArray(issues) &&
        issues.length <= MAX_ISSUES_PER_LANE &&
        Array.isArray(scores) &&
        scores.length <= MAX_SCORES_PER_LANE &&
        Array.isArray(attempts) &&
        attempts.length <= MAX_ATTEMPTS_PER_LANE,
      'ledger_limit',
    )
    chain(issues, route.study, 'issues')
    chain(scores, route.study, 'scores')
    chain(attempts, route.study, 'attempts')
    const subjectKey = key(route.subject.route_key, route.subject.destination, route.subject.asset)
    const subject = board.get(subjectKey)
    const counts = {
      issues: 0,
      attempts: 0,
      noHolderAttempts: 0,
      omittedQCases: 0,
      measuredQCases: 0,
      baselineCallableCases: 0,
      baselineInconclusiveCases: 0,
      baselineUnavailableCases: 0,
      scoredTargets: 0,
      measuredTargets: 0,
      missedWindowTargets: 0,
      pendingTargets: 0,
      missingTargets: 0,
    }
    diagnostics.set(subjectKey, counts)
    for (const attempt of attempts) {
      const attemptMs = utcMs(attempt.atUtc)
      check(
        ['issue', 'score'].includes(attempt.phase) &&
          ['no_holder', 'source_unavailable', 'assay_unavailable'].includes(attempt.reason) &&
          attemptMs > 0 &&
          (entry.lane !== 'usdt' ||
            ((attempt.candidateSource === undefined ||
              (attempt.phase === 'issue' && attempt.candidateSource === 'frozen_seed')) &&
              (attempt.failureStage === undefined ||
                (attempt.phase === 'issue' &&
                  attempt.reason === 'source_unavailable' &&
                  USDT_ISSUE_FAILURE_STAGES.has(attempt.failureStage))))),
        'attempt_invalid',
      )
      if (attemptMs <= nowMs) {
        counts.attempts++
        if (attempt.phase === 'issue' && attempt.reason === 'no_holder') counts.noHolderAttempts++
      }
    }
    const scoresByCell = new Map()
    for (const score of scores) {
      const issue = issues[score.issueSequence - 1]
      const target = issue?.targets?.find((row) => row.horizonHours === score.horizonHours)
      check(
        issue &&
          target &&
          score.issueSha256 === issue.sha256 &&
          (score.routeKey === undefined || score.routeKey === route.subject.route_key) &&
          (score.destination === undefined || score.destination === VAULT) &&
          (score.asset === undefined || score.asset === USDC) &&
          (entry.lane === 'usdt'
            ? score.finalAsset === undefined || score.finalAsset === USDT
            : score.finalAsset === undefined) &&
          score.holder === issue.holder &&
          score.targetAtUtc === target.targetAtUtc &&
          score.deadlineAtUtc === target.deadlineAtUtc &&
          score.payoutAssessment === route.payoutAssessment &&
          JSON.stringify(score.qRaw) === JSON.stringify(issue.qRaw),
        'score_binding_invalid',
      )
      const cell = `${score.issueSequence}:${score.horizonHours}`
      check(!scoresByCell.has(cell), 'score_duplicate')
      scoresByCell.set(cell, score)
    }
    for (const issue of issues) {
      check(
        issue.routeKey === route.subject.route_key &&
          issue.destination === VAULT &&
          issue.asset === USDC &&
          (entry.lane === 'usdt' ? issue.finalAsset === USDT : issue.finalAsset === undefined) &&
          issue.payoutAssessment === route.payoutAssessment &&
          ADDRESS.test(issue.holder ?? '') &&
          issue.candidate?.holder === issue.holder &&
          positiveRaw(issue.candidate?.maxWithdrawRaw) &&
          Array.isArray(issue.qRaw) &&
          issue.qRaw.length > 0 &&
          issue.qRaw.length <= 5 &&
          JSON.stringify(issue.qRaw) === JSON.stringify(qLadder(issue.candidate.maxWithdrawRaw)) &&
          Number.isSafeInteger(issue.baseline?.blockNumber) &&
          issue.baseline.blockNumber > 0 &&
          HASH.test(issue.baseline.blockHash ?? '') &&
          Number.isSafeInteger(issue.baseline.blockTimestamp) &&
          issue.baseline.blockTimestamp > 0 &&
          Array.isArray(issue.baseline.cases) &&
          issue.baseline.cases.length === issue.qRaw.length &&
          Array.isArray(issue.targets) &&
          issue.targets.length === HORIZONS.length,
        'issue_identity_invalid',
      )
      const issueMs = utcMs(issue.issuedAtUtc)
      const baselineMs = issue.baseline.blockTimestamp * 1_000
      check(baselineMs <= issueMs && issueMs - baselineMs <= 2 * HOUR_MS, 'issue_clock_invalid')
      const issueVisible = issueMs <= nowMs
      if (issueVisible) {
        counts.issues++
        counts.omittedQCases += 5 - issue.qRaw.length
      }
      const baselineAtUtc = new Date(baselineMs).toISOString()
      const featureJoin = issueVisible
        ? selectAsOfFeatures(featuresBySubject.get(subjectKey) ?? [], subject, issue, {
            baseline: {
              targetBlock: String(issue.baseline.blockNumber),
              targetHash: issue.baseline.blockHash,
              targetBlockAt: baselineAtUtc,
            },
          })
        : null
      if (issueVisible)
        check(featureJoin && typeof featureJoin === 'object', 'feature_join_invalid')
      for (const [caseIndex, caseRow] of issue.baseline.cases.entries()) {
        const qRaw = issue.qRaw[caseIndex]
        check(
          caseRow?.qRaw === qRaw &&
            measurementValid(
              caseRow.measurement,
              route,
              issue.holder,
              qRaw,
              issue.baseline.blockNumber,
              issue.baseline.blockHash,
            ),
          'baseline_case_invalid',
        )
        if (issueVisible) counts.measuredQCases++
        const baseline = baselineOf(caseRow.measurement)
        if (issueVisible) {
          if (baseline.baseline === 'simulated_callable') counts.baselineCallableCases++
          else if (baseline.baseline === 'inconclusive') counts.baselineInconclusiveCases++
          else counts.baselineUnavailableCases++
        }
        for (const [targetIndex, target] of issue.targets.entries()) {
          const horizon = HORIZONS[targetIndex]
          const targetMs = utcMs(target?.targetAtUtc)
          const deadlineMs = utcMs(target?.deadlineAtUtc)
          check(
            target.horizonHours === horizon &&
              targetMs === issueMs + horizon * HOUR_MS &&
              deadlineMs === targetMs + 2 * HOUR_MS,
            'target_invalid',
          )
          const score = scoresByCell.get(`${issue.sequence}:${horizon}`)
          const scoreCase = score?.status === 'measured' ? score.cases?.[caseIndex] : null
          let scoreVisible = false
          if (score) {
            const scoredMs = utcMs(score.scoredAtUtc)
            check(scoredMs >= targetMs, 'score_clock_invalid')
            scoreVisible = issueVisible && scoredMs <= nowMs
            if (score.status === 'missed_window')
              check(
                scoredMs > deadlineMs &&
                  score.cases === null &&
                  score.block?.timestamp * 1_000 > deadlineMs &&
                  score.block.timestamp * 1_000 <= scoredMs &&
                  Number.isSafeInteger(score.block?.number) &&
                  score.block.number > issue.baseline.blockNumber &&
                  HASH.test(score.block?.hash ?? ''),
                'score_censor_invalid',
              )
            else {
              check(
                score.status === 'measured' &&
                  scoredMs <= deadlineMs &&
                  Array.isArray(score.cases) &&
                  score.cases.length === issue.qRaw.length &&
                  Number.isSafeInteger(score.block?.number) &&
                  score.block.number > issue.baseline.blockNumber &&
                  HASH.test(score.block?.hash ?? '') &&
                  Number.isSafeInteger(score.block.timestamp) &&
                  score.block.timestamp * 1_000 >= targetMs &&
                  score.block.timestamp * 1_000 <= deadlineMs &&
                  score.block.timestamp * 1_000 <= scoredMs &&
                  scoreCase?.qRaw === qRaw &&
                  [
                    'simulated_success',
                    'simulated_revert',
                    'holder_absent',
                    'unavailable',
                  ].includes(scoreCase.outcome) &&
                  (scoreCase.measurement === null
                    ? scoreCase.outcome === 'unavailable'
                    : measurementValid(
                        scoreCase.measurement,
                        route,
                        issue.holder,
                        qRaw,
                        score.block.number,
                        score.block.hash,
                      ) &&
                      (scoreCase.measurement.simulation.status === 'success'
                        ? scoreCase.outcome === 'simulated_success'
                        : scoreCase.measurement.simulation.status === 'position_insufficient'
                          ? ['simulated_revert', 'holder_absent'].includes(scoreCase.outcome)
                          : scoreCase.outcome === 'simulated_revert')),
                'score_case_invalid',
              )
            }
            if (caseIndex === 0 && scoreVisible) {
              counts.scoredTargets++
              if (score.status === 'measured') counts.measuredTargets++
              else counts.missedWindowTargets++
            }
          }
          if (issueVisible && caseIndex === 0 && !scoreVisible) {
            if (nowMs <= deadlineMs) counts.pendingTargets++
            else counts.missingTargets++
          }
          if (!issueVisible) continue
          const visibleScore = scoreVisible ? score : null
          const visibleScoreCase = scoreVisible ? scoreCase : null
          episodes.push({
            subject: subjectKey,
            stageScope: route.stageScope,
            fullRoutePaidProofSha256: null,
            lane: `fluid_bridge_${entry.lane}`,
            issueClusterSha256: issue.sha256,
            issueSha256: issue.sha256,
            scoreSha256: visibleScore?.sha256 ?? null,
            holderCommitment: sha(`${VAULT}:${issue.holder.toLowerCase()}`),
            qRaw,
            qUnit: 'USDC_first_leg_assets',
            qCaseLabel: `q${caseIndex + 1}`,
            originalAsset: route.originalAsset,
            firstLegAsset: USDC,
            firstLegOnly: true,
            conversionStatus: entry.lane === 'usdt' ? 'unassessed' : null,
            finalPayoutStatus: 'unassessed',
            plannedHorizonHours: horizon,
            leadAtIssueMinutes: (targetMs - issueMs) / 60_000,
            targetClockBasis: 'issue_clock_plan',
            issueAtUtc: issue.issuedAtUtc,
            issueClock: 'local_operator_clock_unwitnessed',
            featureAvailabilityClock: 'local_operator_clock_unwitnessed',
            baselineBlock: String(issue.baseline.blockNumber),
            baselineBlockHash: issue.baseline.blockHash,
            baselineAtUtc,
            targetAtUtc: target.targetAtUtc,
            deadlineAtUtc: target.deadlineAtUtc,
            observedAtUtc:
              visibleScore?.status === 'measured'
                ? new Date(visibleScore.block.timestamp * 1_000).toISOString()
                : null,
            labelAvailableAtUtc: visibleScore?.scoredAtUtc ?? null,
            ...featureJoin,
            baseline: baseline.baseline,
            baselineReason: baseline.reason,
            outcome: outcomeOf(baseline, visibleScore, visibleScoreCase, deadlineMs, nowMs),
            rawBaselineStatus: caseRow.measurement.simulation.status,
            rawBaselineHolderCoverage: caseRow.measurement.simulation.holderCoverage ?? null,
            rawScoreStatus: visibleScore?.status ?? null,
            rawScoreOutcome: visibleScoreCase?.outcome ?? null,
            rawScoreSimulationStatus: visibleScoreCase?.measurement?.simulation?.status ?? null,
            analysisPrimaryForCell: false,
            forecastEligible: false,
          })
          check(episodes.length <= MAX_EPISODES, 'row_limit')
        }
      }
    }
  }
  check(seenLanes.size === 2, 'lane_missing')
  return { board, episodes, diagnostics }
}
