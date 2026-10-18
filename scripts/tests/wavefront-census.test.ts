/**
 * Full-pull invariants of the Oct 10-11 full-coverage census — the whole-pull counterpart of
 * tests/unit/wavefrontCensus.test.ts. Needs the datasets repo (MEMBRANE_DATASETS_DIR or
 * ../membrane-datasets) with the on-chain pull and the written census.
 *
 *   MEMBRANE_DATASETS_DIR=... npx tsx scripts/tests/wavefront-census.test.ts
 *
 * Checks: a fresh build equals the written census.json rows (determinism); the compared set
 * (Membrane's own line, liquidity-capped, owner rulings 2026-10-18) partitions the walked
 * positions with the exclusions; the protocol-line run with no liquidity model is the
 * pre-ruling census ($157.06M); the real side is the same in every run; no liquidity window
 * fills past its limit; the whale's figures; Membrane's debt is sized to its line
 * (debt0 x memLine / protocolLine) and an unsplit single-leg position at Membrane's line, on that
 * debt, uncapped, is cureWalk; 3,197 positions
 * (2,421 Aave + 776 Morpho, the full scope) partitioned into walked + not walked with a reason
 * for each; both sides on the same
 * positions; every walked position located by the protocol at its t0 event; mixed splits sum
 * to the whole; the canonical replay.jsonl.gz and the served compact replay are the same
 * records, fold without error, and their final totals are the WALKED rows' sums and
 * census.json's;
 * every unsplit single-leg walked position's kernel figure equals cureWalk on its composite
 * series.
 */
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

import { cureWalk } from '../../lib/position-sim/curePath'
import {
  BORROW_LTV_GAP,
  CURE_WINDOW_SECONDS,
  LIQ_DEBT_MINIMUM_USD,
  MAX_THRESHOLD_TO_DELAY,
} from '../../lib/position-sim/membrane'
import {
  aaveLocatedAt,
  aavePoolOf,
  aavePositionSpec,
  type AaveEventRecord,
} from '../../lib/wavefront/aave'
import { morphoLocatedAt, morphoPositionSpec } from '../../lib/wavefront/morpho'
import { aavePid, morphoPid } from '../../lib/wavefront/pid'
import { decodeCompact, decodeJsonl, replay } from '../../lib/wavefront/stream'
import { datasetsDir } from '../lib/datasetsDir.mjs'
import { buildCensus } from '../oct10-coverage/census'
import { loadCensusInputs } from '../oct10-coverage/censusInputs'

let passed = 0
let failed = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (e) {
    failed++
    console.log(`  FAIL ${name}\n       ${(e as Error).message}`)
  }
}

const D = datasetsDir(process.cwd())
const inputs = loadCensusInputs(D)
const aaveOracle = inputs.aaveOracle
const morphoOracle = inputs.morphoOracle
const census = buildCensus(inputs)
const rows = census.rows
/** The pre-2026-10-18 census: the protocol's line, no liquidity model. */
const legacy = buildCensus(inputs, { lineMode: 'protocol', noCapacityModel: true })
const legacyByPid = new Map(legacy.rows.map((r) => [r.pid, r]))
/** Membrane's own line and line-sized debt, capacity unlimited: positions are independent. */
const memUnlimited = buildCensus(inputs, { capacityMultiplier: Infinity })
const memUnlimitedByPid = new Map(memUnlimited.rows.map((r) => [r.pid, r]))
const written = JSON.parse(
  fs.readFileSync(path.join(D, 'oct10-2025', 'coverage', 'census.json'), 'utf8'),
)
const byPid = new Map(rows.map((r) => [r.pid, r]))

console.log('wavefront census (full pull)')

test('a fresh build is the written census.json, row for row', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rows)), written.rows)
})

test('3,197 positions = 2,421 Aave accounts + 776 Morpho positions, each once', () => {
  assert.strictEqual(rows.length, 3197)
  assert.strictEqual(rows.filter((r) => r.protocol === 'aave-v3').length, 2421)
  assert.strictEqual(rows.filter((r) => r.protocol === 'morpho-blue').length, 776)
  assert.strictEqual(new Set(rows.map((r) => r.pid)).size, rows.length)
})

