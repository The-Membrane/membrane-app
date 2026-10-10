import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { buildSubjectManifest } from '../record-carry-cash-issues.mjs'
import {
  appendLocalCarryExitV2Record,
  verifyLocalCarryExitV2Ledger,
} from './localCarryExitV2Store.mjs'
import { CARRY_EXIT_V2_FROZEN_ROUTES } from './carry-exit-v2-rpc-proof.mjs'
import {
  buildLocalCarryExitV2HistoricalRoster,
  buildLocalCarryExitV2HistoricalUnavailableAttempt,
  LOCAL_CARRY_EXIT_V2_HISTORICAL_ROSTER as roster,
  LOCAL_CARRY_EXIT_V2_MISSING_REASONS,
  selectLocalCarryExitV2HistoricalSubjects,
  summarizeLocalCarryExitV2HistoricalRoster,
} from './localCarryExitV2HistoricalRoster.mjs'

const expectedMissing = {
  'apxUSD → ApyUSD [apxUSD]': 'apyusd_receipt_claim_semantics_missing',
  'AUSD → Staked USDat [USDat]': 'saturn_final_ausd_delivery_semantics_missing',
  'PYUSD → StakingVault [wYLDS]': 'pyusd_final_payout_semantics_missing',
  'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]': 'pt_to_usde_final_delivery_semantics_missing',
  'USDe → Staked USDe [USDe]': 'susde_arbitrary_q_initiation_claim_semantics_missing',
  'USDT → FluidBridgeAggregatorProxy [USDC]': 'fluid_usdc_to_usdt_conversion_semantics_missing',
}

test('historical denominator is 26/68; 62 registry intersection divides into 58 supported and 4 Fluid', () => {
  assert.deepEqual(summarizeLocalCarryExitV2HistoricalRoster(), {
    routeGroups: 26,
    exactSubjects: 68,
    frozenRouteGroups: 25,
    frozenSubjects: 67,
    supplementalSubjects: 1,
    registryIntersection: 62,
    supportedDispatchSubjects: 58,
    presentDispatchUnprovenSubjects: 4,
    missingFinalDeliverySubjects: 6,
    forecastValidated: false,
    holderExecutableExit: false,
  })
  assert.ok(CARRY_EXIT_V2_FROZEN_ROUTES.length > roster.length)
  assert.equal(new Set(roster.map((row) => row.subjectId)).size, 68)
  assert.ok(Object.isFrozen(roster))
  assert.ok(roster.every(Object.isFrozen))
})

test('frozen roster agrees exactly with authoritative historical manifest and supplemental subject', async () => {
  const manifest = await buildSubjectManifest()
  const expected = [...manifest.subjects, ...manifest.supplementalSubjects].map((row) => [
    row.route_key,
    row.destination,
    row.asset,
  ])
  assert.deepEqual(
    roster.map((row) => [row.routeKey, row.destination, row.manifestAsset]),
    expected,
  )
  assert.ok(roster.every((row) => row.frozenManifestSha256 === manifest.sha256))
  const supplemental = roster.filter((row) => row.supplemental)
  assert.equal(supplemental.length, 1)
  assert.equal(supplemental[0].routeKey, 'USDe → supply on Aave V3')
  assert.equal(supplemental[0].destination, '0x4f5923fc5fd4a93352581b38b7cd26943012decf')
  assert.equal(supplemental[0].coverageStatus, 'prospective_registry_supported')
})

test('six staged final delivery gaps have exact typed reasons', () => {
  assert.deepEqual(LOCAL_CARRY_EXIT_V2_MISSING_REASONS, expectedMissing)
  assert.deepEqual(
    Object.fromEntries(
      roster
        .filter((row) => row.coverageStatus === 'missing_final_delivery_semantics')
        .map((row) => [row.routeKey, row.unavailableReason]),
    ),
    expectedMissing,
  )
  const fluid = roster.filter((row) => row.coverageStatus === 'registry_present_dispatch_unproven')
  assert.equal(fluid.length, 4)
  assert.ok(
    fluid.every(
      (row) => row.registryKind === 'fluid' && row.unavailableReason === 'fluid_delivery_unproven',
    ),
  )
})

test('original payout and intermediate manifest units stay separate', () => {
  const intermediate = roster.filter((row) => !row.manifestAssetIsOriginalPayout)
  assert.deepEqual(
    intermediate.map((row) => row.routeKey),
    [
      'AUSD → Staked USDat [USDat]',
      'PYUSD → StakingVault [wYLDS]',
      'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]',
      'USDT → FluidBridgeAggregatorProxy [USDC]',
    ],
  )
  assert.ok(intermediate.every((row) => row.manifestAssetScope === 'intermediate_asset'))
  assert.ok(
    roster.every(
      (row) =>
        row.manifestIdentityDoesNotProveFinalDelivery &&
        !row.forecastValidated &&
        !row.holderExecutableExit,
    ),
  )
  const saturn = intermediate[0]
  assert.equal(saturn.originalPayoutAsset, '0x00000000efe302beaa2b3e6e1b18d08d69a9012a')
  assert.equal(saturn.originalPayoutDecimals, 6)
  assert.equal(
    roster.find((row) => row.originalPayoutSymbol === 'EURCV').originalPayoutDecimals,
    18,
  )
})

