// One local, bounded evidence lane per ten-minute scheduler tick.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const STATE_PATH = resolve('data/research/venue-signals/holder-exit-campaign-state.json')
export const SLOT_MS = 600_000
export const HOURLY_MS = 3_600_000
export const ASSAY_MS = 21_600_000
export const DAILY_MS = 86_400_000
const ROTATING_MS = 3 * HOURLY_MS
const SHORT_STAGE_RETRY_MS = 3 * SLOT_MS
const MAX_CHILD_MS = 560_000
const PRIORITY_SCRVUSD_FAILURE_LANE = 'priority_scrvusd_failure'
const PRIORITY_MORPHO_FAILURE_LANE = 'priority_morpho_failure'
const PRIORITY_TARGET_FAILURE_BACKOFF_MS = 2 * SLOT_MS
const APYUSD_STAGE_BITS = Object.freeze([
  [1, 'receipt_intake'],
  [2, 'receipt_forceability'],
  [4, 'impairment_followup'],
  [8, 'receipt_outcomes'],
])
const LANES = Object.freeze({
  susde_archive: ['scripts/susde-public-pending-continuity-tick.sh'],
  susde_assay: ['scripts/susde-public-pending-continuity-tick.sh'],
  direct_flow: ['scripts/carry-direct-supplier-flow-tick.sh'],
  aave_holder: ['scripts/carry-aave-usdc-holder-prospective-tick.sh'],
  aave_cash: ['scripts/carry-aave-usdc-cash-archive-tick.sh'],
  all_subject_cash: ['scripts/carry-local-cash-tick.sh'],
  morpho_v2_score: ['scripts/carry-local-morpho-holder-tick.sh', 'v2score'],
  morpho_v2_issue_api: ['scripts/carry-local-morpho-holder-tick.sh', 'issue-missing-api'],
  apyusd_frozen_open: ['scripts/carry-apyusd-frozen-open-tick.sh'],
  apyusd_prospective_intake: ['scripts/carry-apyusd-prospective-intake-tick.sh'],
  saturn_pending_series: ['scripts/carry-saturn-pending-series-tick.sh'],
  fluid_bridge_usdc_score: ['scripts/carry-fluid-bridge-usdc-holder-tick.sh', '--score'],
  fluid_bridge_usdt_score: ['scripts/carry-fluid-bridge-usdt-holder-tick.sh', '--score'],
  fluid_ftoken_score: ['scripts/carry-fluid-ftoken-holder-tick.sh', 'score'],
  twyne_borrower_pt_score: ['scripts/carry-twyne-borrower-pt-tick.sh', '--score'],
  compound_holder_score: ['scripts/carry-local-compound-holder-tick.sh', 'score'],
  usd3_holder_score: ['scripts/carry-public-usd3-exit-tick.sh', 'score-campaign'],
  stusds_holder_score: ['scripts/carry-public-stusds-exit-tick.sh', 'score-campaign'],
  susds_holder_score: ['scripts/carry-public-susds-exit-tick.sh', 'score-campaign'],
  aave_usdc_holder_score: ['scripts/carry-public-direct-exit-tick.sh', 'score-direct-campaign'],
  aave_usde_holder_score: ['scripts/carry-public-direct-exit-tick.sh', 'score-direct-campaign'],
  spark_usdt_holder_score: ['scripts/carry-public-direct-exit-tick.sh', 'score-spark-campaign'],
  umbrella_gho_holder_score: ['scripts/carry-local-umbrella-gho-holder-tick.sh', 'score-campaign'],
  sgho_holder_score: ['scripts/carry-public-sgho-exit-tick.sh', 'score-campaign'],
  sgho_fixed_q_score: ['scripts/carry-public-sgho-exit-tick.sh', 'fixed-q-score-campaign'],
  sgho_fixed_q_issue: ['scripts/carry-public-sgho-exit-tick.sh', 'fixed-q-issue-campaign'],
  hastra_prime_score: ['scripts/carry-pyusd-staking-prospective-tick.sh', 'score-campaign'],
  fluid_bridge_usdc_issue: ['scripts/carry-fluid-bridge-usdc-holder-tick.sh', '--issue'],
  fluid_bridge_usdt_issue: ['scripts/carry-fluid-bridge-usdt-holder-tick.sh', '--issue'],
  fluid_ftoken_issue: ['scripts/carry-fluid-ftoken-holder-tick.sh', 'issue'],
  twyne_borrower_pt_issue: ['scripts/carry-twyne-borrower-pt-tick.sh', '--issue'],
  compound_holder_issue: ['scripts/carry-local-compound-holder-tick.sh', 'issue'],
  usd3_holder_issue: ['scripts/carry-public-usd3-exit-tick.sh', 'issue'],
  stusds_holder_issue: ['scripts/carry-public-stusds-exit-tick.sh', 'issue-campaign'],
  susds_holder_issue: ['scripts/carry-public-susds-exit-tick.sh', 'issue-campaign'],
  aave_usdc_holder_issue: ['scripts/carry-public-direct-exit-tick.sh', 'issue-aave-campaign'],
  aave_usde_holder_issue: ['scripts/carry-public-direct-exit-tick.sh', 'issue-aave-usde-campaign'],
  spark_usdt_holder_issue: ['scripts/carry-public-direct-exit-tick.sh', 'issue-spark-campaign'],
  umbrella_gho_holder_issue: ['scripts/carry-local-umbrella-gho-holder-tick.sh', 'issue-campaign'],
  sgho_holder_issue: ['scripts/carry-public-sgho-exit-tick.sh', 'issue-campaign'],
  hastra_prime_issue: ['scripts/carry-pyusd-staking-prospective-tick.sh', 'issue-campaign'],
})
const SHORT_STAGE_LANES = new Set([
  'fluid_bridge_usdc_score',
  'fluid_bridge_usdt_score',
  'fluid_ftoken_score',
  'twyne_borrower_pt_score',
  'compound_holder_score',
  'usd3_holder_score',
  'stusds_holder_score',
  'susds_holder_score',
  'aave_usdc_holder_score',
  'aave_usde_holder_score',
  'spark_usdt_holder_score',
  'umbrella_gho_holder_score',
  'sgho_holder_score',
  'sgho_fixed_q_score',
  'sgho_fixed_q_issue',
  'hastra_prime_score',
])
const SHORT_STAGE_ISSUE_LANES = [
  'fluid_bridge_usdc_issue',
  'fluid_bridge_usdt_issue',
  'fluid_ftoken_issue',
  'twyne_borrower_pt_issue',
  'compound_holder_issue',
  'usd3_holder_issue',
  'stusds_holder_issue',
  'susds_holder_issue',
  'spark_usdt_holder_issue',
  'umbrella_gho_holder_issue',
  'sgho_holder_issue',
  'hastra_prime_issue',
]
const LIGHT_DIRECT_MARKETS = Object.freeze({
  aave_usdc_holder_issue: 'aaveV3Usdc',
  aave_usde_holder_issue: 'aaveV3Usde',
  spark_usdt_holder_issue: 'sparkLendUsdt',
  compound_holder_issue: 'compoundV3Usdc',
})
const LIGHT_DIRECT_ISSUE_LANES = Object.keys(LIGHT_DIRECT_MARKETS)
const FULL_FRESH_DIRECT_ISSUE_LANES = ['aave_usdc_holder_issue', 'aave_usde_holder_issue']
const DIRECT_FEATURE_MAX_AGE_MS = 2 * HOURLY_MS

