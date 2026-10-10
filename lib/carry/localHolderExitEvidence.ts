/** Public, aggregate evidence counts. No holder or raw proof leaves this module. */
import { STAKED_USDAT_ROUTE, STAKED_USDAT_VAULT } from '@/lib/carry/stakedUsdatExit'
import { UMBRELLA_GHO_ROUTE, UMBRELLA_STKGHO } from '@/lib/carry/umbrellaGhoExit'

export type HolderEvidenceIssue = {
  sequence: number
  sha256: string
  routeKey: string
  destination: string
  originalAsset: string
  baseline: { assetDecimals: number }
  issuedAtUtc: string
  horizonsHours: number[]
  targets: { horizonHours: number; targetAtUtc: string; captureDeadlineUtc: string }[]
  cases: {
    label: string
    assetsRaw: string | null
    status: string
    measurement?: { baselineStatus?: string; status?: string; holderCoverageRaw?: string } | null
  }[]
}

export type HolderEvidenceScore = {
  issueSequence: number
  issueSha256: string
  routeKey: string
  destination: string
  horizonHours: number
  targetAtUtc: string
  onTime: boolean
  cases: ({
    label: string
    status: string
    outcome?: string | null
    reason?: string | null
    onTime?: boolean
    transition?: string
  } | null)[]
}

export type HolderEvidenceStudy = {
  issues: HolderEvidenceIssue[]
  scores: HolderEvidenceScore[]
}

export type HolderEvidenceCell = {
  qLabel: string
  qLabels: string[]
  assetsRaw: string | null
  assetDecimals: number
  horizonHours: number
  issued: number
  baselineEligible: number
  baselineIneligible: number
  baselineImpaired: number
  baselineUnavailable: number
  omitted: number
  onTimeMeasured: number
  onTimeMeasuredSuccess: number
  onTimeMeasuredNonSuccess: number
  onTimeUnknownRevert: number
  onTimeHolderAttrition: number
  onTimePreviewGap: number
  onTimeInconclusiveRevert: number
  impairedOnTimeMeasured: number
  impairedSimulatedRecovery: number
  impairedStillReverting: number
  impairedHolderAttrition: number
  impairedInconclusiveRevert: number
  impairedOutcomeUnavailable: number
  impairedOutcomeMissing: number
  impairedOutcomePending: number
  outcomeUnavailable: number
  outcomeMissing: number
  outcomePending: number
  distinctIssueEpisodes: number
  firstIssuedAtUtc: string
  lastIssuedAtUtc: string
  firstTargetAtUtc: string
  lastTargetAtUtc: string
  firstCaptureDeadlineUtc: string
  lastCaptureDeadlineUtc: string
  /** Frozen observation target, not the first instant recovery became possible. */
  firstImpairedRecoveryTargetAtUtc: string | null
  lastImpairedRecoveryTargetAtUtc: string | null
}

const PUBLIC_COUNT_KEYS = [
  'issued',
  'baselineEligible',
  'baselineIneligible',
  'baselineImpaired',
  'baselineUnavailable',
  'omitted',
  'onTimeMeasured',
  'onTimeMeasuredSuccess',
  'onTimeMeasuredNonSuccess',
  'onTimeUnknownRevert',
  'onTimeHolderAttrition',
  'onTimePreviewGap',
  'onTimeInconclusiveRevert',
  'impairedOnTimeMeasured',
  'impairedSimulatedRecovery',
  'impairedStillReverting',
  'impairedHolderAttrition',
  'impairedInconclusiveRevert',
  'impairedOutcomeUnavailable',
  'impairedOutcomeMissing',
  'impairedOutcomePending',
  'outcomeUnavailable',
  'outcomeMissing',
  'outcomePending',
] as const satisfies readonly (keyof HolderEvidenceCell)[]

export type PublicHolderEvidenceCell = {
  horizonHours: number
  distinctIssueEpisodes: number
} & Pick<HolderEvidenceCell, (typeof PUBLIC_COUNT_KEYS)[number]>

type ApyUsdInitiationIssue = {
  sequence: number
  sha256: string
  routeKey: string
  destination: string
  cases: { assetsRaw: string | null; baseline: { status: string } | null }[]
  targets: { horizonHours: number; captureDeadlineUtc: string }[]
}

type ApyUsdInitiationScore = {
  issueSequence: number
  issueSha256: string
  horizonHours: number
  status: 'measured' | 'capture_window_missed'
  cases: { status: string; outcome: string | null }[]
}

