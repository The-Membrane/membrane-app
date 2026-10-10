import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withUsd3JointHistoricalEvidence } from '@/pages/api/carry/holder-exit-assessment'
import type { HolderExitAssessmentRequest } from '@/lib/carry/holderExitAssessment'
import type { HolderExitCapacityAgreement } from '@/lib/carry/holderExitCapacity'

const mocks = vi.hoisted(() => ({ select: vi.fn(), issue: vi.fn() }))
vi.mock('@/lib/carry/usd3JointHistoricalEvidence.server', () => ({
  readUsd3JointHistoricalEvidenceAtIssue: mocks.issue,
}))
vi.mock('@/lib/carry/holderExitCapacity', async (original) => ({
  ...(await original<typeof import('@/lib/carry/holderExitCapacity')>()),
  selectedHolderExitCapacity: mocks.select,
}))
const input = {
  routeKey: 'USDC → USD3 [USDC]',
  destinationAddress: '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc',
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
describe('USD3 API optional evidence attachment (simulated issuer)', () => {
  it.each([{}, { error: 'holder_exit_assessment_unavailable' }])(
    'attaches the actual final issue clock to either successful or capacity-only responses',
    async (extras) => {
      const evidence = { authenticated: false, originalAuthority: false }
      mocks.issue.mockResolvedValue({ evidence, issuedAtUtc: '2026-10-08T12:00:20.000Z' })
      const response = { ...extras, capacityAgreement: capacity }
      const result = await withUsd3JointHistoricalEvidence(input, response)
      expect(result).toEqual({
        ...response,
        usd3JointHistoricalEvidence: evidence,
        usd3JointIssuedAtUtc: '2026-10-08T12:00:20.000Z',
      })
      expect(mocks.issue).toHaveBeenCalledTimes(1)
      expect(mocks.issue.mock.calls[0][1]).toMatchObject({
        owner: input.owner,
        requestedRaw: input.assetsRaw,
        currentSource: capacity.quote.source,
      })
    },
  )
  it('omits optional evidence on failure without a second capture or changing the current response', async () => {
    mocks.issue.mockResolvedValue(null)
    const response = { capacityAgreement: capacity }
    expect(await withUsd3JointHistoricalEvidence(input, response)).toBe(response)
    expect(mocks.issue).toHaveBeenCalledTimes(1)
  })
  it('does not acquire for other routes, missing capacity, or a current binding mismatch', async () => {
    expect(await withUsd3JointHistoricalEvidence(input, {})).toEqual({})
    const response = { capacityAgreement: capacity }
    expect(await withUsd3JointHistoricalEvidence({ ...input, routeKey: 'other' }, response)).toBe(
      response,
    )
    mocks.select.mockReturnValue(null)
    expect(await withUsd3JointHistoricalEvidence(input, response)).toBe(response)
    expect(mocks.issue).not.toHaveBeenCalled()
  })
})
