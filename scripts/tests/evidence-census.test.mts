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
 *   3. the filters and sorts the cohort table drives, over the 2,280 compared positions.
 *
 * UPDATED 2026-10-18 (owner rulings): Membrane walks every position at ITS OWN line with
 * liquidity-capped sales; the cohort and every total are the COMPARED set (2,280 of 3,197: the
 * rest have no Membrane line or would sell a token with no observed liquidity), and only DEBT
 * REPAID is compared. At those lines Membrane closes 17.6% MORE debt, net.
 *
 * It renders components with renderToStaticMarkup (no browser), like the old
 * scripts/tests/evidence.test.mts it replaces for the UI.
 */
import assert from 'node:assert'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
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
const { HeroChart } = await import('@/components/Simulator/HeroChart')
const { GuaranteeBlock } = await import('@/components/Simulator/GuaranteeBlock')
const { OCT10_SCALE_LINE } = await import('@/lib/position-sim/oct10Totals')

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

// The served cohort is the COMPARED set; the census holds every position, all walked.
eq(rows.length, doc.meta.positions, 'cohort length == meta.positions (compared)')
eq(doc.meta.walked, doc.meta.censusPositions, 'every census position walked')
eq(
  doc.meta.positions +
    doc.meta.exclusions.noMembraneLine.positions +
    doc.meta.exclusions.noCapacity.positions,
  doc.meta.censusPositions,
  'compared + excluded == the census',
)
eq(doc.meta.exclusions.noMembraneLine.positions, 866, '866 positions with no Membrane line')
eq(doc.meta.exclusions.noCapacity.positions, 51, '51 with no observed liquidity')
ok(!('realSeizedUsd' in D.all), 'no collateral-seized figure in the comparison')
ok(
  !/seized/i.test(JSON.stringify({ debt: D, landing: file.landing })),
  'no seized figure served in the comparison',
)
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

// The headline figures (2026-10-18: Membrane's own line, 1.1x capacity, the compared set).
eq(D.all.positions, 2280, '2,280 compared positions')
eq(D.byProtocol['aave-v3'].positions, 1727, '1,727 Aave positions')
eq(D.byProtocol['morpho-blue'].positions, 553, '553 Morpho positions')
eq(usdM(D.all.realRepaidUsd), '$164.1M', 'protocols closed $164.1M')
eq(usdM(D.all.memRepaidUsd), '$193.0M', 'Membrane $193.0M')
eq(D.all.gapPct.toFixed(2), '-17.62', '17.6% more')
eq(D.byProtocol['aave-v3'].gapPct.toFixed(2), '-23.58', 'Aave 23.6% more')
eq(D.byProtocol['morpho-blue'].gapPct.toFixed(2), '8.32', 'Morpho 8.3% less')
// The published sensitivities, each on its own set, the headline among them.
{
  const S = doc.meta.sensitivities
  const h = S.find((r) => r.headline)!
  eq(h.key, 'capacity-1.1', 'the headline row is 1.1x capacity')
  near(h.memRepaidUsd, D.all.memRepaidUsd, 'the headline row is the headline')
  for (const r of S) {
    near(r.gapUsd, r.realRepaidUsd - r.memRepaidUsd, `${r.key}: gap == real - Membrane`, 0.02)
    eq(
      r.byProtocol['aave-v3'].positions + r.byProtocol['morpho-blue'].positions,
      r.positions,
      `${r.key}: the split partitions its set`,
    )
    near(r.lessUsd - r.moreUsd, r.gapUsd, `${r.key}: gross less - gross more == net`, 0.05)
  }
  for (const k of ['capacity-0.5', 'capacity-1', 'capacity-2', 'capacity-unlimited'])
    eq(S.find((r) => r.key === k)!.positions, h.positions, `${k}: the headline's own positions`)
  const pl = S.find((r) => r.key === 'protocol-line-unlimited')!
  ok(
    pl.memRepaidUsd < 157_056_180.33,
    'the protocol line, unlimited: the old census less no-capacity',
  )
  // the cap only ever takes sales away on the same positions, in total
  const caps = [
    'capacity-0.5',
    'capacity-1',
    'capacity-1.1',
    'capacity-2',
    'capacity-unlimited',
  ].map((k) => S.find((r) => r.key === k)!.memRepaidUsd)
  for (let i = 1; i < caps.length; i++)
    ok(caps[i] >= caps[i - 1], `more capacity, more repaid (${i})`)
  const w = doc.meta.liquidity.whale
  eq(w.headline?.excluded, 'no-membrane-line', 'the whale is out of the headline')
  near(w.protocolLineCapped!.memRepaidUsd!, 13_097_271.37, 'the whale at Aave’s line, 1.1x')
  near(w.protocolLineUnlimited!.memRepaidUsd!, 29_863_534.37, 'the whale at Aave’s line, unlimited')
}
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