/** Receipt initiation is a separate outcome from apxUSD claim delivery. */
export function aggregateApyUsdInitiationEvidence(
  routeKey: string,
  destination: string,
  issues: ApyUsdInitiationIssue[],
  scores: ApyUsdInitiationScore[],
  now = Date.now(),
) {
  const cells = new Map<
    number,
    {
      horizonHours: number
      distinctIssueEpisodes: number
      issued: number
      baselineCallable: number
      baselineReverted: number
      initiationMeasured: number
      initiationSuccess: number
      initiationReverted: number
      outcomeMissing: number
      outcomePending: number
      outcomeCensored: number
    }
  >()
  const scoreByKey = new Map<string, ApyUsdInitiationScore>()
  for (const score of scores) {
    const issue = issues[score.issueSequence - 1]
    if (
      !issue ||
      issue.sha256 !== score.issueSha256 ||
      !issue.targets.some((target) => target.horizonHours === score.horizonHours) ||
      score.cases.length !== issue.cases.length
    )
      throw Error('apyusd_public_score_binding_invalid')
    const key = `${score.issueSequence}:${score.horizonHours}`
    if (scoreByKey.has(key)) throw Error('apyusd_public_score_duplicate')
    scoreByKey.set(key, score)
  }
  for (const issue of issues) {
    if (issue.routeKey !== routeKey || issue.destination !== destination) continue
    for (const target of issue.targets) {
      let cell = cells.get(target.horizonHours)
      if (!cell) {
        cell = {
          horizonHours: target.horizonHours,
          distinctIssueEpisodes: 0,
          issued: 0,
          baselineCallable: 0,
          baselineReverted: 0,
          initiationMeasured: 0,
          initiationSuccess: 0,
          initiationReverted: 0,
          outcomeMissing: 0,
          outcomePending: 0,
          outcomeCensored: 0,
        }
        cells.set(target.horizonHours, cell)
      }
      cell.distinctIssueEpisodes++
      const score = scoreByKey.get(`${issue.sequence}:${target.horizonHours}`)
      for (const [index, entry] of issue.cases.entries()) {
        if (entry.assetsRaw === null) continue
        cell.issued++
        if (entry.baseline?.status === 'initiation_success') cell.baselineCallable++
        else if (entry.baseline?.status === 'evm_revert') cell.baselineReverted++
        else throw Error('apyusd_public_baseline_invalid')
        const outcome = score?.cases[index]
        if (!outcome) {
          if (now > Date.parse(target.captureDeadlineUtc)) cell.outcomeMissing++
          else cell.outcomePending++
        } else if (score.status === 'capture_window_missed') {
          if (outcome.outcome !== 'censored_capture_window_missed')
            throw Error('apyusd_public_censor_invalid')
          cell.outcomeCensored++
        } else if (score.status === 'measured') {
          cell.initiationMeasured++
          if (outcome.outcome === 'initiation_success') cell.initiationSuccess++
          else if (outcome.outcome === 'evm_revert') cell.initiationReverted++
          else throw Error('apyusd_public_outcome_invalid')
        }
      }
    }
  }
  return [...cells.values()].sort((a, b) => a.horizonHours - b.horizonHours)
}

type QueueRequestIssue = {
  sequence: number
  sha256: string
  routeKey: string
  destination: string
  measurement: { outcome: 'success' | 'evm_revert' }
  targets: { horizonHours: number; deadlineUtc: string }[]
}

type QueueRequestScore = {
  issueSequence: number
  issueSha256: string
  horizonHours: number
  status: 'measured' | 'missed_deadline'
  transition: string
}

export type PublicQueueRequestEvidenceCell = {
  horizonHours: number
  issued: number
  baselineCallable: number
  baselineReverted: number
  onTimeStateScored: number
  requestCallMeasured: number
  stillCallable: number
  becameReverting: number
  simulatedCallRecovery: number
  stillReverting: number
  holderAttrition: number
  requestUnavailable: number
  regimeChangeCensored: number
  missed: number
  pending: number
}

type UmbrellaIssue = {
  sequence: number
  sha256: string
  routeKey: string
  destination: string
  holder: string
  measurement: { gate: string; outcome: 'success' | 'evm_revert' }
  targets: { horizonHours: number; deadlineUtc: string }[]
}

type UmbrellaScore = {
  issueSequence: number
  issueSha256: string
  horizonHours: number
  status: 'measured' | 'missed_deadline'
  transition: string
  measurement: { gate: string; outcome: string } | null
}

export type PublicUmbrellaRedeemEvidenceCell = {
  horizonHours: number
  issued: number
  distinctHolders: number
  baselineWaiting: number
  baselineWindowOpen: number
  baselineReverted: number
  baselineCallable: number
  stateScored: number
  redeemCallMeasured: number
  windowOpen: number
  waiting: number
  windowExpired: number
  paused: number
  stillCallable: number
  becameReverting: number
  simulatedCallRecovery: number
  stillReverting: number
  holderAttrition: number
  regimeChangeCensored: number
  missed: number
  pending: number
}

/** Exact private holders and target clocks collapse into route/horizon counts. */
export function aggregateUmbrellaRedeemEvidence(
  routeKey: string,
  destination: string,
  issues: UmbrellaIssue[],
  scores: UmbrellaScore[],
  now = Date.now(),
): PublicUmbrellaRedeemEvidenceCell[] {
  if (!routeKey || !ADDRESS.test(destination) || !Number.isFinite(now))
    throw Error('invalid_umbrella_redeem_evidence_query')
  const scoreByTarget = new Map<string, UmbrellaScore>()
  for (const score of scores) {
    const issue = issues[score.issueSequence - 1]
    const key = `${score.issueSequence}:${score.horizonHours}`
    if (
      !issue ||
      score.issueSha256 !== issue.sha256 ||
      !issue.targets.some((target) => target.horizonHours === score.horizonHours) ||
      scoreByTarget.has(key)
    )
      throw Error('umbrella_redeem_score_issue_mismatch')
    scoreByTarget.set(key, score)
  }
  const cells = new Map<number, PublicUmbrellaRedeemEvidenceCell>()
  const holders = new Map<number, Set<string>>()
  for (const issue of issues) {
    if (issue.routeKey !== routeKey || issue.destination !== destination) continue
    if (!ADDRESS.test(issue.holder)) throw Error('umbrella_redeem_holder_invalid')
    for (const target of issue.targets) {
      let cell = cells.get(target.horizonHours)
      if (!cell) {
        cell = {
          horizonHours: target.horizonHours,
          issued: 0,
          distinctHolders: 0,
          baselineWaiting: 0,
          baselineWindowOpen: 0,
          baselineReverted: 0,
          baselineCallable: 0,
          stateScored: 0,
          redeemCallMeasured: 0,
          windowOpen: 0,
          waiting: 0,
          windowExpired: 0,
          paused: 0,
          stillCallable: 0,
          becameReverting: 0,
          simulatedCallRecovery: 0,
          stillReverting: 0,
          holderAttrition: 0,
          regimeChangeCensored: 0,
          missed: 0,
          pending: 0,
        }
        cells.set(target.horizonHours, cell)
      }
      cell.issued++
      if (!holders.has(target.horizonHours)) holders.set(target.horizonHours, new Set())
      holders.get(target.horizonHours)!.add(issue.holder.toLowerCase())
      if (issue.measurement.gate === 'waiting') cell.baselineWaiting++
      if (issue.measurement.gate === 'window_open') cell.baselineWindowOpen++
      if (issue.measurement.outcome === 'evm_revert') cell.baselineReverted++
      else if (issue.measurement.outcome === 'success') cell.baselineCallable++
      else throw Error('umbrella_redeem_baseline_invalid')
      const score = scoreByTarget.get(`${issue.sequence}:${target.horizonHours}`)
      if (!score) {
        cell.pending++
        continue
      }
      if (score.status === 'missed_deadline') {
        if (score.transition !== 'missing') throw Error('umbrella_redeem_transition_invalid')
        cell.missed++
        continue
      }
      if (score.status !== 'measured' || !score.measurement)
        throw Error('umbrella_redeem_score_invalid')
      cell.stateScored++
      const gateKey = {
        window_open: 'windowOpen',
        waiting: 'waiting',
        window_expired: 'windowExpired',
        paused: 'paused',
      }[score.measurement.gate] as keyof PublicUmbrellaRedeemEvidenceCell | undefined
      if (gateKey) cell[gateKey]++
      const transitionKey = {
        still_callable: 'stillCallable',
        became_reverting: 'becameReverting',
        simulated_call_recovery: 'simulatedCallRecovery',
        still_reverting: 'stillReverting',
        holder_attrition: 'holderAttrition',
        regime_change_censored: 'regimeChangeCensored',
      }[score.transition] as keyof PublicUmbrellaRedeemEvidenceCell | undefined
      if (!transitionKey && score.transition !== 'unassessed')
        throw Error('umbrella_redeem_transition_invalid')
      if (transitionKey) cell[transitionKey]++
      if (
        [
          'still_callable',
          'became_reverting',
          'simulated_call_recovery',
          'still_reverting',
        ].includes(score.transition)
      )
        cell.redeemCallMeasured++
    }
  }
  for (const [horizon, cell] of cells) cell.distinctHolders = holders.get(horizon)!.size
  return [...cells.values()].sort((a, b) => a.horizonHours - b.horizonHours)
}

