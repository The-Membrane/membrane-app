/**
 * THE WAVEFRONT STREAM — record schema v1.
 *
 * One append-only stream carries both sides of the Real-vs-Membrane comparison for every
 * position the window touches: when the position appeared (`open`), every real liquidation
 * the protocol ran on it (`real`), every decision Membrane's engine would have made
 * (`mem`), and a running summary every 10 minutes (`tick`). The Oct 10-11 census writes it
 * for the recorded window (scripts/oct10-coverage/build-census.ts); the live engine appends
 * the same records as blocks arrive. The UI and the tests read it through `applyRecord` —
 * the ONE reducer — so a total on screen and a total in a test are the same fold.
 *
 * ---------------------------------------------------------------------------
 * RECORDS (every record has `kind` and `seq`; seq is 1, 2, 3, … in stream order)
 * ---------------------------------------------------------------------------
 *   open  pid, protocol, chain, block, ts       when the position entered the stream (its
 *                                               first liquidation event)
 *         legs [{symbol, usd}], debtLegs        collateral and debt at the walk anchor
 *         debtUsd, collUsd, line, ltv0          (t0), valued at block-N oracle prices
 *         delayClass  'no-delay'|'delayed'|'mixed'   (collateralClass.ts delayClassOf)
 *         cluster     primary collateral group (lib/wavefront/cluster.ts)
 *         walked      true when Membrane's engine walks it; false → `reason` says why
 *         t0 {block, ts, minute}                the walk anchor (walked only). Equal to
 *                                               block/ts unless the first event was not
 *                                               located and a later one was.
 *         subs [{sub, delayClass, line, share, collUsd, debtUsd}]   a MIXED position is
 *                                               walked as two positions (sub 0 = no-delay
 *                                               legs, sub 1 = delayed legs)
 *   real  pid, ts, block, tx, logIndex          one protocol liquidation
 *         repaidUsd, seizedUsd                  USD at that block's oracle prices; null when
 *                                               the token has no USD price (counted)
 *         badDebtUsd?                           Morpho realised bad debt, NOT in repaidUsd:
 *                                               present on every Morpho record (null when
 *                                               unpriced), absent on Aave
 *   mem   pid, sub?, ts, minute                 one Membrane decision (lib/wavefront/kernel.ts)
 *         event 'arm' | 'save' | 'sell' | 'sell-instant'
 *         why?  'band' | 'expiry' | 'grid-end' | 'no-series'   (sells only; 'instant' for
 *                                               sell-instant)
 *         repaidUsd, soldUsd                    USD at that minute's prices (0 for arm/save;
 *                                               null when the unit has no USD price)
 *         ltv                                   the LTV the decision was taken on
 *   tick  ts, minute                            summary of every record before it
 *         coverage {walked, total}              positions opened so far: walked / all
 *         totals.real {positions, repaidUsd, soldUsd, badDebtUsd, unpricedEvents}
 *         totals.mem  {positionsSold, positionsArmed, positionsKept, repaidUsd, soldUsd,
 *                      unpricedSales}
 *
 * pid = `aave-v3:<chain>:<user>` or `morpho-blue:<chain>:<marketId>:<borrower>` (lower case).
 *
 * ORDER. Records are sorted by ts; at equal ts a tick comes first, then open, real, mem; then
 * by position and by the order the position emitted them. A tick at minute m has
 * ts = startTs + 60·(m+1) — the END of minute m — and summarises every record with a smaller
 * ts, i.e. every record before it. Ticks fall on m = 9, 19, …, 2879. A mem record's ts is
 * t0's own second at the t0 minute and the minute START after that (`memTs`), when that
 * minute's in-force oracle price applies.
 *
 * STATE PARTITION. Every walked position that has been opened is in exactly one state:
 *   sold   at least one Membrane sale so far (either half of a split counts),
 *   armed  never sold, and a delay timer is running on it now,
 *   kept   never sold, no timer running.
 * So positionsSold + positionsArmed + positionsKept == coverage.walked at every tick. The
 * census sells every timer still running when the grid ends (the conservative grid-end
 * sale), so the final tick has positionsArmed == 0.
 *
 * ---------------------------------------------------------------------------
 * FILES
 * ---------------------------------------------------------------------------
 * JSONL (canonical, `encodeJsonl` / `decodeJsonl`): line 1 is a header
 * `{"kind":"header","format":"wavefront-stream","schema":1,"window":{…}}`, then one record per
 * line in seq order. USD amounts are rounded to cents and LTVs / lines to 1e-6 when the record
 * is made (`roundRecord`), so every consumer sums the same numbers.
 *
 * COMPACT (served to the app, `encodeCompact` / `decodeCompact`): the same records as
 * column arrays — see `CompactReplay` below. `decodeCompact(encodeCompact(records))` returns
 * the records exactly (tests/unit/wavefrontStream.test.ts). Strings that repeat (chain,
 * symbol, cluster, reason, market id) are dictionary indices; `order` is one character per
 * record in seq order ('o' open, 'r' real, 'm' mem, 't' tick) and the k-th character's record
 * is the next unread row of that table; seq = k + 1; a mem record's ts is rebuilt from its
 * position's t0 with `memTs`; pid is rebuilt from protocol, chain, market and address.
 */

