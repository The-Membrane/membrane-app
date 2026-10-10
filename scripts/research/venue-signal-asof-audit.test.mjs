import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { MARKETS } from './aave-core-forward-panel.mjs'
import { readCheckpoint as readBaseline } from './aave-core-holder-witness.mjs'
import { readCheckpoint as readFeatures } from './aave-core-anchor-features.mjs'
import { auditAsOf } from './venue-signal-asof-audit.mjs'

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const DAY = '2026-09-28'
const SECOND = Date.parse(`${DAY}T06:15:00Z`) / 1000
const BLOCK = 26059143
const BLOCK_HASH = `0x${'ab'.repeat(32)}`
const SOURCE_SHA = 'f'.repeat(64)
const schedule = (overrides = {}) => [{ day: DAY, decisionAtMs: SECOND * 1000 + 300, expectedBlock: BLOCK, expectedBlockHash: BLOCK_HASH, ...overrides }]

function fixture({ baseline = true, feature = true, baseChange = {}, featureChange = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'venue-asof-'))
  const baselinePath = join(dir, 'baseline.json')
  const featurePath = join(dir, 'features.json')
  const source = readBaseline(baselinePath)
  let base
  if (baseline) {
    const row = {
      block: BLOCK,
      blockHash: BLOCK_HASH,
      blockTimestamp: SECOND,
      observedAtMs: SECOND * 1000 + 100,
      markets: MARKETS.map((market) => ({
        name: market.name,
        underlying: market.base.toLowerCase(),
        aToken: market.aToken.toLowerCase(),
        decimals: market.decimals,
        quoteRaw: '1000000000000',
        transferWindow: { fromBlock: BLOCK - 2000, toBlock: BLOCK - 1, logs: 0 },
        candidates: [],
        qualifyingHolders: [],
      })),
      previousSha256: null,
      ...baseChange,
    }
    base = { ...row, rowSha256: digest(row) }
    source.baselines.push(base)
  }
  writeFileSync(baselinePath, JSON.stringify({ payload: source, sha256: digest(source) }))
  const target = readFeatures(featurePath, baselinePath)
  if (feature) {
    const row = {
      block: BLOCK,
      blockHash: BLOCK_HASH,
      blockTimestamp: SECOND,
      baselineObservedAtMs: base?.observedAtMs ?? SECOND * 1000 + 100,
      observedAtMs: SECOND * 1000 + 200,
      sourcePhysicalSha256: SOURCE_SHA,
      baselineRowSha256: base?.rowSha256 ?? 'a'.repeat(64),
      markets: MARKETS.map((market) => ({
        name: market.name,
        underlying: market.base.toLowerCase(),
        aToken: market.aToken.toLowerCase(),
        decimals: market.decimals,
        rawCashProxy: { signedGapFraction: { numerator: '1', denominator: '2' } },
        rawCashProxyMissingReason: null,
        strategyBorrowUsageModel: null,
        strategyBorrowUsageMissingReason: 'zero-model-denominator',
      })),
      previousSha256: null,
      ...featureChange,
    }
    target.rows.push({ ...row, rowSha256: digest(row) })
  }
  writeFileSync(featurePath, JSON.stringify({ payload: target, sha256: digest(target) }))
  return { dir, baselinePath, featurePath }
}

function withFixture(options, fn) {
  const files = fixture(options)
  try { return fn(files) } finally { rmSync(files.dir, { recursive: true, force: true }) }
}

function appendCapture(files, { block, seconds, sourceSha }) {
  const baseline = JSON.parse(readFileSync(files.baselinePath, 'utf8')).payload
  const priorBase = baseline.baselines.at(-1)
  const nextBase = {
    ...priorBase,
    block,
    blockTimestamp: seconds,
    observedAtMs: seconds * 1000 + 100,
    previousSha256: priorBase.rowSha256,
  }
  nextBase.rowSha256 = digest({ ...nextBase, rowSha256: undefined })
  baseline.baselines.push(nextBase)
  writeFileSync(files.baselinePath, JSON.stringify({ payload: baseline, sha256: digest(baseline) }))
  const features = JSON.parse(readFileSync(files.featurePath, 'utf8')).payload
  const priorFeature = features.rows.at(-1)
  const nextFeature = {
    ...priorFeature,
    block,
    blockTimestamp: seconds,
    baselineObservedAtMs: nextBase.observedAtMs,
    observedAtMs: seconds * 1000 + 200,
    sourcePhysicalSha256: sourceSha,
    baselineRowSha256: nextBase.rowSha256,
    previousSha256: priorFeature.rowSha256,
  }
  nextFeature.rowSha256 = digest({ ...nextFeature, rowSha256: undefined })
  features.rows.push(nextFeature)
  writeFileSync(files.featurePath, JSON.stringify({ payload: features, sha256: digest(features) }))
}