/** Only queue request eth_call transitions; none of these counts means a paid withdrawal. */
export function aggregateStakedUsdatQueueRequestEvidence(
  routeKey: string,
  destination: string,
  issues: QueueRequestIssue[],
  scores: QueueRequestScore[],
  now = Date.now(),
): PublicQueueRequestEvidenceCell[] {
  if (!routeKey || !ADDRESS.test(destination) || !Number.isFinite(now))
    throw Error('invalid_queue_request_evidence_query')
  const byHorizon = new Map<number, PublicQueueRequestEvidenceCell>()
  const scoreByTarget = new Map<string, QueueRequestScore>()
  for (const score of scores) {
    const issue = issues[score.issueSequence - 1]
    const key = `${score.issueSequence}:${score.horizonHours}`
    if (
      !issue ||
      score.issueSha256 !== issue.sha256 ||
      !issue.targets.some((target) => target.horizonHours === score.horizonHours) ||
      scoreByTarget.has(key)
    )
      throw Error('queue_request_score_issue_mismatch')
    scoreByTarget.set(key, score)
  }
  for (const issue of issues) {
    if (issue.routeKey !== routeKey || issue.destination !== destination) continue
    for (const target of issue.targets) {
      let cell = byHorizon.get(target.horizonHours)
      if (!cell) {
        cell = {
          horizonHours: target.horizonHours,
          issued: 0,
          baselineCallable: 0,
          baselineReverted: 0,
          onTimeStateScored: 0,
          requestCallMeasured: 0,
          stillCallable: 0,
          becameReverting: 0,
          simulatedCallRecovery: 0,
          stillReverting: 0,
          holderAttrition: 0,
          requestUnavailable: 0,
          regimeChangeCensored: 0,
          missed: 0,
          pending: 0,
        }
        byHorizon.set(target.horizonHours, cell)
      }
      cell.issued++
      if (issue.measurement.outcome === 'success') cell.baselineCallable++
      else if (issue.measurement.outcome === 'evm_revert') cell.baselineReverted++
      else throw Error('queue_request_baseline_invalid')
      const score = scoreByTarget.get(`${issue.sequence}:${target.horizonHours}`)
      if (!score) {
        if (now > Date.parse(target.deadlineUtc)) cell.missed++
        else cell.pending++
        continue
      }
      if (score.status === 'missed_deadline') {
        if (score.transition !== 'missing') throw Error('queue_request_transition_invalid')
        cell.missed++
        continue
      }
      if (score.status !== 'measured') throw Error('queue_request_score_invalid')
      const key = {
        still_callable: 'stillCallable',
        became_reverting: 'becameReverting',
        simulated_call_recovery: 'simulatedCallRecovery',
        still_reverting: 'stillReverting',
        holder_attrition: 'holderAttrition',
        request_unavailable: 'requestUnavailable',
        regime_change_censored: 'regimeChangeCensored',
      }[score.transition] as keyof PublicQueueRequestEvidenceCell | undefined
      if (!key) throw Error('queue_request_transition_invalid')
      cell[key]++
      cell.onTimeStateScored++
      if (
        [
          'still_callable',
          'became_reverting',
          'simulated_call_recovery',
          'still_reverting',
        ].includes(score.transition)
      )
        cell.requestCallMeasured++
    }
  }
  return [...byHorizon.values()].sort((a, b) => a.horizonHours - b.horizonHours)
}

const ADDRESS = /^0x[0-9a-f]{40}$/