const parsedTime = (value) => {
  if (typeof value !== 'string') return null
  const valueMs = Date.parse(value)
  return Number.isSafeInteger(valueMs) ? valueMs : null
}

const h1TargetObservationMatches = (issue, attempt, observation, nowMs) => {
  if (
    observation?.collectionMode !== 'current' ||
    observation?.evidenceKind !== 'current_finalized_observation'
  )
    return false
  const blockMs = parsedTime(observation?.source?.blockAt)
  const receiptMs = parsedTime(observation?.firstLocalReceiptAt)
  const issueMs = parsedTime(issue.issuedAt)
  const lowMs = parsedTime(attempt.targetLowAt)
  const highMs = parsedTime(attempt.targetHighAt)
  const sourceMs = parsedTime(attempt?.source?.blockAt)
  if (
    blockMs === null ||
    receiptMs === null ||
    issueMs === null ||
    lowMs === null ||
    highMs === null ||
    sourceMs === null ||
    blockMs < lowMs ||
    blockMs > highMs ||
    blockMs <= sourceMs ||
    receiptMs <= issueMs ||
    receiptMs > highMs + HOURLY_MS ||
    receiptMs > nowMs
  )
    return false
  const row = observation.subjects?.find(
    (subject) =>
      subject.routeKey === attempt.routeKey && subject.destination === attempt.destination,
  )
  return (
    row?.state === 'observed' &&
    row.asset === attempt.asset &&
    row.assetDecimals === attempt.source.assetDecimals &&
    typeof row.cashRaw === 'string' &&
    /^\d+$/.test(row.cashRaw)
  )
}

/**
 * Find verified H1 baseline windows that can still accept a current receipt.
 * A target stays due through its one-hour ingestion grace, but disappears as
 * soon as every issued subject has a qualifying target observation.
 */
