/**
 * Live wavefront engine — the whole minute loop on a scripted chain (tests/unit/wavefrontLiveFake.ts:
 * real ABIs, real Multicall3 calldata decoded and answered; an Aave registry with the Core market
 * and a second "Lido" market).
 *
 * Scenario (Base-like 2 s blocks; minute m starts at EPOCH + 60 m; WETH follows PATH by minute):
 *   A   Core, 10 WETH vs 17,000 USDC, liquidated mid-minute 5 (LTV0 0.85, line 0.83: armed),
 *       saved at 8, sold at the band at 9; liquidated again at 9 (real only)
 *   AL  the same address on the Lido market, liquidated at 5: a SECOND position (pid has the pool)
 *   C   Morpho, 10 WETH vs ~17,400 USDC, LLTV 0.86, liquidated at 5 (armed)
 *   B   Core, 10 WETH vs 15,000 USDC, liquidated at 6, HF >= 1 at N and at N-1: walked:false
 *   D   Core, 10 WETH vs 17,200 USDC, liquidated at 6 (same minute as B)
 *   F   Core, 10 WETH vs 16,500 USDC, liquidated at 11 in a block whose END price (1,990) hides
 *       the breach the N-1 price (1,960) shows: located at N-1 (`priceBasis: 'N-1'`)
 *
 * Checked: the stream folds through the reducer; opens / reals (with the Aave protocol fee) /
 * mems / ticks; one position per (pool, user); a mid-minute open (t0 record at its own second,
 * the next at the minute start); ONE price multicall per stepped minute for every position on the
 * chain (both Aave oracles and the Morpho oracle in it); A's records equal a kernel fed the
 * scripted path directly; no silent carry-forward (a value missing on every backend is a gap on
 * the tick, a value missing on one backend is re-read); resume after a crash (in-process and a new
 * process) gives the same stream; a restart after downtime replays the missed minutes flagged
 * `backfilled`; logs are never read past head − confirmations (of the LOWER of two backends'
 * heads) and an event in an unconfirmed block that disappears is never emitted; a false empty
 * and a short answer are caught by the second backend; an event both primary backends missed
 * comes back `late` via the background reconciliation; an empty no second backend can confirm is
 * not believed. (Scope, dedupe, lagging chains, cancellation, gap-close and the state's size:
 * wavefrontLiveLiveness.test.ts.)
 */
import { describe, expect, it } from 'vitest'

import { MembraneKernel, type KernelLeg } from '@/lib/wavefront/kernel'
import { replay, roundRecord, type MemRecord, type StreamRecord } from '@/lib/wavefront/stream'
import {
  Blocks,
  CHAIN_CONFIG,
  LogScanner,
  MemorySink,
  SimClock,
  UnconfirmedEmptyError,
  aaveProtocolFee,
  type HeadFn,
  type LiveRecord,
} from '@/lib/wavefront/live'
import { FakeChain, aaveLog } from './wavefrontLiveFake'
import {
  A,
  D,
  EPOCH,
  F_N,
  PATH,
  S,
  USDC,
  WETH,
  blockAt,
  chainSpec,
  engine,
  pidA,
  pidAL,
  pidB,
  pidC,
  pidD,
  pidF,
  pidOf,
  runAll,
  strip,
  ts,
} from './wavefrontLiveScenario'

