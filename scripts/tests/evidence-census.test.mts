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
 *   3. the filters and sorts the cohort table drives, over the 1,545 compared positions.
 *
 * UPDATED 2026-10-18 (owner rulings, rounds 2 and 3): Membrane walks every position at ITS OWN
 * line with its debt SIZED to that line (debt0 x memLine / protocolLine, collateral unchanged)
 * and sales capped at a uniform 0.98x capacity†; a position holding ANY collateral without a
 * Membrane line is excluded; the cohort and every total are the COMPARED set (1,545 of 3,197).
 * The comparison is the SHARE of each side's own t0 debt closed, debt-weighted: the protocols
 * 31.2%, Membrane 13.3%†, 17.9 pp less, net. No Membrane dollar is set beside a real one.
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
const { decodeEvidence, sparedPp, compareRow, summaryOf } =
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
const pc = (x: number) => `${(x * 100).toFixed(1)}%`
const ppw = (x: number) => `${Math.abs(x).toFixed(1)} pp ${x >= 0 ? 'less' : 'more'}`
/** Debt-weighted shares recomputed from the rows (memFrac is served at 1e-5). */
const sharesOf = (rs: readonly CohortRow[]) => {
  const p = rs.filter((r) => r.priced)
  const rd = sum(p.map((r) => r.debtUsd ?? 0))
  const md = sum(p.map((r) => r.memDebtUsd ?? 0))
  return {
    priced: p.length,
    real: rd > 0 ? sum(p.map((r) => r.realRepaidUsd)) / rd : 0,
    mem: md > 0 ? sum(p.map((r) => r.memFrac! * (r.memDebtUsd ?? 0))) / md : 0,
  }
}

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
const X = doc.meta.exclusions
eq(
  doc.meta.positions +
    X.noMembraneLine.positions +
    X.partialMembraneLine.positions +
    X.noCapacity.positions,
  doc.meta.censusPositions,
  'compared + excluded == the census',
)
eq(X.noMembraneLine.positions, 866, '866 positions with no Membrane line')
eq(X.partialMembraneLine.positions, 782, '782 holding some collateral without a Membrane line')
eq(X.noCapacity.positions, 4, '4 with no observed liquidity')
for (const [k, b] of Object.entries({
  noMembraneLine: X.noMembraneLine,
  partialMembraneLine: X.partialMembraneLine,
  noCapacity: X.noCapacity,
})) {
  eq(sum(b.top.map((t) => t.positions)), b.positions, `${k}: by main collateral partitions it`)
  near(
    sum(b.top.map((t) => t.realRepaidUsd)),
    b.realRepaidUsd,
    `${k}: by main collateral, real $`,
    0.05,
  )
  eq(
    b.byProtocol['aave-v3'].positions + b.byProtocol['morpho-blue'].positions,
    b.positions,
    `${k}: the split partitions it`,
  )
}
ok(!('realSeizedUsd' in D.all), 'no collateral-seized figure in the comparison')
ok(
  !/seized/i.test(JSON.stringify({ debt: D, landing: file.landing })),
  'no seized figure served in the comparison',
)
// No Membrane dollar is served in any comparison block (rows keep their own, unset beside real).
// (memDebtUsd is Membrane's own line-sized t0 debt: the share's denominator, not a result.)
ok(
  !/"mem(?!DebtUsd)[A-Za-z]*Usd"/.test(
    JSON.stringify({ debt: D, byAsset: doc.byAsset, landing: file.landing }),
  ),
  'no Membrane dollar result in the debt summary, byAsset or the landing block',
)
eq(new Set(rows.map((r) => r.id)).size, rows.length, 'row ids are unique')
eq(sum(rows.map((r) => r.events)), doc.meta.events, 'events: rows sum to meta.events')

