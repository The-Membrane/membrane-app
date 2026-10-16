/**
 * Integrity of public/data/oct10-2025/evidence.json — the OLD census (scripts/build-evidence.ts,
 * 2,347 Aave accounts priced off mainnet Chainlink rounds).
 *
 * 2026-10-16 (owner decision): no page reads this file any more. The Evidence page and the
 * landing read the full on-chain census, public/data/oct10-2025/evidence-census.json, and
 * their lens text, filters and sorts are tested in scripts/tests/evidence-census.test.mts.
 * This file and its builder are kept because tests/unit/wavefrontKernel.test.ts,
 * scripts/tests/position-sim.test.ts and the census cross-check (meta.crossCheck) use it as a
 * fixture, so its own integrity checks stay here, unchanged. The UI render checks that used to
 * close this file asserted the old doc against the old components; the components now render
 * the census, and those checks moved to the census twin with the census's figures.
 */
import fs from 'node:fs'
import assert from 'node:assert'

// The old document's shape. Its TypeScript interface lived in components/Evidence/types.ts,
// which now types the census; this test reads the old file untyped, as the builder writes it.
type OldDoc = any
const doc: OldDoc = JSON.parse(fs.readFileSync('public/data/oct10-2025/evidence.json', 'utf8'))

let checks = 0

// ---- dataset integrity ---------------------------------------------------
// EVERY summary number is over INCLUDED rows. The cohort array carries the excluded
// ones too, flagged, so the table can still show them — so the two counts differ by
// exactly meta.excluded.accounts and nothing else.
const inc = (doc.cohort as any[]).filter((r) => !r.excluded)
const exc = (doc.cohort as any[]).filter((r) => r.excluded)
// UPDATED 2026-09-14: doc.debt publishes TWO sets. The flat fields ARE `priced` — the
// included rows whose collateral has a series, so the band/walk/cure model applies —
// and `allIncluded` adds back the rows with no collateral series, which take one repay
// and can never cure. Everything below checks both, and never conflates them.
const pricedRows = inc.filter((r) => r.priced)
const unpricedRows = inc.filter((r) => !r.priced)
const D = doc.debt as any
assert.strictEqual(inc.length, D.allIncluded.accounts, 'included rows == debt.allIncluded.accounts')
assert.strictEqual(pricedRows.length, D.priced.accounts, 'priced rows == debt.priced.accounts')
assert.strictEqual(D.accounts, D.priced.accounts, 'the flat debt fields ARE the priced set')
assert.strictEqual(
  pricedRows.length + unpricedRows.length,
  inc.length,
  'priced + unpriced-collateral partitions the included rows',
)
assert.ok(unpricedRows.length > 0, 'the unpriced-collateral tail exists and is published')
assert.ok(
  unpricedRows.every((r) => r.collClass === 'unpriced'),
  'a row is unpriced for the walk exactly when its collateral class is unpriced',
)
assert.strictEqual(exc.length, (doc.meta as any).excluded.accounts, 'excluded count is published')
assert.strictEqual(
  doc.cohort.length,
  inc.length + exc.length,
  'the cohort is exactly included + excluded',
)
assert.strictEqual(
  D.membraneClosesLess + D.membraneClosesMore,
  D.priced.accounts,
  'less + more partitions the PRICED rows',
)
checks += 9

// the headline must be reproducible from the raw rows, not just trusted
const sumOf = (rows: any[], k: string) => rows.reduce((s, r) => s + r[k], 0)
const aave = sumOf(inc, 'aaveClosedUsd')
const mem = sumOf(inc, 'membraneClosedUsd')
for (const [label, rows, set] of [
  ['priced', pricedRows, D.priced],
  ['allIncluded', inc, D.allIncluded],
] as [string, any[], any][]) {
  assert.ok(
    Math.abs(sumOf(rows, 'aaveClosedUsd') - set.aaveClosedUsd) < 1,
    `${label}: aave total matches its rows`,
  )
  assert.ok(
    Math.abs(sumOf(rows, 'membraneClosedUsd') - set.membraneClosedUsd) < 1,
    `${label}: membrane total matches its rows`,
  )
  assert.ok(
    Math.abs(sumOf(rows, 'membraneOneRepayUsd') - set.membraneOneRepayUsd) < 1,
    `${label}: one-repay total matches its rows`,
  )
  assert.ok(
    Math.abs(set.aaveClosedUsd - set.membraneClosedUsd - set.gapUsd) < 1,
    `${label}: gap is the subtraction it claims`,
  )
  assert.strictEqual(set.accounts, rows.length, `${label}: account count matches its rows`)
  checks += 5
}
assert.ok(Math.abs(aave - mem - D.allIncluded.gapUsd) < 1, 'allIncluded difference matches')
// An unpriced row closes its one repay and never cures, so it moves the two sets apart
// by exactly the same amount on both Membrane figures. That identity is the claim.
assert.ok(
  unpricedRows.every((r) => Math.abs(r.membraneClosedUsd - r.membraneOneRepayUsd) < 0.02),
  'an unpriced-collateral row closes exactly one repay — no window was ever walked on it',
)
assert.ok(
  Math.abs(D.allIncluded.delayCreditUsd - D.priced.delayCreditUsd) < 1,
  'so the delay credit is identical in both sets — all of it comes from priced rows',
)
assert.ok(
  D.allIncluded.aaveClosedUsd > D.priced.aaveClosedUsd,
  'adding the unpriced tail can only raise Aave',
)
assert.ok(D.allIncluded.membraneClosedUsd > D.priced.membraneClosedUsd, 'and Membrane')
checks += 5

