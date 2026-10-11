import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExitPressureCard, type ExitPressureCardProps } from '@/components/Carry/ExitPressureCard'
import { holderUsd3JointIssueFromResponse } from '@/components/Carry/ForecastWorkbench'

// Model math/native replay are covered by their own suites. These simulated
// boundaries test retained request identity, the visible summary and omission.
const mocks = vi.hoisted(() => ({
  fromResponse: vi.fn(),
  issue: vi.fn(),
  select: vi.fn(),
  receipt: vi.fn(),
}))
vi.mock('@/lib/carry/usd3JointHolderForecastBinding', () => ({
  usd3JointHolderForecastIssueFromResponse: mocks.fromResponse,
  issuedUsd3JointHolderForecast: mocks.issue,
  selectedUsd3JointHolderForecastFromIssue: mocks.select,
  selectedUsd3JointHolderForecastIssue: mocks.receipt,
}))
const AT = Date.parse('2026-10-08T12:00:10.000Z')
const base: ExitPressureCardProps = {
  routeKey: 'USDC → USD3 [USDC]',
  destination: '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc',
  requestedAmount: '1',
  requestedRaw: '1000000',
  requestedAssetSymbol: 'USDC',
  requestedAssetAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  requestedAssetDecimals: 6,
  requestedHolderAddress: '0x0000000000000000000000000000000000000001',
  horizonHours: 24,
  asOfMs: AT,
  currentCash: null,
  prospectiveCashModel: null,
  historicalScenario: null,
  grossWithdrawals: null,
  grossInflows: null,
  historicalGrossFlow: null,
  morphoPayout: null,
  holderAssessment: null,
  expectedEventEnrollment: null,
  eventContext: null,
  historicalOutlook: null,
}
const question = {
  routeKey: base.routeKey,
  destination: base.destination,
  requestedRaw: base.requestedRaw,
  requestedAssetAddress: base.requestedAssetAddress,
  requestedAssetDecimals: base.requestedAssetDecimals,
  requestedHolderAddress: base.requestedHolderAddress,
  horizonHours: base.horizonHours,
}
const receipt = {
  issuedAtMs: AT,
  block: '27000000',
  blockHash: '0x' + 'a'.repeat(64),
  sharesRaw: '9000000',
  fullEaRaw: '9500000',
  asset: base.requestedAssetAddress,
  assetDecimals: 6,
  shareDecimals: 6,
  profileId: 'usd3_joint_reviewed_native_history_v1',
  source: {
    chainId: 1,
    blockNumber: 27_000_000,
    blockHash: '0x' + 'a'.repeat(64),
    blockTime: '2026-10-08T12:00:00.000Z',
    finalized: true,
  },
}
function render(props: Partial<ExitPressureCardProps> = {}) {
  return renderToStaticMarkup(
    <ChakraProvider>
      <ExitPressureCard {...base} {...props} />
    </ChakraProvider>,
  ).replaceAll(/<style[\s\S]*?<\/style>/g, '')
}
beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset())
  mocks.fromResponse.mockReturnValue(receipt)
  mocks.receipt.mockReturnValue(receipt)
  const model = {
    sharesRaw: receipt.sharesRaw,
    fullEaRaw: receipt.fullEaRaw,
    asset: receipt.asset,
    assetDecimals: 6,
    shareDecimals: 6,
    profileId: receipt.profileId,
    source: receipt.source,
    targetAtUtc: '2026-10-09T12:00:10.000Z',
    process: {
      targetSummary: {
        empiricalP10HeadroomRaw: '-1000000',
        empiricalP90HeadroomRaw: '2000000',
        minimumHeadroomRaw: '-1000000',
      },
      issueAtUtc: new Date(AT).toISOString(),
      targetAtUtc: '2026-10-09T12:00:10.000Z',
      scenarios: [],
    },
  }
  mocks.issue.mockReturnValue(model)
  mocks.select.mockReturnValue(model)
})
describe('USD3 request publication and card summary', () => {
  it.each([200, 503])(
    'retains the original evidence and real server issue clock on status %s',
    (status) => {
      const response = {
        capacityAgreement: { exactCurrent: true },
        usd3JointHistoricalEvidence: { nativeBytes: true },
        usd3JointIssuedAtUtc: new Date(AT).toISOString(),
        ...(status === 503 ? { error: 'holder_exit_assessment_unavailable' } : {}),
      }
      const result = holderUsd3JointIssueFromResponse(response, status, question, AT + 1000)
      expect(result?.question.asOfMs).toBe(AT)
      expect(result?.capacityAgreement).toBe(response.capacityAgreement)
      expect(result?.historicalEvidence).toBe(response.usd3JointHistoricalEvidence)
      expect(mocks.fromResponse).toHaveBeenCalledWith(response, status, { ...question, asOfMs: AT })
    },
  )
  it('rejects absent, noncanonical, future and failed private issue clocks', () => {
    const response = { capacityAgreement: {}, usd3JointHistoricalEvidence: {} }
    expect(holderUsd3JointIssueFromResponse(response, 200, question, AT)).toBeNull()
    expect(
      holderUsd3JointIssueFromResponse(
        { ...response, usd3JointIssuedAtUtc: '2026-10-08T12:00:10Z' },
        200,
        question,
        AT,
      ),
    ).toBeNull()
    expect(
      holderUsd3JointIssueFromResponse(
        { ...response, usd3JointIssuedAtUtc: new Date(AT + 1).toISOString() },
        200,
        question,
        AT,
      ),
    ).toBeNull()
    mocks.fromResponse.mockReturnValue(null)
    expect(
      holderUsd3JointIssueFromResponse(
        { ...response, usd3JointIssuedAtUtc: new Date(AT).toISOString() },
        200,
        question,
        AT,
      ),
    ).toBeNull()
  })
  it('renders the empirical P10–P90 native range in the existing Expected headroom metric', () => {
    const issue = holderUsd3JointIssueFromResponse(
      {
        capacityAgreement: {},
        usd3JointHistoricalEvidence: {},
        usd3JointIssuedAtUtc: new Date(AT).toISOString(),
      },
      200,
      question,
      AT,
    )!
    const html = render({ holderUsd3JointIssue: issue })
    expect(html).toContain('Expected headroom')
    expect(html).toContain('−1–+2 USDC')
    expect(html).not.toContain('Projected funding headroom')
    expect(mocks.issue).not.toHaveBeenCalled()
    expect(mocks.select).toHaveBeenCalledWith(issue.issue, issue.question, AT)
  })
  it('preserves a missing or censored native summary as an empty value', () => {
    expect(render()).toContain('Expected headroom')
    expect(render()).not.toContain('Projected funding headroom')
    mocks.select.mockReturnValue(null)
    const issue = holderUsd3JointIssueFromResponse(
      {
        capacityAgreement: {},
        usd3JointHistoricalEvidence: {},
        usd3JointIssuedAtUtc: new Date(AT).toISOString(),
      },
      200,
      question,
      AT,
    )!
    const html = render({ holderUsd3JointIssue: issue })
    expect(html).not.toContain('−1–+2 USDC')
  })
  it('rejects changed amount/owner/horizon/asset and advances the render selector clock', () => {
    const issue = holderUsd3JointIssueFromResponse(
      {
        capacityAgreement: {},
        usd3JointHistoricalEvidence: {},
        usd3JointIssuedAtUtc: new Date(AT).toISOString(),
      },
      200,
      question,
      AT,
    )!
    for (const changed of [
      { requestedRaw: '2000000' },
      { requestedHolderAddress: '0x' + '2'.repeat(40) },
      { horizonHours: 48 },
      { requestedAssetDecimals: 18 },
    ]) {
      mocks.select.mockClear()
      expect(render({ ...changed, holderUsd3JointIssue: issue })).not.toContain('−1–+2 USDC')
      expect(mocks.select).not.toHaveBeenCalled()
    }
    render({ holderUsd3JointIssue: issue, asOfMs: AT + 30000 })
    expect(mocks.select).toHaveBeenLastCalledWith(issue.issue, issue.question, AT + 30000)
  })
})
