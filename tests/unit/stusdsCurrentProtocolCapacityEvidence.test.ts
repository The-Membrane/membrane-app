import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { encodeFunctionResult, parseAbi } from 'viem'
import rawCapture from '@/data/research/venue-signals/stusds-historical-capacity-2026-10-07T14-29.json'
import {
  acceptStusdsCurrentProtocolCapacityEvidence,
  replayStusdsCurrentProtocolOrigin,
  replayStusdsCurrentProtocolCapacityEvidence,
  stusdsProtocolReadPlan,
  type StusdsProtocolOriginObservation,
} from '@/lib/carry/stusdsCurrentProtocolCapacityEvidence'
import normalized from '@/data/research/venue-signals/stusds-historical-capacity-2026-10-07T14-29.export.json'
import { stusdsRayPow } from '@/lib/carry/stusdsHistoricalHolderCapacityProjection'
import { readTrackedDirectVaultExit } from '@/lib/carry/trackedDirectVaultExit'
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
function fixture() {
  const source = {
    ...rawCapture.sources[2],
    blockNumber: Number(rawCapture.sources[2].blockNumber),
    finalized: true,
  } as any
  const asOfMs = Date.parse(rawCapture.capturedAt),
    plan = stusdsProtocolReadPlan(source)
  const origins = rawCapture.origins.map((host) => {
    const rows = rawCapture.traces.filter((t) => t.anchor === 2 && t.origin === host)
    const find = (key: string) => rows.find((t) => t.key === key)!
    const observation: StusdsProtocolOriginObservation = {
      source: structuredClone(source),
      readAtUtc: rawCapture.capturedAt,
      nativeIdentity: {
        assetAddress: '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
        assetDecimals: 18,
        shareDecimals: 18,
      },
      coreRuntimeCodes: {
        proxy: find('code_proxy').response!.result as string,
        asset: find('code_asset').response!.result as string,
      },
      traces: plan.map((p) => {
        const row = find(p.key)
        return {
          key: p.key,
          method: row.request.method,
          params: structuredClone(row.request.params),
          result: row.response!.result,
        }
      }),
    }
    return { host, observation }
  })
  return {
    record: { origins },
    expected: { source, asOfMs, originHosts: rawCapture.origins },
    asOfMs,
  }
}
describe('StUSDS current native protocol evidence', () => {
  it('replays actual two-origin current raw replies at a genuinely dated clock', () => {
    const f = fixture(),
      c = replayStusdsCurrentProtocolCapacityEvidence(f.record, f.expected, hash)!
    const points = f.record.origins.map((x) =>
      replayStusdsCurrentProtocolOrigin(x.observation, f.expected.source, f.asOfMs, hash),
    )
    expect(points[0]).toBeTruthy()
    expect(points[1]).toBeTruthy()
    expect(points[1]).toEqual(points[0])
    expect(c).toBeTruthy()
    expect(c.point.globalProngs.unusedFundsBurnRaw).toBe('37337616014701263152204795')
    expect(c.point.globalProngs.unusedFundsGetterRaw).toBe(c.point.globalProngs.unusedFundsBurnRaw)
    expect(c.point.holderQuote).toBeUndefined()
    expect(c.point.sourceImplementationEquivalence).toBe(false)
    expect(stusdsProtocolReadPlan(f.expected.source)).toHaveLength(21)
  })
  it('authorizes only the externally replayed current, not self hashes or arithmetic', () => {
    const f = fixture(),
      current = replayStusdsCurrentProtocolCapacityEvidence(f.record, f.expected, hash)!
    expect(acceptStusdsCurrentProtocolCapacityEvidence(current, f.record, f.expected, hash)).toBe(
      true,
    )
    current.point.globalProngs.totalSupplyRaw = String(
      BigInt(current.point.globalProngs.totalSupplyRaw) + 1n,
    )
    expect(acceptStusdsCurrentProtocolCapacityEvidence(current, f.record, f.expected, hash)).toBe(
      false,
    )
  })
  it.each([
    'origin',
    'source',
    'params',
    'nativeUnits',
    'malformed',
    'runtime',
    'prong',
    'expired',
  ])('rejects %s proof drift', (mode) => {
    const f = fixture(),
      o = f.record.origins[0].observation
    if (mode === 'origin') f.record.origins[1].host = f.record.origins[0].host
    if (mode === 'source') o.source.blockHash = '0x' + 'b'.repeat(64)
    if (mode === 'params') (o.traces[0].params.at(-1) as any).requireCanonical = false
    if (mode === 'nativeUnits') (o.nativeIdentity as any).assetDecimals = 6
    if (mode === 'malformed') o.traces[0].result = ['0x' + '0'.repeat(64)]
    if (mode === 'runtime') o.coreRuntimeCodes.proxy = '0x6000'
    if (mode === 'prong')
      o.traces.find((t) => t.key === 'chiNow')!.result = '0x' + '0'.repeat(63) + '1'
    if (mode === 'expired') f.expected.asOfMs = Date.parse(f.expected.source.blockTime) + 1800001
    expect(replayStusdsCurrentProtocolCapacityEvidence(f.record, f.expected, hash)).toBeNull()
  })
  it('isolates inputs before hash callbacks and never issues caller aliases', () => {
    const f = fixture(),
      baseline = replayStusdsCurrentProtocolCapacityEvidence(f.record, f.expected, hash)
    const result = replayStusdsCurrentProtocolCapacityEvidence(f.record, f.expected, (s) => {
      f.record.origins[0].observation.source.blockHash = '0x' + 'b'.repeat(64)
      f.expected.source.blockHash = '0x' + 'b'.repeat(64)
      return hash(s)
    })
    expect(result).toEqual(baseline)
  })
  it('retains nonzero-base burn arithmetic but does not fabricate getter rate', () => {
    const f = fixture(),
      o = f.record.origins[0].observation,
      plan = stusdsProtocolReadPlan(o.source)
    const set = (key: string, value: bigint) => {
      const p = plan.find((p) => p.key === key) as any
      o.traces.find((t) => t.key === key)!.result = encodeFunctionResult({
        abi: p.abi,
        functionName: p.name,
        result: value,
      })
    }
    set('jugBase', 1n)
    const p = normalized.current.globalProngs
    const elapsed = Date.parse(o.source.blockTime) / 1000 - Number(p.jugRhoUnix)
    const pow = BigInt(stusdsRayPow(String(BigInt(p.jugDutyRaw) + 1n), elapsed)!)
    set('burnRateNow', (pow * BigInt(p.vatStoredRateRaw)) / 10n ** 27n)
    const c = replayStusdsCurrentProtocolOrigin(o, o.source, f.asOfMs, hash)
    expect(c).toBeTruthy()
    expect(c!.globalProngs.unusedFundsGetterRaw).toBeNull()
    expect(c!.globalProngs.unusedFundsBurnRaw).not.toBeNull()
  })
  async function native(f: ReturnType<typeof fixture>, fail: boolean | 'malformed' = false) {
    const o = f.record.origins[0].observation,
      by = new Map(
        o.traces.map((t) => [JSON.stringify({ method: t.method, params: t.params }), t.result]),
      )
    const block = {
      number: BigInt(o.source.blockNumber),
      hash: o.source.blockHash,
      timestamp: BigInt(Date.parse(o.source.blockTime) / 1000),
    }
    let extra = 0
    const client = {
      getChainId: async () => 1,
      getBlock: async () => block,
      getCode: async ({ address }: any) =>
        address === o.nativeIdentity.assetAddress
          ? o.coreRuntimeCodes.asset
          : o.coreRuntimeCodes.proxy,
      request: vi.fn(async (args: any) => {
        if (args.method === 'eth_getCode' && args.params[0] === '0x' + 'b'.repeat(40)) return '0x'
        extra++
        if (fail === true) throw Error('optional_rpc_error')
        if (fail === 'malformed') return ['0x']
        const r = by.get(JSON.stringify(args))
        if (r === undefined) throw Error('unexpected_request')
        return r
      }),
      readContract: async ({ functionName }: any) =>
        functionName === 'asset'
          ? o.nativeIdentity.assetAddress
          : functionName === 'decimals'
            ? 18
            : 1000000000000000000000n,
      call: async () => ({
        data: encodeFunctionResult({
          abi: parseAbi(['function withdraw(uint256,address,address) returns(uint256)']),
          functionName: 'withdraw',
          result: 1000000000000000000n,
        }),
      }),
    }
    const result = await readTrackedDirectVaultExit(
      client as any,
      {
        routeKey: 'USDS → StUsds [USDS]',
        destinationAddress: '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9',
        owner: ('0x' + 'b'.repeat(40)) as any,
        assetsRaw: '1000000000000000000',
      },
      f.asOfMs,
      undefined,
      { includeCapacityFacts: true, includeStusdsProtocolCapacity: true },
    )
    return { result, extra }
  }
  it('native optional producer forwards exact raw replies and uses only 21 extra calls', async () => {
    const { result, extra } = await native(fixture())
    expect(extra).toBe(21)
    expect(result.protocolCapacityObservation).toBeTruthy()
    expect(result.simulation.status).toBe('success')
  })
  it('native optional failures preserve full entitlement, maximum and exact-Q execution', async () => {
    const { result, extra } = await native(fixture(), true)
    expect(extra).toBe(1)
    expect(result.protocolCapacityObservation).toBeNull()
    expect(result.position.entitlementAssetsRaw).toBe('1000000000000000000000')
    expect(result.position.maxWithdrawAssetsRaw).toBe('1000000000000000000000')
    expect(result.simulation.status).toBe('success')
  })
  it('malformed optional replies clear only the new channel', async () => {
    const { result } = await native(fixture(), 'malformed')
    expect(result.protocolCapacityObservation).toBeNull()
    expect(result.simulation.status).toBe('success')
    expect(result.position.entitlementAssetsRaw).toBe('1000000000000000000000')
  })
  it('post-read thirty-minute expiry clears optional evidence without changing the legacy assay', async () => {
    const f = fixture()
    f.asOfMs = Date.parse(f.expected.source.blockTime) + 1800001
    const { result } = await native(f)
    expect(result.protocolCapacityObservation).toBeNull()
    expect(result.simulation.status).toBe('success')
    expect(result.position.maxWithdrawAssetsRaw).toBe('1000000000000000000000')
  })
})