test('available at caller clock only when matching sealed feature completed by decision', () => withFixture({}, (files) => {
  const result = auditAsOf({ ...files, schedule: schedule() })
  assert.equal(result.rows[0].status, 'asof_available_at_caller_clock')
  assert.equal(result.rows[0].sourcePhysicalShaStatus, 'unavailable')
  assert.equal(result.rows[0].pilotWindowStatus, 'unknown-start-or-finish')
  assert.equal(result.rows[0].pilotWindowChecks.witnessStartedInWindow, null)
  assert.equal(result.rows[0].pilotWindowChecks.witnessFinishedBy07, true)
  assert.equal(result.rows[0].pilotEligibility, 'unproven')
  assert.deepEqual(result.rows.map((row) => row.market), ['USDC', 'USDT'])
  assert.equal(result.counts.asof_available_at_caller_clock, 2)
  assert.equal(result.scheduleSha256, digest(schedule()))
  assert.match(result.scheduleProvenance, /not physical file bytes or independent preregistration/)
  assert.match(result.scheduleProvenance, /normalized JSON/)
}))

test('feature completed after decision is late', () => withFixture({ featureChange: { observedAtMs: SECOND * 1000 + 500 } }, (files) => {
  assert.equal(auditAsOf({ ...files, schedule: schedule() }).rows[0].status, 'late')
}))

test('frozen missing day remains missing, never quiet', () => withFixture({ baseline: false, feature: false }, (files) => {
  const result = auditAsOf({ ...files, schedule: schedule() })
  assert.equal(result.rows[0].status, 'missing')
  assert.equal(result.rows[0].reason, 'baseline-day-absent')
  assert.equal(result.counts.asof_available_at_caller_clock, 0)
  assert.equal(result.counts.missing, 2)
}))

test('matching B with different feature hash is censored', () => withFixture({ featureChange: { blockHash: `0x${'cd'.repeat(32)}` } }, (files) => {
  assert.equal(auditAsOf({ ...files, schedule: schedule() }).rows[0].status, 'censored/invalid')
}))

test('expected block recorded on a different day is censored', () => withFixture({ baseChange: { blockTimestamp: SECOND - 86400 } }, (files) => {
  assert.equal(auditAsOf({ ...files, schedule: schedule() }).rows[0].reason, 'baseline-day-mismatch')
}))

test('a quiet-looking feature day is only availability at caller clock', () => withFixture({}, (files) => {
  const result = auditAsOf({ ...files, schedule: schedule() })
  assert.equal(result.rows[0].status, 'asof_available_at_caller_clock')
  assert.match(result.caveat, /Missing days are not quiet days/)
  assert.equal('outcome' in result.rows[0], false)
}))

test('a missing selected market signal is censored for that market only', () => withFixture({}, (files) => {
  const saved = JSON.parse(readFileSync(files.featurePath, 'utf8'))
  saved.payload.rows[0].markets[1].rawCashProxy = null
  saved.payload.rows[0].markets[1].rawCashProxyMissingReason = 'zero-proxy-denominator'
  const row = saved.payload.rows[0]
  row.rowSha256 = digest({ ...row, rowSha256: undefined })
  writeFileSync(files.featurePath, JSON.stringify({ payload: saved.payload, sha256: digest(saved.payload) }))
  const result = auditAsOf({ ...files, schedule: schedule() })
  assert.deepEqual(result.rows.map((item) => item.status), ['asof_available_at_caller_clock', 'censored/invalid'])
  assert.equal(result.rows[1].captureStatus, 'captured')
  assert.equal(result.rows[1].signalAvailability.rawCashProxy, 'unavailable')
}))

test('a name-only market record cannot become eligible', () => withFixture({}, (files) => {
  const saved = JSON.parse(readFileSync(files.featurePath, 'utf8'))
  saved.payload.rows[0].markets[1] = { name: 'USDT' }
  const row = saved.payload.rows[0]
  row.rowSha256 = digest({ ...row, rowSha256: undefined })
  writeFileSync(files.featurePath, JSON.stringify({ payload: saved.payload, sha256: digest(saved.payload) }))
  const result = auditAsOf({ ...files, schedule: schedule() })
  assert.deepEqual(result.rows.map((item) => item.status), ['asof_available_at_caller_clock', 'censored/invalid'])
}))

