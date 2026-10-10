import {
  selectedConditionalSampledCashPathProjection,
  registeredConditionalSampledCashIdentity,
  type ConditionalSampledCashCurrentSource,
  type ConditionalSampledCashProjection,
} from './conditionalSampledCashPathProjection'
import {
  assessHolderExitConditionalProjection,
  resolveIssuedHolderExitSubject,
  type HolderExitSubjectSpec,
  type HolderExitConditionalProjectionEvidence,
} from './holderExitMechanisms'
import { matchingHolderExitViewAssessment } from './holderExitMechanicalOutlookView'
import {
  projectResolvedHolderExitMechanicalOutlook,
  type MechanicalEligibility,
} from './holderExitMechanicalProjection'
import { resolveHolderExitSubject } from './holderExitSubjectRegistry'

export function resolveConditionalHolderSampledCashSubject(
  routeKey: unknown,
  destination: unknown,
): HolderExitSubjectSpec | null {
  const native = registeredConditionalSampledCashIdentity(routeKey, destination)
  if (!native) return null
  const subject = resolveIssuedHolderExitSubject(native.routeKey, native.destination)
  return subject &&
    subject.mechanism === 'atomic' &&
    subject.stages.length === 1 &&
    subject.stages[0] === 'atomic_exit' &&
    subject.canonicalFinalAsset?.address === native.asset &&
    subject.canonicalFinalAsset.decimals === native.assetDecimals
    ? subject
    : null
}
export type ConditionalHolderSampledCashBinding = {
  currentSource: ConditionalSampledCashCurrentSource
  owner: string
  requestedRaw: string
  horizonHours: number
  asOfMs: number
}
export type ConditionalHolderSampledCashProjection = {
  status: 'conditional_holder_sampled_cash_projection'
  claim: 'conditional_sampled_endpoint_cash_projection'
  cashMeasure: ConditionalSampledCashProjection['cashMeasure']
  holderFailureForecast: false
  holderExecutableExit: false
  prospectiveValidated: false
  forecastValidated: false
  minedPayoutObserved: false
  sourceWithdrawal: 'simulated_two_origin'
  assumption: 'repeat_historical_endpoint_cash_changes_and_unchanged_holder_balance_authority_and_mechanics'
  owner: string
  cashProjection: ConditionalSampledCashProjection
  horizons: (ConditionalSampledCashProjection['horizons'][number] & {
    mechanicalEligibility: {
      earliest: MechanicalEligibility
      latest: MechanicalEligibility
      notBeforeAt: string | null
      windowEndInclusiveAt: string | null
    }
  })[]
  executionAgreement: HolderExitConditionalProjectionEvidence
}
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const address = (v: unknown, expected: string) =>
  typeof v === 'string' &&
  /^0x[0-9a-fA-F]{40}$/.test(v) &&
  v.toLowerCase() === expected.toLowerCase()
const sameSource = (value: unknown, current: ConditionalSampledCashCurrentSource) =>
  record(value) &&
  value.chainId === 1 &&
  value.blockNumber === Number(current.block) &&
  typeof value.blockHash === 'string' &&
  value.blockHash.toLowerCase() === current.blockHash.toLowerCase() &&
  value.blockTime === current.blockTime

