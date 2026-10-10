import { createHash } from 'node:crypto'
import {
  LOCAL_CARRY_CASH_ROOT,
  localCarryCashObservationsFromVerified,
  verifyLocalCarryCash,
} from '@/scripts/lib/localCarryCashStore.mjs'
import {
  localSupplementalAaveUsdeCashObservationsFromVerified,
  verifyLocalSupplementalAaveUsdeCash,
} from '@/scripts/lib/localSupplementalAaveUsdeCashStore.mjs'
import { readConfiguredLiveCurrentCash } from '@/scripts/research/carry-live-current-cash.mjs'
import {
  buildConditionalSampledCashPathProjection,
  conditionalSampledCashHistoryFromVerifiedTimeline,
  type ConditionalSampledCashCurrentSource,
  type ConditionalSampledCashPathProjection,
} from './conditionalSampledCashPathProjection'
import { localHistoricalSampledCashTimeline } from './localHistoricalSampledCashTimeline'
import type { CarryCashSubject, CarryLiveCurrentCash } from './historicalCashContext'
import {
  buildVenueForecastAnalogPrior,
  type AnalogCashDonor,
  type AnalogCashScenario,
  type VenueForecastAnalogPriorInput,
} from './venueForecastAnalogPrior'
import {
  compatibleAnalogCashProfiles,
  reviewedAnalogCashProfile,
  reviewedAnalogCashSubject,
} from './analogCashProfileRegistry.server'