// ---- the time lens, recomputed from the ROWS (review 2026-10-16: never the doc's own fields)
const pct2 = (x: number) => Math.round(x * 1e4) / 100
const medianOf = (xs: number[]) => {
  const v = [...xs].sort((a, b) => a - b)
  const m = v.length >> 1
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}
const R = (() => {
  const c = rows.filter((r) => r.cure)
  const k = c.filter((r) => r.cure!.curedInWindow)
  const h = c.filter((r) => r.cure!.healthyAt8h)
  const pricedRows = rows.filter((r) => r.priced)
  const mem = sum(rows.map((r) => r.memRepaidUsd))
  const oneRepay = sum(pricedRows.map((r) => r.oneRepayUsd ?? 0))
  // the delay credit is set against the UNLIMITED walk (one repay is not liquidity-capped)
  const credit = (r: CohortRow) => Math.max(0, (r.oneRepayUsd ?? 0) - r.memUnlimitedUsd)
  const memUnl = sum(pricedRows.map((r) => r.memUnlimitedUsd))
  const curedRows = pricedRows.filter((r) => r.minutesToFirstCure != null)
  const cureCredit = sum(curedRows.map(credit))
  const within = (m: number) =>
    pct2(sum(curedRows.filter((r) => r.minutesToFirstCure! <= m).map(credit)) / cureCredit)
  const outcome = (o: string) => rows.filter((r) => r.outcome === o).length
  const withSale = (o: string) => rows.filter((r) => r.outcome === o && r.sales > 0).length
  return {
    analysed: c.length,
    curedPct: pct2(k.length / c.length),
    healthyPct: pct2(h.length / c.length),
    medianMin: medianOf(k.map((r) => r.cure!.minutesToCure!)),
    noWindow: c.filter((r) => r.cure!.noWindow).length,
    wouldCure: c.filter((r) => r.cure!.wouldHaveCuredWithWindow).length,
    neverSold: rows.filter((r) => r.sales === 0).length,
    window: rows.filter((r) => r.delayClass !== 'no-delay').length,
    mixed: rows.filter((r) => r.delayClass === 'mixed').length,
    noDelay: rows.filter((r) => r.delayClass === 'no-delay').length,
    mem,
    oneRepay,
    delayCredit: oneRepay - memUnl,
    cureCredit,
    w2: within(2),
    w60: within(60),
    w480: within(480),
    outcome,
    withSale,
  }
})()
// The doc agrees with the rows (one repay is published per row to the cent, so the sums of
// 3,184 rounded rows may differ from the unrounded total by a few dollars).
eq(T.cure.accountsAnalysed, R.analysed, 'cure analysed == rows')
eq(T.cure.curedPct, R.curedPct, 'cure pct == rows')
eq(T.cure.healthyAt8hPct, R.healthyPct, 'healthy-at-8h pct == rows')
eq(T.cure.medianMinutesToCure, R.medianMin, 'cure median minutes == the median recounted from rows')
eq(
  [T.cure.noDelay.accounts, T.cure.noDelay.wouldHaveCuredWithWindow],
  [R.noWindow, R.wouldCure],
  'no-window counts == rows',
)
eq(T.neverSold.positions, R.neverSold, 'never sold == rows with sales === 0')
eq(T.windowPositions, R.window, 'window positions == rows not in the no-delay class')
eq(R.window, rows.length - R.noDelay, 'window positions == all minus no-delay')
eq(
  T.classes,
  { delayed: rows.length - R.mixed - R.noDelay, mixed: R.mixed, 'no-delay': R.noDelay },
  'classes == rows',
)
near(T.oneRepay.memOneRepayUsd, R.oneRepay, 'one repay == Σ rows', 20)
near(T.oneRepay.delayCreditUsd, R.delayCredit, 'delay credit == Σ rows', 20)
near(T.oneRepay.cureCreditUsd, R.cureCredit, 'cure credit == Σ rows', 20)
near(T.oneRepay.cureCreditShareWithin2min, R.w2, 'cure credit share 2 min == rows', 0.05)
near(T.oneRepay.cureCreditShareWithin1h, R.w60, 'cure credit share 1h == rows', 0.05)
near(T.oneRepay.cureCreditShareWithin8h, R.w480, 'cure credit share 8h == rows', 0.05)
near(
  T.bandSensitivity.find((b) => b.band === doc.meta.params.band)!.memRepaidUsd,
  R.mem,
  'the headline band == Σ rows',
  0.05,
)
for (const o of Object.keys(T.outcomes)) {
  eq(T.outcomeWithSale[o], R.withSale(o), `outcome ${o}: positions with a sale == rows`)
}
// THE HELD DENOMINATOR, restated: the two not-sold buckets are the LARGER half's outcome, so
// the positions never sold at all are exactly those buckets minus their positions with a sale.
eq(
  R.outcome('cured-then-held') -
    R.withSale('cured-then-held') +
    (R.outcome('held') - R.withSale('held')),
  R.neverSold,
  'never sold == the not-sold buckets minus their positions with a sale on the other half',
)
// 201 never sold; 2,280 - 18 no-delay = 2,262 with a window (Membrane's own line).
eq([R.neverSold, R.window], [201, 2262], 'never sold 201; window 2,262')

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
  eq(census.rows.length, doc.meta.censusPositions, 'census.json rows: the whole census')
  eq(
    census.rows.filter((r: { mem: unknown }) => r.mem).length,
    rows.length,
    'census.json compared rows == the cohort',
  )
  censusChecked = true
}
// The fresh-print count cannot come from the rows; recount it from the oracle path itself
// when the inputs are here: minutes where mainnet's AaveOracle WETH price differs from the
// minute before.
let freshChecked = false
const oraclePath = path.join(
  dsDir,
  'recall-coverage',
  'inputs',
  'oct10',
  'onchain',
  'aave-oracle-1m.mainnet.json.gz',
)
if (fs.existsSync(oraclePath)) {
  const o = JSON.parse(gunzipSync(fs.readFileSync(oraclePath)).toString('utf8'))
  const weth = o.assets.find((a: { symbol: string }) => a.symbol === 'WETH').address
  const col: (string | null)[] = o.prices[weth]
  let fresh = 0
  for (let m = 1; m < col.length; m++) if (col[m] !== col[m - 1]) fresh++
  eq(T.freshPrints.minutes, fresh, 'fresh WETH prints == recounted on the AaveOracle path')
  freshChecked = true
}

