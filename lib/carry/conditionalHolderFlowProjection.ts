import { ROUTES } from '@/components/Carry/fixtures'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'
import recorderConfig from '@/tools/venue-recorder.config.json'
import { GHO_SGHO } from '@/scripts/route-rates/exact-leg-spread.mjs'
import {
  CONDITIONAL_FLOW_SOURCE_MAX_AGE_SECONDS,
  selectedConditionalGrossFlowHeadroom,
  type ConditionalGrossFlowCurrentSource,
  type ConditionalGrossFlowProjection,
} from './conditionalGrossFlowHeadroom'
import { buildCarryForecastRegistry } from './forecastRegistry'
import { verifiedDirectSupplyDestinations } from './forecastRegistryMarkets'
import {
  assessHolderExitConditionalProjection,
  buildFrozenHolderExitMechanisms,
  type HolderExitConditionalProjectionEvidence,
} from './holderExitMechanisms'
import { matchingHolderExitViewAssessment } from './holderExitMechanicalOutlookView'
import { projectResolvedHolderExitMechanicalOutlook } from './holderExitMechanicalProjection'
import { resolveHolderExitSubject } from './holderExitSubjectRegistry'

export type ConditionalHolderFlowBinding = {
  currentSource: ConditionalGrossFlowCurrentSource
  owner: string
  requestedRaw: string
  horizonHours: number
  asOfMs: number
}
export type ConditionalHolderFlowProjection = {
  status: 'conditional_holder_exit_projection'
  sourceWithdrawal: 'simulated_two_origin'
  assumption: 'repeat_historical_joint_flows_and_unchanged_holder_balance_authority_and_mechanics'
  holderExecutableExit: false
  prospectiveValidated: false
  forecastValidated: false
  minedPayoutObserved: false
  question: {
    routeKey: string
    destination: string
    owner: string
    payoutAsset: string
    assetDecimals: 6
    requestedRaw: string
    horizonHours: number
  }
  currentSource: ConditionalGrossFlowCurrentSource
  evaluatedAt: string
  sourceProofValidUntil: string
  target: ConditionalGrossFlowProjection['target']
  capacity: ConditionalGrossFlowProjection['capacity']
  userHeadroom: ConditionalGrossFlowProjection['userHeadroom']
  historicalScenarioFraction: ConditionalGrossFlowProjection['historicalScenarioFraction']
  scenarios: (ConditionalGrossFlowProjection['scenarios'][number] & {
    coverage: 'covers_requested_q' | 'cash_below_requested_q'
  })[]
  executionAgreement: HolderExitConditionalProjectionEvidence
}
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const sameAddress = (a: unknown, b: string) =>
  typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() === b.toLowerCase()
const sameSource = (v: unknown, source: ConditionalGrossFlowCurrentSource) =>
  record(v) &&
  v.chainId === 1 &&
  v.blockNumber === source.blockNumber &&
  typeof v.blockHash === 'string' &&
  v.blockHash.toLowerCase() === source.blockHash.toLowerCase() &&
  v.blockTime === source.blockTime
// Specs are issued by the existing fingerprint-checked frozen registry, not caller descriptors.
const specs = buildFrozenHolderExitMechanisms(
  buildCarryForecastRegistry(
    ROUTES,
    seed,
    recorderConfig.venues,
    GHO_SGHO.destination,
    verifiedDirectSupplyDestinations(),
  ),
).subjectSpecs

