// THE TODAY EDITION — its words and the figures in them. Pure: no React, so the unit tests
// import it in node. Every figure is read from lib/regime/m0Thresholds.generated.json (the
// builder's aggregate of membrane-datasets price-history) or from lib/regime/m0.ts.

import { GUARANTEE } from '@/lib/position-sim/guarantee'
import { HOUR_MS, M0_COVERAGE_WINDOW, M0_MAX_INPUT_AGE_MS, M0_MIN_COVERAGE } from '@/lib/regime/m0'
import { M0_THRESHOLDS_FILE, type M0ThresholdsFile } from '@/lib/regime/thresholds'

/**
 * The owner's masthead line (a comment on the newspaper canvas, 2026-10-11). It is
 * LANDING_TAGLINE in lib/position-sim/guarantee.ts on feat/newspaper-landing, which is not
 * on this base; import that constant instead once the branches meet.
 */
export const TAGLINE = `${GUARANTEE.name} Cross the line with time to spare.`

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The dateline's longest date, "Wed 14 Oct 2026": the slot is reserved at this width. */
export const DATELINE_MAX_CHARS = 15

/** Local calendar day as "2026-10-14": a stable snapshot (it only changes at midnight). */
export function localIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** "2026-10-14" → "Wed 14 Oct 2026". Fixed names, so the width never depends on the ICU. */
export function datelineLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return `${WEEKDAYS[date.getDay()]} ${d} ${MONTHS[m - 1]} ${y}`
}

/** "15 Jan 2020" from a UTC ISO stamp. */
const utcDay = (iso: string) => {
  const d = new Date(iso)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}
const pct2 = (v: number) => `${(v * 100).toFixed(2)}%`
const count = (n: number) => n.toLocaleString('en-US')

/** "How the regime is set": the M0 rule as label/value rows. */
export function regimeRows(
  t: M0ThresholdsFile = M0_THRESHOLDS_FILE,
): { label: string; value: string }[] {
  return [
    { label: 'Choppy when', value: 'either test fires in the last 24h' },
    { label: 'ETH 24h move', value: `≥ ${pct2(t.move24hP95)} (p95) · n ${count(t.n.move24h)}` },
    {
      label: 'Chainlink vs Coinbase',
      value: `≥ ${pct2(t.gapP999)} apart (${t.gapQuantile}) · n ${count(t.n.gap)}`,
    },
    { label: 'History', value: `hourly, ${utcDay(t.period.from)} – ${utcDay(t.period.to)}` },
    { label: 'Hold', value: 'Holds 24h after the last trigger' },
    { label: 'Liquidation volume', value: 'Not counted — no live source' },
    {
      label: 'Withheld when',
      value: `an input is over ${M0_MAX_INPUT_AGE_MS / HOUR_MS}h old, or under ${M0_MIN_COVERAGE} of ${M0_COVERAGE_WINDOW}h have both prices`,
    },
  ]
}

/** The method table's provenance credit. */
export function regimeCredit(t: M0ThresholdsFile = M0_THRESHOLDS_FILE): string {
  return `membrane-datasets ${t.source.path} · sha256 ${t.source.sha256.slice(0, 8)} · measured`
}
