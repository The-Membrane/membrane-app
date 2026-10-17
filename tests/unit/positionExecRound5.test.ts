// Q27 round 5 (owner feedback, 2026-10-17): the order slip re-reads on refocus, offers the
// cap's room left, validates the amount before a signature, closes into a toast once
// settled; the collect-dust slip lets the reader untick rows.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DESIGN_STATES, reprepare } from '@/components/PositionV0/dev/slipStates'
import { DUST_STATES } from '@/components/PositionV0/dev/dustStates'
import { capSuggestion, limitOf, rowAt, settledToast, withAmount } from '@/components/PositionV0/leverExec'
import { checkAmount, maxText } from '@/lib/position-exec/amountInput'
import {
  defaultPicks,
  dustSheet,
  dustTotals,
  picked,
  pickedSim,
} from '@/lib/position-exec/dust'
import type { AmountLimit } from '@/lib/position-exec/gates'
import { REFOCUS_DEBOUNCE_MS, rereadLine, watchRefocus } from '@/lib/position-exec/refocus'
import { TX_IDLE } from '@/lib/position-exec/sheet'
import type { SimResult } from '@/lib/position-exec/simulate'
import { pausableTimer } from '@/lib/position-exec/toastTimer'
import { TOUCH_TABLE } from '@/lib/position/touchHistory'

const by = (k: string) => DESIGN_STATES.find((s) => s.key === k)!

// ------------------------------------------------------------------ refocus

class Doc extends EventTarget {
  visibilityState = 'visible'
}

describe('re-read on refocus', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const setup = (o: { enabled?: () => boolean; minGapMs?: number } = {}) => {
    const win = new EventTarget()
    const doc = new Doc()
    const hits: number[] = []
    let t = 1_000_000
    const stop = watchRefocus({
      win,
      doc,
      onRefocus: (at) => hits.push(at),
      enabled: o.enabled ?? (() => true),
      now: () => t,
      minGapMs: o.minGapMs,
    })
    const away = () => win.dispatchEvent(new Event('blur'))
    const back = () => win.dispatchEvent(new Event('focus'))
    const tick = (ms: number) => {
      t += ms
      vi.advanceTimersByTime(ms)
    }
    return { win, doc, hits, stop, away, back, tick }
  }

  it('reads again once, after the debounce, when the window has focus again', () => {
    const s = setup()
    s.back() // focus without leaving first is not a return
    s.tick(REFOCUS_DEBOUNCE_MS + 10)
    expect(s.hits).toHaveLength(0)
    s.away()
    s.back()
    s.tick(REFOCUS_DEBOUNCE_MS - 10)
    expect(s.hits).toHaveLength(0)
    s.tick(20)
    expect(s.hits).toHaveLength(1)
  })
  it('a tab coming back visible counts; focus and visibility together read once', () => {
    const s = setup()
    s.doc.visibilityState = 'hidden'
    s.doc.dispatchEvent(new Event('visibilitychange'))
    s.away()
    s.doc.visibilityState = 'visible'
    s.doc.dispatchEvent(new Event('visibilitychange'))
    s.back()
    s.tick(REFOCUS_DEBOUNCE_MS + 1)
    expect(s.hits).toHaveLength(1)
  })
  it('never sooner than the minimum gap, never while disabled, and not after stop', () => {
    let on = true
    const s = setup({ enabled: () => on, minGapMs: 5_000 })
    s.away()
    s.back()
    s.tick(REFOCUS_DEBOUNCE_MS + 1)
    s.away()
    s.back()
    s.tick(REFOCUS_DEBOUNCE_MS + 1) // inside the gap
    expect(s.hits).toHaveLength(1)
    s.tick(5_000)
    on = false // a transaction is with the wallet
    s.away()
    s.back()
    s.tick(REFOCUS_DEBOUNCE_MS + 1)
    expect(s.hits).toHaveLength(1)
    on = true
    s.stop()
    s.away()
    s.back()
    s.tick(REFOCUS_DEBOUNCE_MS + 1)
    expect(s.hits).toHaveLength(1)
  })
  it('prints the time it read again', () => {
    expect(rereadLine(new Date(2026, 9, 17, 14, 2, 9).getTime())).toBe('re-read at 14:02:09')
  })
})

// ------------------------------------------------------------------ the amount field

const LIMIT: AmountLimit = { units: 8_912_940n, why: 'balance', text: 'Wallet holds 8.91 USDT' }

