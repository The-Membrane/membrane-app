// Pure projection of the sealed ApyUSD exact-holder/Q initiation ledger.
// An eth_call can initiate a hypothetical receipt, but it neither mints an owned
// receipt nor proves a later apxUSD payout.
import { createHash } from 'node:crypto'

// Frozen V1 reader constants. Keep this module free of the RPC-heavy source imports.
const ROUTE = 'apxUSD → ApyUSD [apxUSD]'
const VAULT = '0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a'
const ASSET = '0x98a878b1cd98131b271883b390f68d2c90674665'
const RECEIPT = '0x9bf51f33955ec70f87c4b5c49441815589043237'
const VAULT_IMPL = '0xfd616567ecc1607f61073951a1e822f7315bb112'
const RECEIPT_IMPL = '0x54f1c7ffe10bc392f08ae9432a7e21a6e86bb982'
const CODE_HASHES = [
  '0x748fde5d195af5984cc16c81df36137e6599c6f50f9f5113d05994c1b90ebad7',
  '0x76f9f10f52a301cd5472850a4ac1f5421c8bb57f126e7bd171bd9d3ae70dc30b',
  '0x7427a665f82e79f9e1e3a5592339de70bffab25517bbad2f7127549874fbf670',
  '0xae89d4b99f8590a5045c314350c7e1a0a7fdd69fd1adeb11aa554d6e2edeb1eb',
]
const ISSUE_STUDY = 'carry_public_apyusd_exit_issue_v1'
const SCORE_STUDY = 'carry_public_apyusd_exit_score_v1'
const HORIZONS = [1, 4, 24, 48, 168]
const HOUR_MS = 3_600_000
const SLOT_MS = 15 * 60_000
const SHA = /^[0-9a-f]{64}$/
const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const AMOUNT = /^(0|[1-9][0-9]*)$/
const MAX_ISSUES = 2_000
const MAX_SCORES = 10_000
const MAX_EPISODES = 60_000
const sha = (value) => createHash('sha256').update(value).digest('hex')
const key = (route, destination, asset) =>
  `${route}\0${destination.toLowerCase()}\0${asset.toLowerCase()}`
