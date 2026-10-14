/**
 * Live wavefront engine — scope, dedupe, liveness and state size (the second review's items),
 * on the scripted chain of wavefrontLiveScenario.ts:
 *
 *   scope       logs are read by TOPIC from any emitter and classified: forks (their own
 *               ADDRESSES_PROVIDER), an Aave V2-like pool (none) and a non-registry instance are
 *               excluded and counted per emitter; a pool the registry lists only from mid-stream
 *               is found by the registry re-read an unknown emitter triggers; a non-registry
 *               instance comes in only when allow-listed; a Morpho signature off the singleton is
 *               excluded;
 *   dedupe      after failed reconciliation passes the next one re-scans from the last success,
 *               and every event it re-finds is recognised (no duplicate `real`, the reviewer's
 *               repro); the catch-up range is capped and the cap counted;
 *   liveness    a chain that stops answering does not hold the others: their minutes go on, its
 *               positions are flagged lagging on the tick, and its minutes are caught up as
 *               `late` records when it answers — the same records, per position, as without the
 *               outage; a reconciliation pass that hangs is CANCELLED at its budget while the
 *               minutes go on;
 *   lifecycle   a position whose oracle stays silent is closed after maxGapMinutes (with the
 *               reason); the gap positions survive a restart;
 *   state       closed positions leave the state (the stream is their archive) and a later
 *               liquidation of a closed pid still folds; the state does not grow with time.
 */
import { describe, expect, it } from 'vitest'

import { replay } from '@/lib/wavefront/stream'
import {
  AbortedError,
  Blocks,
  CHAIN_CONFIG,
  CountingRpc,
  LiveEngine,
  LogScanner,
  MemorySink,
  SimClock,
  allowedAaveProviders,
  clockHead,
  type CallOpts,
  type ChainKey,
  type EngineOptions,
  type HeadFn,
  type LiveRecord,
  type LiveRpc,
  type RpcAnswer,
} from '@/lib/wavefront/live'
import { FakeChain, aaveLog, morphoLog, type FakeChainSpec } from './wavefrontLiveFake'
import {
  A,
  B,
  D,
  E18,
  EPOCH,
  LIDO,
  OPTS,
  S,
  USDC,
  WETH,
  blockAt,
  chainSpec,
  engine,
  pidA,
  pidAL,
  pidB,
  pidD,
  pidOf,
  reserves,
  runAll,
  strip,
  ts,
} from './wavefrontLiveScenario'

const SPARK = '0x000000000000000000000000000000000000a5a5'
const SPARK_PROVIDER = '0x000000000000000000000000000000000000a5a6'
const V2POOL = '0x000000000000000000000000000000000000b2b2'
const HZ = {
  provider: '0x00000000000000000000000000000000000002a1',
  pool: '0x00000000000000000000000000000000000002b1',
  oracle: '0x00000000000000000000000000000000000002c1',
  dataProvider: '0x00000000000000000000000000000000000002d1',
}
const NEW = {
  provider: '0x00000000000000000000000000000000000003a1',
  pool: '0x00000000000000000000000000000000000003b1',
  oracle: '0x00000000000000000000000000000000000003c1',
  dataProvider: '0x00000000000000000000000000000000000003d1',
}
const H = '0x00000000000000000000000000000000000000ee'
const user = (address: string, debt: bigint) => ({
  address,
  eMode: 0,
  collateral: { [WETH]: 10n * E18 },
  debt: { [USDC]: debt },
})
const liq = (block: number, x: { pool?: string; user: string; logIndex?: number }) =>
  aaveLog('base', {
    block,
    logIndex: x.logIndex ?? 1,
    pool: x.pool,
    collateral: WETH,
    debt: USDC,
    user: x.user,
    debtToCover: 8_500_000000n,
    liquidated: 44n * 10n ** 17n,
  })