test('coverage partitions the total, and every uncovered position has a reason', () => {
  const walked = rows.filter((r) => r.walked)
  const not = rows.filter((r) => !r.walked)
  assert.strictEqual(walked.length + not.length, 3197)
  assert.strictEqual(written.meta.coverage.walked, walked.length)
  assert.strictEqual(written.meta.coverage.uncovered.length, not.length)
  for (const r of not) assert.ok(r.reason, r.pid)
  const pc = written.meta.coverage.byProtocolChain as { total: number; walked: number }[]
  assert.strictEqual(
    pc.reduce((a, x) => a + x.total, 0),
    3197,
  )
  assert.strictEqual(
    pc.reduce((a, x) => a + x.walked, 0),
    walked.length,
  )
})

test('both sides are on the same positions: the compared ones', () => {
  for (const r of rows) {
    assert.ok(r.real.events > 0, `${r.pid} has no real event`)
    assert.strictEqual(r.mem !== null, r.walked && !r.excluded, r.pid)
    if (r.excluded) assert.ok(r.excludedDetail, r.pid)
  }
  const T = written.meta.coverage
  assert.strictEqual(T.compared, rows.filter((r) => r.mem).length)
  assert.strictEqual(
    T.excluded.noMembraneLine,
    rows.filter((r) => r.excluded === 'no-membrane-line').length,
  )
  assert.strictEqual(
    T.excluded.partialMembraneLine,
    rows.filter((r) => r.excluded === 'partial-membrane-line').length,
  )
  assert.strictEqual(T.excluded.noCapacity, rows.filter((r) => r.excluded === 'no-capacity').length)
  assert.strictEqual(
    T.compared + T.excluded.noMembraneLine + T.excluded.partialMembraneLine + T.excluded.noCapacity,
    T.walked,
  )
  // the strict set (owner ruling 2026-10-18, round 2): 1,545 compared; 866 + 782 + 4 out
  assert.deepStrictEqual(
    [T.compared, T.excluded.noMembraneLine, T.excluded.partialMembraneLine, T.excluded.noCapacity],
    [1545, 866, 782, 4],
  )
  // a compared position has a Membrane line for EVERY collateral leg
  for (const r of rows) if (r.mem) assert.strictEqual(r.memLine!.unknown.length, 0, r.pid)
  assert.strictEqual(
    rows.reduce((a, r) => a + r.real.events, 0),
    inputs.aaveCsv.length + inputs.morphoCsv.length,
    'every CSV event is on the real side once',
  )
})

test('every walked position is located by the protocol at its t0 event', () => {
  const aEv = new Map<string, AaveEventRecord[]>()
  for (const e of inputs.aaveEvents) {
    const k = aavePid(e.chain, aavePoolOf(e), e.user)
    aEv.set(k, [...(aEv.get(k) ?? []), e])
  }
  const mEv = new Map<string, any[]>()
  for (const e of inputs.morphoEvents) {
    const k = morphoPid(e.chain, e.market_id, e.borrower)
    mEv.set(k, [...(mEv.get(k) ?? []), e])
  }
  for (const r of rows) {
    const evs = (r.protocol === 'aave-v3' ? aEv.get(r.pid)! : mEv.get(r.pid)!).sort(
      (a: any, b: any) => a.block_number - b.block_number || a.log_index - b.log_index,
    )
    // t0 = the first event located at block-N prices, else at N-1 prices
    const at = (e: any, b: 'N' | 'N-1') =>
      r.protocol === 'aave-v3' ? aaveLocatedAt(e, b) : morphoLocatedAt(e, b)
    const located = evs.filter((e: any) => at(e, 'N') || at(e, 'N-1'))
    if (r.walked) {
      assert.ok(located.length > 0, r.pid)
      assert.strictEqual(r.t0!.block, located[0].block_number, r.pid)
      assert.strictEqual(r.t0!.priceBasis, at(located[0], 'N') ? 'N' : 'N-1', r.pid)
      assert.strictEqual(r.t0!.shifted, located[0] !== evs[0], r.pid)
      // located on the PROTOCOL's line (row.line), whatever line Membrane then walks at
      if (!legacyByPid.get(r.pid)!.mem!.subs)
        assert.ok(r.ltv0! > r.line!, `${r.pid}: located but LTV0 <= line`)
    } else {
      assert.strictEqual(located.length, 0, r.pid)
    }
  }
})