const subjectKey = key(ROUTE, VAULT, ASSET)
export const APYUSD_SUBJECT = Object.freeze({ route_key: ROUTE, destination: VAULT, asset: ASSET })
const check = (ok, reason) => {
  if (!ok) throw Error(`holder_episode_panel_apyusd_${reason}`)
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
const headerValid = (header) =>
  AMOUNT.test(header?.number ?? '') &&
  BigInt(header.number) > 0n &&
  HASH.test(header.hash ?? '') &&
  HASH.test(header.parentHash ?? '') &&
  Number.isSafeInteger(header.timestamp) &&
  header.timestamp > 0
const identityValid = (identity) =>
  identity?.vaultImpl === VAULT_IMPL &&
  identity?.receiptImpl === RECEIPT_IMPL &&
  JSON.stringify(identity.codeHashes) === JSON.stringify(CODE_HASHES)
const fixedCases = (maxRaw) => {
  const max = BigInt(maxRaw)
  const values = [10n ** 18n, 10n ** 19n, 10n ** 20n, max / 4n, max / 2n, max]
  const used = new Set()
  return values.map((q) => {
    if (q === 0n || used.has(q.toString())) return null
    used.add(q.toString())
    return q.toString()
  })
}
const assayValid = (caseStatus, primary, secondary) =>
  ['initiation_success', 'evm_revert'].includes(caseStatus) &&
  JSON.stringify(primary) === JSON.stringify(secondary) &&
  primary?.status === caseStatus &&
  (caseStatus === 'evm_revert'
    ? primary.sharesRaw === null && primary.simulatedReceiptId === null
    : AMOUNT.test(primary.sharesRaw ?? '') && AMOUNT.test(primary.simulatedReceiptId ?? ''))

export function apyUsdBoardSubjects(manifest) {
  check(Array.isArray(manifest?.subjects), 'manifest_invalid')
  const matches = manifest.subjects.filter(
    (subject) =>
      subject.route_key === ROUTE &&
      subject.destination?.toLowerCase() === VAULT &&
      subject.asset?.toLowerCase() === ASSET,
  )
  check(matches.length === 1, 'frozen_subject_invalid')
  return new Map([[subjectKey, matches[0]]])
}

function validateIssue(issue, sequence, previousSha256) {
  check(
    issue?.sequence === sequence &&
      issue.previousSha256 === previousSha256 &&
      sealed(issue) &&
      issue.study === ISSUE_STUDY &&
      issue.routeKey === ROUTE &&
      issue.destination === VAULT &&
      issue.originalAsset === ASSET &&
      issue.receipt === RECEIPT &&
      ADDRESS.test(issue.holder ?? '') &&
      AMOUNT.test(issue.holderSharesRaw ?? '') &&
      BigInt(issue.holderSharesRaw) > 0n &&
      AMOUNT.test(issue.maxWithdrawRaw ?? '') &&
      BigInt(issue.maxWithdrawRaw) > 0n &&
      headerValid(issue.baseline) &&
      identityValid(issue.baseline.identity) &&
      typeof issue.baseline.originA === 'string' &&
      typeof issue.baseline.originB === 'string' &&
      issue.baseline.originA !== issue.baseline.originB &&
      issue.finalPayout === 'unmeasured_no_onchain_owned_receipt' &&
      Array.isArray(issue.cases) &&
      issue.cases.length === 6 &&
      Array.isArray(issue.targets) &&
      issue.targets.length === HORIZONS.length &&
      JSON.stringify(issue.horizonsHours) === JSON.stringify(HORIZONS),
    'issue_identity_invalid',
  )
  const issueMs = utcMs(issue.issuedAtUtc)
  const baselineMs = issue.baseline.timestamp * 1_000
  check(
    baselineMs <= issueMs &&
      issueMs - baselineMs <= HOUR_MS &&
      issue.slot === Math.floor(issueMs / SLOT_MS),
    'issue_clock_invalid',
  )
  const expectedQ = fixedCases(issue.maxWithdrawRaw)
  for (const [index, entry] of issue.cases.entries()) {
    check(
      entry?.label === `q${index + 1}` && entry.assetsRaw === expectedQ[index],
      'issue_q_invalid',
    )
    if (entry.assetsRaw === null)
      check(entry.status === 'omitted' && entry.baseline === null, 'issue_omission_invalid')
    else
      check(
        entry.status === 'measured' &&
          entry.baseline?.payout === 'not_delivered_by_initiation' &&
          assayValid(entry.baseline.status, entry.baseline.primary, entry.baseline.secondary),
        'issue_case_invalid',
      )
  }
  for (const [index, plan] of issue.targets.entries()) {
    const horizon = HORIZONS[index]
    check(
      plan?.horizonHours === horizon &&
        utcMs(plan.targetAtUtc) === issueMs + horizon * HOUR_MS &&
        utcMs(plan.captureDeadlineUtc) === issueMs + (horizon + 2) * HOUR_MS,
      'issue_target_invalid',
    )
  }
  return issueMs
}

function validateScore(score, sequence, previousSha256, issuesBySequence) {
  const issue = issuesBySequence.get(score?.issueSequence)
  const plan = issue?.targets.find((entry) => entry.horizonHours === score?.horizonHours)
  check(
    score?.sequence === sequence &&
      score.previousSha256 === previousSha256 &&
      sealed(score) &&
      issue &&
      plan &&
      score.study === SCORE_STUDY &&
      score.issueSha256 === issue.sha256 &&
      score.routeKey === ROUTE &&
      score.destination === VAULT &&
      score.originalAsset === ASSET &&
      score.holder === issue.holder &&
      score.targetAtUtc === plan.targetAtUtc &&
      score.captureDeadlineUtc === plan.captureDeadlineUtc &&
      score.finalPayout === 'unmeasured_no_onchain_owned_receipt' &&
      Array.isArray(score.cases) &&
      score.cases.length === 6,
    'score_binding_invalid',
  )
  const targetMs = utcMs(plan.targetAtUtc)
  const deadlineMs = utcMs(plan.captureDeadlineUtc)
  const scoredMs = utcMs(score.scoredAtUtc)
  check(scoredMs >= targetMs, 'score_clock_invalid')
  if (score.status === 'measured') {
    const target = score.target
    check(
      scoredMs <= deadlineMs &&
        headerValid(target) &&
        BigInt(target.number) > BigInt(issue.baseline.number) &&
        target.timestamp * 1_000 >= targetMs &&
        target.timestamp * 1_000 <= deadlineMs &&
        target.timestamp * 1_000 <= scoredMs &&
        headerValid(target.parent) &&
        BigInt(target.parent.number) + 1n === BigInt(target.number) &&
        target.parent.hash === target.parentHash &&
        target.parent.timestamp * 1_000 < targetMs &&
        identityValid(target.identity) &&
        typeof target.originA === 'string' &&
        typeof target.originB === 'string' &&
        target.originA !== target.originB &&
        score.deadlineWitness === null,
      'score_target_invalid',
    )
  } else {
    check(
      score.status === 'capture_window_missed' &&
        scoredMs > deadlineMs &&
        score.target === null &&
        headerValid(score.deadlineWitness?.primary) &&
        headerValid(score.deadlineWitness?.secondary) &&
        score.deadlineWitness.primary.timestamp * 1_000 > deadlineMs &&
        score.deadlineWitness.secondary.timestamp * 1_000 > deadlineMs &&
        score.deadlineWitness.primary.timestamp * 1_000 <= scoredMs &&
        score.deadlineWitness.secondary.timestamp * 1_000 <= scoredMs,
      'score_censor_invalid',
    )
  }
  for (const [index, entry] of score.cases.entries()) {
    const original = issue.cases[index]
    check(
      entry?.label === original.label && entry.assetsRaw === original.assetsRaw,
      'score_q_binding_invalid',
    )
    if (original.assetsRaw === null)
      check(entry.status === 'omitted' && entry.outcome === null, 'score_omission_invalid')
    else if (score.status === 'capture_window_missed')
      check(
        entry.status === 'unavailable' && entry.outcome === 'censored_capture_window_missed',
        'score_censor_case_invalid',
      )
    else
      check(
        entry.status === 'measured' &&
          entry.payout === 'not_delivered_by_initiation' &&
          assayValid(entry.outcome, entry.primary, entry.secondary),
        'score_case_invalid',
      )
  }
  return { issue, plan, scoredMs }
}

const observedSimulation = (entry) => {
  if (!entry || entry.status !== 'measured') return null
  return entry.outcome === 'initiation_success'
    ? { status: 'simulated_callable', reason: null }
    : { status: 'inconclusive', reason: 'revert_cause_unknown' }
}

function outcomeOf(baseline, score, scoreCase, deadlineMs, nowMs) {
  if (baseline === 'inconclusive')
    return { status: 'not_at_risk', reason: 'baseline_revert_cause_unknown' }
  if (!score)
    return nowMs <= deadlineMs
      ? { status: 'pending', reason: null }
      : { status: 'missing', reason: 'no_verified_score_after_deadline' }
  if (score.status === 'capture_window_missed')
    return { status: 'censored', reason: 'capture_window_missed' }
  return observedSimulation(scoreCase)
}

/** Project only caller-supplied, sealed arrays from verifyApyUsdIssues/Scores. */
export function buildApyUsdEpisodes({
  manifest,
  issues,
  scores,
  featuresBySubject = new Map(),
  selectAsOfFeatures,
  nowMs,
}) {
  const board = apyUsdBoardSubjects(manifest)
  check(
    Array.isArray(issues) &&
      issues.length <= MAX_ISSUES &&
      Array.isArray(scores) &&
      scores.length <= MAX_SCORES &&
      featuresBySubject instanceof Map &&
      typeof selectAsOfFeatures === 'function' &&
      Number.isSafeInteger(nowMs) &&
      nowMs >= 0,
    'inputs_invalid',
  )
  const subject = board.get(subjectKey)
  const diagnostics = new Map([
    [
      subjectKey,
      {
        issues: 0,
        noHolderIssues: 0,
        omittedQCases: 0,
        measuredQCases: 0,
        baselineInitiationSuccessCases: 0,
        baselineCoveredRevertCases: 0,
        scoredTargets: 0,
        measuredTargets: 0,
        missedDeadlineTargets: 0,
      },
    ],
  ])
  const info = diagnostics.get(subjectKey)
  const issuesBySequence = new Map()
  const visibleIssues = new Set()
  const seenHolders = new Set()
  let previousSha256 = null
  for (const [index, issue] of issues.entries()) {
    const issuedMs = validateIssue(issue, index + 1, previousSha256)
    check(!seenHolders.has(issue.holder), 'holder_repeated')
    seenHolders.add(issue.holder)
    previousSha256 = issue.sha256
    issuesBySequence.set(issue.sequence, issue)
    if (issuedMs > nowMs) continue
    visibleIssues.add(issue.sequence)
    info.issues++
    for (const entry of issue.cases) {
      if (entry.assetsRaw === null) info.omittedQCases++
      else {
        info.measuredQCases++
        if (entry.baseline.status === 'initiation_success') info.baselineInitiationSuccessCases++
        else info.baselineCoveredRevertCases++
      }
    }
  }
  const scoresByCell = new Map()
  const visibleScoresByCell = new Map()
  previousSha256 = null
  for (const [index, score] of scores.entries()) {
    const { scoredMs } = validateScore(score, index + 1, previousSha256, issuesBySequence)
    const cell = `${score.issueSequence}:${score.horizonHours}`
    check(!scoresByCell.has(cell), 'score_duplicate')
    scoresByCell.set(cell, score)
    previousSha256 = score.sha256
    if (scoredMs > nowMs || !visibleIssues.has(score.issueSequence)) continue
    visibleScoresByCell.set(cell, score)
    info.scoredTargets++
    if (score.status === 'measured') info.measuredTargets++
    else info.missedDeadlineTargets++
  }
  const episodes = []
  for (const issue of issues) {
    if (!visibleIssues.has(issue.sequence)) continue
    const baselineAtUtc = new Date(issue.baseline.timestamp * 1_000).toISOString()
    const featureJoin = selectAsOfFeatures(
      featuresBySubject.get(subjectKey) ?? [],
      subject,
      issue,
      {
        baseline: {
          targetBlock: issue.baseline.number,
          targetHash: issue.baseline.hash,
          targetBlockAt: baselineAtUtc,
        },
      },
    )
    check(featureJoin && typeof featureJoin === 'object', 'feature_join_invalid')
    for (const entry of issue.cases) {
      if (entry.assetsRaw === null) continue
      const baseline =
        entry.baseline.status === 'initiation_success' ? 'simulated_callable' : 'inconclusive'
      const baselineReason = baseline === 'inconclusive' ? 'revert_cause_unknown' : null
      for (const plan of issue.targets) {
        const score = visibleScoresByCell.get(`${issue.sequence}:${plan.horizonHours}`)
        const scoreCase = score?.cases.find((item) => item.label === entry.label)
        const targetMs = utcMs(plan.targetAtUtc)
        const deadlineMs = utcMs(plan.captureDeadlineUtc)
        episodes.push({
          subject: subjectKey,
          stageScope: 'apyusd_withdraw_initiation_eth_call',
          fullRoutePaidProofSha256: null,
          lane: 'apyusd',
          issueClusterSha256: issue.sha256,
          issueSha256: issue.sha256,
          scoreSha256: score?.sha256 ?? null,
          holderCommitment: sha(`${VAULT}:${issue.holder}`),
          qRaw: entry.assetsRaw,
          qUnit: 'apxUSD_assets',
          qCaseLabel: entry.label,
          plannedHorizonHours: plan.horizonHours,
          leadAtIssueMinutes: (targetMs - utcMs(issue.issuedAtUtc)) / 60_000,
          targetClockBasis: 'issue_clock_plan',
          issueAtUtc: issue.issuedAtUtc,
          issueClock: 'local_operator_clock_unwitnessed',
          featureAvailabilityClock: 'local_operator_clock_unwitnessed',
          baselineBlock: issue.baseline.number,
          baselineBlockHash: issue.baseline.hash,
          baselineAtUtc,
          targetAtUtc: plan.targetAtUtc,
          deadlineAtUtc: plan.captureDeadlineUtc,
          observedAtUtc: score?.target
            ? new Date(score.target.timestamp * 1_000).toISOString()
            : null,
          labelAvailableAtUtc: score?.scoredAtUtc ?? null,
          ...featureJoin,
          baseline,
          baselineReason,
          outcome: outcomeOf(baseline, score, scoreCase, deadlineMs, nowMs),
          observedSimulation: observedSimulation(scoreCase),
          rawBaselineStatus: entry.baseline.status,
          rawScoreStatus: scoreCase?.status ?? null,
          rawScoreOutcome: scoreCase?.outcome ?? null,
          initiationPayout: 'not_delivered_by_initiation',
          finalPayout: 'unmeasured_no_onchain_owned_receipt',
          analysisPrimaryForCell: false,
          forecastEligible: false,
        })
        check(episodes.length <= MAX_EPISODES, 'row_limit')
      }
    }
  }
  return { board, episodes, diagnostics }
}