describe('live engine: scope by topic and emitter classification', () => {
  function scopeSpec(): FakeChainSpec {
    const s = chainSpec()
    s.forks = [
      { pool: SPARK, provider: SPARK_PROVIDER },
      { pool: V2POOL, provider: null },
    ]
    s.outsideRegistry = [{ ...HZ, marketId: 'Fake Horizon', reserves: reserves(), users: [user(H, 17_000_000000n)] }]
    s.extraAave!.push({
      ...NEW,
      marketId: 'Fake New Market',
      reserves: reserves(),
      users: [user(A, 17_000_000000n)],
      registryFrom: blockAt(S(6)),
    })
    const offMorpho = morphoLog('base', {
      block: blockAt(S(8)) + 3,
      logIndex: 2,
      marketId: '0x' + '22'.repeat(32),
      borrower: H,
      repaidAssets: 1n,
      seizedAssets: 1n,
    })
    offMorpho.address = '0x000000000000000000000000000000000000c4c4'
    s.logs.push(
      liq(blockAt(S(7)) + 5, { pool: SPARK, user: D }),
      liq(blockAt(S(8)) + 5, { pool: V2POOL, user: D }),
      liq(blockAt(S(7)) + 7, { pool: HZ.pool, user: H }),
      liq(blockAt(S(8)) + 9, { pool: NEW.pool, user: A }),
      offMorpho,
    )
    return s
  }
  const pidNew = `aave-v3:base:${NEW.pool}:${A}`
  const pidHz = `aave-v3:base:${HZ.pool}:${H}`

  it('excludes forks, a pool without ADDRESSES_PROVIDER and a non-registry instance; finds a pool the registry added mid-stream', async () => {
    const base = await runAll()
    const { sink, e } = await runAll(new FakeChain(scopeSpec()))
    const cs = e.state.chains.base!
    expect(Object.keys(cs.excluded).sort()).toEqual([SPARK, V2POOL, HZ.pool, '0x000000000000000000000000000000000000c4c4'].sort())
    expect(cs.excluded[SPARK].reason).toMatch(/not in the registry \(an Aave V3 fork\)/)
    expect(cs.excluded[SPARK].provider).toBe(SPARK_PROVIDER)
    expect(cs.excluded[V2POOL].reason).toMatch(/no ADDRESSES_PROVIDER/)
    expect(cs.excluded[HZ.pool].provider).toBe(HZ.provider)
    expect(e.rt.base.scanner.stats.excludedByEmitter).toEqual({
      [SPARK]: 1,
      [V2POOL]: 1,
      [HZ.pool]: 1,
      '0x000000000000000000000000000000000000c4c4': 1,
    })
    expect(e.rt.base.scanner.stats.excludedLogs).toBe(4)
    // The registry's new market: found through the re-read an unknown emitter triggers.
    const opens = sink.records.filter((r) => r.kind === 'open')
    expect(opens.map((r) => r.pid)).toContain(pidNew)
    expect(opens.map((r) => r.pid)).not.toContain(pidHz)
    expect(e.rt.base.aave.has(NEW.pool)).toBe(true)
    // Everything else is the base stream.
    const rest = (rs: LiveRecord[]) => rs.filter((r) => r.kind !== 'tick' && pidOf(r) !== pidNew).map(strip)
    expect(rest(sink.records)).toEqual(rest(base.sink.records))
    replay(sink.records)
  })

  it('brings a non-registry instance in only when allow-listed', async () => {
    const { sink, e } = await runAll(new FakeChain(scopeSpec()), { allowAaveProviders: [HZ.provider] })
    expect(sink.records.filter((r) => r.kind === 'open').map((r) => r.pid)).toContain(pidHz)
    expect(e.state.chains.base!.excluded[HZ.pool]).toBeUndefined()
    expect(Object.keys(e.state.chains.base!.excluded)).toContain(SPARK)
    expect(e.status().chains.base.markets).toHaveLength(4)
  })

  it('names Horizon (mainnet, OFF by default) for --allow-aave-provider', () => {
    expect(allowedAaveProviders('mainnet', ['horizon'])).toEqual(['0x5d39e06b825c1f2b80bf2756a73e28efaa128ba0'])
    expect(allowedAaveProviders('base', ['horizon'])).toEqual([])
    expect(() => allowedAaveProviders('mainnet', ['nope'])).toThrow(/not an address or a known label/)
  })
})

