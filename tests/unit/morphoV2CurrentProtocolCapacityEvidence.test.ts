import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { beforeAll, describe, it, expect } from 'vitest'
import {
  morphoV2ProtocolReadPlan,
  readMorphoV2CurrentProtocolOrigin,
  replayMorphoV2CurrentProtocolOrigin,
  replayMorphoV2CurrentProtocolCapacityEvidence,
  approveMorphoV2CurrentProtocolCapacityEvidence,
  type MorphoV2NativeSource,
} from '@/lib/carry/morphoV2CurrentProtocolCapacityEvidence'
const raw = JSON.parse(
  readFileSync(
    'data/research/venue-signals/morpho-v2-adapter-capacity-pilot-2026-10-07T15-32.json',
    'utf8',
  ),
)
const hosts = raw.origins as string[],
  NOW = Date.parse(raw.capturedAt)
const source: MorphoV2NativeSource = {
  chainId: 1,
  blockNumber: Number(raw.sources[2].blockNumber),
  blockHash: raw.sources[2].blockHash,
  blockTime: raw.sources[2].blockTime,
  finalized: true,
}
const fixtureRows = raw.traces.filter((t: any) => t.origin === hosts[0] && t.anchor === 2)
function fixture(extra?: (request: any, count: number) => void) {
  let calls = 0,
    time = NOW
  const client = {
    request: async (request: any) => {
      ++calls
      extra?.(request, calls)
      const row = fixtureRows.find(
        (r: any) =>
          JSON.stringify({ method: r.request.method, params: r.request.params }) ===
          JSON.stringify(request),
      )
      if (!row) throw Error('unexpected_wire')
      time++
      return structuredClone(row.response.result)
    },
  }
  return { client, now: () => time, calls: () => calls }
}
beforeAll(async () => {
  await morphoV2ProtocolReadPlan(source)
}, 30000)
async function observation() {
  const f = fixture()
  const o = await readMorphoV2CurrentProtocolOrigin(f.client, source, { now: f.now })
  expect(o).not.toBeNull()
  expect(f.calls()).toBe(31)
  return o!
}
describe('optional source-pinned current Morpho pilot prongs', () => {
  it('returns promptly in an actual cold process and never launches calls after explicit prewarm', () => {
    const code = `
      import api from './lib/carry/morphoV2CurrentProtocolCapacityEvidence.ts';
      const { readMorphoV2CurrentProtocolOrigin, prewarmMorphoV2ProtocolHistory } = api;
      globalThis.fetch = async () => { throw Error('network_forbidden'); };
      const source = { chainId:1, blockNumber:26190000, blockHash:'0x'+'a'.repeat(64), blockTime:new Date(Math.floor(Date.now()/1000)*1000-60000).toISOString(), finalized:true };
      let starts=0;
      const client={ request:async()=>{ starts++; throw Error('unexpected_request'); } };
      const before=performance.now();
      const result=await readMorphoV2CurrentProtocolOrigin(client,source);
      const elapsedMs=performance.now()-before;
      const afterRead=starts;
      const prewarmed=await prewarmMorphoV2ProtocolHistory();
      console.log(JSON.stringify({ returnedNull:result===null, elapsedMs, afterRead, afterPrewarm:starts, prewarmed }));
    `
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', code],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 25000, maxBuffer: 65536 },
    )
    expect(child.status, child.stderr).toBe(0)
    const result = JSON.parse(child.stdout.trim().split('\n').at(-1)!)
    expect(result.returnedNull).toBe(true)
    expect(result.elapsedMs).toBeLessThanOrEqual(8250)
    expect(result.afterRead).toBe(0)
    expect(result.afterPrewarm).toBe(0)
    expect(result.prewarmed).toBe(true)
  }, 30000)
  it('uses31actual raw native calls and independently matches actual current prongs', async () => {
    const o = await observation(),
      p = await replayMorphoV2CurrentProtocolOrigin(o, source, NOW + 1000)
    expect(p?.status).toBe('single_origin_conditional_configured_adapter_prongs')
    expect(p?.prongs.internalSharesRaw).toBe('986418728075')
    expect(p?.prongs.market).toEqual([
      '1706649053',
      '1643117448964867',
      '1031725',
      '988165374711',
      '1791250727',
      '0',
    ])
    expect(p?.prongs.blueCashRaw).toBe('117494061623744')
    expect(o.traces.at(-1)?.key).toBe('header_after')
    expect(o.traces.findIndex((x) => x.key === 'borrowRate')).toBeGreaterThan(
      o.traces.findIndex((x) => x.key === 'market'),
    )
    expect(
      o.traces.every(
        (t) =>
          t.method === 'eth_getBlockByNumber' ||
          (t.params.at(-1) as any).blockHash === source.blockHash,
      ),
    ).toBe(true)
  })
  it('requires exact externally supplied source and configured pair, independently reconstructing current evidence', async () => {
    const o = await observation(),
      record = { origins: hosts.map((host) => ({ host, observation: structuredClone(o) })) },
      expected = { source, asOfMs: NOW + 1000, originHosts: hosts }
    const r = await replayMorphoV2CurrentProtocolCapacityEvidence(record, expected)
    expect(r?.point.status).toBe('two_origin_conditional_configured_adapter_prongs')
    expect(r?.point.prongs.idleCashRaw).toBe('0')
    expect(r?.runtimeIdentities).toHaveLength(5)
    expect((r?.runtimeIdentities[0] as any).implementationAddress).toBeNull()
    expect((r?.runtimeIdentities[0] as any).implementationCodeHash).toBeNull()
    expect(r?.knowledgeCutoff).toBe(o.readAtUtc)
    expect(
      await replayMorphoV2CurrentProtocolCapacityEvidence(record, {
        ...expected,
        originHosts: [hosts[0], hosts[0]],
      }),
    ).toBeNull()
    expect(
      await replayMorphoV2CurrentProtocolCapacityEvidence(record, {
        ...expected,
        source: { ...source, blockHash: `0x${'a'.repeat(64)}` },
      }),
    ).toBeNull()
    const wrong = structuredClone(record)
    wrong.origins[1].host = 'unapproved.example'
    expect(await replayMorphoV2CurrentProtocolCapacityEvidence(wrong, expected)).toBeNull()
  })
  it('rejects mismatched code/config/raw arrays/padding/header/sourceclock and malformed fee class', async () => {
    const o = await observation()
    for (const mutate of [
      (x: any) => (x.traces.find((t: any) => t.key === 'code_adapter').result = '0x00'),
      (x: any) =>
        (x.traces.find((t: any) => t.key === 'liquidityData').result = x.traces.find(
          (t: any) => t.key === 'market',
        ).result),
      (x: any) =>
        (x.traces.find((t: any) => t.key === 'market').result = [
          x.traces.find((t: any) => t.key === 'market').result,
        ]),
      (x: any) => (x.traces.find((t: any) => t.key === 'market').result += '00'.repeat(32)),
      (x: any) => (x.traces[0].result.hash = `0x${'a'.repeat(64)}`),
      (x: any) => (x.traces.at(-1).result.timestamp = '0x00'),
      (x: any) => (x.readAtUtc = new Date(NOW + 9000).toISOString()),
      (x: any) =>
        (x.traces.find((t: any) => t.key === 'feeRecipient').result = '0x' + '0'.repeat(63) + '1'),
    ]) {
      const x = structuredClone(o)
      mutate(x)
      expect(await replayMorphoV2CurrentProtocolOrigin(x, source, NOW + 10000)).toBeNull()
    }
  })
  it('rejects reordered dependencies and state outside header enclosure', async () => {
    const o = await observation()
    const swap = structuredClone(o),
      i = swap.traces.findIndex((t) => t.key === 'market'),
      j = swap.traces.findIndex((t) => t.key === 'borrowRate')
    ;[swap.traces[i], swap.traces[j]] = [swap.traces[j], swap.traces[i]]
    expect(await replayMorphoV2CurrentProtocolOrigin(swap, source, NOW + 1000)).toBeNull()
    const clock = structuredClone(o)
    clock.traces[1].startedAtUtc = new Date(
      Date.parse(clock.traces[0].completedAtUtc) - 1,
    ).toISOString()
    expect(await replayMorphoV2CurrentProtocolOrigin(clock, source, NOW + 1000)).toBeNull()
  })
  it('snapshots source and request method before awaits, retaining no exposed URI', async () => {
    const s = structuredClone(source)
    let f: ReturnType<typeof fixture>
    f = fixture((_, n) => {
      if (n === 1) {
        s.blockHash = `0x${'a'.repeat(64)}`
        f.client.request = async () => {
          throw Error('new_method')
        }
      }
    })
    const o = await readMorphoV2CurrentProtocolOrigin(f.client, s, { now: f.now })
    expect(o).not.toBeNull()
    expect(o?.source.blockHash).toBe(source.blockHash)
    expect(f.calls()).toBe(31)
    expect(JSON.stringify(o)).not.toContain('https://')
  })
  it('stops at first optional failure without changing unrelated quote facts or launching remaining calls', async () => {
    const required = { entitlementRaw: '2000000', simulation: 'success' },
      copy = structuredClone(required),
      f = fixture((_, n) => {
        if (n === 3) throw Error('optional_transport')
      })
    expect(await readMorphoV2CurrentProtocolOrigin(f.client, source, { now: f.now })).toBeNull()
    expect(f.calls()).toBe(3)
    expect(required).toEqual(copy)
    const late = fixture()
    let count = 0
    const never = {
      request: async () => {
        count++
        await new Promise((resolve) => setTimeout(resolve, 35))
        return fixtureRows[0].response.result
      },
    }
    expect(
      await readMorphoV2CurrentProtocolOrigin(never, source, { now: late.now, deadlineMs: 10 }),
    ).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(count).toBe(1)
  })
  it('rejects late completion/source expiry and prevents approval alias mutation', async () => {
    const f = fixture(),
      lateNow = () => f.now() + 9000
    expect(
      await readMorphoV2CurrentProtocolOrigin(f.client, source, { now: lateNow, deadlineMs: 8001 }),
    ).toBeNull()
    expect(f.calls()).toBe(0)
    const o = await observation(),
      record = { origins: hosts.map((host) => ({ host, observation: structuredClone(o) })) },
      expected = { source: structuredClone(source), asOfMs: NOW + 1000, originHosts: [...hosts] },
      r = await approveMorphoV2CurrentProtocolCapacityEvidence(record, expected)
    expect(r).not.toBeNull()
    const original = structuredClone(r!.current)
    record.origins[0].observation.traces[1].result = '0x00'
    expected.source.blockHash = `0x${'a'.repeat(64)}`
    r!.current.point.prongs.blueCashRaw = '1'
    expect(r!.acceptEvidence(original)).toBe(true)
    expect(r!.acceptEvidence(r!.current)).toBe(false)
    expect(
      await replayMorphoV2CurrentProtocolOrigin(o, source, Date.parse(source.blockTime) + 1800001),
    ).toBeNull()
  })
})
