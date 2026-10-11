// Offline support accounting for verified prospective holder exit ledgers.
// This reports samples and censoring, never a forecast or a wallet identity.
import { fileURLToPath } from 'node:url'

const subjectKey = (route, destination) => `${route}\0${destination.toLowerCase()}`
const cellKey = (subject, asset, q, horizon) =>
  `${subject}\0${asset.toLowerCase()}\0${q}\0${horizon}`
const asTime = (value) => {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) throw Error('support_time_invalid')
  return time
}

function coverage(manifest) {
  if (!Array.isArray(manifest?.subjects)) throw Error('support_manifest_invalid')
  const subjects = new Map()
  for (const subject of manifest.subjects) {
    const key = subjectKey(subject.route_key, subject.destination)
    if (subjects.has(key)) throw Error('support_manifest_duplicate_subject')
    subjects.set(key, subject)
  }
  if (subjects.size !== 67 || new Set(manifest.subjects.map((x) => x.route_key)).size !== 25)
    throw Error('support_manifest_not_frozen_25_67')
  return subjects
}

function emptyCell(routeKey, destination, asset, assetsRaw, horizonHours) {
  return {
    routeKey,
    destination,
    asset,
    assetsRaw,
    horizonHours,
    issueRecords: 0,
    distinctHolders: 0,
    baselineImpairedDistinctHolders: 0,
    baselineControlDistinctHolders: 0,
    baseline: { impaired: 0, control: 0, unavailable: 0 },
    impaired: {
      recovery: 0,
      still: 0,
      entitlementGap: 0,
      attrition: 0,
      ambiguous: 0,
      ineligible: 0,
      entitlementUnassessed: 0,
      censored: 0,
      pending: 0,
      missing: 0,
      unscoredByDesign: 0,
    },
    control: {
      continued: 0,
      newRevert: 0,
      entitlementGap: 0,
      attrition: 0,
      ambiguous: 0,
      ineligible: 0,
      entitlementUnassessed: 0,
      censored: 0,
      pending: 0,
      missing: 0,
    },
  }
}

function outcomeBucket(lane, score, caseScore = score) {
  if (lane === 'compound') {
    if (caseScore.status === 'unavailable' && caseScore.reason === 'capture_window_missed')
      return 'censored'
    if (caseScore.status !== 'measured') throw Error('support_outcome_unrecognized')
    if (caseScore.outcome === 'holder_attrition') return 'attrition'
    if (caseScore.outcome === 'exit_success') return 'continued'
    if (caseScore.outcome === 'exit_revert_cause_unknown') return 'ambiguous'
    throw Error('support_outcome_unrecognized')
  }
  if (lane === 'sghoFixedQ' || lane === 'aaveFrozenQ' || lane === 'aaveCommonQ') {
    if (score.status === 'censored') return 'censored'
    if (score.status !== 'measured') throw Error('support_outcome_unrecognized')
    if (caseScore.transition === 'holder_attrition') return 'attrition'
    if (caseScore.transition === 'simulated_recovery') return 'recovery'
    if (caseScore.transition === 'still_reverting') return 'still'
    if (caseScore.transition === 'remained_exitable') return 'continued'
    if (caseScore.transition === 'lost_exitability') return 'newRevert'
    throw Error('support_outcome_unrecognized')
  }
  if (lane === 'fluidFtoken') {
    if (score.status === 'capture_window_missed' || score.status === 'identity_changed')
      return 'censored'
    if (score.status !== 'measured') throw Error('support_outcome_unrecognized')
    if (caseScore?.entitlement?.status === 'holder_ineligible') return 'ineligible'
    if (caseScore?.entitlement?.status === 'entitlement_unassessed') return 'entitlementUnassessed'
    if (caseScore?.entitlement?.status !== 'covered') throw Error('support_outcome_unrecognized')
    if (caseScore?.outcome?.status === 'success') return 'continued'
    if (caseScore?.outcome?.status === 'evm_revert') return 'ambiguous'
    throw Error('support_outcome_unrecognized')
  }
  if (['sgho', 'susds', 'stusds', 'usd3'].includes(lane)) {
    if (score.status === 'unavailable' && score.reason === 'capture_window_missed')
      return 'censored'
    if (score.status !== 'measured') throw Error('support_outcome_unrecognized')
    if (score.outcome === 'holder_shares_zero') return 'attrition'
    if (score.outcome === 'simulated_withdraw_success')
      return score.transition === 'simulated_recovery' ? 'recovery' : 'continued'
    if (['withdraw_revert_cause_unknown', 'preview_share_gap'].includes(score.outcome))
      return score.transition === 'still_reverting' ? 'still' : 'newRevert'
    throw Error('support_outcome_unrecognized')
  }
  if (lane === 'morpho') {
    if (score.outcome === 'censored_capture_window_missed') return 'censored'
    if (score.outcome === 'holder_attrition') return 'attrition'
    if (score.outcome === 'preview_gap') return 'entitlementGap'
    if (score.outcome === 'inconclusive_revert') return 'ambiguous'
    if (score.transition === 'simulated_recovery') return 'recovery'
    if (score.transition === 'still_reverting') return 'still'
    if (score.transition === 'simulated_continuity') return 'continued'
    if (score.transition === 'new_revert') return 'newRevert'
  } else {
    if (score.status === 'unavailable' && score.reason === 'capture_window_missed')
      return 'censored'
    if (score.outcome === 'holder_attrition') return 'attrition'
    if (score.outcome === 'exit_success') return 'continued'
    if (score.outcome === 'exit_revert_cause_unknown') return 'ambiguous'
  }
  throw Error('support_outcome_unrecognized')
}

