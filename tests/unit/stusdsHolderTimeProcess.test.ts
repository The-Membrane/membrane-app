import { describe, it, expect } from 'vitest'
import evidence from '@/data/research/venue-signals/stusds-historical-capacity-2026-10-07T14-29.export.json'
import {
  buildHolderExitCapacityQuote,
  agreeHolderExitCapacityQuotes,
} from '@/lib/carry/holderExitCapacity'
import { stusdsRayPow } from '@/lib/carry/stusdsHistoricalHolderCapacityProjection'
import { stusdsPinnedProtocolHistory } from '@/lib/carry/stusdsProtocolCapacityHistoryPins'
import {
  buildStusdsHolderTimeProcess,
  selectedStusdsHolderTimeProcess,
} from '@/lib/carry/stusdsHolderTimeProcess'
const UNIT = 10n ** 18n
const routeKey = 'USDS → StUsds [USDS]',
  destination = '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9',
  asset = evidence.asset,
  owner = '0x' + 'b'.repeat(40)
function fixture(E = 1000n * UNIT, Q = UNIT) {
  const current = {
    point: structuredClone(evidence.current),
    readAtUtc: evidence.knowledgeCutoff,
    captureReceiptSha256: evidence.captureReceiptSha256,
  }
  const asOfMs = Date.parse(evidence.knowledgeCutoff),
    source = {
      chainId: 1 as const,
      blockNumber: Number(current.point.source.blockNumber),
      blockHash: current.point.source.blockHash,
      blockTime: current.point.source.blockTime,
      finalized: true as const,
    }
  const assessment = {
    status: 'assessed',
    routeKey,
    destinationAddress: destination,
    owner,
    request: { assetsRaw: String(Q), assetAddress: asset, horizonHours: 24 },
    source: { ...source, originValidation: 'single_provider' },
    stages: [
      {
        name: 'withdrawal',
        relatedToRequest: true,
        status: 'reverted',
        assetAddress: asset,
        amountRaw: String(Q),
      },
    ],
    finalPayout: { status: 'unassessed', assetAddress: asset, amountRaw: null },
  }
  const quote = buildHolderExitCapacityQuote(
    assessment as any,
    {
      entitlementRaw: String(E),
      quotedMaxWithdrawRaw: '0',
      quotedMaxWithdrawStatus: 'quoted',
      effectiveLimitRaw: null,
      withdrawalsPaused: null,
    },
    asOfMs,
  )!
  expect(quote).toBeTruthy()
  const capacityAgreement = agreeHolderExitCapacityQuotes(
    { host: 'one.example', quote },
    { host: 'two.example', quote },
    asOfMs,
  )!
  const input = {
    history: stusdsPinnedProtocolHistory(),
    current,
    capacityAgreement,
    binding: {
      routeKey,
      destination,
      owner,
      requestedRaw: String(Q),
      asset,
      assetDecimals: 18,
      currentSource: source,
      asOfMs,
    },
    horizonHours: 24,
    asOfMs,
  }
  const accept = (v: unknown) => JSON.stringify(v) === JSON.stringify(current)
  const value = buildStusdsHolderTimeProcess(input, accept)
  return { input, accept, value, current }
}

