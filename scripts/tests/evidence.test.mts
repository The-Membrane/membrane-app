/**
 * Verifies the Evidence lenses actually render, against the REAL dataset.
 *
 * The app currently has an unrelated, app-wide hydration hang (router.isReady
 * stays false on every page, including untouched ones), so the browser cannot
 * exercise these components. This renders them directly instead: if a lens
 * throws, or renders without its key numbers, this fails.
 */
import fs from 'node:fs'
import assert from 'node:assert'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChakraProvider } from '@chakra-ui/react'

import type { EvidenceDoc } from '@/components/Evidence/types'

// Dynamic imports: tsx's static-import hoisting resolves these JSX modules before
// they finish evaluating and reports a phantom "no export named" error.
const { DebtLens } = await import('@/components/Evidence/DebtLens')
const { TimeLens } = await import('@/components/Evidence/TimeLens')
const { CohortLens } = await import('@/components/Evidence/CohortLens')
const { sparedUsd } = await import('@/components/Evidence/types')

const doc: EvidenceDoc = JSON.parse(
  fs.readFileSync('public/data/oct10-2025/evidence.json', 'utf8'),
)

const render = (el: React.ReactElement) =>
  renderToStaticMarkup(React.createElement(ChakraProvider, null, el))

let checks = 0
const has = (html: string, needle: string, what: string) => {
  assert.ok(html.includes(needle), `${what}: expected to find ${JSON.stringify(needle)}`)
  checks++
}

// ---- dataset integrity ---------------------------------------------------
assert.strictEqual(doc.cohort.length, doc.debt.accounts, 'cohort length == debt.accounts')
assert.strictEqual(doc.debt.membraneClosesLess + doc.debt.membraneClosesMore, doc.debt.accounts,
  'less + more partitions the cohort')
checks += 2

// the headline must be reproducible from the raw rows, not just trusted
const aave = doc.cohort.reduce((s, r) => s + r.aaveClosedUsd, 0)
const mem = doc.cohort.reduce((s, r) => s + r.membraneClosedUsd, 0)
assert.ok(Math.abs(aave - doc.debt.aaveClosedUsd) < 1, 'aave total matches cohort sum')
assert.ok(Math.abs(mem - doc.debt.membraneClosedUsd) < 1, 'membrane total matches cohort sum')
assert.ok(Math.abs(aave - mem - doc.debt.differenceUsd) < 1, 'difference matches')
checks += 3

const less = doc.cohort.filter((r) => r.membraneClosedFrac < r.aaveClosedFrac).length
assert.strictEqual(less, doc.debt.membraneClosesLess, 'membraneClosesLess recomputes')
checks++

const cur = doc.cohort.filter((r) => r.cure)
const cured = cur.filter((r) => r.cure!.curedInWindow).length
const healthy = cur.filter((r) => r.cure!.healthyAt8h).length
assert.strictEqual(cur.length, doc.time.accountsAnalysed, 'cure sample size matches')
assert.strictEqual(cured, doc.time.curedInWindow, 'curedInWindow recomputes')
assert.strictEqual(healthy, doc.time.healthyAt8h, 'healthyAt8h recomputes')
assert.ok(healthy <= cured, 'healthy-at-8h is a subset of cured')
checks += 4

// ---- DebtLens ------------------------------------------------------------
const debtHtml = render(React.createElement(DebtLens, { debt: doc.debt, byAsset: doc.byAsset }))
has(debtHtml, '$144.2M', 'DebtLens Aave total')
has(debtHtml, '$105.0M', 'DebtLens Membrane total')
has(debtHtml, '27.2% less debt closed', 'DebtLens difference')
has(debtHtml, '2,245', 'DebtLens closes-less count')
has(debtHtml, '105', 'DebtLens closes-more count')
has(debtHtml, 'WETH', 'DebtLens per-asset table')
has(debtHtml, '71.0%', 'DebtLens Aave median')
has(debtHtml, '17.8%', 'DebtLens Membrane median')

// ---- TimeLens ------------------------------------------------------------
const timeHtml = render(React.createElement(TimeLens, { time: doc.time }))
has(timeHtml, '0s', 'TimeLens Aave grants zero')
has(timeHtml, '8h', 'TimeLens Membrane window')
has(timeHtml, '87.52%', 'TimeLens cured pct')
has(timeHtml, '60.76%', 'TimeLens healthy-at-8h pct')
has(timeHtml, '43 min', 'TimeLens median cure time')
has(timeHtml, '281', 'TimeLens re-breach delta (919-638)')