describe('live engine: reconciliation dedupe after failed passes (the reviewer repro)', () => {
  // Three liquidations around minute 72; passes every 60 minutes over a 120-minute window.
  const spec = (): FakeChainSpec => ({
    ...chainSpec(),
    head: 1000 + 30 * 320,
    extraAave: [],
    markets: [],
    morphoPositions: [],
    users: [user(A, 17_000_000000n), user(B, 15_000_000000n), user(D, 17_200_000000n)],
    logs: [
      liq(3165, { user: A, logIndex: 3 }),
      aaveLog('base', { block: 3185, logIndex: 2, collateral: WETH, debt: USDC, user: B, debtToCover: 7_500_000000n, liquidated: 39n * 10n ** 17n }),
      aaveLog('base', { block: 3186, logIndex: 4, collateral: WETH, debt: USDC, user: D, debtToCover: 8_600_000000n, liquidated: 45n * 10n ** 17n }),
    ],
  })
  async function run(failPasses: number[], opts: Partial<EngineOptions> = {}) {
    const fake = new FakeChain(spec())
    const sink = new MemorySink()
    const e = engine(fake, sink, { endMinute: 305, reconcileEveryMinutes: 60, reconcileWindowMinutes: 120, ...opts })
    await e.init()
    // The independent backends fail the passes started at these minutes (rate-limiting).
    const scanner = e.rt.base.scanner
    const real = scanner.reconcile.bind(scanner)
    let n = 0
    scanner.reconcile = async (...a: Parameters<LogScanner['reconcile']>) => {
      n++
      if (failPasses.includes(n)) throw new Error('request limit reached')
      return real(...a)
    }
    await e.run()
    const reals = sink.records.filter((r) => r.kind === 'real')
    return { e, sink, reals: reals.map((r) => `${r.kind === 'real' && r.tx}:${r.kind === 'real' && r.logIndex}`), st: replay(sink.records) }
  }

  it('re-finds every processed event after three failed passes: no duplicate real', async () => {
    const clean = await run([])
    const flaky = await run([2, 3, 4])
    expect(flaky.e.state.counters.reconcileFailures).toBe(3)
    expect(flaky.e.state.counters.reconcileRuns).toBe(2)
    expect(flaky.e.state.counters.lateEvents).toBe(0)
    expect(flaky.reals).toEqual(clean.reals)
    expect(new Set(flaky.reals).size).toBe(3)
    expect(flaky.st.totals.real.repaidUsd).toBe(clean.st.totals.real.repaidUsd)
    // All three real records, once each ($49,200 when the pruned keys were re-found) …
    const repaid = (rs: LiveRecord[]) => rs.reduce((a, r) => a + (r.kind === 'real' ? (r.repaidUsd ?? 0) : 0), 0)
    expect(repaid(flaky.sink.records)).toBe(24_600)
    // … and the schema-v2 totals: real over WALKED positions (B, not located, is out).
    expect(flaky.st.totals.real.repaidUsd).toBe(17_100)
    // The last pass reached back to the last success (minute 59): 240 minutes, past the window.
    expect(flaky.e.state.chains.base!.reconciledTo).toBeGreaterThan(blockAt(S(299)))
  })

  it('caps the catch-up range (counted) and still never duplicates', async () => {
    const flaky = await run([2, 3, 4], { reconcileMaxCatchupMinutes: 150 })
    expect(flaky.e.state.counters.reconcileCapped).toBe(1)
    expect(new Set(flaky.reals).size).toBe(3)
    expect(flaky.reals).toHaveLength(3)
  })
})

/** Two scripted chains behind one RpcPool-like seam; a chain can be taken down. */
class Router implements LiveRpc {
  down = new Set<ChainKey>()
  constructor(readonly by: Partial<Record<ChainKey, FakeChain>>) {}
  async request(chain: ChainKey, method: string, params: unknown[], opts?: CallOpts): Promise<RpcAnswer> {
    if (this.down.has(chain)) throw new Error(`${chain}: fetch failed`)
    return this.by[chain]!.request(chain, method, params, opts)
  }
  groups(chain: ChainKey) {
    return this.by[chain]!.groups()
  }
}