export const STREAM_FORMAT = 'wavefront-stream'
export const STREAM_SCHEMA = 1
export const COMPACT_FORMAT = 'wavefront-replay-compact'
export const TICK_EVERY_MINUTES = 10

export type Protocol = 'aave-v3' | 'morpho-blue'
export type DelayClass = 'no-delay' | 'delayed' | 'mixed'
export type MemEvent = 'arm' | 'save' | 'sell' | 'sell-instant'
export type SaleWhy = 'band' | 'expiry' | 'instant' | 'grid-end' | 'no-series'

export interface StreamWindow {
  startTs: number
  stepSeconds: number
  minutes: number
}

export interface StreamLeg {
  symbol: string
  usd: number | null
}

export interface SubSpec {
  sub: number
  delayClass: 'no-delay' | 'delayed'
  line: number
  /** Share of the position's collateral (and so of its debt) at t0. */
  share: number
  collUsd: number | null
  debtUsd: number | null
}

export interface OpenRecord {
  kind: 'open'
  seq: number
  pid: string
  protocol: Protocol
  chain: string
  block: number
  ts: number
  legs: StreamLeg[]
  debtLegs: StreamLeg[]
  debtUsd: number | null
  collUsd: number | null
  line: number | null
  ltv0: number | null
  delayClass: DelayClass
  cluster: string
  walked: boolean
  reason?: string
  t0?: { block: number; ts: number; minute: number }
  subs?: SubSpec[]
}

export interface RealRecord {
  kind: 'real'
  seq: number
  pid: string
  ts: number
  block: number
  tx: string
  logIndex: number
  repaidUsd: number | null
  seizedUsd: number | null
  badDebtUsd?: number | null
}

export interface MemRecord {
  kind: 'mem'
  seq: number
  pid: string
  sub?: number
  ts: number
  minute: number
  event: MemEvent
  why?: SaleWhy
  repaidUsd: number | null
  soldUsd: number | null
  /** The LTV the decision was taken on; null when no collateral is left (infinite). */
  ltv: number | null
}

export interface Totals {
  real: {
    positions: number
    repaidUsd: number
    soldUsd: number
    badDebtUsd: number
    unpricedEvents: number
  }
  mem: {
    positionsSold: number
    positionsArmed: number
    positionsKept: number
    repaidUsd: number
    soldUsd: number
    unpricedSales: number
  }
}

export interface TickRecord {
  kind: 'tick'
  seq: number
  ts: number
  minute: number
  coverage: { walked: number; total: number }
  totals: Totals
}

export type StreamRecord = OpenRecord | RealRecord | MemRecord | TickRecord

export interface StreamHeader {
  kind: 'header'
  format: typeof STREAM_FORMAT
  schema: typeof STREAM_SCHEMA
  window: StreamWindow
}

// ------------------------------------------------------------------ helpers

/** Cents. Applied once, when a record is made. */
export const roundUsd = (x: number | null | undefined): number | null =>
  x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100
/** LTVs, lines and shares: 1e-6. Infinity (no collateral left) is kept as null. */
export const roundRatio = (x: number | null | undefined): number | null =>
  x == null || !Number.isFinite(x) ? null : Math.round(x * 1e6) / 1e6

/** Timestamp of a mem record: t0's own second at the t0 minute, else the minute START. */
export function memTs(
  minute: number,
  t0Minute: number,
  t0Ts: number,
  startTs: number,
  stepSeconds: number,
): number {
  return minute === t0Minute ? t0Ts : Math.max(t0Ts, startTs + stepSeconds * minute)
}

/** The tick closing minute m. */
export const tickTs = (w: StreamWindow, minute: number) => w.startTs + w.stepSeconds * (minute + 1)
export const isTickMinute = (minute: number) => (minute + 1) % TICK_EVERY_MINUTES === 0

