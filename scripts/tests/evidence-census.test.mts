/**
 * The Evidence page and the landing on the FULL on-chain census of 10-11 Oct 2025
 * (public/data/oct10-2025/evidence-census.json, built by scripts/build-evidence-census.ts).
 *
 *   npx tsx scripts/tests/evidence-census.test.mts
 *
 * Three parts, each against the REAL served file:
 *   1. integrity — every summary figure is the sum of its rows; the rows' totals equal the
 *      census's own totals (census.meta.totals, recorded in meta.source.totals; and, when the
 *      datasets clone is present, census.json itself, by sha256 and by value); the headline
 *      file the landing imports agrees with the full file;
 *   2. the lens text — DebtLens, TimeLens, CohortLens, ForecastGate and the landing copy in
 *      facts.ts render with the census figures, the split beside every blended figure, and a
 *      † on the Membrane side;
 *   3. the filters and sorts the cohort table drives, over all 3,197 positions.
 *
 * It renders components with renderToStaticMarkup (no browser), like the old
 * scripts/tests/evidence.test.mts it replaces for the UI.
 */
import assert from 'node:assert'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChakraProvider } from '@chakra-ui/react'

import type { CohortRow, EvidenceFile } from '@/components/Evidence/types'

// Dynamic imports: tsx's static-import hoisting resolves these JSX modules before
// they finish evaluating and reports a phantom "no export named" error.
const { DebtLens } = await import('@/components/Evidence/DebtLens')
const { TimeLens } = await import('@/components/Evidence/TimeLens')
const { CohortLens } = await import('@/components/Evidence/CohortLens')
const { ForecastGate } = await import('@/components/Evidence/ForecastGate')
const { decodeEvidence, sparedUsd, compareRow, summaryOf } =
  await import('@/components/Evidence/types')
const { useCohort, matchesOutcome } = await import('@/components/Evidence/useEvidence')
const { evidenceDescription } = await import('@/components/Evidence/seo')
const { CLOSE, HERO_VARIANTS } = await import('@/components/Seniority/facts')

const FILE = 'public/data/oct10-2025/evidence-census.json'
const file: EvidenceFile = JSON.parse(fs.readFileSync(FILE, 'utf8'))
const headline = JSON.parse(
  fs.readFileSync('public/data/oct10-2025/evidence-census-headline.json', 'utf8'),
)
const doc = decodeEvidence(file)
const rows = doc.cohort
const D = doc.debt
const T = doc.time

const render = (el: React.ReactElement) =>
  renderToStaticMarkup(React.createElement(ChakraProvider, null, el))

