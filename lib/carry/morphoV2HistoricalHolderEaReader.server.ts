/** Optional archive reads: no RPC startup, cache, jobs, owner proof or execution. */
import {
  MORPHO_V2_HISTORICAL_HOLDER_EA_DEADLINE_MS,
  decodeMorphoV2HistoricalHolderEaUint,
  morphoV2HistoricalHolderEaCalldata,
  selectMorphoV2HistoricalHolderEaAnchors,
  type MorphoV2HistoricalHolderEaCurrentSource,
  type MorphoV2HistoricalHolderEaOriginObservation,
  type MorphoV2HistoricalHolderEaTrace,
} from './morphoV2HistoricalHolderEaEvidence'
import type { MorphoV2ProtocolRequestClient } from './morphoV2ProtocolCapacityReplay'
import type { MorphoV2TrustedProfile } from './morphoV2TrustedProfiles'

const MAX_AGE_MS = 2 * 60 * 60 * 1000
function check(value: boolean): asserts value {
  if (!value) throw new Error('morpho_historical_holder_ea_read_invalid')
}
/** Uses the existing independently configured client (8s timeout, retry 0).
 * Each ordered native call redeems the exact same full S at a reviewed hash.
 * A failed, partial, stale or late origin produces no observation. */
export async function readMorphoV2HistoricalHolderEaOrigin(
  client: MorphoV2ProtocolRequestClient,
  source: MorphoV2HistoricalHolderEaCurrentSource,
  options: {
    profile: MorphoV2TrustedProfile
    sharesRaw: string
    now?: () => number
    deadlineMs?: number
  },
): Promise<MorphoV2HistoricalHolderEaOriginObservation | null> {
  try {
    // Retain private profile identity; snapshot all mutable input before await.
    // Validation runs on the original source before cloning could invoke an accessor.
    selectMorphoV2HistoricalHolderEaAnchors(options.profile, source)
    const profile = options.profile,
      currentSource = structuredClone(source),
      sharesRaw = options.sharesRaw,
      now = options.now ?? Date.now,
      deadlineMs = options.deadlineMs ?? MORPHO_V2_HISTORICAL_HOLDER_EA_DEADLINE_MS,
      anchors = selectMorphoV2HistoricalHolderEaAnchors(profile, currentSource),
      subject = structuredClone(profile.subject),
      data = morphoV2HistoricalHolderEaCalldata(sharesRaw),
      request = client.request.bind(client),
      wallStarted = performance.now(),
      started = now()
    const fresh = (at: number) =>
      Number.isSafeInteger(at) &&
      at >= 0 &&
      at >= Date.parse(currentSource.blockTime) - 120_000 &&
      at - Date.parse(currentSource.blockTime) <= MAX_AGE_MS
    check(
      Number.isSafeInteger(deadlineMs) &&
        deadlineMs > 0 &&
        deadlineMs <= MORPHO_V2_HISTORICAL_HOLDER_EA_DEADLINE_MS &&
        fresh(started),
    )
    const traces: MorphoV2HistoricalHolderEaTrace[] = []
    let previous = started
    for (const point of anchors) {
      const begun = now(),
        remaining = deadlineMs - (performance.now() - wallStarted)
      check(remaining > 0 && fresh(begun) && begun >= previous && begun - started < deadlineMs)
      const params: MorphoV2HistoricalHolderEaTrace['params'] = [
        { to: subject.destination as `0x${string}`, data },
        { blockHash: point.source.blockHash as `0x${string}`, requireCanonical: true },
      ]
      let timer: ReturnType<typeof setTimeout> | undefined
      const work = Promise.resolve().then(() => {
        const launch = now()
        check(
          performance.now() - wallStarted < deadlineMs &&
            launch >= begun &&
            launch - started < deadlineMs &&
            fresh(launch),
        )
        return request({ method: 'eth_call', params: structuredClone(params) })
      })
      const result = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('morpho_historical_holder_ea_deadline')),
            remaining,
          )
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer)
      })
      const completed = now()
      check(
        performance.now() - wallStarted <= deadlineMs &&
          completed >= begun &&
          completed - started <= deadlineMs &&
          fresh(completed),
      )
      decodeMorphoV2HistoricalHolderEaUint(result)
      traces.push({
        source: structuredClone(point.source),
        key: 'previewRedeem',
        method: 'eth_call',
        params,
        result: result as `0x${string}`,
        startedAtUtc: new Date(begun).toISOString(),
        completedAtUtc: new Date(completed).toISOString(),
      })
      previous = completed
    }
    const read = now()
    check(
      performance.now() - wallStarted <= deadlineMs &&
        read >= previous &&
        read - started <= deadlineMs &&
        fresh(read),
    )
    return {
      schemaVersion: 1,
      kind: 'morpho_v2_historical_holder_ea_origin_v1',
      profileId: profile.id,
      routeKey: subject.routeKey,
      destination: subject.destination as `0x${string}`,
      asset: subject.asset as `0x${string}`,
      assetDecimals: subject.assetDecimals,
      shareDecimals: subject.shareDecimals,
      currentSource,
      sharesRaw,
      startedAtUtc: new Date(started).toISOString(),
      readAtUtc: new Date(read).toISOString(),
      deadlineMs,
      traces,
    }
  } catch {
    return null
  }
}