describe('live engine: chains are independent', () => {
  const E = '0x00000000000000000000000000000000000000e1'
  function opSpec(): FakeChainSpec {
    return {
      chain: 'optimism',
      ts,
      head: 1000 + 30 * 40,
      reserves: reserves(),
      tokens: {},
      users: [user(E, 17_000_000000n)],
      markets: [],
      morphoPositions: [],
      logs: [
        aaveLog('optimism', { block: blockAt(S(7)) + 4, logIndex: 1, collateral: WETH, debt: USDC, user: E, debtToCover: 8_500_000000n, liquidated: 44n * 10n ** 17n }),
      ],
    }
  }
  async function run(outage: [number, number] | null) {
    const fakes = { base: new FakeChain(chainSpec()), optimism: new FakeChain(opSpec()) }
    const rpc = new Router(fakes)
    const clock = new SimClock(S(3) * 1000)
    const head: HeadFn = async (c, _b, nowSec) => {
      const f = fakes[c as 'base' | 'optimism']
      f.spec.head = blockAt(nowSec)
      if (outage && nowSec >= outage[0] && nowSec < outage[1]) rpc.down.add('optimism')
      else rpc.down.delete('optimism')
      if (rpc.down.has(c)) throw new Error(`${c}: fetch failed`)
      return f.spec.head
    }
    const sink = new MemorySink()
    const e = new LiveEngine(
      // Backoff advances the simulated clock (the outage is in simulated time).
      { rpc, clock, sink, head, backoff: (ms) => clock.sleep(ms) },
      { ...OPTS, chains: ['base', 'optimism'], mode: 'live', pollSeconds: 4, chainStallSeconds: 60, endMinute: 16 },
    )
    await e.init()
    await e.run()
    return { e, sink }
  }

  it('a chain down for minutes 6-10 does not hold the other; it is caught up late, the same records per position', async () => {
    const clean = await run(null)
    // Optimism answers nothing from S(6)+40 to S(11)+40 (simulated time).
    const out = await run([S(6) + 40, S(11) + 40])
    const lagged = out.e.minuteLog.filter((x) => x.lagging?.includes('optimism'))
    expect(lagged.length).toBeGreaterThanOrEqual(3)
    expect(out.e.state.counters.laggingChainMinutes).toBeGreaterThanOrEqual(3)
    expect(out.e.state.counters.catchupMinutes).toBeGreaterThanOrEqual(3)
    // Base's minutes went on during the outage (processed in their own minute, not late).
    const baseLate = out.sink.records.filter((r) => r.late && pidOf(r)?.includes(':base:'))
    expect(baseLate).toHaveLength(0)
    // The tick of minute 9 says optimism was lagging.
    const tick9 = out.sink.records.find((r) => r.kind === 'tick' && r.minute === 9)!
    expect(tick9.gaps?.lagging?.chains).toEqual(['optimism'])
    // Optimism's liquidation (minute 7) came in late, with its own time.
    const pidE = `aave-v3:optimism:${CHAIN_CONFIG.optimism.aavePool}:${E}`
    const eOpen = out.sink.records.find((r) => r.kind === 'open' && r.pid === pidE)!
    expect(eOpen.late).toBe(true)
    expect(eOpen.eventTs).toBe(ts(blockAt(S(7)) + 4))
    // Per position, the same records as without the outage.
    const per = (rs: LiveRecord[]) => {
      const m = new Map<string, unknown[]>()
      for (const r of rs) {
        if (r.kind === 'tick') continue
        const { ts: t, eventTs, backfilled, late, seq, ...x } = r as LiveRecord
        void backfilled
        void late
        void seq
        m.set(r.pid, [...(m.get(r.pid) ?? []), { ...x, ts: eventTs ?? t }])
      }
      return m
    }
    expect(per(out.sink.records)).toEqual(per(clean.sink.records))
    replay(out.sink.records)
  })
})