/** Rank at equal ts. */
export const KIND_RANK: Record<StreamRecord['kind'], number> = { tick: 0, open: 1, real: 2, mem: 3 }

/** A record with its amounts rounded the way the stream stores them. */
export function roundRecord<T extends StreamRecord>(r: T): T {
  switch (r.kind) {
    case 'open':
      return {
        ...r,
        legs: r.legs.map((l) => ({ symbol: l.symbol, usd: roundUsd(l.usd) })),
        debtLegs: r.debtLegs.map((l) => ({ symbol: l.symbol, usd: roundUsd(l.usd) })),
        debtUsd: roundUsd(r.debtUsd),
        collUsd: roundUsd(r.collUsd),
        line: roundRatio(r.line),
        ltv0: roundRatio(r.ltv0),
        ...(r.subs
          ? {
              subs: r.subs.map((s) => ({
                ...s,
                line: roundRatio(s.line)!,
                share: roundRatio(s.share)!,
                collUsd: roundUsd(s.collUsd),
                debtUsd: roundUsd(s.debtUsd),
              })),
            }
          : {}),
      }
    case 'real':
      return {
        ...r,
        repaidUsd: roundUsd(r.repaidUsd),
        seizedUsd: roundUsd(r.seizedUsd),
        ...(r.badDebtUsd !== undefined ? { badDebtUsd: roundUsd(r.badDebtUsd) } : {}),
      }
    case 'mem':
      return {
        ...r,
        repaidUsd: roundUsd(r.repaidUsd),
        soldUsd: roundUsd(r.soldUsd),
        ltv: roundRatio(r.ltv),
      }
    case 'tick':
      return { ...r, totals: roundTotals(r.totals) }
  }
}

export function emptyTotals(): Totals {
  return {
    real: { positions: 0, repaidUsd: 0, soldUsd: 0, badDebtUsd: 0, unpricedEvents: 0 },
    mem: {
      positionsSold: 0,
      positionsArmed: 0,
      positionsKept: 0,
      repaidUsd: 0,
      soldUsd: 0,
      unpricedSales: 0,
    },
  }
}

export function roundTotals(t: Totals): Totals {
  return {
    real: {
      ...t.real,
      repaidUsd: roundUsd(t.real.repaidUsd)!,
      soldUsd: roundUsd(t.real.soldUsd)!,
      badDebtUsd: roundUsd(t.real.badDebtUsd)!,
    },
    mem: {
      ...t.mem,
      repaidUsd: roundUsd(t.mem.repaidUsd)!,
      soldUsd: roundUsd(t.mem.soldUsd)!,
    },
  }
}

/** Equal counts, and dollars within `tolUsd` (sums are folded in a different order). */
export function totalsClose(a: Totals, b: Totals, tolUsd = 0.011): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) <= tolUsd
  return (
    a.real.positions === b.real.positions &&
    a.real.unpricedEvents === b.real.unpricedEvents &&
    near(a.real.repaidUsd, b.real.repaidUsd) &&
    near(a.real.soldUsd, b.real.soldUsd) &&
    near(a.real.badDebtUsd, b.real.badDebtUsd) &&
    a.mem.positionsSold === b.mem.positionsSold &&
    a.mem.positionsArmed === b.mem.positionsArmed &&
    a.mem.positionsKept === b.mem.positionsKept &&
    a.mem.unpricedSales === b.mem.unpricedSales &&
    near(a.mem.repaidUsd, b.mem.repaidUsd) &&
    near(a.mem.soldUsd, b.mem.soldUsd)
  )
}

// ------------------------------------------------------------------ JSONL

export function encodeJsonl(window: StreamWindow, records: readonly StreamRecord[]): string {
  const header: StreamHeader = {
    kind: 'header',
    format: STREAM_FORMAT,
    schema: STREAM_SCHEMA,
    window,
  }
  const lines = [JSON.stringify(header)]
  for (const r of records) lines.push(JSON.stringify(r))
  return lines.join('\n') + '\n'
}

export function decodeJsonl(text: string): { header: StreamHeader; records: StreamRecord[] } {
  const lines = text.split('\n').filter((l) => l.length > 0)
  if (!lines.length) throw new Error('wavefront stream: empty')
  const header = JSON.parse(lines[0]) as StreamHeader
  if (header.kind !== 'header' || header.format !== STREAM_FORMAT) {
    throw new Error('wavefront stream: missing header line')
  }
  if (header.schema !== STREAM_SCHEMA) {
    throw new Error(`wavefront stream: schema ${header.schema}, this reader is ${STREAM_SCHEMA}`)
  }
  const records = lines.slice(1).map((l) => JSON.parse(l) as StreamRecord)
  for (const r of records) {
    if (!(r.kind in KIND_RANK)) throw new Error(`wavefront stream: unknown kind ${(r as any).kind}`)
  }
  return { header, records }
}