test('out-of-range decision time fails as invalid schedule', () => withFixture({}, (files) => {
  assert.throws(
    () => auditAsOf({ ...files, schedule: schedule({ decisionAtMs: Number.MAX_SAFE_INTEGER }) }),
    /Invalid or duplicate frozen schedule row/,
  )
}))

test('a different B on the same day cannot replace the expected anchor', () => withFixture({ baseChange: { block: BLOCK + 1 } }, (files) => {
  const result = auditAsOf({ ...files, schedule: schedule() })
  assert.equal(result.rows[0].status, 'censored/invalid')
  assert.equal(result.rows[0].reason, 'baseline-anchor-mismatch')
}))

test('selected event B survives a second calendar capture on the same day', () => withFixture({}, (files) => {
  appendCapture(files, { block: 26059633, seconds: SECOND + 300, sourceSha: 'e'.repeat(64) })
  const result = auditAsOf({ ...files, schedule: schedule() })
  assert.deepEqual(result.rows.map((row) => row.status), [
    'asof_available_at_caller_clock', 'asof_available_at_caller_clock',
  ])
  assert.deepEqual(result.rows.map((row) => row.baselineBlock), [BLOCK, BLOCK])
  const ambiguous = auditAsOf({ ...files, schedule: schedule({ expectedBlock: undefined, expectedBlockHash: undefined }) })
  assert.equal(ambiguous.rows[0].reason, 'ambiguous-baseline-day')
}))

test('append-updated baseline leaves two historical physical sources unavailable, not invalid', () => withFixture({}, (files) => {
  appendCapture(files, { block: BLOCK + 490, seconds: SECOND + 86400, sourceSha: 'e'.repeat(64) })
  const nextDay = '2026-09-29'
  const next = { day: nextDay, decisionAtMs: (SECOND + 86400) * 1000 + 300, expectedBlock: BLOCK + 490 }
  const result = auditAsOf({ ...files, schedule: [...schedule(), next] })
  assert.equal(result.counts.asof_available_at_caller_clock, 4)
  assert.deepEqual([...new Set(result.rows.map((row) => row.sourcePhysicalShaStatus))], ['unavailable'])
}))

test('witness finish after 07:00 fails pilot timing even when feature and caller clock are later', () => withFixture({
  baseChange: {
    captureStartedAtMs: Date.parse(`${DAY}T06:29:00Z`),
    observedAtMs: Date.parse(`${DAY}T07:05:00Z`),
  },
  featureChange: {
    baselineObservedAtMs: Date.parse(`${DAY}T07:05:00Z`),
    captureStartedAtMs: Date.parse(`${DAY}T07:06:00Z`),
    observedAtMs: Date.parse(`${DAY}T07:07:00Z`),
  },
}, (files) => {
  const result = auditAsOf({ ...files, schedule: schedule({ decisionAtMs: Date.parse(`${DAY}T07:08:00Z`) }) })
  assert.equal(result.rows[0].status, 'asof_available_at_caller_clock')
  assert.equal(result.rows[0].pilotWindowChecks.witnessFinishedBy07, false)
  assert.equal(result.rows[0].pilotWindowStatus, 'out-of-window-end')
  assert.equal(result.rows[0].pilotEligibility, 'unproven')
}))

test('witness 06:29 start and 06:31 finish meets window despite feature 06:32–06:33', () => withFixture({
  baseChange: {
    captureStartedAtMs: Date.parse(`${DAY}T06:29:00Z`),
    observedAtMs: Date.parse(`${DAY}T06:31:00Z`),
  },
  featureChange: {
    baselineObservedAtMs: Date.parse(`${DAY}T06:31:00Z`),
    captureStartedAtMs: Date.parse(`${DAY}T06:32:00Z`),
    observedAtMs: Date.parse(`${DAY}T06:33:00Z`),
  },
}, (files) => {
  const result = auditAsOf({ ...files, schedule: schedule({ decisionAtMs: Date.parse(`${DAY}T06:34:00Z`) }) })
  assert.equal(result.rows[0].status, 'asof_available_at_caller_clock')
  assert.deepEqual(result.rows[0].pilotWindowChecks, {
    inPilotDateRange: true,
    witnessStartedInWindow: true,
    witnessFinishedBy07: true,
  })
  assert.equal(result.rows[0].featureCaptureStartedAtMs, Date.parse(`${DAY}T06:32:00Z`))
  assert.equal(result.rows[0].featureObservedAtMs, Date.parse(`${DAY}T06:33:00Z`))
  assert.equal(result.rows[0].pilotWindowStatus, 'within-observed-window')
  assert.equal(result.rows[0].pilotEligibility, 'unproven')
}))

