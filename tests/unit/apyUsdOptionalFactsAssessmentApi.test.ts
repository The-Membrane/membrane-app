import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPublicClient, http } from 'viem'

import { APXUSD_ASSET, APYUSD_ROUTE, APYUSD_VAULT } from '@/lib/carry/apyUsdExit'
import {
  readHolderExitAssessment,
  type HolderExitAssessment,
} from '@/lib/carry/holderExitAssessment'
import { readMorphoV2CurrentProtocolOrigin } from '@/lib/carry/morphoV2CurrentProtocolCapacityEvidence'
import { checkRateLimit } from '@/lib/game/rateLimit'
import handler, { sameHolderExitAssessment } from '@/pages/api/carry/holder-exit-assessment'

const boundary = vi.hoisted(() => ({
  clients: [{ testClient: 1 }, { testClient: 2 }],
  urls: ['https://first.example', 'https://second.example'],
  requestId: 0,
}))
vi.mock('viem', async (original) => ({
  ...(await original<typeof import('viem')>()),
  createPublicClient: vi.fn(),
  http: vi.fn((url, options) => ({ url, options })),
}))
vi.mock('@/lib/carry/holderExitAssessment', async (original) => ({
  ...(await original<typeof import('@/lib/carry/holderExitAssessment')>()),
  readHolderExitAssessment: vi.fn(),
}))
// Optional joint acquisition is disabled: synthetic SDK fixtures never call native factories or retention.
vi.mock('@/lib/carry/apyUsdJointNativeEvidence.server', () => ({
  acquireApyUsdJointNativeCurrent: vi.fn().mockResolvedValue(null),
  selectedOriginalApyUsdJointNativeCurrent: vi.fn().mockReturnValue(null),
  readApyUsdJointNativeHistoryAtIssue: vi.fn().mockResolvedValue(null),
  selectedOriginalApyUsdJointNativeHistory: vi.fn().mockReturnValue(null),
  apyUsdJointNativeReceiptCandidateHints: vi.fn(() => []),
}))
// This API gate uses only synthetic native assessments; no full archive replay or RPC starts.
vi.mock('@/lib/carry/morphoV2CurrentProtocolCapacityEvidence', () => ({
  prewarmMorphoV2ProtocolHistory: vi.fn().mockResolvedValue(true),
  readMorphoV2CurrentProtocolOrigin: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/scripts/research/carry-depth-quote-archive.mjs', () => ({
  readProviderPolicy: () => ({ status: 'active' }),
  configuredProviders: () => boundary.urls.map((url) => ({ url, host: new URL(url).hostname })),
}))
vi.mock('@/lib/game/rateLimit', () => ({
  checkRateLimit: vi.fn(),
  getClientIp: () => `127.0.0.${++boundary.requestId}`,
}))

