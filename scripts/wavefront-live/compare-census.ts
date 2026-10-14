/**
 * HISTORICAL EQUIVALENCE: the live engine's `--mode historical` stream against the Oct 10-11
 * census replay, for the positions OPENED inside the slice, on the minutes inside it.
 *
 *   npx tsx scripts/wavefront-live/compare-census.ts --live /tmp/hist.jsonl \
 *     [--census <replay.jsonl.gz | wavefront-replay.json>] [--from ISO --to ISO] [--out report.json]
 *
 * Default census: $MEMBRANE_DATASETS_DIR/oct10-2025/coverage/replay.jsonl.gz, else the served
 * public/data/oct10-2025/wavefront-replay.json (the same records, compact form).
 *
 * Compared, per pid: the open record (every field: line, class, walked, reason, legs, t0, subs,
 * USD …), every real record with ts before the slice end, every mem record with minute before
 * the slice end, and the ORDER of the pid's records (the kinds in seq order). Integers — blocks,
 * timestamps, minutes, log indexes, sub indexes, counts — must be EQUAL; other numbers within
 * 1e-6 relative (USD are cents on both sides, so in practice equal). The live stream must fold
 * through the ONE reducer without an error (its ticks checked against its fold), and at every
 * live tick inside the slice the fold of the compared positions' records so far must equal the
 * census's fold of the same positions' records so far (coverage exactly; real seized after the
 * protocol fee within a cent per record).
 *
 * `differences` counts EVERYTHING that differs — record diffs, tick diffs, census positions
 * missing in the live stream, live positions the census does not have — except the by-design
 * categories below, each listed with its members. The exit code is 1 when differences > 0.
 *
 * What the live engine does differently BY DESIGN (owner review 2.1), and how it is compared:
 *   - pids carry the Aave pool: Core-pool ids are mapped back to the census's legacy form;
 *     positions on the other pools (mainnet Lido, EtherFi) are outside the census and listed;
 *   - Morpho Blue positions on a chain where the census has no Morpho position at all (the
 *     owner's Oct 10 pull covered Morpho on mainnet and Base) are outside the census and listed;
 *   - Aave real seizedUsd includes the liquidation protocol fee: compared as
 *     seizedUsd - protocolFeeUsd (each rounded to cents, so within $0.01);
 *   - a position not liquidatable at the N prices but at the N-1 prices is walked
 *     (`priceBasis: 'N-1'`) where the census has walked:false — listed separately;
 *   - a minute with a held leg's oracle value missing on every backend is not stepped (a gap)
 *     where the census carried the last value forward — gaps are counted from the ticks.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { gunzipSync } from 'zlib'
import { AAVE_CORE_POOL, legacyPid, parseAnyPid } from '../../lib/wavefront/pid'
import {
  applyRecord,
  createReplayState,
  decodeCompact,
  decodeJsonl,
  replay,
  type MemRecord,
  type OpenRecord,
  type RealRecord,
  type StreamRecord,
  type TickRecord,
} from '../../lib/wavefront/stream'

function args(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1]
  return out
}

const REL = 1e-6
/** Fields that are integers by definition: compared exactly whatever their size. */
const INTEGER_FIELDS = new Set(['block', 'ts', 'minute', 'seq', 'logIndex', 'sub', 't0Block', 't0Ts', 't0Minute', 'eventTs', 'events', 'positions', 'walked', 'total'])
const close = (a: unknown, b: unknown, path: string) => {
  if (typeof a !== 'number' || typeof b !== 'number') return a === b
  if (a === b) return true
  const field = path.slice(path.lastIndexOf('.') + 1)
  // Integers are equal or different: 1e-6 of a block number (~23.5 M) is 23 blocks, of a unix
  // time 29 minutes.
  if (INTEGER_FIELDS.has(field) || (Number.isInteger(a) && Number.isInteger(b))) return false
  return Math.abs(a - b) <= REL * Math.max(Math.abs(a), Math.abs(b))
}