// ------------------------------------------------------------------ reducer

export interface PositionState {
  open: OpenRecord
  real: {
    events: number
    repaidUsd: number
    seizedUsd: number
    badDebtUsd: number
    unpricedEvents: number
  }
  mem: {
    sales: number
    /** Bit k set while sub k (0 for an unsplit position) has a delay timer running. */
    armedMask: number
    arms: number
    saves: number
    repaidUsd: number
    soldUsd: number
    unpricedSales: number
    /** The LTV of the last decision. */
    ltv: number | null
    firstSaleMinute: number | null
  }
}

export interface ReplayState {
  seq: number
  ts: number
  positions: Map<string, PositionState>
  /** pids in open order. */
  order: string[]
  coverage: { walked: number; total: number }
  totals: Totals
  lastTick: TickRecord | null
  ticks: number
}

export function createReplayState(): ReplayState {
  return {
    seq: 0,
    ts: -Infinity,
    positions: new Map(),
    order: [],
    coverage: { walked: 0, total: 0 },
    totals: emptyTotals(),
    lastTick: null,
    ticks: 0,
  }
}

type MemStatus = 'sold' | 'armed' | 'kept'
const statusOf = (p: PositionState): MemStatus =>
  p.mem.sales > 0 ? 'sold' : p.mem.armedMask !== 0 ? 'armed' : 'kept'
const STATUS_KEY = {
  sold: 'positionsSold',
  armed: 'positionsArmed',
  kept: 'positionsKept',
} as const

export interface ApplyOptions {
  /** Check every tick against the fold so far (default true). */
  verifyTicks?: boolean
}

/**
 * Fold one record into the state, IN PLACE, and return it. Throws on anything the schema
 * forbids: a non-increasing seq, a ts going backwards, a second open for a pid, a real or mem
 * record before its open, a mem record for a position that is not walked, or (with
 * verifyTicks) a tick whose totals are not the fold's.
 */
export function applyRecord(
  state: ReplayState,
  rec: StreamRecord,
  opts: ApplyOptions = {},
): ReplayState {
  if (!(rec.seq > state.seq)) throw new Error(`seq ${rec.seq} after ${state.seq}`)
  if (rec.ts < state.ts) throw new Error(`seq ${rec.seq}: ts ${rec.ts} before ${state.ts}`)
  state.seq = rec.seq
  state.ts = rec.ts
  const T = state.totals
  switch (rec.kind) {
    case 'open': {
      if (state.positions.has(rec.pid)) throw new Error(`${rec.pid}: opened twice`)
      state.positions.set(rec.pid, {
        open: rec,
        real: { events: 0, repaidUsd: 0, seizedUsd: 0, badDebtUsd: 0, unpricedEvents: 0 },
        mem: {
          sales: 0,
          armedMask: 0,
          arms: 0,
          saves: 0,
          repaidUsd: 0,
          soldUsd: 0,
          unpricedSales: 0,
          ltv: rec.ltv0,
          firstSaleMinute: null,
        },
      })
      state.order.push(rec.pid)
      state.coverage.total++
      if (rec.walked) {
        state.coverage.walked++
        T.mem.positionsKept++
      }
      return state
    }
    case 'real': {
      const p = state.positions.get(rec.pid)
      if (!p) throw new Error(`${rec.pid}: real before open`)
      if (p.real.events === 0) T.real.positions++
      p.real.events++
      if (rec.repaidUsd == null || rec.seizedUsd == null) {
        p.real.unpricedEvents++
        T.real.unpricedEvents++
      }
      if (rec.repaidUsd != null) {
        p.real.repaidUsd += rec.repaidUsd
        T.real.repaidUsd += rec.repaidUsd
      }
      if (rec.seizedUsd != null) {
        p.real.seizedUsd += rec.seizedUsd
        T.real.soldUsd += rec.seizedUsd
      }
      if (rec.badDebtUsd != null) {
        p.real.badDebtUsd += rec.badDebtUsd
        T.real.badDebtUsd += rec.badDebtUsd
      }
      return state
    }
    case 'mem': {
      const p = state.positions.get(rec.pid)
      if (!p) throw new Error(`${rec.pid}: mem before open`)
      if (!p.open.walked) throw new Error(`${rec.pid}: mem record for a position not walked`)
      const before = statusOf(p)
      const bit = 1 << (rec.sub ?? 0)
      p.mem.ltv = rec.ltv
      if (rec.event === 'arm') {
        p.mem.armedMask |= bit
        p.mem.arms++
      } else if (rec.event === 'save') {
        p.mem.armedMask &= ~bit
        p.mem.saves++
      } else {
        p.mem.armedMask &= ~bit // a sale deletes the timer (LiquidationEngine.sol:1421-1423)
        p.mem.sales++
        if (p.mem.firstSaleMinute === null) p.mem.firstSaleMinute = rec.minute
        if (rec.repaidUsd == null || rec.soldUsd == null) {
          p.mem.unpricedSales++
          T.mem.unpricedSales++
        }
        if (rec.repaidUsd != null) {
          p.mem.repaidUsd += rec.repaidUsd
          T.mem.repaidUsd += rec.repaidUsd
        }
        if (rec.soldUsd != null) {
          p.mem.soldUsd += rec.soldUsd
          T.mem.soldUsd += rec.soldUsd
        }
      }
      const after = statusOf(p)
      if (after !== before) {
        T.mem[STATUS_KEY[before]]--
        T.mem[STATUS_KEY[after]]++
      }
      return state
    }
    case 'tick': {
      if (opts.verifyTicks ?? true) {
        if (
          rec.coverage.walked !== state.coverage.walked ||
          rec.coverage.total !== state.coverage.total
        ) {
          throw new Error(`tick ${rec.minute}: coverage is not the fold's`)
        }
        if (!totalsClose(rec.totals, T))
          throw new Error(`tick ${rec.minute}: totals are not the fold's`)
      }
      state.lastTick = rec
      state.ticks++
      return state
    }
  }
}