// Dated synthetic holder E/Q and source clock are not a live forecast claim.
const nowMs = Date.parse('2026-10-07T12:00:00.000Z')
const sourceSeconds = nowMs / 1000 - 600
const body = {
  routeKey: APYUSD_ROUTE,
  destinationAddress: APYUSD_VAULT,
  owner: '0x0000000000000000000000000000000000000001',
  assetsRaw: '1000000000000000000',
  horizonHours: 168,
  receiptTokenId: '1000',
  chainId: 1,
}
const feeCurve = {
  minFeeWad: '0',
  maxFeeWad: '34000000000000000',
  minDurationSeconds: 259_200,
  maxDurationSeconds: 1_728_000,
  curvatureWad: '1000000000000000000',
}
const receipt = {
  tokenId: body.receiptTokenId,
  ownership: 'holder' as const,
  escrowRaw: '9000000000000000000',
  createdAt: sourceSeconds - 700_000,
  claimableAt: sourceSeconds - 440_800,
  claimableNow: true,
  receiptPaused: false,
  currentFeeRaw: '200000000000000000',
  currentPreviewPayoutRaw: '8800000000000000000',
  claimSimulation: 'success' as const,
  simulatedClaimPayoutRaw: '8790000000000000000',
  delivery: 'not_observed' as const,
}
const unknownFees = {
  currentFeeCurve: null,
  currentMinimumClaimDelaySeconds: null,
  ifInitiatedAtCheckedBlockClaimableAt: null,
  ifInitiatedAtCheckedBlockEarliestNetRaw: null,
  ifInitiatedAtCheckedBlockMinimumFeeAt: null,
  ifInitiatedAtCheckedBlockMinimumFeeNetRaw: null,
  ifInitiatedAtCheckedBlockHorizonNetRaw: null,
}
function assessment(): HolderExitAssessment {
  return {
    status: 'partial',
    routeKey: body.routeKey,
    destinationAddress: body.destinationAddress,
    owner: body.owner as HolderExitAssessment['owner'],
    request: {
      assetsRaw: body.assetsRaw,
      assetAddress: APXUSD_ASSET,
      horizonHours: body.horizonHours,
      receiptTokenId: body.receiptTokenId,
    },
    source: {
      chainId: 1,
      blockNumber: 26_093_883,
      blockHash: `0x${'a'.repeat(64)}`,
      blockTime: new Date(sourceSeconds * 1000).toISOString(),
      originValidation: 'single_provider',
    },
    stages: [
      {
        name: 'receipt_initiation',
        assetAddress: null,
        status: 'simulated',
        amountRaw: body.assetsRaw,
        relatedToRequest: true,
      },
      {
        name: 'receipt_claim',
        assetAddress: APXUSD_ASSET,
        status: 'simulated',
        amountRaw: receipt.simulatedClaimPayoutRaw,
        relatedToRequest: false,
      },
    ],
    finalPayout: { assetAddress: APXUSD_ASSET, status: 'unassessed', amountRaw: null },
    existingReceiptClaim: {
      tokenId: body.receiptTokenId,
      assetAddress: APXUSD_ASSET,
      status: 'simulated',
      amountRaw: receipt.simulatedClaimPayoutRaw,
      delivery: 'not_observed',
    },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
    apyUsdCondition: {
      currentFeeCurve: { ...feeCurve },
      currentMinimumClaimDelaySeconds: feeCurve.minDurationSeconds,
      ifInitiatedAtCheckedBlockClaimableAt: sourceSeconds + feeCurve.minDurationSeconds,
      ifInitiatedAtCheckedBlockEarliestNetRaw: '966000000000000000',
      ifInitiatedAtCheckedBlockMinimumFeeAt: sourceSeconds + feeCurve.maxDurationSeconds,
      ifInitiatedAtCheckedBlockMinimumFeeNetRaw: body.assetsRaw,
      ifInitiatedAtCheckedBlockHorizonNetRaw: '980000000000000000',
      existingReceipt: { ...receipt },
    },
  }
}
async function request(first: HolderExitAssessment, second: HolderExitAssessment) {
  vi.mocked(readHolderExitAssessment).mockResolvedValueOnce(first).mockResolvedValueOnce(second)
  let status = 0
  let response: Record<string, any> = {}
  const res = {
    setHeader: vi.fn(),
    status: vi.fn((code: number) => {
      status = code
      return res
    }),
    json: vi.fn((data: Record<string, any>) => {
      response = data
      return res
    }),
  }
  await handler({ method: 'POST', body, headers: {}, socket: {} } as never, res as never)
  return { status, response }
}
function expectRequiredAssays(response: Record<string, any>, required: HolderExitAssessment) {
  expect(response.status).toBe('partial')
  expect(response.source).toEqual({ ...required.source, originValidation: 'two_provider' })
  expect(response.request).toEqual(required.request)
  expect(response.stages).toEqual(required.stages)
  expect(response.existingReceiptClaim).toEqual(required.existingReceiptClaim)
  expect(response.finalPayout).toEqual(required.finalPayout)
  expect(response.forecast).toEqual(required.forecast)
  expect(response.executionAgreement).toBeUndefined()
  expect(response.capacityAgreement).toBeUndefined()
}

