import type { HolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import {
  bindMorphoV2NativeHolderAssessment,
  completeMorphoV2NativeHolderObservation,
  readMorphoV2NativeHolderAtSource,
} from '@/lib/carry/morphoV2NativeHolderIdentity.server'
import type { MorphoHolderPositionObservation } from '@/lib/carry/morphoV2HolderPositionEvidence'

/** Synthetic RPC results enter the real native receipt boundary; plain objects cannot brand themselves. */
export async function fixtureNativeHolderObservation(
  candidate: MorphoHolderPositionObservation,
  owner: `0x${string}`,
  sharesRaw: string,
  fullEaRaw: string,
  assetDecimals: number,
  shareDecimals: number,
): Promise<MorphoHolderPositionObservation> {
  try {
    const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`
    const begin = Date.parse(candidate.startedAtUtc),
      balanceEnd = Date.parse(candidate.traces[0].completedAtUtc),
      previewStart = Date.parse(candidate.traces[1].startedAtUtc),
      previewEnd = Date.parse(candidate.traces[1].completedAtUtc)
    const times = [begin, begin, begin, begin, balanceEnd, balanceEnd, balanceEnd, balanceEnd, previewStart, previewEnd]
    const client = { request: async ({ params }: { params: [{ to: string; data: string }, unknown] }) => {
      const [{ to, data }] = params
      if (data === '0x38d52e0f') return word(BigInt(candidate.asset))
      if (data === '0x313ce567') return word(BigInt(to === candidate.asset ? assetDecimals : shareDecimals))
      if (data.startsWith('0x70a08231')) return word(BigInt(sharesRaw))
      if (data.startsWith('0x4cdad506')) return word(BigInt(fullEaRaw))
      throw new Error('unexpected_fixture_rpc')
    } }
    const receipt = await readMorphoV2NativeHolderAtSource(client as never,
      { routeKey: candidate.routeKey, destination: candidate.destination, owner, source: candidate.source },
      () => times.shift() ?? previewEnd)
    const observation = completeMorphoV2NativeHolderObservation(receipt, begin, Date.parse(candidate.readAtUtc))
    if (!observation) return candidate
    // Old fixture deadlines were 8 seconds. Production native transport already uses 120 seconds.
    const normalized = { ...candidate, deadlineMs: 120_000 }
    if (JSON.stringify(observation) !== JSON.stringify(normalized)) return candidate
    candidate.deadlineMs = 120_000
    return observation
  } catch { return candidate }
}

export async function fixtureNativeHolderAssessment<T extends HolderExitAssessment>(a: T): Promise<T> {
  const candidate = a.morphoHolderPositionObservation, q = a.capacityQuote, p = q?.sourceHolderPosition
  if (candidate && q && p && q.entitlementRaw !== null)
    a.morphoHolderPositionObservation = await fixtureNativeHolderObservation(candidate,
      a.owner as `0x${string}`, p.sharesRaw, q.entitlementRaw, q.assetDecimals, p.shareDecimals)
  return bindMorphoV2NativeHolderAssessment(a)
}
