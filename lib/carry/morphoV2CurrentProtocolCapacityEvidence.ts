/** Server-only native optional observations; no provider URLs or holder E are accepted here. */
import { createHash } from 'node:crypto'
import type { MorphoV2HolderTimeProcessInput } from './morphoV2HolderTimeProcess'
import { loadMorphoV2PilotHistoricalEvidence } from './morphoV2PilotHistoricalEvidence'
import { morphoV2PinnedProtocolHistory } from './morphoV2ProtocolCapacityHistoryPins'
import {
  approveReviewedMorphoV2ProtocolHistory,
  reviewedMorphoV2ProtocolHistory,
  type ReviewedMorphoV2ProtocolCurrent,
  type ReviewedMorphoV2ProtocolHistory,
} from './morphoV2ReviewedProtocolHistories'
import {
  isAppOwnedMorphoV2TrustedProfile,
  resolveMorphoV2TrustedProfile,
  type MorphoV2TrustedProfile,
} from './morphoV2TrustedProfiles'
import {
  morphoV2ProtocolReadPlan as pureMorphoV2ProtocolReadPlan,
  morphoV2ProtocolBorrowRateReadSpec,
  normalizeMorphoV2ProtocolReadResult,
  isMorphoV2NativeSourceValid,
  replayMorphoV2CurrentProtocolOrigin as pureReplayMorphoV2CurrentProtocolOrigin,
  replayMorphoV2CurrentProtocolCapacityEvidence as pureReplayMorphoV2CurrentProtocolCapacityEvidence,
  approveMorphoV2CurrentProtocolCapacityEvidence as pureApproveMorphoV2CurrentProtocolCapacityEvidence,
  type MorphoV2NativeSource,
  type MorphoV2ProtocolTrace,
  type MorphoV2ProtocolOriginObservation,
  type MorphoV2ProtocolRequestClient,
  type MorphoV2ProtocolReadSpec,
  type MorphoV2ProtocolCapacityExpected,
} from './morphoV2ProtocolCapacityReplay'
export type {
  MorphoV2NativeSource,
  MorphoV2ProtocolTrace,
  MorphoV2ProtocolOriginObservation,
  MorphoV2ProtocolRequestClient,
  MorphoV2ProtocolReadSpec,
  MorphoV2ProtocolCapacityExpected,
  MorphoV2ProtocolReplayExpected,
  MorphoV2ProtocolCapacityObservation,
} from './morphoV2ProtocolCapacityReplay'
const sha256Text = (text: string) => createHash('sha256').update(text).digest('hex')
function check(value: boolean, why: string): asserts value {
  if (!value) throw Error(why)
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
function selectedProfile(profile?: MorphoV2TrustedProfile): MorphoV2TrustedProfile {
  if (profile !== undefined) {
    check(isAppOwnedMorphoV2TrustedProfile(profile), 'trusted_profile')
    return profile
  }
  const subject = morphoV2PinnedProtocolHistory().subject
  const legacy = resolveMorphoV2TrustedProfile(subject.routeKey, subject.destination, subject.asset)
  check(isAppOwnedMorphoV2TrustedProfile(legacy), 'trusted_profile')
  return legacy
}
type HistoryCacheEntry = {
  promise: Promise<ReviewedMorphoV2ProtocolHistory>
  value: ReviewedMorphoV2ProtocolHistory | null
}
// Only history is cached. Current sources, origins and receipts are always replayed.
// A private registered profile is validated before its ID can address this cache.
const histories = new Map<string, HistoryCacheEntry>()
async function historical(profile: MorphoV2TrustedProfile) {
  check(isAppOwnedMorphoV2TrustedProfile(profile), 'trusted_profile')
  const selected = reviewedMorphoV2ProtocolHistory(profile)
  check(selected !== null, 'profile_history')
  let entry = histories.get(profile.id)
  if (!entry) {
    // Explicit legacy prewarm starts the raw loader synchronously, as before.
    // The read path only checks settled cache values and never starts this work.
    const loading =
      profile.id === 'morpho_v2_usdc_reviewed_protocol_history'
        ? loadMorphoV2PilotHistoricalEvidence().then((capture) => capture.evidence)
        : [
              'morpho_v2_ausd_observed_protocol_history',
              'morpho_v2_eurcv_observed_protocol_history',
              'morpho_v2_link_observed_protocol_history',
            ].includes(profile.id)
          ? import('./morphoV2MultiAssetObservedHistory.server').then(async (adapter) => {
              const history = await adapter.loadMorphoV2MultiAssetObservedProtocolHistory(profile)
              check(history !== null, 'observed_native_archive')
              return history
            })
          : Promise.resolve(selected)
    const fresh: HistoryCacheEntry = {
      value: null,
      promise: loading.then((history) => {
        check(
          approveReviewedMorphoV2ProtocolHistory(profile, history, sha256Text),
          'history_frame_pin',
        )
        fresh.value = freeze(structuredClone(history))
        return fresh.value
      }),
    }
    fresh.promise = fresh.promise.catch((error) => {
      if (histories.get(profile.id) === fresh) histories.delete(profile.id)
      throw error
    })
    histories.set(profile.id, fresh)
    entry = fresh
  }
  return structuredClone(await entry.promise)
}
/** Explicit finite server prewarm, with no RPC, OS job or automatic read-time scheduling.
 * Raw pinned replay may exceed the optional read budget on a cold process. A cold
 * read fails immediately; it never waits for this promise or launches calls later. */
export async function prewarmMorphoV2ProtocolHistory(profile?: MorphoV2TrustedProfile) {
  try {
    await historical(selectedProfile(profile))
    return true
  } catch {
    return false
  }
}

/** No retry is made. The supplied native client must be configured with timeout8s/retry0.
 * Sequential requests stop permanently on any failure/deadline; late work cannot approve.
 * The optional producer neither changes required quote facts nor constructs holder E. */
export async function readMorphoV2CurrentProtocolOrigin(
  client: MorphoV2ProtocolRequestClient,
  source: MorphoV2NativeSource,
  options: { now?: () => number; deadlineMs?: number; profile?: MorphoV2TrustedProfile } = {},
) {
  try {
    const profile = selectedProfile(options.profile),
      s = structuredClone(source),
      request = client.request.bind(client),
      now = options.now ?? Date.now,
      deadlineMs = options.deadlineMs ?? 8000,
      startWall = performance.now(),
      started = now()
    check(
      Number.isSafeInteger(deadlineMs) &&
        deadlineMs >= 1 &&
        deadlineMs <= 8000 &&
        isMorphoV2NativeSourceValid(s, started),
      'read_setup',
    )
    check(reviewedMorphoV2ProtocolHistory(profile) !== null, 'profile_history')
    if (!histories.get(profile.id)?.value) return null
    const traces: MorphoV2ProtocolTrace[] = [],
      base = pureMorphoV2ProtocolReadPlan(s, undefined, profile)
    let bytes = 0
    const launch = async (spec: MorphoV2ProtocolReadSpec) => {
      const remaining = deadlineMs - (performance.now() - startWall)
      check(
        remaining > 0 && traces.length < 31 && isMorphoV2NativeSourceValid(s, now()),
        'read_deadline',
      )
      const params = structuredClone(spec.params),
        begun = now()
      let timer: ReturnType<typeof setTimeout> | undefined
      const work = Promise.resolve().then(() => {
        const wire = { method: spec.method, params: structuredClone(params) }
        check(
          performance.now() - startWall < deadlineMs && isMorphoV2NativeSourceValid(s, now()),
          'launch_deadline',
        )
        return request(wire)
      })
      const result = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('read_deadline')), remaining)
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer)
      })
      const completed = now()
      check(
        performance.now() - startWall <= deadlineMs &&
          Number.isSafeInteger(completed) &&
          completed >= begun &&
          completed - started <= deadlineMs,
        'late_completion',
      )
      const safe = normalizeMorphoV2ProtocolReadResult(spec, result, s)
      bytes += JSON.stringify(safe).length
      check(bytes <= 256 * 1024, 'retained_bytes')
      const trace = {
        key: spec.key,
        method: spec.method,
        params,
        result: structuredClone(safe),
        startedAtUtc: new Date(begun).toISOString(),
        completedAtUtc: new Date(completed).toISOString(),
      }
      traces.push(trace)
      return trace
    }
    for (const spec of base.slice(0, -1)) await launch(spec)
    await launch(
      morphoV2ProtocolBorrowRateReadSpec(
        s,
        traces.find((x) => x.key === 'market')!.result,
        profile,
      ),
    )
    await launch(base.at(-1)!)
    const observation: MorphoV2ProtocolOriginObservation = {
      source: s,
      startedAtUtc: new Date(started).toISOString(),
      readAtUtc: new Date(now()).toISOString(),
      deadlineMs,
      traces,
    }
    check(performance.now() - startWall <= deadlineMs, 'read_deadline')
    const approved = await replayMorphoV2CurrentProtocolOrigin(observation, s, now(), profile)
    check(
      performance.now() - startWall <= deadlineMs &&
        isMorphoV2NativeSourceValid(s, now()) &&
        now() - started <= deadlineMs,
      'approval_deadline',
    )
    return approved ? observation : null
  } catch {
    return null
  }
}
/** Existing server signatures retain explicit raw-history approval before pure replay. */
export async function morphoV2ProtocolReadPlan(
  source: MorphoV2NativeSource,
  market?: readonly bigint[],
  profile?: MorphoV2TrustedProfile,
) {
  const selected = selectedProfile(profile),
    s = structuredClone(source),
    currentMarket = market ? [...market] : undefined
  await historical(selected)
  return pureMorphoV2ProtocolReadPlan(s, currentMarket, selected)
}
export async function replayMorphoV2CurrentProtocolOrigin(
  value: unknown,
  expectedSource: MorphoV2NativeSource,
  asOfMs: number,
  profile?: MorphoV2TrustedProfile,
) {
  try {
    const selected = selectedProfile(profile),
      observation = structuredClone(value),
      source = structuredClone(expectedSource)
    await historical(selected)
    return pureReplayMorphoV2CurrentProtocolOrigin(observation, source, asOfMs, selected)
  } catch {
    return null
  }
}
type LegacyExpected = Omit<MorphoV2ProtocolCapacityExpected, 'profile'> & { profile?: undefined }
type ApprovedCurrent<T> = {
  current: T
  acceptEvidence: (candidate: unknown) => boolean
  sourceImplementationEquivalence: false
}
function snapshotExpected(expected: MorphoV2ProtocolCapacityExpected) {
  const profile = selectedProfile(expected.profile)
  return {
    ...structuredClone({
      source: expected.source,
      asOfMs: expected.asOfMs,
      originHosts: expected.originHosts,
    }),
    profile,
  }
}
export async function replayMorphoV2CurrentProtocolCapacityEvidence(
  value: unknown,
  expected: LegacyExpected,
): Promise<MorphoV2HolderTimeProcessInput['current'] | null>
export async function replayMorphoV2CurrentProtocolCapacityEvidence(
  value: unknown,
  expected: MorphoV2ProtocolCapacityExpected,
): Promise<ReviewedMorphoV2ProtocolCurrent | null>
export async function replayMorphoV2CurrentProtocolCapacityEvidence(
  value: unknown,
  expected: MorphoV2ProtocolCapacityExpected,
) {
  try {
    const authority = snapshotExpected(expected),
      observation = structuredClone(value)
    await historical(authority.profile)
    return pureReplayMorphoV2CurrentProtocolCapacityEvidence(observation, authority, sha256Text)
  } catch {
    return null
  }
}
export async function approveMorphoV2CurrentProtocolCapacityEvidence(
  value: unknown,
  expected: LegacyExpected,
): Promise<ApprovedCurrent<MorphoV2HolderTimeProcessInput['current']> | null>
export async function approveMorphoV2CurrentProtocolCapacityEvidence(
  value: unknown,
  expected: MorphoV2ProtocolCapacityExpected,
): Promise<ApprovedCurrent<ReviewedMorphoV2ProtocolCurrent> | null>
export async function approveMorphoV2CurrentProtocolCapacityEvidence(
  value: unknown,
  expected: MorphoV2ProtocolCapacityExpected,
) {
  try {
    const authority = snapshotExpected(expected),
      observation = structuredClone(value)
    await historical(authority.profile)
    return pureApproveMorphoV2CurrentProtocolCapacityEvidence(observation, authority, sha256Text)
  } catch {
    return null
  }
}