describe('APY native optional facts at the two-origin API boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(readHolderExitAssessment).mockReset()
    vi.mocked(createPublicClient)
      .mockReset()
      .mockReturnValueOnce(boundary.clients[0] as never)
      .mockReturnValueOnce(boundary.clients[1] as never)
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true })
    vi.spyOn(Date, 'now').mockReturnValue(nowMs)
  })
  afterEach(() => vi.restoreAllMocks())

  it('retains exactly agreeing curve and original receipt facts before building the outlook', async () => {
    const first = assessment()
    const second = assessment()
    const { status, response } = await request(first, second)
    expect(status).toBe(200)
    expectRequiredAssays(response, first)
    expect(response.apyUsdCondition).toEqual(first.apyUsdCondition)
    expect(response.apyUsdCondition.currentFeeCurve).not.toBe(
      first.apyUsdCondition?.currentFeeCurve,
    )
    expect(response.apyUsdCondition.existingReceipt).not.toBe(
      first.apyUsdCondition?.existingReceipt,
    )
    expect(response.apyUsdCondition.existingReceipt.escrowRaw).toBe('9000000000000000000')
    expect(response.request.assetsRaw).toBe('1000000000000000000')
    expect(
      response.mechanicalOutlook.outlook.prongs.find((p: any) => p.id === 'new_q_receipt_claim'),
    ).toMatchObject({
      earliestAt: new Date((sourceSeconds + feeCurve.minDurationSeconds) * 1000).toISOString(),
      // Include the original source-to-response offset in the native elapsed time.
      amountRaw: '974013888888888888',
      feeRaw: '25986111111111112',
      feeMinimumNetRaw: body.assetsRaw,
    })
    expect(http).toHaveBeenNthCalledWith(1, boundary.urls[0], { timeout: 8000, retryCount: 0 })
    expect(http).toHaveBeenNthCalledWith(2, boundary.urls[1], { timeout: 8000, retryCount: 0 })
    expect(vi.mocked(readHolderExitAssessment).mock.calls.map(([clients]) => clients.apy)).toEqual(
      boundary.clients,
    )
    expect(readMorphoV2CurrentProtocolOrigin).not.toHaveBeenCalled()
  })

  it.each(['missing curve', 'different curve', 'different endpoint', 'missing endpoint'])(
    'drops all seven fee facts for %s while preserving independently agreed assays and receipt E',
    async (control) => {
      const first = assessment()
      const second = assessment()
      if (control === 'missing curve') second.apyUsdCondition!.currentFeeCurve = null
      if (control === 'different curve')
        second.apyUsdCondition!.currentFeeCurve!.maxFeeWad = '33000000000000000'
      if (control === 'different endpoint')
        second.apyUsdCondition!.ifInitiatedAtCheckedBlockHorizonNetRaw = '970000000000000000'
      if (control === 'missing endpoint')
        delete (
          second.apyUsdCondition as Partial<NonNullable<HolderExitAssessment['apyUsdCondition']>>
        ).ifInitiatedAtCheckedBlockEarliestNetRaw
      expect(sameHolderExitAssessment(first, second)).toBe(true)
      const { status, response } = await request(first, second)
      expect(status).toBe(200)
      expectRequiredAssays(response, first)
      expect(response.apyUsdCondition).toEqual({ ...unknownFees, existingReceipt: receipt })
      expect(
        response.mechanicalOutlook.outlook.prongs.find((p: any) => p.id === 'new_q_receipt_claim'),
      ).toMatchObject({
        earliestAt: null,
        amountRaw: null,
        feeRaw: null,
        feeMinimumAt: null,
        feeMinimumNetRaw: null,
      })
      expect(first.apyUsdCondition?.currentFeeCurve).toEqual(feeCurve)
    },
  )

  it('keeps both-unknown fee metadata unknown even if old endpoints are nonnull', async () => {
    const first = assessment()
    const second = assessment()
    first.apyUsdCondition!.currentFeeCurve = null
    second.apyUsdCondition!.currentFeeCurve = null
    const { status, response } = await request(first, second)
    expect(status).toBe(200)
    expectRequiredAssays(response, first)
    expect(response.apyUsdCondition).toEqual({ ...unknownFees, existingReceipt: receipt })
  })

  it.each([
    'currentMinimumClaimDelaySeconds',
    'ifInitiatedAtCheckedBlockClaimableAt',
    'ifInitiatedAtCheckedBlockEarliestNetRaw',
    'ifInitiatedAtCheckedBlockMinimumFeeAt',
    'ifInitiatedAtCheckedBlockMinimumFeeNetRaw',
    'ifInitiatedAtCheckedBlockHorizonNetRaw',
  ] as const)('clears the complete fee group when legacy %s differs', async (key) => {
    const first = assessment()
    const second = assessment()
    second.apyUsdCondition![key] = null
    const { status, response } = await request(first, second)
    expect(status).toBe(200)
    expectRequiredAssays(response, first)
    expect(response.apyUsdCondition).toEqual({ ...unknownFees, existingReceipt: receipt })
  })

  it.each([
    'missing receipt',
    'different original clock',
    'different full escrow',
    'different pause',
  ])(
    'drops entire receipt metadata for %s and retains the core claim assay and agreed fees',
    async (control) => {
      const first = assessment()
      const second = assessment()
      if (control === 'missing receipt') second.apyUsdCondition!.existingReceipt = null
      if (control === 'different original clock')
        second.apyUsdCondition!.existingReceipt!.createdAt! += 1
      if (control === 'different full escrow')
        second.apyUsdCondition!.existingReceipt!.escrowRaw = '8000000000000000000'
      if (control === 'different pause')
        second.apyUsdCondition!.existingReceipt!.receiptPaused = true
      const { status, response } = await request(first, second)
      expect(status).toBe(200)
      expectRequiredAssays(response, first)
      expect(response.apyUsdCondition).toEqual({ ...first.apyUsdCondition, existingReceipt: null })
    },
  )

  it('accepts deep equality regardless of native metadata property order', async () => {
    const first = assessment()
    const second = assessment()
    second.apyUsdCondition!.currentFeeCurve = Object.fromEntries(
      Object.entries(feeCurve).reverse(),
    ) as typeof feeCurve
    second.apyUsdCondition!.existingReceipt = Object.fromEntries(
      Object.entries(receipt).reverse(),
    ) as typeof receipt
    const { status, response } = await request(first, second)
    expect(status).toBe(200)
    expect(response.apyUsdCondition).toEqual(first.apyUsdCondition)
  })

  it.each([0, 1])(
    'leaves optional facts unknown when origin %s has no condition',
    async (origin) => {
      const first = assessment()
      const second = assessment()
      delete (origin === 0 ? first : second).apyUsdCondition
      const { status, response } = await request(first, second)
      expect(status).toBe(200)
      expectRequiredAssays(response, first)
      expect(response.apyUsdCondition).toEqual({ ...unknownFees, existingReceipt: null })
    },
  )

  it('leaves both-unknown receipt metadata unknown without removing agreed fees', async () => {
    const first = assessment()
    const second = assessment()
    first.apyUsdCondition!.existingReceipt = null
    second.apyUsdCondition!.existingReceipt = null
    const { status, response } = await request(first, second)
    expect(status).toBe(200)
    expectRequiredAssays(response, first)
    expect(response.apyUsdCondition).toEqual(first.apyUsdCondition)
  })

  it.each([
    'stage',
    'source hash',
    'source height',
    'source time',
    'Q',
    'owner',
    'claim',
    'other condition fact',
  ])('keeps required %s disagreement at the failing boundary', async (control) => {
    const first = assessment()
    const second = assessment()
    if (control === 'stage') second.stages[0].status = 'reverted'
    if (control === 'source hash') second.source.blockHash = `0x${'b'.repeat(64)}`
    if (control === 'source height') second.source.blockNumber += 1
    if (control === 'source time')
      second.source.blockTime = new Date((sourceSeconds + 1) * 1000).toISOString()
    if (control === 'Q') second.request.assetsRaw = '2000000000000000000'
    if (control === 'owner') second.owner = '0x0000000000000000000000000000000000000002'
    if (control === 'claim') second.existingReceiptClaim!.amountRaw = '8780000000000000000'
    if (control === 'other condition fact')
      Object.assign(second.apyUsdCondition!, { requiredGate: false })
    expect(sameHolderExitAssessment(first, second)).toBe(false)
    const { status, response } = await request(first, second)
    expect(status).toBe(503)
    expect(response.apyUsdCondition).toBeUndefined()
    expect(response.executionAgreement).toBeUndefined()
    expect(response.mechanicalOutlook).toBeUndefined()
  })

  it('does not exclude APY-shaped fields from unrelated routes or destinations', () => {
    for (const changed of ['route', 'destination']) {
      const first = assessment()
      const second = assessment()
      if (changed === 'route') first.routeKey = second.routeKey = 'unrelated route'
      else
        first.destinationAddress = second.destinationAddress =
          '0x0000000000000000000000000000000000000002'
      second.apyUsdCondition!.currentFeeCurve = null
      expect(sameHolderExitAssessment(first, second)).toBe(false)
    }
  })
})