export function aggregateHolderExitEvidence(
  routeKey: string,
  destination: string,
  studies: HolderEvidenceStudy[],
  now = Date.now(),
): HolderEvidenceCell[] {
  if (!routeKey || !ADDRESS.test(destination) || !Number.isFinite(now))
    throw Error('invalid_holder_evidence_query')
  const prospectiveSyncVault =
    routeKey === 'USDC → USD3 [USDC]' || routeKey === 'USDS → StUsds [USDS]'
  const cells = new Map<string, HolderEvidenceCell>()
  const episodes = new Map<string, Set<string>>()

  for (const [studyIndex, study] of studies.entries()) {
    // The source verifiers validate each full numbered hash chain and score-to-issue
    // binding. Keep a second boundary check so injected or changed readers fail shut.
    const scoreByIssueAndHorizon = new Map<string, HolderEvidenceScore>()
    for (const score of study.scores) {
      const issue = study.issues[score.issueSequence - 1]
      const target = issue?.targets.find((row) => row.horizonHours === score.horizonHours)
      if (
        !issue ||
        score.issueSha256 !== issue.sha256 ||
        score.routeKey !== issue.routeKey ||
        score.destination !== issue.destination ||
        !target ||
        score.targetAtUtc !== target.targetAtUtc ||
        score.cases.length !== issue.cases.length ||
        score.cases.some((row, index) => row && row.label !== issue.cases[index].label)
      )
        throw Error('holder_evidence_score_issue_mismatch')
      const scoreKey = `${score.issueSequence}:${score.horizonHours}`
      if (scoreByIssueAndHorizon.has(scoreKey)) throw Error('holder_evidence_duplicate_score')
      scoreByIssueAndHorizon.set(scoreKey, score)
    }
    for (const issue of study.issues) {
      if (issue.routeKey !== routeKey || issue.destination !== destination) continue
      if (
        !Array.isArray(issue.horizonsHours) ||
        issue.targets.length !== issue.horizonsHours.length ||
        !ADDRESS.test(issue.originalAsset) ||
        !Number.isInteger(issue.baseline?.assetDecimals) ||
        issue.baseline.assetDecimals < 0 ||
        issue.baseline.assetDecimals > 36 ||
        !Number.isFinite(Date.parse(issue.issuedAtUtc))
      )
        throw Error('holder_evidence_issue_invalid')
      for (const horizonHours of issue.horizonsHours) {
        const target = issue.targets.find((row) => row.horizonHours === horizonHours)
        if (
          !target ||
          !Number.isFinite(Date.parse(target.targetAtUtc)) ||
          !Number.isFinite(Date.parse(target.captureDeadlineUtc))
        )
          throw Error('holder_evidence_target_invalid')
        const score = scoreByIssueAndHorizon.get(`${issue.sequence}:${horizonHours}`)
        for (const [index, baseline] of issue.cases.entries()) {
          const key = `${issue.originalAsset}\u0000${issue.baseline.assetDecimals}\u0000${baseline.assetsRaw ?? `omitted:${baseline.label}`}\u0000${horizonHours}`
          let cell = cells.get(key)
          if (!cell) {
            cell = {
              qLabel: baseline.label,
              qLabels: [baseline.label],
              assetsRaw: baseline.assetsRaw,
              assetDecimals: issue.baseline.assetDecimals,
              horizonHours,
              issued: 0,
              baselineEligible: 0,
              baselineIneligible: 0,
              baselineImpaired: 0,
              baselineUnavailable: 0,
              omitted: 0,
              onTimeMeasured: 0,
              onTimeMeasuredSuccess: 0,
              onTimeMeasuredNonSuccess: 0,
              onTimeUnknownRevert: 0,
              onTimeHolderAttrition: 0,
              onTimePreviewGap: 0,
              onTimeInconclusiveRevert: 0,
              impairedOnTimeMeasured: 0,
              impairedSimulatedRecovery: 0,
              impairedStillReverting: 0,
              impairedHolderAttrition: 0,
              impairedInconclusiveRevert: 0,
              impairedOutcomeUnavailable: 0,
              impairedOutcomeMissing: 0,
              impairedOutcomePending: 0,
              outcomeUnavailable: 0,
              outcomeMissing: 0,
              outcomePending: 0,
              distinctIssueEpisodes: 0,
              firstIssuedAtUtc: issue.issuedAtUtc,
              lastIssuedAtUtc: issue.issuedAtUtc,
              firstTargetAtUtc: target.targetAtUtc,
              lastTargetAtUtc: target.targetAtUtc,
              firstCaptureDeadlineUtc: target.captureDeadlineUtc,
              lastCaptureDeadlineUtc: target.captureDeadlineUtc,
              firstImpairedRecoveryTargetAtUtc: null,
              lastImpairedRecoveryTargetAtUtc: null,
            }
            cells.set(key, cell)
            episodes.set(key, new Set())
          }
          if (!cell.qLabels.includes(baseline.label)) cell.qLabels.push(baseline.label)
          episodes.get(key)!.add(`${studyIndex}:${issue.sequence}`)
          if (issue.issuedAtUtc < cell.firstIssuedAtUtc) cell.firstIssuedAtUtc = issue.issuedAtUtc
          if (issue.issuedAtUtc > cell.lastIssuedAtUtc) cell.lastIssuedAtUtc = issue.issuedAtUtc
          if (target.targetAtUtc < cell.firstTargetAtUtc) cell.firstTargetAtUtc = target.targetAtUtc
          if (target.targetAtUtc > cell.lastTargetAtUtc) cell.lastTargetAtUtc = target.targetAtUtc
          if (target.captureDeadlineUtc < cell.firstCaptureDeadlineUtc)
            cell.firstCaptureDeadlineUtc = target.captureDeadlineUtc
          if (target.captureDeadlineUtc > cell.lastCaptureDeadlineUtc)
            cell.lastCaptureDeadlineUtc = target.captureDeadlineUtc
          if (baseline.status === 'omitted' || baseline.assetsRaw === null) {
            cell.omitted++
            continue
          }
          cell.issued++
          if (baseline.status === 'unavailable') {
            cell.baselineUnavailable++
            continue
          }
          if (baseline.status !== 'measured') throw Error('holder_evidence_baseline_invalid')
          if (
            baseline.measurement?.baselineStatus !== 'success' &&
            baseline.measurement?.status !== 'success'
          ) {
            cell.baselineIneligible++
            if (
              baseline.measurement?.baselineStatus === 'revert' ||
              baseline.measurement?.baselineStatus === 'covered_revert'
            ) {
              cell.baselineImpaired++
              const impairedOutcome = score?.cases[index]
              if (!impairedOutcome) {
                if (now > Date.parse(target.captureDeadlineUtc)) cell.impairedOutcomeMissing++
                else cell.impairedOutcomePending++
              } else if (
                !prospectiveSyncVault &&
                impairedOutcome.status === 'ineligible' &&
                (impairedOutcome.reason == null ||
                  impairedOutcome.reason === 'baseline_not_success') &&
                impairedOutcome.outcome == null &&
                impairedOutcome.transition == null
              ) {
                // Older sealed studies did not assess impaired Q at future horizons.
                cell.impairedOutcomeUnavailable++
              } else if (impairedOutcome.status === 'unavailable') {
                if (impairedOutcome.transition !== 'censored')
                  throw Error('holder_evidence_impaired_censor_invalid')
                cell.impairedOutcomeUnavailable++
              } else if (impairedOutcome.status === 'measured' && impairedOutcome.onTime === true) {
                cell.impairedOnTimeMeasured++
                if (
                  impairedOutcome.outcome === 'simulated_withdraw_success' &&
                  impairedOutcome.transition === 'simulated_recovery'
                ) {
                  cell.impairedSimulatedRecovery++
                  if (
                    cell.firstImpairedRecoveryTargetAtUtc === null ||
                    target.targetAtUtc < cell.firstImpairedRecoveryTargetAtUtc
                  )
                    cell.firstImpairedRecoveryTargetAtUtc = target.targetAtUtc
                  if (
                    cell.lastImpairedRecoveryTargetAtUtc === null ||
                    target.targetAtUtc > cell.lastImpairedRecoveryTargetAtUtc
                  )
                    cell.lastImpairedRecoveryTargetAtUtc = target.targetAtUtc
                } else if (
                  (['preview_gap', 'covered_revert_cause_unknown'].includes(
                    impairedOutcome.outcome ?? '',
                  ) ||
                    (prospectiveSyncVault &&
                      ['preview_share_gap', 'withdraw_revert_cause_unknown'].includes(
                        impairedOutcome.outcome ?? '',
                      ))) &&
                  impairedOutcome.transition === 'still_reverting'
                )
                  cell.impairedStillReverting++
                else if (
                  (impairedOutcome.outcome === 'holder_attrition' ||
                    (prospectiveSyncVault && impairedOutcome.outcome === 'holder_shares_zero')) &&
                  impairedOutcome.transition === 'holder_attrition'
                )
                  cell.impairedHolderAttrition++
                else if (
                  impairedOutcome.outcome === 'inconclusive_revert' &&
                  impairedOutcome.transition === 'inconclusive_revert'
                )
                  cell.impairedInconclusiveRevert++
                else throw Error('holder_evidence_impaired_transition_invalid')
              } else throw Error('holder_evidence_impaired_outcome_invalid')
            }
            continue
          }
          cell.baselineEligible++
          const outcome = score?.cases[index]
          if (!outcome) {
            if (now > Date.parse(target.captureDeadlineUtc)) cell.outcomeMissing++
            else cell.outcomePending++
          } else if (outcome.status === 'measured' && (outcome.onTime ?? score?.onTime) === true) {
            cell.onTimeMeasured++
            if (
              outcome.outcome === 'simulated_withdraw_success' ||
              outcome.outcome === 'exit_success'
            )
              cell.onTimeMeasuredSuccess++
            else if (
              outcome.outcome === 'withdraw_revert_cause_unknown' ||
              outcome.outcome === 'exit_revert_cause_unknown' ||
              outcome.outcome === 'covered_revert_cause_unknown'
            ) {
              cell.onTimeMeasuredNonSuccess++
              cell.onTimeUnknownRevert++
            } else if (
              outcome.outcome === 'holder_shares_zero' ||
              outcome.outcome === 'holder_attrition'
            ) {
              cell.onTimeMeasuredNonSuccess++
              cell.onTimeHolderAttrition++
            } else if (
              outcome.outcome === 'preview_share_gap' ||
              outcome.outcome === 'preview_gap'
            ) {
              cell.onTimeMeasuredNonSuccess++
              cell.onTimePreviewGap++
            } else if (outcome.outcome === 'inconclusive_revert') {
              cell.onTimeMeasuredNonSuccess++
              cell.onTimeInconclusiveRevert++
            } else throw Error('holder_evidence_outcome_class_invalid')
          } else if (outcome.status === 'unavailable') {
            cell.outcomeUnavailable++
          } else {
            throw Error('holder_evidence_outcome_invalid')
          }
        }
      }
    }
  }
  for (const [key, cell] of cells) cell.distinctIssueEpisodes = episodes.get(key)!.size
  return [...cells.values()].sort(
    (a, b) =>
      a.qLabel.localeCompare(b.qLabel) ||
      a.horizonHours - b.horizonHours ||
      (a.assetsRaw ?? '').localeCompare(b.assetsRaw ?? ''),
  )
}