export function summarizeH1CashTargetDue(ledger, nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw Error('campaign_time_invalid')
  const records = Array.isArray(ledger?.records) ? ledger.records : []
  const observations = Array.isArray(ledger?.observations) ? ledger.observations : []
  const scoredSlots = new Set(
    records
      .filter(
        (record) =>
          record?.kind === 'score' &&
          (record.horizonHours === 1 || !Object.hasOwn(record, 'horizonHours')),
      )
      .map((record) => record.issueSlotAt),
  )
  const windows = []
  for (const issue of records.filter((record) => record?.kind === 'issue')) {
    if (scoredSlots.has(issue.slotAt)) continue
    const attempts = Array.isArray(issue.attempts)
      ? issue.attempts.filter(
          (attempt) => attempt?.horizonHours === 1 && attempt.status === 'issued',
        )
      : []
    if (!attempts.length) continue
    const lowMs = Math.min(...attempts.map((attempt) => parsedTime(attempt.targetLowAt) ?? NaN))
    const highMs = Math.max(...attempts.map((attempt) => parsedTime(attempt.targetHighAt) ?? NaN))
    const receiptDeadlineMs = highMs + HOURLY_MS
    if (
      !Number.isSafeInteger(lowMs) ||
      !Number.isSafeInteger(highMs) ||
      nowMs < lowMs ||
      nowMs >= receiptDeadlineMs
    )
      continue
    const missing = attempts.filter(
      (attempt) =>
        !observations.some((observation) =>
          h1TargetObservationMatches(issue, attempt, observation, nowMs),
        ),
    )
    if (missing.length)
      windows.push({
        issueSlotAt: issue.slotAt,
        targetLowMs: lowMs,
        targetHighMs: highMs,
        receiptDeadlineMs,
        missingAttempts: missing.length,
      })
  }
  windows.sort(
    (a, b) =>
      a.receiptDeadlineMs - b.receiptDeadlineMs ||
      a.targetHighMs - b.targetHighMs ||
      a.issueSlotAt.localeCompare(b.issueSlotAt),
  )
  return {
    due: windows.length > 0,
    liveWindows: windows.length,
    missingAttempts: windows.reduce((total, window) => total + window.missingAttempts, 0),
    nextTargetHighMs: windows[0]?.targetHighMs ?? null,
    nextReceiptDeadlineMs: windows[0]?.receiptDeadlineMs ?? null,
  }
}

export async function readVerifiedH1CashTargetDue(nowMs) {
  const [{ buildSubjectManifest }, { verifyLocalCashIssueLedger }] = await Promise.all([
    import('../record-carry-cash-issues.mjs'),
    import('../lib/localCarryCashIssueStore.mjs'),
  ])
  const manifest = await buildSubjectManifest()
  return summarizeH1CashTargetDue(verifyLocalCashIssueLedger(manifest), nowMs)
}

export function hasFreshVerifiedDirectFlowPair(result, marketKey, nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return false
  return [
    ['supply', 'gross_supplier_supply_24h'],
    ['withdraw', 'gross_supplier_withdraw_24h'],
  ].every(
    ([flowKind, kind]) =>
      result?.sources?.some(
        (source) =>
          source.marketKey === marketKey &&
          source.flowKind === flowKind &&
          source.featureCount > 0 &&
          source.reason === null,
      ) &&
      result?.features?.some((feature) => {
        const sourceMs = Date.parse(feature.sourceAt)
        return (
          feature.kind === kind &&
          feature.coverageComplete === true &&
          Number.isSafeInteger(sourceMs) &&
          sourceMs <= nowMs &&
          nowMs - sourceMs < DIRECT_FEATURE_MAX_AGE_MS
        )
      }),
  )
}

export async function nextFreshLightDirectIssueLane({
  nowMs,
  lastAttempts = {},
  verificationFailedLanes = [],
  featureReader,
  candidateLanes = LIGHT_DIRECT_ISSUE_LANES,
}) {
  const candidates = candidateLanes
    .filter(
      (lane) =>
        due(nowMs, lastAttempts[lane], DAILY_MS) &&
        !verificationFailedLanes.includes(lane.replace('_issue', '_score')),
    )
    .sort(
      (a, b) =>
        (lastAttempts[a] ?? -1) - (lastAttempts[b] ?? -1) ||
        LIGHT_DIRECT_ISSUE_LANES.indexOf(a) - LIGHT_DIRECT_ISSUE_LANES.indexOf(b),
    )
  for (const lane of candidates) {
    try {
      const result = await featureReader({ marketKeys: [LIGHT_DIRECT_MARKETS[lane]] })
      if (hasFreshVerifiedDirectFlowPair(result, LIGHT_DIRECT_MARKETS[lane], nowMs)) return lane
    } catch {
      // A failed offline replay never licenses an issue.
    }
  }
  return null
}

export function campaignCommandForLane(lane) {
  if (!Object.hasOwn(LANES, lane)) throw Error('campaign_lane_invalid')
  return ['-k', '10s', '550s', '/bin/sh', ...LANES[lane]]
}

export function apyUsdFailedStages(exitStatus) {
  if (exitStatus === 0) return []
  if (!Number.isSafeInteger(exitStatus) || exitStatus < 65 || exitStatus > 79) return null
  const mask = exitStatus - 64
  return APYUSD_STAGE_BITS.filter(([bit]) => (mask & bit) !== 0).map(([, stage]) => stage)
}

const logApyUsdStageFailures = (lane, child) => {
  if (lane !== 'apyusd_prospective_intake') return
  const stages = !child.error && !child.signal ? apyUsdFailedStages(child.status) : null
  process.stdout.write(
    `holder-exit-campaign:${lane}:failed-stages:${stages?.length ? stages.join(',') : 'unknown'}\n`,
  )
}

const due = (nowMs, lastMs, intervalMs) =>
  !Number.isSafeInteger(lastMs) ||
  lastMs < 0 ||
  (nowMs >= lastMs &&
    Math.floor(nowMs / SLOT_MS) - Math.floor(lastMs / SLOT_MS) >= intervalMs / SLOT_MS)

