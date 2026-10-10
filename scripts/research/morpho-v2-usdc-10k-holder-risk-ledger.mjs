// Offline, descriptive replay of the frozen USDC -> VaultV2 fixed-$10k history.
// No chain reads, model fitting, probability, or future holder-exit forecast.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { lossIntervals } from './carry-morpho-exit-history-grid.mjs'
import {
  DESIGN,
  readSavedCell,
  validateCellResult,
  validatePlan,
} from './carry-morpho-stable-exit-history.mjs'

export const STUDY = 'morpho-v2-usdc-10k-holder-risk-ledger-v1'
export const ROUTE_KEY = 'USDC → VaultV2 [USDC]'
export const Q_ASSETS_RAW = '10000000000'
export const DEFAULT_DIRECTORY = fileURLToPath(
  new URL('../../lib/carry/research/morpho-stable-exit-history-v1/', import.meta.url),
)

const add = (counts, key) => {
  counts[key] = (counts[key] || 0) + 1
}
const makeCount = () => ({
  plannedCells: 0,
  completedCells: 0,
  missingCells: 0,
  cellStatus: {},
  fixed10kBaselineClass: {},
  baselineSuccessEpisodes: 0,
  observedFirstLossEpisodes: 0,
  observedRecoveryEpisodes: 0,
  firstLossRightCensoredEpisodes: 0,
  holderAttritionCensoredEpisodes: 0,
  otherCensoredEpisodes: 0,
  episodesWithMissingHorizonSamples: 0,
  holderVaultClusters: 0,
})
const CALL_STATUSES = new Set([
  'success',
  'evm_revert',
  'rpc_unavailable',
  'gas_error',
  'not_read_identity',
])

function validateProbeCall(probe) {
  const status = probe?.call?.status
  if (status !== undefined && !CALL_STATUSES.has(status)) throw Error('ledger_call_status_invalid')
  if (
    (probe?.class === 'success' && status !== 'success') ||
    (['evm_revert', 'holder_attrition'].includes(probe?.class) && status !== 'evm_revert')
  )
    throw Error('ledger_call_class_invalid')
}

function observedEpisode(size, cell) {
  const interval = lossIntervals(size)
  const firstLoss = interval.firstLoss?.class === 'evm_revert' ? interval.firstLoss : null
  const recovery = interval.recovery?.throughHours !== undefined ? interval.recovery : null
  const missingBetween = (after, through) =>
    size.horizons.some(
      (sample) =>
        sample.hours > after &&
        sample.hours < through &&
        !['success', 'evm_revert'].includes(sample.class),
    )
  return {
    anchorBlock: cell.anchorBlock,
    vault: cell.vault,
    holder: cell.row.holder,
    holderVaultCluster: `${cell.vault}:${cell.row.holder}`,
    cellSha256: cell.cellSha256,
    horizonClasses: size.horizons.map(({ hours, class: outcome }) => ({ hours, outcome })),
    firstObservedLossIntervalHours: firstLoss
      ? {
          after: firstLoss.afterHours,
          through: firstLoss.throughHours,
          hasMissingInterveningSample: missingBetween(firstLoss.afterHours, firstLoss.throughHours),
        }
      : null,
    firstLossRightCensoredAtHours: interval.firstLoss?.rightCensoredAtHours ?? null,
    observedRecoveryIntervalHours: recovery
      ? {
          after: recovery.afterHours,
          through: recovery.throughHours,
          hasMissingInterveningSample: missingBetween(recovery.afterHours, recovery.throughHours),
        }
      : null,
    recoveryRightCensoredAtHours: interval.recovery?.rightCensoredAtHours ?? null,
    censoring: interval.censoring,
    missingHorizonSamples: interval.missingHorizons,
  }
}