let checks = 0
const ok = (cond: unknown, what: string) => {
  assert.ok(cond, what)
  checks++
}
const eq = (a: unknown, b: unknown, what: string) => {
  assert.deepStrictEqual(a, b, what)
  checks++
}
const near = (a: number, b: number, what: string, tol = 0.011) => {
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`)
  checks++
}
const has = (html: string, needle: string, what: string) => {
  assert.ok(html.includes(needle), `${what}: expected to find ${JSON.stringify(needle)}`)
  checks++
}
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const usdM = (x: number) => `$${(x / 1e6).toFixed(1)}M`

// ============================================================ 1. integrity
const protoOf = { aave: 'aave-v3', morpho: 'morpho-blue' } as const
const setRows = (k: string) =>
  k === 'all'
    ? rows
    : k === 'aave-v3' || k === 'morpho-blue'
      ? rows.filter((r) => protoOf[r.protocol] === k)
      : rows.filter(
          (r) =>
            `${protoOf[r.protocol]}${r.protocol === 'aave' ? `:${r.market}` : ''}:${r.chain}` === k,
        )

// The served file is the census: same count, nothing excluded, every position walked.
eq(rows.length, doc.meta.positions, 'cohort length == meta.positions')
eq(doc.meta.walked, doc.meta.positions, 'every position walked')
eq(new Set(rows.map((r) => r.id)).size, rows.length, 'row ids are unique')
eq(sum(rows.map((r) => r.events)), doc.meta.events, 'events: rows sum to meta.events')

// Every debt set is the sum of its rows, and equals census.meta.totals.
const sets = [
  ['all', D.all],
  ['aave-v3', D.byProtocol['aave-v3']],
  ['morpho-blue', D.byProtocol['morpho-blue']],
  ...D.byVenueChain.map((v) => [v.key, v] as const),
] as const
for (const [k, s] of sets) {
  const rs = setRows(k)
  const census = doc.meta.source.totals[k]
  ok(census, `census total exists for ${k}`)
  eq(s.positions, rs.length, `${k}: positions == rows`)
  eq(s.positions, census.positions, `${k}: positions == census.meta.totals`)
  eq(s.events, census.events, `${k}: events == census.meta.totals`)
  near(s.realRepaidUsd, sum(rs.map((r) => r.realRepaidUsd)), `${k}: real repaid == rows`, 0.05)
  near(s.memRepaidUsd, sum(rs.map((r) => r.memRepaidUsd)), `${k}: Membrane repaid == rows`, 0.05)
  near(s.realRepaidUsd, census.realRepaidUsd, `${k}: real repaid == census.meta.totals`)
  near(s.memRepaidUsd, census.memRepaidUsd, `${k}: Membrane repaid == census.meta.totals`)
  near(s.gapUsd, s.realRepaidUsd - s.memRepaidUsd, `${k}: gap == real - Membrane`)
  eq(s.memNeverSold, census.positionsKept, `${k}: never sold == census positionsKept`)
  eq(s.gridEnd.positions, census.positionsSoldAtGridEnd, `${k}: grid end == census`)
  // The per-position comparison partitions the set.
  const cmp = rs.map(compareRow)
  eq(
    [s.less, s.more, s.equal, s.unpricedPositions],
    [
      cmp.filter((c) => c === 'less').length,
      cmp.filter((c) => c === 'more').length,
      cmp.filter((c) => c === 'equal').length,
      cmp.filter((c) => c === 'unpriced').length,
    ],
    `${k}: less / more / equal / unpriced recount from the rows`,
  )
  eq(s.less + s.more + s.equal + s.unpricedPositions, s.positions, `${k}: they partition`)
}
// The two protocols partition the census, and so do the venue x chain rows.
eq(
  D.byProtocol['aave-v3'].positions + D.byProtocol['morpho-blue'].positions,
  D.all.positions,
  'Aave + Morpho == all',
)
near(
  sum(D.byVenueChain.map((v) => v.realRepaidUsd)),
  D.all.realRepaidUsd,
  'venue x chain rows sum to all (real)',
  0.05,
)
near(
  sum(D.byVenueChain.map((v) => v.memRepaidUsd)),
  D.all.memRepaidUsd,
  'venue x chain rows sum to all (Membrane)',
  0.05,
)

// The headline figures the owner verified (2026-10-16).
eq(D.all.positions, 3197, '3,197 positions')
eq(D.byProtocol['aave-v3'].positions, 2421, '2,421 Aave positions')
eq(D.byProtocol['morpho-blue'].positions, 776, '776 Morpho positions')
eq(usdM(D.all.realRepaidUsd), '$188.1M', 'protocols closed $188.1M')
eq(usdM(D.all.memRepaidUsd), '$157.1M', 'Membrane $157.1M')
eq(D.all.gapPct.toFixed(1), '16.5', '16.5% less')
eq(D.byProtocol['aave-v3'].gapPct.toFixed(1), '5.8', 'Aave 5.8% less')
eq(D.byProtocol['morpho-blue'].gapPct.toFixed(1), '56.1', 'Morpho 56.1% less')
near(doc.meta.crossCheck.new.memRepaidUsd, 13133229.25, 'cross-check: $13.13M on the 747 rows')
near(doc.meta.crossCheck.old.memRepaidUsd, 22204493.19, 'cross-check: the old $22.20M')

// Outcomes partition the census and equal census.meta.outcomes.
eq(T.outcomes, doc.meta.source.outcomes, 'outcomes == census.meta.outcomes')
eq(sum(Object.values(T.outcomes)), rows.length, 'outcomes partition the census')
for (const [o, n] of Object.entries(T.outcomes)) {
  eq(rows.filter((r) => r.outcome === o).length, n, `outcome ${o} recounts from the rows`)
}
eq(T.neverSold.positions, rows.filter((r) => r.sales === 0).length, 'never sold == sales 0')

// Grid end: marked rows, their USD, and the outcome bucket of positions first sold there.
const ge = rows.filter((r) => r.gridEndUsd != null)
eq(ge.length, doc.meta.gridEnd.positions, 'grid-end rows == meta.gridEnd.positions')
near(sum(ge.map((r) => r.gridEndUsd!)), doc.meta.gridEnd.memRepaidUsd, 'grid-end USD == rows', 0.05)
ok(
  rows.filter((r) => r.outcome === 'sold-at-grid-end').every((r) => r.gridEndUsd != null),
  'every position first sold at the grid end is marked',
)

// Unpriced positions: in every count, in no dollar figure.
const unpriced = rows.filter((r) => !r.priced)
eq(unpriced.length, doc.meta.unpriced.positions, 'unpriced count')
ok(
  unpriced.every((r) => r.protocol === 'morpho' && r.realRepaidUsd === 0 && r.memRepaidUsd === 0),
  'unpriced positions are Morpho and carry no dollars',
)
ok(
  unpriced.every((r) => r.realFrac === null && r.memFrac === null),
  'and no fractions',
)

// The cure diagnostic recounts from the rows (the old builder's definition, all positions).
const cured = rows.filter((r) => r.cure)
eq(T.cure.accountsAnalysed, cured.length, 'cure: positions analysed')
eq(T.cure.curedInWindow, cured.filter((r) => r.cure!.curedInWindow).length, 'cure: cured')
eq(T.cure.healthyAt8h, cured.filter((r) => r.cure!.healthyAt8h).length, 'cure: healthy at 8h')
ok(
  cured.every((r) => !r.cure!.curedInWindow || r.cure!.bestLtv <= r.line + 1e-5),
  'cured means the best LTV is at or under the line',
)
ok(
  cured.every((r) => !(r.cure!.noWindow && r.cure!.curedInWindow)),
  'a position with no window is never counted cured',
)
eq(
  cured.filter((r) => r.cure!.noWindow).length,
  rows.filter((r) => r.delayClass === 'no-delay').length,
  'no window == the no-delay class',
)

// byAsset: per primary leg, >= 20 positions, recounted.
for (const a of doc.byAsset) {
  const rs = rows.filter((r) => r.primary === a.symbol)
  eq(a.positions, rs.length, `byAsset ${a.symbol} positions`)
  eq(a.aave + a.morpho, a.positions, `byAsset ${a.symbol} split`)
  ok(a.positions >= 20, `byAsset ${a.symbol} >= 20`)
}

// The headline file the landing imports is the same census.
eq(headline.censusSha256, doc.meta.source.sha256, 'headline file: same census sha256')
eq(headline.positions, D.all.positions, 'headline file: positions')
eq(headline.all.realRepaidUsd, D.all.realRepaidUsd, 'headline file: real')
eq(headline.all.memRepaidUsd, D.all.memRepaidUsd, 'headline file: Membrane')
eq(headline.aave.gapPct, D.byProtocol['aave-v3'].gapPct, 'headline file: Aave gap')
eq(headline.morpho.gapPct, D.byProtocol['morpho-blue'].gapPct, 'headline file: Morpho gap')

// Served size: a client fetch, not a download.
const bytes = fs.statSync(FILE).size
ok(bytes < 1_200_000, `the served file stays under 1.2 MB (${bytes.toLocaleString('en-US')} B)`)

// The canonical census, when the datasets clone is here (rule N18). Its sha256 and its
// totals must be the ones recorded; without the clone, the recorded totals above stand.
const dsDir = path.resolve(process.env.MEMBRANE_DATASETS_DIR ?? '../membrane-datasets')
const censusPath = path.join(dsDir, 'oct10-2025', 'coverage', 'census.json')
let censusChecked = false
if (fs.existsSync(censusPath)) {
  const buf = fs.readFileSync(censusPath)
  eq(createHash('sha256').update(buf).digest('hex'), doc.meta.source.sha256, 'census.json sha256')
  const census = JSON.parse(buf.toString('utf8'))
  near(D.all.realRepaidUsd, census.meta.totals.all.realWalked.repaidUsd, 'census.json real')
  near(D.all.memRepaidUsd, census.meta.totals.all.mem.repaidUsd, 'census.json Membrane')
  eq(census.rows.length, rows.length, 'census.json rows')
  censusChecked = true
}

// ============================================================ 2. the lens text
const debtHtml = render(
  React.createElement(DebtLens, { debt: D, byAsset: doc.byAsset, meta: doc.meta }),
)
has(debtHtml, '3,197', 'DebtLens: positions')
has(debtHtml, '$188.1M', 'DebtLens: protocols closed')
has(debtHtml, '$157.1M†', 'DebtLens: Membrane, marked modelled')
has(debtHtml, '16.5% less debt closed†', 'DebtLens: the direction and size of the gap')
has(debtHtml, 'Aave V3', 'DebtLens: the Aave row of the split')
has(debtHtml, 'Morpho Blue', 'DebtLens: the Morpho row of the split')
has(debtHtml, '5.8% less', 'DebtLens: Aave gap')
has(debtHtml, '56.1% less', 'DebtLens: Morpho gap')
has(debtHtml, '$148.2M', 'DebtLens: Aave closed')
has(debtHtml, '$17.5M†', 'DebtLens: Morpho Membrane')
for (const v of D.byVenueChain) has(debtHtml, v.label, `DebtLens: per-chain row ${v.label}`)
has(debtHtml, `${D.all.more.toLocaleString('en-US')}`, 'DebtLens: Membrane closes more count')
has(debtHtml, `${D.all.less.toLocaleString('en-US')}`, 'DebtLens: Membrane closes less count')
has(debtHtml, 'window was still', 'DebtLens: the grid-end sales are stated')
has(debtHtml, `${doc.meta.gridEnd.positions} positions`, 'DebtLens: grid-end count')
has(debtHtml, 'no USD price', 'DebtLens: the unpriced positions are stated')
has(debtHtml, 'WETH', 'DebtLens: per-asset table')
ok(!/2,347|\b747\b|36\.0%|\$34\.7M|\$22\.2M/.test(debtHtml), 'DebtLens: no old-census figure')
checks++

const timeHtml = render(React.createElement(TimeLens, { time: T, meta: doc.meta }))
has(timeHtml, '0s', 'TimeLens: the protocols grant zero')
has(timeHtml, '8h', 'TimeLens: Membrane window')
has(timeHtml, 'within 4% of the line · none for stablecoins†', 'TimeLens qualifies the 8h')
has(timeHtml, `${T.cure.curedPct}%`, 'TimeLens: cured pct, recomputed on the census')
has(timeHtml, `${T.cure.healthyAt8hPct}%`, 'TimeLens: healthy-at-8h pct')
has(timeHtml, `median ${T.cure.medianMinutesToCure} min`, 'TimeLens: median minutes')
has(timeHtml, `${usdM(T.oneRepay.delayCreditUsd)}†`, 'TimeLens: delay credit, modelled')
has(timeHtml, `${T.neverSold.positions.toLocaleString('en-US')}`, 'TimeLens: never sold')
has(timeHtml, 'Window still open when the data ends', 'TimeLens: grid end apart')
has(timeHtml, `band 2%`, 'TimeLens: band sensitivity')
for (const b of T.bandSensitivity)
  has(timeHtml, `${usdM(b.memRepaidUsd)}†`, `TimeLens: band ${b.band}`)
has(timeHtml, 'nobody clears the timer early', 'TimeLens: the early-clear corner')
has(
  timeHtml,
  `changed in ${T.freshPrints.minutes.toLocaleString('en-US')} of ${T.freshPrints.gridMinutes.toLocaleString('en-US')} minutes`,
  'TimeLens: fresh prints, recomputed on the AaveOracle path',
)
{
  const at = timeHtml.indexOf('Stablecoin collateral (or a line above 90%)')
  const n = (T.outcomes['sold-no-delay'] ?? 0).toLocaleString('en-US')
  ok(at >= 0 && timeHtml.slice(at, at + 1500).includes(`>${n}<`), `no-delay step renders ${n}`)
}
ok(!/183 of|69\.88%|2,347/.test(timeHtml), 'TimeLens: no old-census figure')
checks++

const gateHtml = render(
  React.createElement(ForecastGate, {
    realMedianFrac: D.all.medians.all.realMedianFrac,
    membraneMedianFrac: D.all.medians.all.memMedianFrac,
    split: [],
    positions: D.all.medians.all.positions,
    membraneMore: D.all.more,
  }),
)
has(
  gateHtml,
  `Answered on ${D.all.medians.all.positions.toLocaleString('en-US')} real positions`,
  'ForecastGate: the count is the census',
)
has(gateHtml, 'Aave or Morpho', 'ForecastGate: both protocols')

const cohortHtml = render(React.createElement(CohortLens, { rows }))
has(
  cohortHtml,
  `Showing 100 of ${rows.length.toLocaleString('en-US')}`,
  'CohortLens states its cap',
)
has(cohortHtml, 'Membrane worse', 'CohortLens exposes the losing filter')
has(cohortHtml, 'window open at data end', 'CohortLens: the grid-end filter')
has(cohortHtml, 'Morpho Blue', 'CohortLens: the protocol filter')
const top = [...rows].sort((a, b) => (b.debtUsd ?? -1) - (a.debtUsd ?? -1))[0]
has(
  cohortHtml,
  `${top.primary}${top.coll.length > 1 ? `+${top.coll.length - 1}` : ''}/${top.debt[0][0]}${top.debt.length > 1 ? `+${top.debt.length - 1}` : ''}`,
  'CohortLens default sort = largest debt',
)

// SEO: the description is the census's, and carries the split.
const desc = evidenceDescription(summaryOf(file))
has(desc, '$188.1M', 'SEO: protocols closed')
has(desc, '$157.1M on Membrane (modelled)', 'SEO: Membrane, marked modelled')
has(desc, 'Aave 5.8% less, Morpho 56.1% less', 'SEO: the split')
ok(!/71%|17\.8%/.test(desc), 'SEO: the stale median figures are gone')
checks++

// The landing copy (facts.ts): derived from the census, the split on every blended line.
const bridge = HERO_VARIANTS.c.bridge.line
has(bridge, '3,197 positions on Aave and Morpho', 'landing bridge: the census')
has(bridge, '$188.1M', 'landing bridge: protocols closed')
has(bridge, '$157.1M†', 'landing bridge: Membrane, modelled')
has(bridge, 'Aave 5.8% less, Morpho 56.1% less', 'landing bridge: the split')
has(bridge, 'own oracle read on chain', 'landing bridge: names the oracle')
for (const v of Object.values(HERO_VARIANTS)) {
  ok(
    !/747|36%|Chainlink/.test(v.bridge.line),
    'no hero variant keeps the old 747 / 36% / Chainlink line',
  )
}
has(CLOSE.headline, '3,197', 'Close headline: the census count')
const lines = CLOSE.contains.lines.join('\n')
has(lines, 'Aave V3: 2,421 positions', 'Close: the Aave split')
has(lines, 'Morpho Blue: 776 positions', 'Close: the Morpho split')
has(lines, `${doc.meta.gridEnd.positions} positions were still inside`, 'Close: grid end')
has(
  lines,
  `${D.all.more.toLocaleString('en-US')} positions lose more on Membrane†`,
  'Close: losses',
)
ok(
  !/2,347|\b747\b|\b290\b|\b110\b|\b184\b|\$34\.7M|\$22\.2M/.test(lines),
  'Close: no old-census figure',
)
checks++

// ============================================================ 3. the filters
function probe(opts: Parameters<typeof useCohort>[1]) {
  let out: ReturnType<typeof useCohort> | null = null
  const P: React.FC = () => {
    out = useCohort(rows, opts)
    return null
  }
  renderToStaticMarkup(React.createElement(P))
  return out!
}
const base = {
  asset: 'all',
  chain: 'all',
  protocol: 'all' as const,
  outcome: 'all' as const,
  sort: 'debtUsd' as const,
  limit: 100,
}
const all = probe(base)
eq([all.total, all.matched, all.visible.length], [rows.length, rows.length, 100], 'unfiltered')

const less = probe({ ...base, outcome: 'membraneLess' })
const more = probe({ ...base, outcome: 'membraneMore' })
const equal = probe({ ...base, outcome: 'equal' })
eq(less.matched, D.all.less, '"Membrane closes less" == debt.all.less')
eq(more.matched, D.all.more, '"Membrane worse" == debt.all.more')
eq(equal.matched, D.all.equal, '"equal" == debt.all.equal')
eq(
  less.matched + more.matched + equal.matched + D.all.unpricedPositions,
  rows.length,
  'they partition',
)

const curedF = probe({ ...base, outcome: 'cured' })
eq(curedF.matched, T.cure.curedInWindow, '"cured in 8h" == time.cure.curedInWindow')
const notCured = probe({ ...base, outcome: 'notCured' })
eq(
  curedF.matched + notCured.matched + T.cure.noDelay.accounts,
  T.cure.accountsAnalysed,
  'cured + never cured + no window == analysed',
)
const gridEnd = probe({ ...base, outcome: 'gridEnd' })
eq(gridEnd.matched, doc.meta.gridEnd.positions, '"window open at data end" == meta.gridEnd')

for (const [p, k] of [
  ['aave', 'aave-v3'],
  ['morpho', 'morpho-blue'],
] as const) {
  const x = probe({ ...base, protocol: p })
  eq(x.matched, D.byProtocol[k].positions, `protocol filter ${p}`)
  ok(
    x.visible.every((r: CohortRow) => r.protocol === p),
    `protocol filter ${p} is exclusive`,
  )
}
for (const v of D.byVenueChain) {
  const x = probe({
    ...base,
    chain: v.chain,
    protocol: v.protocol === 'aave-v3' ? 'aave' : 'morpho',
  })
  const expected = D.byVenueChain
    .filter((w) => w.chain === v.chain && w.protocol === v.protocol)
    .reduce((a, w) => a + w.positions, 0)
  eq(x.matched, expected, `chain + protocol filter ${v.key}`)
}
const weth = probe({ ...base, asset: 'WETH' })
eq(weth.matched, doc.byAsset.find((a) => a.symbol === 'WETH')!.positions, 'asset filter == byAsset')
ok(
  weth.visible.every((r: CohortRow) => r.primary === 'WETH'),
  'asset filter is exclusive',
)

const byDebt = probe(base).visible
ok(
  byDebt.every((r, i) => i === 0 || (byDebt[i - 1].debtUsd ?? -1) >= (r.debtUsd ?? -1)),
  'sort: debt desc',
)
const bySpared = probe({ ...base, sort: 'spared' }).visible
ok(
  bySpared.every(
    (r, i) => i === 0 || (sparedUsd(bySpared[i - 1]) ?? -Infinity) >= (sparedUsd(r) ?? -Infinity),
  ),
  'sort: spared desc',
)
const byEvents = probe({ ...base, sort: 'events' }).visible
eq(byEvents[0].events, Math.max(...rows.map((r) => r.events)), 'sort: most repeat hits')
const byLtv = probe({ ...base, sort: 'ltv0' }).visible
ok(
  byLtv.every((r, i) => i === 0 || byLtv[i - 1].ltv0 >= r.ltv0),
  'sort: LTV desc',
)

const combo = probe({ ...base, asset: 'WETH', outcome: 'cured', protocol: 'aave' })
ok(combo.matched > 0 && combo.matched <= weth.matched, 'filters compose')
ok(
  combo.visible.every(
    (r: CohortRow) => r.primary === 'WETH' && r.protocol === 'aave' && matchesOutcome(r, 'cured'),
  ),
  'composed filter is correct',
)
const unpricedSorted = probe({ ...base, protocol: 'morpho' }).visible
ok(
  unpricedSorted.every((r: CohortRow) => r.debtUsd != null) ||
    unpricedSorted.findIndex((r: CohortRow) => r.debtUsd == null) >
      unpricedSorted.findLastIndex((r: CohortRow) => r.debtUsd != null),
  'unpriced positions sort last',
)

console.log(`EVIDENCE CENSUS OK — ${checks} assertions passed`)
console.log(
  `  ${rows.length} positions · real ${usdM(D.all.realRepaidUsd)} · Membrane ${usdM(D.all.memRepaidUsd)} · ${D.all.gapPct}% less`,
)
console.log(
  `  less/more/equal/unpriced ${D.all.less}/${D.all.more}/${D.all.equal}/${D.all.unpricedPositions} · cured ${T.cure.curedInWindow}/${T.cure.accountsAnalysed} · grid end ${doc.meta.gridEnd.positions}`,
)
console.log(
  `  census.json ${censusChecked ? 'checked (sha256 and totals)' : `not found at ${censusPath}: checked against the totals recorded in meta.source.totals`}`,
)
console.log(`  served file ${bytes.toLocaleString('en-US')} B`)
