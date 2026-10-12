import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_INPUTS,
  EXIT_QUEUE_NOT_LOADED,
  LOADOUTS,
  STRESS_LABEL,
  anchorAgeText,
  buildStressPosition,
  computeFrontier,
  exitQueueView,
  queueTimeText,
  resolveSelection,
  usd,
  type ExitQueueContext,
  type ExitQueueView,
  type SandboxInputs,
} from '@/components/RiskFrontier/viewModel'
import type { ExitTimeInput } from '@/lib/exitQueue/riskFrontier'
import { label, type VenueKey } from '@/lib/exitQueue/types'
import { queueVenuePosition } from '@/lib/position-sim/exitQueueAxis'
import { runStress, type StressResult } from '@/lib/position-sim/stressGrid'

// ------------------------------------------------------------------ fixtures

const H = 3_600
const D = 86_400
const ANCHOR = { block: 26_130_296, ts: 1_791_246_000 } // 2026-10-06T00:20Z
const LIVE_NOW = (ANCHOR.ts + 2 * H) * 1000
const STALE_NOW = (ANCHOR.ts + 7 * D + 3 * H) * 1000
const STEP = { price: { kind: 'step' as const, drop: 0.25 } }

/** A ledger input shaped like the 2026-10-05 keyed-RPC readings (board, exit-queue lane). */
function input(venue: VenueKey, o: Partial<ExitTimeInput> = {}): ExitTimeInput {
  return {
    venue,
    anchor: ANCHOR,
    label: label('measured_history'),
    windowDays: 30,
    coverage: 'complete',
    requestToExit: { p50S: null, p90S: null, atLeastS: null, n: 0 },
    advertisedCooldownS: null,
    advertisedSetsWait: false,
    scheduleFloorS: null,
    queueDepth: { amount: null, count: null, symbol: 'X', decimals: 18 },
    oldestOpenAgeS: null,
    lastParamChangeTs: null,
    ...o,
  }
}

const LIDO = input('lido-steth', {
  requestToExit: { p50S: 23.4 * H, p90S: 112.1 * H, atLeastS: null, n: 2843 },
  queueDepth: { amount: '131818000000000000000000', count: 514, symbol: 'stETH', decimals: 18 },
  oldestOpenAgeS: 140 * H,
})
const KELP = input('kelp-rseth', {
  requestToExit: { p50S: 402.5 * H, p90S: null, atLeastS: 505.9 * H, n: 218 },
  advertisedCooldownS: 0,
})
const MAPLE = input('maple-syrupusdc', {
  requestToExit: { p50S: 204, p90S: 384, atLeastS: null, n: 609 },
})
const BEACON = input('beacon-exit', {
  requestToExit: { p50S: 200 * H, p90S: 230 * H, atLeastS: null, n: 40 },
  scheduleFloorS: 230 * H,
})
const FEED: ExitTimeInput[] = [LIDO, BEACON, KELP, MAPLE]

const ctx = (o: Partial<ExitQueueContext> = {}): ExitQueueContext => ({
  inputs: FEED,
  missing: '',
  nowMs: LIVE_NOW,
  venue: null,
  ...o,
})

const pos = (inp: SandboxInputs = DEFAULT_INPUTS) => buildStressPosition(inp).position

const row = (v: ExitQueueView, venue: VenueKey) => v.rows.find((r) => r.venue === venue)!

const sold = (r: StressResult | null) => (r && r.outcome !== 'not_modelled' ? r.exposedUsd : 0)

/** Every string the panel prints for one view. */
function visible(v: ExitQueueView): string[] {
  const out = [v.missing ?? '', v.dateline ?? '', v.note ?? '', v.comparison ?? '']
  for (const r of v.rows)
    out.push(
      r.name,
      r.asset,
      r.p50Text,
      r.p90Text,
      r.queueText,
      r.oldestText ?? '',
      r.ageText,
      r.stateNote ?? '',
      r.finding ?? '',
      r.credit,
    )
  return out
}

// ------------------------------------------------------------------ format