const nextLiveStageLane = (stageRows, nowMs, lastAttempts) => {
  const imminent = (row) =>
    Number.isSafeInteger(row.nextLiveDeadlineMs) &&
    row.nextLiveDeadlineMs <= nowMs + SLOT_MS + MAX_CHILD_MS
  const critical = (row) =>
    Number.isSafeInteger(row.nextLiveDeadlineMs) && row.nextLiveDeadlineMs <= nowMs + MAX_CHILD_MS
  const candidates = stageRows
    .filter((row) => SHORT_STAGE_LANES.has(row.lane) && row.live > 0)
    .filter((row) => {
      return (
        due(
          nowMs,
          lastAttempts[row.lane],
          row.lane === 'sgho_fixed_q_issue' ? SLOT_MS : SHORT_STAGE_RETRY_MS,
        ) ||
        (imminent(row) && due(nowMs, lastAttempts[row.lane], SLOT_MS))
      )
    })
  const untried = (row) =>
    !Number.isSafeInteger(lastAttempts[row.lane]) || lastAttempts[row.lane] < row.nextLiveTargetMs
  candidates.sort((a, b) => {
    const aCritical = critical(a)
    const bCritical = critical(b)
    const aImminent = imminent(a)
    const bImminent = imminent(b)
    const aUntried = untried(a)
    const bUntried = untried(b)
    return (
      Number(bCritical) - Number(aCritical) ||
      (aCritical && bCritical ? a.nextLiveDeadlineMs - b.nextLiveDeadlineMs : 0) ||
      Number(bImminent) - Number(aImminent) ||
      (aImminent && bImminent ? a.nextLiveDeadlineMs - b.nextLiveDeadlineMs : 0) ||
      Number(bUntried) - Number(aUntried) ||
      (a.lane === 'sgho_fixed_q_issue' || b.lane === 'sgho_fixed_q_issue'
        ? a.nextLiveDeadlineMs - b.nextLiveDeadlineMs
        : 0) ||
      (lastAttempts[a.lane] ?? -1) - (lastAttempts[b.lane] ?? -1) ||
      a.nextLiveDeadlineMs - b.nextLiveDeadlineMs ||
      a.lane.localeCompare(b.lane)
    )
  })
  return candidates[0]?.lane ?? null
}

const nextExpiredStageLane = (stageRows, nowMs, lastAttempts) => {
  const candidates = stageRows.filter(
    (row) =>
      SHORT_STAGE_LANES.has(row.lane) &&
      row.expired > 0 &&
      due(nowMs, lastAttempts[row.lane], SHORT_STAGE_RETRY_MS),
  )
  candidates.sort(
    (a, b) =>
      (lastAttempts[a.lane] ?? -1) - (lastAttempts[b.lane] ?? -1) ||
      (a.nextExpiredDeadlineMs ?? Infinity) - (b.nextExpiredDeadlineMs ?? Infinity) ||
      a.lane.localeCompare(b.lane),
  )
  return candidates[0]?.lane ?? null
}

const nextShortStageIssueLane = (
  shortStage,
  stageRows,
  shortStageVerificationFailed,
  nowMs,
  lastAttempts,
) => {
  if (!Array.isArray(shortStage?.byLane) || stageRows.some((row) => row.live > 0)) return null
  const failedScoreLanes = new Set(
    Array.isArray(shortStage.verificationFailedLanes)
      ? shortStage.verificationFailedLanes
      : shortStageVerificationFailed
        ? [...SHORT_STAGE_LANES]
        : [],
  )
  return (
    SHORT_STAGE_ISSUE_LANES.filter(
      (lane) =>
        !failedScoreLanes.has(lane.replace('_issue', '_score')) &&
        due(nowMs, lastAttempts[lane], DAILY_MS),
    ).sort(
      (a, b) =>
        (lastAttempts[a] ?? -1) - (lastAttempts[b] ?? -1) ||
        SHORT_STAGE_ISSUE_LANES.indexOf(a) - SHORT_STAGE_ISSUE_LANES.indexOf(b),
    )[0] ?? null
  )
}

const nextRotatingCaptureLane = (
  shortStage,
  stageRows,
  shortStageVerificationFailed,
  nowMs,
  lastAttempts,
  directIssueLane = null,
) => {
  const candidates = ['morpho_v2_issue_api', 'aave_cash', 'all_subject_cash'].filter((lane) =>
    due(nowMs, lastAttempts[lane], ROTATING_MS),
  )
  const issueLane = nextShortStageIssueLane(
    shortStage,
    stageRows,
    shortStageVerificationFailed,
    nowMs,
    lastAttempts,
  )
  if (issueLane) candidates.push(issueLane)
  if (FULL_FRESH_DIRECT_ISSUE_LANES.includes(directIssueLane)) candidates.push(directIssueLane)
  // Slot 5 has more due work than fixed priority can serve. The oldest
  // attempt wins, including first attempts, so every eligible lane advances.
  const tieOrder = ['morpho_v2_issue_api', 'aave_cash', 'all_subject_cash']
  candidates.sort(
    (a, b) =>
      (lastAttempts[a] ?? -1) - (lastAttempts[b] ?? -1) ||
      (tieOrder.indexOf(a) < 0 ? tieOrder.length : tieOrder.indexOf(a)) -
        (tieOrder.indexOf(b) < 0 ? tieOrder.length : tieOrder.indexOf(b)),
  )
  return candidates[0] ?? null
}