test('feature start after 06:30 does not fail witness pilot timing', () => withFixture({
  baseChange: { captureStartedAtMs: SECOND * 1000 + 50 },
  featureChange: {
    captureStartedAtMs: Date.parse(`${DAY}T06:31:00Z`),
    observedAtMs: Date.parse(`${DAY}T06:31:10Z`),
  },
}, (files) => {
  const result = auditAsOf({ ...files, schedule: schedule({ decisionAtMs: Date.parse(`${DAY}T06:32:00Z`) }) })
  assert.equal(result.rows[0].status, 'asof_available_at_caller_clock')
  assert.equal(result.rows[0].pilotWindowChecks.witnessStartedInWindow, true)
  assert.equal(result.rows[0].pilotWindowStatus, 'within-observed-window')
  assert.equal(result.rows[0].pilotEligibility, 'unproven')
}))

test('baseline start after 06:30 also fails pilot timing', () => withFixture({
  baseChange: {
    captureStartedAtMs: Date.parse(`${DAY}T06:31:00Z`),
    observedAtMs: Date.parse(`${DAY}T06:31:10Z`),
  },
  featureChange: {
    baselineObservedAtMs: Date.parse(`${DAY}T06:31:10Z`),
    captureStartedAtMs: Date.parse(`${DAY}T06:31:20Z`),
    observedAtMs: Date.parse(`${DAY}T06:31:30Z`),
  },
}, (files) => {
  const result = auditAsOf({ ...files, schedule: schedule({ decisionAtMs: Date.parse(`${DAY}T06:32:00Z`) }) })
  assert.equal(result.rows[0].pilotWindowChecks.witnessStartedInWindow, false)
  assert.equal(result.rows[0].pilotWindowStatus, 'out-of-window-start')
}))

test('feature market decimals mismatch is censored for that market only', () => withFixture({}, (files) => {
  const saved = JSON.parse(readFileSync(files.featurePath, 'utf8'))
  saved.payload.rows[0].markets[1].decimals = 18
  const row = saved.payload.rows[0]
  row.rowSha256 = digest({ ...row, rowSha256: undefined })
  writeFileSync(files.featurePath, JSON.stringify({ payload: saved.payload, sha256: digest(saved.payload) }))
  const result = auditAsOf({ ...files, schedule: schedule() })
  assert.equal(result.rows[0].status, 'asof_available_at_caller_clock')
  assert.equal(result.rows[1].reason, 'invalid-market-record')
}))

test('Sep 26 calendar pair matches current physical SHA and reserves a missing day', () => {
  const root = fileURLToPath(new URL('../../data/research/venue-signals/', import.meta.url))
  const daily = {
    day: '2026-09-26',
    decisionAtMs: 1790402456243,
    expectedBlock: 26059633,
    expectedBlockHash: '0x0054f02057d2c8160e809def3ae50a2e5324dc118d94f2820f48e37f020c6168',
    baselinePath: join(root, 'aave-core-holder-witness-2026-09-26.json'),
    featurePath: join(root, 'aave-core-anchor-features-2026-09-26.json'),
  }
  const missing = { day: '2026-09-27', decisionAtMs: Date.parse('2026-09-27T06:30:00Z'), baselinePath: null, featurePath: null }
  const result = auditAsOf({ schedule: [daily, missing] })
  assert.equal(result.counts.asof_available_at_caller_clock, 2)
  assert.equal(result.counts.missing, 2)
  assert.equal(result.rows[0].sourcePhysicalShaStatus, 'current-file-bytes-match-feature-record; immutability-unproven')
  assert.equal(result.rows[0].pilotEligibility, 'unproven')
})

test('corrupt envelope or row chain hard fails', () => withFixture({}, (files) => {
  const saved = JSON.parse(readFileSync(files.featurePath, 'utf8'))
  saved.payload.rows[0].rowSha256 = '0'.repeat(64)
  writeFileSync(files.featurePath, JSON.stringify({ payload: saved.payload, sha256: digest(saved.payload) }))
  assert.throws(() => auditAsOf({ ...files, schedule: schedule() }), /row chain mismatch/)
  writeFileSync(files.featurePath, JSON.stringify({ payload: saved.payload, sha256: '0'.repeat(64) }))
  assert.throws(() => auditAsOf({ ...files, schedule: schedule() }), /SHA mismatch/)
}))