// ---- the block-1 rebase --------------------------------------------------
// The defect this whole rebuild exists to remove: an account read at block-1 whose
// liquidating block carried a fresh oracle print looked healthy at the moment it was
// liquidated, so the model saw no breach and credited Membrane with closing ~$0.
const excMeta = (doc.meta as any).excluded
assert.ok(excMeta.aaveClosedUsd > 0, 'the excluded rows carry their Aave USD, published')
assert.ok(
  Math.abs(exc.reduce((s, r) => s + r.aaveClosedUsd, 0) - excMeta.aaveClosedUsd) < 1,
  'meta.excluded.aaveClosedUsd recomputes from the flagged rows',
)
// ltv0 and liqLine are published rounded to 5dp, so two rows that clear the line by
// less than 1e-5 land on equality here. The tolerance is the rounding, nothing else.
const EPS = 1e-5
assert.ok(
  exc.every((r) => r.ltv0 <= r.liqLine + EPS),
  'every excluded row really is still under its line AFTER the rebase',
)
// ADDED 2026-10-14: a MIXED account (a stable AND a volatile reserve seized) cannot exist
// on Membrane, but the CSV cannot class it as anything else either, so the headline walks
// it delayed exactly as before. Excluding it is a published sensitivity, not the headline.
assert.ok(
  inc.some((r) => r.delayClass === 'mixed') &&
    inc.filter((r) => r.delayClass === 'mixed').every((r) => r.outcome !== 'sold-no-delay'),
  'mixed accounts stay in the headline, walked delayed',
)
checks += 2
assert.ok(
  inc.every((r) => r.ltv0 >= r.liqLine - EPS),
  'every INCLUDED row really is breached after the rebase — no unlocated lines survive',
)
assert.ok(
  excMeta.rebasedIntoBreach > 0,
  `the rebase pulled ${excMeta.rebasedIntoBreach} snapshot-healthy accounts into a real breach`,
)
assert.ok(
  (doc.cohort as any[]).every(
    (r) =>
      Math.abs(r.collateralUsd - r.snapshotCollateralUsd * r.rebaseColl) <
      Math.max(1, r.collateralUsd * 1e-5),
  ),
  'collateralUsd is exactly the snapshot scaled by the published rebase ratio',
)
checks += 6

// ---- the delay-window model ---------------------------------------------
// The Membrane figure is a WALK now, not one repay. These assertions are what stops it
// silently reverting to the old number or drifting from lib/position-sim/curePath.ts.
const cm = (doc.meta as any).cureModel
assert.ok(cm, 'meta.cureModel is published')
assert.strictEqual(cm.delaySeconds, 28_800, 'delay 28800s')
assert.strictEqual(cm.band, 0.04, 'band 4%')
assert.strictEqual(cm.borrowLtvGap, 0.03, 'borrow-cap gap 3pp')
// The deployed liqDebtMinimum: script/DeployFullSystem.s.sol:388 setLiqDebtMinimum(2000e18).
assert.strictEqual(cm.debtMinimumUsd, 2000, 'liqDebtMinimum $2,000')
assert.strictEqual(cm.maxSales, 20, 'sales per episode capped at 20')
checks += 6

const outcomeTotal = (Object.values(cm.outcomes) as number[]).reduce((s, v) => s + v, 0)
assert.strictEqual(outcomeTotal, inc.length, 'the outcome histogram partitions the INCLUDED rows')
const outcomeFromRows: Record<string, number> = {}
for (const r of inc) outcomeFromRows[r.outcome] = (outcomeFromRows[r.outcome] ?? 0) + 1
assert.deepStrictEqual(outcomeFromRows, cm.outcomes, 'the histogram recomputes from the rows')
// After the rebase no INCLUDED row may carry the unlocated-line outcome — that is now
// exactly the exclusion criterion, so it appearing here would mean the filter leaked.
assert.ok(
  !('sold-immediately-unlocated-line' in cm.outcomes),
  'no included row has an unlocated line any more',
)
checks += 3

const oneRepay = sumOf(inc, 'membraneOneRepayUsd')
assert.ok(Math.abs(oneRepay - cm.membraneOneRepayUsd) < 1, 'one-repay total matches the rows')
assert.ok(
  Math.abs(oneRepay - mem - cm.delayCreditUsd) < 1,
  'delay credit is the subtraction it claims',
)
checks += 2

// Every row that was never sold must close nothing, and every sale must name its minute.
for (const r of inc) {
  if (r.closedAtIndex === null) {
    assert.strictEqual(r.membraneClosedUsd, 0, `${r.user}: unsold rows close nothing`)
    assert.ok(r.outcome === 'held' || r.outcome === 'cured-then-held', `${r.user}: unsold outcome`)
  } else {
    assert.ok(r.outcome.startsWith('sold'), `${r.user}: a sale must carry a sold-* outcome`)
  }
}
checks++

// The excluded rows keep the conservative one-repay figure so the table can show a
// number, but that number must never reach a total.
assert.ok(exc.length > 400, `the unresolvable cohort is still sizeable (${exc.length})`)
assert.ok(
  exc.every((r) => r.outcome === 'sold-immediately-unlocated-line'),
  'every excluded row carries the unlocated-line outcome',
)
assert.ok(
  exc.every((r) => r.membraneClosedUsd === r.membraneOneRepayUsd),
  'each excluded row keeps the one-repay figure for display',
)
checks += 3

// ---- the decomposition ---------------------------------------------------
// NET delay credit = gross credit - counter-credit, by construction.
assert.ok(
  Math.abs(cm.cureCreditGrossUsd - cm.counterCreditUsd - cm.delayCreditUsd) < 1,
  'delayCreditUsd is gross minus counter',
)
assert.ok(
  cm.counterCreditUsd > 0 && cm.counterCreditAccounts > 0,
  'accounts where the deferred sale cost MORE exist and are published',
)
// gapByOutcome must partition the included rows and reconstruct the headline gap.
const gapAccounts = (Object.values(cm.gapByOutcome) as any[]).reduce((s, g) => s + g.accounts, 0)
const gapTotal = (Object.values(cm.gapByOutcome) as any[]).reduce((s, g) => s + g.gapUsd, 0)
assert.strictEqual(gapAccounts, inc.length, 'gapByOutcome partitions the included rows')
assert.ok(Math.abs(gapTotal - D.allIncluded.gapUsd) < 1, 'gapByOutcome sums to the allIncluded gap')
// locatedLineOnly is the ALL-INCLUDED headline: every included row has a located line.
assert.strictEqual(cm.locatedLineOnly.accounts, inc.length, 'located-line count == allIncluded')
assert.ok(
  Math.abs(cm.locatedLineOnly.aaveClosedUsd - D.allIncluded.aaveClosedUsd) < 1,
  'located Aave == allIncluded',
)
assert.ok(
  Math.abs(cm.locatedLineOnly.membraneClosedUsd - D.allIncluded.membraneClosedUsd) < 1,
  'located Membrane == allIncluded',
)
// Concentration, against the positive side of the gap (the net can be negative).
assert.ok(
  cm.concentration.top1Share > 0 && cm.concentration.top1Share <= 1,
  'top1 share is a share',
)
assert.ok(cm.concentration.top5Share >= cm.concentration.top1Share, 'top5 >= top1')
assert.ok(typeof cm.concentration.top1Account === 'string', 'the top account is named, not hidden')
// What a 2-minute cure physically was.
assert.strictEqual(cm.freshEthPrints, 183, 'the ETH oracle printed fresh in 183 minutes')
assert.strictEqual(cm.gridMinutes, 2880, 'of 2,880 in the window')
assert.ok(
  cm.medianRequiredUpMoveFastCurePct > 0 && cm.medianRequiredUpMoveFastCurePct < 5,
  `a fast cure needed a sub-5% up-move (median ${cm.medianRequiredUpMoveFastCurePct}%)`,
)
checks += 12