describe('exit queues — format', () => {
  it('prints a wait in hours; a lower bound floors so "≥" stays true', () => {
    expect(queueTimeText(384)).toBe('6m')
    expect(queueTimeText(30)).toBe('<1m')
    expect(queueTimeText(7.56 * H)).toBe('7.6h')
    expect(queueTimeText(112.1 * H)).toBe('112h')
    expect(queueTimeText(505.9 * H, true)).toBe('≥505h')
    expect(queueTimeText(7.59 * H, true)).toBe('≥7.5h')
    expect(queueTimeText(-1)).toBe('—')
  })

  it('floors the anchor age', () => {
    expect(anchorAgeText(2 * H + 59 * 60)).toBe('2h old')
    expect(anchorAgeText(7 * D + 3 * H)).toBe('7d 3h old')
    expect(anchorAgeText(-5)).toBe('ahead of this clock')
  })
})

// ------------------------------------------------------------------ the owner's rule

describe('exit queues — only what is liquid at the call is used (owner, 2026-10-12)', () => {
  it('runs the held −25% step with recall = the vault buffer, at target and drained', () => {
    const p = pos()
    const v = exitQueueView(p, ctx())
    expect(v.runs?.atBufferTarget).toEqual(runStress(queueVenuePosition(p, 0.05), STEP))
    expect(v.runs?.bufferDrained).toEqual(runStress(queueVenuePosition(p, 0), STEP))
    expect(v.liquid).toEqual(runStress(p, STEP))
  })

  it('negative control: a 6-minute queue and a ≥ 21-day queue sell the same', () => {
    const v = exitQueueView(pos(), ctx())
    const tail = (f: string | null) => f!.slice(f!.indexOf('Only the'))
    expect(tail(row(v, 'maple-syrupusdc').finding)).toBe(tail(row(v, 'lido-steth').finding))
    expect(tail(row(v, 'kelp-rseth').finding)).toBe(tail(row(v, 'lido-steth').finding))
  })

  it('states the Lido finding as analysis: the wait, set aside, and the dollars sold', () => {
    const p = pos()
    const v = exitQueueView(p, ctx())
    const target = sold(runStress(queueVenuePosition(p, 0.05), STEP))
    const drained = sold(runStress(queueVenuePosition(p, 0), STEP))
    expect(row(v, 'lido-steth').finding).toBe(
      "Your stETH exit takes 112h at p90, and a liquidation can't wait for it. " +
        `Only the 5% buffer is liquid, so a held −25% step sells ${usd(target)} to ${usd(drained)}.`,
    )
    expect(row(v, 'lido-steth').finding).toContain('$19,151 to $23,588')
    // The same position recalls in time from a liquid venue: the queue is what sells.
    expect(v.liquid?.outcome).toBe('recall_cured')
    expect(v.comparison).toBe(
      'Held −25% †: 5% buffer at target, sold ($19.2k of collateral); buffer drained, sold ' +
        '($23.6k of collateral). A liquid venue (your chosen exit): recall restored (recalled $4,010).',
    )
  })

  it('a lower bound keeps its "≥"', () => {
    expect(row(exitQueueView(pos(), ctx()), 'kelp-rseth').finding).toMatch(
      /^Your rsETH exit takes ≥505h at p90, and a liquidation can't wait for it\./,
    )
  })

  it('equal ends say one figure; no sale says so', () => {
    const tight = LOADOUTS.find((l) => l.id === 'tight-carry')!.inputs
    expect(row(exitQueueView(pos(tight), ctx()), 'lido-steth').finding).toMatch(
      /so a held −25% step sells \$30,000\.$/,
    )
    // LTV 30%: −25% never reaches the line.
    const low = pos({ ...DEFAULT_INPUTS, collateralUsd: 100_000, debtUsd: 30_000 })
    expect(row(exitQueueView(low, ctx()), 'maple-syrupusdc').finding).toBe(
      "Your syrupUSDC exit takes 6m at p90, and a liquidation can't wait for it. " +
        'Only the 5% buffer is liquid, and a held −25% step sells nothing.',
    )
  })

  it('the no-delay class reads the same: the call happens at the line', () => {
    const nd = LOADOUTS.find((l) => l.id === 'no-delay')!.inputs
    const f = row(exitQueueView(pos(nd), ctx()), 'lido-steth').finding!
    expect(f).toMatch(/^Your stETH exit takes 112h at p90/)
    expect(f).toMatch(/sells \$75,000\.$/)
    expect(f).not.toMatch(/window/)
  })

  it('levered long: rows show the readings, nothing claims a recall', () => {
    const lev = LOADOUTS.find((l) => l.id === 'levered')!.inputs
    const v = exitQueueView(pos(lev), ctx())
    expect(v.note).toBe('Levered long: no recall, so no exit queue applies.')
    expect(v.liquid).toBeNull()
    expect(v.comparison).toBeNull()
    for (const r of v.rows) expect(r.finding).toBeNull()
    expect(v.runs?.atBufferTarget?.outcome).toBe('not_modelled')
  })
})

