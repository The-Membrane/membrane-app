/**
 * exit-readout-levels — writes the exit readout's stress levels (lib/position-sim/exitReadout.ts,
 * between its generated markers): per venue, the typical, bad (p10) and worst stress event by
 * held idle cash over the 8 h from onset, on the engine's events (stressEventCash.ts).
 *
 * Run (from the repo root), then run prettier on the file:
 *   ./node_modules/.bin/tsx scripts/position-sim/exit-readout-levels.ts [--emit]
 * Without --emit it prints the rows. Reads public/data/venue-stress/{history,summary}.json.
 * tests/unit/exitReadout.test.ts recomputes the rows from the same data and fails on drift.
 */
import fs from 'node:fs'
import path from 'node:path'

import { EXIT_CAPACITY_ANALOG_VENUES } from '../../lib/position-sim/exitCapacityAnalogs'
import { exitReadoutCashRows } from '../../lib/position-sim/stressEventCash'
import {
  VENUE_DEFAULT_STRESS_UTIL,
  stressWindowsFromEpisodes,
  utilWindowsFromSeries,
  venueSeriesFromHistory,
  type VenueStressEpisode,
  type VenueStressHistoryFile,
} from '../../lib/position-sim/venueStressAnalogs'

const ROOT = path.resolve(__dirname, '../..')
const readJson = <T>(rel: string): T =>
  JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')) as T

const history = readJson<VenueStressHistoryFile>('public/data/venue-stress/history.json')
const summary = readJson<{
  method: { minSize: Record<string, number>; stressUtil: Record<string, number> }
  episodes: VenueStressEpisode[]
}>('public/data/venue-stress/summary.json')

const series = venueSeriesFromHistory(history, { minSize: summary.method.minSize })
const derivedUtil = series
  .filter((s) => summary.method.stressUtil[s.venue] === undefined)
  .flatMap((s) => utilWindowsFromSeries(s, VENUE_DEFAULT_STRESS_UTIL))
const windows = stressWindowsFromEpisodes(summary.episodes, derivedUtil)
const rows = exitReadoutCashRows(series, windows, EXIT_CAPACITY_ANALOG_VENUES)

if (!process.argv.includes('--emit')) {
  for (const r of rows) {
    console.log(
      `${r.venue.padEnd(24)} n=${r.events}  ` +
        Object.entries(r.cash8)
          .map(([l, x]) => `${l} ${x.cash} ${r.symbol} (${x.event}, ${x.onset})`)
          .join('  '),
    )
  }
} else {
  const file = path.join(ROOT, 'lib/position-sim/exitReadout.ts')
  const src = fs.readFileSync(file, 'utf8')
  const open = '// <generated:exit-readout-levels>'
  const close = '// </generated:exit-readout-levels>'
  const a = src.indexOf(open)
  const b = src.indexOf(close)
  if (a < 0 || b < a) throw new Error(`${file}: generated markers not found`)
  const table = Object.fromEntries(rows.map((r) => [r.venue, r]))
  const body =
    `\n/** Held idle cash over the 8 h from onset at each venue's typical, bad (p10) and worst\n` +
    ` *  stress event, token units (WETH in ETH). ${rows.length} venues. */\n` +
    `export const EXIT_READOUT_VENUE_LEVELS = ${JSON.stringify(table, null, 2)} as const satisfies Record<string, ExitReadoutCashRow>\n`
  fs.writeFileSync(file, src.slice(0, a + open.length) + body + src.slice(b))
  console.log(`wrote ${rows.length} venues to ${path.relative(ROOT, file)}`)
}