test('mixed splits sum their debts and collateral to the whole', () => {
  const opens = new Map(census.records.filter((x) => x.kind === 'open').map((x: any) => [x.pid, x]))
  let n = 0
  for (const r of rows) {
    if (!r.mem?.subs) {
      if (r.mem) assert.notStrictEqual(r.delayClass, 'mixed', `${r.pid}: mixed but not split`)
      continue
    }
    n++
    assert.strictEqual(r.delayClass, 'mixed')
    const subs = r.mem.subs
    assert.ok(Math.abs(subs.reduce((a, s) => a + s.share, 0) - 1) < 1e-12, r.pid)
    const o = opens.get(r.pid)
    const d = o.subs.reduce((a: number, s: any) => a + s.debtUsd, 0)
    assert.ok(Math.abs(d - o.debtUsd) <= 0.02, `${r.pid}: halves' debt ${d} vs ${o.debtUsd}`)
    assert.deepStrictEqual(
      subs.flatMap((s) => s.symbols).sort(),
      r.collateral.map((c) => c.symbol).sort(),
    )
    assert.ok(Math.abs(r.mem.closedT0 - subs.reduce((a, s) => a + s.closedT0, 0)) < 1e-6, r.pid)
    // Membrane's debt is sized PER HALF: Σ share_h x debtScale_h x debt (open.memDebtUsd)
    const scaled = r.memLine!.halves!.reduce(
      (a, h, i) => a + subs[i].share * h.debtScale * (r.debtUsd ?? 0),
      0,
    )
    assert.ok(
      Math.abs(scaled - (o.memDebtUsd ?? 0)) <= 0.02,
      `${r.pid}: ${scaled} vs ${o.memDebtUsd}`,
    )
  }
  // 180 on the strict set (some collateral without a Membrane line is excluded)
  assert.ok(n >= 150, `${n} splits`)
})

test('the canonical replay and the served compact replay are the same records', () => {
  const jsonl = decodeJsonl(
    gunzipSync(
      fs.readFileSync(path.join(D, 'oct10-2025', 'coverage', 'replay.jsonl.gz')),
    ).toString(),
  )
  const compact = decodeCompact(
    JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), 'public', 'data', 'oct10-2025', 'wavefront-replay.json'),
        'utf8',
      ),
    ),
  )
  assert.deepStrictEqual(compact, jsonl.records)
  assert.deepStrictEqual(JSON.parse(JSON.stringify(census.records)), jsonl.records)
})

test('the stream folds, and its totals are the COMPARED rows sums and census.json totals', () => {
  const s = replay(census.records)
  const walked = rows.filter((r) => r.mem)
  const near = (a: number, b: number, what: string) =>
    assert.ok(Math.abs(a - b) < 0.05, `${what}: ${a} vs ${b}`)
  near(
    s.totals.real.repaidUsd,
    walked.reduce((a, r) => a + r.real.repaidUsd, 0),
    'real repaid',
  )
  near(
    s.totals.real.soldUsd,
    walked.reduce((a, r) => a + r.real.seizedUsd, 0),
    'real seized',
  )
  near(
    s.totals.mem.repaidUsd,
    rows.reduce((a, r) => a + (r.mem?.repaidUsd ?? 0), 0),
    'mem repaid',
  )
  near(
    s.totals.mem.soldUsd,
    rows.reduce((a, r) => a + (r.mem?.soldUsd ?? 0), 0),
    'mem sold',
  )
  const T = written.meta.totals.all
  // the reducer folds real records of WALKED positions only (same positions on both sides)
  near(s.totals.real.repaidUsd, T.realWalked.repaidUsd, 'census.json real repaid (walked)')
  near(s.totals.mem.repaidUsd, T.mem.repaidUsd, 'census.json mem repaid')
  assert.strictEqual(s.totals.mem.positionsSold, T.mem.positionsSold)
  assert.strictEqual(s.totals.mem.positionsKept, T.mem.positionsKept)
  assert.strictEqual(s.totals.mem.positionsArmed, 0)
  assert.strictEqual(s.coverage.walked, T.compared)
  // DEBT REPAID ONLY: no collateral-seized figure is a census total any more
  assert.strictEqual(T.realWalked.seizedUsd, undefined)
  assert.strictEqual(T.mem.soldUsd, undefined)
})

test('the protocol line with no liquidity model is the pre-2026-10-18 census', () => {
  // its headline was $157,056,180.33 of Membrane debt repaid on all 3,197 positions
  const m = legacy.rows.reduce((a, r) => a + (r.mem?.repaidUsd ?? 0), 0)
  assert.ok(Math.abs(m - 157_056_180.33) < 0.05, `${m}`)
  assert.strictEqual(legacy.rows.filter((r) => r.mem).length, 3197)
})

