import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withFluidUsdcBridgeJointHistoricalEvidence } from '@/pages/api/carry/holder-exit-assessment'
import type { HolderExitAssessmentRequest } from '@/lib/carry/holderExitAssessment'
import type { HolderExitCapacityAgreement } from '@/lib/carry/holderExitCapacity'

const mocks = vi.hoisted(() => ({ select: vi.fn(), issue: vi.fn() }))
vi.mock('@/lib/carry/fluidUsdcBridgeJointHistoricalEvidence.server', () => ({
  readFluidUsdcBridgeJointHistoricalEvidenceAtIssue: mocks.issue,
}))
vi.mock('@/lib/carry/holderExitCapacity', async (original) => ({
  ...(await original<typeof import('@/lib/carry/holderExitCapacity')>()),
  selectedHolderExitCapacity: mocks.select,
}))
const input = {
  routeKey: 'USDC → FluidBridgeAggregatorProxy [USDC]',
  destinationAddress: '0x273da948aca9261043fbdb2a857bc255ecc29012',
  owner: '0x0000000000000000000000000000000000000001',
  assetsRaw: '1000000',
  horizonHours: 24,
  chainId: 1,
} as HolderExitAssessmentRequest
const capacity = {
  quote: {
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    assetDecimals: 6,
    source: {
      chainId: 1,
      blockNumber: 27_000_000,
      blockHash: '0x' + 'a'.repeat(64),
      blockTime: '2026-10-08T12:00:00.000Z',
      finalized: true,
    },
  },
} as HolderExitCapacityAgreement
beforeEach(() => {
  mocks.select.mockReset().mockReturnValue(capacity)
  mocks.issue.mockReset()
})
describe('Fluid USDC bridge API optional evidence attachment (simulated issuer)', () => {
  it.each([{}, { error: 'holder_exit_assessment_unavailable' }])(
    'attaches the actual final issue clock to either successful or capacity-only responses',
    async (extras) => {
      const evidence = { authenticated: false, originalAuthority: false }
      mocks.issue.mockResolvedValue({ evidence, issuedAtUtc: '2026-10-08T12:00:20.000Z' })
      const executionAgreement = { preservedExecutionEnvelope: true }
      const response = { ...extras, capacityAgreement: capacity, executionAgreement }
      const result = await withFluidUsdcBridgeJointHistoricalEvidence(input, response)
      expect(result).toEqual({
        ...response,
        fluidUsdcBridgeJointHistoricalEvidence: evidence,
        fluidUsdcBridgeJointIssuedAtUtc: '2026-10-08T12:00:20.000Z',
      })
      expect(mocks.issue).toHaveBeenCalledTimes(1)
      expect(mocks.issue.mock.calls[0][1]).toMatchObject({
        owner: input.owner,
        requestedRaw: input.assetsRaw,
        currentSource: capacity.quote.source,
        executionAgreement,
      })
    },
  )
  it('omits optional evidence on failure without a second capture or changing the current response', async () => {
    mocks.issue.mockResolvedValue(null)
    const response = { capacityAgreement: capacity }
    expect(await withFluidUsdcBridgeJointHistoricalEvidence(input, response)).toBe(response)
    expect(mocks.issue).toHaveBeenCalledTimes(1)
  })
  it('does not acquire for other routes, missing capacity, or a current binding mismatch', async () => {
    expect(await withFluidUsdcBridgeJointHistoricalEvidence(input, {})).toEqual({})
    const response = { capacityAgreement: capacity }
    expect(
      await withFluidUsdcBridgeJointHistoricalEvidence({ ...input, routeKey: 'other' }, response),
    ).toBe(response)
    mocks.select.mockReturnValue(null)
    expect(await withFluidUsdcBridgeJointHistoricalEvidence(input, response)).toBe(response)
    expect(mocks.issue).not.toHaveBeenCalled()
  })
})