/** Coarse public disclosure: no exact Q, holder, asset address, or issue clock. */
export function projectPublicHolderExitEvidence(
  routeKey: string,
  destination: string,
  exactCells: HolderEvidenceCell[],
  studies: HolderEvidenceStudy[],
): PublicHolderEvidenceCell[] {
  const byHorizon = new Map<number, PublicHolderEvidenceCell>()
  for (const exact of exactCells) {
    let coarse = byHorizon.get(exact.horizonHours)
    if (!coarse) {
      coarse = {
        horizonHours: exact.horizonHours,
        distinctIssueEpisodes: 0,
      } as PublicHolderEvidenceCell
      for (const key of PUBLIC_COUNT_KEYS) coarse[key] = 0
      byHorizon.set(exact.horizonHours, coarse)
    }
    for (const key of PUBLIC_COUNT_KEYS) coarse[key] += exact[key]
  }
  const episodes = new Map<number, Set<string>>()
  for (const [studyIndex, study] of studies.entries())
    for (const issue of study.issues) {
      if (
        issue.routeKey !== routeKey ||
        issue.destination !== destination ||
        issue.cases.length === 0
      )
        continue
      for (const horizon of issue.horizonsHours) {
        if (!byHorizon.has(horizon)) continue
        if (!episodes.has(horizon)) episodes.set(horizon, new Set())
        episodes.get(horizon)!.add(`${studyIndex}:${issue.sequence}`)
      }
    }
  for (const [horizon, coarse] of byHorizon)
    coarse.distinctIssueEpisodes = episodes.get(horizon)?.size ?? 0
  return [...byHorizon.values()].sort((a, b) => a.horizonHours - b.horizonHours)
}