/** One bounded lane per tick; score due Morpho cases before issuing new ones. */
export function chooseCampaignLane({
  nowMs,
  archiveComplete,
  archiveVerificationFailed = false,
  episodeAttested,
  joinedSourceAvailable,
  shortStage = null,
  shortStageVerificationFailed = false,
  h1CashTarget = null,
  lastAttempts = {},
  directIssueLane = null,
}) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw Error('campaign_time_invalid')
  const slot = Math.floor(nowMs / SLOT_MS) % 6
  const stageRows = Array.isArray(shortStage?.byLane) ? shortStage.byLane : []
  // Rotate failed live lanes on a thirty-minute retry; a closing window gets
  // one final ten-minute retry without monopolizing unrelated targets.
  const liveStage = nextLiveStageLane(stageRows, nowMs, lastAttempts)
  const liveStageDeadlineMs = stageRows.find((row) => row.lane === liveStage)?.nextLiveDeadlineMs
  const h1TargetHighMs = h1CashTarget?.nextTargetHighMs
  const h1Due =
    h1CashTarget?.due === true && Number.isSafeInteger(h1TargetHighMs) && h1TargetHighMs >= 0
  // One all-subject capture can close every still-missing H1 target. It beats
  // ordinary rotation and a later-closing holder target, while a holder target
  // with an earlier or equal irreversible deadline keeps priority.
  if (
    h1Due &&
    (!liveStage ||
      (Number.isSafeInteger(liveStageDeadlineMs) && h1TargetHighMs < liveStageDeadlineMs))
  )
    return 'all_subject_cash'
  if (liveStage) return liveStage
  // Two scoring slots per hour cover up to six due Q×horizon cells per run,
  // including a new H1 issue and older H24 targets inside their capture grace.
  if (slot === 0 || slot === 4) return 'morpho_v2_score'
  // Enroll new receipts and follow the frozen cohort in separate bounded
  // passes. Each is due every three hours; spare slot 3 ticks remain available
  // to the sUSDe assay or a failed archive retry.
  if (slot === 3 && due(nowMs, lastAttempts.apyusd_prospective_intake, 3 * HOURLY_MS))
    return 'apyusd_prospective_intake'
  if (slot === 3 && due(nowMs, lastAttempts.apyusd_frozen_open, 3 * HOURLY_MS))
    return 'apyusd_frozen_open'
  // Keep the queue sample alive while the larger sUSDe archive is still filling.
  // This occupies one archive/issue slot per day, never a Morpho score slot.
  if (slot === 5 && due(nowMs, lastAttempts.saturn_pending_series, DAILY_MS))
    return 'saturn_pending_series'
  // An unfinished sUSDe archive must not consume the direct and holder slots.
  // Its spare slots still advance the archive, while slot 5 rotates issue/cash.
  if (slot === 1 && due(nowMs, lastAttempts.direct_flow, HOURLY_MS)) return 'direct_flow'
  if (slot === 2 && joinedSourceAvailable && due(nowMs, lastAttempts.aave_holder, HOURLY_MS))
    return 'aave_holder'
  if (
    slot === 3 &&
    archiveComplete &&
    !episodeAttested &&
    due(nowMs, lastAttempts.susde_assay, ASSAY_MS)
  )
    return 'susde_assay'
  // Old missed windows must be sealed, but cannot indefinitely prevent new
  // exact-holder enrollment while an historical censor backlog is drained.
  if (slot === 3) {
    const issueLane = nextShortStageIssueLane(
      shortStage,
      stageRows,
      shortStageVerificationFailed,
      nowMs,
      lastAttempts,
    )
    if (FULL_FRESH_DIRECT_ISSUE_LANES.includes(directIssueLane)) {
      if (!issueLane || (lastAttempts[directIssueLane] ?? -1) < (lastAttempts[issueLane] ?? -1))
        return directIssueLane
    }
    if (issueLane) return issueLane
  }
  if (slot === 5) {
    const captureLane = nextRotatingCaptureLane(
      shortStage,
      stageRows,
      shortStageVerificationFailed,
      nowMs,
      lastAttempts,
      directIssueLane,
    )
    if (captureLane) return captureLane
  }
  if (slot === 3 || slot === 5) {
    const expiredStage = nextExpiredStageLane(stageRows, nowMs, lastAttempts)
    if (expiredStage) return expiredStage
  }
  if (!archiveComplete || archiveVerificationFailed) return 'susde_archive'
  return 'aave_cash'
}