// ---- what the block-level rebase publishes -------------------------------
// The rebase is now a BLOCK fact: p_state is the last round the snapshot block could
// see, p_liq the last round the liquidating block could. Nothing here may be derivable
// from a minute cell, and every row must carry the two prices its ratio is made of.
assert.ok(
  (doc.cohort as any[]).every((r) => typeof r.block === 'number' && r.block > 0),
  'every row names the block it was liquidated in',
)
assert.ok(
  (doc.cohort as any[]).every(
    (r) => r.pLiqColl === null || Math.abs(r.rebaseColl - r.pLiqColl / r.pStateColl) < 1e-4,
  ),
  'rebaseColl is exactly pLiqColl / pStateColl — the two published prices, nothing else',
)
// Only a round landing IN the liquidating block can move an account, so a rebase is the
// rare case, not the common one. If this ever becomes a majority, the block matching broke.
const rebased = (doc.cohort as any[]).filter((r) => Math.abs(r.rebaseColl - 1) > 1e-9)
assert.ok(rebased.length > 0, 'some accounts really were liquidated in a printing block')
assert.ok(
  rebased.length < doc.cohort.length * 0.05,
  `a rebase is the exception (${rebased.length} of ${doc.cohort.length})`,
)
checks += 4

// The headline block, and the same four numbers with the excluded rows kept.
assert.ok(
  Math.abs(cm.headline.aaveClosedUsd - D.allIncluded.aaveClosedUsd) < 1,
  'headline Aave == allIncluded',
)
assert.ok(
  Math.abs(cm.headline.membraneClosedUsd - D.allIncluded.membraneClosedUsd) < 1,
  'headline Membrane == allIncluded',
)
assert.strictEqual(cm.headline.accounts, inc.length, 'headline counts included rows')
// cureModel republishes both sets so no surface has to reach into doc.debt for them.
assert.deepStrictEqual(cm.priced, D.priced, 'cureModel.priced is the same object as debt.priced')
assert.deepStrictEqual(
  cm.allIncluded,
  D.allIncluded,
  'cureModel.allIncluded matches debt.allIncluded',
)
checks += 2
assert.strictEqual(cm.withExcludedKept.accounts, doc.cohort.length, 'with-excluded keeps every row')
assert.ok(
  Math.abs(
    cm.withExcludedKept.aaveClosedUsd -
      (doc.cohort as any[]).reduce((s, r) => s + r.aaveClosedUsd, 0),
  ) < 1,
  'with-excluded Aave recomputes from the cohort',
)
/**
 * THE TWO SETS NOW DISAGREE IN SIGN, and that is the deliberate expectation (2026-09-14).
 *
 * `priced` says Membrane closes LESS than Aave. `allIncluded` says it closes more. The
 * whole difference is the unpriced-collateral tail: those rows have no series, so they
 * cannot be walked at all - they take ONE repay-to-cap at t0, sized from the ORACLE value
 * of collateral nothing here can price, and can never cure. They import an upper bound
 * with none of the delay window it exists to be compared against, and `allIncluded`
 * exists precisely so that import is visible rather than blended away.
 *
 * Both sets used to be negative. They stopped being so when wstETH stopped being priced
 * through the STETH/ETH MARKET feed: that feed moved wstETH 4.4% against ETH inside eight
 * minutes and held two huge wstETH accounts inside the band that Aave's own prices (a
 * CONSTANT wrap rate) put outside it. It was worth
 * meta.sensitivity.wstethMarketFeedMembraneClosedUsd.pricedDeltaUsd on its own.
 */
assert.ok(D.priced.gapPct > 0, `priced: Membrane closes LESS than Aave (${D.priced.gapPct}%)`)
assert.ok(
  D.allIncluded.gapPct < 0,
  `allIncluded: the unpriced tail's one-repay upper bound flips it (${D.allIncluded.gapPct}%)`,
)
assert.ok(
  D.priced.gapPct > D.allIncluded.gapPct,
  'and the unpriced tail can only move the gap toward Membrane closing more',
)
checks += 3
// Keeping them FLIPS the sign of the headline: the excluded rows are where Aave's money is.
// headline is the allIncluded view, so it carries the unpriced tail's sign; keeping the
// EXCLUDED rows on both sides flips it back, because that is where Aave's money is.
assert.ok(
  cm.headline.gapPct < 0 && cm.withExcludedKept.gapPct > 0,
  `included-only Membrane closes MORE (${cm.headline.gapPct}%) and with-excluded LESS (${cm.withExcludedKept.gapPct}%)`,
)
checks += 6