/** Caller-supplied cells are checked against the frozen plan before description. */
export function describeLedger(plan, completedCells) {
  validatePlan(plan)
  if (!Array.isArray(completedCells)) throw Error('ledger_cells_invalid')
  const usdcFrozen = plan.cells.filter((cell) => cell.routeKey === ROUTE_KEY)
  const planned = new Set(usdcFrozen.map((cell) => `${cell.anchorBlock}:${cell.vault}`))
  const byKey = new Map()
  for (const cell of completedCells) {
    validateCellResult(plan, cell)
    const key = `${cell.anchorBlock}:${cell.vault}`
    if (!planned.has(key)) throw Error('ledger_non_usdc_cell')
    if (byKey.has(key)) throw Error('ledger_duplicate_cell')
    byKey.set(key, cell)
  }

  const development = makeCount()
  const reservedHoldout = makeCount()
  const all = makeCount()
  const clusters = { development: new Set(), reservedHoldout: new Set(), all: new Set() }
  const cells = []
  const episodes = []
  for (const frozen of usdcFrozen) {
    const cell = byKey.get(`${frozen.anchorBlock}:${frozen.vault}`)
    const split =
      frozen.anchorBlock === DESIGN.reservedHoldoutAnchor ? 'reservedHoldout' : 'development'
    const counts = split === 'reservedHoldout' ? reservedHoldout : development
    const targets = [counts, all]
    const size =
      cell?.status === 'measured'
        ? cell.row.sizes.find((candidate) => candidate.label === 'fixed_10k')
        : null
    if (cell?.status === 'measured' && (!size || size.assetsRaw !== Q_ASSETS_RAW))
      throw Error('ledger_fixed_q_invalid')
    if (size?.eligible) {
      validateProbeCall(size.baseline)
      for (const sample of size.horizons) validateProbeCall(sample)
    }
    const status = cell?.status || (frozen.status === 'frozen' ? 'pending' : frozen.status)
    const baselineClass = !cell
      ? `not_measured_${status}`
      : cell.status !== 'measured'
        ? `not_measured_${cell.status}`
        : !size.eligible
          ? 'ineligible_holder_claim'
          : size.baseline.class
    const entry = {
      split,
      anchorBlock: frozen.anchorBlock,
      vault: frozen.vault,
      cellStatus: status,
      cellSha256: cell?.cellSha256 || null,
      fixed10kBaselineClass: baselineClass,
      holder: cell?.row?.holder || null,
    }
    cells.push(entry)
    for (const target of targets) {
      target.plannedCells++
      if (cell) target.completedCells++
      else target.missingCells++
      add(target.cellStatus, entry.cellStatus)
      add(target.fixed10kBaselineClass, baselineClass)
    }
    if (baselineClass !== 'success') continue
    const episode = { split, ...observedEpisode(size, cell) }
    episodes.push(episode)
    clusters[split].add(episode.holderVaultCluster)
    clusters.all.add(episode.holderVaultCluster)
    for (const target of targets) {
      target.baselineSuccessEpisodes++
      if (episode.firstObservedLossIntervalHours) target.observedFirstLossEpisodes++
      if (episode.observedRecoveryIntervalHours) target.observedRecoveryEpisodes++
      if (episode.firstLossRightCensoredAtHours !== null) target.firstLossRightCensoredEpisodes++
      if (episode.censoring?.class === 'holder_attrition') target.holderAttritionCensoredEpisodes++
      else if (episode.censoring) target.otherCensoredEpisodes++
      if (episode.missingHorizonSamples) target.episodesWithMissingHorizonSamples++
    }
  }
  development.holderVaultClusters = clusters.development.size
  reservedHoldout.holderVaultClusters = clusters.reservedHoldout.size
  all.holderVaultClusters = clusters.all.size
  const sharedClusters = [...clusters.development].filter((key) =>
    clusters.reservedHoldout.has(key),
  )

  return {
    schemaVersion: 1,
    study: STUDY,
    routeKey: ROUTE_KEY,
    asset: DESIGN.assets[0],
    qAssetsRaw: Q_ASSETS_RAW,
    planSha256: plan.planSha256,
    source: 'caller_supplied_frozen_plan_and_validated_cells',
    reservedHoldoutAnchor: DESIGN.reservedHoldoutAnchor,
    counts: {
      development,
      reservedHoldout,
      all,
      sharedHolderVaultClustersAcrossSplits: sharedClusters.length,
    },
    cells,
    episodes,
    limits: {
      forecastValidated: false,
      prospectiveSamples: 0,
      likelyExitDurationAvailable: false,
      independentObservations: false,
      cohortSelection: DESIGN.cohortSelection,
      observation:
        'Historical hash-pinned eth_call samples at 1/4/24/48/168h; intervals are between samples, not continuous exit monitoring or mined payout.',
      attribution:
        'A simulated withdrawal revert does not establish its cause or prove all routes are blocked.',
      missing:
        'Pending cells, absent eligible holders, ineligible fixed Q, provider/identity censors and missing horizon samples remain explicit denominators.',
      holdout:
        'Reserved anchor is described separately; these retrospective cells were not a prospective or calibrated validation set.',
    },
  }
}

/** Verify canonical saved bytes and every selected cell; never open an RPC client. */
export function readSavedLedger(directory = DEFAULT_DIRECTORY) {
  const names = readdirSync(directory)
  const plans = names.filter((name) => /^plan-[0-9a-f]{64}\.json$/.test(name))
  if (plans.length !== 1) throw Error('ledger_plan_count_invalid')
  const bytes = readFileSync(join(directory, plans[0]))
  const plan = JSON.parse(bytes.toString('utf8'))
  validatePlan(plan)
  if (
    plans[0] !== `plan-${plan.planSha256}.json` ||
    bytes.toString('utf8') !== `${JSON.stringify(plan, null, 2)}\n`
  )
    throw Error('ledger_plan_artifact_invalid')
  const planned = new Set(plan.cells.map((cell) => `${cell.anchorBlock}:${cell.vault}`))
  for (const name of names.filter((item) => item.startsWith('cell-'))) {
    const match = name.match(/^cell-([0-9a-f]{64})-(\d+)-(0x[0-9a-f]{40})-[0-9a-f]{64}\.json$/)
    if (!match || match[1] !== plan.planSha256 || !planned.has(`${Number(match[2])}:${match[3]}`))
      throw Error('ledger_cell_artifact_invalid')
  }
  const completed = []
  for (const frozen of plan.cells.filter((cell) => cell.routeKey === ROUTE_KEY)) {
    const saved = readSavedCell(plan, frozen.anchorBlock, frozen.vault, directory)
    if (saved) completed.push(saved.cell)
  }
  return {
    ...describeLedger(plan, completed),
    source: 'saved_retrospective_cells_disk_integrity_only',
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv[2] === '--help') {
      process.stdout.write(
        'usage: node morpho-v2-usdc-10k-holder-risk-ledger.mjs [saved-directory]\n',
      )
    } else if (process.argv.length > 3) {
      throw Error('ledger_arguments_invalid')
    } else {
      process.stdout.write(`${JSON.stringify(readSavedLedger(process.argv[2]))}\n`)
    }
  } catch (error) {
    process.stderr.write(`${error?.message || 'ledger_failed'}\n`)
    process.exitCode = 1
  }
}