describe('the amount field', () => {
  it('takes an amount the token can carry exactly, under the limit', () => {
    expect(checkAmount('8.5', 6, LIMIT)).toEqual({
      kind: 'ok',
      units: 8_500_000n,
      amount: 8.5,
      amountDecimals: 1,
      text: '8.5',
    })
    expect(checkAmount('1,000', 6, null)).toMatchObject({ kind: 'ok', units: 1_000_000_000n })
    expect(checkAmount('.25', 6, LIMIT)).toMatchObject({ kind: 'ok', units: 250_000n })
    expect(checkAmount('8.912940', 6, LIMIT)).toMatchObject({ kind: 'ok', units: 8_912_940n })
  })
  it('refuses more than the limit, by name, and anything that would round', () => {
    expect(checkAmount('9', 6, LIMIT)).toEqual({
      kind: 'error',
      message: 'More than the limit: Wallet holds 8.91 USDT',
    })
    expect(checkAmount('1.1234567', 6, null)).toEqual({ kind: 'error', message: 'At most 6 decimals for this token' })
    expect(checkAmount('0', 6, LIMIT).kind).toBe('error')
    expect(checkAmount('abc', 6, LIMIT).kind).toBe('error')
    expect(checkAmount('', 6, LIMIT)).toEqual({ kind: 'empty' })
  })
  it('Max is the limit cut down, never above it', () => {
    expect(maxText(LIMIT, 6, 6)).toBe('8.91294')
    expect(maxText(LIMIT, 6, 2)).toBe('8.91')
    expect(maxText({ ...LIMIT, units: 0n }, 6, 2)).toBeNull()
    expect(maxText({ ...LIMIT, units: 2_000_000n }, 6, 2)).toBe('2')
    const max = maxText(LIMIT, 6, 6)!
    expect(checkAmount(max, 6, LIMIT).kind).toBe('ok')
  })
  it('on the captured short read, the limit is the wallet and the solved repay is over it', () => {
    const s = by('balance')
    const limit = limitOf(s.prepared!)
    expect(limit.why).toBe('balance')
    expect(limit.text).toMatch(/^Wallet holds 8\.91 USDT$/)
    expect(checkAmount('20', 6, limit).kind).toBe('error')
  })
})

// ------------------------------------------------------------------ cap room

describe('over the cap: the room left, one tap', () => {
  it('offers the room left, cut down to the row decimals', () => {
    const s = by('cap')
    expect(s.sheet.notice).toMatch(/^Over the supply cap: cap 2,700,000 · supplied/)
    expect(capSuggestion(s.prepared!)).toEqual({ amount: 0.24, amountDecimals: 2, text: 'Use 0.24 (the room left)' })
    // No offer where the cap is not what blocks.
    expect(capSuggestion(by('ready').prepared!)).toBeNull()
  })
  it('re-prepares the slip at that amount: the cap passes and the rows move', () => {
    const s = by('cap')
    const sug = capSuggestion(s.prepared!)!
    const r = reprepare(s, sug.amount, sug.amountDecimals)
    const p = r.prepared!
    expect(p.custom).toBe(true)
    expect(p.amount).toBe(240_000_000_000_000_000n)
    expect(p.gates.find((g) => g.id === 'cap')).toMatchObject({ ok: true })
    expect(p.gates.every((g) => g.ok)).toBe(true)
    expect(p.calls.find((c) => c.functionName === 'approve')!.args![1]).toBe(240_000_000_000_000_000n)
    // A smaller top-up moves the line less far than the solved one.
    expect(p.row.newDistancePct).toBeLessThanOrEqual(s.prepared!.row.newDistancePct)
    // The captured simulation was of the old batch: the new one is simulated afresh.
    expect(r.sheet.button).toMatchObject({ kind: 'wait', label: 'Simulating…' })
    expect(r.sheet.notice).toBeNull()
  })
})