// The excluded set is characterised, not just counted.
assert.ok(
  excMeta.medianDebtUsd > 0 && excMeta.inCrashWindowPct > 0,
  'excluded size and timing published',
)
assert.ok(Object.keys(excMeta.byChain).length > 1, 'the excluded set spans chains, and says so')
// Almost all of them fail for ONE reason: Aave read them healthy at block N-1.
assert.ok(
  excMeta.healthFactorAtSnapshotAtLeast1 / excMeta.accounts > 0.9,
  `the exclusion is a snapshot-health problem (${excMeta.healthFactorAtSnapshotAtLeast1}/${excMeta.accounts} had hf >= 1)`,
)
// ADDED 2026-09-14: a mutually exclusive reason breakdown, so the shares actually sum.
const br = excMeta.byReason
assert.strictEqual(
  (Object.values(br) as any[]).reduce((s, b) => s + b.accounts, 0),
  excMeta.accounts,
  'the reason buckets partition the excluded set',
)
assert.ok(
  Math.abs(
    (Object.values(br) as any[]).reduce((s, b) => s + b.aaveClosedUsd, 0) - excMeta.aaveClosedUsd,
  ) < 1,
  'and their Aave dollars sum to the excluded total',
)
assert.ok(
  br.snapshotHealthyNoBlockNRound?.accounts > 0,
  'the snapshot-health bucket is the named majority reason',
)
assert.ok(
  br.l2TimestampProxy?.accounts > 0,
  'the L2 timestamp-proxy bucket is published separately',
)
assert.ok(!('mixedDelayClass' in br), 'mixed accounts are not an exclusion reason')
checks += 8

// The per-account medians. The all-included Membrane median is a FLOOR artefact and the
// dataset must say so by publishing the subset the floor does not swallow.
const med = cm.medians
assert.strictEqual(
  med.allIncluded.accounts,
  inc.length,
  'the all-included median block is every included row',
)
assert.strictEqual(
  med.allIncluded.membraneMedianFrac,
  1,
  'the median included account is closed WHOLE by the floor',
)
assert.ok(
  med.debtAtLeastFloor.accounts < med.allIncluded.accounts,
  'the >= $2,000 subset is a subset',
)
assert.ok(
  med.debtAtLeastFloor.membraneMedianFrac < 1,
  `above the floor the median is a real partial (${med.debtAtLeastFloor.membraneMedianFrac})`,
)
assert.strictEqual(med.floorUsd, 2000, 'the floor the subset is cut at is named')
checks += 5

// Held whole day, and the accounts already past the band at t0.
assert.strictEqual(
  cm.heldWholeDay.accounts,
  inc.filter((r) => r.closedAtIndex === null).length,
  'held-whole-day counts the rows that were never sold',
)
// Who those rows actually are. One account can carry the clearest outcome in the dataset,
// so both denominators are published with the account named.
const hc = cm.heldConcentration
assert.strictEqual(hc.accounts, cm.heldWholeDay.accounts, 'held concentration covers the held set')
assert.ok(Math.abs(hc.debtUsd - cm.heldWholeDay.debtUsd) < 1, 'and the same held debt')
assert.ok(
  hc.debtTop1Share > 0 && hc.debtTop1Share <= 1 && hc.debtTop5Share >= hc.debtTop1Share,
  `held-debt shares are shares (top1 ${hc.debtTop1Share}, top5 ${hc.debtTop5Share})`,
)
assert.ok(
  hc.cureCreditTop1Share > 0 && hc.cureCreditTop5Share >= hc.cureCreditTop1Share,
  'held cure-credit shares are shares',
)
assert.ok(
  typeof hc.debtTop1Account === 'string' && hc.debtTop5Accounts.length === 5,
  'the accounts carrying the held set are NAMED, not just counted',
)
assert.ok(typeof hc.cureCreditTop1Account === 'string', 'and so is the top cure-credit account')
checks += 6
assert.ok(cm.heldWholeDay.debtUsd > 0, 'and carries their debt')
assert.strictEqual(
  cm.soldAtT0.accounts,
  cm.outcomes['sold-at-t0'],
  'sold-at-t0 matches the histogram',
)
assert.ok(
  cm.soldAtT0.medianDistancePastLinePct > cm.soldAtT0.bandPct,
  `a sold-at-t0 row is past the band by construction (median ${cm.soldAtT0.medianDistancePastLinePct}% vs band ${cm.soldAtT0.bandPct}%)`,
)
checks += 4

// Concentration against the ABSOLUTE gap — how few accounts decide the headline at all.
const ac = cm.absoluteConcentration
assert.ok(
  ac.top1Share > 0 && ac.top1Share <= 1 && ac.top5Share >= ac.top1Share,
  '|gap| shares are shares',
)
assert.ok(
  Math.abs(
    ac.gapAbsoluteUsd -
      inc.reduce((s, r) => s + Math.abs(r.aaveClosedUsd - r.membraneClosedUsd), 0),
  ) < 1,
  'the absolute-gap denominator recomputes from the rows',
)
assert.ok(
  ac.gapAbsoluteUsd >= Math.abs(doc.debt.differenceUsd),
  'the absolute gap is never smaller than the net gap it nets out',
)
checks += 3

// ---- the sensitivity corners ---------------------------------------------
// The ONE alignment corner left: a round in the LIQUIDATING block not counted as in
// force, so p_liq collapses onto p_state and no account is rebased at all. The old
// t0±1-minute sweep is gone — no dollar is decided from a minute cell any more.
const align = (doc.meta as any).sensitivity.alignment
assert.ok(align && align.blockNMinus1, 'the alignment sensitivity is published')
assert.strictEqual(align.countsBlockNRound, true, 'the headline counts the block-N round')
assert.ok(
  align.blockNMinus1.excludedAccounts >= (doc.meta as any).excluded.accounts,
  'not rebasing at all can only leave MORE accounts unlocated',
)
assert.ok(
  !('t0PlusOne' in (doc.meta as any).sensitivity) &&
    !('t0MinusOne' in (doc.meta as any).sensitivity),
  'the moot t0±1 minute sweep is gone',
)
checks += 4

