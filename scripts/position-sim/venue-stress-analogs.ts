/**
 * venue-stress-analogs — prints the measured venue exit-capacity analog table
 * (lib/position-sim/venueStressAnalogs.ts) from the venue stress history.
 *
 * Run (from the repo root):
 *   ./node_modules/.bin/tsx scripts/position-sim/venue-stress-analogs.ts [--basis=held|reading]
 *     [--events=<venue id>] [--out=<path.json>] [--emit-presets]
 * Reads public/data/venue-stress/{history,summary}.json and, for WETH's USD cash,
 * public/data/price-history/eth-usd-1h.json (primary series, the hour's close). No chain
 * reads. A venue the summary has no stress level for (the reused USDe grid) gets its util
 * windows derived from its series (`utilWindowsFromSeries`, the builder's rule).
 * `--out` writes the table without the per-event member rows. `--emit-presets` rewrites the
 * generated rows of lib/position-sim/exitCapacityAnalogs.ts (the stress engine's measured
 * exit-capacity presets; basis 'held' only): the cash-vs-book HEADLINE rows at every book of
 * EXIT_CAPACITY_BOOKS (`cashVsBookAnalogs` → `exitCapacityBookRows`) and the pro-rata FLOOR
 * rows (`exitCapacityAnalogRows`) — run prettier on it afterwards.
 */
import fs from 'node:fs'
import path from 'node:path'

import { indexAt, primaryGrid, type PriceHistoryFile } from '../../lib/position-sim/drawdowns'
import { EXIT_CAPACITY_BOOKS } from '../../lib/position-sim/exitCapacityAnalogs'
import {
  VENUE_ANALOG_DEFAULT_BASIS,
  cashVsBookAnalogs,
  exitCapacityAnalogRows,
  exitCapacityBookRows,
  VENUE_DEFAULT_STRESS_UTIL,
  stressWindowsFromEpisodes,
  utilWindowsFromSeries,
  venueSeriesFromHistory,
  venueStressAnalogs,
  type VenueAnalogBasis,
  type VenueStressEpisode,
  type VenueStressHistoryFile,
} from '../../lib/position-sim/venueStressAnalogs'

const ROOT = path.resolve(__dirname, '../..')
const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)

const readJson = <T>(rel: string): T =>
  JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')) as T

const history = readJson<VenueStressHistoryFile>('public/data/venue-stress/history.json')
const summary = readJson<{
  method: { minSize: Record<string, number>; stressUtil: Record<string, number> }
  episodes: VenueStressEpisode[]
}>('public/data/venue-stress/summary.json')
const eth = primaryGrid(readJson<PriceHistoryFile>('public/data/price-history/eth-usd-1h.json'))

const priceUsd = (symbol: string, tSec: number): number | null => {
  if (symbol !== 'WETH' && symbol !== 'ETH') return null
  const i = indexAt(eth, tSec)
  return i >= 0 && i < eth.close.length ? eth.close[i] : null
}

const basis = (arg('basis') ?? VENUE_ANALOG_DEFAULT_BASIS) as VenueAnalogBasis
if (basis !== 'reading' && basis !== 'held') throw new Error(`--basis must be reading|held`)

const series = venueSeriesFromHistory(history, { minSize: summary.method.minSize })
const derivedUtil = series
  .filter((s) => summary.method.stressUtil[s.venue] === undefined)
  .flatMap((s) => utilWindowsFromSeries(s, VENUE_DEFAULT_STRESS_UTIL))
const windows = stressWindowsFromEpisodes(summary.episodes, derivedUtil)
const table = venueStressAnalogs(series, windows, { basis, priceUsd })

const pct = (x: number) => `${(x * 100).toFixed(2)}%`.padStart(7)
const hrs = (x: number | null, lb: number | null = null) =>
  x === null ? (lb === null ? '—' : `>${Math.round(lb)}`) : `${Math.round(x)}`