describe('StUSDS issue-clock selected-horizon native time process', () => {
  it.each([1, 24, 48])(
    'H%s creates exact issue+H with original donor clock and source age',
    (h) => {
      const f = fixture()
      f.input.horizonHours = h
      const v = buildStusdsHolderTimeProcess(f.input, f.accept)!
      expect(v).toBeTruthy()
      expect(v.targetAtUtc).toBe(new Date(f.input.asOfMs + h * 3600000).toISOString())
      expect(v.lower.scenarios[0].donor.durationSeconds).toBe(1152)
      expect(v.lower.scenarios[0].donor.jointDeltaRaw).toEqual({
        totalSupplyRaw: '0',
        vatArtRaw: '0',
        clipDueRaw: '0',
      })
      const points = v.lower.scenarios[0].points
      expect(points[1].elapsedFromSourceSeconds).toBe(
        (f.input.asOfMs - Date.parse(f.current.point.source.blockTime)) / 1000,
      )
      expect(points.at(-1)!.elapsedFromSourceSeconds).toBe(
        (f.input.asOfMs - Date.parse(f.current.point.source.blockTime)) / 1000 + h * 3600,
      )
      expect(points.length).toBeLessThanOrEqual(128)
      expect(v.targetInterval).toBeTruthy()
      expect(v.lower.input.observations[0].availableAtUtc).toBe(evidence.knowledgeCutoff)
      expect(v.holderExecutableExit).toBe(false)
    },
  )
  it('reproduces current native index and clips fullE before Q exactly once, ignoring current M0', () => {
    const f = fixture(1000n * UNIT, UNIT),
      v = f.value!
    const first = v.lower.scenarios[0].points[0]
    expect(first.entitlementRaw).toBe(String(1000n * UNIT))
    expect(first.headroomRaw).toBe(String(999n * UNIT))
    const last = v.lower.scenarios[0].points.at(-1)!
    expect(BigInt(last.entitlementRaw!)).toBeGreaterThan(1000n * UNIT)
    expect(BigInt(last.headroomRaw)).toBe(BigInt(last.capacityRaw) - UNIT)
    expect(BigInt(v.upper.scenarios[0].points.at(-1)!.headroomRaw)).toBeGreaterThanOrEqual(
      BigInt(last.headroomRaw),
    )
    f.input.current.point.globalProngs.chiNowRaw = '1'
    expect(buildStusdsHolderTimeProcess(f.input, () => true)).toBeNull()
  })
  it.each(['owner', 'Q', 'source', 'units', 'history', 'expiry', 'lookahead', 'runtime'])(
    'rejects independently mismatched %s',
    (mode) => {
      const f = fixture()
      const x: any = f.input
      if (mode === 'owner') x.binding.owner = '0x' + 'c'.repeat(40)
      if (mode === 'Q') x.binding.requestedRaw = '2'
      if (mode === 'source') x.binding.currentSource.blockHash = '0x' + '0'.repeat(64)
      if (mode === 'units') x.binding.assetDecimals = 6
      if (mode === 'history') x.history.history.points[0].globalProngs.totalSupplyRaw = '1'
      if (mode === 'expiry') {
        x.asOfMs = Date.parse(x.current.point.source.blockTime) + 1800001
        x.binding.asOfMs = x.asOfMs
      }
      if (mode === 'lookahead') {
        x.asOfMs = Date.parse(evidence.knowledgeCutoff) - 1
        x.binding.asOfMs = x.asOfMs
      }
      if (mode === 'runtime')
        x.current.point.runtimeIdentities.implementationCodeSha256 = '0'.repeat(64)
      expect(buildStusdsHolderTimeProcess(x, f.accept)).toBeNull()
    },
  )
  it('external replay callback cannot mutate source/Q/owner/prongs used after qualification', () => {
    const f = fixture(),
      original = structuredClone(f.value)
    const v = buildStusdsHolderTimeProcess(f.input, (c) => {
      expect(c).toEqual(f.current)
      f.input.current.point.globalProngs.totalSupplyRaw = '1'
      f.input.binding.owner = '0x' + 'c'.repeat(40)
      f.input.binding.requestedRaw = '2'
      return true
    })
    expect(v).toEqual(original)
  })
  it('selector snapshots payload and independent expected before external callbacks', () => {
    const f = fixture(),
      original = structuredClone(f.value)
    const v = selectedStusdsHolderTimeProcess(f.value, f.input, f.input.asOfMs, () => {
      ;(f.value as any).requestedRaw = '2'
      f.input.binding.requestedRaw = '2'
      return true
    })
    expect(v).toEqual(original)
    expect(
      selectedStusdsHolderTimeProcess(
        original,
        fixture().input,
        Date.parse(original!.sourceProofValidUntil) + 1,
        () => true,
      ),
    ).toBeNull()
    const bad = structuredClone(original)!
    bad.assumptions.wallClockTargetExact = false as any
    expect(
      selectedStusdsHolderTimeProcess(bad, fixture().input, fixture().input.asOfMs, () => true),
    ).toBeNull()
  })
  it('keeps overflow mechanical scenarios explicitly censored rather than silently clipping', () => {
    const f = fixture((1n << 256n) - 2n)
    const v = buildStusdsHolderTimeProcess(f.input, f.accept)!
    expect(v).toBeTruthy()
    expect(v.targetInterval).toBeNull()
    expect(v.lower.scenarios[0].status).toBe('censored_path')
    expect(v.upper.targetSummary).toBeNull()
  })
  it('fractional issue time retains exact target while mechanical accrual floors elapsed to seconds', () => {
    const f = fixture()
    f.input.asOfMs += 123
    f.input.binding.asOfMs = f.input.asOfMs
    f.input.horizonHours = 1
    const v = buildStusdsHolderTimeProcess(f.input, f.accept)!,
      g = f.current.point.globalProngs
    const last = v.lower.scenarios[0].points.at(-1)!,
      atSeconds = Math.floor(Date.parse(v.targetAtUtc) / 1000),
      RAY = 10n ** 27n
    const chi =
      (BigInt(stusdsRayPow(g.strRaw, atSeconds - Number(g.rhoUnix))!) * BigInt(g.chiRaw)) / RAY
    expect(last.entitlementRaw).toBe(String((1000n * UNIT * chi) / BigInt(g.chiNowRaw)))
    expect(v.targetAtUtc).toBe(new Date(f.input.asOfMs + 3600000).toISOString())
    expect(Date.parse(last.atUtc) % 1000).toBe(f.input.asOfMs % 1000)
    expect(v.assumptions.futureProtocolClock).toBe('floor_elapsed_milliseconds_to_whole_seconds')
  })
  it('runtime or current mechanical clock gaps reject even if an external callback incorrectly approves shape', () => {
    const f = fixture()
    f.input.current.point.source.chainId = 2 as any
    expect(buildStusdsHolderTimeProcess(f.input, () => true)).toBeNull()
    const z = fixture()
    z.input.current.point.globalProngs.rhoUnix = String(Math.floor(z.input.asOfMs / 1000) + 1)
    expect(buildStusdsHolderTimeProcess(z.input, () => true)).toBeNull()
  })
})