const sens = (doc.meta as any).sensitivity
// EVERY sweep here runs over the INCLUDED rows, so it is compared against the
// allIncluded set, not the priced headline the Debt lens leads with.
const MEM_ALL = D.allIncluded.membraneClosedUsd
// Nobody ever calls the permissionless clear: that can only close MORE, never less.
assert.ok(
  sens.noEarlyClearMembraneClosedUsd >= MEM_ALL,
  'an uncleared timer never helps the borrower',
)
assert.ok(
  Math.abs(sens.noEarlyClearDeltaUsd - (sens.noEarlyClearMembraneClosedUsd - MEM_ALL)) < 1,
  'the no-early-clear delta is the subtraction it claims',
)
// The $2,000 floor escalates small chunks, so it can only close MORE.
assert.ok(sens.noDebtFloorMembraneClosedUsd <= MEM_ALL, 'switching the floor off closes less')
assert.ok(sens.debtFloorAccountsChanged > 0, 'the floor moves a published number of accounts')
// Re-arming after a sale can only close MORE than a single-sale cap.
assert.ok(sens.singleSaleMembraneClosedUsd <= MEM_ALL, 'capping at one sale closes less')
assert.ok(sens.repeatSaleAccounts > 0 && sens.maxSalesSeen > 1, 'repeat sales really happen')
// The headline with the excluded rows kept on BOTH sides, for the before/after.
assert.ok(sens.withExcludedAaveClosedUsd > D.allIncluded.aaveClosedUsd, 'keeping them raises Aave')
assert.ok(sens.withExcludedMembraneClosedUsd > MEM_ALL, 'and raises Membrane')
checks += 8
// A t0 sale past the band walks on like any sale; the old stop after it is a sensitivity, and
// stopping can only close LESS. Its deltas are the subtractions they claim, on both sets.
{
  const nw = sens.noWalkOnAfterT0BandSale
  assert.ok(nw && typeof nw.rule === 'string', 'the old t0 stop is published as a sensitivity')
  assert.ok(
    nw.pricedMembraneClosedUsd <= D.priced.membraneClosedUsd,
    'stopping closes less (priced)',
  )
  assert.ok(nw.allIncludedMembraneClosedUsd <= MEM_ALL, 'and less (allIncluded)')
  assert.ok(
    Math.abs(nw.pricedDeltaUsd - (D.priced.membraneClosedUsd - nw.pricedMembraneClosedUsd)) <
      0.01 && Math.abs(nw.allIncludedDeltaUsd - (MEM_ALL - nw.allIncludedMembraneClosedUsd)) < 0.01,
    'the walk-on deltas are the subtractions they claim',
  )
  assert.ok(
    nw.accountsChanged > 0,
    'walking on after the t0 sale moves a published number of accounts',
  )
  const t0Walked = inc.filter((r: any) => r.outcome === 'sold-at-t0' && r.sales > 1)
  assert.ok(t0Walked.length >= nw.accountsChanged, 'and those accounts sell again after t0')
  checks += 6
}

// ---- the collateral mapping ----------------------------------------------
const cmap = (doc.meta as any).collateralMapping
// UPDATED 2026-09-14: `ethProxy` is replaced by a four-way class partition, because
// wstETH moved OUT of the proxy bucket and into the exact one.
assert.ok(!('ethProxy' in cmap), 'the old single ethProxy bucket is gone')
const K = cmap.classes
assert.strictEqual(
  K.exact.accounts + K.stableFlat.accounts + K.proxied.accounts + K.unpriced.accounts,
  inc.length,
  'the four price classes partition the included rows',
)
for (const k of ['exact', 'stableFlat', 'proxied', 'unpriced']) {
  assert.ok(
    K[k].accounts > 0 && K[k].debtUsd > 0,
    `${k} is published with a count and a debt figure`,
  )
  assert.ok(Array.isArray(K[k].symbols) && K[k].symbols.length > 0, `${k} names its symbols`)
  const rows = inc.filter((r) => r.collClass === k)
  assert.strictEqual(rows.length, K[k].accounts, `${k} count recomputes from the rows`)
  checks += 3
}
// The fix itself: wstETH is EXACT, and no longer sits with the proxies.
assert.ok(K.exact.symbols.includes('wstETH'), 'wstETH is priced exactly, on its own feed')
assert.ok(!K.proxied.symbols.includes('wstETH'), 'and is not in the proxy bucket any more')
assert.ok(
  K.unpriced.accounts === unpricedRows.length,
  'the unpriced class is exactly the tail that separates the two headline sets',
)
assert.ok(cmap.multiCollateral.accounts > 0, 'the multi-collateral exposure is stated')
assert.ok(
  cmap.debtLegRatio.accounts > 0,
  'stable-collateral / volatile-debt accounts now build a ratio from the DEBT leg',
)
assert.strictEqual(cmap.freshOraclePrints.ethOracle, 183, 'fresh ETH prints published here too')
assert.ok(
  cmap.freshOraclePrints.wstethOracle > 0,
  `the wstETH composite prints fresh in ${cmap.freshOraclePrints.wstethOracle} minutes`,
)
checks += 6

// ---- the repay-to-cap execution bound ------------------------------------
// The engine sizes its repay from the ORACLE value of the collateral, so on an illiquid
// leg it is an upper bound. The HEADLINE is still uncapped - a modelled haircut would be
// a second unmeasured assumption on the first - but as of 2026-09-14 the bound is also
// PRICED: meta.sensitivity.liquidityBound caps one sale at the largest single repay real
// Aave liquidators managed on that collateral symbol that day, which is measured.
const lb = cm.liquidityBound
assert.ok(
  lb.rule.startsWith('not capped'),
  `the headline repay is not silently capped (${lb.rule})`,
)
assert.ok(
  typeof lb.cappedRule === 'string' && lb.cappedRule.includes('LARGEST SINGLE REPAY'),
  'and the capped alternative states its measured rule',
)
assert.ok(
  typeof lb.note === 'string' && lb.note.length > 100,
  'and the reason is stated, not implied',
)
assert.ok(
  lb.workedExample && lb.workedExample.membraneClosedUsd > lb.workedExample.aaveClosedUsd * 3,
  'the worked counter-example is a row where the model closes multiples of what real liquidators absorbed',
)
assert.strictEqual(
  lb.workedExample.collClass,
  'unpriced',
  'and it sits in the unpriced tail, which is why the priced set excludes it',
)
checks += 4

// ---- intra-block ordering -------------------------------------------------
// A round in the liquidating block counts only if its log_index precedes the
// LiquidationCall's. Rebases stay rare, and nothing outside the block ever moves.
assert.ok(
  rebased.length > 0 && rebased.length < 40,
  `intra-block ordering keeps the rebase rare (${rebased.length} rows)`,
)
assert.ok(
  (doc.cohort as any[]).every((r) => r.pStateColl === null || r.pLiqColl! >= 0),
  'every row carries both prices its rebase is built from',
)
checks += 2