const vaultLanes = new Set(['sgho', 'sghoFixedQ', 'susds', 'stusds', 'usd3'])
const unscoredImpairedLanes = new Set(['direct', 'compound', 'sgho', 'susds'])

function baselineBucket(lane, entry) {
  if (lane === 'aaveCommonQ') {
    if (entry.status !== 'measured') return 'unavailable'
    if (entry.measurement?.baselineStatus === 'success') return 'control'
    if (entry.measurement?.baselineStatus === 'covered_revert') return 'impaired'
    throw Error('support_baseline_unrecognized')
  }
  if (lane === 'aaveFrozenQ') {
    if (entry.baselineStatus === 'success') return 'control'
    if (entry.baselineStatus === 'covered_revert') return 'impaired'
    throw Error('support_baseline_unrecognized')
  }
  if (lane === 'compound') {
    if (entry.status !== 'measured') return 'unavailable'
    const measurement = entry.measurement
    const covered = BigInt(measurement.holderCoverageRaw) >= BigInt(entry.assetsRaw)
    if (measurement.status === 'success') return covered ? 'control' : 'unavailable'
    if (measurement.status === 'evm_revert')
      return covered && measurement.coveredRevert === true ? 'impaired' : 'unavailable'
    throw Error('support_baseline_unrecognized')
  }
  if (lane === 'fluidFtoken') {
    if (entry.baseline?.status === 'success') return 'control'
    if (entry.baseline?.status === 'evm_revert') return 'unavailable'
    throw Error('support_baseline_unrecognized')
  }
  if (vaultLanes.has(lane)) {
    if (lane === 'sghoFixedQ') {
      if (entry.baselineStatus === 'success') return 'control'
      if (entry.baselineStatus === 'covered_revert') return 'impaired'
      throw Error('support_baseline_unrecognized')
    }
    if (entry.status !== 'measured') return 'unavailable'
    if (entry.measurement?.baselineStatus === 'success') return 'control'
    if (entry.measurement?.baselineStatus === 'covered_revert') return 'impaired'
    return 'unavailable'
  }
  if (lane === 'morpho')
    return entry.baselineStatus === 'baseline_revert'
      ? 'impaired'
      : entry.baselineStatus === 'simulated_withdraw_success'
        ? 'control'
        : 'unavailable'
  if (entry.status !== 'measured') return 'unavailable'
  if (
    lane === 'direct' &&
    BigInt(entry.measurement?.holderCoverageRaw ?? 0) < BigInt(entry.assetsRaw)
  )
    return 'unavailable'
  return entry.measurement?.status === 'success'
    ? 'control'
    : entry.measurement?.status === 'evm_revert' && entry.measurement.coveredRevert === true
      ? 'impaired'
      : 'unavailable'
}