// ------------------------------------------------------------------ the rows

describe('exit queues — rows carry the measured queue', () => {
  it('shows p50, p90, the queue and a stall the p90 hides', () => {
    const lido = row(exitQueueView(pos(), ctx()), 'lido-steth')
    expect(lido.state).toBe('live')
    expect(lido.p50Text).toBe('23h')
    expect(lido.p90Text).toBe('112h')
    expect(lido.queueText).toBe('131.8k stETH · 514 requests')
    expect(lido.oldestText).toBe('oldest open 140h')
    expect(lido.stateNote).toBeNull()
    expect(lido.credit).toBe(
      'p90 request → claimable, last 30 d, n=2,843 · block 26,130,296 · measured history, not a forecast',
    )
  })

  it('a queue no position token exits through has no row (the beacon queue)', () => {
    const v = exitQueueView(pos(), ctx())
    expect(v.rows.map((r) => r.venue)).toEqual(['lido-steth', 'kelp-rseth', 'maple-syrupusdc'])
    expect(v.selected?.venue).toBe('lido-steth')
    expect(exitQueueView(pos(), ctx({ venue: 'maple-syrupusdc' })).selected?.venue).toBe(
      'maple-syrupusdc',
    )
    expect(v.dateline).toBe('exit-queue ledger · block 26,130,296 · 2h old')
  })
})

// ------------------------------------------------------------------ never live when not

describe('exit queues — stale, unknown and missing are never shown as live', () => {
  it('a stale ledger is hatched with its age, runs nothing and has no finding', () => {
    const v = exitQueueView(pos(), ctx({ nowMs: STALE_NOW }))
    expect(v.stale).toBe(true)
    expect(v.runs).toBeNull()
    expect(v.comparison).toBeNull()
    expect(v.dateline).toBe('exit-queue ledger · block 26,130,296 · 7d 3h old · stale, not live')
    for (const r of v.rows) {
      expect(r.state).toBe('stale')
      expect(r.finding).toBeNull() // the headline is suppressed while stale
      expect(r.stateNote).toBe('stale, 7d 3h old: not run')
      expect(r.ageText).toBe('block 26,130,296 · 7d 3h old')
    }
    // The last reading stays visible, hatched, so the reader sees what went stale.
    expect(row(v, 'lido-steth').p90Text).toBe('112h')
  })

  it('goes stale at the ledger rule: 30 h, not before', () => {
    const at30 = exitQueueView(pos(), ctx({ nowMs: (ANCHOR.ts + 30 * H) * 1000 }))
    expect(row(at30, 'lido-steth').state).toBe('live')
    const past = exitQueueView(pos(), ctx({ nowMs: (ANCHOR.ts + 30 * H + 1) * 1000 }))
    expect(row(past, 'lido-steth').state).toBe('stale')
  })

  it('one stale venue hatches only itself, and the dateline names the oldest anchor', () => {
    const old = { block: 26_100_000, ts: ANCHOR.ts - 3 * D }
    const v = exitQueueView(pos(), ctx({ inputs: [{ ...LIDO, anchor: old }, MAPLE] }))
    expect(row(v, 'lido-steth').state).toBe('stale')
    expect(row(v, 'lido-steth').finding).toBeNull()
    expect(row(v, 'maple-syrupusdc').state).toBe('live')
    expect(row(v, 'maple-syrupusdc').finding).not.toBeNull()
    expect(v.dateline).toBe('exit-queue ledger · block 26,100,000 · 3d 2h old · stale, not live')
  })

  it('a venue with nothing measured runs nothing: unknown is never a zero wait', () => {
    const v = exitQueueView(pos(), ctx({ inputs: [input('lido-steth')] }))
    const r = v.rows[0]
    expect(r.state).toBe('unknown')
    expect(r.p90Text).toBe('—')
    expect(r.finding).toBeNull()
    expect(r.stateNote).toBe('nothing measured yet: not run')
    expect(v.runs).toBeNull()
  })

  it('no ledger: no rows, and the reason is shown', () => {
    const v = exitQueueView(
      pos(),
      ctx({ inputs: null, missing: 'no exit-queue ledger on this host' }),
    )
    expect(v.rows).toEqual([])
    expect(v.missing).toBe('no exit-queue ledger on this host')
    expect(computeFrontier(DEFAULT_INPUTS, null).exitQueue.missing).toBe(
      EXIT_QUEUE_NOT_LOADED.missing,
    )
  })
})