// ---- CohortLens ----------------------------------------------------------
const cohortHtml = render(React.createElement(CohortLens, { rows: doc.cohort }))
has(cohortHtml, 'Showing 100 of 2,350', 'CohortLens states its cap explicitly')
has(cohortHtml, 'wstETH/USDC', 'CohortLens renders the largest position')
has(cohortHtml, 'Membrane worse', 'CohortLens exposes the losing filter')

// the table must be sorted by debt desc by default
const top = [...doc.cohort].sort((a, b) => b.debtUsd - a.debtUsd)[0]
has(cohortHtml, `${top.collSymbol}/${top.debtSymbol}`, 'CohortLens default sort = largest debt')

// spared can be negative -- confirm such rows exist, so the UI must handle it
const negatives = doc.cohort.filter((r) => sparedUsd(r) < 0).length
assert.ok(negatives > 0, 'negative-spared rows exist and must render')
checks++

console.log(`EVIDENCE OK — ${checks} assertions passed`)
console.log(`  cohort ${doc.cohort.length}  aave $${aave.toLocaleString()}  membrane $${mem.toLocaleString()}`)
console.log(`  cure sample ${cur.length}  cured ${cured}  healthy@8h ${healthy}`)
console.log(`  rows where Membrane closes MORE: ${negatives}`)

// ---- interaction logic ---------------------------------------------------
// The preview browser runs the tab permanently hidden, so requestAnimationFrame
// never fires; Next's displayContent() therefore never resolves and NO page in
// the app hydrates. Clicks cannot be tested there. So the filter/sort logic that
// the UI's controls drive is exercised directly here instead.
const { useCohort } = await import('@/components/Evidence/useEvidence')

function probe(opts: Parameters<typeof useCohort>[1]) {
  let out: ReturnType<typeof useCohort> | null = null
  const P: React.FC = () => {
    out = useCohort(doc.cohort, opts)
    return null
  }
  renderToStaticMarkup(React.createElement(P))
  return out!
}

const base = { asset: 'all', chain: 'all', outcome: 'all' as const, sort: 'debtUsd' as const, limit: 100 }

const all = probe(base)
assert.strictEqual(all.total, 2350, 'unfiltered total')
assert.strictEqual(all.matched, 2350, 'unfiltered matched')
assert.strictEqual(all.visible.length, 100, 'limit caps visible rows')
checks += 3

const worse = probe({ ...base, outcome: 'membraneMore' })
assert.strictEqual(worse.matched, doc.debt.membraneClosesMore,
  'the "Membrane worse" filter surfaces exactly the losing accounts')
checks++

const better = probe({ ...base, outcome: 'membraneLess' })
assert.strictEqual(better.matched, doc.debt.membraneClosesLess, '"Membrane closes less" filter')
assert.strictEqual(better.matched + worse.matched, 2350, 'the two outcome filters partition')
checks += 2

const curedF = probe({ ...base, outcome: 'cured' })
assert.strictEqual(curedF.matched, doc.time.curedInWindow, '"cured in 8h" filter')
checks++

const weth = probe({ ...base, asset: 'WETH' })
assert.strictEqual(weth.matched, doc.byAsset.WETH.accounts, 'asset filter matches byAsset count')
assert.ok(weth.visible.every((r) => r.collSymbol === 'WETH'), 'asset filter is exclusive')
checks += 2

// sorts must actually order
const byDebt = probe(base).visible
assert.ok(byDebt.every((r, i) => i === 0 || byDebt[i - 1].debtUsd >= r.debtUsd), 'sort: debt desc')
const bySpared = probe({ ...base, sort: 'spared' }).visible
assert.ok(bySpared.every((r, i) => i === 0 || sparedUsd(bySpared[i - 1]) >= sparedUsd(r)), 'sort: spared desc')
const byEvents = probe({ ...base, sort: 'events' }).visible
assert.strictEqual(byEvents[0].events, Math.max(...doc.cohort.map((r) => r.events)), 'sort: most repeat hits')
checks += 3

// combined filters must compose
const combo = probe({ ...base, asset: 'WETH', outcome: 'cured' })
assert.ok(combo.matched > 0 && combo.matched <= weth.matched, 'filters compose')
assert.ok(combo.visible.every((r) => r.collSymbol === 'WETH' && r.cure?.curedInWindow), 'composed filter is correct')
checks += 2

console.log(`INTERACTION OK — filter/sort verified headlessly (${checks} total assertions)`)
console.log(`  "Membrane worse" filter -> ${worse.matched} accounts`)
console.log(`  "cured in 8h" filter    -> ${curedF.matched} accounts`)
console.log(`  WETH + cured            -> ${combo.matched} accounts`)
console.log(`  worst repeat-liquidated -> ${byEvents[0].events} separate liquidations`)