/** At 1–3 GiB, preserve open score windows and defer routine work only near deadline. */
export function chooseLightCampaignLane({
  nowMs,
  lastAttempts = {},
  shortStage = null,
  directIssueLane = null,
}) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw Error('campaign_time_invalid')
  const stageRows = Array.isArray(shortStage?.byLane) ? shortStage.byLane : []
  const slot = Math.floor(nowMs / SLOT_MS) % 6
  let baseline = null
  if (slot === 3) {
    if (due(nowMs, lastAttempts.apyusd_prospective_intake, 3 * HOURLY_MS))
      baseline = 'apyusd_prospective_intake'
    else if (due(nowMs, lastAttempts.apyusd_frozen_open, 3 * HOURLY_MS))
      baseline = 'apyusd_frozen_open'
    else if (due(nowMs, lastAttempts.saturn_pending_series, 3 * HOURLY_MS))
      baseline = 'saturn_pending_series'
  }
  const closingStage = stageRows.some(
    (row) =>
      SHORT_STAGE_LANES.has(row.lane) &&
      row.live > 0 &&
      Number.isSafeInteger(row.nextLiveDeadlineMs) &&
      row.nextLiveDeadlineMs <= nowMs + SLOT_MS + MAX_CHILD_MS,
  )
  if (baseline && !closingStage) return baseline
  const liveStage = nextLiveStageLane(stageRows, nowMs, lastAttempts)
  if (liveStage) return liveStage
  if (baseline) return baseline
  if ((slot === 3 || slot === 5) && LIGHT_DIRECT_ISSUE_LANES.includes(directIssueLane))
    return directIssueLane
  if (slot === 5) {
    const expiredStage = nextExpiredStageLane(stageRows, nowMs, lastAttempts)
    if (expiredStage) return expiredStage
  }
  return null
}

export function readCampaignState(path = STATE_PATH) {
  if (!existsSync(path)) return { lastAttempts: {} }
  try {
    const bytes = readFileSync(path)
    if (bytes.length > 4096) throw Error('campaign_state_oversize')
    const state = JSON.parse(bytes.toString('utf8'))
    if (
      state?.version !== 1 ||
      !state.lastAttempts ||
      typeof state.lastAttempts !== 'object' ||
      Array.isArray(state.lastAttempts) ||
      Object.entries(state.lastAttempts).some(
        ([key, value]) =>
          ![
            'direct_flow',
            'aave_holder',
            'aave_cash',
            'all_subject_cash',
            'susde_assay',
            'morpho_v2_issue_api',
            'apyusd_frozen_open',
            'apyusd_prospective_intake',
            'saturn_pending_series',
            ...SHORT_STAGE_LANES,
            ...SHORT_STAGE_ISSUE_LANES,
            ...LIGHT_DIRECT_ISSUE_LANES,
            PRIORITY_SCRVUSD_FAILURE_LANE,
            PRIORITY_MORPHO_FAILURE_LANE,
          ].includes(key) ||
          !Number.isSafeInteger(value) ||
          value < 0,
      )
    )
      throw Error('campaign_state_invalid')
    return state
  } catch {
    // This file records scheduling only. Rebuild it rather than stall evidence
    // collection when a previous run left partial or malformed bytes.
    return { lastAttempts: {} }
  }
}

export function writeCampaignState(lane, nowMs, state, path = STATE_PATH) {
  if (
    ![
      'direct_flow',
      'aave_holder',
      'aave_cash',
      'all_subject_cash',
      'susde_assay',
      'morpho_v2_issue_api',
      'apyusd_frozen_open',
      'apyusd_prospective_intake',
      'saturn_pending_series',
      ...SHORT_STAGE_LANES,
      ...SHORT_STAGE_ISSUE_LANES,
      ...LIGHT_DIRECT_ISSUE_LANES,
      PRIORITY_SCRVUSD_FAILURE_LANE,
      PRIORITY_MORPHO_FAILURE_LANE,
    ].includes(lane)
  )
    return
  const next = {
    version: 1,
    lastAttempts: { ...state.lastAttempts, [lane]: nowMs },
  }
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 })
  renameSync(temporary, path)
}

