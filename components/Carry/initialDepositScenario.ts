import { sha256, stringToHex } from 'viem'
import {
  initialDepositMarket,
  selectedInitialDepositCapacityProjection,
  type InitialDepositCapacityProjection,
} from '@/lib/carry/initialDepositCapacityProjection'
import type { ConditionalSampledCashCurrentSource } from '@/lib/carry/conditionalSampledCashPathProjection'

export type CarryScenarioMode = 'exit' | 'initial_deposit'
export type InitialDepositQuestion = {
  mode: 'initial_deposit'
  routeKey: string
  destination: string
  depositAssetsRaw: string
  plannedExitAssetsRaw: string
  horizonHours: number
  asset: string
  assetDecimals: 6
}
export type InitialDepositScenarioIssue = {
  question: InitialDepositQuestion
  sentAtMs: number
  receivedAtMs: number
  projection: InitialDepositCapacityProjection
  dailyProjection: unknown
}
export type InitialDepositCurrentWitness = {
  routeKey: string
  destination: string
  assetAddress?: string | null
  assetDecimals: number
  cashRaw: string
  block?: string
  blockHash?: string
  observedAt: string
  freshness: string
  sourceKind?: 'manifest_bound_ledger' | 'live_read_only_two_origin_finalized'
  readAtUtc?: string
  firstLocalReceiptAt?: string
  manifestSha256?: string
  receiptSha256?: string
}
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const exact = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => exact(v, b[i]))
    )
  if (record(a) || record(b))
    return (
      record(a) &&
      record(b) &&
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((k) => Object.hasOwn(b, k) && exact(a[k], b[k]))
    )
  return Object.is(a, b)
}
const hash = (v: string) => sha256(stringToHex(v)).slice(2)
export function changeInitialDepositAmounts(
  current: { depositSize: string; plannedExitSize: string; plannedExitEdited: boolean },
  field: 'deposit' | 'planned_exit',
  value: string,
) {
  return field === 'planned_exit'
    ? { ...current, plannedExitSize: value, plannedExitEdited: true }
    : {
        ...current,
        depositSize: value,
        plannedExitSize: current.plannedExitEdited ? current.plannedExitSize : value,
      }
}
export function initialDepositNativeRaw(value: string): string | null {
  if (!/^(0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value) || value.length > 85) return null
  const [whole, fraction = ''] = value.split('.')
  const n = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'))
  return n > 0n && n < 1n << 256n ? String(n) : null
}
export function initialDepositQuestion(
  mode: CarryScenarioMode,
  routeKey: string,
  destination: string,
  depositSize: string,
  plannedExitSize: string,
  horizonHours: number,
): InitialDepositQuestion | null {
  const m = initialDepositMarket(routeKey, destination.toLowerCase())
  const D = initialDepositNativeRaw(depositSize),
    Q = initialDepositNativeRaw(plannedExitSize)
  return mode === 'initial_deposit' && m && D && Q && [1, 24, 48, 168].includes(horizonHours)
    ? {
        mode,
        routeKey,
        destination: destination.toLowerCase(),
        depositAssetsRaw: D,
        plannedExitAssetsRaw: Q,
        horizonHours,
        asset: m.underlying.toLowerCase(),
        assetDecimals: 6,
      }
    : null
}
export function initialDepositSourceFromWitness(
  question: InitialDepositQuestion,
  witness: InitialDepositCurrentWitness | null,
): ConditionalSampledCashCurrentSource | null {
  if (
    !witness ||
    witness.freshness !== 'fresh' ||
    witness.routeKey !== question.routeKey ||
    witness.destination.toLowerCase() !== question.destination ||
    witness.assetAddress?.toLowerCase() !== question.asset ||
    witness.assetDecimals !== 6 ||
    typeof witness.block !== 'string' ||
    !witness.blockHash ||
    !witness.sourceKind
  )
    return null
  const local = witness.sourceKind === 'manifest_bound_ledger'
  const readAt = local ? witness.firstLocalReceiptAt : witness.readAtUtc
  if (!readAt) return null
  return {
    chainId: 1,
    routeKey: question.routeKey,
    destination: question.destination,
    asset: question.asset,
    assetDecimals: 6,
    cashRaw: witness.cashRaw,
    block: witness.block,
    blockHash: witness.blockHash,
    blockTime: witness.observedAt,
    readAt,
    sourceKind: witness.sourceKind,
    ...(local
      ? { manifestSha256: witness.manifestSha256, receiptSha256: witness.receiptSha256 }
      : {}),
  }
}
export function initialDepositIssueFromResponse(
  response: unknown,
  question: InitialDepositQuestion,
  sentAtMs: number,
  receivedAtMs: number,
): InitialDepositScenarioIssue | null {
  if (
    !record(response) ||
    response.routeKey !== question.routeKey ||
    response.destination !== question.destination ||
    !record(response.initialDepositProjection) ||
    !Number.isSafeInteger(sentAtMs) ||
    !Number.isSafeInteger(receivedAtMs) ||
    sentAtMs > receivedAtMs
  )
    return null
  const projection = response.initialDepositProjection
  if (
    projection.status !== 'conditional_initial_deposit_projection' ||
    !record(projection.request) ||
    typeof projection.request.asOf !== 'string'
  )
    return null
  const issueAt = Date.parse(projection.request.asOf)
  if (
    !Number.isSafeInteger(issueAt) ||
    issueAt < sentAtMs ||
    issueAt > receivedAtMs ||
    projection.request.mode !== question.mode ||
    projection.request.depositAssetsRaw !== question.depositAssetsRaw ||
    projection.request.plannedExitAssetsRaw !== question.plannedExitAssetsRaw ||
    projection.request.horizonHours !== question.horizonHours
  )
    return null
  return structuredClone({
    question,
    sentAtMs,
    receivedAtMs,
    projection,
    dailyProjection: response.conditionalSampledCashPathProjection,
  }) as InitialDepositScenarioIssue
}
/** Rebuild once at the original issue against independent observed cash, never its own hypothetical C+D. */
export function issuedInitialDepositScenario(
  issue: InitialDepositScenarioIssue | null,
  expected: InitialDepositQuestion | null,
  witness: InitialDepositCurrentWitness | null,
) {
  if (!issue || !expected || !exact(issue.question, expected)) return null
  const source = initialDepositSourceFromWitness(expected, witness)
  const p = issue.projection
  if (
    !source ||
    !record(p) ||
    p.status !== 'conditional_initial_deposit_projection' ||
    !record(p.request) ||
    typeof p.request.asOf !== 'string' ||
    !record(p.hypotheticalReceipt)
  )
    return null
  const issueAtMs = Date.parse(p.request.asOf)
  if (
    !Number.isSafeInteger(issue.sentAtMs) ||
    !Number.isSafeInteger(issue.receivedAtMs) ||
    !Number.isSafeInteger(issueAtMs) ||
    issue.sentAtMs > issueAtMs ||
    issueAtMs > issue.receivedAtMs
  )
    return null
  const receipt = p.hypotheticalReceipt
  const selected = selectedInitialDepositCapacityProjection(
    p,
    {
      currentSource: source,
      dailyProjection: issue.dailyProjection,
      depositAssetsRaw: expected.depositAssetsRaw,
      plannedExitAssetsRaw: expected.plannedExitAssetsRaw,
      horizonHours: expected.horizonHours,
      asOfMs: issueAtMs,
      nativeAgreement: p.nativeAgreement,
      nativeUnavailableReason: receipt.status === 'unavailable' ? receipt.reason : undefined,
    },
    issue.receivedAtMs,
    hash,
  )
  return selected?.status === 'conditional_initial_deposit_projection' ? selected : null
}
/** Ticks only expire the fixed issuance. They never recompute a path or slide any clock. */
export function initialDepositRenderWindow(
  value: ReturnType<typeof issuedInitialDepositScenario>,
  asOfMs: number,
) {
  return Boolean(
    value &&
    Number.isSafeInteger(asOfMs) &&
    asOfMs >= Date.parse(value.request.asOf) &&
    asOfMs <= Date.parse(value.cashOnlyProcess.sourceProofValidUntil) &&
    asOfMs < Date.parse(value.target.at),
  )
}