/** Fold a whole stream. */
export function replay(records: Iterable<StreamRecord>, opts: ApplyOptions = {}): ReplayState {
  const s = createReplayState()
  for (const r of records) applyRecord(s, r, opts)
  return s
}

/** A tick record for the fold so far (the writer uses it; seq is set by the caller). */
export function tickFromState(
  state: ReplayState,
  window: StreamWindow,
  minute: number,
): TickRecord {
  return {
    kind: 'tick',
    seq: 0,
    ts: tickTs(window, minute),
    minute,
    coverage: { ...state.coverage },
    totals: roundTotals(state.totals),
  }
}

// ------------------------------------------------------------------ compact

/**
 * The served replay (public/data/oct10-2025/wavefront-replay.json). Columns, not objects;
 * every array in a table has one entry per row of that table. Nullable numbers are JSON null.
 *
 *   open.addr / protocol (0 aave-v3, 1 morpho-blue) / chain (dict.chain) / market
 *     (dict.market, -1 for Aave) — pid is rebuilt from these
 *   open.block, ts, debtUsd, collUsd, line, ltv0, delayClass (0 no-delay, 1 delayed,
 *     2 mixed), cluster (dict.cluster), walked (0/1), reason (dict.reason, -1 none),
 *     t0Block / t0Ts / t0Minute (null when not walked)
 *   open.legN[i] collateral legs of row i, laid end to end in legSym (dict.symbol) / legUsd;
 *     debtN / debtSym / debtUsdLeg the same for debt legs; subN / subClass (0 no-delay,
 *     1 delayed) / subLine / subShare / subCollUsd / subDebtUsd the same for split halves
 *     (sub index = position within the row's run)
 *   real.pos (row in open), ts, block, tx, logIndex, repaidUsd, seizedUsd, badDebtUsd
 *     (badDebtUsd: null on Aave rows, where the record has none)
 *   mem.pos, sub (-1 none), minute, event (0 arm, 1 save, 2 sell, 3 sell-instant),
 *     why (index in WHY, -1 none), repaidUsd, soldUsd, ltv
 *   tick.minute, ts, walked, total, then the Totals fields flattened (see TICK_COLS)
 */
export interface CompactReplay {
  format: typeof COMPACT_FORMAT
  schema: typeof STREAM_SCHEMA
  window: StreamWindow
  tickEveryMinutes: number
  dict: { chain: string[]; symbol: string[]; cluster: string[]; reason: string[]; market: string[] }
  order: string
  open: Record<string, (number | string | null)[]>
  real: Record<string, (number | string | null)[]>
  mem: Record<string, (number | null)[]>
  tick: Record<string, number[]>
}