export async function readCampaignEvidence(
  nowMs = Date.now(),
  {
    archiveReader = async () =>
      (await import('./susde-public-pending-continuity-archive.mjs')).verifyContinuityArchive(),
    episodeReader = async () =>
      (await import('./susde-public-pending-payout-v2.mjs')).verifyEpisodes(),
    joinedEndpointReader = async () =>
      (await import('./aave-usdc-holder-flow-pair.mjs')).loadVerifiedEndpoint().endpoint,
    shortStageReader = async (time) =>
      (await import('./holder-exit-short-stage-due.mjs')).readVerifiedShortStageDue(time),
    h1CashTargetReader = readVerifiedH1CashTargetDue,
  } = {},
) {
  let archiveComplete = false
  let archiveVerificationFailed = false
  try {
    archiveComplete = (await archiveReader()).summary.complete
  } catch {
    archiveVerificationFailed = true
  }
  let episodeAttested = false
  if (archiveComplete) {
    try {
      episodeAttested = (await episodeReader()).length > 0
    } catch {
      // Sidecar absence or corruption cannot claim a completed episode. It
      // should still leave the independent Aave lanes eligible to advance.
    }
  }
  let joinedSourceAvailable = false
  if (Math.floor(nowMs / SLOT_MS) % 6 === 2) {
    try {
      joinedSourceAvailable = Boolean(await joinedEndpointReader())
    } catch {
      // The existing holder tick performs its own RPC freshness check. Offline
      // absence or invalidity keeps this lane idle without disclosing source data.
    }
  }
  let shortStage = null
  let shortStageVerificationFailed = false
  try {
    shortStage = await shortStageReader(nowMs)
    shortStageVerificationFailed = (shortStage?.verificationFailedLanes?.length ?? 0) > 0
  } catch {
    shortStageVerificationFailed = true
  }
  let h1CashTarget = null
  let h1CashTargetVerificationFailed = false
  try {
    h1CashTarget = await h1CashTargetReader(nowMs)
    if (
      typeof h1CashTarget?.due !== 'boolean' ||
      (h1CashTarget.due === true &&
        (!Number.isSafeInteger(h1CashTarget.nextTargetHighMs) || h1CashTarget.nextTargetHighMs < 0))
    )
      throw Error('campaign_h1_cash_target_invalid')
  } catch {
    h1CashTarget = null
    h1CashTargetVerificationFailed = true
  }
  return {
    archiveComplete,
    archiveVerificationFailed,
    episodeAttested,
    joinedSourceAvailable,
    shortStage,
    shortStageVerificationFailed,
    h1CashTarget,
    h1CashTargetVerificationFailed,
  }
}

function priorityTargetFailedLanes(result) {
  const failed = []
  if (
    ['target_tick_failed', 'disk_reserve', 'capture_failed', 'runtime_bound'].includes(
      result?.scrvusd?.status,
    ) ||
    ['capture_failed', 'runtime_bound'].includes(result?.scrvusd?.capture?.status) ||
    ['capture_failed', 'runtime_bound'].includes(result?.scrvusd?.score?.status)
  )
    failed.push('scrvusd')
  if (
    ['disk_reserve', 'runtime_bound', 'worker_failed', 'preflight_failed'].includes(
      result?.morpho?.status,
    )
  )
    failed.push('morpho')
  return failed
}

/**
 * User-enqueued and live target windows share the campaign's one launchd job.
 * A quiet preflight returns control to the routine rotation; real target work
 * consumes this tick so a deadline-sensitive assay is not delayed by a long
 * archive lane.
 */
export async function runPriorityTargetTick(
  nowMs,
  targetTick = async (time, { blockedLanes = [] } = {}) =>
    (await import('../holder-exit-targets-tick.mjs')).tick(time, {
      singleLane: true,
      singleAction: true,
      blockedLanes,
    }),
  lastFailures = {},
) {
  const blockedLanes = ['scrvusd', 'morpho'].filter((lane) => {
    const failedAt = lastFailures[lane]
    return (
      Number.isSafeInteger(failedAt) &&
      failedAt >= 0 &&
      nowMs >= failedAt &&
      nowMs - failedAt < PRIORITY_TARGET_FAILURE_BACKOFF_MS
    )
  })
  let result
  try {
    result = await targetTick(nowMs, { blockedLanes })
  } catch {
    process.stderr.write('holder-exit-campaign:priority-targets:failed\n')
    return { handled: false, ok: false, failedLanes: [], blockedLanes, errored: true }
  }
  if (!result) return { handled: false, ok: true, failedLanes: [], blockedLanes, errored: false }
  const failedLanes = priorityTargetFailedLanes(result)
  const ok = failedLanes.length === 0
  process.stdout.write(`holder-exit-campaign:priority-targets:${ok ? 'ok' : 'failed'}\n`)
  return { handled: true, ok, failedLanes, blockedLanes, errored: false }
}

function priorityFailureTimes(state) {
  return {
    scrvusd: state.lastAttempts[PRIORITY_SCRVUSD_FAILURE_LANE],
    morpho: state.lastAttempts[PRIORITY_MORPHO_FAILURE_LANE],
  }
}

function writePriorityFailures(failedLanes, nowMs, state, statePath) {
  let current = state
  for (const lane of failedLanes) {
    const key = lane === 'scrvusd' ? PRIORITY_SCRVUSD_FAILURE_LANE : PRIORITY_MORPHO_FAILURE_LANE
    writeCampaignState(key, nowMs, current, statePath)
    current = { ...current, lastAttempts: { ...current.lastAttempts, [key]: nowMs } }
  }
}

