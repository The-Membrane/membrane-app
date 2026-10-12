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
  windowMultipleText,
  type ExitQueueContext,
  type ExitQueueView,
  type SandboxInputs,
} from '@/components/RiskFrontier/viewModel'
import type { ExitTimeInput } from '@/lib/exitQueue/riskFrontier'
import { label, type VenueKey } from '@/lib/exitQueue/types'
import { runStress } from '@/lib/position-sim/stressGrid'

// ------------------------------------------------------------------ fixtures

const H = 3_600
const D = 86_400
const ANCHOR = { block: 26_130_296, ts: 1_791_246_000 } // 2026-10-06T00:20Z
const LIVE_NOW = (ANCHOR.ts + 2 * H) * 1000
const STALE_NOW = (ANCHOR.ts + 7 * D + 3 * H) * 1000

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

/** Every string the panel prints for one view. */
function visible(v: ExitQueueView): string[] {
  const out = [v.missing ?? '', v.dateline ?? '', v.note ?? '']
  for (const r of v.rows)
    out.push(
      r.name,
      r.asset,
      r.p50Text,
      r.p90Text,
      r.queueText,
      r.oldestText ?? '',
      r.ageText,
      r.leaf.title,
      r.leaf.short,
      r.evidence,
      r.finding ?? '',
      r.comparison ?? '',
      r.credit,
    )
  return out
}

// ------------------------------------------------------------------ format

describe('exit queues — format', () => {
  it('prints a wait in the window unit; a lower bound floors so "≥" stays true', () => {
    expect(queueTimeText(384)).toBe('6m')
    expect(queueTimeText(30)).toBe('<1m')
    expect(queueTimeText(7.56 * H)).toBe('7.6h')
    expect(queueTimeText(112.1 * H)).toBe('112h')
    expect(queueTimeText(505.9 * H, true)).toBe('≥505h')
    expect(queueTimeText(7.59 * H, true)).toBe('≥7.5h')
    expect(queueTimeText(-1)).toBe('—')
  })

  it('floors the window multiple and the anchor age', () => {
    expect(windowMultipleText(112.1 / 8)).toBe('14×')
    expect(windowMultipleText(36.5 / 8)).toBe('4.5×')
    expect(windowMultipleText(505.9 / 8, true)).toBe('≥63×')
    expect(anchorAgeText(2 * H + 59 * 60)).toBe('2h old')
    expect(anchorAgeText(7 * D + 3 * H)).toBe('7d 3h old')
    expect(anchorAgeText(-5)).toBe('ahead of this clock')
  })
})

// ------------------------------------------------------------------ live

