import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildFluidUsdtBridgeHolderTimeProcess as build,
  selectedFluidUsdtBridgeHolderTimeProcess as select,
  type FluidUsdtBridgeTimeInput,
  type FluidUsdtBridgeQuoteEvidence,
  type FluidUsdtNativeDeliveryPath,
} from '@/lib/carry/fluidUsdtBridgeHolderTimeProcess'
let evidence: FluidUsdtBridgeQuoteEvidence
beforeAll(async () => {
  const raw = readFileSync(
    'data/research/venue-signals/fluid-usdt-historical-conversion-2026-10-07T14-14.json',
    'utf8',
  )
  const collector =
    await import('../../scripts/research/fluid-usdt-historical-conversion-capture.mjs')
  evidence = collector.replayFluidUsdtConversionHistory(
    JSON.parse(raw),
    collector.prepareFluidUsdtConversionPlan(),
  )
}, 30000)
const equal = isDeepStrictEqual
function fixture(bucket = '10145', H = 1) {
  const input: FluidUsdtBridgeTimeInput = {
    mode: 'dated_captured_projection',
    routeKey: 'USDT → FluidBridgeAggregatorProxy [USDC]',
    destination: '0x273da948aca9261043fbdb2a857bc255ecc29012',
    usdcInputRaw: bucket,
    requestedUsdtRaw: bucket === '10145' ? '10000' : '10000000000',
    horizonHours: H,
    issueAtUtc: evidence.knowledgeCutoff,
    evidence: structuredClone(evidence),
  }
  const approved = structuredClone(input.evidence)
  return {
    input,
    accept: (kind: string, value: unknown) => kind !== 'native_delivery' && equal(value, approved),
  }
}
function native(
  input: FluidUsdtBridgeTimeInput,
  available = input.usdcInputRaw,
  E = input.usdcInputRaw,
) {
  const { accept } = fixture(input.usdcInputRaw, input.horizonHours),
    publicQuote = build(input, accept)!
  input.owner = '0x3f825bb69af74a4921dd051c80fe8bf8fb7d3a2e'
  input.nativeDelivery = {
    owner: input.owner,
    inputAsset: evidence.input.asset,
    inputDecimals: 6,
    inputRaw: input.usdcInputRaw,
    currentSource: structuredClone(evidence.current!.source),
    issueAtUtc: publicQuote.process.issueAtUtc,
    targetAtUtc: publicQuote.process.targetAtUtc,
    provenanceRef: 'independently_qualified_native_delivery_fixture_not_real_capture',
    readAtUtc: input.issueAtUtc,
    knowledgeCutoff: input.issueAtUtc,
    fullEntitlementMethod: 'preview_redeem_full_position',
    scenarios: publicQuote.process.scenarios.map((s) => ({
      donorSources: structuredClone(
        evidence.history.points.map((p) => p.source),
      ) as FluidUsdtNativeDeliveryPath['scenarios'][number]['donorSources'],
      quoteDonorProvenanceRefs: structuredClone(s.donor.provenanceRefs) as [string, string],
      nativeDonorProvenanceRef: 'same_anchor_native_fixture_not_actual_evidence',
      nativeDonorAvailableAtUtc: [input.issueAtUtc, input.issueAtUtc],
      points: s.points.map((p) => ({
        atUtc: p.atUtc,
        availableUsdcRaw: available,
        fullEntitlementUsdcRaw: E,
      })),
    })),
  }
  const nativeApproved = structuredClone(input.nativeDelivery)
  return (kind: string, value: unknown) =>
    kind === 'native_delivery' ? equal(value, nativeApproved) : accept(kind, value)
}
describe('Fluid USDT bridge independently qualified exact-size quote process', () => {
  it.each([1, 24, 48])(
    'keeps historical3072s and genuine selected H%s target; small fixed quote changes are flat',
    (H) => {
      const { input, accept } = fixture('10145', H),
        r = build(input, accept)!
      expect(r.scope).toBe('public_fixed_input_conversion_quote_coverage')
      expect(r.holderExit).toBeNull()
      expect(r.process.targetAtUtc).toBe(
        new Date(Date.parse(input.issueAtUtc) + H * 3600000).toISOString(),
      )
      expect(r.process.scenarios[0].donor.durationSeconds).toBe(3072)
      expect(r.process.scenarios[0].targetHeadroomRaw).toBe('144')
      expect(r.process.scenarios[0].donor.availableAtUtc).toEqual([
        evidence.knowledgeCutoff,
        evidence.knowledgeCutoff,
      ])
      expect(r.forecastValidated).toBe(false)
      expect(r.holderExecutableExit).toBe(false)
      expect(r.assumptions.quoteChangesAreCompetingFlows).toBe(false)
    },
  )
  it('large public channel uses its own signed quote rate, source age and Q once; no small-bucket scaling', () => {
    const { input, accept } = fixture('10000000000'),
      r = build(input, accept)!,
      p = r.process
    const elapsed = BigInt(
      Date.parse(p.targetAtUtc) - Date.parse(evidence.current!.source.blockTime),
    )
    const numerator = -29670n * elapsed,
      dt = 3072000n
    const shift = numerator / dt - (numerator % dt === 0n ? 0n : 1n)
    expect(p.scenarios[0].targetHeadroomRaw).toBe(
      String(10000637761n + shift - BigInt(input.requestedUsdtRaw)),
    )
    expect(p.scenarios[0].donor.jointDeltaRaw).toEqual({ fixed_input_usdt_quote: '-29670' })
    expect(r.holderExit).toBeNull()
    const wrong = structuredClone(input)
    wrong.usdcInputRaw = '1000000'
    expect(build(wrong, () => true)).toBeNull()
  })
  it('requires independent raw-replay approval for BOTH history/current, not a resealed payload', () => {
    const { input, accept } = fixture()
    expect(build(input, (kind, v) => kind === 'history' && accept(kind, v))).toBeNull()
    const changed = structuredClone(input)
    changed.evidence.history.points[1].usdtQuotedRaw = '50000'
    changed.evidence.captureReceiptSha256 = createHash('sha256')
      .update(JSON.stringify(changed.evidence))
      .digest('hex')
    expect(build(changed, accept)).toBeNull()
    expect(
      build(input, () => {
        throw Error('authority_unavailable')
      }),
    ).toBeNull()
  })
  it('no original final-Q or owner is inferred from the archived first-leg assay', () => {
    const { input, accept } = fixture()
    input.requestedUsdtRaw = '20000'
    const r = build(input, accept)!
    expect(r.process.scenarios[0].targetHeadroomRaw).toBe('-9856')
    expect(r.process.scenarios[0].sampledShortfalls[0].rightCensored).toBe(true)
    expect(r.durationScope).toBe('sampled_quote_coverage_only_not_holder_exit_duration')
    expect(r.input.evidence.originalUsdtRequestedRaw).toBeNull()
  })
  it('same-sized separately approved native fullE/delivery enables conditional final-Q coverage only', () => {
    const { input } = fixture(),
      accept = native(input),
      r = build(input, accept)!
    expect(r.holderExit!.owner).toBe(input.owner)
    expect(r.holderExit!.allTargetAmountsKnown).toBe(true)
    expect(r.holderExit!.paths[0].targetHeadroomUsdtRaw).toBe('144')
    expect(r.holderExit!.paths[0].points.every((p) => p.requiredUsdcInputRaw === '10145')).toBe(
      true,
    )
    expect(r.holderExit!.releaseAndCombinedExecution).toBe('unverified')
  })
  it('native shortage/fullE below the exact bucket never creates a partial swap or a positive exit claim', () => {
    for (const [C, E] of [
      ['10144', '10145'],
      ['10145', '10144'],
      ['0', '10145'],
    ]) {
      const { input } = fixture(),
        accept = native(input, C, E),
        r = build(input, accept)!
      expect(r.process.scenarios[0].targetHeadroomRaw).toBe('144')
      expect(r.holderExit!.paths[0].points[0].coverage).toBe('native_input_shortfall')
      expect(r.holderExit!.paths[0].targetHeadroomUsdtRaw).toBeNull()
      expect(r.holderExit!.paths[0].sampledCoverageRuns[0].rightCensored).toBe(true)
    }
  })
  it('unknown native delivery censors final coverage while keeping public quotes useful', () => {
    const { input } = fixture()
    native(input)
    input.nativeDelivery!.scenarios[0].points.forEach((p) => (p.availableUsdcRaw = null))
    const approved = structuredClone(input.nativeDelivery),
      base = fixture().accept
    const r = build(input, (kind, v) =>
      kind === 'native_delivery' ? equal(v, approved) : base(kind, v),
    )!
    expect(
      r.holderExit!.paths[0].points.every(
        (p) => p.coverage === 'unknown' && p.finalHeadroomUsdtRaw === null,
      ),
    ).toBe(true)
    expect(r.holderExit!.allTargetAmountsKnown).toBe(false)
    expect(r.process.targetSummary).not.toBeNull()
  })
  it('native owner/source/bucket/clock/donor/unit mismatch drops only the composite', () => {
    for (const mutate of [
      (n: FluidUsdtNativeDeliveryPath) => (n.owner = '0x' + '1'.repeat(40)),
      (n: FluidUsdtNativeDeliveryPath) => (n.currentSource.blockHash = '0x' + '1'.repeat(64)),
      (n: FluidUsdtNativeDeliveryPath) => (n.inputRaw = '10144'),
      (n: FluidUsdtNativeDeliveryPath) => (n.issueAtUtc = '2026-10-07T14:15:11.021Z'),
      (n: FluidUsdtNativeDeliveryPath) => (n.inputDecimals = 18 as 6),
      (n: FluidUsdtNativeDeliveryPath) => (n.knowledgeCutoff = '2026-10-07T14:15:11.021Z'),
      (n: FluidUsdtNativeDeliveryPath) =>
        (n.scenarios[0].nativeDonorAvailableAtUtc[1] = '2026-10-07T14:15:11.021Z'),
      (n: FluidUsdtNativeDeliveryPath) =>
        (n.scenarios[0].donorSources[0].blockHash = '0x' + '1'.repeat(64)),
      (n: FluidUsdtNativeDeliveryPath) =>
        (n.scenarios[0].points[0].atUtc = '2026-10-07T14:15:11.021Z'),
    ]) {
      const { input } = fixture(),
        accept = native(input)
      mutate(input.nativeDelivery!)
      expect(build(input, accept)?.holderExit).toBeNull()
    }
  })
  it('independent selector rejects modified scope/summary/metadata and later expiry without retiming', () => {
    const { input, accept } = fixture(),
      r = build(input, accept)!,
      issue = Date.parse(input.issueAtUtc)
    expect(select(r, { input, asOfMs: issue + 1000 }, accept)?.process.targetAtUtc).toBe(
      r.process.targetAtUtc,
    )
    for (const mutate of [
      (x: any) => (x.scope = 'holder_exit_capacity'),
      (x: any) => (x.process.scenarios[0].targetHeadroomRaw = '1'),
      (x: any) => (x.holderExecutableExit = true),
      (x: any) => (x.durationScope = 'holder_exit_duration'),
    ]) {
      const bad = structuredClone(r)
      mutate(bad)
      expect(select(bad, { input, asOfMs: issue }, accept)).toBeNull()
    }
    expect(
      select(r, { input, asOfMs: Date.parse(r.process.sourceProofValidUntil) + 1 }, accept),
    ).toBeNull()
    expect(select(r, { input, asOfMs: Date.parse(r.process.targetAtUtc) }, accept)).toBeNull()
    const wrong = structuredClone(input)
    wrong.requestedUsdtRaw = '10001'
    expect(select(r, { input: wrong, asOfMs: issue }, accept)).toBeNull()
  })
  it('rejects runtime/native/elapsed/currency drift; failed other-size quote does not erase this bucket', () => {
    const { input, accept } = fixture()
    for (const mutate of [
      (i: any) => (i.evidence.current.runtimeCodeHashes.pool = '0x' + '1'.repeat(64)),
      (i: any) => (i.evidence.input.decimals = 18),
      (i: any) => (i.evidence.history.elapsedSeconds[1] = 3000),
      (i: any) => (i.requestedUsdtRaw = ['10000']),
      (i: any) => (i.evidence.captureReceiptSha256 = [evidence.captureReceiptSha256]),
    ]) {
      const bad = structuredClone(input)
      mutate(bad)
      expect(build(bad, () => true)).toBeNull()
    }
    const own = structuredClone(input)
    own.evidence.current!.protocolQuote.usdtQuotedRaw = null
    own.evidence.current!.protocolQuote.status = 'incomplete'
    expect(build(own, () => true)?.process.scenarios[0].targetHeadroomRaw).toBe('144')
    expect(build(input, accept)).not.toBeNull()
  })
  it('snapshot before evidence callbacks prevents caller amount/source/history mutations', () => {
    const { input, accept } = fixture(),
      baseline = build(input, accept)
    expect(
      build(input, (kind, v) => {
        input.requestedUsdtRaw = '1'
        input.evidence.current!.source.blockHash = '0x' + '1'.repeat(64)
        return accept(kind, v)
      }),
    ).toEqual(baseline)
    const issued = fixture(),
      value = build(issued.input, issued.accept)!,
      expected = { input: issued.input, asOfMs: Date.parse(issued.input.issueAtUtc) }
    expect(
      select(value, expected, (kind, v) => {
        expected.input.requestedUsdtRaw = '1'
        ;(value as any).scope = 'forged'
        return issued.accept(kind, v)
      }),
    ).not.toBeNull()
  })
  it('native arithmetic overflow stays a censored scenario, never a fabricated bounded quote', () => {
    const { input } = fixture()
    input.evidence.history.points[1].usdtQuotedRaw = '10147'
    input.evidence.current!.usdtQuotedRaw = ((1n << 256n) - 1n).toString()
    const r = build(input, () => true)!
    expect(r.process.targetSummary).toBeNull()
    expect(r.process.scenarios[0].status).toBe('censored_path')
    expect(r.process.scenarios[0].reason).toBe('native_intermediate_overflow')
  })
  it('dated evidence cannot fabricate an old issue before genuine capture or a new live source clock', () => {
    const { input, accept } = fixture()
    const before = structuredClone(input)
    before.issueAtUtc = '2026-10-02T04:06:47.000Z'
    expect(build(before, accept)).toBeNull()
    const retimed = structuredClone(input)
    retimed.mode = 'current_conditional'
    retimed.issueAtUtc = '2026-10-07T16:00:00.000Z'
    expect(build(retimed, accept)).toBeNull()
  })
})