// ============================================================ 2. the lens text
const debtHtml = render(
  React.createElement(DebtLens, { debt: D, byAsset: doc.byAsset, meta: doc.meta }),
)
has(debtHtml, '2,280', 'DebtLens: positions')
has(debtHtml, 'of 3,197 liquidated', 'DebtLens: of the census')
has(debtHtml, '$164.1M', 'DebtLens: protocols closed')
has(debtHtml, '$193.0M†', 'DebtLens: Membrane, marked modelled')
has(debtHtml, '17.6% more debt closed†', 'DebtLens: the direction and size of the gap')
has(debtHtml, 'Liquidity-capped sales†', 'DebtLens: the liquidity card')
has(debtHtml, 'unlimited (the old assumption)', 'DebtLens: the unlimited run')
has(debtHtml, 'protocol&#x27;s own line', 'DebtLens: the protocol-line run')
has(debtHtml, '$13.1M† with the cap', 'DebtLens: the whale, capped')
has(debtHtml, '$29.9M† unlimited', 'DebtLens: the whale, unlimited')
// The net gap is shown with what it is made of, and every Membrane-side figure carries †.
const grossLess = sum(
  rows.filter((r) => compareRow(r) === 'less').map((r) => r.realRepaidUsd - r.memRepaidUsd),
)
const grossMore = sum(
  rows.filter((r) => compareRow(r) === 'more').map((r) => r.memRepaidUsd - r.realRepaidUsd),
)
near(D.all.lessUsd, grossLess, 'gross less == Σ rows', 0.05)
near(D.all.moreUsd, grossMore, 'gross more == Σ rows', 0.05)
near(D.all.lessUsd - D.all.moreUsd, D.all.gapUsd, 'gross less − gross more == the net gap', 0.05)
has(debtHtml, 'Difference, net', 'DebtLens: the difference is labelled net')
has(debtHtml, '$28.9M†', 'DebtLens: the net difference carries †')
has(
  debtHtml,
  `less on ${D.all.less.toLocaleString('en-US')} positions (${usdM(grossLess)}†), more on ${D.all.more.toLocaleString('en-US')} (${usdM(grossMore)}†)`,
  'DebtLens: the gross beside the net (rows)',
)
has(debtHtml, 'Difference†', 'DebtLens: the difference column carries †')
has(debtHtml, '$31.5M† · 23.6% more', 'DebtLens: the Aave difference carries †')
has(debtHtml, 'Aave V3', 'DebtLens: the Aave row of the split')
has(debtHtml, 'Morpho Blue', 'DebtLens: the Morpho row of the split')
has(debtHtml, '23.6% more', 'DebtLens: Aave gap')
has(debtHtml, '8.3% less', 'DebtLens: Morpho gap')
has(debtHtml, '$133.4M', 'DebtLens: Aave closed')
has(debtHtml, '$28.1M†', 'DebtLens: Morpho Membrane')
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
has(
  timeHtml,
  `${R.curedPct}% of the ${R.analysed.toLocaleString('en-US')} positions`,
  'TimeLens: cured pct (rows)',
)
has(timeHtml, `${R.healthyPct}% were under it`, 'TimeLens: healthy-at-8h pct (rows)')
has(timeHtml, `median ${R.medianMin} min`, 'TimeLens: median minutes (rows)')
has(timeHtml, `${usdM(R.delayCredit)}†`, 'TimeLens: delay credit, modelled (rows)')
has(timeHtml, `${usdM(R.oneRepay)} one repay`, 'TimeLens: one repay (rows)')
has(timeHtml, `${usdM(R.cureCredit)}† of it`, 'TimeLens: cure credit (rows)')
has(
  timeHtml,
  `>${R.neverSold.toLocaleString('en-US')}<`,
  'TimeLens: the never-sold tile is the rows with sales === 0',
)
has(
  timeHtml,
  `of ${rows.length.toLocaleString('en-US')} positions; no sale on any half`,
  'TimeLens: never-sold denominator is every position',
)
has(
  timeHtml,
  `${R.window.toLocaleString('en-US')} positions hold collateral that gets the window`,
  'TimeLens: window count from the delay class (rows)',
)
has(
  timeHtml,
  `other ${R.noDelay.toLocaleString('en-US')} have none`,
  'TimeLens: no-window count (rows)',
)
{
  const n = R.outcome('cured-then-held')
  const w = R.withSale('cured-then-held')
  has(
    timeHtml,
    `${(n - w).toLocaleString('en-US')} never sold at all; on ${w.toLocaleString('en-US')} split positions the other half was sold`,
    'TimeLens: the cured-then-held row says how many had the other half sold (rows)',
  )
  const hn = R.outcome('held')
  const hw = R.withSale('held')
  has(
    timeHtml,
    `the other half was sold on ${hw.toLocaleString('en-US')} of these ${hn.toLocaleString('en-US')}`,
    'TimeLens: the held row says the other half was sold (rows)',
  )
}
ok(!/; never sold</.test(timeHtml), 'TimeLens: no outcome label claims "never sold" for a bucket')
has(timeHtml, 'Window still open when the data ends', 'TimeLens: grid end apart')
has(timeHtml, `band 2%`, 'TimeLens: band sensitivity')
for (const b of T.bandSensitivity)
  has(timeHtml, `${usdM(b.memRepaidUsd)}†`, `TimeLens: band ${b.band}`)