type Observations = Parameters<typeof localHistoricalSampledCashTimeline>[0]
type LedgerProof = { subjects: CarryCashSubject[]; observations: Observations }
const ledgers = new WeakMap<object, LedgerProof>()
const verifiedManifests = new WeakMap<object, Parameters<typeof verifyLocalCarryCash>[0]>()
const liveSources = new WeakMap<object, ConditionalSampledCashCurrentSource>()
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const exact = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// Only these real verifier/reader entry points grant private provenance.
// A caller-supplied receipt, matching hash, or live source tag grants none.
export function verifyAnalogCashLedger(
  manifest: Parameters<typeof verifyLocalCarryCash>[0],
  root?: string,
) {
  if (root !== undefined && root !== LOCAL_CARRY_CASH_ROOT)
    throw Error('unsupported_analog_cash_root')
  const privateManifest = structuredClone(manifest)
  const ledger = verifyLocalCarryCash(privateManifest, LOCAL_CARRY_CASH_ROOT)
  verifiedManifests.set(manifest, privateManifest)
  ledgers.set(
    ledger,
    structuredClone({
      subjects: privateManifest.subjects,
      observations: localCarryCashObservationsFromVerified(ledger),
    }),
  )
  return ledger
}
export function verifyAnalogSupplementalCashLedger(
  manifest: Parameters<typeof verifyLocalSupplementalAaveUsdeCash>[0],
) {
  const privateManifest = structuredClone(manifest)
  const ledger = verifyLocalSupplementalAaveUsdeCash(privateManifest)
  verifiedManifests.set(manifest, privateManifest)
  ledgers.set(
    ledger,
    structuredClone({
      subjects: privateManifest.subjects,
      observations: localSupplementalAaveUsdeCashObservationsFromVerified(ledger),
    }),
  )
  return ledger
}
export async function readAuthenticatedAnalogLiveCash(
  query: Parameters<typeof readConfiguredLiveCurrentCash>[0],
  options: { manifest: object; cache?: boolean; maxSourceAgeMs?: number },
): Promise<CarryLiveCurrentCash> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => !['manifest', 'cache', 'maxSourceAgeMs'].includes(key))
  )
    return { status: 'unavailable', reason: 'unsupported_live_read_options' }
  const manifest = verifiedManifests.get(options.manifest)
  if (!manifest) return { status: 'unavailable', reason: 'authenticated_manifest_required' }
  const maxSourceAgeMs = options.maxSourceAgeMs ?? 1800000
  if (
    (options.cache !== undefined && typeof options.cache !== 'boolean') ||
    !Number.isSafeInteger(maxSourceAgeMs) ||
    maxSourceAgeMs <= 0 ||
    maxSourceAgeMs > 1800000
  )
    return { status: 'unavailable', reason: 'invalid_live_read_policy' }
  // No caller-supplied provider, client, native reader, clock or origins reach
  // the configured reader. The manifest is the private verifier snapshot.
  // Its shared cache can contain reads obtained through exported injection
  // seams, so authority always requires a fresh configured read.
  const value = await readConfiguredLiveCurrentCash(
    {
      routeKey: query?.routeKey,
      destination: query?.destination,
      ...(query?.asset === undefined ? {} : { asset: query.asset }),
    },
    { manifest: structuredClone(manifest), cache: false, maxSourceAgeMs },
  )
  if (value.status === 'available')
    liveSources.set(
      value,
      structuredClone({
        chainId: 1,
        routeKey: value.routeKey,
        destination: value.destination,
        asset: value.asset,
        assetDecimals: value.assetDecimals,
        cashRaw: value.cashRaw,
        block: value.block,
        blockHash: value.blockHash,
        blockTime: value.blockAt,
        readAt: value.readAtUtc,
        sourceKind: value.sourceKind,
      }),
    )
  return value
}
function receiptSource(
  proof: LedgerProof,
  subject: CarryCashSubject,
  decimals: number,
  asOf: string,
) {
  const latest = proof.observations
    .filter((entry) => entry.collectionMode === 'current')
    .sort((a, b) => b.source.blockAt.localeCompare(a.source.blockAt))[0]
  if (!latest || Date.parse(latest.firstLocalReceiptAt) > Date.parse(asOf)) return null
  const rows = latest.subjects.filter(
    (r) => r.routeKey === subject.route_key && r.destination === subject.destination,
  )
  const row = rows.length === 1 ? rows[0] : null
  if (
    !row ||
    row.state !== 'observed' ||
    row.asset !== subject.asset ||
    row.assetDecimals !== decimals
  )
    return null
  const witness = latest as typeof latest & { manifestSha256: string; receiptSha256: string }
  if (
    !/^[a-f0-9]{64}$/.test(witness.manifestSha256) ||
    !/^[a-f0-9]{64}$/.test(witness.receiptSha256)
  )
    return null
  return {
    chainId: 1 as const,
    routeKey: subject.route_key,
    destination: subject.destination,
    asset: subject.asset,
    assetDecimals: decimals,
    cashRaw: row.cashRaw!,
    block: latest.source.block,
    blockHash: latest.source.blockHash,
    blockTime: latest.source.blockAt,
    readAt: latest.firstLocalReceiptAt,
    sourceKind: 'manifest_bound_ledger' as const,
    manifestSha256: witness.manifestSha256,
    receiptSha256: witness.receiptSha256,
  }
}
export type { AnalogCashScenario } from './venueForecastAnalogPrior'
const unqualified = (reason: string): AnalogCashScenario => ({
  status: 'unqualified',
  reason,
  Ea: null,
})