type MorphoV2Issue = {
  sequence: number
  sha256: string
  routeKey: string
  destination: string
  asset: string
  issuedAtUtc: string
  horizonsHours: number[]
  targets: HolderEvidenceIssue['targets']
  baseline: { assetDecimals: number }
  cases: {
    label: string
    assetsRaw: string | null
    baselineStatus: string
  }[]
}

type MorphoV2Score = {
  issueSequence: number
  issueSha256: string
  routeKey: string
  destination: string
  caseLabel: string
  assetsRaw: string
  horizonHours: number
  targetAtUtc: string
  captureDeadlineUtc: string
  scoredAtUtc: string
  baselineStatus: string
  transition: string
  outcome: string
}

function morphoV2Transition(baselineStatus: string, outcome: string) {
  if (outcome === 'censored_capture_window_missed') return 'censored'
  if (outcome === 'simulated_withdraw_success')
    return baselineStatus === 'baseline_revert' ? 'simulated_recovery' : 'simulated_continuity'
  if (outcome === 'holder_attrition' || outcome === 'inconclusive_revert') return outcome
  if (outcome === 'preview_gap' || outcome === 'covered_revert_cause_unknown')
    return baselineStatus === 'baseline_revert' ? 'still_reverting' : 'new_revert'
  throw Error('holder_evidence_morpho_v2_outcome_invalid')
}

/** V2 has one score per Q/H, unlike the older public studies' horizon-wide rows. */
export function normalizeMorphoV2Evidence(
  issues: MorphoV2Issue[],
  scores: MorphoV2Score[],
): HolderEvidenceStudy {
  const normalizedIssues: HolderEvidenceIssue[] = issues.map((issue) => ({
    sequence: issue.sequence,
    sha256: issue.sha256,
    routeKey: issue.routeKey,
    destination: issue.destination,
    originalAsset: issue.asset,
    baseline: { assetDecimals: issue.baseline.assetDecimals },
    issuedAtUtc: issue.issuedAtUtc,
    horizonsHours: issue.horizonsHours,
    targets: issue.targets,
    cases: issue.cases.map((row) => ({
      label: row.label,
      assetsRaw: row.assetsRaw,
      status:
        row.baselineStatus === 'omitted'
          ? 'omitted'
          : row.baselineStatus === 'unavailable'
            ? 'unavailable'
            : 'measured',
      measurement:
        row.baselineStatus === 'simulated_withdraw_success'
          ? { baselineStatus: 'success' }
          : row.baselineStatus === 'baseline_revert'
            ? { baselineStatus: 'revert' }
            : null,
    })),
  }))
  const grouped = new Map<string, HolderEvidenceScore>()
  for (const score of scores) {
    const issue = issues[score.issueSequence - 1]
    const index = issue?.cases.findIndex((row) => row.label === score.caseLabel)
    const target = issue?.targets.find((row) => row.horizonHours === score.horizonHours)
    if (
      !issue ||
      index === undefined ||
      index < 0 ||
      !target ||
      score.issueSha256 !== issue.sha256 ||
      score.routeKey !== issue.routeKey ||
      score.destination !== issue.destination ||
      score.assetsRaw !== issue.cases[index].assetsRaw ||
      score.targetAtUtc !== target.targetAtUtc ||
      score.captureDeadlineUtc !== target.captureDeadlineUtc ||
      !Number.isFinite(Date.parse(score.scoredAtUtc)) ||
      Date.parse(score.scoredAtUtc) < Date.parse(target.targetAtUtc) ||
      (score.outcome === 'censored_capture_window_missed'
        ? Date.parse(score.scoredAtUtc) <= Date.parse(target.captureDeadlineUtc)
        : Date.parse(score.scoredAtUtc) > Date.parse(target.captureDeadlineUtc)) ||
      !['simulated_withdraw_success', 'baseline_revert'].includes(
        issue.cases[index].baselineStatus,
      ) ||
      score.baselineStatus !== issue.cases[index].baselineStatus ||
      score.transition !== morphoV2Transition(score.baselineStatus, score.outcome)
    )
      throw Error('holder_evidence_morpho_v2_binding_invalid')
    const key = `${score.issueSequence}:${score.horizonHours}`
    let row = grouped.get(key)
    if (!row) {
      row = {
        issueSequence: score.issueSequence,
        issueSha256: score.issueSha256,
        routeKey: score.routeKey,
        destination: score.destination,
        horizonHours: score.horizonHours,
        targetAtUtc: score.targetAtUtc,
        onTime: true,
        cases: Array(issue.cases.length).fill(null),
      }
      grouped.set(key, row)
    }
    if (row.cases[index] !== null) throw Error('holder_evidence_morpho_v2_duplicate_score')
    row.cases[index] = {
      label: score.caseLabel,
      status: score.outcome === 'censored_capture_window_missed' ? 'unavailable' : 'measured',
      outcome: score.outcome === 'censored_capture_window_missed' ? null : score.outcome,
      onTime: score.outcome !== 'censored_capture_window_missed',
      transition: score.transition,
    }
  }
  return { issues: normalizedIssues, scores: [...grouped.values()] }
}

