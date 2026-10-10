import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { buildSubjectManifest } from '../record-carry-cash-issues.mjs'
import { loadPinnedAudit } from './conditional-cash-time-holdout.mjs'
import {
  BACKTEST_FILE,
  authenticateFundingBacktest,
  buildAllVenueRetrospectiveFundingCoverage,
  reconcileFundingCoverage,
} from './all-venue-retrospective-funding-backtest.mjs'

const manifest = await buildSubjectManifest()
const audit = loadPinnedAudit()
const text = readFileSync(BACKTEST_FILE, 'utf8')
const backtest = authenticateFundingBacktest(text)
const build = (m = manifest, b = backtest) => reconcileFundingCoverage(m, audit, b)

test('authenticated frozen roster has all 25 groups/67 exact destinations and separate supplemental', async () => {
  const report = await buildAllVenueRetrospectiveFundingCoverage()
  assert.deepEqual(report.counts, {
    coreGroups: 25,
    coreDestinations: 67,
    nativeOriginalAssetFundingGroups: 21,
    nativeOriginalAssetFundingDestinations: 63,
    excludedFinalOriginalAssetGroups: 4,
    excludedFinalOriginalAssetDestinations: 4,
    supplementalGroups: 1,
    supplementalDestinations: 1,
  })
  const rows = report.groups.flatMap((group) => group.destinations)
  assert.equal(
    new Set(rows.map((row) => `${row.identity.routeKey}\0${row.identity.destination}`)).size,
    67,
  )
  assert.equal(report.supplemental.histories[0].identity.routeKey, 'USDe → supply on Aave V3')
  assert.equal(
    rows.some((row) => row.identity.routeKey === 'USDe → supply on Aave V3'),
    false,
  )
})

test('four foreign stages stay excluded; USDC bridge never becomes original USDT funding', () => {
  const rows = build().groups.flatMap((group) => group.destinations)
  const excluded = rows.filter((row) => row.exclusion)
  assert.equal(excluded.length, 4)
  assert.ok(
    excluded.every(
      (row) =>
        row.horizons.length === 0 &&
        row.nativeFinalOriginalAssetHistory === false &&
        row.censorReasons.includes('foreign_final_payout'),
    ),
  )
  const bridge = excluded.find(
    (row) => row.identity.destination === '0x273da948aca9261043fbdb2a857bc255ecc29012',
  )
  assert.equal(bridge.identity.asset, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')
  assert.equal(bridge.scope, 'partial_or_foreign_asset_stage_only')
})

test('funding diagnostics retain original folds, errors and censors without holder claims', () => {
  for (const row of build().groups.flatMap((group) => group.destinations)) {
    assert.equal(row.holderFacts, 'holder_facts_unavailable')
    assert.equal(row.probability, null)
    assert.equal(row.forecastValidated, false)
    assert.equal(row.prospectiveValidated, false)
    assert.equal(row.holderExecutableExit, false)
    for (const fact of ['E', 'Q', 'M', 'sourceAuthority'])
      assert.equal(Object.hasOwn(row, fact), false)
    if (row.historyKey)
      assert.deepEqual(
        row.horizons,
        backtest.historyResults.find((history) => history.historyKey === row.historyKey).horizons,
      )
  }
  assert.deepEqual(build().jointFunding, { susde: backtest.susdeJoint, apy: backtest.apyJoint })
})

test('tampered saved backtest bytes and roster pin fail closed', () => {
  assert.throws(() => authenticateFundingBacktest(text + ' '), /backtest_file_pin_mismatch/)
  assert.throws(() => build({ ...manifest, sha256: '0'.repeat(64) }), /roster_pin_mismatch/)
  const copy = structuredClone(manifest)
  copy.subjects[0].asset = '0x' + '1'.repeat(40)
  assert.throws(() => build(copy), /roster_pin_mismatch/)
})

test('duplicate, missing and mismatched exact history identities are rejected', () => {
  const duplicate = structuredClone(backtest)
  duplicate.historyResults[1] = duplicate.historyResults[0]
  assert.throws(() => build(manifest, duplicate), /history_identity_or_acquisition/)
  const missing = structuredClone(backtest)
  missing.historyResults.pop()
  assert.throws(() => build(manifest, missing), /backtest_shape/)
  const wrongAsset = structuredClone(backtest)
  wrongAsset.historyResults[0].identity.asset = '0x' + '1'.repeat(40)
  assert.throws(() => build(manifest, wrongAsset), /history_identity_or_acquisition/)
})

test('analysis before authenticated acquisition and altered exclusion partition are rejected', () => {
  const early = structuredClone(backtest)
  early.analysisAtUtc = '2026-10-01T00:00:00.000Z'
  assert.throws(() => build(manifest, early), /history_identity_or_acquisition/)
  const changed = structuredClone(backtest)
  changed.exclusions[0].reason = 'native'
  assert.throws(() => build(manifest, changed), /exclusion_mismatch/)
})

test('supplemental cannot be substituted with another exact identity', () => {
  const changed = structuredClone(manifest)
  changed.supplementalSubjects[0].destination = '0x' + '1'.repeat(40)
  assert.throws(() => build(changed), /supplemental_partition/)
})

test('joint sUSDe and APY acquisition clocks cannot cross the actual analysis time', () => {
  for (const kind of ['susde', 'apy']) {
    const changed = structuredClone(backtest)
    if (kind === 'susde')
      changed.susdeJoint.acquisitionClocks[0].availableAtUtc = '2026-10-09T00:00:00.000Z'
    else changed.apyJoint.acquisitionAtUtc = '2026-10-09T00:00:00.000Z'
    assert.throws(() => build(manifest, changed), /joint_acquisition_after_analysis/)
  }
})
