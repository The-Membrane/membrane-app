// Offline count-only transition audit for the sealed Morpho stable-vault archive.
// This does not read the chain, fit a model, or publish a holder-exit forecast.
import { createHash } from 'node:crypto'
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

export const STUDY = 'morpho-stable-fixed-10k-transition-audit-v1'
export const Q_LABEL = 'fixed_10k'
export const Q_ASSETS_RAW = '10000000000'
export const DEFAULT_DIRECTORY = fileURLToPath(
  new URL('../../lib/carry/research/morpho-stable-exit-history-v1/', import.meta.url),
)

const ASSET_SYMBOL = Object.freeze({
  [DESIGN.assets[0]]: 'USDC',
  [DESIGN.assets[1]]: 'USDT',
})
const TERMINAL_CENSOR_CLASSES = new Set([
  'holder_attrition',
  'holder_type_changed',
  'identity_changed',
])
const sha = (value) => createHash('sha256').update(value).digest('hex')
const count = (target, key, amount = 1) => {
  target[key] = (target[key] || 0) + amount
}
const intervalKey = (afterHours, throughHours) => `(${afterHours},${throughHours}]`
const splitForAnchor = (anchorBlock) =>
  anchorBlock === DESIGN.reservedHoldoutAnchor ? 'reservedAnchor' : 'development'

function emptyCallableCounts() {
  return {
    baselineCallableEpisodes: 0,
    observedExactCallImpairmentOnsetEpisodes: 0,
    noObservedExactCallImpairmentOnsetEpisodes: 0,
    callableRightCensoredEpisodes: 0,
    holderAttritionCensoredBeforeOnsetEpisodes: 0,
    holderTypeChangedCensoredBeforeOnsetEpisodes: 0,
    identityChangedCensoredBeforeOnsetEpisodes: 0,
    otherObservationCensoredBeforeOnsetEpisodes: 0,
    postOnsetRecoveryEpisodes: 0,
    postOnsetRecoveryRightCensoredEpisodes: 0,
    postOnsetTerminalCensoredEpisodes: 0,
    episodesWithMissingHorizonSamples: 0,
  }
}

function emptyImpairedCounts() {
  return {
    baselineCoveredRevertEpisodes: 0,
    observedFirstLaterSuccessEpisodes: 0,
    stillImpairedRightCensoredEpisodes: 0,
    holderAttritionCensoredBeforeRecoveryEpisodes: 0,
    holderTypeChangedCensoredBeforeRecoveryEpisodes: 0,
    identityChangedCensoredBeforeRecoveryEpisodes: 0,
    otherObservationCensoredBeforeRecoveryEpisodes: 0,
    episodesWithMissingHorizonSamples: 0,
  }
}

function terminalCensorCountField(prefix, className) {
  if (className === 'holder_attrition') return `holderAttritionCensored${prefix}Episodes`
  if (className === 'holder_type_changed') return `holderTypeChangedCensored${prefix}Episodes`
  if (className === 'identity_changed') return `identityChangedCensored${prefix}Episodes`
  return `otherObservationCensored${prefix}Episodes`
}

function dependencyClusterSummary(episodes) {
  const anchorsByHolderVault = new Map()
  for (const episode of episodes) {
    if (!anchorsByHolderVault.has(episode.holderVaultClusterId))
      anchorsByHolderVault.set(episode.holderVaultClusterId, new Set())
    const anchors = anchorsByHolderVault.get(episode.holderVaultClusterId)
    if (anchors.has(episode.anchorBlock)) throw Error('transition_holder_vault_anchor_duplicate')
    anchors.add(episode.anchorBlock)
  }
  const holderVaultClustersByAnchorMultiplicity = {}
  let maximumAnchorMultiplicity = 0
  for (const anchors of anchorsByHolderVault.values()) {
    count(holderVaultClustersByAnchorMultiplicity, String(anchors.size))
    maximumAnchorMultiplicity = Math.max(maximumAnchorMultiplicity, anchors.size)
  }
  return {
    uniqueHolderVaultClusters: anchorsByHolderVault.size,
    holderVaultClustersByAnchorMultiplicity,
    maximumAnchorMultiplicity,
  }
}

