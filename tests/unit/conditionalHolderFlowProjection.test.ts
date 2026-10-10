import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import summary from '@/data/research/venue-signals/aave-usdc-flow-stress-duration-v1.json'
import { buildHistoricalCompetingFlowEstimate } from '@/lib/carry/historicalCompetingFlowEstimate'
import { buildConditionalGrossFlowHeadroom } from '@/lib/carry/conditionalGrossFlowHeadroom'
import { selectedConditionalHolderFlowProjection } from '@/lib/carry/conditionalHolderFlowProjection'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function fixture() {
  const currentSource = {
    chainId: 1,
    routeKey: 'USDC → supply on Aave V3',
    destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    assetDecimals: 6,
    cashRaw: '10000000000000',
    blockNumber: 26139032,
    blockHash: `0x${'a'.repeat(64)}`,
    blockTime: '2026-10-07T07:30:00.000Z',
    readAt: '2026-10-07T07:31:00.000Z',
    finalized: true,
  } as const
  const owner = `0x${'b'.repeat(40)}`
  const expected = {
    currentSource,
    owner,
    requestedRaw: '1000000000000',
    horizonHours: 24,
    asOfMs: Date.parse('2026-10-07T07:32:01.000Z'),
  }
  const cashProjection = buildConditionalGrossFlowHeadroom(
    {
      currentSource,
      request: { requestedRaw: expected.requestedRaw, asOf: '2026-10-07T07:32:00.000Z' },
      historicalFlow: buildHistoricalCompetingFlowEstimate(summary, hash),
    },
    hash,
  )
  if (cashProjection.status !== 'estimated') throw Error(cashProjection.reason)
  const assessment = {
    status: 'assessed',
    routeKey: currentSource.routeKey,
    destinationAddress: currentSource.destination,
    owner,
    request: {
      assetsRaw: expected.requestedRaw,
      assetAddress: currentSource.asset,
      horizonHours: 24,
    },
    source: {
      chainId: 1,
      blockNumber: currentSource.blockNumber,
      blockHash: currentSource.blockHash,
      blockTime: currentSource.blockTime,
      originValidation: 'two_provider',
    },
    stages: [
      {
        name: 'withdrawal',
        status: 'simulated',
        relatedToRequest: true,
        assetAddress: currentSource.asset,
        amountRaw: expected.requestedRaw,
      },
    ],
    finalPayout: {
      status: 'simulated',
      assetAddress: currentSource.asset,
      amountRaw: expected.requestedRaw,
    },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
  }
  const question = {
    routeKey: currentSource.routeKey,
    destinationAddress: currentSource.destination,
    owner,
    finalAssetAddress: currentSource.asset,
    finalAssetDecimals: 6,
    assetsRaw: expected.requestedRaw,
  }
  const executionAgreement = {
    question,
    routeAndContractIdentityVerified: true,
    inputAndFinalAssetAddressesVerified: true,
    simulations: ['one.example', 'two.example'].map((originHost) => ({
      question: { ...question },
      originHost,
      source: {
        chainId: 1,
        blockNumber: currentSource.blockNumber,
        blockHash: currentSource.blockHash,
        blockTime: currentSource.blockTime,
        finalized: true,
      },
      kind: 'full_route_execution',
      execution: 'single_call',
      fullRouteExecutionVerified: true,
      requiredStages: [{ name: 'atomic_exit', status: 'executed' }],
      finalAssetAmountRaw: expected.requestedRaw,
      status: 'simulated',
    })),
  }
  return { value: { cashProjection, assessment, executionAgreement }, expected }
}
describe('conditional exact-holder joint-flow projection', () => {
  it('binds fresh exact-holder two-origin payout evidence, preserves scenarios/Q once and never claims delivery', () => {
    const f = fixture()
    const before = structuredClone(f)
    const result = selectedConditionalHolderFlowProjection(f.value, f.expected, hash)!
    expect(result).not.toBeNull()
    expect(result).toMatchObject({
      status: 'conditional_holder_exit_projection',
      sourceWithdrawal: 'simulated_two_origin',
      holderExecutableExit: false,
      prospectiveValidated: false,
      forecastValidated: false,
      minedPayoutObserved: false,
      question: {
        owner: f.expected.owner,
        requestedRaw: f.expected.requestedRaw,
        horizonHours: 24,
        assetDecimals: 6,
      },
    })
    expect(result.target).toEqual(f.value.cashProjection.target)
    expect(result.userHeadroom).toEqual(f.value.cashProjection.userHeadroom)
    expect(result.capacity).toEqual(f.value.cashProjection.capacity)
    expect(result.historicalScenarioFraction).toEqual(
      f.value.cashProjection.historicalScenarioFraction,
    )
    expect(result.sourceProofValidUntil).toBe('2026-10-07T08:00:00.000Z')
    for (const s of result.scenarios) {
      expect(BigInt(s.userHeadroomRaw)).toBe(
        BigInt(s.capacityRaw) - BigInt(f.expected.requestedRaw),
      )
      expect(s.coverage).toBe(
        BigInt(s.capacityRaw) >= BigInt(f.expected.requestedRaw)
          ? 'covers_requested_q'
          : 'cash_below_requested_q',
      )
    }
    expect(f).toEqual(before)
    Object.assign(result.target.durationSeconds, { lowerSeconds: 1 })
    result.executionAgreement.simulations[0].question.owner = `0x${'c'.repeat(40)}`
    expect(f).toEqual(before)
  })
  it.each([
    'owner',
    'Q',
    'horizon',
    'hash',
    'time',
    'units',
    'source',
    'cash',
    'proof_owner',
    'proof_Q',
    'proof_hash',
    'proof_stage',
    'proof_status',
    'same_origin',
    'one_origin',
    'first_leg',
    'unknown_prong',
    'final_status',
    'missing_proof',
    'array_proof',
  ])('rejects unbound/forged %s', (change) => {
    const f = fixture()
    if (change === 'owner') f.expected.owner = `0x${'c'.repeat(40)}`
    if (change === 'Q') f.expected.requestedRaw = '999999'
    if (change === 'horizon') f.expected.horizonHours = 48
    if (change === 'hash') f.value.assessment.source.blockHash = `0x${'c'.repeat(64)}`
    if (change === 'time') f.value.assessment.source.blockTime = '2026-10-07T07:30:01.000Z'
    if (change === 'units') Object.assign(f.expected.currentSource, { assetDecimals: 18 })
    if (change === 'source') Object.assign(f.expected.currentSource, { cashRaw: '1' })
    if (change === 'cash') f.value.cashProjection.scenarios[0].userHeadroomRaw = '1'
    if (change === 'proof_owner')
      f.value.executionAgreement.simulations[0].question.owner = `0x${'c'.repeat(40)}`
    if (change === 'proof_Q') f.value.executionAgreement.question.assetsRaw = '999999'
    if (change === 'proof_hash')
      f.value.executionAgreement.simulations[0].source.blockHash = `0x${'c'.repeat(64)}`
    if (change === 'proof_stage')
      f.value.executionAgreement.simulations[0].requiredStages[0].name = 'withdrawal'
    if (change === 'proof_status')
      f.value.executionAgreement.simulations[0].status = 'mined_observed'
    if (change === 'same_origin')
      f.value.executionAgreement.simulations[1].originHost =
        f.value.executionAgreement.simulations[0].originHost
    if (change === 'one_origin') f.value.executionAgreement.simulations.pop()
    if (change === 'first_leg') f.value.assessment.finalPayout.amountRaw = null as never
    if (change === 'unknown_prong')
      f.value.assessment.stages.push({
        ...f.value.assessment.stages[0],
        name: 'conversion',
        status: 'unassessed',
      })
    if (change === 'final_status') f.value.assessment.finalPayout.status = 'unassessed'
    if (change === 'missing_proof') Object.assign(f.value, { executionAgreement: undefined })
    if (change === 'array_proof')
      Object.assign(f.value, { executionAgreement: Object.entries(f.value.executionAgreement) })
    expect(selectedConditionalHolderFlowProjection(f.value, f.expected, hash)).toBeNull()
  })
  it('keeps current proof expiry separate from the conditional future target', () => {
    const f = fixture()
    f.expected.asOfMs = Date.parse('2026-10-07T08:00:00.000Z')
    expect(selectedConditionalHolderFlowProjection(f.value, f.expected, hash)).not.toBeNull()
    f.expected.asOfMs++
    expect(selectedConditionalHolderFlowProjection(f.value, f.expected, hash)).toBeNull()
  })
  it('rejects a target already reached at the current render clock', () => {
    const f = fixture()
    f.expected.asOfMs = Date.parse(f.value.cashProjection.target.earliestAt)
    expect(selectedConditionalHolderFlowProjection(f.value, f.expected, hash)).toBeNull()
  })
  it('rejects issued cash facts from the render clock future', () => {
    const f = fixture()
    f.expected.asOfMs = Date.parse('2026-10-07T07:31:59.999Z')
    expect(selectedConditionalHolderFlowProjection(f.value, f.expected, hash)).toBeNull()
  })
})