// A tighter band must close MORE debt and a looser band LESS — monotone, by construction.
const bs = cm.bandSensitivity as { band: number; membraneClosedUsd: number }[]
assert.strictEqual(bs.length, 3, 'three bands swept')
assert.ok(bs[0].membraneClosedUsd > bs[1].membraneClosedUsd, '2% band closes more than 4%')
assert.ok(bs[1].membraneClosedUsd > bs[2].membraneClosedUsd, '4% band closes more than 8%')
assert.ok(
  Math.abs(bs[1].membraneClosedUsd - mem) < 1,
  'the 4% sweep reproduces the allIncluded total',
)
checks += 4

const less = pricedRows.filter((r) => r.membraneClosedFrac < r.aaveClosedFrac).length
assert.strictEqual(less, D.membraneClosesLess, 'membraneClosesLess recomputes over the PRICED rows')
assert.strictEqual(
  inc.filter((r) => r.membraneClosedFrac < r.aaveClosedFrac).length,
  D.allIncluded.membraneClosesLess,
  'and over every included row for the allIncluded set',
)
checks += 2

const cur = inc.filter((r) => r.cure)
const cured = cur.filter((r: any) => r.cure!.curedInWindow).length
const healthy = cur.filter((r: any) => r.cure!.healthyAt8h).length
assert.strictEqual(cur.length, doc.time.accountsAnalysed, 'cure sample size matches')
assert.strictEqual(cured, doc.time.curedInWindow, 'curedInWindow recomputes')
assert.strictEqual(healthy, doc.time.healthyAt8h, 'healthyAt8h recomputes')
// healthy-at-8h is a PRICE fact and stays published for no-delay rows, which have no
// window and so are never cured: the subset relation holds over the windowed rows only.
const windowed = cur.filter((r: any) => !r.cure!.noWindow)
assert.ok(
  windowed.filter((r: any) => r.cure!.healthyAt8h).length <=
    windowed.filter((r: any) => r.cure!.curedInWindow).length,
  'healthy-at-8h is a subset of cured, over the rows that have a window',
)
checks += 4

