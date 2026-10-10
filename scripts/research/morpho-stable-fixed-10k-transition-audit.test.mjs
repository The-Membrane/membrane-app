import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { lossIntervals } from './carry-morpho-exit-history-grid.mjs'
import { readSavedCell } from './carry-morpho-stable-exit-history.mjs'
import {
  DEFAULT_DIRECTORY,
  describeFixed10kTransitionAudit,
  readSavedFixed10kTransitionAudit,
} from './morpho-stable-fixed-10k-transition-audit.mjs'

const stratum = (riskSet, assetSymbol, anchorSplit) =>
  riskSet.strata.find(
    (entry) => entry.assetSymbol === assetSymbol && entry.anchorSplit === anchorSplit,
  )

const sha = (value) => createHash('sha256').update(value).digest('hex')

function readArchive() {
  const planName = readdirSync(DEFAULT_DIRECTORY).find((name) => name.startsWith('plan-'))
  assert.ok(planName)
  const plan = JSON.parse(readFileSync(join(DEFAULT_DIRECTORY, planName), 'utf8'))
  const cells = plan.cells.map((frozen) => {
    const saved = readSavedCell(plan, frozen.anchorBlock, frozen.vault, DEFAULT_DIRECTORY)
    assert.ok(saved)
    return saved.cell
  })
  return { plan, cells }
}

test('replays the sealed fixed-$10k archive into two disjoint descriptive risk sets', () => {
  const report = readSavedFixed10kTransitionAudit()
  assert.equal(
    report.evidence.planSha256,
    '4d200e6aad83715eabe7ced460aa599615e2627df68d55160f0096baacfef661',
  )
  assert.equal(
    report.evidence.planFileSha256,
    'ce8e1720325dad54503c105cffca30505285157ff691ca666406e80f609842a8',
  )
  assert.equal(
    report.evidence.validatedCellArtifactSetSha256,
    '6095f87ab4bdb9a23e63c8a4a62cfed7c7baae5b27a31eeb79e8f176d960d004',
  )
  assert.equal(report.evidence.canonicalPlanBytesVerified, true)
  assert.equal(report.evidence.canonicalCellBytesVerified, true)
  assert.equal(report.evidence.validatedCellArtifacts, 160)
  assert.equal(report.denominators.plannedVaultAnchorCells, 160)
  assert.equal(report.denominators.completedVaultAnchorCells, 160)
  assert.equal(report.denominators.missingVaultAnchorCells, 0)
  assert.equal(report.denominators.fixed10kEligibleEpisodes, 51)
  assert.deepEqual(report.denominators.fixed10kExclusionReason, {
    cell_no_eligible_holder: 77,
    exceeds_anchor_holder_claim: 28,
    cell_unfunded_at_anchor: 4,
  })

  const callable = report.riskSets.callableToExactCallImpairment
  assert.deepEqual(callable.all.counts, {
    baselineCallableEpisodes: 43,
    observedExactCallImpairmentOnsetEpisodes: 2,
    noObservedExactCallImpairmentOnsetEpisodes: 41,
    callableRightCensoredEpisodes: 25,
    holderAttritionCensoredBeforeOnsetEpisodes: 15,
    holderTypeChangedCensoredBeforeOnsetEpisodes: 1,
    identityChangedCensoredBeforeOnsetEpisodes: 0,
    otherObservationCensoredBeforeOnsetEpisodes: 0,
    postOnsetRecoveryEpisodes: 1,
    postOnsetRecoveryRightCensoredEpisodes: 1,
    postOnsetTerminalCensoredEpisodes: 0,
    episodesWithMissingHorizonSamples: 0,
  })
  assert.equal(callable.all.uniqueHolderVaultAnchorEpisodes, 43)
  assert.equal(callable.all.uniqueHolderVaultClusters, 43)
  assert.deepEqual(callable.all.holderVaultClustersByAnchorMultiplicity, { 1: 43 })
  assert.equal(callable.all.maximumAnchorMultiplicity, 1)
  assert.deepEqual(callable.all.onsetIntervalsHours, {
    '(24,48]': 1,
    '(48,168]': 1,
  })
  assert.deepEqual(callable.all.postOnsetRecoveryIntervalsHours, { '(48,168]': 1 })
  assert.deepEqual(callable.all.postOnsetRecoveryRightCensoredAtHours, { 168: 1 })
  assert.equal(stratum(callable, 'USDC', 'development').counts.baselineCallableEpisodes, 28)
  assert.equal(
    stratum(callable, 'USDC', 'development').counts.observedExactCallImpairmentOnsetEpisodes,
    1,
  )
  assert.equal(stratum(callable, 'USDT', 'development').counts.baselineCallableEpisodes, 4)
  assert.equal(
    stratum(callable, 'USDT', 'development').counts.postOnsetRecoveryRightCensoredEpisodes,
    1,
  )
  assert.equal(stratum(callable, 'USDC', 'reservedAnchor').counts.baselineCallableEpisodes, 11)
  assert.equal(stratum(callable, 'USDT', 'reservedAnchor').counts.baselineCallableEpisodes, 0)

  const impaired = report.riskSets.baselineCoveredRevertToFirstLaterSuccess
  assert.deepEqual(impaired.all.counts, {
    baselineCoveredRevertEpisodes: 8,
    observedFirstLaterSuccessEpisodes: 1,
    stillImpairedRightCensoredEpisodes: 5,
    holderAttritionCensoredBeforeRecoveryEpisodes: 2,
    holderTypeChangedCensoredBeforeRecoveryEpisodes: 0,
    identityChangedCensoredBeforeRecoveryEpisodes: 0,
    otherObservationCensoredBeforeRecoveryEpisodes: 0,
    episodesWithMissingHorizonSamples: 0,
  })
  assert.equal(impaired.all.uniqueHolderVaultAnchorEpisodes, 8)
  assert.equal(impaired.all.uniqueHolderVaultClusters, 5)
  assert.deepEqual(impaired.all.holderVaultClustersByAnchorMultiplicity, { 1: 4, 4: 1 })
  assert.equal(impaired.all.maximumAnchorMultiplicity, 4)
  assert.deepEqual(impaired.all.recoveryIntervalsHours, { '(48,168]': 1 })
  assert.deepEqual(impaired.all.recoveryRightCensoredAtHours, { 168: 5 })
  assert.deepEqual(impaired.all.terminalCensorIntervalsHours, {
    'holder_attrition:(24,48]': 1,
    'holder_attrition:(48,168]': 1,
  })
  assert.equal(stratum(impaired, 'USDC', 'development').counts.baselineCoveredRevertEpisodes, 7)
  assert.equal(
    stratum(impaired, 'USDC', 'reservedAnchor').counts.observedFirstLaterSuccessEpisodes,
    1,
  )
  assert.equal(report.riskSets.sharedHolderVaultClusters, 0)
  assert.equal(report.fixedQuestion.episodeUnit, 'holder-vault-anchor')
  assert.equal(report.fixedQuestion.dependencyClusterUnit, 'holder-vault')
  assert.equal(report.fixedQuestion.analysisSelection, 'post_archive_descriptive_slice')
  assert.equal(report.fixedQuestion.analysisSelectionPredeclared, false)
  assert.equal(report.fixedQuestion.reservedAnchorUntouched, false)
  assert.equal(report.boundaries.commonPanelPooled, false)
  assert.equal(report.boundaries.transitionName, 'exact-call impairment')
  assert.equal(report.boundaries.liquidityCauseEstablished, false)
  assert.equal(report.boundaries.fittedProbabilityAvailable, false)
  assert.equal(report.boundaries.likelyDurationAvailable, false)
  assert.equal(report.boundaries.postArchiveDescriptiveSlice, true)
  assert.equal(report.boundaries.reservedAnchorUsedAsUntouchedHoldout, false)
  assert.equal('episodes' in report, false)
  assert.equal('cells' in report, false)
})