// Every debt set is the share of its rows, and equals census.meta.totals.
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
  near(s.realRepaidUsd, census.realRepaidUsd, `${k}: real repaid == census.meta.totals`)
  const sh = sharesOf(rs)
  eq(sh.priced, s.pricedPositions, `${k}: priced positions == rows`)
  near(sh.real, s.realShare, `${k}: real share == rows`, 2e-5)
  near(sh.mem, s.memShare, `${k}: Membrane share == rows`, 2e-5)
  eq(s.realShare, census.realShare, `${k}: real share == census.meta.totals`)
  eq(s.memShare, census.memShare, `${k}: Membrane share == census.meta.totals`)
  near(s.gapPp, (s.realShare - s.memShare) * 100, `${k}: gap == (real - Membrane) in pp`, 1e-3)
  near(
    s.realDebtUsd,
    sum(rs.filter((r) => r.priced).map((r) => r.debtUsd ?? 0)),
    `${k}: real debt`,
    0.05 * rs.length,
  )
  near(
    s.memDebtUsd,
    sum(rs.filter((r) => r.priced).map((r) => r.memDebtUsd ?? 0)),
    `${k}: Membrane debt`,
    0.05 * rs.length,
  )
  ok(
    s.memDebtUsd <= s.realDebtUsd + 0.01,
    `${k}: Membrane's line-sized debt is no larger than the real`,
  )
  eq(s.memNeverSold, census.positionsKept, `${k}: never sold == census positionsKept`)
  eq(s.gridEnd.positions, census.positionsSoldAtGridEnd, `${k}: grid end == census`)
  // The per-position comparison of the two shares partitions the set.
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
  const ls = sharesOf(rs.filter((r) => compareRow(r) === 'less'))
  const ms = sharesOf(rs.filter((r) => compareRow(r) === 'more'))
  near(ls.real, s.lessSet.realShare, `${k}: less set, real share`, 1e-4)
  near(ls.mem, s.lessSet.memShare, `${k}: less set, Membrane share`, 1e-4)
  near(ms.real, s.moreSet.realShare, `${k}: more set, real share`, 1e-4)
  near(ms.mem, s.moreSet.memShare, `${k}: more set, Membrane share`, 1e-4)
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
eq(sum(D.byVenueChain.map((v) => v.positions)), D.all.positions, 'venue x chain rows partition all')