// ---- the delay class (lib/position-sim/collateralClass.ts) -------------------
// ADDED 2026-10-14. A no-delay row is sold the minute it is over its line (curePath.ts
// clause vii): no window, so never cured. The CSV names only the LIQUIDATED reserves, so a
// class is applied only where they are >= 95% of the collateral (seenCollateralShare);
// everywhere else it is 'unknown' and walks the window, unless the line is above 90%.
const dc = (doc.meta as any).delayClass
assert.ok(
  dc && typeof dc.rule === 'string' && dc.sources.length > 5,
  'meta.delayClass states its rule and cites',
)
assert.ok(
  typeof dc.composition === 'string' && dc.composition.includes('on-chain reads of every reserve'),
  'and says where full composition has to come from',
)
// ONE denominator (the first event's total collateral), capped at 1: a share above 1 is
// not a fraction of anything, and the class test (>= 0.95) is the same capped or not.
assert.ok(
  (doc.cohort as any[]).every(
    (r) =>
      r.seenCollateralShare === null || (r.seenCollateralShare >= 0 && r.seenCollateralShare <= 1),
  ),
  'every published seen share is in [0, 1]',
)
assert.ok(
  dc.seenCollateralShare.rawAboveOne.accounts >= 0 &&
    (dc.seenCollateralShare.rawAboveOne.accounts === 0 ||
      dc.seenCollateralShare.rawAboveOne.max > 1),
  'the capped rows are counted, with the largest raw share',
)
checks += 2
assert.ok(
  dc.stableSymbols.includes('USDC') && dc.stableSymbols.includes('USDe'),
  'the shared stable list',
)
assert.deepStrictEqual(
  dc.measuredStables,
  ['USDe', 'sUSDe'],
  'USDe/sUSDe are measured, not held at $1',
)
const CLASSES = ['no-delay', 'delayed', 'mixed', 'unknown']
for (const [label, rows] of [
  ['cohort', doc.cohort as any[]],
  ['included', inc],
  ['priced', pricedRows],
] as [string, any[]][]) {
  assert.ok(
    rows.every((r) => CLASSES.includes(r.delayClass)),
    `${label}: every row is classed`,
  )
  for (const k of CLASSES) {
    const g = rows.filter((r) => r.delayClass === k)
    assert.strictEqual(dc.counts[label][k].accounts, g.length, `${label}/${k}: count recomputes`)
    assert.ok(
      Math.abs(dc.counts[label][k].membraneClosedUsd - sumOf(g, 'membraneClosedUsd')) < 1,
      `${label}/${k}: Membrane dollars recompute`,
    )
    checks += 2
  }
}
assert.strictEqual(
  dc.mixedInCohort,
  (doc.cohort as any[]).filter((r) => r.delayClass === 'mixed').length,
  'mixedInCohort recomputes',
)
const KNOWN = dc.knownCompositionShare
assert.strictEqual(KNOWN, 0.95, 'a class is applied only when >= 95% of the collateral is seen')
const known = (r: any) => r.seenCollateralShare !== null && r.seenCollateralShare >= KNOWN
assert.ok(
  inc.filter((r) => r.delayClass === 'unknown').every((r) => !known(r) && r.liqLine <= 0.9),
  'unknown means: the CSV sees under 95% of the collateral, and the line is not above 90%',
)
assert.ok(
  inc.filter((r) => r.delayClass === 'delayed').every(known),
  'delayed is only claimed where the composition is seen',
)
const ndInc = inc.filter((r) => r.delayClass === 'no-delay')
assert.ok(ndInc.length > 0, 'the no-delay class is populated')
assert.ok(
  ndInc.every((r) => r.liqLine > 0.9 || (known(r) && dc.stableSymbols.includes(r.collSymbol))),
  'no-delay means: seen-all-stable collateral, or a line above 90%',
)
assert.strictEqual(
  dc.noDelayBy.included.stableCollateral + dc.noDelayBy.included.lineAbove90Only,
  ndInc.length,
  'every no-delay row is no-delay for a stated reason',
)
// How much of each account's collateral the CSV can see, as a partition of the rows.
for (const [label, rows] of [
  ['included', inc],
  ['priced', pricedRows],
] as [string, any[]][]) {
  const dist = dc.seenCollateralShare[label]
  assert.strictEqual(
    (Object.values(dist) as number[]).reduce((a, b) => a + b, 0),
    rows.length,
    `${label}: the share buckets partition the rows`,
  )
  assert.strictEqual(dist['>=0.95'], rows.filter(known).length, `${label}: the known bucket`)
  const sl = dc.stableLegs[label]
  assert.strictEqual(
    sl.compositionKnown + sl.compositionUnknown,
    sl.accounts,
    `${label}: stable-leg rows split into known and unknown`,
  )
  checks += 3
}
assert.ok(
  dc.stableLegs.priced.compositionUnknown > dc.stableLegs.priced.compositionKnown,
  'most stable-collateral rows are NOT classable from this CSV, and the data says so',
)
assert.ok(
  ndInc.every((r) => r.outcome === 'sold-no-delay' || r.outcome === 'sold-immediately-no-series'),
  'a no-delay row is sold at once (or takes the one-repay when it has no series)',
)
assert.strictEqual(
  cm.outcomes['sold-no-delay'],
  ndInc.filter((r) => r.outcome === 'sold-no-delay').length,
  'the histogram counts the no-delay sales',
)
assert.ok(
  ndInc
    .filter((r) => r.outcome === 'sold-no-delay')
    .every((r) => r.closedAtIndex === 0 && r.minutesToFirstCure === null),
  'and every one of them is sold at t0 with no cure',
)
assert.ok(
  inc.filter((r) => r.delayClass !== 'no-delay').every((r) => r.outcome !== 'sold-no-delay'),
  'only a no-delay row carries the no-delay outcome',
)
assert.ok(
  inc.filter((r) => r.liqLine > 0.9).every((r) => r.delayClass === 'no-delay'),
  'every included line above 90% is no-delay — only that class can carry one',
)
assert.strictEqual(
  dc.linesAbove90.included,
  inc.filter((r) => r.liqLine > 0.9).length,
  'lines > 90% counted',
)
// The cure diagnostic: no window, so never cured, and the dropped count stays visible.
const ndCur = cur.filter((r: any) => r.cure!.noWindow)
assert.ok(
  ndCur.every(
    (r: any) =>
      r.delayClass === 'no-delay' && !r.cure!.curedInWindow && r.cure!.minutesToCure === null,
  ),
  'a no-delay row is never curedInWindow',
)
assert.strictEqual(doc.time.noDelay!.accounts, ndCur.length, 'time.noDelay.accounts recomputes')
assert.strictEqual(
  doc.time.noDelay!.wouldHaveCuredWithWindow,
  ndCur.filter((r: any) => r.cure!.wouldHaveCuredWithWindow).length,
  'time.noDelay.wouldHaveCuredWithWindow recomputes',
)
// The old all-delayed treatment, published as a sensitivity: it IS the previous headline.
const sd = (doc.meta as any).sensitivity.stablesDelayed
assert.strictEqual(sd.priced.accounts, D.priced.accounts, 'stablesDelayed walks the same rows')
assert.ok(
  Math.abs(sd.pricedDeltaUsd - (D.priced.membraneClosedUsd - sd.priced.membraneClosedUsd)) < 1,
  'its priced delta is the subtraction it claims',
)
// Both sides are summed the same way (each row rounded to the cent, then added), so a true
// zero prints as 0 — not as a few cents of rounding.
assert.strictEqual(sd.sameRows.pricedDeltaUsd, 0, 'on this day the no-delay walk moves no dollar')
assert.strictEqual(sd.sameRows.allIncludedDeltaUsd, 0, 'over every included row too')
// Dropping the mixed accounts from both sides, published rather than applied.
const mx = (doc.meta as any).sensitivity.mixedExcluded
const mixedInc = inc.filter((r) => r.delayClass === 'mixed')
assert.strictEqual(mx.mixed.allIncluded.accounts, mixedInc.length, 'mixedExcluded names the rows')
assert.strictEqual(
  mx.allIncluded.accounts + mixedInc.length,
  D.allIncluded.accounts,
  'and removes exactly them',
)
assert.ok(
  Math.abs(mx.priced.aaveClosedUsd + mx.mixed.priced.aaveClosedUsd - D.priced.aaveClosedUsd) < 1 &&
    Math.abs(
      mx.priced.membraneClosedUsd + mx.mixed.priced.membraneClosedUsd - D.priced.membraneClosedUsd,
    ) < 1,
  'the priced split is a partition of the headline dollars',
)
checks += 27

// ---- the anchor: Aave's own price vs the round we select ------------------
// Added 2026-09-14. This is the only end-to-end check the pricing chain has, and its
// result is NEGATIVE: the two series do not reconcile, so the test asserts the finding
// rather than a clean bill of health.
const anc = doc.meta.anchor
assert.ok(anc && anc.recoveredPrices > 100, `Aave prices recovered (${anc?.recoveredPrices})`)
assert.ok(anc.pointsWithAFeed > 50, 'enough of them have a feed to compare against')
assert.strictEqual(
  anc.exactMatchToAnyRound,
  0,
  "none of Aave's recovered prices equals ANY round in the log, at any block",
)
for (const [rule, r] of Object.entries<any>(anc.residualByBlockRule)) {
  assert.ok(r.points > 0 && r.medianAbsPct >= 0, `${rule} residual is published`)
}
// NO BLOCK RULE FIXES IT: every selection lands within a fifth of a percent of the others
// on the median, so the residual is not a choice of block.
const meds = Object.values<any>(anc.residualByBlockRule).map((r) => r.medianAbsPct)
assert.ok(
  Math.max(...meds) - Math.min(...meds) < 0.2,
  `every block rule gives the same median residual (${meds.join(', ')})`,
)
assert.ok(anc.residualByPriceClass.exact.points > 0, 'the own-feed subset is broken out')
assert.ok(anc.coverage.priced.accountsAnchored > 0, 'coverage over the priced set is published')
checks += 5

