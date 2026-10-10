import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  APXUSD_ASSET,
  APYUSD_ROUTE,
  APYUSD_VAULT,
  readApyUsdExit,
  type ApyUsdExitResult,
} from '@/lib/carry/apyUsdExit'
import { readHolderExitAssessment } from '@/lib/carry/holderExitAssessment'

vi.mock('@/lib/carry/apyUsdExit', async (original) => ({
  ...(await original<typeof import('@/lib/carry/apyUsdExit')>()),
  readApyUsdExit: vi.fn(),
}))

const hash = `0x${'a'.repeat(64)}` as const
const owner = '0x0000000000000000000000000000000000000001' as const
const timestamp = 1790814551
const feeCurve = {
  minFeeWad: '0',
  maxFeeWad: '34000000000000000',
  minDurationSeconds: 259_200,
  maxDurationSeconds: 1_728_000,
  curvatureWad: '1000000000000000000',
}
const receipt = {
  tokenId: '1000',
  ownership: 'holder' as const,
  escrowRaw: '9000000000000000000',
  createdAt: timestamp - 700_000,
  claimableAt: timestamp - 440_800,
  claimableNow: true,
  receiptPaused: false,
  currentFeeRaw: '200000000000000000',
  currentPreviewPayoutRaw: '8800000000000000000',
  claimSimulation: 'success' as const,
  simulatedClaimPayoutRaw: '8790000000000000000',
  delivery: 'not_observed' as const,
}
const request = {
  routeKey: APYUSD_ROUTE,
  destinationAddress: APYUSD_VAULT,
  owner,
  assetsRaw: '1000000000000000000',
  horizonHours: 168,
  receiptTokenId: '1000',
}
const apyRequest = vi.fn()
const apyClient = { request: apyRequest }
const clients = { apy: apyClient } as never
function observed() {
  return {
    status: 'observed' as const,
    evidence: { chainId: 1, blockNumber: 26093883, blockHash: hash, blockTimestamp: timestamp },
    current: {
      holderSharesRaw: '500000000000000000',
      maxWithdrawEscrowRaw: '2000000000000000000',
      requestedEscrowRaw: request.assetsRaw,
      previewSharesToBurnRaw: '90000000000000000',
      vaultPaused: false,
      initiation: {
        status: 'success' as const,
        sharesRaw: '90000000000000000',
        receiptTokenId: '1001',
      },
      currentFeeCurve: { ...feeCurve },
      currentMinimumClaimDelaySeconds: feeCurve.minDurationSeconds,
      ifInitiatedAtCheckedBlockClaimableAt: timestamp + feeCurve.minDurationSeconds,
      ifInitiatedAtCheckedBlockEarliestNetRaw: '966000000000000000',
      ifInitiatedAtCheckedBlockMinimumFeeAt: timestamp + feeCurve.maxDurationSeconds,
      ifInitiatedAtCheckedBlockMinimumFeeNetRaw: request.assetsRaw,
      payout: 'not_delivered_by_initiation' as const,
      existingReceipt: { ...receipt },
    },
  }
}
const supply = (result: unknown) =>
  vi.mocked(readApyUsdExit).mockResolvedValueOnce(result as ApyUsdExitResult)

