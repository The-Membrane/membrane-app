import assert from 'node:assert/strict'
import test from 'node:test'

import assessmentModule from '../../lib/carry/holderExitAssessment.ts'
import { buildSubjectManifest } from '../record-carry-cash-issues.mjs'

const { resolveHolderExitSubject, validateHolderExitAssessmentRequest } = assessmentModule
const ADDRESS = /^0x[0-9a-f]{40}$/i
const TRANSFORMED_PAYOUT_KINDS = new Set([
  'staked_usdat',
  'pyusd_staking',
  'twyne_pt',
  'fluid_usdt',
])

test('every frozen exact subject has an on-demand holder/Q resolver', async () => {
  const manifest = await buildSubjectManifest()
  assert.equal(new Set(manifest.subjects.map((subject) => subject.route_key)).size, 25)
  assert.equal(manifest.subjects.length, 67)

  const failures = []
  for (const subject of manifest.subjects) {
    try {
      const target = resolveHolderExitSubject(subject.route_key, subject.destination)
      if (!ADDRESS.test(target.payoutAsset)) {
        failures.push({ subject, reason: 'payout_asset_invalid' })
      } else if (
        target.payoutAsset.toLowerCase() !== subject.asset.toLowerCase() &&
        !TRANSFORMED_PAYOUT_KINDS.has(target.kind)
      ) {
        failures.push({ subject, reason: 'new_asset_transformation', kind: target.kind })
      }
    } catch (error) {
      failures.push({ subject, reason: String(error?.message ?? error) })
    }
  }
  assert.deepEqual(failures, [])
})

test('a future unregistered route abstains before any provider call', () => {
  assert.throws(
    () => resolveHolderExitSubject('future route', '0x0000000000000000000000000000000000000001'),
    /holder_exit_subject_unsupported/,
  )
})

test('every frozen subject accepts a holder/Q request with required first-leg inputs', async () => {
  const manifest = await buildSubjectManifest()
  const failures = []
  for (const subject of manifest.subjects) {
    try {
      const target = resolveHolderExitSubject(subject.route_key, subject.destination)
      const request = {
        routeKey: subject.route_key,
        destinationAddress: subject.destination,
        owner: '0x1111111111111111111111111111111111111111',
        assetsRaw: '1',
        horizonHours: 24,
        ...(target.kind === 'fluid_usdt' ? { firstLegUsdcRaw: '1' } : {}),
        ...(target.kind === 'staked_usdat' ? { sharesRaw: '1' } : {}),
        ...(target.kind === 'twyne_pt'
          ? {
              collateralVault: '0x2222222222222222222222222222222222222222',
              ptRaw: '1',
            }
          : {}),
      }
      assert.equal(validateHolderExitAssessmentRequest(request).kind, target.kind)
    } catch (error) {
      failures.push({ subject, reason: String(error?.message ?? error) })
    }
  }
  assert.deepEqual(failures, [])
})
