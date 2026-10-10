import { createHash } from 'node:crypto'

import { DIRECT_MARKETS as PUBLIC_MARKETS } from './carry-public-direct-exit-issue.mjs'
import { DIRECT_MARKETS as COMPOUND_MARKETS } from './carry-local-compound-holder-issue.mjs'

const MARKET_CONFIG = [
  { key: 'sparkLendUsdt', route: PUBLIC_MARKETS.sparkLendUsdt, lane: 'spark_v1' },
  { key: 'compoundV3Usdc', route: COMPOUND_MARKETS.compoundV3Usdc, lane: 'compound_v1' },
]
const SHA = /^[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/i
const BLOCK_HASH = /^0x[0-9a-f]{64}$/i
const amount = /^(0|[1-9][0-9]*)$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const key = (route, destination, asset) =>
  `${route}\0${destination.toLowerCase()}\0${asset.toLowerCase()}`
const requirePanel = (condition, reason) => {
  if (!condition) throw Error(`holder_episode_panel_supplier_${reason}`)
}
const time = (value) => {
  const ms = Date.parse(value)
  requirePanel(Number.isSafeInteger(ms) && new Date(ms).toISOString() === value, 'clock_invalid')
  return ms
}

export function directSupplierBoardSubjects(manifest) {
  const board = new Map()
  for (const config of MARKET_CONFIG) {
    requirePanel(config.route, 'route_missing')
    const matches = manifest.subjects.filter(
      (subject) =>
        key(subject.route_key, subject.destination, subject.asset) ===
        key(config.route.routeKey, config.route.destination, config.route.asset),
    )
    requirePanel(matches.length === 1, 'frozen_subject_missing')
    board.set(config.key, matches[0])
  }
  return board
}

function baselineOf(entry, compound) {
  if (entry.status !== 'measured') return 'unavailable'
  const measurement = entry.measurement
  if (!measurement || !amount.test(measurement.holderCoverageRaw ?? '')) return 'unavailable'
  const covered = BigInt(measurement.holderCoverageRaw) >= BigInt(entry.assetsRaw)
  if (measurement.status === 'success') return covered ? 'simulated_callable' : 'unavailable'
  if (compound && !covered) return 'unavailable'
  // A covered call revert does not establish why the exit failed.
  if (measurement.status === 'evm_revert' && measurement.coveredRevert === true)
    return 'inconclusive'
  return 'inconclusive'
}

function outcomeOf(baseline, score, caseScore, deadlineMs, nowMs) {
  if (baseline === 'unavailable' || baseline === 'inconclusive')
    return { status: 'not_at_risk', reason: `baseline_${baseline}` }
  if (baseline === 'simulated_impaired')
    return { status: 'not_assayed', reason: 'impaired_baseline_unscored_by_design' }
  if (!score)
    return nowMs <= deadlineMs
      ? { status: 'pending', reason: null }
      : { status: 'missing', reason: 'no_verified_score_after_deadline' }
  if (caseScore.status === 'unavailable' && caseScore.reason === 'capture_window_missed')
    return { status: 'censored', reason: 'capture_window_missed' }
  requirePanel(caseScore.status === 'measured', 'score_case_invalid')
  if (caseScore.outcome === 'exit_success') return { status: 'simulated_callable', reason: null }
  if (caseScore.outcome === 'holder_attrition')
    return { status: 'censored', reason: 'holder_attrition' }
  if (caseScore.outcome === 'exit_revert_cause_unknown')
    return { status: 'inconclusive', reason: 'revert_cause_unknown' }
  throw Error('holder_episode_panel_supplier_outcome_invalid')
}

/** Caller supplies verified ledgers; the panel reader performs the sealed replay. */
export function buildDirectSupplierEpisodes({
  manifest,
  sparkIssues = [],
  sparkScores = [],
  compoundIssues = [],
  compoundScores = [],
  featuresBySubject = new Map(),
  issueFlowFeaturesBySha = new Map(),
  selectAsOfFeatures,
  nowMs,
}) {
  const board = directSupplierBoardSubjects(manifest)
  requirePanel(Number.isSafeInteger(nowMs) && nowMs >= 0, 'now_invalid')
  const episodes = []
  for (const config of MARKET_CONFIG) {
    const compound = config.key === 'compoundV3Usdc'
    const issues = (compound ? compoundIssues : sparkIssues).filter(
      (issue) => issue.marketKey === config.key,
    )
    const scores = (compound ? compoundScores : sparkScores).filter(
      (score) => score.marketKey === config.key,
    )
    requirePanel(issues.length <= 2_000 && scores.length <= 10_000, 'ledger_limit')
    const subject = board.get(config.key)
    const subjectKey = key(subject.route_key, subject.destination, subject.asset)
    const issueBySequence = new Map()
    for (const issue of issues) {
      requirePanel(
        Number.isSafeInteger(issue.sequence) &&
          !issueBySequence.has(issue.sequence) &&
          SHA.test(issue.sha256 ?? '') &&
          issue.routeKey === subject.route_key &&
          issue.destination.toLowerCase() === subject.destination.toLowerCase() &&
          issue.originalAsset.toLowerCase() === subject.asset.toLowerCase() &&
          amount.test(issue.baseline?.targetBlock ?? '') &&
          BLOCK_HASH.test(issue.baseline?.targetHash ?? '') &&
          Array.isArray(issue.cases) &&
          issue.cases.length <= 8 &&
          Array.isArray(issue.targets) &&
          issue.targets.length <= 8,
        'issue_identity_invalid',
      )
      issueBySequence.set(issue.sequence, issue)
    }
    const scoreByCell = new Map()
    for (const score of scores) {
      const cell = `${score.issueSequence}:${score.horizonHours}`
      requirePanel(
        !scoreByCell.has(cell) && issueBySequence.has(score.issueSequence),
        'score_orphan_or_duplicate',
      )
      scoreByCell.set(cell, { row: score, scoredAtMs: time(score.scoredAtUtc) })
    }
    const usedScores = new Set()
    for (const issue of issues) {
      const holder = issue.candidate?.holder
      requirePanel(
        holder == null
          ? issue.cases.every((entry) => entry.status !== 'measured')
          : ADDRESS.test(holder),
        'holder_invalid',
      )
      const issuedMs = time(issue.issuedAtUtc)
      const baselineMs = time(issue.baseline.targetBlockAt)
      requirePanel(baselineMs <= issuedMs, 'baseline_clock_invalid')
      if (!holder) continue
      let featureJoin = null
      const labels = new Set()
      const quantities = new Set()
      for (const entry of issue.cases) {
        requirePanel(typeof entry.label === 'string' && !labels.has(entry.label), 'case_duplicate')
        labels.add(entry.label)
        if (entry.assetsRaw == null) {
          requirePanel(entry.status === 'omitted', 'case_omission_invalid')
          continue
        }
        requirePanel(amount.test(entry.assetsRaw) && !quantities.has(entry.assetsRaw), 'q_invalid')
        quantities.add(entry.assetsRaw)
        const baseline = baselineOf(entry, compound)
        const horizons = new Set()
        for (const target of issue.targets) {
          const targetMs = time(target.targetAtUtc)
          const deadlineMs = time(target.captureDeadlineUtc)
          requirePanel(
            Number.isSafeInteger(target.horizonHours) &&
              target.horizonHours > 0 &&
              !horizons.has(target.horizonHours) &&
              targetMs > issuedMs &&
              deadlineMs > targetMs,
            'target_invalid',
          )
          horizons.add(target.horizonHours)
          const cell = `${issue.sequence}:${target.horizonHours}`
          const scoreRecord = scoreByCell.get(cell)
          const score = scoreRecord?.row
          let caseScore = null
          if (score) {
            requirePanel(scoreRecord.scoredAtMs >= targetMs, 'score_clock_invalid')
            requirePanel(
              SHA.test(score.sha256 ?? '') &&
                score.issueSha256 === issue.sha256 &&
                score.routeKey === issue.routeKey &&
                score.destination.toLowerCase() === issue.destination.toLowerCase() &&
                score.originalAsset.toLowerCase() === issue.originalAsset.toLowerCase() &&
                score.holder.toLowerCase() === holder.toLowerCase() &&
                score.targetAtUtc === target.targetAtUtc &&
                score.captureDeadlineUtc === target.captureDeadlineUtc &&
                Array.isArray(score.cases) &&
                score.cases.length === issue.cases.length,
              'score_binding_invalid',
            )
            caseScore = score.cases.find((row) => row.label === entry.label)
            requirePanel(
              caseScore &&
                caseScore.assetsRaw === entry.assetsRaw &&
                score.cases.filter((row) => row.label === entry.label).length === 1,
              'score_case_binding_invalid',
            )
            usedScores.add(cell)
          }
          if (issuedMs > nowMs) continue
          if (featureJoin === null)
            featureJoin = selectAsOfFeatures(
              [
                ...(featuresBySubject.get(subjectKey) ?? []),
                ...(issueFlowFeaturesBySha.get(issue.sha256) ?? []),
              ],
              subject,
              issue,
              issue,
            )
          const visibleScore = scoreRecord?.scoredAtMs <= nowMs ? score : null
          const visibleCaseScore = visibleScore ? caseScore : null
          episodes.push({
            subject: subjectKey,
            stageScope: compound
              ? 'direct_compound_v3_withdraw_eth_call'
              : 'direct_spark_withdraw_eth_call',
            fullRoutePaidProofSha256: null,
            lane: config.lane,
            issueClusterSha256: issue.sha256,
            issueSha256: issue.sha256,
            scoreSha256: visibleScore?.sha256 ?? null,
            holderCommitment: sha(`${issue.destination.toLowerCase()}:${holder.toLowerCase()}`),
            qRaw: entry.assetsRaw,
            qUnit: 'asset_raw',
            qCaseLabel: entry.label,
            plannedHorizonHours: target.horizonHours,
            leadAtIssueMinutes: (targetMs - issuedMs) / 60_000,
            targetClockBasis: compound ? 'issue_plan' : 'baseline_block_timestamp',
            issueAtUtc: issue.issuedAtUtc,
            issueClock: 'local_operator_clock_unwitnessed',
            featureAvailabilityClock: 'local_operator_clock_unwitnessed',
            baselineBlock: issue.baseline.targetBlock,
            baselineBlockHash: issue.baseline.targetHash,
            baselineAtUtc: issue.baseline.targetBlockAt,
            targetAtUtc: target.targetAtUtc,
            deadlineAtUtc: target.captureDeadlineUtc,
            observedAtUtc: visibleScore?.target?.targetBlockAt ?? null,
            labelAvailableAtUtc: visibleScore?.scoredAtUtc ?? null,
            baseline,
            outcome: outcomeOf(baseline, visibleScore, visibleCaseScore, deadlineMs, nowMs),
            rawScoreOutcome: visibleCaseScore?.outcome ?? null,
            ...featureJoin,
            analysisPrimaryForCell: false,
            forecastEligible: false,
          })
          requirePanel(episodes.length <= 20_000, 'row_limit')
        }
      }
    }
    requirePanel(usedScores.size === scoreByCell.size, 'score_unmatched')
  }
  return { board, episodes }
}
