#!/usr/bin/env node
/**
 * Builds components/Borrow/data/drawdownHistory.json, the history counts behind
 * the Borrow page sizing panel (board ruling Q26-S1).
 *
 * Inputs (membrane-datasets, history-forecasts/s1-sizing):
 *   - nonchain.json: output of review/nonchain.py. NON-OVERLAPPING H-window counts of
 *     "the hourly low fell at least d below the prior close within H", daily 00:00Z
 *     origins from 2017-09-01. nonchain.py's json.dump goes to /dev/null (its exec of
 *     history_freq.py rebinds OUT), so build nonchain.json from its stdout: each line is
 *     `<SYM>|<H>|<d> {python dict}`; parse with ast.literal_eval. The review corrected the author's chained-episode
 *     counts to these (chaining merged most of 2018 into one ETH 30 d episode).
 *   - review/out/history_freq.json: the named stress events (worst drop inside the
 *     window for Mar 2020, Aug 2024, Oct 2025).
 *
 * Usage:
 *   node scripts/build-drawdown-history.mjs <nonchain.json> <history_freq.json> \
 *     <datasets commit sha> [out json]
 *
 * The output keeps only what the panel shows. Re-run it when the dataset is refreshed;
 * the unit test checks the shape and a few anchor counts the review quotes.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [nonchainPath, freqPath, datasetsSha, outArg] = process.argv.slice(2)
if (!nonchainPath || !freqPath || !datasetsSha) {
  console.error(
    'usage: build-drawdown-history.mjs <nonchain.json> <history_freq.json> <datasets sha> [out]',
  )
  process.exit(2)
}
const out =
  outArg ??
  path.join(
    path.dirname(new URL(import.meta.url).pathname),
    '..',
    'components/Borrow/data/drawdownHistory.json',
  )

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const nonchain = JSON.parse(readFileSync(nonchainPath, 'utf8'))
const freq = JSON.parse(readFileSync(freqPath, 'utf8'))

const UNDERLYINGS = { ETH: 'ETHUSDT', BTC: 'BTCUSDT' }
const HORIZONS = { 1: 24, 7: 168, 30: 720 } // days -> hours
const LEVELS = [15, 20, 25, 30, 40] // percent; the grid review/nonchain.py counts
const EVENTS = [
  { id: 'mar-2020', label: 'Mar 2020', key: '2020-03 covid' },
  { id: 'aug-2024', label: 'Aug 2024', key: '2024-08 yen carry' },
  { id: 'oct-2025', label: 'Oct 2025', key: '2025-10 Oct 10 liquidations' },
]

const counts = {}
const stress = {}
for (const [u, sym] of Object.entries(UNDERLYINGS)) {
  counts[u] = {}
  stress[u] = {}
  const events = freq.series?.[`spot|${sym}`]?.events
  if (!events) throw new Error(`history_freq.json has no spot|${sym} events`)
  for (const [days, hours] of Object.entries(HORIZONS)) {
    counts[u][days] = {}
    for (const lvl of LEVELS) {
      // nonchain.py writes Python float keys: 0.15, 0.2, 0.25, 0.3, 0.4
      const cell = nonchain[`${sym}|${hours}|${lvl / 100}`]
      if (!cell || !Number.isInteger(cell.nonoverlap))
        throw new Error(`nonchain.json missing ${sym}|${hours}|${lvl / 100}`)
      counts[u][days][lvl] = cell.nonoverlap
    }
    stress[u][days] = EVENTS.map((e) => {
      const drop = events[e.key]?.[String(hours)]
      if (typeof drop !== 'number')
        throw new Error(`history_freq.json missing ${sym} ${e.key} ${hours}h`)
      // drop: the measured fraction (4 dp, used for the "would reach your line" test);
      // dropPct: whole percent for display, rounded as the S1 README tables round it.
      return { id: e.id, label: e.label, drop, dropPct: Math.round(drop * 100) }
    })
  }
}

const doc = {
  what: 'HISTORY, not a forecast. Non-overlapping H-day windows since 2017-09-01 in which the Binance hourly low fell at least d below the prior hourly close (daily 00:00Z origins).',
  source: {
    venue: 'Binance spot ETHUSDT / BTCUSDT 1h klines (data-api.binance.vision)',
    span: 'Sep 2017 – Oct 2026',
    dataFetched: '2026-10-27 to 21:00Z',
    datasetsRepo: 'membrane-datasets',
    datasetsCommit: datasetsSha,
    countsFile:
      'history-forecasts/s1-sizing/review/nonchain.py -> nonchain.json (field nonoverlap)',
    countsSha256: sha256(nonchainPath),
    countsNote:
      'nonchain.py is not committed with its output and writes it to /dev/null (its exec of history_freq.py rebinds OUT); nonchain.json is its printed dicts parsed back into JSON, run on the Binance data fetched 2026-10-27',
    eventsFile: 'history-forecasts/s1-sizing/review/out/history_freq.json (series spot|*.events)',
    eventsSha256: sha256(freqPath),
    generator: 'scripts/build-drawdown-history.mjs',
  },
  levels: LEVELS,
  horizons: Object.keys(HORIZONS).map(Number),
  counts,
  stress,
}

// Format with the repo's prettier config so a re-run reproduces the committed file byte for byte.
const prettier = await import('prettier')
const text = await prettier.format(JSON.stringify(doc), {
  ...(await prettier.resolveConfig(out)),
  parser: 'json',
})
writeFileSync(out, text)
console.log(`wrote ${out}`)