/** Comet can simulate withdraw by borrowing. Only supplied balance >= Q is eligible. */
export function normalizeCompoundHolderEvidence(
  issues: HolderEvidenceIssue[],
  scores: HolderEvidenceScore[],
): HolderEvidenceStudy {
  const normalizedIssues = issues.map((issue) => ({
    ...issue,
    cases: issue.cases.map((entry) => {
      if (entry.status !== 'measured' || entry.measurement?.status !== 'success') return entry
      if (
        !/^[0-9]+$/.test(entry.assetsRaw ?? '') ||
        !/^[0-9]+$/.test(entry.measurement.holderCoverageRaw ?? '')
      )
        throw Error('holder_evidence_compound_baseline_invalid')
      return {
        ...entry,
        measurement: {
          status:
            BigInt(entry.measurement.holderCoverageRaw!) >= BigInt(entry.assetsRaw!)
              ? 'success'
              : 'not_supplied',
        },
      }
    }),
  }))
  return { issues: normalizedIssues, scores }
}

export async function readLocalHolderExitEvidence(routeKey: string, destination: string) {
  if (routeKey === 'PYUSD → StakingVault [wYLDS]') {
    const { PRIME } = await import('@/scripts/research/pyusd-staking-economic-exit.mjs')
    if (destination.toLowerCase() === PRIME) {
      const prospective = await import('@/scripts/research/pyusd-staking-prospective.mjs')
      await prospective.verify()
      const [issues, scores] = await Promise.all([
        prospective.readRows('issues'),
        prospective.readRows('scores'),
      ])
      return {
        status: issues.length ? ('available' as const) : ('unavailable' as const),
        routeKey,
        destination,
        scope: 'local_public_simulations' as const,
        disclosure: 'coarse_route_horizon_counts' as const,
        countUnit: 'holder_episodes' as const,
        calibratedForecast: false,
        cells: [],
        primeFirstStageEvidence: prospective.summarizeProspective(issues, scores),
      }
    }
  }
  if (
    routeKey === 'USDC → Fluid USD Coin [USDC]' ||
    routeKey === 'USDT → fToken [USDT]' ||
    routeKey === 'GHO → fToken [GHO]'
  ) {
    const fluid = await import('@/scripts/research/carry-fluid-ftoken-holder.mjs')
    const fluidHolderEvidence = fluid.readPublicFluidHolderEvidence(routeKey, destination)
    if (fluidHolderEvidence) {
      return {
        status: fluidHolderEvidence.status,
        routeKey,
        destination,
        scope: 'local_public_simulations' as const,
        disclosure: 'coarse_route_horizon_counts' as const,
        countUnit: 'correlated_q_cases' as const,
        calibratedForecast: false,
        cells: [],
        fluidHolderEvidence,
      }
    }
  }
  if (
    routeKey === 'apxUSD → ApyUSD [apxUSD]' &&
    destination === '0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a'
  ) {
    const [issueModule, scoreModule] = await Promise.all([
      import('@/scripts/research/carry-public-apyusd-exit-issue.mjs'),
      import('@/scripts/research/carry-public-apyusd-exit-score.mjs'),
    ])
    const [issues, scores] = await Promise.all([
      issueModule.verifyApyUsdIssues(),
      scoreModule.verifyApyUsdScores(),
    ])
    const receiptInitiationEvidence = {
      scope: 'same_holder_withdraw_for_receipt_eth_call_only' as const,
      finalPayoutAssessment: 'unmeasured_no_mined_receipt_in_study' as const,
      cells: aggregateApyUsdInitiationEvidence(routeKey, destination, issues, scores),
    }
    return {
      status: receiptInitiationEvidence.cells.length
        ? ('available' as const)
        : ('unavailable' as const),
      routeKey,
      destination,
      scope: 'local_public_simulations' as const,
      disclosure: 'coarse_route_horizon_counts' as const,
      countUnit: 'correlated_q_cases' as const,
      calibratedForecast: false,
      cells: [],
      queueRequestEvidence: null,
      umbrellaRedeemEvidence: null,
      receiptInitiationEvidence,
    }
  }
  const isStakedUsdat = routeKey === STAKED_USDAT_ROUTE && destination === STAKED_USDAT_VAULT
  const isUmbrellaGho = routeKey === UMBRELLA_GHO_ROUTE && destination === UMBRELLA_STKGHO
  if (isUmbrellaGho) {
    // This route has its own private ledger. No generic holder study records
    // target the frozen Umbrella route; unrelated verifier failures must not
    // hide its measured evidence.
    const umbrella = await import('@/scripts/research/carry-local-umbrella-gho-holder.mjs')
    const verified = await umbrella.verifyAll()
    const umbrellaRedeemEvidence = {
      scope: 'same_holder_stkgho_redeem_eth_call_only' as const,
      sampling: 'window_open_enriched_transfer_recipient_eoa' as const,
      cells: aggregateUmbrellaRedeemEvidence(
        routeKey,
        destination,
        verified.issues,
        verified.scores,
      ),
    }
    return {
      status: umbrellaRedeemEvidence.cells.length
        ? ('available' as const)
        : ('unavailable' as const),
      routeKey,
      destination,
      scope: 'local_public_simulations' as const,
      disclosure: 'coarse_route_horizon_counts' as const,
      countUnit: 'correlated_q_cases' as const,
      calibratedForecast: false,
      cells: [],
      queueRequestEvidence: null,
      umbrellaRedeemEvidence,
    }
  }
  if (
    routeKey === 'USDC → USD3 [USDC]' &&
    destination === '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc'
  ) {
    const [issueModule, scoreModule] = await Promise.all([
      import('@/scripts/research/carry-public-usd3-exit-issue.mjs'),
      import('@/scripts/research/carry-public-usd3-exit-score.mjs'),
    ])
    const study = {
      issues: await issueModule.verifyUsd3Issues(),
      scores: await scoreModule.verifyUsd3Scores(),
    }
    const studies = [study]
    // Missing here is an unsealed, local-clock observation gap. The scorer
    // seals a capture-window censor only after finalized chain witnesses.
    const exactCells = aggregateHolderExitEvidence(routeKey, destination, studies, Date.now())
    const cells = projectPublicHolderExitEvidence(routeKey, destination, exactCells, studies)
    return {
      status: cells.length ? ('available' as const) : ('unavailable' as const),
      routeKey,
      destination,
      scope: 'local_public_simulations' as const,
      disclosure: 'coarse_route_horizon_counts' as const,
      countUnit: 'correlated_q_cases' as const,
      calibratedForecast: false,
      cells,
      queueRequestEvidence: null,
      umbrellaRedeemEvidence: null,
    }
  }
  if (
    routeKey === 'USDS → StUsds [USDS]' &&
    destination === '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9'
  ) {
    const [issueModule, scoreModule] = await Promise.all([
      import('@/scripts/research/carry-public-stusds-exit-issue.mjs'),
      import('@/scripts/research/carry-public-stusds-exit-score.mjs'),
    ])
    const study = {
      issues: await issueModule.verifyStusdsIssues(),
      scores: await scoreModule.verifyStusdsScores(),
    }
    const studies = [study]
    // A local overdue gap is provisional; only the scorer can seal a censor.
    const exactCells = aggregateHolderExitEvidence(routeKey, destination, studies, Date.now())
    const cells = projectPublicHolderExitEvidence(routeKey, destination, exactCells, studies)
    return {
      status: cells.length ? ('available' as const) : ('unavailable' as const),
      routeKey,
      destination,
      scope: 'local_public_simulations' as const,
      disclosure: 'coarse_route_horizon_counts' as const,
      countUnit: 'correlated_q_cases' as const,
      calibratedForecast: false,
      cells,
      queueRequestEvidence: null,
      umbrellaRedeemEvidence: null,
    }
  }
  const [
    sghoIssue,
    sghoScore,
    susdsIssue,
    susdsScore,
    directIssue,
    directScore,
    morphoV2,
    compoundIssue,
    compoundScore,
  ] = await Promise.all([
    import('@/scripts/research/carry-public-sgho-exit-issue.mjs'),
    import('@/scripts/research/carry-public-sgho-exit-score.mjs'),
    import('@/scripts/research/carry-public-susds-exit-issue.mjs'),
    import('@/scripts/research/carry-public-susds-exit-score.mjs'),
    import('@/scripts/research/carry-public-direct-exit-issue.mjs'),
    import('@/scripts/research/carry-public-direct-exit-score.mjs'),
    import('@/scripts/research/carry-local-morpho-holder-v2.mjs'),
    import('@/scripts/research/carry-local-compound-holder-issue.mjs'),
    import('@/scripts/research/carry-local-compound-holder-score.mjs'),
  ])
  const studies = await Promise.all([
    Promise.all([sghoIssue.verifySghoIssues(), sghoScore.verifySghoScores()]),
    Promise.all([susdsIssue.verifySusdsIssues(), susdsScore.verifySusdsScores()]),
    Promise.all([directIssue.verifyPublicDirectIssues(), directScore.verifyPublicDirectScores()]),
    Promise.all([
      compoundIssue.verifyPublicDirectIssues(),
      compoundScore.verifyPublicDirectScores(),
    ]),
  ])
  const morphoIssues = await morphoV2.readV2Issues()
  // allowJs infers the default-null parameter narrowly; the runtime verifier
  // explicitly accepts the already verified issue array.
  const readMorphoV2Scores = morphoV2.readV2Scores as unknown as (
    issues: MorphoV2Issue[],
  ) => Promise<MorphoV2Score[]>
  const morphoScores = await readMorphoV2Scores(morphoIssues)
  const verifiedStudies = [
    ...studies.slice(0, 3).map(([issues, scores]) => ({ issues, scores })),
    normalizeCompoundHolderEvidence(studies[3][0], studies[3][1]),
    normalizeMorphoV2Evidence(morphoIssues, morphoScores),
  ]
  const exactCells = aggregateHolderExitEvidence(routeKey, destination, verifiedStudies)
  const cells = projectPublicHolderExitEvidence(routeKey, destination, exactCells, verifiedStudies)
  const queueRequestEvidence = isStakedUsdat
    ? await (async () => {
        const saturn = await import('@/scripts/research/carry-local-staked-usdat-holder.mjs')
        const verified = await saturn.verifyAll()
        return {
          scope: 'same_holder_queue_request_eth_call_only' as const,
          sampling: 'stress_enriched_reverting_eoa_else_callable' as const,
          cells: aggregateStakedUsdatQueueRequestEvidence(
            routeKey,
            destination,
            verified.issues,
            verified.scores,
          ),
        }
      })()
    : null
  return {
    status:
      cells.length > 0 || (queueRequestEvidence?.cells.length ?? 0) > 0
        ? ('available' as const)
        : ('unavailable' as const),
    routeKey,
    destination,
    scope: 'local_public_simulations' as const,
    disclosure: 'coarse_route_horizon_counts' as const,
    countUnit: 'correlated_q_cases' as const,
    calibratedForecast: false,
    cells,
    queueRequestEvidence,
    umbrellaRedeemEvidence: null,
  }
}