test('the real side is what happened: the same in every run', () => {
  for (const r of rows) assert.deepStrictEqual(r.real, legacyByPid.get(r.pid)!.real, r.pid)
})

test('the capacity table and the book: no window ever fills past its limit', () => {
  const aave = census.capacity.find(
    (c) => c.key === 'mainnet:0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9',
  )!
  assert.ok(Math.abs(aave.capacityTokens - 97_556.85) < 0.01, `${aave.capacityTokens}`)
  assert.ok(
    Math.abs(aave.liquidatorCapacityTokens - 96_876.22) < 0.01,
    `${aave.liquidatorCapacityTokens}`,
  )
  assert.strictEqual(census.liquidity!.multiplier, 0.98)
  let bound = 0
  for (const [k, b] of Object.entries(census.liquidity!.byKey)) {
    assert.ok(b.limitTokens != null && b.limitTokens > 0, k)
    assert.ok(
      b.peakWindowTokens <= b.limitTokens! * (1 + 1e-9),
      `${k}: ${b.peakWindowTokens} > ${b.limitTokens}`,
    )
    if (b.shortOffers > 0) bound++
  }
  assert.ok(bound > 0, 'the cap binds somewhere')
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(census.capacity)),
    written.meta.liquidity.capacity,
  )
})

test('the whale: excluded (no Membrane line); at Aave’s line 0.98x vs unlimited', () => {
  const W =
    'aave-v3:mainnet:0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2:0x372cae7fa19b81a9786a9081704ea1e2dad576b7'
  assert.strictEqual(rows.find((r) => r.pid === W)!.excluded, 'no-membrane-line')
  const capped = buildCensus(inputs, { lineMode: 'protocol' }).rows.find((r) => r.pid === W)!
  const unl = buildCensus(inputs, { lineMode: 'protocol', capacityMultiplier: Infinity }).rows.find(
    (r) => r.pid === W,
  )!
  assert.ok(Math.abs(capped.mem!.repaidUsd - 11_523_540.89) < 0.01, `${capped.mem!.repaidUsd}`)
  assert.ok(Math.abs(unl.mem!.repaidUsd - 29_863_534.37) < 0.01, `${unl.mem!.repaidUsd}`)
  assert.ok(Math.abs(capped.real.repaidUsd - 3_688_252.3) < 0.01)
})