/** API issuer: provenance stays private and binds frozen plans to native Q and clocks. */
export function issueAnalogCashScenario(input: {
  currentLedger: object | null
  donorLedger: object | null
  subject: CarryCashSubject
  liveCurrent?: CarryLiveCurrentCash
  requestedRaw: string | null
  horizonHours: number
  issueAtUtc: string
  nativeProjection: ConditionalSampledCashPathProjection
  currentSourceConflict: boolean
}): AnalogCashScenario {
  if (
    input.currentSourceConflict ||
    (input.liveCurrent?.status === 'unavailable' &&
      ['cash_origin_disagreement', 'finalized_block_disagreement'].includes(
        input.liveCurrent.reason,
      ))
  )
    return unqualified('current_source_conflict')
  const currentProfile = reviewedAnalogCashSubject(input.subject)
  if (!currentProfile) return unqualified('mechanism_profile_unreviewed')
  const currentProof = input.currentLedger && ledgers.get(input.currentLedger)
  const donorProof = input.donorLedger && ledgers.get(input.donorLedger)
  if (!currentProof) return unqualified('authenticated_ledger_required')
  if (
    !currentProof.subjects.some(
      (s) =>
        s.route_key === input.subject.route_key &&
        s.destination === input.subject.destination &&
        s.asset === input.subject.asset,
    )
  )
    return unqualified('subject_mismatch')
  let currentSource: ConditionalSampledCashCurrentSource | null = receiptSource(
    currentProof,
    input.subject,
    currentProfile.identity.assetDecimals,
    input.issueAtUtc,
  )
  if (input.liveCurrent?.status === 'available') {
    const live = liveSources.get(input.liveCurrent)
    if (
      !live ||
      !exact(live, {
        chainId: 1,
        routeKey: input.liveCurrent.routeKey,
        destination: input.liveCurrent.destination,
        asset: input.liveCurrent.asset,
        assetDecimals: input.liveCurrent.assetDecimals,
        cashRaw: input.liveCurrent.cashRaw,
        block: input.liveCurrent.block,
        blockHash: input.liveCurrent.blockHash,
        blockTime: input.liveCurrent.blockAt,
        readAt: input.liveCurrent.readAtUtc,
        sourceKind: input.liveCurrent.sourceKind,
      })
    )
      return unqualified('authenticated_live_source_required')
    if (
      !reviewedAnalogCashProfile(live) ||
      !exact(currentProfile.identity, {
        routeKey: live.routeKey,
        destination: live.destination,
        asset: live.asset,
        assetDecimals: live.assetDecimals,
      })
    )
      return unqualified('subject_mismatch')
    if (
      currentSource &&
      (BigInt(live.block) < BigInt(currentSource.block) ||
        (live.block === currentSource.block &&
          (live.cashRaw !== currentSource.cashRaw ||
            live.blockHash !== currentSource.blockHash ||
            live.blockTime !== currentSource.blockTime)) ||
        (BigInt(live.block) > BigInt(currentSource.block) &&
          Date.parse(live.blockTime) <= Date.parse(currentSource.blockTime)))
    )
      return unqualified('current_source_conflict')
    currentSource = live
  }
  if (!currentSource) return unqualified('authenticated_current_source_unavailable')
  if (currentSource.cashRaw === '0')
    return unqualified('zero_current_cash_has_no_normalization_base')
  if (!input.requestedRaw) return unqualified('invalid_requested_raw')
  if (Date.parse(input.issueAtUtc) - Date.parse(currentSource.blockTime) > 1800000)
    return unqualified('source_stale')
  // The caller cannot force analog fallback by mislabelling an available own
  // history. Reconstruct the native prong from private authenticated evidence.
  const ownTimeline = localHistoricalSampledCashTimeline(currentProof.observations, input.subject)
  if (ownTimeline.status === 'sampled_timeline') {
    const ownProjection = buildConditionalSampledCashPathProjection(
      {
        history: conditionalSampledCashHistoryFromVerifiedTimeline(
          currentProof.observations,
          ownTimeline,
        ),
        currentSource,
        request: { requestedRaw: input.requestedRaw, asOf: input.issueAtUtc },
      },
      hash,
    )
    if (ownProjection.status === 'estimated') return unqualified('own_native_history_preferred')
    if (ownProjection.reason !== 'insufficient_eligible_history')
      return unqualified(ownProjection.reason)
  } else if (ownTimeline.reason === 'identity_mismatch') return unqualified('history_unverified')
  // Supplied status can only censor; it never authenticates or hides own data.
  if (input.nativeProjection.status === 'estimated')
    return unqualified('own_native_history_preferred')
  if (input.nativeProjection.reason !== 'insufficient_eligible_history')
    return unqualified(input.nativeProjection.reason)
  if (!donorProof) return unqualified('authenticated_ledger_required')
  const donors: AnalogCashDonor[] = []
  for (const subject of donorProof.subjects) {
    if (
      subject.route_key === input.subject.route_key &&
      subject.destination === input.subject.destination
    )
      continue
    const profile = reviewedAnalogCashSubject(subject)
    if (!profile || !compatibleAnalogCashProfiles(currentProfile, profile)) continue
    const timeline = localHistoricalSampledCashTimeline(donorProof.observations, subject)
    if (timeline.status !== 'sampled_timeline') continue
    const history = conditionalSampledCashHistoryFromVerifiedTimeline(
      donorProof.observations,
      timeline,
    )
    const verificationSource = receiptSource(
      donorProof,
      subject,
      profile.identity.assetDecimals,
      input.issueAtUtc,
    )
    if (!history || !verificationSource) continue
    const verificationAtUtc = verificationSource.readAt
    const verified = buildConditionalSampledCashPathProjection(
      {
        history,
        currentSource: verificationSource,
        request: { requestedRaw: '1', asOf: verificationAtUtc },
      },
      hash,
    )
    if (
      verified.status !== 'estimated' ||
      history.points.some(
        (p) =>
          BigInt(p[1]) >= BigInt(currentSource!.block) ||
          Date.parse(p[3]) >= Date.parse(currentSource!.blockTime),
      )
    )
      continue
    if (
      !history.points.some(
        (p, i) =>
          i > 0 &&
          p[0] === history.points[i - 1][0] + 1 &&
          Date.parse(p[3]) - Date.parse(history.points[i - 1][3]) <= 91800000 &&
          history.points[i - 1][4] !== '0',
      )
    )
      continue
    donors.push({
      profile,
      history,
      verificationSource,
      verificationAtUtc,
      nativeUnitMap: {
        donorAsset: profile.identity.asset,
        donorDecimals: profile.identity.assetDecimals,
        currentAsset: currentProfile.identity.asset,
        currentDecimals: currentProfile.identity.assetDecimals,
        normalization: 'dimensionless_net_delta_over_donor_cash_before',
      },
    })
  }
  donors.sort(
    (a, b) =>
      Number(b.profile.identity.asset === currentProfile.identity.asset) -
        Number(a.profile.identity.asset === currentProfile.identity.asset) ||
      a.profile.identity.routeKey.localeCompare(b.profile.identity.routeKey) ||
      a.profile.identity.destination.localeCompare(b.profile.identity.destination),
  )
  if (!donors.length) return unqualified('compatible_authenticated_donor_history_unavailable')
  const plan: VenueForecastAnalogPriorInput = structuredClone({
    currentProfile,
    currentSource,
    requestedRaw: input.requestedRaw,
    issueAtUtc: input.issueAtUtc,
    horizonHours: input.horizonHours,
    maxHistoricalGapSeconds: 91800,
    donors: donors.slice(0, 16),
  })
  function freeze(value: unknown) {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child)
      Object.freeze(value)
    }
  }
  freeze(plan)
  // Equality binds copies to an already authenticated private plan; it does
  // not grant authority to inputs, source tags, manifests or history hashes.
  const prior = buildVenueForecastAnalogPrior(plan, hash, {
    current: (candidate) => exact(candidate, plan) && ledgers.has(input.currentLedger!),
    donor: (candidate) =>
      ledgers.has(input.donorLedger!) && plan.donors.some((d) => exact(d, candidate)),
  })
  return prior
    ? {
        status: 'analog_cash_scenario',
        claim: 'conditional_analog_native_cash_only',
        Ea: null,
        prior,
        issuedInput: structuredClone(plan),
        currentSource: structuredClone(currentSource),
        donorSelection: {
          eligibleDonors: donors.length,
          selectedDonors: plan.donors.length,
          limit: 16,
          method: 'exact_asset_then_subject_key',
        },
        historicalExtremesAreConfidenceBands: false,
        holderExecutableExit: false,
        forecastValidated: false,
      }
    : unqualified('invalid_analog_plan_or_native_overflow')
}
