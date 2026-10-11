import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { encodeFunctionData, encodeFunctionResult, parseAbi } from 'viem'
import {
  decodeFluidUsdcBridgeJointNativeHistoryEvidence as decode,
  encodeFluidUsdcBridgeJointNativeHistoryEvidence as encode,
  parseFluidUsdcBridgeJointNativeEvidenceJson,
  type FluidUsdcBridgeJointNativeHistoryEvidenceTransport as Transport,
} from '@/lib/carry/fluidUsdcBridgeJointNativeEvidenceCodec'
import { resolveFluidUsdcBridgeJointTrustedProfile as resolve } from '@/lib/carry/fluidUsdcBridgeJointTrustedProfile'
const ROUTE = 'USDC → FluidBridgeAggregatorProxy [USDC]'
const BRIDGE = '0x273da948aca9261043fbdb2a857bc255ecc29012'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
let original: unknown, baseline: Transport
beforeAll(() => {
  original = JSON.parse(
    readFileSync(
      'data/research/venue-signals/fluid-usdc-bridge-joint-history-evidence-2026-10-08/originals/20-native-historical-capture.json',
      'utf8',
    ),
  )
  baseline = encode(original)
})
const fixture = () => structuredClone(baseline)
describe('Fluid unsigned native history codec', () => {
  it('reconstructs archived full S/net Ea and all five native funding prongs without granting authority', () => {
    const facts = decode(baseline)!
    expect(facts).not.toBeNull()
    expect(facts.frames).toHaveLength(4)
    expect(facts.originalAuthority).toBe(false)
    expect(facts.authenticated).toBe(false)
    expect(facts.acquiredAtUtc).toBe(facts.frames[3].acquiredAtUtc)
    const c = original as { availableAtUtc: string; plan: { subject: { sharesRaw: string } } }
    expect(
      facts.frames.every(
        (f) =>
          f.acquiredAtUtc === c.availableAtUtc &&
          f.holderSharesRaw === c.plan.subject.sharesRaw &&
          f.owner === null &&
          f.historicalOwnership === false,
      ),
    ).toBe(true)
    expect(Object.keys(facts.frames[0].nativeProngs)).toHaveLength(5)
    expect(facts.frames[0].runtimeCodeHashes).toEqual(
      resolve(ROUTE, BRIDGE, USDC)!.runtimeCodeHashes,
    )
    expect(new TextEncoder().encode(JSON.stringify(baseline)).length).toBeLessThan(1024 * 1024)
    expect(JSON.stringify(baseline)).not.toContain('https://')
    expect(JSON.stringify(baseline)).not.toContain('rawBodyBase64')
    expect(decode(JSON.stringify(baseline))).toEqual(facts)
  })
  it('has one private frozen app-owned profile and twelve exact native header pins', () => {
    const profile = resolve(ROUTE, BRIDGE, USDC)!
    expect(Object.isFrozen(profile)).toBe(true)
    expect(Object.isFrozen(profile.runtimeCodeHashes)).toBe(true)
    expect(profile.anchors.map((a) => a.cashIndex)).toEqual(
      Array.from({ length: 12 }, (_, i) => 108 + i),
    )
    expect(resolve('caller provider', BRIDGE, USDC)).toBeNull()
    expect(resolve(ROUTE, USDC, USDC)).toBeNull()
  })
  it('rejects origin/method/anchor/source/header/units/owner/runtime and ABI drift', () => {
    const mutations: ((v: Transport) => void)[] = [
      (v) => {
        v.captures[0].anchors[0].cashIndex = 108
      },
      (v) => {
        v.captures[0].anchors[0].source.blockHash = '0x' + '1'.repeat(64)
      },
      (v) => {
        v.captures[0].anchors[0].origins[0].host = 'caller.invalid'
      },
      (v) => {
        v.captures[0].anchors[0].origins[0].traces[0].request.method = 'eth_accounts'
      },
      (v) => {
        v.subject.assetDecimals = 18 as 6
      },
      (v) => {
        ;(v as unknown as Record<string, unknown>).owner = BRIDGE
      },
      (v) => {
        v.subject.sharesRaw = '1'
      },
      (v) => {
        v.codes[BRIDGE] = '0x00'
      },
      (v) => {
        v.captures[0].anchors[0].origins[1].traces[24].response.result = '0x' + '0'.repeat(64)
      },
      (v) => {
        v.captures[0].anchors[0].origins[0].traces[25].response.result = {
          number: '0x1',
          hash: '0x' + '0'.repeat(64),
          timestamp: '0x1',
        }
      },
      (v) => {
        v.captures[0].anchors[0].origins[0].traces[20].response.result = '0x' + '0'.repeat(63) + '2'
      },
      (v) => {
        v.captures[0].anchors[0].origins[0].traces[21].response.result = '0x' + '0'.repeat(63) + '1'
      },
      (v) => {
        v.captures[0].anchors[0].origins[0].traces[23].response.result = '0x00'
      },
      (v) => {
        v.captures[0].anchors[0].origins[0].traces[1].response.result = {
          number: '0x1',
          hash: '0x' + '1'.repeat(64),
          timestamp: '0x1',
        }
      },
    ]
    for (const mutate of mutations) {
      const v = fixture()
      mutate(v)
      expect(decode(v)).toBeNull()
    }
  })
  it('rejects failed native responses, missing/duplicate starts, acquisition clock lies and extra fields', () => {
    for (const mutate of [
      (v: Transport) => {
        ;(
          v.captures[0].anchors[0].origins[0].traces[23].response as unknown as Record<
            string,
            unknown
          >
        ).error = { code: -32000, message: 'unavailable' }
      },
      (v: Transport) => {
        v.captures[0].anchors[0].origins[0].traces[2].physicalId =
          v.captures[0].anchors[0].origins[0].traces[1].physicalId
      },
      (v: Transport) => {
        v.captures[0].anchors[0].origins[0].traces.pop()
      },
      (v: Transport) => {
        v.captures[0].acquiredAtUtc = v.captures[0].startedAtUtc
      },
      (v: Transport) => {
        v.captures[0].anchors[0].origins[0].traces[0].completedAtUtc = '2026-10-09T00:00:00.000Z'
      },
      (v: Transport) => {
        ;(v as unknown as Record<string, unknown>).approve = true
      },
    ]) {
      const v = fixture()
      mutate(v)
      expect(decode(v)).toBeNull()
    }
  })
  it('retains consistent unsigned changed S claims as structural claims only', () => {
    const v = fixture(),
      abi = parseAbi(['function previewRedeem(uint256 shares) view returns (uint256)'])
    v.subject.sharesRaw = '100000000000000000000'
    for (const a of v.captures[0].anchors)
      for (const o of a.origins) {
        const t = o.traces.find((t) => t.key === 'full_net_ea')!
        t.request.params[0] = {
          to: BRIDGE,
          data: encodeFunctionData({
            abi,
            functionName: 'previewRedeem',
            args: [100000000000000000000n],
          }),
        }
        t.response.result = encodeFunctionResult({
          abi,
          functionName: 'previewRedeem',
          result: 123456789n,
        })
      }
    const f = decode(v)!
    expect(f).not.toBeNull()
    expect(
      f.frames.every(
        (x) => x.holderSharesRaw === v.subject.sharesRaw && x.fullHolderNetUsdcRaw === '123456789',
      ),
    ).toBe(true)
    expect(f.originalAuthority).toBe(false)
    expect(f.authenticated).toBe(false)
  })
  it('bounds own data, rejects accessors/cycles/sparse arrays/duplicates without invoking getters', () => {
    let hits = 0
    const v = fixture()
    Object.defineProperty(v, 'subject', {
      enumerable: true,
      get() {
        hits++
        return baseline.subject
      },
    })
    expect(decode(v)).toBeNull()
    expect(hits).toBe(0)
    const cycle = fixture() as unknown as Record<string, unknown>
    cycle.extra = cycle
    expect(decode(cycle)).toBeNull()
    const sparse = fixture()
    delete sparse.captures[0].anchors[0].origins[0].traces[1]
    expect(decode(sparse)).toBeNull()
    expect(decode('{"schema":"x","schema":"y"}')).toBeNull()
    expect(() => parseFluidUsdcBridgeJointNativeEvidenceJson('{"id":1,"id":2}')).toThrow()
    expect(decode(' '.repeat(1024 * 1024 + 1))).toBeNull()
    expect(
      decode({ ...fixture(), codes: { ...baseline.codes, extra: '0x' + '00'.repeat(65537) } }),
    ).toBeNull()
    const isolated = decode(baseline)!
    const altered = fixture()
    altered.subject.sharesRaw = '1'
    expect(isolated.frames[0].holderSharesRaw).toBe(baseline.subject.sharesRaw)
  })
})