/** Inputs must come from the corresponding verified ledger readers. */
export function auditHolderExitSupport({
  manifest,
  morphoIssues,
  morphoScores,
  directIssues,
  directScores,
  aaveFrozenQIssues = [],
  aaveFrozenQScores = [],
  aaveCommonQIssues = [],
  aaveCommonQScores = [],
  aaveCommonQAttempts = [],
  compoundIssues = [],
  compoundScores = [],
  sghoIssues = [],
  sghoScores = [],
  sghoFixedQIssues = [],
  sghoFixedQScores = [],
  susdsIssues = [],
  susdsScores = [],
  stusdsIssues = [],
  stusdsScores = [],
  usd3Issues = [],
  usd3Scores = [],
  fluidFtokenIssues = [],
  fluidFtokenScores = [],
  now = Date.now(),
}) {
  const subjects = coverage(manifest)
  const cells = new Map()
  const ledgers = [
    { lane: 'morpho', issues: morphoIssues, scores: morphoScores },
    { lane: 'direct', issues: directIssues, scores: directScores },
    { lane: 'aaveFrozenQ', issues: aaveFrozenQIssues, scores: aaveFrozenQScores },
    { lane: 'aaveCommonQ', issues: aaveCommonQIssues, scores: aaveCommonQScores },
    { lane: 'compound', issues: compoundIssues, scores: compoundScores },
    { lane: 'sgho', issues: sghoIssues, scores: sghoScores },
    { lane: 'sghoFixedQ', issues: sghoFixedQIssues, scores: sghoFixedQScores },
    { lane: 'susds', issues: susdsIssues, scores: susdsScores },
    { lane: 'stusds', issues: stusdsIssues, scores: stusdsScores },
    { lane: 'usd3', issues: usd3Issues, scores: usd3Scores },
    { lane: 'fluidFtoken', issues: fluidFtokenIssues, scores: fluidFtokenScores },
  ]
  const coveredSubjects = new Set()
  const measuredSubjects = new Set()
  const measuredCells = new Set()
  const holdersByCell = new Map()
  const impairedHoldersByCell = new Map()
  const controlHoldersByCell = new Map()
  let outOfCohortIssues = 0
  const sghoParents = new Map(sghoIssues.map((issue) => [issue.sequence, issue]))
  const supersededV1Cells = new Set()
  const fixedQParents = new Set()
  for (const issue of sghoFixedQIssues) {
    const parent = sghoParents.get(issue.v1IssueSequence)
    if (
      fixedQParents.has(issue.v1IssueSequence) ||
      !parent ||
      parent.sha256 !== issue.v1IssueSha256 ||
      parent.candidate?.holder !== issue.holder ||
      parent.routeKey !== issue.routeKey ||
      parent.destination !== issue.destination ||
      parent.originalAsset !== issue.originalAsset
    )
      throw Error('support_sgho_fixed_q_parent_mismatch')
    fixedQParents.add(issue.v1IssueSequence)
    const matchingCases = parent.cases.filter((entry) => entry.assetsRaw === issue.assetsRaw)
    if (matchingCases.length > 1) throw Error('support_sgho_fixed_q_parent_duplicate_q')
    const matchingCase = matchingCases[0]
    if (
      matchingCase?.status === 'measured' &&
      matchingCase.measurement?.baselineStatus !== issue.baselineStatus
    )
      throw Error('support_sgho_fixed_q_baseline_disagreement')
    if (matchingCase)
      for (const target of issue.targets)
        if (parent.targets.some((entry) => entry.horizonHours === target.horizonHours))
          supersededV1Cells.add(`${parent.sequence}:${issue.assetsRaw}:${target.horizonHours}`)
  }
  const directParents = new Map(directIssues.map((issue) => [issue.sequence, issue]))
  const diagnosticParents = new Set()
  for (const attempt of aaveCommonQAttempts) {
    const parent = directParents.get(attempt.v1IssueSequence)
    if (
      !parent ||
      parent.sha256 !== attempt.v1IssueSha256 ||
      parent.marketKey !== 'aaveV3Usdc' ||
      diagnosticParents.has(parent.sequence) ||
      attempt.observationStatus !== 'operator_observed_unverified' ||
      attempt.verifiedCensor !== false ||
      ![
        'receipt_guard_triggered',
        'issue_record_guard_triggered',
        'baseline_assay_failed',
      ].includes(attempt.observedCondition)
    )
      throw Error('support_aave_common_q_attempt_invalid')
    diagnosticParents.add(parent.sequence)
  }
  const supersededDirectV1Cells = new Set()
  const aaveParents = new Set()
  for (const issue of aaveFrozenQIssues) {
    const parent = directParents.get(issue.v1IssueSequence)
    if (
      aaveParents.has(issue.v1IssueSequence) ||
      !parent ||
      parent.sha256 !== issue.v1IssueSha256 ||
      parent.marketKey !== 'aaveV3Usdc' ||
      parent.candidate?.holder !== issue.holder ||
      parent.routeKey !== issue.routeKey ||
      parent.destination !== issue.destination ||
      parent.originalAsset !== issue.originalAsset
    )
      throw Error('support_aave_frozen_q_parent_mismatch')
    aaveParents.add(issue.v1IssueSequence)
    for (const entry of issue.cases) {
      const matches = parent.cases.filter(
        (row) => row.label === entry.label && row.assetsRaw === entry.assetsRaw,
      )
      if (
        matches.length !== 1 ||
        matches[0].status !== 'measured' ||
        (entry.baselineStatus === 'success' && matches[0].measurement?.status !== 'success') ||
        (entry.baselineStatus === 'covered_revert' &&
          (matches[0].measurement?.status !== 'evm_revert' ||
            matches[0].measurement?.coveredRevert !== true)) ||
        BigInt(matches[0].measurement?.holderCoverageRaw ?? 0) < BigInt(entry.assetsRaw)
      )
        throw Error('support_aave_frozen_q_case_mismatch')
      for (const target of issue.targets)
        if (parent.targets.some((row) => row.horizonHours === target.horizonHours))
          supersededDirectV1Cells.add(
            `${parent.sequence}:${entry.assetsRaw}:${target.horizonHours}`,
          )
    }
  }
  const supersededAaveV2Cells = new Set()
  const commonQParents = new Set()
  for (const issue of aaveCommonQIssues) {
    const parent = directParents.get(issue.v1IssueSequence)
    if (
      commonQParents.has(issue.v1IssueSequence) ||
      !parent ||
      parent.sha256 !== issue.v1IssueSha256 ||
      parent.marketKey !== 'aaveV3Usdc' ||
      parent.routeKey !== issue.routeKey ||
      parent.destination !== issue.destination ||
      parent.originalAsset !== issue.originalAsset
    )
      throw Error('support_aave_common_q_parent_mismatch')
    commonQParents.add(issue.v1IssueSequence)
    const v2 = aaveFrozenQIssues.find((x) => x.v1IssueSequence === issue.v1IssueSequence)
    for (const entry of issue.cases) {
      const baseline = baselineBucket('aaveCommonQ', entry)
      if (
        entry.status === 'inconclusive' &&
        entry.measurement?.baselineStatus !== 'inconclusive_covered_revert'
      )
        throw Error('support_aave_common_q_inconclusive_invalid')
      if (entry.status === 'unavailable') continue
      if (parent.candidate?.holder === issue.holder) {
        const matching = parent.cases.filter((x) => x.assetsRaw === entry.assetsRaw)
        if (matching.length > 1) throw Error('support_aave_common_q_parent_duplicate_q')
        if (matching.length === 1 && matching[0].status === 'measured') {
          const prior = matching[0]
          const covered = BigInt(prior.measurement.holderCoverageRaw) >= BigInt(entry.assetsRaw)
          const priorState = !covered
            ? 'unavailable'
            : prior.measurement.status === 'success'
              ? 'control'
              : prior.measurement.coveredRevert === true
                ? 'impaired'
                : 'inconclusive'
          const state = entry.status === 'inconclusive' ? 'inconclusive' : baseline
          if (priorState !== state)
            throw Error('support_aave_common_q_parent_baseline_disagreement')
          for (const target of issue.targets)
            supersededDirectV1Cells.add(
              `${parent.sequence}:${entry.assetsRaw}:${target.horizonHours}`,
            )
        }
      }
      if (v2?.holder === issue.holder) {
        const matching = v2.cases.filter((x) => x.assetsRaw === entry.assetsRaw)
        if (matching.length > 1) throw Error('support_aave_common_q_v2_duplicate_q')
        if (matching.length === 1) {
          if (
            entry.status === 'inconclusive' ||
            baselineBucket('aaveFrozenQ', matching[0]) !== baseline
          )
            throw Error('support_aave_common_q_v2_baseline_disagreement')
          for (const target of issue.targets)
            supersededAaveV2Cells.add(`${v2.sequence}:${entry.assetsRaw}:${target.horizonHours}`)
        }
      }
    }
  }
  let correlatedSghoV1ObservationsExcluded = 0
  let correlatedAaveV1ObservationsExcluded = 0
  let correlatedAaveV2ObservationsExcluded = 0
  for (const { lane, issues, scores } of ledgers) {
    if (!Array.isArray(issues) || !Array.isArray(scores)) throw Error('support_ledger_invalid')
    const scoresByCase = new Map()
    for (const score of scores) {
      const key =
        lane === 'morpho'
          ? `${score.issueSequence}:${score.horizonHours}:${score.caseLabel}`
          : lane === 'fluidFtoken'
            ? `${score.routeIndex}:${score.issueSequence}:${score.horizonHours}`
            : `${score.issueSequence}:${score.horizonHours}`
      if (scoresByCase.has(key)) throw Error('support_score_duplicate')
      scoresByCase.set(key, score)
    }
    for (const issue of issues) {
      const asset = ['morpho', 'fluidFtoken'].includes(lane) ? issue.asset : issue.originalAsset
      const destination = lane === 'fluidFtoken' ? issue.vault : issue.destination
      const subject = subjectKey(issue.routeKey, destination)
      const frozen = subjects.get(subject)
      if (!frozen || frozen.asset.toLowerCase() !== asset.toLowerCase()) {
        outOfCohortIssues++
        continue
      }
      const holder = ['morpho', 'fluidFtoken', 'sghoFixedQ', 'aaveFrozenQ', 'aaveCommonQ'].includes(
        lane,
      )
        ? issue.holder
        : issue.candidate?.holder
      const seenQ = new Set()
      const cases =
        lane === 'sghoFixedQ'
          ? [
              {
                label: 'fixed_1_gho',
                assetsRaw: issue.assetsRaw,
                baselineStatus: issue.baselineStatus,
              },
            ]
          : issue.cases
      for (const entry of cases) {
        if (entry.assetsRaw === null) continue
        if (seenQ.has(entry.assetsRaw)) throw Error('support_duplicate_q_in_issue')
        seenQ.add(entry.assetsRaw)
        const baseline = baselineBucket(lane, entry)
        if (!holder && baseline !== 'unavailable') throw Error('support_holder_missing')
        for (const target of issue.targets) {
          if (
            lane === 'sgho' &&
            supersededV1Cells.has(`${issue.sequence}:${entry.assetsRaw}:${target.horizonHours}`)
          ) {
            correlatedSghoV1ObservationsExcluded++
            continue
          }
          if (
            lane === 'direct' &&
            supersededDirectV1Cells.has(
              `${issue.sequence}:${entry.assetsRaw}:${target.horizonHours}`,
            )
          ) {
            correlatedAaveV1ObservationsExcluded++
            continue
          }
          if (
            lane === 'aaveFrozenQ' &&
            supersededAaveV2Cells.has(`${issue.sequence}:${entry.assetsRaw}:${target.horizonHours}`)
          ) {
            correlatedAaveV2ObservationsExcluded++
            continue
          }
          const key = cellKey(subject, asset, entry.assetsRaw, target.horizonHours)
          let cell = cells.get(key)
          if (!cell) {
            cell = emptyCell(
              issue.routeKey,
              destination,
              asset,
              entry.assetsRaw,
              target.horizonHours,
            )
            cells.set(key, cell)
            holdersByCell.set(key, new Set())
            impairedHoldersByCell.set(key, new Set())
            controlHoldersByCell.set(key, new Set())
            if (lane === 'fluidFtoken')
              cell.fluid = {
                baselineRevertUnassessed: 0,
                target: {
                  coveredSuccess: 0,
                  coveredRevert: 0,
                  holderIneligible: 0,
                  entitlementUnassessed: 0,
                  identityChanged: 0,
                  captureWindowMissed: 0,
                  pending: 0,
                  missing: 0,
                },
              }
          }
          cell.issueRecords++
          cell.baseline[baseline]++
          if (lane === 'aaveCommonQ') {
            if (!cell.aaveCommonQ) cell.aaveCommonQ = { inconclusiveCoveredBaseline: 0 }
            if (entry.status === 'inconclusive') cell.aaveCommonQ.inconclusiveCoveredBaseline++
          }
          if (lane === 'fluidFtoken' && entry.baseline.status === 'evm_revert')
            cell.fluid.baselineRevertUnassessed++
          if (holder) holdersByCell.get(key).add(holder)
          if (holder && baseline === 'impaired') impairedHoldersByCell.get(key).add(holder)
          if (holder && baseline === 'control') controlHoldersByCell.get(key).add(holder)
          coveredSubjects.add(subject)
          const score = scoresByCase.get(
            lane === 'morpho'
              ? `${issue.sequence}:${target.horizonHours}:${entry.label}`
              : lane === 'fluidFtoken'
                ? `${issue.routeIndex}:${issue.sequence}:${target.horizonHours}`
                : `${issue.sequence}:${target.horizonHours}`,
          )
          const caseScore = ['morpho', 'sghoFixedQ'].includes(lane)
            ? score
            : score?.cases?.find((x) => x.label === entry.label)
          const deadline = lane === 'fluidFtoken' ? target.deadlineUtc : target.captureDeadlineUtc
          if (lane === 'compound') {
            if (!cell.compound)
              cell.compound = {
                baselineInsufficientCoverage: 0,
                target: {
                  success: 0,
                  coveredRevert: 0,
                  holderAttrition: 0,
                  captureWindowMissed: 0,
                  ineligibleBaseline: 0,
                  pending: 0,
                  missing: 0,
                },
              }
            if (
              entry.status === 'measured' &&
              BigInt(entry.measurement.holderCoverageRaw) < BigInt(entry.assetsRaw)
            )
              cell.compound.baselineInsufficientCoverage++
            const eligibleBaseline = baseline === 'control'
            if (score && (caseScore?.status === 'ineligible') === eligibleBaseline)
              throw Error('support_compound_score_eligibility_mismatch')
            const targetBucket = !eligibleBaseline
              ? 'ineligibleBaseline'
              : !score
                ? now <= asTime(deadline)
                  ? 'pending'
                  : 'missing'
                : caseScore?.status === 'unavailable' &&
                    caseScore.reason === 'capture_window_missed'
                  ? 'captureWindowMissed'
                  : caseScore?.status === 'measured'
                    ? caseScore.outcome === 'exit_success'
                      ? 'success'
                      : caseScore.outcome === 'exit_revert_cause_unknown'
                        ? 'coveredRevert'
                        : caseScore.outcome === 'holder_attrition'
                          ? 'holderAttrition'
                          : null
                    : null
            if (!targetBucket) throw Error('support_outcome_unrecognized')
            cell.compound.target[targetBucket]++
          }
          if (lane === 'fluidFtoken') {
            let fluidTarget
            if (!score) fluidTarget = now <= asTime(deadline) ? 'pending' : 'missing'
            else if (score.status === 'capture_window_missed') fluidTarget = 'captureWindowMissed'
            else if (score.status === 'identity_changed') fluidTarget = 'identityChanged'
            else if (score.status === 'measured') {
              if (caseScore?.entitlement?.status === 'holder_ineligible')
                fluidTarget = 'holderIneligible'
              else if (caseScore?.entitlement?.status === 'entitlement_unassessed')
                fluidTarget = 'entitlementUnassessed'
              else if (caseScore?.entitlement?.status === 'covered')
                fluidTarget =
                  caseScore.outcome?.status === 'success'
                    ? 'coveredSuccess'
                    : caseScore.outcome?.status === 'evm_revert'
                      ? 'coveredRevert'
                      : null
            }
            if (!fluidTarget) throw Error('support_outcome_unrecognized')
            cell.fluid.target[fluidTarget]++
          }
          if (baseline === 'unavailable') continue
          measuredSubjects.add(subject)
          measuredCells.add(key)
          const bucket =
            unscoredImpairedLanes.has(lane) && baseline === 'impaired'
              ? 'unscoredByDesign'
              : !(lane === 'fluidFtoken' ? score : caseScore)
                ? now <= asTime(deadline)
                  ? 'pending'
                  : 'missing'
                : outcomeBucket(lane, lane === 'fluidFtoken' ? score : caseScore, caseScore)
          if (!(bucket in cell[baseline])) throw Error('support_outcome_baseline_mismatch')
          cell[baseline][bucket]++
        }
      }
    }
  }
  for (const [key, cell] of cells) {
    cell.distinctHolders = holdersByCell.get(key).size
    cell.baselineImpairedDistinctHolders = impairedHoldersByCell.get(key).size
    cell.baselineControlDistinctHolders = controlHoldersByCell.get(key).size
  }
  const coveredGroups = new Set([...coveredSubjects].map((key) => subjects.get(key).route_key))
  const measuredGroups = new Set([...measuredSubjects].map((key) => subjects.get(key).route_key))
  const groupSubjects = new Map()
  for (const [key, subject] of subjects) {
    if (!groupSubjects.has(subject.route_key))
      groupSubjects.set(subject.route_key, { total: 0, withIssue: 0 })
    const group = groupSubjects.get(subject.route_key)
    group.total++
    if (coveredSubjects.has(key)) group.withIssue++
  }
  return {
    scope: 'verified_prospective_holder_simulation_support_only',
    forecastValidated: false,
    statisticalIndependenceValidated: false,
    denominator: { routeGroups: 25, exactSubjects: 67 },
    support: {
      routeGroupsWithIssueInAuditedLedgers: coveredGroups.size,
      exactSubjectsWithIssueInAuditedLedgers: coveredSubjects.size,
      routeGroupsWithMeasuredBaselineInAuditedLedgers: measuredGroups.size,
      exactSubjectsWithMeasuredBaselineInAuditedLedgers: measuredSubjects.size,
      exactCellsWithMeasuredBaselineInAuditedLedgers: measuredCells.size,
      routeGroupsWithoutIssueInAuditedLedgers: 25 - coveredGroups.size,
      exactSubjectsWithoutIssueInAuditedLedgers: 67 - coveredSubjects.size,
      correlatedSghoV1ObservationsExcluded,
      correlatedAaveV1ObservationsExcluded,
      correlatedAaveV2ObservationsExcluded,
      aaveCommonQUnverifiedDiagnostics: aaveCommonQAttempts.length,
    },
    groups: [...groupSubjects]
      .map(([routeKey, counts]) => ({ routeKey, ...counts }))
      .sort((a, b) => a.routeKey.localeCompare(b.routeKey)),
    outOfCohortIssues,
    cells: [...cells.values()].sort(
      (a, b) =>
        a.routeKey.localeCompare(b.routeKey) ||
        a.destination.localeCompare(b.destination) ||
        a.asset.localeCompare(b.asset) ||
        (BigInt(a.assetsRaw) < BigInt(b.assetsRaw)
          ? -1
          : BigInt(a.assetsRaw) > BigInt(b.assetsRaw)
            ? 1
            : 0) ||
        a.horizonHours - b.horizonHours,
    ),
  }
}