/** Join a verified proxy path to current full-route holder proofs without promoting proxy cash to exit capacity. */
export function selectedConditionalHolderSampledCashProjection(
  value: { cashProjection: unknown; assessment: unknown; executionAgreement: unknown },
  expected: ConditionalHolderSampledCashBinding,
  hash: (serialized: string) => string,
): ConditionalHolderSampledCashProjection | null {
  try {
    if (
      !record(value) ||
      !record(expected) ||
      !record(expected.currentSource) ||
      expected.horizonHours !== 24 ||
      typeof expected.currentSource.block !== 'string' ||
      !/^(0|[1-9][0-9]{0,77})$/.test(expected.currentSource.block) ||
      BigInt(expected.currentSource.block) > BigInt(Number.MAX_SAFE_INTEGER)
    )
      return null
    const source = expected.currentSource
    const subject = resolveConditionalHolderSampledCashSubject(source.routeKey, source.destination)
    if (!subject) return null
    const cash = selectedConditionalSampledCashPathProjection(
      value.cashProjection,
      {
        identity: {
          routeKey: source.routeKey,
          destination: source.destination,
          asset: source.asset,
          assetDecimals: source.assetDecimals,
        },
        requestedRaw: expected.requestedRaw,
        currentSource: source,
        asOfMs: expected.asOfMs,
      },
      hash,
    )
    if (!cash) return null
    const assessment = matchingHolderExitViewAssessment(value.assessment, {
      routeKey: source.routeKey,
      destination: source.destination,
      owner: expected.owner,
      requestedRaw: expected.requestedRaw,
      payoutAsset: source.asset,
      horizonHours: expected.horizonHours,
      asOfMs: expected.asOfMs,
    })
    if (
      !assessment ||
      !sameSource(assessment.source, source) ||
      assessment.source.originValidation !== 'two_provider' ||
      assessment.status !== 'assessed' ||
      assessment.finalPayout.status !== 'simulated' ||
      assessment.finalPayout.amountRaw !== expected.requestedRaw ||
      Object.keys(assessment.request).some(
        (k) => !['assetsRaw', 'assetAddress', 'horizonHours'].includes(k),
      ) ||
      assessment.stages.length !== 1 ||
      assessment.stages[0].name !== 'withdrawal' ||
      assessment.stages[0].status !== 'simulated' ||
      assessment.stages[0].relatedToRequest !== true ||
      assessment.stages[0].amountRaw !== expected.requestedRaw ||
      !address(assessment.stages[0].assetAddress, source.asset)
    )
      return null
    const agreement = value.executionAgreement
    if (
      !record(agreement) ||
      !record(agreement.question) ||
      !Array.isArray(agreement.simulations) ||
      agreement.simulations.length !== 2
    )
      return null
    const q = agreement.question
    if (
      q.routeKey !== source.routeKey ||
      !address(q.destinationAddress, source.destination) ||
      !address(q.owner, expected.owner) ||
      !address(q.finalAssetAddress, source.asset) ||
      q.finalAssetDecimals !== source.assetDecimals ||
      q.assetsRaw !== expected.requestedRaw ||
      !agreement.simulations.every(
        (p) =>
          record(p) &&
          sameSource(p.source, source) &&
          p.finalAssetAmountRaw === expected.requestedRaw,
      ) ||
      assessHolderExitConditionalProjection(
        subject,
        agreement as HolderExitConditionalProjectionEvidence,
      ).tier !== 'conditional_projection'
    )
      return null
    const resolved = resolveHolderExitSubject(source.routeKey, source.destination as `0x${string}`)
    const horizons = cash.horizons.map((h) => {
      const at = (target: string) =>
        projectResolvedHolderExitMechanicalOutlook(
          assessment,
          {
            routeKey: source.routeKey,
            destinationAddress: source.destination,
            owner: expected.owner,
            assetAddress: source.asset,
            assetsRaw: expected.requestedRaw,
            nowMs: Date.parse(source.blockTime),
            horizonSeconds: (Date.parse(target) - Date.parse(source.blockTime)) / 1000,
          },
          resolved,
        ).requestedQ
      const earliest = at(h.target.earliestAt),
        latest = at(h.target.latestAt)
      return {
        ...h,
        mechanicalEligibility: {
          earliest: earliest.atTarget,
          latest: latest.atTarget,
          notBeforeAt: earliest.fullRouteEarliestAt ?? earliest.stageEarliestAt,
          windowEndInclusiveAt: earliest.windowEndInclusiveAt,
        },
      }
    })
    return {
      status: 'conditional_holder_sampled_cash_projection',
      claim: cash.claim,
      cashMeasure: cash.cashMeasure,
      holderFailureForecast: false,
      holderExecutableExit: false,
      prospectiveValidated: false,
      forecastValidated: false,
      minedPayoutObserved: false,
      sourceWithdrawal: 'simulated_two_origin',
      assumption:
        'repeat_historical_endpoint_cash_changes_and_unchanged_holder_balance_authority_and_mechanics',
      owner: expected.owner.toLowerCase(),
      cashProjection: cash,
      horizons,
      executionAgreement: agreement as HolderExitConditionalProjectionEvidence,
    }
  } catch {
    return null
  }
}
