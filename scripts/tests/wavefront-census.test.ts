/**
 * Full-pull invariants of the Oct 10-11 full-coverage census — the whole-pull counterpart of
 * tests/unit/wavefrontCensus.test.ts. Needs the datasets repo (MEMBRANE_DATASETS_DIR or
 * ../membrane-datasets) with the on-chain pull and the written census.
 *
 *   MEMBRANE_DATASETS_DIR=... npx tsx scripts/tests/wavefront-census.test.ts
 *
 * Checks: a fresh build equals the written census.json rows (determinism); 3,163 positions
 * partitioned into walked + not walked with a reason for each; both sides on the same
 * positions; every walked position located by the protocol at its t0 event; mixed splits sum
 * to the whole; the canonical replay.jsonl.gz and the served compact replay are the same
 * records, fold without error, and their final totals are the rows' sums and census.json's;
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
import { aavePositionSpec, type AaveEventRecord } from '../../lib/wavefront/aave'
import { morphoPositionSpec } from '../../lib/wavefront/morpho'
import { decodeCompact, decodeJsonl, replay } from '../../lib/wavefront/stream'
import { datasetsDir } from '../lib/datasetsDir.mjs'
import { buildCensus, type CensusInputs } from '../oct10-coverage/census'
import { aaveEvents as readAaveCsv, morphoEvents as readMorphoCsv } from '../oct10-coverage/inputs'

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
const INPUTS = path.join(D, 'recall-coverage', 'inputs', 'oct10')
const ON = path.join(INPUTS, 'onchain')
const gz = (p: string) => JSON.parse(gunzipSync(fs.readFileSync(p)).toString())
const gzLines = (p: string) =>
  gunzipSync(fs.readFileSync(p))
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
const aaveOracle = Object.fromEntries(
  ['mainnet', 'arbitrum', 'optimism', 'base'].map((c) => [
    c,
    gz(path.join(ON, `aave-oracle-1m.${c}.json.gz`)),
  ]),
)
const morphoOracle = Object.fromEntries(
  ['mainnet', 'base'].map((c) => [c, gz(path.join(ON, `morpho-oracle-1m.${c}.json.gz`))]),
)
const inputs: CensusInputs = {
  window: { startTs: 1760054400, stepSeconds: 60, minutes: 2880 },
  aaveCsv: readAaveCsv(INPUTS) as any,
  aaveEvents: gzLines(path.join(ON, 'aave-events.jsonl.gz')),
  aaveOracle,
  morphoCsv: readMorphoCsv(INPUTS) as any,
  morphoEvents: gzLines(path.join(ON, 'morpho-events.jsonl.gz')),
  morphoOracle,
}
const census = buildCensus(inputs)
const rows = census.rows
const written = JSON.parse(
  fs.readFileSync(path.join(D, 'oct10-2025', 'coverage', 'census.json'), 'utf8'),
)
const byPid = new Map(rows.map((r) => [r.pid, r]))

console.log('wavefront census (full pull)')

test('a fresh build is the written census.json, row for row', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rows)), written.rows)
})

test('3,163 positions = 2,418 Aave accounts + 745 Morpho positions, each once', () => {
  assert.strictEqual(rows.length, 3163)
  assert.strictEqual(rows.filter((r) => r.protocol === 'aave-v3').length, 2418)
  assert.strictEqual(rows.filter((r) => r.protocol === 'morpho-blue').length, 745)
  assert.strictEqual(new Set(rows.map((r) => r.pid)).size, rows.length)
})

test('coverage partitions the total, and every uncovered position has a reason', () => {
  const walked = rows.filter((r) => r.walked)
  const not = rows.filter((r) => !r.walked)
  assert.strictEqual(walked.length + not.length, 3163)
  assert.strictEqual(written.meta.coverage.walked, walked.length)
  assert.strictEqual(written.meta.coverage.uncovered.length, not.length)
  for (const r of not) assert.ok(r.reason, r.pid)
  const pc = written.meta.coverage.byProtocolChain as { total: number; walked: number }[]
  assert.strictEqual(
    pc.reduce((a, x) => a + x.total, 0),
    3163,
  )
  assert.strictEqual(
    pc.reduce((a, x) => a + x.walked, 0),
    walked.length,
  )
})

test('both sides are on the same positions', () => {
  for (const r of rows) {
    assert.ok(r.real.events > 0, `${r.pid} has no real event`)
    assert.strictEqual(r.mem !== null, r.walked, r.pid)
  }
  assert.strictEqual(
    rows.reduce((a, r) => a + r.real.events, 0),
    inputs.aaveCsv.length + inputs.morphoCsv.length,
    'every CSV event is on the real side once',
  )
})

test('every walked position is located by the protocol at its t0 event', () => {
  const aEv = new Map<string, AaveEventRecord[]>()
  for (const e of inputs.aaveEvents) {
    const k = `aave-v3:${e.chain}:${e.user}`
    aEv.set(k, [...(aEv.get(k) ?? []), e])
  }
  const mEv = new Map<string, any[]>()
  for (const e of inputs.morphoEvents) {
    const k = `morpho-blue:${e.chain}:${e.market_id}:${e.borrower}`
    mEv.set(k, [...(mEv.get(k) ?? []), e])
  }
  for (const r of rows) {
    const evs = (r.protocol === 'aave-v3' ? aEv.get(r.pid)! : mEv.get(r.pid)!).sort(
      (a: any, b: any) => a.block_number - b.block_number || a.log_index - b.log_index,
    )
    const located = evs.filter((e: any) =>
      r.protocol === 'aave-v3' ? e.atN.liquidatable : e.liquidatableN,
    )
    if (r.walked) {
      assert.ok(located.length > 0, r.pid)
      assert.strictEqual(r.t0!.block, located[0].block_number, r.pid)
      assert.strictEqual(r.t0!.shifted, located[0] !== evs[0], r.pid)
      if (!r.mem!.subs) assert.ok(r.ltv0! > r.line!, `${r.pid}: located but LTV0 <= line`)
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
      if (r.walked) assert.notStrictEqual(r.delayClass, 'mixed', `${r.pid}: mixed but not split`)
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
  }
  assert.ok(n > 400, `${n} splits`)
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

test('the stream folds, and its totals are the rows sums and census.json totals', () => {
  const s = replay(census.records)
  const near = (a: number, b: number, what: string) =>
    assert.ok(Math.abs(a - b) < 0.05, `${what}: ${a} vs ${b}`)
  near(
    s.totals.real.repaidUsd,
    rows.reduce((a, r) => a + r.real.repaidUsd, 0),
    'real repaid',
  )
  near(
    s.totals.real.soldUsd,
    rows.reduce((a, r) => a + r.real.seizedUsd, 0),
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
  near(s.totals.real.repaidUsd, T.realAll.repaidUsd, 'census.json real repaid')
  near(s.totals.mem.repaidUsd, T.mem.repaidUsd, 'census.json mem repaid')
  assert.strictEqual(s.totals.mem.positionsSold, T.mem.positionsSold)
  assert.strictEqual(s.totals.mem.positionsKept, T.mem.positionsKept)
  assert.strictEqual(s.totals.mem.positionsArmed, 0)
  assert.strictEqual(s.coverage.walked, T.walked)
})

test('every unsplit single-leg walked position equals cureWalk on its composite series', () => {
  let n = 0
  const col = (src: any, chain: string, key: string) =>
    (src[chain].prices[key] as (string | null)[]).map((v) => (v == null ? NaN : Number(v)))
  const aEv = new Map<string, AaveEventRecord[]>()
  for (const e of inputs.aaveEvents)
    aEv.set(`aave-v3:${e.chain}:${e.user}`, [...(aEv.get(`aave-v3:${e.chain}:${e.user}`) ?? []), e])
  const mEv = new Map<string, any[]>()
  for (const e of inputs.morphoEvents) {
    const k = `morpho-blue:${e.chain}:${e.market_id}:${e.borrower}`
    mEv.set(k, [...(mEv.get(k) ?? []), e])
  }
  for (const r of rows) {
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
      cc = col(aaveOracle, r.chain, spec.collateral[0].key)
      dc = col(aaveOracle, r.chain, spec.debt[0].key)
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
  }
  console.log(`        [${n} single-leg positions]`)
  assert.ok(n > 1500, `${n}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
