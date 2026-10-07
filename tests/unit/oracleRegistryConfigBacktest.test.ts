// Kelp rsETH LayerZero backtest (REGRESSION test, docs/research/CONFIG-CARDS-DESIGN.md §5).
//
// The fixture is the raw Ethereum event sequence of the rsETH OFTAdapter (plus the LZ defaults
// it inherited), point reads, and the Unichain peer's window around the route's creation —
// built by `node scripts/oracle-registry/config/backtest-kelp.mjs --build-fixture`. The rules
// are the production rules; this file is the only place that knows the exploit date, the
// exploited eid and the evaluation block. A guard below proves the rule sources do not.

import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { kelpCriteria, runLzBacktest, type LzFixture } from '@/lib/oracleRegistry/config/backtest'

const DIR = join(process.cwd(), 'data', 'oracle-registry', 'config', 'backtest')
const fx = JSON.parse(readFileSync(join(DIR, 'kelp-rseth.fixture.json'), 'utf8')) as LzFixture
const EVAL = 24_908_284 // last block before the exploit tx (24,908,285, 2026-04-18 17:35:35 UTC)
const CUTOFF = Date.UTC(2026, 3, 18, 17, 35, 35) / 1000
const out = runLzBacktest(fx, EVAL)
const crit = kelpCriteria(out, { exploitedEid: 30320, controlEid: 30325, cutoffTs: CUTOFF })
const at = (block: number, eid: number, dir: 'send' | 'receive' = 'receive') =>
  out.timeline.find((c) => c.block === block && c.route?.eid === eid && c.route.direction === dir)

describe('Kelp rsETH backtest — design §5 criteria', () => {
  it('a red change on eid 30320 is dated before the exploit', () => {
    expect(crit.redOnExploitedEidBeforeCutoff.pass).toBe(true)
    const created = at(22_179_964, 30320)!
    expect(created.red).toBe(true)
    expect(created.floorBreach).toBe(true)
    expect(created.ruleIds).toContain('BR-2')
    expect(created.beforeDisplay).toMatch(/blocked \(dead_dvn\)/)
    expect(created.ts!).toBeLessThan(CUTOFF)
  })

  it('the head state at block 24,908,284 lists eid 30320 as a floor breach (both directions)', () => {
    expect(crit.exploitedEidFloorBreachAtEval.pass).toBe(true)
    const recv = out.headAtEval.find((r) => r.eid === 30320 && r.direction === 'receive')!
    expect(recv.live).toBe(true)
    expect(recv.E).toBe(1)
    expect(recv.breaches.map((b) => b.ruleId)).toContain('BR-2')
  })

  it('Movement has no red DVN changes (gating); its peer re-point is red (BR-6 strict, owner ruling #3)', () => {
    expect(crit.controlRouteNoRedDvnChanges.pass).toBe(true)
    expect(crit.controlRouteNoRedDvnChanges.red).toEqual([])
    // the event scan found the peer re-pointed 0x1e4c…→0xe34b… at block 22,094,020: red, correctly
    expect(crit.controlRouteNoRedDvnChanges.peerRepointsRed.length).toBeGreaterThan(0)
    const red = out.timeline.filter(
      (c) => c.red && c.route?.eid === 30325 && (c.block ?? 0) <= EVAL,
    )
    expect(red.every((c) => c.ruleIds.every((r) => r === 'BR-6'))).toBe(true)
    expect(red.map((c) => c.block)).toContain(22_094_020)
    // The 1,000,000 → 30,000 confirmation move stays at/above LayerZero's pathway default: noted, not red.
    expect(at(22_274_647, 30325)!.red).toBe(false)
  })

  it('honest framing (owner ruling #5): red for about a year before the exploit, next to the base rate', async () => {
    const { kelpFraming, kelpSeverity } = await import('@/lib/oracleRegistry/config/backtest')
    const base = JSON.parse(readFileSync(join(DIR, 'kelp-rseth.base-rate.json'), 'utf8'))
    const f = kelpFraming(
      crit,
      { exploitedEid: 30320, cutoffTs: CUTOFF, evalBlock: EVAL },
      base,
      kelpSeverity(fx, base),
    )
    expect(f.redDaysBeforeExploit).toBeGreaterThan(365)
    expect(f.redDaysBeforeExploit).toBeLessThan(400)
    expect(f.text).toMatch(/825 of 1,835 comparable OApps \(45%\)/)
    expect(f.text).toMatch(/broad flag, not a discriminator/)
    const committed = JSON.parse(readFileSync(join(DIR, 'kelp-rseth.expected.json'), 'utf8'))
    expect(committed.framing.text).toBe(f.text)
  })

  it('unannounced is null throughout (trivially: v1 ingests no governance source; Kelp is NO-GOV-CHANNEL)', () => {
    expect(crit.unannouncedNullThroughout.pass).toBe(true)
  })

  it('the replayed merge matches on-chain getConfig at blocks 24,907,000 and 24,908,284', () => {
    expect(crit.crossChecksMatch.pass).toBe(true)
    expect(out.crossChecks.filter((c) => c.direction === 'receive').map((c) => c.replay)).toEqual([
      expect.stringMatching(/^E=1 · 1-of-1 \(layerzero-labs\)/),
      expect.stringMatching(/^E=1 · 1-of-1 \(layerzero-labs\)/),
    ])
  })
})