// ---- wstETH: the wrap rate, and what the market feed was worth -------------
const wst = cmap.wsteth
assert.ok(
  Math.abs(wst.wrapRate - 1.215989) < 1e-6,
  `wstETH is priced through the MEASURED wrap rate (${wst.wrapRate})`,
)
assert.ok(
  wst.derivation.includes('1.21598891'),
  'and the derivation names the measured 8-decimal figure',
)
const wsens = doc.meta.sensitivity.wstethMarketFeedMembraneClosedUsd
assert.ok(
  wsens.pricedDeltaUsd > 25_000_000,
  `the market feed added $${(wsens.pricedDeltaUsd / 1e6).toFixed(1)}M to the priced total on its own`,
)
assert.ok(
  wsens.movers.length >= 2 && wsens.movers.every((m: any) => m.account && m.collSymbol),
  'and the accounts it moves are named, not aggregated away',
)
checks += 4

// ---- the execution bound, priced --------------------------------------------
const lbs = doc.meta.sensitivity.liquidityBound
assert.ok(lbs.capTable.length > 5, 'the measured cap table is published per collateral symbol')
assert.ok(
  lbs.capTable.every((c: any) => c.largestSingleAaveRepayUsd > 0),
  'every cap is a real observed repay',
)
assert.ok(
  lbs.liquidityBoundMembraneClosedUsd.priced <= D.priced.membraneClosedUsd &&
    lbs.liquidityBoundMembraneClosedUsd.allIncluded <= D.allIncluded.membraneClosedUsd,
  'capping one sale can only reduce what Membrane closes',
)
checks += 3

// ---- the anchored rebuild ----------------------------------------------------
const anch = doc.meta.sensitivity.aaveAnchored
assert.ok(anch.priced.membraneClosedUsd > 0, 'the anchored rebuild produces a total')
assert.ok(
  Math.abs(anch.pricedDeltaUsd) < D.priced.membraneClosedUsd,
  'and the anchor moves less than the total it anchors',
)
checks += 2

// ---- concentration on DISTINCT WALLETS ---------------------------------------
// The cohort is keyed chain:address, so a row-level top-1 share understates how few real
// counterparties decide the headline.
for (const set of [D.priced, D.allIncluded]) {
  const w = set.walletConcentration
  assert.ok(w.distinctWallets > 0 && w.distinctWallets <= set.accounts, 'wallets <= rows')
  assert.ok(w.top1Share >= 0 && w.top1Share <= 1, 'top-1 share is a share')
  assert.ok(w.top5Share >= w.top1Share, 'top-5 contains top-1')
  assert.ok(
    w.top1Share >= set.concentration.top1Share - 1e-9,
    'deduping onto wallets can only raise concentration, never lower it',
  )
}
assert.ok(
  cm.heldConcentration.byWalletDebt.distinctWallets > 0,
  'the held set is deduped onto wallets too',
)
checks += 9

// ---- the priced-set direction and the per-asset table ---------------------------------------
// (The rendered DebtLens / TimeLens / CohortLens checks moved to evidence-census.test.mts.)
{
  const cav = doc.meta.caveats as string[]
  assert.ok(
    !cav.some((c) => /no-delay|MixedDelayClass|delay class/i.test(c)),
    'no caveat uses an insider class name',
  )
  const noWin = cav.find((c) => c.startsWith('NO 8-HOUR WINDOW'))
  const cannotSee = cav.find((c) => c.startsWith('THIS DATA CANNOT SEE MOST COLLATERAL'))
  assert.ok(noWin && cannotSee, 'both delay-class caveats are published')
  for (const c of [noWin!, cannotSee!]) {
    assert.ok(!/meta\.|Q\d+\b/.test(c), `plain words, no meta keys: ${c.slice(0, 40)}`)
  }
  assert.ok(noWin!.startsWith('NO 8-HOUR WINDOW†:'), 'the modelled claim carries the †')
  checks += 5
}
// The priced set still says Membrane closes LESS (the direction the old lens rendered).
assert.ok(D.priced.gapUsd > 0, 'priced set: Membrane closes less')
checks++

// spared can be negative -- confirm such rows exist (the old table had to render them)
const negatives = inc.filter((r) => r.aaveClosedUsd - r.membraneClosedUsd < 0).length
assert.ok(negatives > 0, 'negative-spared rows exist')
checks++

// ---- the counts the old table's filters were reconciled against ---------------------------
const worseAll = (doc.cohort as any[]).filter((r) => r.membraneClosedFrac >= r.aaveClosedFrac)
assert.strictEqual(
  inc.filter((r) => r.membraneClosedFrac >= r.aaveClosedFrac).length,
  D.allIncluded.membraneClosesMore,
  'the INCLUDED "Membrane worse" rows are what debt.allIncluded.membraneClosesMore counts',
)
assert.strictEqual(
  pricedRows.filter((r) => r.membraneClosedFrac >= r.aaveClosedFrac).length,
  D.membraneClosesMore,
  'while the flat field counts only the PRICED rows',
)
assert.strictEqual(
  worseAll.length +
    (doc.cohort as any[]).filter((r) => r.membraneClosedFrac < r.aaveClosedFrac).length,
  doc.cohort.length,
  'the two outcome classes partition the cohort',
)
assert.strictEqual(
  inc.filter((r) => r.cure?.curedInWindow).length,
  doc.time.curedInWindow,
  'the INCLUDED cured rows are time.curedInWindow',
)
assert.strictEqual(
  inc.filter((r) => r.collSymbol === 'WETH').length,
  doc.byAsset.WETH.accounts,
  'byAsset counts INCLUDED rows only',
)
assert.ok(doc.byAsset.wstETH && doc.byAsset.wstETH.accounts > 0, 'wstETH has its own row')
checks += 6

console.log(`OLD EVIDENCE (fixture) OK — ${checks} assertions passed`)
console.log(
  `  cohort ${doc.cohort.length}  aave $${aave.toLocaleString()}  membrane $${mem.toLocaleString()}`,
)
console.log(`  cure sample ${cur.length}  cured ${cured}  healthy@8h ${healthy}`)
console.log(`  rows where Membrane closes MORE: ${negatives}`)