test('rejects one holder-vault dependency cluster split across baseline risk sets', () => {
  const { plan, cells } = readArchive()
  const repeated = new Map()
  for (const cell of cells) {
    const size = cell.row?.sizes?.find((candidate) => candidate.label === 'fixed_10k')
    if (!size?.eligible || size.baseline.class !== 'evm_revert') continue
    const key = `${cell.row.holder}:${cell.vault}`
    if (!repeated.has(key)) repeated.set(key, [])
    repeated.get(key).push(cell)
  }
  const source = [...repeated.values()].find((episodes) => episodes.length > 1)?.[0]
  assert.ok(source)

  const changed = structuredClone(source)
  const size = changed.row.sizes.find((candidate) => candidate.label === 'fixed_10k')
  size.baseline.call = { status: 'success', sharesBurnedRaw: '1' }
  size.baseline.class = 'success'
  size.exitInterval = lossIntervals(size)
  const { cellSha256: _oldCellSha256, ...unsigned } = changed
  changed.cellSha256 = sha(JSON.stringify(unsigned))
  const changedCells = cells.map((cell) =>
    cell.anchorBlock === changed.anchorBlock && cell.vault === changed.vault ? changed : cell,
  )

  assert.throws(
    () => describeFixed10kTransitionAudit(plan, changedCells),
    /transition_holder_vault_risk_sets_overlap/,
  )
})

test('rejects noncanonical plan and cell artifacts before counting', () => {
  const names = readdirSync(DEFAULT_DIRECTORY)
  const planName = names.find((name) => name.startsWith('plan-'))
  const cellName = names.find((name) => name.startsWith('cell-'))
  assert.ok(planName)
  assert.ok(cellName)

  const badPlanDirectory = mkdtempSync(join(tmpdir(), 'morpho-transition-plan-'))
  const badCellDirectory = mkdtempSync(join(tmpdir(), 'morpho-transition-cell-'))
  try {
    copyFileSync(join(DEFAULT_DIRECTORY, planName), join(badPlanDirectory, planName))
    appendFileSync(join(badPlanDirectory, planName), '\n')
    assert.throws(
      () => readSavedFixed10kTransitionAudit(badPlanDirectory),
      /transition_plan_artifact_invalid/,
    )

    copyFileSync(join(DEFAULT_DIRECTORY, planName), join(badCellDirectory, planName))
    copyFileSync(join(DEFAULT_DIRECTORY, cellName), join(badCellDirectory, cellName))
    appendFileSync(join(badCellDirectory, cellName), '\n')
    assert.throws(
      () => readSavedFixed10kTransitionAudit(badCellDirectory),
      /cell_artifact_content_invalid/,
    )
  } finally {
    rmSync(badPlanDirectory, { recursive: true, force: true })
    rmSync(badCellDirectory, { recursive: true, force: true })
  }
})