describe('live engine: reconciliation is off the minute path and cancelled at its budget', () => {
  it('a hanging pass does not hold the minutes and is cancelled', async () => {
    class Hanging extends FakeChain {
      async request(chain: ChainKey, method: string, params: unknown[], opts?: CallOpts) {
        // The reconciliation's backend (g3, outside the primary pair) never answers logs.
        const ex = new Set(opts?.excludeGroups ?? [])
        if (method === 'eth_getLogs' && ex.has('g1') && ex.has('g2')) return new Promise<RpcAnswer>(() => {})
        return super.request(chain, method, params, opts)
      }
    }
    const fake = new Hanging(chainSpec())
    const rpc = new CountingRpc(fake, 60_000)
    const sink = new MemorySink()
    const e = new LiveEngine(
      { rpc, clock: new SimClock(S(3) * 1000), sink, head: clockHead(), backoff: async () => {} },
      { ...OPTS, reconcileEveryMinutes: 2, reconcileWindowMinutes: 4, reconcileBudgetSeconds: 0.3, awaitReconciliation: false },
    )
    await e.init()
    const t0 = Date.now()
    await e.run()
    // All minutes processed while the pass hung.
    expect(e.state.nextMinute).toBe(15)
    expect(Date.now() - t0).toBeLessThan(5_000)
    await e.settle()
    // Cancelled: the waiting request was released by the signal (not by the 60 s timeout).
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(rpc.inflight.size).toBe(0)
    // Consumed by the next minute: counted as a failed pass, retried next time.
    e.opts.endMinute = 16
    await e.run()
    expect(e.state.counters.reconcileFailures).toBeGreaterThanOrEqual(1)
    expect(e.state.counters.reconcileRuns).toBe(0)
  })

  it('the scanner stops a pass at once when its signal aborts', async () => {
    const fake = new FakeChain(chainSpec())
    const ctrl = new AbortController()
    const scanner = new LogScanner(new CountingRpc(fake), CHAIN_CONFIG.base, new Blocks(fake, 'base', 2))
    ctrl.abort()
    await expect(scanner.reconcile(1001, 1100, [], ctrl.signal)).rejects.toThrow(AbortedError)
  })
})

describe('live engine: the Aave protocol fee is the receipt\'s treasury transfer (the census\'s source)', () => {
  it('uses the transfer when it differs from the arithmetic, the arithmetic when there is none', async () => {
    const base = await runAll()
    const fake = new FakeChain(chainSpec())
    const txA = fake.spec.logs.find((l) => l.block === 1165)!.tx.toLowerCase()
    fake.feeDelta[txA] = -(10n ** 15n) // 0.001 WETH less than the arithmetic ($2 at $2,000)
    const { sink, e } = await runAll(fake)
    const realOf = (rs: LiveRecord[]) => rs.find((r) => r.kind === 'real' && r.tx === txA)!
    const a = realOf(base.sink.records)
    const b = realOf(sink.records)
    expect(b.kind === 'real' && b.seizedUsd).toBeCloseTo((a.kind === 'real' ? a.seizedUsd! : 0) - 2, 2)
    expect(b.protocolFeeUsd).toBeCloseTo(a.protocolFeeUsd! - 2, 2)
    expect(e.state.counters.feeScaledRounding).toBe(1)
    expect(e.state.counters.feeFromReceipt).toBe(e.state.counters.eventsByChain.base - 1) // all Aave events
    expect(e.state.counters.feeFromArithmetic).toBe(0)
  })
})