describe("the reader's own amount", () => {
  it('a lower repay re-solves the rows on the same model and buffer', () => {
    const s = by('ready')
    const p = s.prepared!
    const half = rowAt(p.view, p.row, 380, 0, TOUCH_TABLE)
    expect(half.amount).toBe(380)
    expect(half.newDistancePct).toBeLessThanOrEqual(p.row.newDistancePct)
    expect(half.action).toBe('If you repay 380 USDT')
    // The solve's own amount comes back to the solve's distance.
    expect(rowAt(p.view, p.row, p.row.amount, p.row.amountDecimals, TOUCH_TABLE).newDistancePct).toBe(
      p.row.newDistancePct,
    )
  })
  it('withAmount rebuilds gates and calls at the new units, and refuses Morpho without a read', () => {
    const p = withAmount(by('ready').prepared!, by('ready').intent, 380, 0, TOUCH_TABLE)
    expect(p.amount).toBe(380_000_000n)
    expect(p.read.action.amount).toBe(380_000_000n)
    expect(p.gates.every((g) => g.ok)).toBe(true)
    const morpho = { ...by('ready').prepared!, read: { ...by('ready').prepared!.read, venue: { venue: 'morpho' } } }
    expect(() =>
      withAmount(morpho as never, by('ready').intent, 380, 0, TOUCH_TABLE),
    ).toThrow(/fresh read/)
  })
})

// ------------------------------------------------------------------ settled toast

describe('settled: the toast', () => {
  it('says what was done and the new line, from the slip', () => {
    const s = by('settled')
    const t = settledToast(s.prepared!, s.intent.horizon, s.txHash!)
    expect(t.text).toMatch(/^Repaid 760 USDT · new line \$[\d,]+(\.\d+)?$/)
    expect(t.hash).toBe(s.txHash)
  })
  it('fades on its clock, which stops while hovered', () => {
    vi.useFakeTimers()
    let t = 0
    const done = vi.fn()
    const timer = pausableTimer(6_000, done, () => t)
    const step = (ms: number) => {
      t += ms
      vi.advanceTimersByTime(ms)
    }
    step(2_000)
    timer.pause()
    step(10_000)
    expect(done).not.toHaveBeenCalled()
    expect(timer.left()).toBe(4_000)
    timer.resume()
    step(3_999)
    expect(done).not.toHaveBeenCalled()
    step(1)
    expect(done).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})

// ------------------------------------------------------------------ collect dust: ticks

const SIM: SimResult = {
  ok: true,
  method: 'eth_simulateV1',
  gas: [100_000n, 50_000n, 30_000n],
  bufferedGas: 189_000n,
  maxFeePerGas: 1_000_000_000n,
}

describe('collect dust: untick rows', () => {
  const lender = DUST_STATES.find((s) => s.key === 'dust-gas-exceeds-value')!
  it('starts with rows that pay nothing off and rows that pay something on', () => {
    const picks = defaultPicks(lender.dust)
    expect(picks).toEqual(lender.dust.map((c) => c.assets > 0n))
    expect(picks.some((p) => !p)).toBe(true)
    expect(picks.some(Boolean)).toBe(true)
  })
  it('cuts the simulated gas to the ticked calls', () => {
    expect(pickedSim(SIM, [true, false, true])).toMatchObject({ gas: [100_000n, 30_000n], bufferedGas: 136_500n })
    expect(pickedSim(SIM, [false, false, false])).toBeNull()
    const unknown: SimResult = { ...SIM, gas: [100_000n, null, 30_000n] }
    expect(pickedSim(unknown, [true, true, false])).toBe(unknown)
  })
  it('totals follow the ticks; none ticked reads "Nothing selected", disabled', () => {
    const all = lender.dust.map(() => true)
    const some = defaultPicks(lender.dust)
    const tAll = dustTotals(lender.dust, pickedSim(lender.sim, all), lender.ethUsd)
    const tSome = dustTotals(picked(lender.dust, some), pickedSim(lender.sim, some), lender.ethUsd)
    expect(tSome.rows.length).toBeLessThan(tAll.rows.length)
    expect(tSome.receiveUsd).toBeCloseTo(tAll.receiveUsd, 12) // the zero rows paid nothing
    if (tAll.gasUsd !== null && tSome.gasUsd !== null) expect(tSome.gasUsd).toBeLessThan(tAll.gasUsd)
    const none = dustSheet([], null, { connected: true, address: lender.owner, chainId: 1 }, TX_IDLE, lender.owner)
    expect(none.button).toEqual({ kind: 'wait', label: 'Nothing selected', enabled: false })
    expect(none.checks.some((c) => c.id === 'sim')).toBe(false)
    expect(lender.sheetFor(picked(lender.dust, all), pickedSim(lender.sim, all)).button.label).toBe(
      `Collect dust from ${lender.dust.length} positions`,
    )
  })
})