function callableEpisode(cell, size) {
  const interval = lossIntervals(size)
  if (!interval.riskSet) throw Error('transition_callable_interval_invalid')
  return {
    episodeId: `${cell.row.holder}:${cell.vault}:${cell.anchorBlock}`,
    holderVaultClusterId: `${cell.row.holder}:${cell.vault}`,
    anchorBlock: cell.anchorBlock,
    assetSymbol: ASSET_SYMBOL[cell.row.asset],
    anchorSplit: splitForAnchor(cell.anchorBlock),
    interval,
  }
}

function impairedEpisode(cell, size) {
  let lastCoveredRevertHours = 0
  let missingHorizonSamples = 0
  let recoveryInterval = null
  let terminalCensor = null
  for (const sample of size.horizons) {
    if (sample.class === 'success') {
      recoveryInterval = {
        afterHours: lastCoveredRevertHours,
        throughHours: sample.hours,
      }
      break
    }
    if (sample.class === 'evm_revert') {
      lastCoveredRevertHours = sample.hours
      continue
    }
    if (TERMINAL_CENSOR_CLASSES.has(sample.class)) {
      terminalCensor = {
        afterHours: lastCoveredRevertHours,
        atHours: sample.hours,
        class: sample.class,
      }
      break
    }
    missingHorizonSamples++
  }
  return {
    episodeId: `${cell.row.holder}:${cell.vault}:${cell.anchorBlock}`,
    holderVaultClusterId: `${cell.row.holder}:${cell.vault}`,
    anchorBlock: cell.anchorBlock,
    assetSymbol: ASSET_SYMBOL[cell.row.asset],
    anchorSplit: splitForAnchor(cell.anchorBlock),
    recoveryInterval,
    terminalCensor,
    recoveryRightCensoredAtHours:
      recoveryInterval || terminalCensor ? null : lastCoveredRevertHours,
    missingHorizonSamples,
  }
}

function summarizeCallable(episodes) {
  const counts = emptyCallableCounts()
  const onsetIntervalsHours = {}
  const postOnsetRecoveryIntervalsHours = {}
  const onsetRightCensoredAtHours = {}
  const callableRightCensoredAtHours = {}
  const terminalCensorIntervalsHours = {}
  const postOnsetTerminalCensorIntervalsHours = {}
  const episodeIds = new Set()

  for (const episode of episodes) {
    if (episodeIds.has(episode.episodeId)) throw Error('transition_callable_episode_duplicate')
    episodeIds.add(episode.episodeId)
    counts.baselineCallableEpisodes++
    if (episode.interval.missingHorizons > 0) counts.episodesWithMissingHorizonSamples++
    const onset = episode.interval.firstLoss?.class === 'evm_revert'
    if (onset) {
      counts.observedExactCallImpairmentOnsetEpisodes++
      count(
        onsetIntervalsHours,
        intervalKey(episode.interval.firstLoss.afterHours, episode.interval.firstLoss.throughHours),
      )
      if (episode.interval.recovery?.throughHours !== undefined) {
        counts.postOnsetRecoveryEpisodes++
        count(
          postOnsetRecoveryIntervalsHours,
          intervalKey(episode.interval.recovery.afterHours, episode.interval.recovery.throughHours),
        )
      } else if (episode.interval.censoring) {
        counts.postOnsetTerminalCensoredEpisodes++
        count(
          postOnsetTerminalCensorIntervalsHours,
          `${episode.interval.censoring.class}:${intervalKey(
            episode.interval.censoring.afterHours,
            episode.interval.censoring.atHours,
          )}`,
        )
      } else {
        counts.postOnsetRecoveryRightCensoredEpisodes++
        count(onsetRightCensoredAtHours, String(episode.interval.recovery.rightCensoredAtHours))
      }
      continue
    }

    counts.noObservedExactCallImpairmentOnsetEpisodes++
    if (episode.interval.censoring) {
      counts[terminalCensorCountField('BeforeOnset', episode.interval.censoring.class)]++
      count(
        terminalCensorIntervalsHours,
        `${episode.interval.censoring.class}:${intervalKey(
          episode.interval.censoring.afterHours,
          episode.interval.censoring.atHours,
        )}`,
      )
    } else if (episode.interval.missingHorizons > 0) {
      counts.otherObservationCensoredBeforeOnsetEpisodes++
      count(callableRightCensoredAtHours, String(episode.interval.firstLoss.rightCensoredAtHours))
    } else {
      counts.callableRightCensoredEpisodes++
      count(callableRightCensoredAtHours, String(episode.interval.firstLoss.rightCensoredAtHours))
    }
  }

  return {
    uniqueHolderVaultAnchorEpisodes: episodeIds.size,
    ...dependencyClusterSummary(episodes),
    counts,
    onsetIntervalsHours,
    postOnsetRecoveryIntervalsHours,
    postOnsetRecoveryRightCensoredAtHours: onsetRightCensoredAtHours,
    noOnsetRightCensoredAtHours: callableRightCensoredAtHours,
    terminalCensorIntervalsHours,
    postOnsetTerminalCensorIntervalsHours,
  }
}