/** Paths where two values differ (integers exactly, other numbers within REL). */
function diff(a: unknown, b: unknown, path = ''): string[] {
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return [`${path}: array vs object`]
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)])
    const out: string[] = []
    for (const k of keys)
      out.push(...diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`))
    return out
  }
  return close(a, b, path) ? [] : [`${path}: census ${JSON.stringify(a)} live ${JSON.stringify(b)}`]
}

const strip = <T extends StreamRecord>(r: T) => {
  const { seq, backfilled, late, eventTs, ...rest } = r as T & {
    backfilled?: boolean
    late?: boolean
    eventTs?: number
  }
  void seq
  void backfilled
  void late
  void eventTs
  return rest
}

function loadCensus(path: string): { startTs: number; records: StreamRecord[] } {
  if (path.endsWith('.gz')) {
    const { header, records } = decodeJsonl(gunzipSync(readFileSync(path)).toString('utf8'))
    return { startTs: header.window.startTs, records }
  }
  const c = JSON.parse(readFileSync(path, 'utf8'))
  return { startTs: c.window.startTs, records: decodeCompact(c) }
}

function main() {
  const o = args(process.argv.slice(2))
  if (!o.live) throw new Error('--live <hist.jsonl> required')
  const ds = process.env.MEMBRANE_DATASETS_DIR ?? '/home/user/membrane-datasets'
  const censusPath =
    o.census ??
    (existsSync(join(ds, 'oct10-2025/coverage/replay.jsonl.gz'))
      ? join(ds, 'oct10-2025/coverage/replay.jsonl.gz')
      : join(__dirname, '../../public/data/oct10-2025/wavefront-replay.json'))
  const census = loadCensus(censusPath)
  const liveText = readFileSync(o.live, 'utf8')
  const liveRaw = decodeJsonl(liveText)
  // Pool-qualified Aave ids -> the census's ids (Core pool only).
  const nonCore = new Set<string>()
  const mapPid = (pid: string) => {
    const p = parseAnyPid(pid)
    if (p.protocol === 'aave-v3' && p.market && p.market !== AAVE_CORE_POOL[p.chain]) {
      nonCore.add(pid)
      return pid
    }
    return legacyPid(pid)
  }
  const live = {
    header: liveRaw.header,
    records: liveRaw.records.map((r) => (r.kind === 'tick' ? r : { ...r, pid: mapPid(r.pid) })) as StreamRecord[],
  }
  const gaps = live.records
    .filter((r) => r.kind === 'tick')
    .reduce((a, r) => a + ((r as { gaps?: { positionMinutes: number } }).gaps?.positionMinutes ?? 0), 0)
  const S0 = census.startTs
  if (live.header.window.startTs !== S0)
    throw new Error(`epochs differ: census ${S0}, live ${live.header.window.startTs}`)
  const minuteOf = (ts: number) => Math.floor((ts - S0) / 60)

  // The live stream folds through the reducer (ticks included).
  const folded = replay(live.records)

  const liveOpens = liveRaw.records.filter((r): r is OpenRecord => r.kind === 'open').map((r) => ({ ...r, pid: mapPid(r.pid) }))
  const liveMinutes = [
    ...new Set(live.records.filter((r) => r.kind === 'mem').map((r) => (r as MemRecord).minute)),
  ]
  const fm = o.from ? minuteOf(Date.parse(o.from) / 1000) : Math.min(...liveOpens.map((r) => minuteOf(r.ts)))
  const lastTick = live.records.filter((r) => r.kind === 'tick').pop()
  const tm = o.to
    ? minuteOf(Date.parse(o.to) / 1000)
    : Math.max(...liveMinutes, ...(lastTick ? [lastTick.minute] : [])) + 1
  const endTs = S0 + 60 * tm

  const censusOpen = new Map<string, OpenRecord>()
  for (const r of census.records) if (r.kind === 'open') censusOpen.set(r.pid, r)
  const inSlice = (r: OpenRecord) => minuteOf(r.ts) >= fm && minuteOf(r.ts) < tm
  const censusPids = new Set([...censusOpen.values()].filter(inSlice).map((r) => r.pid))
  const livePids = new Set(liveOpens.filter(inSlice).map((r) => r.pid))
  const preSlice = [...livePids].filter((p) => censusOpen.has(p) && !inSlice(censusOpen.get(p)!))
  const missing = [...censusPids].filter((p) => !livePids.has(p))
  // Morpho chains the census covers at all (its pull's scope).
  const censusMorphoChains = new Set(
    [...censusOpen.keys()].filter((p) => p.startsWith('morpho-blue:')).map((p) => p.split(':')[1]),
  )
  const morphoOutOfScope = (p: string) => p.startsWith('morpho-blue:') && !censusMorphoChains.has(p.split(':')[1])
  const outsideCensus = [...livePids].filter((p) => nonCore.has(p))
  const morphoOutside = [...livePids].filter((p) => !censusOpen.has(p) && morphoOutOfScope(p))
  const extra = [...livePids].filter((p) => !censusOpen.has(p) && !nonCore.has(p) && !morphoOutOfScope(p))
  const common = [...censusPids].filter((p) => livePids.has(p))
  const nm1 = new Set(
    liveOpens.filter((r) => (r as { priceBasis?: string }).priceBasis === 'N-1').map((r) => mapPid(r.pid)),
  )

  const byPid = (recs: StreamRecord[]) => {
    const m = new Map<string, { open?: OpenRecord; real: RealRecord[]; mem: MemRecord[] }>()
    for (const r of recs) {
      if (r.kind === 'tick') continue
      let e = m.get(r.pid)
      if (!e) m.set(r.pid, (e = { real: [], mem: [] }))
      if (r.kind === 'open') e.open = r
      else if (r.kind === 'real') e.real.push(r)
      else e.mem.push(r)
    }
    return m
  }
  const C = byPid(census.records)
  const L = byPid(live.records)
  const diffs: { pid: string; what: string; detail: string[] }[] = []
  let reals = 0
  let mems = 0
  let sales = 0
  let censusMemUsd = 0
  let liveMemUsd = 0
  let censusRealUsd = 0
  let liveRealUsd = 0
  const byDesign: { pid: string; what: string; detail: string[] }[] = []
  let feeAdjusted = 0
  let feeUsd = 0
  for (const pid of common) {
    const c = C.get(pid)!
    const l = L.get(pid)!
    const d = diff(strip(c.open!), strip(l.open!)).filter((x) => !x.startsWith('.priceBasis'))
    const sink = nm1.has(pid) ? byDesign : diffs
    if (d.length) sink.push({ pid, what: nm1.has(pid) ? 'open (located at N-1)' : 'open', detail: d })
    const cr = c.real.filter((r) => r.ts < endTs)
    const lr = l.real.filter((r) => r.ts < endTs)
    reals += cr.length
    for (const r of cr) censusRealUsd += r.repaidUsd ?? 0
    for (const r of lr) liveRealUsd += r.repaidUsd ?? 0
    if (cr.length !== lr.length) diffs.push({ pid, what: 'real count', detail: [`census ${cr.length} live ${lr.length}`] })
    cr.forEach((r, i) => {
      if (!lr[i]) return
      const x = strip(lr[i]) as RealRecord & { protocolFeeUsd?: number | null }
      let y: Record<string, unknown> = { ...x }
      if (x.protocolFeeUsd !== undefined) {
        // The census's seized is the liquidator's share: compare seized - fee (cents, so +-0.01).
        const fee = x.protocolFeeUsd ?? 0
        feeUsd += fee
        const share = x.seizedUsd == null ? null : Math.round((x.seizedUsd - fee) * 100) / 100
        const { protocolFeeUsd, ...rest } = x
        void protocolFeeUsd
        y = { ...rest, seizedUsd: share }
        if (share != null && r.seizedUsd != null && Math.abs(share - r.seizedUsd) <= 0.0101) {
          y.seizedUsd = r.seizedUsd
          if (share !== r.seizedUsd) feeAdjusted++
        }
      }
      const dd = diff(strip(r), y)
      if (dd.length) diffs.push({ pid, what: `real ${i}`, detail: dd })
    })
    const cm = c.mem.filter((r) => r.minute < tm)
    const lm = l.mem.filter((r) => r.minute < tm)
    mems += cm.length
    for (const r of cm) if (r.event === 'sell' || r.event === 'sell-instant') {
      sales++
      censusMemUsd += r.repaidUsd ?? 0
    }
    for (const r of lm) if (r.event === 'sell' || r.event === 'sell-instant') liveMemUsd += r.repaidUsd ?? 0
    const memSink = nm1.has(pid) ? byDesign : diffs
    // The pid's records in stream order (kinds), real and mem interleaved.
    const kinds = (x: { open?: OpenRecord; real: RealRecord[]; mem: MemRecord[] }, rl: RealRecord[], ml: MemRecord[]) =>
      [x.open!, ...rl, ...ml].sort((p, q) => p.seq - q.seq).map((r) => (r.kind === 'mem' ? `mem@${r.minute}` : r.kind))
    const ko = kinds(c, cr, cm)
    const kl = kinds(l, lr, lm)
    if (ko.join() !== kl.join()) memSink.push({ pid, what: 'record order', detail: [`census ${ko.join(' ')}`, `live ${kl.join(' ')}`] })
    if (cm.length !== lm.length)
      memSink.push({
        pid,
        what: 'mem count',
        detail: [`census ${cm.length} live ${lm.length}`, `census ${JSON.stringify(cm.map(strip))}`, `live ${JSON.stringify(lm.map(strip))}`],
      })
    else
      cm.forEach((r, i) => {
        const dd = diff(strip(r), strip(lm[i]))
        if (dd.length) memSink.push({ pid, what: `mem ${i}`, detail: dd })
      })
  }
  // Ticks: at every live tick inside the slice, the fold of the compared positions' records so
  // far, live vs census (the N-1 positions left out: they differ by design).
  const compared = new Set(common.filter((p) => !nm1.has(p)))
  const restricted = (recs: StreamRecord[]) =>
    recs.filter(
      (r) =>
        r.kind !== 'tick' &&
        compared.has(r.pid) &&
        (r.kind === 'open' || (r.kind === 'real' ? r.ts < endTs : (r as MemRecord).minute < tm)),
    )
  const cRec = restricted(census.records)
  const lRec = restricted(live.records)
  const cFold = createReplayState()
  const lFold = createReplayState()
  let ci = 0
  let li = 0
  let lFee = 0
  let lReals = 0
  const tickDiffs: { minute: number; detail: string[] }[] = []
  const liveTicks = live.records.filter(
    (r): r is TickRecord => r.kind === 'tick' && r.minute >= fm && r.minute < tm,
  )
  for (const t of liveTicks) {
    while (ci < cRec.length && cRec[ci].ts < t.ts) applyRecord(cFold, cRec[ci++])
    while (li < lRec.length && lRec[li].seq < t.seq) {
      const r = lRec[li++] as StreamRecord & { protocolFeeUsd?: number | null }
      if (r.kind === 'real') {
        lFee += r.protocolFeeUsd ?? 0
        lReals++
      }
      applyRecord(lFold, r)
    }
    const d = diff(
      { coverage: cFold.coverage, real: { ...cFold.totals.real, soldUsd: 0 }, mem: cFold.totals.mem },
      { coverage: lFold.coverage, real: { ...lFold.totals.real, soldUsd: 0 }, mem: lFold.totals.mem },
      `.tick${t.minute}`,
    )
    const sold = lFold.totals.real.soldUsd - lFee
    if (Math.abs(sold - cFold.totals.real.soldUsd) > 0.0101 * Math.max(1, lReals))
      d.push(`.tick${t.minute}.real.soldUsd (after the fee): census ${cFold.totals.real.soldUsd} live ${sold}`)
    if (d.length) tickDiffs.push({ minute: t.minute, detail: d })
  }

  const r2 = (x: number) => Math.round(x * 100) / 100
  const differences = diffs.length + tickDiffs.length + missing.length + extra.length
  const report = {
    census: censusPath,
    live: o.live,
    slice: {
      fromMinute: fm,
      toMinute: tm,
      from: new Date((S0 + 60 * fm) * 1000).toISOString(),
      to: new Date(endTs * 1000).toISOString(),
    },
    liveFold: {
      records: live.records.length,
      seq: folded.seq,
      ticks: folded.ticks,
      coverage: folded.coverage,
      backfilled: live.records.filter((r) => (r as { backfilled?: boolean }).backfilled).length,
      late: live.records.filter((r) => (r as { late?: boolean }).late).length,
    },
    positions: {
      censusOpenedInSlice: censusPids.size,
      liveOpenedInSlice: livePids.size,
      compared: common.length,
      missingInLive: missing,
      extraInLive: extra,
      outsideCensusNonCorePools: outsideCensus,
      outsideCensusMorphoChains: { censusMorphoChains: [...censusMorphoChains], positions: morphoOutside },
      locatedAtNm1: [...nm1].filter((p) => censusPids.has(p)),
      openedBeforeSliceInCensus: preSlice.length,
      byProtocolChain: Object.fromEntries(
        [...new Set(common.map((p) => p.split(':').slice(0, 2).join(':')))].map((k) => [
          k,
          common.filter((p) => p.startsWith(k + ':')).length,
        ]),
      ),
    },
    records: { open: common.length, real: reals, mem: mems, sales },
    dollars: {
      realRepaidCensus: r2(censusRealUsd),
      realRepaidLive: r2(liveRealUsd),
      memRepaidCensus: r2(censusMemUsd),
      memRepaidLive: r2(liveMemUsd),
    },
    realSeizedFee: {
      protocolFeeUsd: Math.round(feeUsd * 100) / 100,
      recordsWithinOneCentAfterFee: feeAdjusted,
    },
    gapPositionMinutes: gaps,
    ticks: { compared: liveTicks.length, positionsInFold: compared.size, differing: tickDiffs.length },
    byDesignDifferences: byDesign,
    differences,
    differenceCounts: {
      records: diffs.length,
      ticks: tickDiffs.length,
      missingInLive: missing.length,
      extraInLive: extra.length,
    },
    diffs: diffs.slice(0, 200),
    tickDiffs: tickDiffs.slice(0, 50),
  }
  if (o.out) writeFileSync(o.out, JSON.stringify(report, null, 1))
  console.log(JSON.stringify({ ...report, diffs: diffs.slice(0, 20), tickDiffs: tickDiffs.slice(0, 5) }, null, 1))
  if (differences > 0) process.exitCode = 1
}

main()
