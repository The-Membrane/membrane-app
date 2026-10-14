/**
 * build-m0-thresholds.mjs — the fixed thresholds of the M0 regime rule.
 *
 *   MEMBRANE_DATASETS_DIR=../membrane-datasets node scripts/regime/build-m0-thresholds.mjs
 *
 * Reads price-history/eth-usd-1h.json from the private datasets repo (board rule N18) and
 * writes lib/regime/m0Thresholds.generated.json: three quantiles, their sample sizes and
 * periods, and the source file's commit and SHA-256. That is an aggregate result, which a
 * public repo may keep (N18); no price is copied.
 *
 * The rule is owner-fixed (board Q27, MODELS_PLAN M0): no fit, no tuning. The quantiles are
 * over the FULL history in the file:
 *   (A) move24hP95  p95 of |oracle_t / oracle_{t−24h} − 1|
 *   (B) gapP999     p99.9 of |oracle_t / coinbase_t − 1|  (the band the rule uses)
 *       gapP99      p99 of the same, recorded so the owner can choose
 *
 * The SHA-256 must match the file's row in price-history/PROVENANCE.md, or the build stops:
 * a dataset that changed without its provenance is not a source.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { datasetsDir } from '../lib/datasetsDir.mjs'
import { GAP_METHOD, MOVE_METHOD, QUANTILE_METHOD, m0Thresholds } from './m0Stats.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DATASET_PATH = 'price-history/eth-usd-1h.json'
const OUT = join(ROOT, 'lib', 'regime', 'm0Thresholds.generated.json')

const iso = (s) => new Date(s * 1000).toISOString().replace('.000Z', 'Z')

const dir = datasetsDir(ROOT)
const file = join(dir, DATASET_PATH)
const bytes = readFileSync(file)
const sha256 = createHash('sha256').update(bytes).digest('hex')

const provenance = readFileSync(join(dir, 'price-history', 'PROVENANCE.md'), 'utf8')
const row = provenance.split('\n').find((l) => l.includes('`eth-usd-1h.json`'))
const recorded = row?.match(/`([0-9a-f]{64})`/)?.[1]
if (recorded !== sha256) {
  throw new Error(
    `${DATASET_PATH} sha256 ${sha256} does not match PROVENANCE.md (${recorded ?? 'no row'})`,
  )
}

const commit = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const dirty = execFileSync('git', ['-C', dir, 'status', '--porcelain', '--', DATASET_PATH], {
  encoding: 'utf8',
}).trim()
if (dirty) throw new Error(`${DATASET_PATH} has uncommitted changes in ${dir}`)

const doc = JSON.parse(bytes.toString('utf8'))
const t = m0Thresholds({
  startTs: doc.startTs,
  stepSeconds: doc.stepSeconds,
  oracle: doc.columns.oracle,
  coinbase: doc.columns.coinbase,
})

const out = {
  move24hP95: t.move24hP95,
  gapP99: t.gapP99,
  gapP999: t.gapP999,
  /** The band rule (B) uses. */
  gapQuantile: 'p99.9',
  n: t.n,
  period: {
    from: iso(Math.min(t.movePeriod.from, t.gapPeriod.from)),
    to: iso(Math.max(t.movePeriod.to, t.gapPeriod.to)),
    move24h: { from: iso(t.movePeriod.from), to: iso(t.movePeriod.to) },
    gap: { from: iso(t.gapPeriod.from), to: iso(t.gapPeriod.to) },
  },
  method: {
    quantile: QUANTILE_METHOD,
    move24h: MOVE_METHOD,
    gap: GAP_METHOD,
    timestamps:
      'hour-end UTC (price-history convention: index i opens at startTs + i·3600; value = price at the end of that hour)',
  },
  source: {
    repo: 'triccs/membrane-datasets',
    commit,
    path: DATASET_PATH,
    sha256,
  },
  generatedAt: new Date().toISOString(),
  generatedBy: relative(ROOT, fileURLToPath(import.meta.url)),
}

writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`)
console.log(
  `wrote ${relative(ROOT, OUT)}: move24hP95 ${t.move24hP95.toFixed(5)} (n ${t.n.move24h}), ` +
    `gap p99 ${t.gapP99.toFixed(5)} p99.9 ${t.gapP999.toFixed(5)} (n ${t.n.gap}), ${out.period.from} → ${out.period.to}`,
)