const PROTOCOLS: Protocol[] = ['aave-v3', 'morpho-blue']
const CLASSES: DelayClass[] = ['no-delay', 'delayed', 'mixed']
const EVENTS: MemEvent[] = ['arm', 'save', 'sell', 'sell-instant']
export const WHY: SaleWhy[] = ['band', 'expiry', 'instant', 'grid-end', 'no-series']
const TICK_COLS = [
  ['realPositions', (t: Totals) => t.real.positions],
  ['realRepaidUsd', (t: Totals) => t.real.repaidUsd],
  ['realSoldUsd', (t: Totals) => t.real.soldUsd],
  ['realBadDebtUsd', (t: Totals) => t.real.badDebtUsd],
  ['realUnpricedEvents', (t: Totals) => t.real.unpricedEvents],
  ['memPositionsSold', (t: Totals) => t.mem.positionsSold],
  ['memPositionsArmed', (t: Totals) => t.mem.positionsArmed],
  ['memPositionsKept', (t: Totals) => t.mem.positionsKept],
  ['memRepaidUsd', (t: Totals) => t.mem.repaidUsd],
  ['memSoldUsd', (t: Totals) => t.mem.soldUsd],
  ['memUnpricedSales', (t: Totals) => t.mem.unpricedSales],
] as const

class Dict {
  readonly list: string[] = []
  private readonly idx = new Map<string, number>()
  of(s: string): number {
    let i = this.idx.get(s)
    if (i === undefined) {
      i = this.list.length
      this.list.push(s)
      this.idx.set(s, i)
    }
    return i
  }
}

/** Split a pid into its parts. */
export function parsePid(pid: string): {
  protocol: Protocol
  chain: string
  market: string | null
  addr: string
} {
  const p = pid.split(':')
  if (p[0] === 'aave-v3' && p.length === 3) {
    return { protocol: 'aave-v3', chain: p[1], market: null, addr: p[2] }
  }
  if (p[0] === 'morpho-blue' && p.length === 4) {
    return { protocol: 'morpho-blue', chain: p[1], market: p[2], addr: p[3] }
  }
  throw new Error(`bad pid ${pid}`)
}

export const makePid = (protocol: Protocol, chain: string, addr: string, market?: string | null) =>
  protocol === 'aave-v3' ? `aave-v3:${chain}:${addr}` : `morpho-blue:${chain}:${market}:${addr}`