function summarizeImpaired(episodes) {
  const counts = emptyImpairedCounts()
  const recoveryIntervalsHours = {}
  const recoveryRightCensoredAtHours = {}
  const terminalCensorIntervalsHours = {}
  const episodeIds = new Set()

  for (const episode of episodes) {
    if (episodeIds.has(episode.episodeId)) throw Error('transition_impaired_episode_duplicate')
    episodeIds.add(episode.episodeId)
    counts.baselineCoveredRevertEpisodes++
    if (episode.missingHorizonSamples > 0) counts.episodesWithMissingHorizonSamples++
    if (episode.recoveryInterval) {
      counts.observedFirstLaterSuccessEpisodes++
      count(
        recoveryIntervalsHours,
        intervalKey(episode.recoveryInterval.afterHours, episode.recoveryInterval.throughHours),
      )
    } else if (episode.terminalCensor) {
      counts[terminalCensorCountField('BeforeRecovery', episode.terminalCensor.class)]++
      count(
        terminalCensorIntervalsHours,
        `${episode.terminalCensor.class}:${intervalKey(
          episode.terminalCensor.afterHours,
          episode.terminalCensor.atHours,
        )}`,
      )
    } else {
      counts.stillImpairedRightCensoredEpisodes++
      count(recoveryRightCensoredAtHours, String(episode.recoveryRightCensoredAtHours))
    }
  }

  return {
    uniqueHolderVaultAnchorEpisodes: episodeIds.size,
    ...dependencyClusterSummary(episodes),
    counts,
    recoveryIntervalsHours,
    recoveryRightCensoredAtHours,
    terminalCensorIntervalsHours,
  }
}

function strataFor(episodes, summarize) {
  const result = []
  for (const assetSymbol of ['USDC', 'USDT'])
    for (const anchorSplit of ['development', 'reservedAnchor'])
      result.push({
        assetSymbol,
        anchorSplit,
        ...summarize(
          episodes.filter(
            (episode) => episode.assetSymbol === assetSymbol && episode.anchorSplit === anchorSplit,
          ),
        ),
      })
  return result
}

/**
 * Describe only aggregate counts after the caller supplies an authoritative plan
 * and cells. No holder, vault, or episode row is emitted.
 */