/** Join current exact-holder execution to conditional joint cash scenarios, without a future payout claim. */
export function selectedConditionalHolderFlowProjection(
  value: { cashProjection: unknown; assessment: unknown; executionAgreement: unknown },
  expected: ConditionalHolderFlowBinding,
  hash: (serialized: string) => string,
): ConditionalHolderFlowProjection | null {
  try {
    if (
      !record(value) ||
      !record(expected) ||
      !record(expected.currentSource) ||
      !Number.isSafeInteger(expected.asOfMs) ||
      !record(value.cashProjection) ||
      !record(value.cashProjection.request) ||
      !utc(value.cashProjection.request.asOf) ||
      Date.parse(value.cashProjection.request.asOf) > expected.asOfMs
    )
      return null
    const cash = selectedConditionalGrossFlowHeadroom(
      value.cashProjection,
      {
        currentSource: expected.currentSource,
        request: { requestedRaw: expected.requestedRaw, asOf: value.cashProjection.request.asOf },
      },
      hash,
    )
    if (
      !cash ||
      Date.parse(cash.currentSource.blockTime) > expected.asOfMs ||
      expected.asOfMs - Date.parse(cash.currentSource.blockTime) >
        CONDITIONAL_FLOW_SOURCE_MAX_AGE_SECONDS * 1000 ||
      Date.parse(cash.currentSource.readAt) > expected.asOfMs ||
      Date.parse(cash.target.earliestAt) <= expected.asOfMs
    )
      return null
    const source = cash.currentSource
    const question = {
      routeKey: source.routeKey,
      destination: source.destination,
      owner: expected.owner,
      requestedRaw: expected.requestedRaw,
      payoutAsset: source.asset,
      horizonHours: expected.horizonHours,
      asOfMs: expected.asOfMs,
    }
    const assessment = matchingHolderExitViewAssessment(value.assessment, question)
    if (
      !assessment ||
      !sameSource(assessment.source, source) ||
      assessment.status !== 'assessed' ||
      assessment.finalPayout.status !== 'simulated' ||
      assessment.finalPayout.amountRaw !== expected.requestedRaw ||
      assessment.stages.length !== 1 ||
      assessment.stages[0].name !== 'withdrawal' ||
      assessment.stages[0].status !== 'simulated' ||
      assessment.stages[0].relatedToRequest !== true ||
      assessment.stages[0].amountRaw !== expected.requestedRaw ||
      !sameAddress(assessment.stages[0].assetAddress, source.asset)
    )
      return null
    const agreement = value.executionAgreement
    if (!record(agreement) || !record(agreement.question)) return null
    const q = agreement.question
    if (
      q.routeKey !== source.routeKey ||
      !sameAddress(q.destinationAddress, source.destination) ||
      !sameAddress(q.owner, expected.owner) ||
      q.assetsRaw !== expected.requestedRaw ||
      !sameAddress(q.finalAssetAddress, source.asset) ||
      q.finalAssetDecimals !== 6 ||
      !Array.isArray(agreement.simulations) ||
      agreement.simulations.length !== 2 ||
      !agreement.simulations.every(
        (proof) =>
          record(proof) &&
          sameSource(proof.source, source) &&
          proof.finalAssetAmountRaw === assessment.finalPayout.amountRaw,
      )
    )
      return null
    const subject = specs.find(
      (s) =>
        s.routeKey === source.routeKey && s.destinationAddress === source.destination.toLowerCase(),
    )
    const resolved = resolveHolderExitSubject(source.routeKey, source.destination as `0x${string}`)
    if (
      !subject ||
      resolved.kind !== 'direct' ||
      !sameAddress(resolved.payoutAsset, source.asset) ||
      assessHolderExitConditionalProjection(
        subject,
        agreement as HolderExitConditionalProjectionEvidence,
      ).tier !== 'conditional_projection'
    )
      return null
    // External render-time freshness was checked above. The projection uses the
    // source clock to evaluate every required prong at the exact cash-window end.
    const mechanical = projectResolvedHolderExitMechanicalOutlook(
      assessment,
      {
        routeKey: source.routeKey,
        destinationAddress: source.destination,
        owner: expected.owner,
        assetAddress: source.asset,
        assetsRaw: expected.requestedRaw,
        nowMs: Date.parse(source.blockTime),
        horizonSeconds: (Date.parse(cash.target.latestAt) - Date.parse(source.blockTime)) / 1000,
      },
      resolved,
    )
    if (
      mechanical.status !== 'conditional' ||
      mechanical.requestedQ.fullRouteEarliestAt === null ||
      mechanical.requestedQ.atTarget !== 'conditional_by_target'
    )
      return null
    return {
      status: 'conditional_holder_exit_projection',
      sourceWithdrawal: 'simulated_two_origin',
      assumption:
        'repeat_historical_joint_flows_and_unchanged_holder_balance_authority_and_mechanics',
      holderExecutableExit: false,
      prospectiveValidated: false,
      forecastValidated: false,
      minedPayoutObserved: false,
      question: {
        routeKey: source.routeKey,
        destination: source.destination,
        owner: expected.owner.toLowerCase(),
        payoutAsset: source.asset,
        assetDecimals: 6,
        requestedRaw: expected.requestedRaw,
        horizonHours: expected.horizonHours,
      },
      currentSource: { ...source },
      evaluatedAt: new Date(expected.asOfMs).toISOString(),
      sourceProofValidUntil: new Date(
        Date.parse(source.blockTime) + CONDITIONAL_FLOW_SOURCE_MAX_AGE_SECONDS * 1000,
      ).toISOString(),
      target: structuredClone(cash.target),
      capacity: structuredClone(cash.capacity),
      userHeadroom: structuredClone(cash.userHeadroom),
      historicalScenarioFraction: { ...cash.historicalScenarioFraction },
      scenarios: cash.scenarios.map((scenario) => ({
        ...scenario,
        coverage:
          BigInt(scenario.userHeadroomRaw) >= 0n ? 'covers_requested_q' : 'cash_below_requested_q',
      })),
      executionAgreement: structuredClone(agreement) as HolderExitConditionalProjectionEvidence,
    }
  } catch {
    return null
  }
}