export function encodeCompact(
  window: StreamWindow,
  records: readonly StreamRecord[],
): CompactReplay {
  const chain = new Dict()
  const symbol = new Dict()
  const cluster = new Dict()
  const reason = new Dict()
  const market = new Dict()
  const posRow = new Map<string, number>()
  const cols = <K extends string>(keys: readonly K[]) =>
    Object.fromEntries(keys.map((k) => [k, [] as any[]])) as Record<K, any[]>
  const open = cols([
    'addr',
    'protocol',
    'chain',
    'market',
    'block',
    'ts',
    'debtUsd',
    'collUsd',
    'line',
    'ltv0',
    'delayClass',
    'cluster',
    'walked',
    'reason',
    't0Block',
    't0Ts',
    't0Minute',
    'legN',
    'legSym',
    'legUsd',
    'debtN',
    'debtSym',
    'debtUsdLeg',
    'subN',
    'subClass',
    'subLine',
    'subShare',
    'subCollUsd',
    'subDebtUsd',
  ] as const)
  const real = cols([
    'pos',
    'ts',
    'block',
    'tx',
    'logIndex',
    'repaidUsd',
    'seizedUsd',
    'badDebtUsd',
  ] as const)
  const mem = cols(['pos', 'sub', 'minute', 'event', 'why', 'repaidUsd', 'soldUsd', 'ltv'] as const)
  const tick = cols(['minute', 'ts', 'walked', 'total', ...TICK_COLS.map((c) => c[0])] as const)
  let order = ''
  let seq = 0
  for (const r of records) {
    if (r.seq !== ++seq) throw new Error(`encodeCompact: seq ${r.seq} at position ${seq}`)
    switch (r.kind) {
      case 'open': {
        const p = parsePid(r.pid)
        if (p.protocol !== r.protocol || p.chain !== r.chain) {
          throw new Error(`encodeCompact: pid ${r.pid} disagrees with its fields`)
        }
        posRow.set(r.pid, open.addr.length)
        open.addr.push(p.addr)
        open.protocol.push(PROTOCOLS.indexOf(r.protocol))
        open.chain.push(chain.of(r.chain))
        open.market.push(p.market === null ? -1 : market.of(p.market))
        open.block.push(r.block)
        open.ts.push(r.ts)
        open.debtUsd.push(r.debtUsd)
        open.collUsd.push(r.collUsd)
        open.line.push(r.line)
        open.ltv0.push(r.ltv0)
        open.delayClass.push(CLASSES.indexOf(r.delayClass))
        open.cluster.push(cluster.of(r.cluster))
        open.walked.push(r.walked ? 1 : 0)
        open.reason.push(r.reason === undefined ? -1 : reason.of(r.reason))
        open.t0Block.push(r.t0 ? r.t0.block : null)
        open.t0Ts.push(r.t0 ? r.t0.ts : null)
        open.t0Minute.push(r.t0 ? r.t0.minute : null)
        open.legN.push(r.legs.length)
        for (const l of r.legs) {
          open.legSym.push(symbol.of(l.symbol))
          open.legUsd.push(l.usd)
        }
        open.debtN.push(r.debtLegs.length)
        for (const l of r.debtLegs) {
          open.debtSym.push(symbol.of(l.symbol))
          open.debtUsdLeg.push(l.usd)
        }
        open.subN.push(r.subs ? r.subs.length : 0)
        for (const [k, s] of (r.subs ?? []).entries()) {
          if (s.sub !== k) throw new Error(`encodeCompact: ${r.pid} sub ${s.sub} at ${k}`)
          open.subClass.push(s.delayClass === 'no-delay' ? 0 : 1)
          open.subLine.push(s.line)
          open.subShare.push(s.share)
          open.subCollUsd.push(s.collUsd)
          open.subDebtUsd.push(s.debtUsd)
        }
        order += 'o'
        break
      }
      case 'real': {
        const row = posRow.get(r.pid)
        if (row === undefined) throw new Error(`encodeCompact: ${r.pid} real before open`)
        real.pos.push(row)
        real.ts.push(r.ts)
        real.block.push(r.block)
        real.tx.push(r.tx)
        real.logIndex.push(r.logIndex)
        real.repaidUsd.push(r.repaidUsd)
        real.seizedUsd.push(r.seizedUsd)
        if ((r.badDebtUsd !== undefined) !== r.pid.startsWith('morpho-blue:')) {
          throw new Error(`encodeCompact: ${r.pid} badDebtUsd must be present exactly on Morpho`)
        }
        real.badDebtUsd.push(r.badDebtUsd === undefined ? null : r.badDebtUsd)
        order += 'r'
        break
      }
      case 'mem': {
        const row = posRow.get(r.pid)
        if (row === undefined) throw new Error(`encodeCompact: ${r.pid} mem before open`)
        mem.pos.push(row)
        mem.sub.push(r.sub === undefined ? -1 : r.sub)
        mem.minute.push(r.minute)
        mem.event.push(EVENTS.indexOf(r.event))
        mem.why.push(r.why === undefined ? -1 : WHY.indexOf(r.why))
        mem.repaidUsd.push(r.repaidUsd)
        mem.soldUsd.push(r.soldUsd)
        mem.ltv.push(r.ltv)
        order += 'm'
        break
      }
      case 'tick': {
        tick.minute.push(r.minute)
        tick.ts.push(r.ts)
        tick.walked.push(r.coverage.walked)
        tick.total.push(r.coverage.total)
        for (const [k, f] of TICK_COLS) tick[k].push(f(r.totals))
        order += 't'
        break
      }
    }
  }
  return {
    format: COMPACT_FORMAT,
    schema: STREAM_SCHEMA,
    window,
    tickEveryMinutes: TICK_EVERY_MINUTES,
    dict: {
      chain: chain.list,
      symbol: symbol.list,
      cluster: cluster.list,
      reason: reason.list,
      market: market.list,
    },
    order,
    open,
    real,
    mem,
    tick,
  }
}