export function describeFixed10kTransitionAudit(plan, completedCells, evidence = null) {
  validatePlan(plan)
  if (!Array.isArray(completedCells)) throw Error('transition_cells_invalid')
  const planned = new Set(plan.cells.map((cell) => `${cell.anchorBlock}:${cell.vault}`))
  const cellsByKey = new Map()
  for (const cell of completedCells) {
    validateCellResult(plan, cell)
    const key = `${cell.anchorBlock}:${cell.vault}`
    if (!planned.has(key)) throw Error('transition_cell_not_planned')
    if (cellsByKey.has(key)) throw Error('transition_cell_duplicate')
    cellsByKey.set(key, cell)
  }

  const completedCellStatus = {}
  const fixed10kExclusionReason = {}
  const callable = []
  const impaired = []
  let missingCells = 0
  let fixed10kEligibleEpisodes = 0
  let fixed10kEligibleOtherBaselineClassEpisodes = 0

  for (const frozen of plan.cells) {
    const cell = cellsByKey.get(`${frozen.anchorBlock}:${frozen.vault}`)
    if (!cell) {
      missingCells++
      count(fixed10kExclusionReason, 'missing_cell')
      continue
    }
    count(completedCellStatus, cell.status)
    if (cell.status !== 'measured') {
      count(fixed10kExclusionReason, `cell_${cell.status}`)
      continue
    }
    const size = cell.row.sizes.find((candidate) => candidate.label === Q_LABEL)
    if (!size || size.assetsRaw !== Q_ASSETS_RAW) throw Error('transition_fixed_q_invalid')
    if (!size.eligible) {
      count(fixed10kExclusionReason, size.reason || 'fixed_q_ineligible')
      continue
    }
    fixed10kEligibleEpisodes++
    if (size.baseline.class === 'success') callable.push(callableEpisode(cell, size))
    else if (size.baseline.class === 'evm_revert') impaired.push(impairedEpisode(cell, size))
    else {
      fixed10kEligibleOtherBaselineClassEpisodes++
      count(fixed10kExclusionReason, `baseline_${size.baseline.class}`)
    }
  }

  const callableClusters = new Set(callable.map((episode) => episode.holderVaultClusterId))
  const impairedClusters = new Set(impaired.map((episode) => episode.holderVaultClusterId))
  const overlap = [...callableClusters].filter((cluster) => impairedClusters.has(cluster)).length
  if (overlap) throw Error('transition_holder_vault_risk_sets_overlap')

  return {
    schemaVersion: 1,
    study: STUDY,
    mode: 'offline_retrospective_count_audit',
    source: 'sealed_morpho_stable_archive_disk_integrity_only',
    evidence,
    fixedQuestion: {
      sizeLabel: Q_LABEL,
      assetsRaw: Q_ASSETS_RAW,
      assetDecimals: 6,
      amountUsdNominal: 10_000,
      horizonsHours: [...DESIGN.horizonsHours],
      episodeUnit: 'holder-vault-anchor',
      dependencyClusterUnit: 'holder-vault',
      analysisSelection: 'post_archive_descriptive_slice',
      analysisSelectionPredeclared: false,
      developmentAnchors: DESIGN.anchors.filter(
        (anchor) => anchor !== DESIGN.reservedHoldoutAnchor,
      ),
      reservedAnchor: DESIGN.reservedHoldoutAnchor,
      reservedAnchorUntouched: false,
    },
    denominators: {
      plannedVaultAnchorCells: plan.cells.length,
      completedVaultAnchorCells: cellsByKey.size,
      missingVaultAnchorCells: missingCells,
      completedCellStatus,
      fixed10kEligibleEpisodes,
      fixed10kEligibleOtherBaselineClassEpisodes,
      fixed10kExclusionReason,
    },
    riskSets: {
      callableToExactCallImpairment: {
        definition:
          'baseline exact same-holder fixed-$10k withdraw call succeeded; endpoint is first later covered eth_call revert',
        all: summarizeCallable(callable),
        strata: strataFor(callable, summarizeCallable),
      },
      baselineCoveredRevertToFirstLaterSuccess: {
        definition:
          'baseline exact same-holder fixed-$10k withdraw call covered the requested shares but reverted; endpoint is first later success',
        all: summarizeImpaired(impaired),
        strata: strataFor(impaired, summarizeImpaired),
      },
      sharedHolderVaultClusters: overlap,
    },
    boundaries: {
      commonPanelPooled: false,
      commonPanelRelation:
        'The common 25-route panel remains a separate cohort and denominator; none of its rows are pooled into this stable-vault audit.',
      transitionName: 'exact-call impairment',
      liquidityCauseEstablished: false,
      fittedProbabilityAvailable: false,
      likelyDurationAvailable: false,
      postArchiveDescriptiveSlice: true,
      reservedAnchorUsedAsUntouchedHoldout: false,
      prospectiveValidation: false,
      sourceRevalidatedAgainstRpc: false,
      interpretation:
        'Intervals are bounded only by the frozen sampled calls. A revert does not establish liquidity as its cause.',
    },
  }
}