test('every unsplit single-leg walked position equals cureWalk on its composite series', () => {
  let n = 0
  const col = (src: any, chain: string, key: string) =>
    (src[chain].prices[key] as (string | null)[]).map((v) => (v == null ? NaN : Number(v)))
  const aEv = new Map<string, AaveEventRecord[]>()
  for (const e of inputs.aaveEvents)
    aEv.set(aavePid(e.chain, aavePoolOf(e), e.user), [
      ...(aEv.get(aavePid(e.chain, aavePoolOf(e), e.user)) ?? []),
      e,
    ])
  const mEv = new Map<string, any[]>()
  for (const e of inputs.morphoEvents) {
    const k = morphoPid(e.chain, e.market_id, e.borrower)
    mEv.set(k, [...(mEv.get(k) ?? []), e])
  }
  let nm = 0
  // cureWalk is handed the protocol's line, so it is compared with the protocol-line run
  for (const r of legacy.rows) {
    if (!r.walked || r.mem!.subs || r.collateral.length !== 1 || r.debt.length !== 1) continue
    let spec
    let cc: number[]
    let dc: number[] | null
    if (r.protocol === 'aave-v3') {
      spec = aavePositionSpec(aEv.get(r.pid)!, {
        startTs: 1760054400,
        stepSeconds: 60,
        debtMinimumUsd: LIQ_DEBT_MINIMUM_USD,
      })
      cc = col(aaveOracle, `${r.chain}:${spec.market}`, spec.collateral[0].key)
      dc = col(aaveOracle, `${r.chain}:${spec.market}`, spec.debt[0].key)
    } else {
      const usd0 =
        r.debt[0].usd != null && r.debt[0].amount > 0 ? r.debt[0].usd / r.debt[0].amount : null
      spec = morphoPositionSpec(mEv.get(r.pid)!, {
        startTs: 1760054400,
        stepSeconds: 60,
        debtMinimumUsd: LIQ_DEBT_MINIMUM_USD,
        collateralSymbol: r.collateral[0].symbol,
        loanSymbol: r.debt[0].symbol,
        loanUsd: () => usd0,
      })
      cc = col(morphoOracle, r.chain, spec.collateral[0].key)
      dc = null
    }
    const c = spec.collateral[0]
    const d = spec.debt[0]
    const i0 = spec.t0!.minute
    const ratios = [1]
    for (let m = i0 + 1; m < 2880; m++) ratios.push(cc[m] / c.p0 / (dc ? dc[m] / d.p0 : 1))
    const w = cureWalk({
      debtUsd: d.value0,
      collateralUsd: c.value0,
      line: spec.line!,
      band: MAX_THRESHOLD_TO_DELAY,
      delaySeconds: CURE_WINDOW_SECONDS,
      stepSeconds: 60,
      gap: BORROW_LTV_GAP,
      ratios,
      debtMinimumUsd: spec.debtMinimum,
      maxSales: 20,
      noDelay: spec.halves[0].delayClass === 'no-delay',
    })
    assert.ok(
      Math.abs(w.closedUsd - r.mem!.closedT0) <= 1e-6 * Math.max(1, w.closedUsd),
      `${r.pid}: ${w.closedUsd} vs ${r.mem!.closedT0}`,
    )
    assert.strictEqual(w.outcome, r.mem!.outcome, r.pid)
    assert.strictEqual(w.sales, r.mem!.sales, r.pid)
    n++
    // the same position at MEMBRANE's line on its line-sized debt (uncapped run)
    const mr = memUnlimitedByPid.get(r.pid)!
    if (mr.mem && !mr.mem.subs && mr.memLine?.halves?.length === 1) {
      const h = mr.memLine.halves[0]
      const wm = cureWalk({
        debtUsd: d.value0 * h.debtScale,
        collateralUsd: c.value0,
        line: h.line,
        band: MAX_THRESHOLD_TO_DELAY,
        delaySeconds: CURE_WINDOW_SECONDS,
        stepSeconds: 60,
        gap: BORROW_LTV_GAP,
        ratios,
        debtMinimumUsd: spec.debtMinimum,
        maxSales: 20,
        noDelay: mr.delayClass === 'no-delay',
      })
      assert.ok(
        Math.abs(wm.closedUsd - mr.mem.closedT0) <= 1e-6 * Math.max(1, wm.closedUsd),
        `${r.pid} at Membrane's line: ${wm.closedUsd} vs ${mr.mem.closedT0}`,
      )
      assert.strictEqual(wm.outcome, mr.mem.outcome, `${r.pid} at Membrane's line`)
      nm++
    }
  }
  console.log(`        [${nm} of them also at Membrane's line, on its line-sized debt]`)
  assert.ok(nm > 1000, `${nm}`)
  console.log(`        [${n} single-leg positions]`)
  assert.ok(n > 1500, `${n}`)
})

test('Membrane’s debt is sized to its line, per half: debt0 x memLine / protocolLine', () => {
  // lib/wavefront/membraneLine.ts membraneDebtScale: memDebt0 = debt0 x memLine / protocolLine
  // per half (a split position's protocol line per half is the value-weighted line of its legs).
  const unl = memUnlimited
  const unscaled = buildCensus(inputs, { capacityMultiplier: Infinity, noDebtScaling: true })
  const unscaledByPid = new Map(unscaled.rows.map((r) => [r.pid, r]))
  let n = 0
  for (const r of unl.rows) {
    if (!r.mem) continue
    const ml = r.memLine!
    for (const h of ml.halves!)
      assert.ok(Math.abs(h.debtScale - h.line / h.protocolLine) < 1e-12, r.pid)
    const u = unscaledByPid.get(r.pid)!.mem!
    assert.ok(Math.abs(r.mem.debt0 / u.debt0 - ml.debtScale!) < 1e-9, r.pid)
    if (r.mem.subs || r.collateral.length !== 1 || r.debt.length !== 1) continue
    // unsplit single leg (cureWalk at this line and debt: the test above)
    assert.strictEqual(ml.halves!.length, 1)
    assert.strictEqual(ml.halves![0].protocolLine, r.line, r.pid)
    n++
  }
  console.log(`        [${n} unsplit single-leg compared positions scaled]`)
  assert.ok(n > 1000, `${n}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