describe('exit queues — live ledger', () => {
  it('states the Lido finding as analysis: the wait against the window', () => {
    const v = exitQueueView(pos(), ctx())
    const lido = row(v, 'lido-steth')
    expect(lido.state).toBe('live')
    expect(lido.finding).toBe(
      "Your stETH exit takes 112h at p90, 14× the 8h window, so recall can't come from Lido.",
    )
    expect(lido.p50Text).toBe('23h')
    expect(lido.p90Text).toBe('112h')
    expect(lido.queueText).toBe('131.8k stETH · 514 requests')
    expect(lido.oldestText).toBe('oldest open 140h')
    expect(lido.windowMultiple).toBeCloseTo(112.1 / 8, 6)
    expect(lido.credit).toBe(
      'p90 request → claimable, last 30 d, n=2,843 · block 26,130,296 · measured history, not a forecast',
    )
    expect(v.selected?.venue).toBe('lido-steth')
    expect(v.stale).toBe(false)
    expect(v.dateline).toBe('exit-queue ledger · block 26,130,296 · 2h old')
  })

  it('runs the queue as a freeze at the held −25% step', () => {
    const p = pos()
    const lido = row(exitQueueView(p, ctx()), 'lido-steth')
    const direct = runStress(p, {
      price: { kind: 'step', drop: 0.25 },
      venue: { freezeHours: 112.1 },
    })
    expect(lido.result?.cellKey).toBe(direct.cellKey)
    expect(lido.result?.outcome).toBe(direct.outcome)
  })

  it('a short queue that still loses to the step names the dollars it adds', () => {
    const p = pos()
    const v = exitQueueView(p, ctx({ venue: 'maple-syrupusdc' }))
    const maple = row(v, 'maple-syrupusdc')
    const queued = maple.result!
    const instant = v.instant!
    expect(queued.outcome).toBe('sold')
    expect(instant.outcome).not.toBe('sold')
    const extra =
      (queued.outcome === 'not_modelled' ? 0 : queued.exposedUsd) -
      (instant.outcome === 'not_modelled' ? 0 : instant.exposedUsd)
    expect(maple.finding).toBe(
      `Your syrupUSDC exit takes 6m at p90, yet a −25% step sells ${usd(extra)} before it lands.`,
    )
    expect(maple.comparison).toMatch(/^Held −25% †: through the queue, sold \(/)
    expect(maple.comparison).toContain('Instant recall (master today): recall restored')
    expect(v.selected?.venue).toBe('maple-syrupusdc')
  })

  it('a queue inside the window that adds no sale says so', () => {
    // LTV 30%: −25% never reaches the line, with or without the queue.
    const low = pos({ ...DEFAULT_INPUTS, collateralUsd: 100_000, debtUsd: 30_000 })
    const maple = row(exitQueueView(low, ctx()), 'maple-syrupusdc')
    expect(maple.finding).toBe(
      'Your syrupUSDC exit takes 6m at p90, inside the 8h window: at −25% it adds no sale.',
    )
    // The wait past the window is still the finding for Lido, whatever the step does.
    expect(row(exitQueueView(low, ctx()), 'lido-steth').finding).toContain(
      "so recall can't come from Lido",
    )
  })

  it('a lower bound prints "≥" and runs both ends', () => {
    const kelp = row(exitQueueView(pos(), ctx()), 'kelp-rseth')
    expect(kelp.p90Text).toBe('≥505h')
    expect(kelp.finding).toBe(
      "Your rsETH exit takes ≥505h at p90, ≥63× the 8h window, so recall can't come from Kelp.",
    )
    expect(kelp.resultIfNeverPaid).not.toBeNull()
    // Both ends sell the same here (−25% jumps past the band): said once.
    expect(kelp.evidence).toBe('$23.6k of collateral (at the bound or never paid)')
    expect(kelp.comparison).toContain('at the bound sold (')
    expect(kelp.comparison).toContain('never paid sold (')
  })

  it('a lower bound whose two ends differ names both', () => {
    // LTV 65.9%: −25% lands inside the band, so the window arms. Recall at the 2 h bound
    // cures; recall that never arrives sells at expiry.
    const inBand = pos({ ...DEFAULT_INPUTS, debtUsd: 29_000 })
    const v = exitQueueView(
      inBand,
      ctx({
        inputs: [
          input('kelp-rseth', { requestToExit: { p50S: null, p90S: null, atLeastS: 2 * H, n: 9 } }),
        ],
      }),
    )
    const kelp = v.rows[0]
    expect(kelp.result?.outcome).toBe('armed_cured')
    expect(kelp.resultIfNeverPaid?.outcome).toBe('sold')
    expect(kelp.evidence).toMatch(
      /^at the bound: armed at .* · never paid: \$[\d.,k]+ of collateral$/,
    )
    expect(kelp.finding).toBe(
      'Your rsETH exit takes ≥2.0h at p90, a lower bound: the real wait may be longer.',
    )
  })

  it('a lower bound inside the window never claims the queue fits', () => {
    const v = exitQueueView(
      pos(),
      ctx({
        inputs: [
          input('maple-syrupusdc', {
            requestToExit: { p50S: null, p90S: null, atLeastS: 2 * H, n: 4 },
          }),
        ],
      }),
    )
    expect(v.rows[0].finding).toBe(
      'Your syrupUSDC exit takes ≥2.0h at p90, a lower bound: the real wait may be longer.',
    )
  })

  it('the no-delay class has no window to compare: it reads the step instead', () => {
    const nd = LOADOUTS.find((l) => l.id === 'no-delay')!.inputs
    const v = exitQueueView(pos(nd), ctx())
    expect(v.windowHours).toBe(0)
    const lido = row(v, 'lido-steth')
    expect(lido.windowMultiple).toBeNull()
    expect(lido.finding).toMatch(/^Your stETH exit takes 112h at p90, yet a −25% step sells \$/)
    expect(lido.finding).not.toMatch(/window/)
  })

  it('levered long: rows show the readings, nothing claims a recall', () => {
    const lev = LOADOUTS.find((l) => l.id === 'levered')!.inputs
    const v = exitQueueView(pos(lev), ctx())
    expect(v.note).toBe('Levered long: no recall, so no exit queue applies.')
    expect(v.instant).toBeNull()
    for (const r of v.rows) {
      expect(r.finding).toBeNull()
      expect(r.comparison).toBeNull()
    }
    expect(row(v, 'lido-steth').result?.outcome).toBe('not_modelled')
  })

  it('a queue no position token exits through has no row (the beacon queue)', () => {
    const v = exitQueueView(pos(), ctx())
    expect(v.rows.map((r) => r.venue)).toEqual(['lido-steth', 'kelp-rseth', 'maple-syrupusdc'])
  })
})

// ------------------------------------------------------------------ never live when not

describe('exit queues — stale, unknown and missing are never shown as live', () => {
  it('a stale ledger is hatched with its age, runs nothing and has no finding', () => {
    const v = exitQueueView(pos(), ctx({ nowMs: STALE_NOW }))
    expect(v.stale).toBe(true)
    expect(v.dateline).toBe('exit-queue ledger · block 26,130,296 · 7d 3h old · stale, not live')
    for (const r of v.rows) {
      expect(r.state).toBe('stale')
      expect(r.leaf.glyph).toBe('░') // hatched
      expect(r.leaf.tone).toBe('muted') // never coloured, never green
      expect(r.result).toBeNull()
      expect(r.resultIfNeverPaid).toBeNull()
      expect(r.finding).toBeNull() // the headline is suppressed while stale
      expect(r.comparison).toBeNull()
      expect(r.ageText).toBe('block 26,130,296 · 7d 3h old')
      expect(r.evidence).toBe('not run: 7d 3h old')
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
    expect(row(v, 'maple-syrupusdc').state).toBe('live')
    expect(v.dateline).toBe('exit-queue ledger · block 26,100,000 · 3d 2h old · stale, not live')
  })

  it('a venue with nothing measured runs nothing: unknown is never a zero wait', () => {
    const v = exitQueueView(pos(), ctx({ inputs: [input('lido-steth')] }))
    const r = v.rows[0]
    expect(r.state).toBe('unknown')
    expect(r.p90Text).toBe('—')
    expect(r.result).toBeNull()
    expect(r.finding).toBeNull()
    expect(r.leaf).toMatchObject({ glyph: '░', tone: 'muted', short: 'nothing measured yet' })
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
  it('computeFrontier carries the exit-queue view; selection resolves to its node', () => {
    const m = computeFrontier(DEFAULT_INPUTS, null, undefined, undefined, ctx())
    const lido = row(m.exitQueue, 'lido-steth')
    const sel = resolveSelection(m, { kind: 'exitQueue', venue: 'lido-steth' })
    expect(sel.title).toBe('Exit queue · Lido stETH')
    expect(sel.sub).toBe('held −25% step · recall paid after 112h (p90)')
    expect(sel.result?.cellKey).toBe(lido.result?.cellKey)
    expect(sel.stock).toContain('paid after the Lido stETH queue')
  })

  it('a stale selection resolves to no result, and says why', () => {
    const m = computeFrontier(DEFAULT_INPUTS, null, undefined, undefined, ctx({ nowMs: STALE_NOW }))
    const sel = resolveSelection(m, { kind: 'exitQueue', venue: 'lido-steth' })
    expect(sel.result).toBeNull()
    expect(sel.missing).toBe(
      'stale ledger, block 26,130,296 · 7d 3h old: the last reading is not run',
    )
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
      }
    }
  })
})

describe('exit queues — fine print', () => {
  it('no longer lists LST exit queues as not modelled, and explains the axis', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../components/RiskFrontier/FinePrint.tsx'),
      'utf8',
    )
    const notYet = src.slice(src.indexOf("head: 'Also not modelled yet'"))
    expect(notYet).not.toMatch(/exit queue/i)
    expect(src).toContain("head: 'Exit queues'")
    expect(src).toContain('is hatched with its age and runs nothing')
  })
})