// ------------------------------------------------------------------ model wiring

describe('exit queues — model and selection', () => {
  it('computeFrontier carries the exit-queue view; selection resolves to the buffer node', () => {
    const m = computeFrontier(DEFAULT_INPUTS, null, undefined, undefined, ctx())
    const sel = resolveSelection(m, { kind: 'exitQueue', venue: 'lido-steth' })
    expect(sel.title).toBe('Exit queue · Lido stETH')
    expect(sel.sub).toBe('held −25% step · recall = the 5% buffer at target')
    expect(sel.result?.cellKey).toBe(m.exitQueue.runs?.atBufferTarget?.cellKey)
    expect(sel.stock).toBe(
      "the vault's 5% buffer: the Lido stETH queue (112h at p90) pays nothing inside the call",
    )
  })

  it('a stale selection resolves to no result, and says why', () => {
    const m = computeFrontier(DEFAULT_INPUTS, null, undefined, undefined, ctx({ nowMs: STALE_NOW }))
    const sel = resolveSelection(m, { kind: 'exitQueue', venue: 'lido-steth' })
    expect(sel.result).toBeNull()
    expect(sel.missing).toBe('stale, 7d 3h old: not run')
  })

  it('keeps the copy rules on every loadout, live and stale', () => {
    for (const l of LOADOUTS) {
      for (const nowMs of [LIVE_NOW, STALE_NOW]) {
        const text = visible(exitQueueView(pos(l.inputs), ctx({ nowMs }))).join(' \n ')
        expect(text, l.id).not.toMatch(/(^|[^\d.])0(\.0+)?%/) // no bare 0%
        expect(text, l.id).not.toMatch(/\$0(?![\d,.])/) // no bare $0
        expect(text, l.id).not.toMatch(
          /\bfree\b|interest-free|\bsafe\b|\bok\b|win rate|confidence|% of users/i,
        )
        expect(text.split(STRESS_LABEL).join(''), l.id).not.toMatch(/probab|odds|chance|likely/i)
        expect(text, l.id).not.toMatch(/freeze|window/i) // the queue is not a wait the call makes
      }
    }
  })
})

describe('exit queues — fine print', () => {
  it('no longer lists LST exit queues as not modelled, and states the liquid-only rule', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../components/RiskFrontier/FinePrint.tsx'),
      'utf8',
    )
    const notYet = src.slice(src.indexOf("head: 'Also not modelled yet'"))
    expect(notYet).not.toMatch(/exit queue/i)
    expect(src).toContain("head: 'Exit queues'")
    expect(src).toContain('pays nothing there, whatever its length')
    expect(src).toContain('is hatched with its age and runs nothing')
  })
})