describe('live engine: the minute loop on a scripted chain', () => {
  it('opens, reals, mems and ticks — folded by the reducer; one position per (pool, user)', async () => {
    const { sink, e } = await runAll()
    const recs = sink.records
    expect(recs.map((r) => r.seq)).toEqual(recs.map((_, i) => i + 1))
    const st = replay(recs)
    expect(st.coverage).toEqual({ walked: 5, total: 6 })
    const opens = recs.filter((r) => r.kind === 'open')
    expect(opens.map((r) => r.pid)).toEqual([pidA, pidAL, pidC, pidB, pidD, pidF])
    expect(opens.find((r) => r.pid === pidB)).toMatchObject({
      walked: false,
      line: 0.83,
      ltv0: 0.746269,
    })
    // The census's reason: not liquidatable at the block N nor the block N-1 prices.
    const reasonB = opens.find((r) => r.pid === pidB)!
    expect(reasonB.kind === 'open' && reasonB.reason).toMatch(/at both the block N-1 and the block N oracle prices/)
    expect(reasonB.kind === 'open' && reasonB.priceBasis).toBeUndefined()
    expect(recs.some((r) => r.kind === 'mem' && r.pid === pidB)).toBe(false)
    expect(opens.find((r) => r.pid === pidA)).toMatchObject({
      walked: true,
      line: 0.83,
      ltv0: 0.85,
      delayClass: 'delayed',
      cluster: 'ETH',
      collUsd: 20000,
      debtUsd: 17000,
    })
    expect(opens.find((r) => r.pid === pidA)!.priceBasis).toBe('N')
    expect(opens.find((r) => r.pid === pidAL)).toMatchObject({ walked: true, ltv0: 0.85 })
    expect(opens.find((r) => r.pid === pidC)).toMatchObject({ walked: true, line: 0.86, protocol: 'morpho-blue' })
    // A's second liquidation is a real record only.
    expect(recs.filter((r) => pidOf(r) === pidA && r.kind === 'real')).toHaveLength(2)
    expect(recs.filter((r) => pidOf(r) === pidA && r.kind === 'open')).toHaveLength(1)
    // Real side: debt_to_cover x the debt price at N; seized = liquidator share + protocol fee.
    const fee = aaveProtocolFee(44n * 10n ** 17n, 10500n, 1000n, 9)
    const feeUsd = Math.round((Number(fee) / 1e18) * 2000 * 100) / 100
    const realA = recs.find((r) => r.kind === 'real' && r.pid === pidA)!
    expect(realA).toMatchObject({ repaidUsd: 8500, protocolFeeUsd: feeUsd })
    expect(realA.kind === 'real' && realA.seizedUsd).toBeCloseTo(8800 + feeUsd, 2)
    expect(recs.find((r) => r.kind === 'real' && r.pid === pidC)).toMatchObject({
      repaidUsd: 500,
      seizedUsd: 520,
      badDebtUsd: 0,
    })
    // One tick (minute 9), equal to the fold.
    const ticks = recs.filter((r) => r.kind === 'tick')
    expect(ticks.map((t) => t.minute)).toEqual([9])
    expect(ticks[0].ts).toBe(S(10))
    expect(ticks[0].kind === 'tick' && ticks[0].coverage).toEqual({ walked: 4, total: 5 })
    expect(ticks[0].gaps).toBeUndefined()
    expect(e.state.counters.errors).toBe(0)
    expect(e.status().chains.base.markets).toHaveLength(2)
  })

  it('locates at the N-1 prices when the end-of-block price hides the breach', async () => {
    const { sink, e } = await runAll()
    const open = sink.records.find((r) => r.kind === 'open' && r.pid === pidF)!
    // N price 1,990: 16,500 / 19,900 = 0.8291 <= 0.83. N-1 price 1,960: 0.841837 > 0.83.
    expect(open).toMatchObject({ walked: true, priceBasis: 'N-1', ltv0: 0.841837, collUsd: 19600 })
    const mems = sink.records.filter((r) => r.kind === 'mem' && r.pid === pidF)
    expect(mems[0]).toMatchObject({ minute: 11, event: 'arm', ts: ts(F_N) })
    expect(e.state.counters.locatedAtNm1).toBe(1)
  })

  it('a position opening mid-minute: t0 record at its own second, then minute starts', async () => {
    const { sink } = await runAll()
    const memA = sink.records.filter((r): r is MemRecord & LiveRecord => r.kind === 'mem' && r.pid === pidA)
    expect(memA.map((r) => [r.minute, r.event, r.why ?? null])).toEqual([
      [5, 'arm', null],
      [8, 'save', null],
      [9, 'sell', 'band'],
    ])
    expect(memA[0].ts).toBe(ts(1165))
    expect(ts(1165)).toBe(S(5) + 31)
    expect(memA[1].ts).toBe(S(8))
    expect(sink.records.find((r) => r.kind === 'open' && r.pid === pidA)!.ts).toBe(S(5) + 31)
  })

  it("A's records equal a kernel fed the scripted path directly (the census's arithmetic)", async () => {
    const { sink } = await runAll()
    const k = new MembraneKernel({
      pid: pidA,
      collateral: [{ key: WETH, symbol: 'WETH', value0: 20000 }],
      debt: [{ key: USDC, symbol: 'USDC', value0: 17000 }],
      line: 0.83,
      noDelay: false,
      band: 0.04,
      delaySteps: 480,
      gap: 0.03,
      debtMinimum: 2000,
      maxSales: 20,
      t0Minute: 5,
      t0Ts: ts(1165),
      startTs: EPOCH,
      stepSeconds: 60,
      lastMinute: Number.MAX_SAFE_INTEGER,
    })
    const want: StreamRecord[] = [...k.start()]
    // The price in force at minute m's start is the last block of minute m-1.
    for (let m = 6; m < 15; m++)
      want.push(...k.step(m, (leg: KernelLeg) => (leg.key === WETH ? PATH[m - 1] / 2000 : 1)))
    const got = sink.records.filter((r) => r.kind === 'mem' && r.pid === pidA).map(strip)
    expect(got).toEqual(want.map((r) => strip(roundRecord(r) as LiveRecord)))
    // The Lido position walks the same path on its own oracle (its t0 is one block later).
    const body = (r: LiveRecord) => {
      const { pid, ts: t, ...x } = strip(r) as MemRecord
      void pid
      return { ...x, ts: x.minute === 5 ? 0 : t }
    }
    expect(sink.records.filter((r) => r.kind === 'mem' && r.pid === pidAL).map(body)).toEqual(
      want.map((r) => body(roundRecord(r) as LiveRecord)),
    )
  })

  it('steps every open position with ONE price multicall per minute', async () => {
    const { e } = await runAll()
    // Minutes 6..14 have positions walking: 9 minutes, one multicall each, holding the Core and
    // Lido getAssetsPrices and the Morpho price().
    expect(e.rt.base.prices.multicalls).toBe(9)
  })

  it('no silent carry-forward: a value missing on every backend is a gap; on one, it is re-read', async () => {
    const base = await runAll()
    const minute7Block = blockAt(S(7))
    // Every backend answers 0 for WETH at minute 7's block: A, AL and D (WETH legs) are not
    // stepped at 7; C's leg is its Morpho oracle and steps.
    const fake = new FakeChain(chainSpec())
    fake.priceFault = { groups: ['g1', 'g2', 'g3'], bad: (b, k) => b === minute7Block && k === WETH }
    const { sink, e } = await runAll(fake)
    const tick = sink.records.find((r) => r.kind === 'tick')!
    expect(tick.gaps).toMatchObject({ positionMinutes: 3, positions: 3 })
    expect(tick.gaps!.sample.map((s) => s.split('@')[0]).sort()).toEqual([pidA, pidAL, pidD].sort())
    expect(e.state.counters.gapPositionMinutes).toBe(3)
    // Minute 7 was a hold for all three, so their decisions are unchanged.
    const noTick = (rs: LiveRecord[]) => rs.filter((r) => r.kind !== 'tick').map(strip)
    expect(noTick(sink.records)).toEqual(noTick(base.sink.records))

    // Only g1 answers 0: re-read on another backend, no gap.
    const fake2 = new FakeChain(chainSpec())
    fake2.priceFault = { groups: ['g1'], bad: (b, k) => b === minute7Block && k === WETH }
    const r2 = await runAll(fake2)
    expect(r2.e.state.counters.gapPositionMinutes).toBe(0)
    expect(r2.e.state.counters.priceRetries).toBe(1)
    expect(r2.sink.records).toEqual(base.sink.records)
  })

  it('resumes after a crash with the same stream (in-process retry and a new process)', async () => {
    const base = await runAll()
    class Flaky extends MemorySink {
      failAt = 3
      async commit(r: readonly LiveRecord[], s: string) {
        if (this.commits + 1 === this.failAt) {
          this.failAt = -1
          this.failNextBetween = true
        }
        return super.commit(r, s)
      }
    }
    const flaky = new Flaky()
    const e1 = engine(new FakeChain(chainSpec()), flaky)
    await e1.init()
    await e1.run()
    expect(flaky.records).toEqual(base.sink.records)
    expect(e1.state.counters.errors).toBeGreaterThanOrEqual(1)

    const sink = new MemorySink()
    const fake = new FakeChain(chainSpec())
    const a = engine(fake, sink, { endMinute: 8 })
    expect(await a.init()).toBe('created')
    await a.run()
    expect(a.state.nextMinute).toBe(8)
    const b = engine(fake, sink, {}, new SimClock(S(8) * 1000 + 40_000))
    expect(await b.init()).toBe('resumed')
    await b.run()
    expect(sink.records).toEqual(base.sink.records)
  })

  it('a restart after downtime replays the missed minutes flagged backfilled', async () => {
    const base = await runAll()
    const fake = new FakeChain(chainSpec())
    const clock = new SimClock(S(3) * 1000)
    const head: HeadFn = async (_c, _b, nowSec) => {
      fake.spec.head = blockAt(nowSec)
      return fake.spec.head
    }
    const sink = new MemorySink()
    const live = { mode: 'live' as const, endMinute: 15 }
    const a = engine(fake, sink, live, clock, head)
    await a.init()
    await a.run(() => a.state.nextMinute >= 8)
    const before = sink.records.length
    expect(sink.records.every((r) => !r.backfilled)).toBe(true)
    await clock.sleep(10 * 60_000) // ten minutes down
    const b = engine(fake, sink, live, clock, head)
    expect(await b.init()).toBe('resumed')
    await b.run()
    const after = sink.records.slice(before)
    expect(after.length).toBeGreaterThan(0)
    expect(after.every((r) => r.backfilled === true)).toBe(true)
    expect(b.state.counters.backfilledMinutes).toBe(7)
    expect(sink.records.map(strip)).toEqual(base.sink.records.map(strip))
  })

  it('never reads logs past head − confirmations; a log in an unconfirmed block that vanishes is never emitted', async () => {
    const fake = new FakeChain(chainSpec())
    // The poll for minute 8 runs at about S(9) + 31 s: head 1,285, confirmed to 1,270.
    const ghost = aaveLog('base', { block: 1280, logIndex: 9, collateral: WETH, debt: USDC, user: D, debtToCover: 1n, liquidated: 1n })
    fake.spec.logs.push(ghost)
    const clock = new SimClock(S(3) * 1000)
    let sawGhostUnconfirmed = false
    const head: HeadFn = async (_c, _b, nowSec) => {
      fake.spec.head = blockAt(nowSec)
      if (fake.spec.head >= ghost.block && fake.spec.head - 15 < ghost.block) sawGhostUnconfirmed = true
      // Reorged out before it reaches 15 confirmations.
      if (fake.spec.head >= ghost.block + 10) fake.spec.logs = fake.spec.logs.filter((l) => l !== ghost)
      return fake.spec.head
    }
    const sink = new MemorySink()
    const e = engine(fake, sink, { mode: 'live', pollSeconds: 4 }, clock, head)
    await e.init()
    await e.run()
    expect(sawGhostUnconfirmed).toBe(true)
    expect(fake.logRanges.length).toBeGreaterThan(0)
    for (const r of fake.logRanges) expect(r.to).toBeLessThanOrEqual(r.head - CHAIN_CONFIG.base.confirmations)
    expect(sink.records.some((r) => r.kind === 'real' && r.tx === ghost.tx)).toBe(false)
  })

  it('catches a false empty: the second backend has the event, the first host is quarantined', async () => {
    const base = await runAll()
    const fake = new FakeChain(chainSpec())
    // g1 answers [] for the range holding A's second liquidation (alone in its range).
    fake.logsFault = { groups: ['g1'], drop: (l) => l.block === 1277 }
    const { sink, e } = await runAll(fake)
    expect(e.rt.base.scanner.stats.falseEmpty).toBe(1)
    expect(e.rt.base.scanner.quarantineLog.map((q) => q.host)).toEqual(['g1.host'])
    expect(sink.records).toEqual(base.sink.records)
  })

  it('a short answer is caught by the second backend: the union is kept, the short host quarantined', async () => {
    const base = await runAll()
    const fake = new FakeChain(chainSpec())
    // g1 drops D's log from a NON-empty answer (B's log is in the same range).
    fake.logsFault = { groups: ['g1'], drop: (l) => l.block === 1186 }
    const { sink, e } = await runAll(fake)
    expect(e.rt.base.scanner.stats.shortAnswers).toBe(1)
    expect(e.rt.base.scanner.quarantineLog.map((q) => q.host)).toEqual(['g1.host'])
    expect(e.state.counters.lateEvents).toBe(0)
    expect(sink.records).toEqual(base.sink.records)
  })

  it('scans only up to the lower of two backends\' heads − confirmations (a lagging node is never asked past its head)', async () => {
    const base = await runAll()
    const fake = new FakeChain(chainSpec())
    fake.headLag = { g2: 40 }
    const clock = new SimClock(S(3) * 1000)
    const head: HeadFn = async (_c, blocks, nowSec) => {
      fake.spec.head = blockAt(nowSec)
      return blocks.agreedHead()
    }
    const sink = new MemorySink()
    const e = engine(fake, sink, { mode: 'live', pollSeconds: 4 }, clock, head)
    await e.init()
    await e.run()
    expect(fake.logRanges.length).toBeGreaterThan(0)
    for (const r of fake.logRanges) expect(r.to).toBeLessThanOrEqual(r.head - 40 - CHAIN_CONFIG.base.confirmations)
    expect(e.rt.base.scanner.stats.shortAnswers).toBe(0)
    const body = (rs: LiveRecord[]) => rs.filter((r) => r.kind !== 'tick').map(strip)
    expect(body(sink.records)).toEqual(body(base.sink.records))
  })

  it('a liquidation BOTH primary backends missed comes back late through the background reconciliation', async () => {
    const base = await runAll()
    const fake = new FakeChain(chainSpec())
    // g1 and g2 (the primary scan's two backends) both drop D's log; g3 has it.
    fake.logsFault = { groups: ['g1', 'g2'], drop: (l) => l.block === 1186 }
    const { sink, e } = await runAll(fake, { reconcileEveryMinutes: 5, reconcileWindowMinutes: 10 })
    expect(e.state.counters.lateEvents).toBe(1)
    expect(e.state.counters.reconcileRuns).toBe(2)
    const late = sink.records.filter((r) => r.late)
    // open, real, and D's walk caught up from t0 (6) to minute 10: arm, save, sell.
    expect(late.map((r) => r.kind)).toEqual(['open', 'real', 'mem', 'mem', 'mem'])
    // The pass started at the end of minute 9 is consumed by minute 10 (off the minute path):
    // its records are appended at the end of minute 10.
    const tick9 = sink.records.find((r) => r.kind === 'tick' && r.minute === 9)!
    expect(late.every((r) => r.ts === S(11) && r.seq > tick9.seq)).toBe(true)
    expect(late[0].eventTs).toBe(ts(1186))
    const noTs = (r: LiveRecord) => {
      const { ts: _t, ...x } = strip(r) as LiveRecord
      void _t
      return x
    }
    expect(sink.records.filter((r) => pidOf(r) === pidD).map(noTs)).toEqual(
      base.sink.records.filter((r) => pidOf(r) === pidD).map(noTs),
    )
    const others = (rs: LiveRecord[]) => rs.filter((r) => r.kind !== 'tick' && pidOf(r) !== pidD).map(strip)
    expect(others(sink.records)).toEqual(others(base.sink.records))
    replay(sink.records)
  })

  it('an empty answer no independent backend can confirm is not believed', async () => {
    const fake = new FakeChain(chainSpec())
    fake.groupList = ['g1']
    const scanner = new LogScanner(fake, CHAIN_CONFIG.base, new Blocks(fake, 'base', 2))
    await expect(scanner.scan(1001, 1100)).rejects.toThrow(UnconfirmedEmptyError)
    expect(scanner.stats.unconfirmedEmpty).toBe(1)
    // A non-empty answer is kept without a second backend (counted; the reconciliation re-checks).
    const got = await scanner.scan(1160, 1170)
    expect(got.events.map((x) => x.block)).toEqual([1165, 1170])
    // (two chunks: the unconfirmed empty above narrowed the span to MIN_CONFIRM_SPAN)
    expect(scanner.stats.unverifiedNonEmpty).toBe(2)
  })
})