describe('Kelp rsETH backtest — the design §5 timeline', () => {
  it('Manta: an optional DVN with no code on Ethereum (BR-4), parked behind the dead default', () => {
    expect(at(19_446_017, 30217)!.ruleIds).toEqual(expect.arrayContaining(['BR-4', 'BR-7']))
  })
  it('Mode and Blast 2-of-2 → 1-of-1 (BR-1 + BR-2)', () => {
    for (const eid of [30260, 30243])
      expect(at(19_480_800, eid)!.ruleIds).toEqual(expect.arrayContaining(['BR-1', 'BR-2']))
  })
  it('a 1-of-1 override replacing an inherited 2-of-2 default is BR-1 (Arbitrum, Optimism, Base, Linea, Bera, Avalanche, Plasma, Mantle)', () => {
    const rows: [number, number][] = [
      [19_559_426, 30110],
      [19_559_426, 30111],
      [19_512_610, 30184],
      [19_662_870, 30183],
      [21_695_295, 30362],
      [23_167_809, 30106],
      [23_375_859, 30383],
      [24_140_229, 30181],
    ]
    for (const [b, eid] of rows) {
      const c = at(b, eid)!
      expect(c, `${eid}@${b}`).toBeTruthy()
      expect(c.ruleIds).toContain('BR-1')
      expect(c.before && (c.before as { source: string }).source).toBe('default')
    }
  })
  it('the Unichain side of eid 30320 was created at 1-of-1 too (remote replay, BR-2)', () => {
    const r = out.remoteTimeline.filter((c) => c.red)
    expect(r.map((c) => c.route?.direction).sort()).toEqual(['receive', 'send'])
    expect(r.every((c) => c.ruleIds.includes('BR-2'))).toBe(true)
    expect(out.remoteHeadAtEval.every((r) => r.breaches.some((b) => b.ruleId === 'BR-2'))).toBe(
      true,
    )
  })
  it('after the exploit: 4-of-4 upgrades, 22 peers zeroed (neutral), the Arbitrum DVN swap (neutral)', () => {
    const after = out.timeline.filter((c) => (c.block ?? 0) > EVAL)
    expect(after.some((c) => c.red)).toBe(false)
    const apr23 = after.filter(
      (c) => c.ts && new Date(c.ts * 1000).toISOString().startsWith('2026-04-23'),
    )
    expect(apr23.length).toBeGreaterThan(0)
    expect(apr23.every((c) => c.severity === 'upgrade')).toBe(true)
    const jun15 = after.filter((c) => c.block === 25_324_299 && c.route?.direction === 'receive')
    expect(jun15).toHaveLength(22)
    expect(jun15.every((c) => c.tags.includes('route_removed') && !c.red)).toBe(true)
    const swap = after.filter((c) => c.block === 25_934_516)
    expect(swap.length).toBeGreaterThan(0)
    expect(swap.every((c) => c.severity === 'neutral')).toBe(true)
  })
  it('the committed summary still matches (regression)', () => {
    const expected = JSON.parse(readFileSync(join(DIR, 'kelp-rseth.expected.json'), 'utf8'))
    expect(out.timeline.filter((c) => c.red).map((c) => c.id)).toEqual(
      expected.red.map((c: { id: string }) => c.id),
    )
  })
})

describe('the rules carry no knowledge of the outcome', () => {
  it('no rule CODE names the subject, the exploited eid, the evaluation block or the exploit date', () => {
    const dir = join(process.cwd(), 'lib', 'oracleRegistry', 'config')
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && x !== 'backtest.ts')) {
      // comments may cite the finding that motivated a rule; code may not depend on it
      const src = readFileSync(join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      expect(src, f).not.toMatch(/30320|30325|24[,_]?908|2026-04-18|0x85d456|kelp|rseth/i)
    }
  })
})

describe('base rate (how unusual was the subject at the evaluation block?)', () => {
  it('counts live under-floor routes per OApp and ranks the subject', async () => {
    const { baseRate, registryFromMeta } = await import('@/lib/oracleRegistry/config/backtest')
    const LZ = '0x589dedbd617e0cbcb916a9223f4d1300c294236b'
    const NM = '0xa59ba433ac34d2927232918ef5b2eaafcf130ba5'
    const one = {
      confirmations: '15',
      requiredDVNCount: 1,
      optionalDVNCount: 0,
      optionalDVNThreshold: 0,
      requiredDVNs: [LZ],
      optionalDVNs: [],
    }
    const two = { ...one, requiredDVNCount: 2, requiredDVNs: [LZ, NM] }
    const A = '0x' + 'a'.repeat(40)
    const B = '0x' + 'b'.repeat(40)
    const ctx = { registry: registryFromMeta(fx.metadata), code: () => true, useDeprecated: false }
    const r = baseRate(
      {
        chainId: 1,
        evalBlock: 1,
        overrides: [
          { oapp: A, eid: 1, config: one },
          { oapp: A, eid: 2, config: one },
          { oapp: B, eid: 1, config: one },
          { oapp: B, eid: 2, config: two },
        ],
        defaults: {},
        live: { [`${A}|1`]: true, [`${A}|2`]: true, [`${B}|1`]: null },
      },
      ctx,
      B,
    )
    expect(r.liveUnderFloorRoutes).toBe(2)
    expect(r.livenessUnknown).toBe(1)
    expect(r.subject.rank).toBeNull()
    expect(r.top[0]).toEqual({ oapp: A, liveUnderFloor: 2 })
  })
  it('the committed study: Kelp was one of many OApps under the floor (a broad flag, not a discriminator)', () => {
    const j = JSON.parse(readFileSync(join(DIR, 'kelp-rseth.base-rate.json'), 'utf8'))
    expect(j.evalBlock).toBe(EVAL)
    expect(j.subject.liveUnderFloor).toBeGreaterThan(0)
    expect(j.oappsWithLiveUnderFloor).toBeGreaterThan(20)
  })
})