export async function readVerifiedSupportAudit(now = Date.now()) {
  const [
    { buildSubjectManifest },
    morpho,
    directIssue,
    directScore,
    aaveFrozenQIssue,
    aaveFrozenQScore,
    aaveCommonQIssue,
    aaveCommonQScore,
    compoundIssue,
    compoundScore,
    sghoIssue,
    sghoScore,
    sghoFixedQIssue,
    sghoFixedQScore,
    susdsIssue,
    susdsScore,
    stusdsIssue,
    stusdsScore,
    usd3Issue,
    usd3Score,
    fluidFtoken,
  ] = await Promise.all([
    import('../record-carry-cash-issues.mjs'),
    import('./carry-local-morpho-holder-v2.mjs'),
    import('./carry-public-direct-exit-issue.mjs'),
    import('./carry-public-direct-exit-score.mjs'),
    import('./carry-public-aave-usdc-fixed-q-v2-issue.mjs'),
    import('./carry-public-aave-usdc-fixed-q-v2-score.mjs'),
    import('./carry-public-aave-usdc-common-q-v3-issue.mjs'),
    import('./carry-public-aave-usdc-common-q-v3-score.mjs'),
    import('./carry-local-compound-holder-issue.mjs'),
    import('./carry-local-compound-holder-score.mjs'),
    import('./carry-public-sgho-exit-issue.mjs'),
    import('./carry-public-sgho-exit-score.mjs'),
    import('./carry-public-sgho-fixed-q-v2-issue.mjs'),
    import('./carry-public-sgho-fixed-q-v2-score.mjs'),
    import('./carry-public-susds-exit-issue.mjs'),
    import('./carry-public-susds-exit-score.mjs'),
    import('./carry-public-stusds-exit-issue.mjs'),
    import('./carry-public-stusds-exit-score.mjs'),
    import('./carry-public-usd3-exit-issue.mjs'),
    import('./carry-public-usd3-exit-score.mjs'),
    import('./carry-fluid-ftoken-holder.mjs'),
  ])
  const manifest = await buildSubjectManifest()
  const [
    morphoIssues,
    directIssues,
    directScores,
    aaveFrozenQIssues,
    aaveFrozenQScores,
    aaveCommonQIssues,
    aaveCommonQScores,
    aaveCommonQAttempts,
    compoundIssues,
    compoundScores,
    sghoIssues,
    sghoScores,
    sghoFixedQIssues,
    sghoFixedQScores,
    susdsIssues,
    susdsScores,
    stusdsIssues,
    stusdsScores,
    usd3Issues,
    usd3Scores,
    fluidFtokenLedgers,
  ] = await Promise.all([
    morpho.readV2Issues(),
    directIssue.verifyPublicDirectIssues(),
    directScore.verifyPublicDirectScores(),
    aaveFrozenQIssue.verifyAaveFrozenQIssues(),
    aaveFrozenQScore.verifyAaveFrozenQScores(),
    aaveCommonQIssue.verifyAaveCommonIssues(),
    aaveCommonQScore.verifyAaveCommonQScores(),
    aaveCommonQIssue.verifyAaveCommonAttempts(),
    compoundIssue.verifyPublicDirectIssues(),
    compoundScore.verifyPublicDirectScores(),
    sghoIssue.verifySghoIssues(),
    sghoScore.verifySghoScores(),
    sghoFixedQIssue.verifySghoFixedQIssues(),
    sghoFixedQScore.verifySghoFixedQScores(),
    susdsIssue.verifySusdsIssues(),
    susdsScore.verifySusdsScores(),
    stusdsIssue.verifyStusdsIssues(),
    stusdsScore.verifyStusdsScores(),
    usd3Issue.verifyUsd3Issues(),
    usd3Score.verifyUsd3Scores(),
    Promise.all(
      [0, 1, 2].map((routeIndex) => {
        const issues = fluidFtoken.verifyIssues(routeIndex)
        return { issues, scores: fluidFtoken.verifyScores(routeIndex, issues) }
      }),
    ),
  ])
  const morphoScores = await morpho.readV2Scores(morphoIssues)
  return auditHolderExitSupport({
    manifest,
    morphoIssues,
    morphoScores,
    directIssues,
    directScores,
    aaveFrozenQIssues,
    aaveFrozenQScores,
    aaveCommonQIssues,
    aaveCommonQScores,
    aaveCommonQAttempts,
    compoundIssues,
    compoundScores,
    sghoIssues,
    sghoScores,
    sghoFixedQIssues,
    sghoFixedQScores,
    susdsIssues,
    susdsScores,
    stusdsIssues,
    stusdsScores,
    usd3Issues,
    usd3Scores,
    fluidFtokenIssues: fluidFtokenLedgers.flatMap((ledger) => ledger.issues),
    fluidFtokenScores: fluidFtokenLedgers.flatMap((ledger) => ledger.scores),
    now,
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  readVerifiedSupportAudit()
    .then((result) => {
      const totals = result.cells.reduce(
        (acc, cell) => {
          acc.issueRecords += cell.issueRecords
          acc.baselineImpaired += cell.baseline.impaired
          acc.baselineControl += cell.baseline.control
          acc.recovery += cell.impaired.recovery
          acc.still += cell.impaired.still
          acc.censored += cell.impaired.censored + cell.control.censored
          return acc
        },
        {
          issueRecords: 0,
          baselineImpaired: 0,
          baselineControl: 0,
          recovery: 0,
          still: 0,
          censored: 0,
        },
      )
      process.stdout.write(
        `${JSON.stringify({
          ...result,
          cells: undefined,
          exactCells: result.cells.length,
          maxIssueRecordsPerExactCell: Math.max(
            0,
            ...result.cells.map((cell) => cell.issueRecords),
          ),
          exactCellsWith20DistinctImpairedAnd20DistinctControlHolders: result.cells.filter(
            (cell) =>
              cell.baselineImpairedDistinctHolders >= 20 &&
              cell.baselineControlDistinctHolders >= 20,
          ).length,
          countsAcrossExactCellsAndHorizons: totals,
        })}\n`,
      )
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
    })
}