// The headline figures (2026-10-18, round 3: Membrane's own line and debt, 0.98x capacity,
// the strict compared set).
eq(D.all.positions, 1545, '1,545 compared positions')
eq(D.byProtocol['aave-v3'].positions, 992, '992 Aave positions')
eq(D.byProtocol['morpho-blue'].positions, 553, '553 Morpho positions')
eq(usdM(D.all.realRepaidUsd), '$135.2M', 'protocols repaid $135.2M: the size of the day here')
eq([pc(D.all.realShare), pc(D.all.memShare)], ['31.2%', '13.3%'], '31.2% vs 13.3%')
eq(D.all.gapPp.toFixed(1), '17.9', '17.9 pp less')
eq(D.byProtocol['aave-v3'].gapPp.toFixed(1), '13.9', 'Aave 13.9 pp less')
eq(D.byProtocol['morpho-blue'].gapPp.toFixed(1), '50.3', 'Morpho 50.3 pp less')
eq([D.all.less, D.all.more, D.all.equal], [1018, 383, 137], 'less / more / equal')
eq(doc.meta.liquidity.multiplier, 0.98, 'the headline multiplier is 0.98x')
eq(
  doc.meta.liquidity.multiplierBasis,
  'modelled: 0.98×, the unweighted mean of the three measured class medians of depth recovery 8h after five crashes (membrane-datasets q28/liquidity-recovery REPORT.md; the report itself rates those medians too generous and recommends lower values — see the sensitivity rows)',
  'the multiplier is labelled with its basis',
)
// The debt sizing (review 2026-10-18): lower for most, higher for some; splits only per half.
{
  const z = doc.meta.line.sizing
  eq(
    [
      z.scaledDown,
      z.scaledUp,
      z.scaledUpHoldingStables,
      z.maxScale,
      z.splits,
      z.splitsWithAHalfUnderItsLine,
    ],
    [1507, 38, 36, 1.28, 180, 52],
    'sizing: 1,507 lower, 38 higher (36 holding stablecoins, up to 1.28x); 52 of 180 splits with a half under its line',
  )
  eq(z.scaledDown + z.scaledUp + z.unchanged, D.all.positions, 'sizing partitions the compared set')
  ok(/a half opens under its own line/.test(doc.meta.method), 'method: the split caveat is stated')
  ok(/52 of the 180 split positions/.test(doc.meta.method), 'method: the 52 are reported')
  ok(
    !/as far past Membrane’s line as the real position sat past/.test(doc.meta.method),
    'method: no blanket as-far-past claim',
  )
}
// The published sensitivities, each on its own set, the headline among them.
{
  const S = doc.meta.sensitivities
  const h = S.find((r) => r.headline)!
  eq(h.key, 'capacity-0.98', 'the headline row is 0.98x capacity')
  eq(h.memShare, D.all.memShare, 'the headline row is the headline')
  eq(h.gapPp, D.all.gapPp, 'the headline row gap is the headline')
  for (const k of [
    'capacity-0.5',
    'capacity-0.98',
    'capacity-1',
    'capacity-1.1',
    'capacity-2',
    'capacity-unlimited',
    'capacity-research-per-class',
    'capacity-research-medians',
    'capacity-research-flow',
    'protocol-line',
    'protocol-line-unlimited',
    'no-debt-scaling',
    'partial-lines',
    'queue-with-partial-lines',
    'band-0.02',
    'band-0.08',
  ])
    ok(
      S.some((r) => r.key === k),
      `sensitivity row ${k} is published`,
    )
  {
    // queue order: the excluded partial-line positions also on the book take capacity first
    const q = S.find((r) => r.key === 'queue-with-partial-lines')!
    ok(q.memShare <= h.memShare, 'queue order: more sellers on the book, no larger Membrane share')
    eq(q.memShare.toFixed(4), '0.1223', 'queue order: 12.23%')
    eq(q.gapPp.toFixed(1), '18.9', 'queue order: 18.9 pp')
  }
  ok(
    S.find((r) => r.key === 'capacity-1.1')!.label.includes('previous headline'),
    '1.1x is labelled the previous headline',
  )
  for (const r of S) {
    near(
      r.gapPp,
      (r.realShare - r.memShare) * 100,
      `${r.key}: gap == (real - Membrane) in pp`,
      1e-3,
    )
    eq(
      r.byProtocol['aave-v3'].positions + r.byProtocol['morpho-blue'].positions,
      r.positions,
      `${r.key}: the split partitions its set`,
    )
    eq(
      r.less + r.more + r.equal + (r.positions - r.pricedPositions),
      r.positions,
      `${r.key}: less/more/equal partition`,
    )
    ok(!('memRepaidUsd' in r), `${r.key}: no Membrane dollar in the row`)
  }
  for (const k of [
    'capacity-0.5',
    'capacity-1',
    'capacity-1.1',
    'capacity-2',
    'capacity-unlimited',
    'capacity-research-per-class',
    'capacity-research-medians',
    'capacity-research-flow',
    'no-debt-scaling',
    'queue-with-partial-lines',
  ])
    eq(S.find((r) => r.key === k)!.positions, h.positions, `${k}: the headline's own positions`)
  {
    const pl = S.find((r) => r.key === 'partial-lines')!
    eq(pl.positions, 2262, 'partial lines: the first-round set, 2,262 positions')
    eq(pl.excluded.partialMembraneLine, 0, 'partial lines: nobody excluded for a partial line')
    eq(
      pl.positions + pl.excluded.noMembraneLine + pl.excluded.noCapacity,
      doc.meta.censusPositions,
      'partial lines: its set and its exclusions partition the census',
    )
  }
  // the cap only ever takes sales away on the same positions: more capacity, a larger share
  const caps = [
    'capacity-research-flow',
    'capacity-0.5',
    'capacity-0.98',
    'capacity-1',
    'capacity-1.1',
    'capacity-2',
    'capacity-unlimited',
  ].map((k) => S.find((r) => r.key === k)!.memShare)
  for (let i = 1; i < caps.length; i++)
    ok(caps[i] >= caps[i - 1], `more capacity, a larger Membrane share (${i})`)
  const w = doc.meta.liquidity.whale
  eq(w.headline?.excluded, 'no-membrane-line', 'the whale is out of the headline')
  near(w.protocolLineCapped!.memRepaidUsd!, 11_523_540.89, 'the whale at Aave’s line, 0.98x')
  near(w.protocolLineUnlimited!.memRepaidUsd!, 29_863_534.37, 'the whale at Aave’s line, unlimited')
  near(
    w.protocolLineCapped!.memFrac!,
    0.33058,
    'the whale at Aave’s line, 0.98x: 33.1% of its debt',
    1e-5,
  )
  near(
    w.realRepaidUsd / w.debtUsd!,
    0.1058,
    'the whale: the protocol closed 10.6% of its debt',
    1e-3,
  )
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

// Grid end: marked rows, and the outcome bucket of positions first sold there.
const ge = rows.filter((r) => r.gridEndUsd != null)
eq(ge.length, doc.meta.gridEnd.positions, 'grid-end rows == meta.gridEnd.positions')
ok(doc.meta.gridEnd.memShare < 0.001, 'grid-end sales are under 0.1% of Membrane’s debt')
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
// The bands, on the share basis: the headline band is the headline.
eq(
  T.bandSensitivity.find((b) => b.band === doc.meta.params.band)!.memShare,
  D.all.memShare,
  'the headline band == the headline share',
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
// 457 never sold; 1,545 - 18 no-delay = 1,527 with a window (Membrane's own line).
eq([R.neverSold, R.window], [457, 1527], 'never sold 457; window 1,527')

// byAsset: per primary leg, >= 20 positions, recounted, both shares from the rows.
for (const a of doc.byAsset) {
  const rs = rows.filter((r) => r.primary === a.symbol)
  eq(a.positions, rs.length, `byAsset ${a.symbol} positions`)
  eq(a.aave + a.morpho, a.positions, `byAsset ${a.symbol} split`)
  ok(a.positions >= 20, `byAsset ${a.symbol} >= 20`)
  const sh = sharesOf(rs)
  near(sh.real, a.realShare, `byAsset ${a.symbol} real share`, 2e-5)
  near(sh.mem, a.memShare, `byAsset ${a.symbol} Membrane share`, 2e-5)
}

// The headline file the landing imports is the same census.
eq(headline.censusSha256, doc.meta.source.sha256, 'headline file: same census sha256')
eq(headline.positions, D.all.positions, 'headline file: positions')
eq(headline.all.realRepaidUsd, D.all.realRepaidUsd, 'headline file: real')
eq(headline.all.realShare, D.all.realShare, 'headline file: real share')
eq(headline.all.memShare, D.all.memShare, 'headline file: Membrane share')
eq(headline.aave.gapPp, D.byProtocol['aave-v3'].gapPp, 'headline file: Aave gap')
eq(headline.morpho.gapPp, D.byProtocol['morpho-blue'].gapPp, 'headline file: Morpho gap')
eq(
  headline.excluded.partialMembraneLine.positions,
  782,
  'headline file: the partial-line exclusion',
)

// Served size: a client fetch, not a download.
const bytes = fs.statSync(FILE).size
ok(bytes < 1_200_000, `the served file stays under 1.2 MB (${bytes.toLocaleString('en-US')} B)`)

// The canonical census, when the datasets clone is here (rule N18). Its sha256 and its
// totals must be the ones recorded; without the clone, the recorded totals above stand.
const dsDir = path.resolve(process.env.MEMBRANE_DATASETS_DIR ?? '../membrane-datasets')
const censusPath = path.join(dsDir, 'oct10-2025', 'coverage', 'census.json')
// A missing datasets clone SKIPS assertions, and says so loudly (review 2026-10-18): a WARNING
// with the count, and a failure when CI_REQUIRE_DATASETS=1.
const CENSUS_JSON_ASSERTIONS = 7
const ORACLE_PATH_ASSERTIONS = 1
let skipped = 0
const skippedWhat: string[] = []
let censusChecked = false
if (!fs.existsSync(censusPath)) {
  skipped += CENSUS_JSON_ASSERTIONS
  skippedWhat.push(`census.json (${censusPath})`)
} else {
  const buf = fs.readFileSync(censusPath)
  eq(createHash('sha256').update(buf).digest('hex'), doc.meta.source.sha256, 'census.json sha256')
  const census = JSON.parse(buf.toString('utf8'))
  eq(D.all.realShare, census.meta.totals.all.shares.realShare, 'census.json real share')
  eq(D.all.memShare, census.meta.totals.all.shares.memShare, 'census.json Membrane share')
  near(D.all.realRepaidUsd, census.meta.totals.all.realWalked.repaidUsd, 'census.json real')
  eq(census.rows.length, doc.meta.censusPositions, 'census.json rows: the whole census')
  // the debt sizing, recounted on census.json's compared rows (review 2026-10-18)
  {
    type R = {
      mem: unknown
      memLine?: { debtScale?: number; halves?: unknown[] }
      t0Decisions?: string[]
    }
    const cr = (census.rows as R[]).filter((r) => r.mem)
    const sc = (r: R) => r.memLine?.debtScale ?? 1
    const splits = cr.filter((r) => (r.memLine?.halves?.length ?? 0) > 1)
    eq(
      {
        scaledDown: cr.filter((r) => sc(r) < 1 - 1e-9).length,
        scaledUp: cr.filter((r) => sc(r) > 1 + 1e-9).length,
        splits: splits.length,
        splitsWithAHalfUnderItsLine: splits.filter((r) => (r.t0Decisions ?? []).includes('under'))
          .length,
      },
      {
        scaledDown: doc.meta.line.sizing.scaledDown,
        scaledUp: doc.meta.line.sizing.scaledUp,
        splits: doc.meta.line.sizing.splits,
        splitsWithAHalfUnderItsLine: doc.meta.line.sizing.splitsWithAHalfUnderItsLine,
      },
      'census.json: the debt sizing recounts (down / up / splits / a half under its line)',
    )
  }
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
if (!fs.existsSync(oraclePath)) {
  skipped += ORACLE_PATH_ASSERTIONS
  skippedWhat.push(`the AaveOracle path (${oraclePath})`)
} else {
  const o = JSON.parse(gunzipSync(fs.readFileSync(oraclePath)).toString('utf8'))
  const weth = o.assets.find((a: { symbol: string }) => a.symbol === 'WETH').address
  const col: (string | null)[] = o.prices[weth]
  let fresh = 0
  for (let m = 1; m < col.length; m++) if (col[m] !== col[m - 1]) fresh++
  eq(T.freshPrints.minutes, fresh, 'fresh WETH prints == recounted on the AaveOracle path')
  freshChecked = true
}

if (skipped > 0) {
  console.warn(
    `WARNING: ${skipped} assertions SKIPPED — the datasets inputs are absent: ${skippedWhat.join('; ')}. ` +
      'Set MEMBRANE_DATASETS_DIR to a membrane-datasets clone on q28/oct10-onchain to run them.',
  )
  if (process.env.CI_REQUIRE_DATASETS === '1') {
    console.error('FAIL: CI_REQUIRE_DATASETS=1 and the datasets inputs are absent.')
    process.exit(1)
  }
}

// ============================================================ 2. the lens text
const debtHtml = render(
  React.createElement(DebtLens, { debt: D, byAsset: doc.byAsset, meta: doc.meta }),
)
has(debtHtml, '1,545', 'DebtLens: positions')
has(debtHtml, 'of 3,197 liquidated', 'DebtLens: of the census')
has(debtHtml, '31.2%', 'DebtLens: protocols closed, as a share')
has(debtHtml, '$135.2M repaid', 'DebtLens: the real dollars, as the size of the day')
has(debtHtml, '13.3%†', 'DebtLens: Membrane, marked modelled')
has(debtHtml, 'of its own debt, sized to its line†', 'DebtLens: Membrane’s debt is line-sized')
has(debtHtml, '17.9 pp less†', 'DebtLens: the direction and size of the gap')
has(debtHtml, 'Liquidity-capped sales†', 'DebtLens: the liquidity card')
has(debtHtml, '0.98x capacity (headline)', 'DebtLens: the headline run')
has(debtHtml, '1.1x capacity (the previous headline)', 'DebtLens: the previous headline run')
has(debtHtml, 'research per-class medians', 'DebtLens: the research medians run')
has(debtHtml, 'research per-class, recommended', 'DebtLens: the recommended research run')
has(debtHtml, 'unlimited (the old assumption)', 'DebtLens: the unlimited run')
has(debtHtml, 'protocol&#x27;s own line', 'DebtLens: the protocol-line run')
has(debtHtml, 'without debt scaling', 'DebtLens: the unscaled run')
has(debtHtml, 'partial-line set', 'DebtLens: the old partial-line set')
has(
  debtHtml,
  'modelled: 0.98×, the unweighted mean of the three measured class medians of depth recovery 8h after five crashes (membrane-datasets q28/liquidity-recovery REPORT.md; the report itself rates those medians too generous and recommends lower values — see the sensitivity rows)',
  'DebtLens: the multiplier is labelled with its basis',
)
// The net gap is shown with what it is made of, and every Membrane-side figure carries †.
has(debtHtml, 'Difference, net', 'DebtLens: the difference is labelled net')
has(
  debtHtml,
  `a smaller share on ${D.all.less.toLocaleString('en-US')} positions (${pc(D.all.lessSet.realShare)} vs ${pc(D.all.lessSet.memShare)}†), a larger one on ${D.all.more.toLocaleString('en-US')} (${pc(D.all.moreSet.realShare)} vs ${pc(D.all.moreSet.memShare)}†)`,
  'DebtLens: the gross beside the net',
)
has(debtHtml, 'Difference†', 'DebtLens: the difference column carries †')
has(debtHtml, '27.1% → 13.2%† ', 'DebtLens: the Aave row, shares')
has(debtHtml, '63.9% → 13.6%† ', 'DebtLens: the Morpho row, shares')
has(debtHtml, 'Aave V3', 'DebtLens: the Aave row of the split')
has(debtHtml, 'Morpho Blue', 'DebtLens: the Morpho row of the split')
has(debtHtml, '13.9 pp less†', 'DebtLens: Aave gap')
has(debtHtml, '50.3 pp less†', 'DebtLens: Morpho gap')
for (const v of D.byVenueChain) has(debtHtml, v.label, `DebtLens: per-chain row ${v.label}`)
has(debtHtml, 'window was still', 'DebtLens: the grid-end sales are stated')
has(debtHtml, `${doc.meta.gridEnd.positions} positions`, 'DebtLens: grid-end count')
has(debtHtml, 'no USD price', 'DebtLens: the unpriced positions are stated')
has(debtHtml, 'WETH', 'DebtLens: per-asset table')
ok(
  !/2,347|\b747\b|36\.0%|\$34\.7M|\$22\.2M|2,280|\$193\.0M|\$164\.1M/.test(debtHtml),
  'DebtLens: no old-census or first-round figure',
)
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
for (const b of T.bandSensitivity) has(timeHtml, `${pc(b.memShare)}†`, `TimeLens: band ${b.band}`)
has(timeHtml, 'of Membrane’s debt closed', 'TimeLens: the bands are shares of Membrane’s own debt')
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
has(desc, 'the protocols closed 31.2% of the debt', 'SEO: protocols closed, a share')
has(desc, 'Membrane at its own lines 13.3% (modelled)', 'SEO: Membrane, marked modelled')
has(desc, '17.9 pp less net', 'SEO: the net gap')
has(desc, 'Aave 13.9 pp less, Morpho 50.3 pp less', 'SEO: the split')
ok(!/71%|17\.8%|\$193|\$164/.test(desc), 'SEO: the stale figures are gone')
checks++

// The landing copy (facts.ts): derived from the census, the split on every blended line.
const bridge = HERO_VARIANTS.c.bridge.line
has(bridge, '1,545 of the 3,197 positions liquidated on Aave and Morpho', 'landing bridge: the set')
has(bridge, '1,648 hold collateral Membrane has no line for', 'landing bridge: the exclusion')
has(bridge, 'the protocols force-closed 31.2% of the debt', 'landing bridge: protocols closed')
has(bridge, '13.3%†', 'landing bridge: Membrane, modelled')
has(bridge, '17.9 pp less, net', 'landing bridge: net, in pp')
has(bridge, 'Aave 13.9 pp less, Morpho 50.3 pp less', 'landing bridge: the split')
has(bridge, 'capped by the liquidity the day showed†', 'landing bridge: the cap, modelled')
has(bridge, 'its protocol’s oracle read on chain', 'landing bridge: names the oracle')
for (const v of Object.values(HERO_VARIANTS)) {
  ok(!/747|36%|Chainlink|\$193|2,280/.test(v.bridge.line), 'no hero variant keeps an old line')
}
has(CLOSE.headline, '1,545', 'Close headline: the compared count')
const lines = CLOSE.contains.lines.join('\n')
{
  const c = headline.concentration
  has(
    lines,
    `Without it the net is ${ppw(c.gapWithoutTop1Pp)}†`,
    'Close: the without-top-1 figure carries †',
  )
  has(
    lines,
    `without them it is ${ppw(c.gapWithoutTop5Pp)}†`,
    'Close: the without-top-5 figure carries †',
  )
}
has(
  lines,
  `a smaller share on ${D.all.less.toLocaleString('en-US')} positions and a larger one on ${D.all.more.toLocaleString('en-US')}`,
  'Close: the net figure with its gross counts',
)
has(
  lines,
  'lower for 1,507 positions, higher (up to 1.28×) for the 38 whose Membrane line is above the protocol’s',
  'Close: the sizing is stated both ways, never "carries less debt"',
)
ok(
  !/carries less debt|smaller debt a Membrane borrower/.test(lines + bridge),
  'no "less debt" claim',
)
has(
  lines,
  'no Membrane dollar is set beside it',
  'Close: the real dollars are the size of the day, never compared',
)
has(
  lines,
  'modelled: 0.98×, the unweighted mean of the three measured class medians of depth recovery 8h after five crashes (membrane-datasets q28/liquidity-recovery REPORT.md; the report itself rates those medians too generous and recommends lower values — see the sensitivity rows)',
  'Close: the multiplier is labelled with its basis',
)
has(
  bridge,
  `a smaller share on ${D.all.less.toLocaleString('en-US')} positions (${pc(D.all.lessSet.realShare)} vs ${pc(D.all.lessSet.memShare)}†), a larger one on ${D.all.more.toLocaleString('en-US')} (${pc(D.all.moreSet.realShare)} vs ${pc(D.all.moreSet.memShare)}†)`,
  'landing bridge: net, with both counts and the gross shares',
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
has(heroChartHtml, '17.9 pp less, net†', 'HeroChart: net, in pp, modelled')
has(heroChartHtml, OCT10_SCALE_LINE.gross, 'HeroChart: the gross counts beside it')
has(
  heroChartHtml,
  'Aave 27.1% → 13.2%† (13.9 pp less) · Morpho 63.9% → 13.6%† (50.3 pp less)',
  'HeroChart: the split',
)
has(heroChartHtml, 'the dollars differ and are not compared', 'HeroChart: no dollar comparison')
ok(!/protected/i.test(heroChartHtml), 'HeroChart: never "protected"')
const guaranteeHtml = render(React.createElement(GuaranteeBlock, {}))
ok(!/protected|\balone\b/i.test(guaranteeHtml), 'GuaranteeBlock: never "protected", never "alone"')
// The corpus (collateral kept) line is DORMANT (owner ruling: no collateral-seized metrics;
// oct10Totals.ts SHOW_CORPUS_COLLATERAL_LINE): the census line leads the block.
ok(
  !/of collateral|would have kept/i.test(guaranteeHtml),
  'GuaranteeBlock: no collateral-kept line on the landing',
)
has(guaranteeHtml, 'days measured · Aave + Morpho', 'GuaranteeBlock: the census window')
has(guaranteeHtml, OCT10_SCALE_LINE.scope, 'GuaranteeBlock: with its scope named')
has(
  guaranteeHtml,
  '17.9 pp less of the debt force-closed, net† (31.2% → 13.3%†)',
  'GuaranteeBlock: net, modelled',
)
has(lines, 'Aave V3: 992 positions', 'Close: the Aave split')
has(lines, 'Morpho Blue: 553 positions', 'Close: the Morpho split')
has(lines, `${doc.meta.gridEnd.positions} positions were still inside`, 'Close: grid end')
has(
  lines,
  `${D.all.more.toLocaleString('en-US')} positions lose a larger share on Membrane†`,
  'Close: losses',
)
ok(
  !/2,347|\b747\b|\b290\b|\b110\b|\b184\b|\$34\.7M|\$22\.2M|2,280|\$193\.0M/.test(lines),
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
    (r, i) => i === 0 || (sparedPp(bySpared[i - 1]) ?? -Infinity) >= (sparedPp(r) ?? -Infinity),
  ),
  'sort: spared (pp of debt) desc',
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

console.log(
  `EVIDENCE CENSUS OK — ${checks} assertions passed${skipped ? ` (WARNING: ${skipped} SKIPPED, datasets absent)` : ''}`,
)
console.log(
  `  ${rows.length} positions · real ${pc(D.all.realShare)} of their debt · Membrane ${pc(D.all.memShare)}† of its own · ${ppw(D.all.gapPp)} · size of the day ${usdM(D.all.realRepaidUsd)}`,
)
console.log(
  `  less/more/equal/unpriced ${D.all.less}/${D.all.more}/${D.all.equal}/${D.all.unpricedPositions} · cured ${T.cure.curedInWindow}/${T.cure.accountsAnalysed} · grid end ${doc.meta.gridEnd.positions}`,
)
console.log(
  `  census.json ${censusChecked ? 'checked (sha256 and totals)' : `not found at ${censusPath}: checked against the totals recorded in meta.source.totals`}; fresh prints ${freshChecked ? 'recounted on the oracle path' : 'not recounted (inputs absent)'}`,
)
console.log(`  served file ${bytes.toLocaleString('en-US')} B`)