const usd = (x: number | null) =>
  x === null ? '—' : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${(x / 1e3).toFixed(1)}k`

console.log(`venue stress analogs · basis '${basis}' · ${table.descriptiveLabel}`)
console.log(
  `windows: ${windows.length} (${derivedUtil.length} util derived from series: ${derivedUtil.map((w) => w.id).join(', ') || 'none'})` +
    ` · named + eth-drop apply to every venue, util to its own\n`,
)
for (const r of table.rows) {
  if (!r.presets) {
    console.log(`${r.name.padEnd(16)} n=0 (skipped ${r.skipped.length})`)
    continue
  }
  console.log(
    `${r.name}  n=${r.n} events ${r.range!.fromIso.slice(0, 10)} → ${r.range!.toIso.slice(0, 10)}` +
      `  (skipped windows: ${r.skipped.length})`,
  )
  for (const p of Object.values(r.presets)) {
    console.log(
      `  ${p.id.padEnd(15)} f8=${pct(p.f)} onset=${pct(p.fOnset)} f24=${pct(p.minF24h)} f72=${pct(p.minF72h)}` +
        `  lock=${hrs(p.lockH)}${p.lockCensored ? '+' : ''}h locked72=${hrs(p.lockedHours72h)}h` +
        ` rec5=${hrs(p.recover5H, p.recoverLowerBoundH)}h${p.horizonCensored ? '(data end)' : ''} cash8=${usd(p.cashUsd8h)}` +
        `  rank ${p.rank}/${p.n}  ← ${p.source.name} @ ${p.source.onsetIso} [${p.source.windowId}]`,
    )
  }
}
const books = cashVsBookAnalogs(
  series,
  windows,
  EXIT_CAPACITY_BOOKS.map((b) => b.usd),
  { priceUsd },
)
console.log(`\ncash vs book (headline) · m = min(1, held idle cash / book) over the 8 h window`)
for (const r of books.rows) {
  if (!r.presets) {
    console.log(`${r.name.padEnd(16)} ${usd(r.bookUsd)} n=0`)
    continue
  }
  console.log(
    `${r.name} · ${usd(r.bookUsd)} book · n=${r.n}` +
      Object.values(r.presets)
        .map(
          (p) =>
            `  ${p.id.split('-')[0]} m=${pct(p.m)} lock=${hrs(p.lockH)}${p.lockCensored ? '+' : ''}h cash8=${usd(p.cashUsd8h)} ← ${p.source.name}`,
        )
        .join(''),
  )
}

console.log(
  `\nbounds: frozen f=${table.bounds.frozen.f} (${table.bounds.frozen.kind}); ` +
    `optimistic f=${table.bounds.optimistic.f} (${table.bounds.optimistic.kind}, default ${table.bounds.optimistic.isDefault})`,
)

const eventsOf = arg('events')
if (eventsOf) {
  const r = table.rows.find((x) => x.venue === eventsOf)
  if (!r) throw new Error(`no venue ${eventsOf}`)
  console.log(`\n${r.name} events, worst first:`)
  for (const e of r.events) {
    const w = e.worst
    console.log(
      `  ${w.onsetIso} f8=${pct(w.minF.h8)} held8=${pct(w.minFHeld.h8)} onset=${pct(w.fOnset)} f72=${pct(w.minF.h72)}` +
        ` lock=${hrs(w.lockH)}h rec5=${hrs(w.recover5H, w.recoverLowerBoundH)}h gap8=${w.maxGapH8h.toFixed(1)}h` +
        `  ${e.name} [${w.windowId}; ${e.memberIds.length} windows]`,
    )
  }
  if (r.skipped.length)
    console.log(`  skipped: ${r.skipped.map((x) => `${x.windowId}:${x.reason}`).join(', ')}`)
}

const out = arg('out')
if (out) {
  const slim = {
    ...table,
    rows: table.rows.map((r) => ({
      ...r,
      events: r.events.map(({ members: _members, ...e }) => e),
    })),
  }
  fs.writeFileSync(path.resolve(out), JSON.stringify(slim, null, 1))
  console.log(`\nwrote ${out}`)
}

if (process.argv.includes('--emit-presets')) {
  const floor = exitCapacityAnalogRows(table)
  const book = exitCapacityBookRows(books)
  const file = path.join(ROOT, 'lib/position-sim/exitCapacityAnalogs.ts')
  const src = fs.readFileSync(file, 'utf8')
  const open = '// <generated:exit-capacity-analogs>\n'
  const close = '// </generated:exit-capacity-analogs>'
  const a = src.indexOf(open)
  const b = src.indexOf(close)
  if (a < 0 || b < a) throw new Error(`${file}: generated markers not found`)
  const through = new Date(history.timeline.t[history.timeline.t.length - 1] * 1000)
    .toISOString()
    .slice(0, 16)
  const body =
    `/** The venue stress history the rows were measured on runs through this hour (UTC). */\n` +
    `export const EXIT_CAPACITY_ANALOG_DATA_THROUGH = '${through}Z'\n\n` +
    `/** ${windows.length} stress windows (named, ETH −10%/24 h drops, utilisation ≥ the venue's stress level). */\n` +
    `export const EXIT_CAPACITY_ANALOG_WINDOW_COUNT = ${windows.length}\n\n` +
    `/** The HEADLINE: cash vs book, m = min(1, held idle cash / book), per venue × book × level. */\n` +
    `export const EXIT_CAPACITY_BOOK_ROWS: readonly ExitCapacityBookRow[] = ${JSON.stringify(book, null, 2)}\n\n` +
    `/** The FLOOR: pro-rata, every depositor exits at once (mult = f), per venue × level. */\n` +
    `export const EXIT_CAPACITY_FLOOR_ROWS: readonly ExitCapacityFloorRow[] = ${JSON.stringify(floor, null, 2)}\n`
  fs.writeFileSync(file, src.slice(0, a + open.length) + body + src.slice(b))
  console.log(
    `\nwrote ${book.length} cash-vs-book + ${floor.length} floor preset rows to ${path.relative(ROOT, file)}`,
  )
}