export function decodeCompact(c: CompactReplay): StreamRecord[] {
  if (c.format !== COMPACT_FORMAT) throw new Error('decodeCompact: not a compact replay')
  if (c.schema !== STREAM_SCHEMA) {
    throw new Error(`decodeCompact: schema ${c.schema}, this reader is ${STREAM_SCHEMA}`)
  }
  const { dict, window: w } = c
  const O = c.open as Record<string, any[]>
  const R = c.real as Record<string, any[]>
  const M = c.mem as Record<string, any[]>
  const K = c.tick as Record<string, number[]>
  const opens: OpenRecord[] = []
  let leg = 0
  let debt = 0
  let sub = 0
  const out: StreamRecord[] = []
  const at = { o: 0, r: 0, m: 0, t: 0 }
  for (let k = 0; k < c.order.length; k++) {
    const seq = k + 1
    const ch = c.order[k]
    if (ch === 'o') {
      const i = at.o++
      const protocol = PROTOCOLS[O.protocol[i]]
      const chainName = dict.chain[O.chain[i]]
      const mk = O.market[i] === -1 ? null : dict.market[O.market[i]]
      const legs: StreamLeg[] = []
      for (let n = 0; n < O.legN[i]; n++, leg++) {
        legs.push({ symbol: dict.symbol[O.legSym[leg]], usd: O.legUsd[leg] })
      }
      const debtLegs: StreamLeg[] = []
      for (let n = 0; n < O.debtN[i]; n++, debt++) {
        debtLegs.push({ symbol: dict.symbol[O.debtSym[debt]], usd: O.debtUsdLeg[debt] })
      }
      const subs: SubSpec[] = []
      for (let n = 0; n < O.subN[i]; n++, sub++) {
        subs.push({
          sub: n,
          delayClass: O.subClass[sub] === 0 ? 'no-delay' : 'delayed',
          line: O.subLine[sub],
          share: O.subShare[sub],
          collUsd: O.subCollUsd[sub],
          debtUsd: O.subDebtUsd[sub],
        })
      }
      const r: OpenRecord = {
        kind: 'open',
        seq,
        pid: makePid(protocol, chainName, O.addr[i], mk),
        protocol,
        chain: chainName,
        block: O.block[i],
        ts: O.ts[i],
        legs,
        debtLegs,
        debtUsd: O.debtUsd[i],
        collUsd: O.collUsd[i],
        line: O.line[i],
        ltv0: O.ltv0[i],
        delayClass: CLASSES[O.delayClass[i]],
        cluster: dict.cluster[O.cluster[i]],
        walked: O.walked[i] === 1,
      }
      if (O.reason[i] !== -1) r.reason = dict.reason[O.reason[i]]
      if (O.t0Minute[i] !== null)
        r.t0 = { block: O.t0Block[i], ts: O.t0Ts[i], minute: O.t0Minute[i] }
      if (subs.length) r.subs = subs
      opens.push(r)
      out.push(r)
    } else if (ch === 'r') {
      const i = at.r++
      const p = opens[R.pos[i]]
      const r: RealRecord = {
        kind: 'real',
        seq,
        pid: p.pid,
        ts: R.ts[i],
        block: R.block[i],
        tx: R.tx[i],
        logIndex: R.logIndex[i],
        repaidUsd: R.repaidUsd[i],
        seizedUsd: R.seizedUsd[i],
      }
      // Present on every Morpho real record (null when unpriced), absent on Aave.
      if (p.protocol === 'morpho-blue') r.badDebtUsd = R.badDebtUsd[i]
      out.push(r)
    } else if (ch === 'm') {
      const i = at.m++
      const p = opens[M.pos[i]]
      if (!p.t0) throw new Error(`decodeCompact: mem for ${p.pid}, which has no t0`)
      const r: MemRecord = {
        kind: 'mem',
        seq,
        pid: p.pid,
        ts: memTs(M.minute[i], p.t0.minute, p.t0.ts, w.startTs, w.stepSeconds),
        minute: M.minute[i],
        event: EVENTS[M.event[i]],
        repaidUsd: M.repaidUsd[i],
        soldUsd: M.soldUsd[i],
        ltv: M.ltv[i],
      }
      if (M.sub[i] !== -1) r.sub = M.sub[i]
      if (M.why[i] !== -1) r.why = WHY[M.why[i]]
      out.push(r)
    } else if (ch === 't') {
      const i = at.t++
      out.push({
        kind: 'tick',
        seq,
        ts: K.ts[i],
        minute: K.minute[i],
        coverage: { walked: K.walked[i], total: K.total[i] },
        totals: {
          real: {
            positions: K.realPositions[i],
            repaidUsd: K.realRepaidUsd[i],
            soldUsd: K.realSoldUsd[i],
            badDebtUsd: K.realBadDebtUsd[i],
            unpricedEvents: K.realUnpricedEvents[i],
          },
          mem: {
            positionsSold: K.memPositionsSold[i],
            positionsArmed: K.memPositionsArmed[i],
            positionsKept: K.memPositionsKept[i],
            repaidUsd: K.memRepaidUsd[i],
            soldUsd: K.memSoldUsd[i],
            unpricedSales: K.memUnpricedSales[i],
          },
        },
      })
    } else {
      throw new Error(`decodeCompact: bad order character ${ch}`)
    }
  }
  return out
}
