import assert from 'node:assert/strict'
import test from 'node:test'

import { RECEIPT } from './carry-public-apyusd-exit-common.mjs'
import {
  buildContinuityRow,
  captureContinuity,
  validateContinuityRows,
} from './apyusd-open-receipt-continuity.mjs'

const EXPECTED = {
  source: {
    transfersSha256: 'a'.repeat(64),
    escrowSha256: 'b'.repeat(64),
    boundariesSha256: 'c'.repeat(64),
  },
  subjects: Array.from({ length: 7 }, (_, index) => ({
    tokenId: String(881 + index),
    holder: '0x1111111111111111111111111111111111111111',
    receiptEscrowRaw: '1000',
    issuedAt: 100,
    claimableAt: 259300,
  })),
}

function observation({ number = 1, status = 'same_holder', at = '2026-10-03T12:00:00.000Z' } = {}) {
  return {
    observationStatus: 'unsealed',
    scope: 'current_status_of_frozen_historical_open_receipts',
    prospectiveQForecast: false,
    holderCodeChecked: true,
    source: EXPECTED.source,
    receipt: RECEIPT,
    origins: ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'],
    block: {
      number,
      hash: `0x${number.toString(16).padStart(64, '0')}`,
      timestamp: Math.floor(Date.parse(at) / 1000) - 60,
    },
    observedAtUtc: at,
    subjects: EXPECTED.subjects,
    proofs: EXPECTED.subjects.map(({ tokenId }, index) => ({
      tokenId,
      ...(index === 2 && status === 'holder_changed'
        ? { status, currentOwner: '0x2222222222222222222222222222222222222222' }
        : index === 2 && status === 'no_current_owner'
          ? { status }
          : {
              status: 'same_holder',
              isClaimable: true,
              claimStatus: 'success',
              claimAmountRaw: '966',
            }),
      holderCodeStatus: 'no_code',
    })),
  }
}

test('continuity rows link distinct finalized blocks and preserve absent or transferred receipts', () => {
  const first = buildContinuityRow(observation(), null, EXPECTED)
  const second = buildContinuityRow(
    observation({ number: 2, status: 'holder_changed', at: '2026-10-03T12:01:00.000Z' }),
    first,
    EXPECTED,
  )
  const third = buildContinuityRow(
    observation({ number: 3, status: 'no_current_owner', at: '2026-10-03T12:02:00.000Z' }),
    second,
    EXPECTED,
  )
  assert.equal(second.previousSha256, first.sha256)
  assert.equal(second.proofs[2].claimStatus, undefined)
  assert.equal(third.proofs[2].claimStatus, undefined)
  assert.equal(third.terminalPayoutVerified, false)
  assert.equal(third.prospectiveQForecast, false)
  assert.equal(validateContinuityRows([first, second, third], EXPECTED).length, 3)
  assert.throws(() => validateContinuityRows([second], EXPECTED), /apyusd_continuity_row_invalid/)
})

test('a forged optimistic claim or terminal payout fails even when the row is resealed', () => {
  const row = buildContinuityRow(observation(), null, EXPECTED)
  const falsePayout = { ...row, terminalPayoutVerified: true }
  assert.throws(
    () => validateContinuityRows([falsePayout], EXPECTED),
    /apyusd_continuity_row_invalid/,
  )
  const wrongAmount = structuredClone(row)
  wrongAmount.proofs[0].claimAmountRaw = '1001'
  assert.throws(
    () => validateContinuityRows([wrongAmount], EXPECTED),
    /apyusd_current_proof_invalid/,
  )
  const stale = { ...observation(), observedAtUtc: '2026-10-03T13:00:00.000Z' }
  assert.throws(() => buildContinuityRow(stale, null, EXPECTED), /apyusd_continuity_time_invalid/)
})

test('disk reserve refuses capture before loading sources, opening RPC, or writing', async () => {
  let calls = 0
  await assert.rejects(
    captureContinuity({
      freeBytes: () => 0,
      sourceLoader: async () => {
        calls++
        return EXPECTED
      },
      observer: async () => {
        calls++
        return observation()
      },
      writer: async () => {
        calls++
      },
    }),
    /apyusd_continuity_disk_reserve/,
  )
  assert.equal(calls, 0)
})