describe('ApyUSD native facts in holder assessment', () => {
  beforeEach(() => {
    vi.mocked(readApyUsdExit).mockReset()
    apyRequest.mockReset().mockResolvedValue('0x')
  })

  it('transports full curve and old receipt E without clipping it to new Q or shares', async () => {
    const native = observed()
    supply(native)
    const result = await readHolderExitAssessment(clients, request)
    expect(result.apyUsdCondition).toMatchObject({
      currentFeeCurve: feeCurve,
      existingReceipt: receipt,
    })
    expect(result.apyUsdCondition?.currentFeeCurve).not.toBe(native.current.currentFeeCurve)
    expect(result.apyUsdCondition?.existingReceipt?.escrowRaw).toBe('9000000000000000000')
    expect(result.request.assetsRaw).toBe(request.assetsRaw)
    expect(result.stages).toMatchObject([
      {
        name: 'receipt_initiation',
        status: 'simulated',
        amountRaw: request.assetsRaw,
        relatedToRequest: true,
      },
      {
        name: 'receipt_claim',
        status: 'simulated',
        amountRaw: receipt.simulatedClaimPayoutRaw,
        relatedToRequest: false,
      },
    ])
    expect(result.existingReceiptClaim).toEqual({
      tokenId: receipt.tokenId,
      assetAddress: APXUSD_ASSET,
      status: 'simulated',
      amountRaw: receipt.simulatedClaimPayoutRaw,
      delivery: 'not_observed',
    })
    expect(result.finalPayout).toEqual({
      assetAddress: APXUSD_ASSET,
      status: 'unassessed',
      amountRaw: null,
    })
    expect(readApyUsdExit).toHaveBeenCalledTimes(1)
    expect(readApyUsdExit).toHaveBeenCalledWith(apyClient, {
      routeKey: APYUSD_ROUTE,
      destinationAddress: APYUSD_VAULT,
      holder: owner,
      assetsRaw: request.assetsRaw,
      receiptTokenId: '1000',
    })
    expect(apyRequest).toHaveBeenCalledTimes(1)
    expect(apyRequest).toHaveBeenCalledWith({
      method: 'eth_getCode',
      params: [owner, { blockHash: hash, requireCanonical: true }],
    })
  })

  it('keeps the owned old receipt when new initiation reverts and share capacity is zero', async () => {
    const native = observed()
    supply({
      ...native,
      current: {
        ...native.current,
        holderSharesRaw: '0',
        maxWithdrawEscrowRaw: '0',
        initiation: { status: 'evm_revert', reason: 'unknown_execution_constraint' },
      },
    })
    const result = await readHolderExitAssessment(clients, request)
    expect(result.apyUsdCondition?.existingReceipt).toEqual(receipt)
    expect(result.apyUsdCondition?.ifInitiatedAtCheckedBlockHorizonNetRaw).toBeNull()
    expect(result.stages[0].status).toBe('reverted')
    expect(result.stages[1]).toMatchObject({
      status: 'simulated',
      amountRaw: receipt.simulatedClaimPayoutRaw,
      relatedToRequest: false,
    })
    expect(result.existingReceiptClaim?.amountRaw).toBe(receipt.simulatedClaimPayoutRaw)
    expect(result.finalPayout.amountRaw).toBeNull()
  })

  it('keeps missing fee outlook unknown while retaining receipt and claim facts', async () => {
    const native = observed()
    supply({
      ...native,
      current: {
        ...native.current,
        currentFeeCurve: null,
        currentMinimumClaimDelaySeconds: null,
        ifInitiatedAtCheckedBlockClaimableAt: null,
        ifInitiatedAtCheckedBlockEarliestNetRaw: null,
        ifInitiatedAtCheckedBlockMinimumFeeAt: null,
        ifInitiatedAtCheckedBlockMinimumFeeNetRaw: null,
      },
    })
    const result = await readHolderExitAssessment(clients, request)
    expect(result.apyUsdCondition).toEqual({
      currentFeeCurve: null,
      currentMinimumClaimDelaySeconds: null,
      ifInitiatedAtCheckedBlockClaimableAt: null,
      ifInitiatedAtCheckedBlockEarliestNetRaw: null,
      ifInitiatedAtCheckedBlockMinimumFeeAt: null,
      ifInitiatedAtCheckedBlockMinimumFeeNetRaw: null,
      ifInitiatedAtCheckedBlockHorizonNetRaw: null,
      existingReceipt: receipt,
    })
    expect(result.stages.map((stage) => stage.status)).toEqual(['simulated', 'simulated'])
    expect(result.finalPayout.amountRaw).toBeNull()
  })

  it('transports an unknown old creation clock without replacing it with the checked block', async () => {
    const native = observed()
    supply({
      ...native,
      current: { ...native.current, existingReceipt: { ...receipt, createdAt: null } },
    })
    const result = await readHolderExitAssessment(clients, request)
    expect(result.apyUsdCondition?.existingReceipt).toEqual({ ...receipt, createdAt: null })
    expect(result.existingReceiptClaim?.amountRaw).toBe(receipt.simulatedClaimPayoutRaw)
  })

  it('returns an explicit null existing receipt when none was selected', async () => {
    const native = observed()
    supply({ ...native, current: { ...native.current, existingReceipt: null } })
    const { receiptTokenId: _, ...withoutReceipt } = request
    const result = await readHolderExitAssessment(clients, withoutReceipt)
    expect(result.apyUsdCondition?.existingReceipt).toBeNull()
    expect(result.apyUsdCondition?.currentFeeCurve).toEqual(feeCurve)
    expect(result.existingReceiptClaim).toBeUndefined()
    expect(result.stages[1]).toMatchObject({ status: 'unassessed', amountRaw: null })
  })

  it.each([
    ['other_owner', 'not_holder', null],
    ['not_found', 'not_found', null],
    ['holder', 'evm_revert', null],
  ] as const)(
    'transports %s receipt facts without promoting %s to delivered Q',
    async (ownership, claimSimulation, simulatedClaimPayoutRaw) => {
      const native = observed()
      const oldReceipt = {
        ...receipt,
        ...(ownership === 'not_found'
          ? {
              escrowRaw: null,
              createdAt: null,
              claimableAt: null,
              claimableNow: null,
              currentFeeRaw: null,
              currentPreviewPayoutRaw: null,
            }
          : {}),
        ownership,
        claimSimulation,
        simulatedClaimPayoutRaw,
      }
      supply({ ...native, current: { ...native.current, existingReceipt: oldReceipt } })
      const result = await readHolderExitAssessment(clients, request)
      expect(result.apyUsdCondition?.existingReceipt).toEqual(oldReceipt)
      expect(result.existingReceiptClaim).toBeUndefined()
      expect(result.finalPayout).toEqual({
        assetAddress: APXUSD_ASSET,
        status: 'unassessed',
        amountRaw: null,
      })
    },
  )
})