has(timeHtml, `${usdM(R.mem)}†`, 'TimeLens: the 4% band is Σ rows')
has(timeHtml, 'nobody clears the timer early', 'TimeLens: the early-clear corner')
has(
  timeHtml,
  `changed in ${T.freshPrints.minutes.toLocaleString('en-US')} of ${T.freshPrints.gridMinutes.toLocaleString('en-US')} minutes`,
  'TimeLens: fresh prints, recomputed on the AaveOracle path',
)
{
  const at = timeHtml.indexOf('Stablecoin collateral (or a line above 90%)')
  const n = R.outcome('sold-no-delay').toLocaleString('en-US')
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
has(desc, '$164.1M', 'SEO: protocols closed')
has(desc, '$193.0M on Membrane at its own lines (modelled)', 'SEO: Membrane, marked modelled')
has(desc, 'Aave 23.6% more, Morpho 8.3% less', 'SEO: the split')
ok(!/71%|17\.8%/.test(desc), 'SEO: the stale median figures are gone')
checks++

// The landing copy (facts.ts): derived from the census, the split on every blended line.
const bridge = HERO_VARIANTS.c.bridge.line
has(bridge, '2,280 of the 3,197 positions liquidated on Aave and Morpho', 'landing bridge: the set')
has(bridge, '$164.1M', 'landing bridge: protocols closed')
has(bridge, '$193.0M†', 'landing bridge: Membrane, modelled')
has(bridge, 'Aave 23.6% more, Morpho 8.3% less', 'landing bridge: the split')
has(bridge, 'capped by the liquidity the day showed†', 'landing bridge: the cap, modelled')
has(bridge, 'its protocol’s oracle read on chain', 'landing bridge: names the oracle')
for (const v of Object.values(HERO_VARIANTS)) {
  ok(
    !/747|36%|Chainlink/.test(v.bridge.line),
    'no hero variant keeps the old 747 / 36% / Chainlink line',
  )
}
has(CLOSE.headline, '2,280', 'Close headline: the compared count')
const lines = CLOSE.contains.lines.join('\n')
{
  const c = headline.concentration
  const g = (x: number) => `${Math.abs(x).toFixed(1)}% ${x >= 0 ? 'less' : 'more'}†`
  has(
    lines,
    `Without it Membrane closes ${g(c.gapWithoutTop1Pct)}`,
    'Close: the without-top-1 figure carries †',
  )
  has(
    lines,
    `without them it is ${g(c.gapWithoutTop5Pct)}`,
    'Close: the without-top-5 figure carries †',
  )
}
has(
  lines,
  `net: Membrane closes less on ${D.all.less.toLocaleString('en-US')} positions`,
  'Close: the net figure with its gross counts',
)
has(
  bridge,
  `less on ${D.all.less.toLocaleString('en-US')} positions (${usdM(D.all.lessUsd)}†), more on ${D.all.more.toLocaleString('en-US')} (${usdM(D.all.moreUsd)}†)`,
  'landing bridge: net, with both counts and the gross',
)
has(
  bridge,
  'walked at Membrane’s own line on its protocol’s oracle',
  'landing bridge: the line and the oracle',
)

// HeroChart and GuaranteeBlock (the landing hero): the census figure is NET, never
// "protected", and it is a separate measure from the corpus line, never "alone".
const heroChartHtml = render(
  React.createElement(HeroChart, {
    comparison: null,
    startTs: null,
    stepSeconds: null,
    isDemo: true,
  }),
)
has(heroChartHtml, '$29M more, net†', 'HeroChart: net, modelled')
has(heroChartHtml, OCT10_SCALE_LINE.gross, 'HeroChart: the gross counts beside it')
ok(!/protected/i.test(heroChartHtml), 'HeroChart: never "protected"')
const guaranteeHtml = render(React.createElement(GuaranteeBlock, {}))
ok(!/protected|\balone\b/i.test(guaranteeHtml), 'GuaranteeBlock: never "protected", never "alone"')
has(
  guaranteeHtml,
  'A different measure',
  'GuaranteeBlock: the census line is labelled a separate measure',
)
has(guaranteeHtml, OCT10_SCALE_LINE.scope, 'GuaranteeBlock: with its scope named')
has(guaranteeHtml, '$29M more debt force-closed, net†', 'GuaranteeBlock: net, modelled')
has(lines, 'Aave V3: 1,727 positions', 'Close: the Aave split')
has(lines, 'Morpho Blue: 553 positions', 'Close: the Morpho split')
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
  `  census.json ${censusChecked ? 'checked (sha256 and totals)' : `not found at ${censusPath}: checked against the totals recorded in meta.source.totals`}; fresh prints ${freshChecked ? 'recounted on the oracle path' : 'not recounted (inputs absent)'}`,
)
console.log(`  served file ${bytes.toLocaleString('en-US')} B`)