export async function runCampaignTick({
  nowMs = Date.now(),
  statePath = STATE_PATH,
  evidence,
  targetTick,
  directFlowFeatureReader = async (options) =>
    (await import('./holder-exit-direct-flow-features.mjs')).readVerifiedDirectFlowFeatures(
      options,
    ),
} = {}) {
  const state = readCampaignState(statePath)
  const priority = await runPriorityTargetTick(nowMs, targetTick, priorityFailureTimes(state))
  writePriorityFailures(priority.failedLanes, nowMs, state, statePath)
  if (priority.handled) return priority.ok
  const priorityErrored = priority.errored
  const summary = evidence ?? (await readCampaignEvidence(nowMs))
  if (summary.shortStageVerificationFailed)
    process.stderr.write('holder-exit-campaign:short-stage-verification-failed\n')
  if (summary.h1CashTargetVerificationFailed)
    process.stderr.write('holder-exit-campaign:h1-cash-target-verification-failed\n')
  const slot = Math.floor(nowMs / SLOT_MS) % 6
  const directIssueLane =
    summary.h1CashTarget?.due !== true && (slot === 3 || slot === 5) && summary.shortStage
      ? await nextFreshLightDirectIssueLane({
          nowMs,
          lastAttempts: state.lastAttempts,
          verificationFailedLanes: summary.shortStage.verificationFailedLanes ?? [],
          featureReader: directFlowFeatureReader,
          candidateLanes: FULL_FRESH_DIRECT_ISSUE_LANES,
        })
      : null
  const lane = chooseCampaignLane({
    nowMs,
    ...summary,
    lastAttempts: state.lastAttempts,
    directIssueLane,
  })
  // Reserve periodic lanes before running. A crash or timeout cannot create a
  // rapid retry loop; the next hourly/assay slot is the next attempt.
  writeCampaignState(lane, nowMs, state, statePath)
  const child = spawnSync('/opt/homebrew/bin/timeout', campaignCommandForLane(lane), {
    cwd: resolve('.'),
    env: FULL_FRESH_DIRECT_ISSUE_LANES.includes(lane)
      ? { ...process.env, HOLDER_EXIT_REQUIRE_FRESH_FLOW: '1' }
      : process.env,
    stdio: 'ignore',
    timeout: MAX_CHILD_MS + 20_000,
  })
  const ok = child.status === 0 && !child.error && !child.signal
  process.stdout.write(`holder-exit-campaign:${lane}:${ok ? 'ok' : 'failed'}\n`)
  if (!ok) logApyUsdStageFailures(lane, child)
  return ok && !priorityErrored
}

export async function runLightCampaignTick({
  nowMs = Date.now(),
  statePath = STATE_PATH,
  spawn = spawnSync,
  targetTick,
  shortStageReader = async (time) =>
    (await import('./holder-exit-short-stage-due.mjs')).readVerifiedShortStageDue(time),
  directFlowFeatureReader = async (options) =>
    (await import('./holder-exit-direct-flow-features.mjs')).readVerifiedDirectFlowFeatures(
      options,
    ),
} = {}) {
  const state = readCampaignState(statePath)
  const priority = await runPriorityTargetTick(nowMs, targetTick, priorityFailureTimes(state))
  writePriorityFailures(priority.failedLanes, nowMs, state, statePath)
  if (priority.handled) return priority.ok
  const priorityErrored = priority.errored
  let shortStage = null
  try {
    shortStage = await shortStageReader(nowMs)
  } catch {
    process.stderr.write('holder-exit-campaign:light-short-stage-verification-failed\n')
  }
  let lane = chooseLightCampaignLane({ nowMs, lastAttempts: state.lastAttempts, shortStage })
  if (
    shortStage &&
    (Math.floor(nowMs / SLOT_MS) % 6 === 3 || Math.floor(nowMs / SLOT_MS) % 6 === 5) &&
    (!lane ||
      (Math.floor(nowMs / SLOT_MS) % 6 === 5 &&
        lane === nextExpiredStageLane(shortStage?.byLane ?? [], nowMs, state.lastAttempts)))
  ) {
    const directIssueLane = await nextFreshLightDirectIssueLane({
      nowMs,
      lastAttempts: state.lastAttempts,
      verificationFailedLanes: shortStage?.verificationFailedLanes ?? [],
      featureReader: directFlowFeatureReader,
    })
    lane = chooseLightCampaignLane({
      nowMs,
      lastAttempts: state.lastAttempts,
      shortStage,
      directIssueLane,
    })
  }
  if (!lane) {
    process.stdout.write('holder-exit-campaign:light-idle\n')
    return !priorityErrored
  }
  writeCampaignState(lane, nowMs, state, statePath)
  const child = spawn('/opt/homebrew/bin/timeout', campaignCommandForLane(lane), {
    cwd: resolve('.'),
    env: LIGHT_DIRECT_ISSUE_LANES.includes(lane)
      ? { ...process.env, HOLDER_EXIT_REQUIRE_FRESH_FLOW: '1' }
      : process.env,
    stdio: 'ignore',
    timeout: MAX_CHILD_MS + 20_000,
  })
  const ok = child.status === 0 && !child.error && !child.signal
  process.stdout.write(`holder-exit-campaign:${lane}:${ok ? 'ok' : 'failed'}\n`)
  if (!ok) logApyUsdStageFailures(lane, child)
  return ok && !priorityErrored
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--light') {
      if (!(await runLightCampaignTick())) process.exitCode = 1
    } else if (process.argv.length === 2) {
      if (!(await runCampaignTick())) process.exitCode = 1
    } else throw Error('campaign_usage')
  } catch {
    process.stderr.write('holder-exit-campaign:planning-failed\n')
    process.exitCode = 1
  }
}
