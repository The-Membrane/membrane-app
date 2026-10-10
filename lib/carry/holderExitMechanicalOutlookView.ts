import type { HolderExitCapacityAgreement } from './holderExitCapacity'
import type { HolderExitAssessment } from './holderExitAssessment'
import type { HolderExitConditionalProjectionEvidence } from './holderExitMechanisms'
import {
  projectResolvedHolderExitMechanicalOutlook,
  MAX_CURRENT_MECHANICAL_SOURCE_AGE_MS,
  type HolderExitMechanicalOutlook,
} from './holderExitMechanicalProjection'
import { resolveHolderExitSubject } from './holderExitSubjectRegistry'

/** Server-computed facts, bound to the complete assessed request rather than only Q. */
export type HolderExitMechanicalEnvelope = {
  issuedAt: string
  horizonSeconds: number
  assessmentRequest: HolderExitAssessment['request']
  outlook: HolderExitMechanicalOutlook
}
export type HolderExitAssessmentView = HolderExitAssessment & {
  mechanicalOutlook?: HolderExitMechanicalEnvelope | null
  capacityAgreement?: HolderExitCapacityAgreement
  executionAgreement?: HolderExitConditionalProjectionEvidence
}
export type HolderExitViewQuestion = {
  routeKey: string
  destination: string
  owner: string | null
  requestedRaw: string | null
  payoutAsset: string | null
  horizonHours: number
  asOfMs: number
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const MAX_RAW = (1n << 256n) - 1n
// View deadline must agree with the server's attested 30-minute source validity.
const SOURCE_AGE_MS = MAX_CURRENT_MECHANICAL_SOURCE_AGE_MS
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const raw = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) <= MAX_RAW
const utc = (value: unknown): value is string =>
  typeof value === 'string' &&
  Number.isSafeInteger(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value
const same = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const sameRequest = (a: unknown, b: unknown) =>
  record(a) &&
  record(b) &&
  JSON.stringify(
    Object.keys(a)
      .sort()
      .map((key) => [key, a[key]]),
  ) ===
    JSON.stringify(
      Object.keys(b)
        .sort()
        .map((key) => [key, b[key]]),
    )
const canonicalFacts = (value: unknown): unknown =>
  Array.isArray(value)
    ? ['array', value.map(canonicalFacts)]
    : record(value)
      ? [
          'object',
          Object.keys(value)
            .sort()
            .map((key) => [key, canonicalFacts(value[key])]),
        ]
      : [value === null ? 'null' : typeof value, value]

/** Only the current UI's owner/question can select an assessment. Payload ownership is not a default. */
export function matchingHolderExitViewAssessment(
  value: unknown,
  question: HolderExitViewQuestion,
): HolderExitAssessmentView | null {
  try {
    if (
      !record(value) ||
      !record(value.request) ||
      !record(value.source) ||
      !record(value.finalPayout) ||
      !question.owner ||
      !ADDRESS.test(question.owner) ||
      !question.payoutAsset ||
      !ADDRESS.test(question.payoutAsset) ||
      !raw(question.requestedRaw) ||
      BigInt(question.requestedRaw) === 0n ||
      !Number.isSafeInteger(question.asOfMs) ||
      !Number.isSafeInteger(question.horizonHours) ||
      question.horizonHours <= 0 ||
      value.routeKey !== question.routeKey ||
      !same(value.destinationAddress, question.destination) ||
      !same(value.owner, question.owner) ||
      value.request.assetsRaw !== question.requestedRaw ||
      value.request.horizonHours !== question.horizonHours ||
      !same(value.request.assetAddress, question.payoutAsset) ||
      !same(value.finalPayout.assetAddress, question.payoutAsset) ||
      typeof value.finalPayout.status !== 'string' ||
      !['unassessed', 'simulated', 'mined_observed'].includes(value.finalPayout.status) ||
      (value.finalPayout.amountRaw !== null && !raw(value.finalPayout.amountRaw)) ||
      typeof value.status !== 'string' ||
      !['assessed', 'partial', 'unsupported'].includes(value.status) ||
      !Array.isArray(value.stages) ||
      !value.stages.every(
        (stage) =>
          record(stage) &&
          typeof stage.name === 'string' &&
          typeof stage.relatedToRequest === 'boolean' &&
          typeof stage.status === 'string' &&
          ['simulated', 'reverted', 'unassessed'].includes(stage.status) &&
          (stage.amountRaw === null || raw(stage.amountRaw)) &&
          (stage.assetAddress === null ||
            (typeof stage.assetAddress === 'string' && ADDRESS.test(stage.assetAddress))),
      ) ||
      !record(value.forecast) ||
      value.forecast.status !== 'unvalidated' ||
      value.forecast.prospectiveValidated !== false ||
      value.forecast.futureExit !== null ||
      value.forecast.exitDurationHours !== null ||
      value.source.chainId !== 1 ||
      value.source.originValidation !== 'two_provider' ||
      !Number.isSafeInteger(value.source.blockNumber) ||
      (value.source.blockNumber as number) < 0 ||
      typeof value.source.blockHash !== 'string' ||
      !HASH.test(value.source.blockHash) ||
      !utc(value.source.blockTime) ||
      Date.parse(value.source.blockTime) > question.asOfMs ||
      question.asOfMs - Date.parse(value.source.blockTime) > SOURCE_AGE_MS
    )
      return null
    return value as HolderExitAssessmentView
  } catch {
    return null
  }
}

/** Drop malformed or aged mechanical facts independently of current cash and assessment data. */
export function selectedHolderExitMechanicalOutlook(
  value: unknown,
  assessment: HolderExitAssessment | null,
  question: HolderExitViewQuestion,
): HolderExitMechanicalEnvelope | null {
  try {
    if (
      !matchingHolderExitViewAssessment(assessment, question) ||
      !record(value) ||
      !utc(value.issuedAt) ||
      Date.parse(value.issuedAt) > question.asOfMs ||
      Date.parse(value.issuedAt) < Date.parse(assessment!.source.blockTime) ||
      value.horizonSeconds !== question.horizonHours * 3600 ||
      !sameRequest(value.assessmentRequest, assessment!.request) ||
      !record(value.outlook)
    )
      return null
    // Resolve the subject locally; envelope-supplied families and prongs are never authority.
    // Supplemental subjects require server verification and are deliberately absent here.
    const bound = assessment!
    const subject = resolveHolderExitSubject(bound.routeKey, bound.destinationAddress)
    const expected = projectResolvedHolderExitMechanicalOutlook(
      bound,
      {
        routeKey: bound.routeKey,
        destinationAddress: bound.destinationAddress,
        owner: bound.owner,
        assetAddress: bound.request.assetAddress,
        assetsRaw: bound.request.assetsRaw,
        horizonSeconds: value.horizonSeconds as number,
        nowMs: Date.parse(value.issuedAt),
      },
      subject,
    )
    if (
      expected.status !== 'conditional' ||
      JSON.stringify(canonicalFacts(value.outlook)) !== JSON.stringify(canonicalFacts(expected))
    )
      return null
    return value as HolderExitMechanicalEnvelope
  } catch {
    return null
  }
}

export type HolderMechanicalRow = {
  label: string
  value: string
  detail: string | null
  warning: boolean
}
const gateTime = (at: string) => `${at.slice(0, 19).replace('T', ' ')} UTC`
const amount = (value: string, decimals: number) => {
  const padded = value.padStart(decimals + 1, '0')
  const whole = (decimals ? padded.slice(0, -decimals) : padded).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ',',
  )
  const fraction = decimals ? padded.slice(-decimals).replace(/0+$/, '') : ''
  return fraction ? `${whole}.${fraction}` : whole
}
/** One existing row: dates are mechanical constraints, never a future payout quote. */
export function holderMechanicalRow(
  value: HolderExitMechanicalEnvelope | null,
  payoutAsset: string | null,
  assetDecimals: number | null,
  assetSymbol: string,
  nowMs: number,
): HolderMechanicalRow | null {
  if (!value) return null
  const o = value.outlook
  const q = o.requestedQ
  if (q.windowEndInclusiveAt && nowMs >= Date.parse(q.windowEndInclusiveAt) + 1000)
    return {
      label: 'Holder window',
      value: 'Closed',
      detail: `Ended ${gateTime(q.windowEndInclusiveAt)}`,
      warning: true,
    }
  const initiated = o.prongs.some(
    (p) =>
      p.scope === 'requested_q' && p.basis === 'checked_block_initiation' && p.earliestAt !== null,
  )
  const fee = o.prongs.find(
    (p) =>
      p.scope === 'requested_q' &&
      same(p.assetAddress, payoutAsset) &&
      p.feeMinimumAt &&
      p.feeMinimumNetRaw !== null,
  )
  const details: string[] = []
  if (q.windowEndInclusiveAt) details.push(`Window ends ${gateTime(q.windowEndInclusiveAt)}`)
  if (fee && Number.isInteger(assetDecimals) && assetDecimals! >= 0 && assetDecimals! <= 36)
    details.push(
      `Min fee ${gateTime(fee.feeMinimumAt!)} · net ${amount(fee.feeMinimumNetRaw!, assetDecimals!)} ${assetSymbol}`,
    )
  if (o.pendingReset) details.push('New request resets pending cooldown')
  const timed =
    q.stageEarliestAt &&
    (Date.parse(q.stageEarliestAt) > Date.parse(o.source.blockTime) ||
      q.fullRouteEarliestAt === null ||
      q.windowEndInclusiveAt)
  if (!timed && !fee && !q.windowEndInclusiveAt) return null
  return {
    label: initiated
      ? 'If started at checked block'
      : q.fullRouteEarliestAt
        ? 'Holder timing'
        : 'Known stage timing',
    value: q.stageEarliestAt ? `Not before ${gateTime(q.stageEarliestAt)}` : 'Timing unassessed',
    detail: details.length ? details.join(' · ') : null,
    warning: q.atTarget !== 'conditional_by_target' || q.fullRouteEarliestAt === null,
  }
}