/** Verify canonical plan/cell bytes and their embedded SHAs; never open an RPC client. */
export function readSavedFixed10kTransitionAudit(directory = DEFAULT_DIRECTORY) {
  const names = readdirSync(directory)
  const planNames = names.filter((name) => /^plan-[0-9a-f]{64}\.json$/.test(name))
  if (planNames.length !== 1) throw Error('transition_plan_count_invalid')
  const planBytes = readFileSync(join(directory, planNames[0]))
  const plan = JSON.parse(planBytes.toString('utf8'))
  validatePlan(plan)
  if (
    planNames[0] !== `plan-${plan.planSha256}.json` ||
    planBytes.toString('utf8') !== `${JSON.stringify(plan, null, 2)}\n`
  )
    throw Error('transition_plan_artifact_invalid')

  const planned = new Set(plan.cells.map((cell) => `${cell.anchorBlock}:${cell.vault}`))
  const cellNames = names.filter((name) => name.startsWith('cell-'))
  for (const name of cellNames) {
    const match = name.match(/^cell-([0-9a-f]{64})-(\d+)-(0x[0-9a-f]{40})-([0-9a-f]{64})\.json$/)
    if (!match || match[1] !== plan.planSha256 || !planned.has(`${Number(match[2])}:${match[3]}`))
      throw Error('transition_cell_artifact_invalid')
  }

  const completed = []
  const cellEvidence = []
  for (const frozen of plan.cells) {
    const saved = readSavedCell(plan, frozen.anchorBlock, frozen.vault, directory)
    if (!saved) continue
    completed.push(saved.cell)
    cellEvidence.push(
      `${saved.cell.anchorBlock}:${saved.cell.vault}:${saved.cell.cellSha256}:${saved.sha256}`,
    )
  }
  cellEvidence.sort()
  return describeFixed10kTransitionAudit(plan, completed, {
    planSha256: plan.planSha256,
    planFileSha256: sha(planBytes),
    canonicalPlanBytesVerified: true,
    canonicalCellBytesVerified: true,
    validatedCellArtifacts: completed.length,
    validatedCellArtifactSetSha256: sha(cellEvidence.join('\n')),
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv[2] === '--help') {
      process.stdout.write(
        'usage: node morpho-stable-fixed-10k-transition-audit.mjs [saved-directory]\n',
      )
    } else if (process.argv.length > 3) {
      throw Error('transition_arguments_invalid')
    } else {
      process.stdout.write(
        `${JSON.stringify(readSavedFixed10kTransitionAudit(process.argv[2]), null, 2)}\n`,
      )
    }
  } catch (error) {
    process.stderr.write(`${error?.message || 'transition_audit_failed'}\n`)
    process.exitCode = 1
  }
}