describe('live engine: lifecycle and state', () => {
  it('a position whose oracle stays silent is closed after maxGapMinutes, with the reason', async () => {
    const fake = new FakeChain(chainSpec())
    // At the minute starts 7, 8 and 9 every backend answers 0 for WETH: A, AL and D (WETH legs,
    // all with an armed timer) are not stepped three minutes in a row.
    const minuteStart = (b: number) => (b - 999) % 30 === 0
    fake.priceFault = {
      groups: ['g1', 'g2', 'g3'],
      bad: (b, k) => k === WETH && minuteStart(b) && b >= blockAt(S(7)) && b <= blockAt(S(9)),
    }
    const { sink, e } = await runAll(fake, { maxGapMinutes: 3 })
    expect(e.state.counters.gapClosed).toBe(3)
    const closed = e.state.pendingGaps.closed!
    expect(closed.map((x) => x.pid).sort()).toEqual([pidA, pidAL, pidD].sort())
    expect(closed.find((x) => x.pid === pidA)!.reason).toMatch(/oracle silent 3 minutes in a row \(an armed timer abandoned\)/)
    // Closed: not stepped (no gap counted) after.
    const tick9 = sink.records.find((r) => r.kind === 'tick' && r.minute === 9)!
    expect(tick9.gaps!.positions).toBe(3)
    expect(e.status().openPositions).toBeLessThan(3)
  })

  it('a minute that fails every time ends a historical run instead of retrying forever', async () => {
    class Broken extends MemorySink {
      async commit(): Promise<void> {
        throw new Error('disk full')
      }
    }
    const e = engine(new FakeChain(chainSpec()), new Broken(), { maxMinuteFailures: 4 })
    await e.init()
    await expect(e.run()).rejects.toThrow(/minute 3 failed 4 times in a row: disk full/)
    // Live, the default is to keep retrying (with backoff): the stream waits.
    expect(new LiveEngine({ rpc: new FakeChain(chainSpec()), clock: new SimClock(0), sink: new MemorySink(), head: clockHead() }, { ...OPTS, mode: 'live' }).opts.maxMinuteFailures).toBe(Infinity)
  })

  it('the gap positions survive a restart', async () => {
    const mk = () => {
      const f = new FakeChain(chainSpec())
      f.priceFault = { groups: ['g1', 'g2', 'g3'], bad: (b, k) => b === blockAt(S(7)) && k === WETH }
      return f
    }
    const one = await runAll(mk())
    const sink = new MemorySink()
    const a = engine(mk(), sink, { endMinute: 8 })
    await a.init()
    await a.run()
    const b = engine(mk(), sink, {}, new SimClock(S(8) * 1000 + 40_000))
    expect(await b.init()).toBe('resumed')
    await b.run()
    expect(sink.records).toEqual(one.sink.records)
    expect(sink.records.find((r) => r.kind === 'tick')!.gaps).toMatchObject({ positionMinutes: 3, positions: 3 })
  })

  it('closed positions leave the state; a later liquidation of a closed pid folds, also after a restart', async () => {
    const spec = () => {
      const s = chainSpec()
      // B (walked: false, closed at once) is liquidated again at minute 12.
      s.logs.push(
        aaveLog('base', { block: blockAt(S(12)) + 3, logIndex: 1, collateral: WETH, debt: USDC, user: B, debtToCover: 1_000_000000n, liquidated: 5n * 10n ** 17n }),
      )
      return s
    }
    const one = await runAll(new FakeChain(spec()))
    const st = JSON.parse(one.sink.state!)
    const kept = (st.replay.positions as [string, unknown][]).map(([p]) => p)
    expect(kept.sort()).toEqual((st.positions as { pid: string }[]).map((p) => p.pid).sort())
    expect(kept).not.toContain(pidB)
    expect(st.replay.order).toEqual([])
    expect(one.sink.records.filter((r) => r.kind === 'real' && r.pid === pidB)).toHaveLength(2)
    expect(one.sink.records.filter((r) => r.kind === 'open' && r.pid === pidB)).toHaveLength(1)
    // The engine's fold (with closed positions rebuilt from the index) = a fold from scratch.
    const fresh = replay(one.sink.records)
    expect(one.e.status().totals).toEqual(fresh.totals)
    expect(one.e.status().coverage).toEqual(fresh.coverage)
    // Resume at minute 10 (B closed, in the stream only): the same stream.
    const sink = new MemorySink()
    const a = engine(new FakeChain(spec()), sink, { endMinute: 10 })
    await a.init()
    await a.run()
    const b = engine(new FakeChain(spec()), sink, {}, new SimClock(S(10) * 1000 + 40_000))
    await b.init()
    await b.run()
    expect(sink.records).toEqual(one.sink.records)
  })

  it('the state does not grow with time (only with the positions walking)', async () => {
    const sizes: number[] = []
    class Measure extends MemorySink {
      async commit(r: readonly LiveRecord[], s: string) {
        sizes.push(s.length)
        return super.commit(r, s)
      }
    }
    const fake = new FakeChain({ ...chainSpec(), head: 1000 + 30 * 330 })
    const sink = new Measure()
    const e = engine(fake, sink, { endMinute: 320, reconcileEveryMinutes: 60, reconcileWindowMinutes: 120 })
    await e.init()
    await e.run()
    // Minute 15 onwards the same positions walk (the horizon is 7 days): the state stays flat —
    // it even shrinks once the processed keys leave the reconciliation's reach.
    const at = (m: number) => sizes[m - 3]
    expect(at(319)).toBeLessThanOrEqual(at(30) * 1.005)
    expect(at(319)).toBeGreaterThan(at(30) * 0.9)
    expect(e.state.chains.base!.seen).toEqual([])
    expect(e.state.chains.base!.chunks.length).toBeLessThanOrEqual(3)
  })
})

void pidAL
void LIDO
void EPOCH