test('registry changes cannot silently assert staged support, and duplicate identities reject', () => {
  const missing = roster.find((row) => row.routeKey === 'AUSD → Staked USDat [USDat]')
  const added = buildLocalCarryExitV2HistoricalRoster([
    ...CARRY_EXIT_V2_FROZEN_ROUTES,
    {
      routeKey: missing.routeKey,
      destination: missing.destination,
      asset: missing.manifestAsset,
      kind: 'susds',
    },
  ])
  assert.equal(
    added.find((row) => row.subjectId === missing.subjectId).coverageStatus,
    'missing_final_delivery_semantics',
  )
  assert.throws(
    () =>
      buildLocalCarryExitV2HistoricalRoster([
        ...CARRY_EXIT_V2_FROZEN_ROUTES,
        CARRY_EXIT_V2_FROZEN_ROUTES[0],
      ]),
    /registry_duplicate/,
  )
  assert.equal(
    summarizeLocalCarryExitV2HistoricalRoster(buildLocalCarryExitV2HistoricalRoster([]))
      .missingFinalDeliverySubjects,
    68,
  )
})

test('stable bounded slot rotation visits every subject, including unsupported subjects', () => {
  assert.equal(
    new Set(
      Array.from(
        { length: 68 },
        (_, slotIndex) => selectLocalCarryExitV2HistoricalSubjects({ slotIndex })[0].subjectId,
      ),
    ).size,
    68,
  )
  assert.deepEqual(selectLocalCarryExitV2HistoricalSubjects({ slotIndex: 67, limit: 2 }), [
    roster[67],
    roster[0],
  ])
  assert.deepEqual(selectLocalCarryExitV2HistoricalSubjects({ slotIndex: 68 }), [roster[0]])
  for (const input of [
    { slotIndex: -1 },
    { slotIndex: 1.2 },
    { slotIndex: 0, limit: 0 },
    { slotIndex: 0, limit: 69 },
  ])
    assert.throws(() => selectLocalCarryExitV2HistoricalSubjects(input), /selection_invalid/)
})

test('unavailable attempt is stable per original payout Q and slot, with explicit denominator provenance', () => {
  for (const subject of roster.filter((row) => row.unavailableReason)) {
    const input = {
      subjectId: subject.subjectId,
      slotAtUtc: '2026-10-07T12:00:00.000Z',
      assetsRaw: '1000',
    }
    const attempt = buildLocalCarryExitV2HistoricalUnavailableAttempt(input)
    assert.deepEqual(attempt, buildLocalCarryExitV2HistoricalUnavailableAttempt(input))
    assert.equal(attempt.asset, subject.originalPayoutAsset)
    assert.equal(attempt.decimals, subject.originalPayoutDecimals)
    assert.equal(attempt.manifestAsset, subject.manifestAsset)
    assert.equal(attempt.reason, subject.unavailableReason)
    assert.equal(attempt.status, 'unavailable')
    assert.equal(attempt.forecastValidated, false)
    assert.equal(attempt.holderExecutableExit, false)
    assert.notEqual(
      attempt.attemptId,
      buildLocalCarryExitV2HistoricalUnavailableAttempt({ ...input, assetsRaw: '1001' }).attemptId,
    )
  }
})

test('unavailable attempt rejects fake identities, supported subjects, noncanonical time and Q', () => {
  const subject = roster.find((row) => row.unavailableReason)
  const valid = {
    subjectId: subject.subjectId,
    slotAtUtc: '2026-10-07T12:00:00.000Z',
    assetsRaw: '1',
  }
  for (const patch of [
    { subjectId: 'fake' },
    { subjectId: roster.find((row) => !row.unavailableReason).subjectId },
    { slotAtUtc: '2026-10-07' },
    { assetsRaw: '0' },
    { assetsRaw: 1 },
    { assetsRaw: '01' },
    { assetsRaw: (1n << 256n).toString() },
  ])
    assert.throws(() => buildLocalCarryExitV2HistoricalUnavailableAttempt({ ...valid, ...patch }))
})

test('all ten unavailable denominator payloads persist once in the local ledger', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'historical-denominator-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = join(directory, 'ledger')
  const slotAtUtc = '2026-10-07T12:00:00.000Z'
  for (const subject of roster.filter((row) => row.unavailableReason)) {
    const payload = buildLocalCarryExitV2HistoricalUnavailableAttempt({
      subjectId: subject.subjectId,
      slotAtUtc,
      assetsRaw: '1000',
    })
    appendLocalCarryExitV2Record('attempt', payload, {
      root,
      now: Date.parse(slotAtUtc),
      minFreeBytes: 0,
    })
  }
  const ledger = verifyLocalCarryExitV2Ledger({ root })
  assert.equal(ledger.records.length, 10)
  assert.equal(ledger.attempts.size, 10)
  assert.equal(ledger.issues.size, 0)
})
