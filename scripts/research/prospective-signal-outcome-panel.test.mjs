import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MARKETS } from './aave-core-forward-panel.mjs'
import { readCheckpoint as emptyBaseline } from './aave-core-holder-witness.mjs'
import { readCheckpoint as emptyFeatures } from './aave-core-anchor-features.mjs'
import { readCheckpoint as emptyOutcomes, HORIZONS } from './aave-core-holder-outcomes.mjs'
import {
  buildProspectiveSignalOutcomePanel,
  scheduledSampleLeadFromLocalObservation,
} from './prospective-signal-outcome-panel.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const digest = (value) => hash(JSON.stringify(value))
const DAY = '2026-09-28'
const AT = Date.parse(`${DAY}T06:15:00Z`)
const B = 26059143
const BH = `0x${'ab'.repeat(32)}`
const H = (letter) => `0x${letter.repeat(64)}`
const HOLDER = '0x1111111111111111111111111111111111111111'
const QUOTE = '1000000000000'
const AFTER_ALL_HORIZONS = AT + (HORIZONS['7d'] + 1) * 1000
const observedImplementation = { status: 'observed', address: HOLDER, codeHash: H('a') }
const seal = (path, payload) =>
  writeFileSync(path, JSON.stringify({ payload, sha256: digest(payload) }))

function fixture(t, { poolIdentity = true, outcomeCall = 'success', censoring = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prospective-panel-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const baselinePath = join(dir, 'baseline.json')
  const featurePath = join(dir, 'feature.json')
  const outcomePath = join(dir, 'outcome.json')
  const baseline = emptyBaseline(baselinePath)
  const baselineRow = {
    block: B,
    blockHash: BH,
    blockTimestamp: AT / 1000,
    observedAtMs: AT + 100,
    poolCodeHash: H('f'),
    ...(poolIdentity ? { poolImplementation: observedImplementation } : {}),
    markets: MARKETS.map((market) => ({
      name: market.name,
      underlying: market.base.toLowerCase(),
      underlyingCodeHash: H('b'),
      aToken: market.aToken.toLowerCase(),
      aTokenCodeHash: H('c'),
      decimals: 6,
      quoteRaw: QUOTE,
      transferWindow: { fromBlock: B - 2000, toBlock: B - 1, logs: 1 },
      candidates: [
        { address: HOLDER, aTokenBalanceRaw: QUOTE, codeStatus: 'eoa', withdraw: 'success' },
      ],
      qualifyingHolders: [HOLDER],
    })),
    previousSha256: null,
  }
  baseline.baselines.push({ ...baselineRow, rowSha256: digest(baselineRow) })
  seal(baselinePath, baseline)
  const feature = emptyFeatures(featurePath, baselinePath)
  const featureRow = {
    block: B,
    blockHash: BH,
    blockTimestamp: AT / 1000,
    baselineObservedAtMs: AT + 100,
    observedAtMs: AT + 200,
    sourcePhysicalSha256: hash(readFileSync(baselinePath)),
    baselineRowSha256: baseline.baselines[0].rowSha256,
    markets: MARKETS.map((market) => ({
      name: market.name,
      underlying: market.base.toLowerCase(),
      aToken: market.aToken.toLowerCase(),
      decimals: 6,
      rawCashProxy: { signedGapFraction: { numerator: '1', denominator: '2' } },
      rawCashProxyMissingReason: null,
      strategyBorrowUsageModel: null,
      strategyBorrowUsageMissingReason: 'zero-model-denominator',
    })),
    previousSha256: null,
  }
  feature.rows.push({ ...featureRow, rowSha256: digest(featureRow) })
  seal(featurePath, feature)
  const outcome = emptyOutcomes(outcomePath, baselinePath)
  const target = AT / 1000 + HORIZONS['24h']
  const outcomeRow = {
    baselineBlock: B,
    baselineBlockHash: BH,
    baselineSha256: baseline.baselines[0].rowSha256,
    horizon: '24h',
    targetTimestamp: target,
    block: B + 100,
    blockHash: H('d'),
    blockTimestamp: target,
    observedAtMs: target * 1000 + 100,
    poolCodeHash: H('f'),
    baselineImplementation: poolIdentity
      ? observedImplementation
      : { status: 'unknown', reason: 'missing' },
    poolImplementation: observedImplementation,
    markets: MARKETS.map((market) => ({
      name: market.name,
      underlying: market.base.toLowerCase(),
      aToken: market.aToken.toLowerCase(),
      underlyingCodeHash: H('b'),
      aTokenCodeHash: H('c'),
      reserveAToken: market.aToken.toLowerCase(),
      decimals: 6,
      flags: { active: true, paused: false },
      cashRaw: QUOTE,
      readErrors: [],
      quoteRaw: QUOTE,
      baselineATokenImplementation: observedImplementation,
      aTokenImplementation: observedImplementation,
      witnesses: [
        {
          holder: HOLDER,
          call: outcomeCall,
          returnedRaw: outcomeCall === 'success' ? QUOTE : null,
          aTokenBalanceRaw: QUOTE,
          codeStatus: 'eoa',
          healthReadErrors: [],
          readErrorStage: null,
          censoring,
          deterioration: censoring.length
            ? 'censored'
            : outcomeCall === 'revert'
              ? 'baseline-success-to-unattributed-revert'
              : 'no-observed-revert',
        },
      ],
    })),
    previousSha256: null,
  }
  outcome.outcomes.push({ ...outcomeRow, rowSha256: digest(outcomeRow) })
  seal(outcomePath, outcome)
  const schedule = [
    {
      day: DAY,
      decisionAtMs: AT + 300,
      expectedBlock: B,
      expectedBlockHash: BH,
      baselinePath,
      featurePath,
      outcomePath,
      baselinePhysicalSha256: hash(readFileSync(baselinePath)),
      featurePhysicalSha256: hash(readFileSync(featurePath)),
      outcomePhysicalSha256: hash(readFileSync(outcomePath)),
    },
  ]
  return { schedule, baselinePath, featurePath, outcomePath }
}

test('emits every day×market×horizon; sampled success is not an interval-quiet control', (t) => {
  const { schedule } = fixture(t)
  const panel = buildProspectiveSignalOutcomePanel({ schedule, asOfMs: AFTER_ALL_HORIZONS })
  assert.equal(panel.rows.length, 6)
  const six = panel.rows.find((row) => row.market === 'USDC' && row.horizon === '6h')
  assert.equal(six.signalStatus, 'insufficient-scheduled-sample-lead')
  assert.equal(six.outcomeStatus, 'missing')
  const day = panel.rows.find((row) => row.market === 'USDC' && row.horizon === '24h')
  assert.equal(day.outcomeStatus, 'sampled_success')
  assert.equal(day.signalStatus, 'asof-available-reported')
  assert.equal(day.sampledObservationReady, true)
  assert.equal(day.exploratoryScoringReady, false)
  assert.equal(day.sampledQuietControlReady, false)
  assert.equal(day.onsetLeadAtLeastSixHours, null)
  assert.equal(day.predictiveEligibility, 'unproven')
  assert.equal(day.sourceIdentity.baselineExpectedPhysicalShaMatched, true)
})

test('unresolved baseline implementation censors mechanical successes', (t) => {
  const { schedule } = fixture(t, { poolIdentity: false })
  const row = buildProspectiveSignalOutcomePanel({
    schedule,
    asOfMs: AFTER_ALL_HORIZONS,
  }).rows.find((r) => r.horizon === '24h')
  assert.equal(row.outcomeStatus, 'censored')
  assert.equal(row.exploratoryScoringReady, false)
  assert.ok(row.witnesses[0].censoring.includes('pool-implementation-unresolved'))
})

test('uncensored fixed-holder revert is deterioration; explicit censoring never becomes control', (t) => {
  const { schedule } = fixture(t, { outcomeCall: 'revert' })
  const row = buildProspectiveSignalOutcomePanel({
    schedule,
    asOfMs: AFTER_ALL_HORIZONS,
  }).rows.find((r) => r.horizon === '24h')
  assert.equal(row.outcomeStatus, 'deterioration')
  assert.equal(row.scheduledSampleLeadAtLeastSixHours, true)
  assert.equal(row.onsetLeadAtLeastSixHours, null)
  assert.equal(row.onsetLeadSeconds, null)
  assert.equal(row.eventLeadReady, false)
  assert.equal(row.exploratoryScoringReady, false)
  assert.equal(row.onsetTimingStatus, 'unproven-interval-censored-between-baseline-and-sample')
  const changed = fixture(t, { outcomeCall: 'success', censoring: ['holder-attrition'] })
  const censored = buildProspectiveSignalOutcomePanel({
    schedule: changed.schedule,
    asOfMs: AFTER_ALL_HORIZONS,
  }).rows.find((r) => r.horizon === '24h')
  assert.equal(censored.outcomeStatus, 'censored')
})

test('missing day and source hash disagreement remain explicit, not quiet or eligible', (t) => {
  const { schedule } = fixture(t)
  const missing = buildProspectiveSignalOutcomePanel({
    asOfMs: AFTER_ALL_HORIZONS,
    schedule: [
      {
        day: DAY,
        decisionAtMs: AT,
        expectedBlock: B,
        expectedBlockHash: BH,
        baselinePath: null,
        featurePath: null,
      },
    ],
  })
  assert.equal(missing.rows.length, 6)
  assert.equal(missing.rows[0].auditStatus, 'missing')
  assert.equal(missing.rows[0].outcomeStatus, 'missing')
  const bad = [{ ...schedule[0], featurePhysicalSha256: '0'.repeat(64) }]
  const row = buildProspectiveSignalOutcomePanel({
    schedule: bad,
    asOfMs: AFTER_ALL_HORIZONS,
  }).rows.find((r) => r.horizon === '24h')
  assert.equal(row.signalStatus, 'source-identity-unproven')
  assert.equal(row.exploratoryScoringReady, false)
  const outcomeUnfrozen = [{ ...schedule[0], outcomePhysicalSha256: '0'.repeat(64) }]
  const observed = buildProspectiveSignalOutcomePanel({
    schedule: outcomeUnfrozen,
    asOfMs: AFTER_ALL_HORIZONS,
  }).rows.find((r) => r.horizon === '24h')
  assert.equal(observed.outcomeStatus, 'sampled_success')
  assert.equal(observed.sourceIdentity.outcomeExpectedPhysicalShaMatched, false)
  assert.equal(observed.sampledObservationReady, false)
})

test('an explicit as-of clock is mandatory', (t) => {
  const { schedule } = fixture(t)
  assert.throws(
    () => buildProspectiveSignalOutcomePanel({ schedule }),
    /Explicit as-of clock required/,
  )
})

test('not-yet-due outcome is pending only with an explicit as-of clock', (t) => {
  const { schedule } = fixture(t)
  const panel = buildProspectiveSignalOutcomePanel({ schedule, asOfMs: AT + 3600 * 1000 })
  const seven = panel.rows.find((row) => row.market === 'USDC' && row.horizon === '7d')
  assert.equal(seven.outcomeStatus, 'pending')
  assert.equal(seven.outcomeReason, 'horizon-not-yet-due')
  assert.equal(
    panel.rows.find((row) => row.market === 'USDC' && row.horizon === '24h').outcomeStatus,
    'pending',
  )
  const due = buildProspectiveSignalOutcomePanel({
    schedule,
    asOfMs: AT + (HORIZONS['7d'] + 1) * 1000,
  })
  assert.equal(
    due.rows.find((row) => row.market === 'USDC' && row.horizon === '7d').outcomeStatus,
    'missing',
  )
})

test('lead uses later decision/feature completion, not block time', (t) => {
  const { schedule } = fixture(t)
  const target = AT + HORIZONS['24h'] * 1000
  const row = buildProspectiveSignalOutcomePanel({
    schedule,
    asOfMs: AFTER_ALL_HORIZONS,
  }).rows.find((r) => r.horizon === '24h')
  assert.equal(row.scheduledSampleLeadSeconds, (target - (AT + 300)) / 1000)
  assert.deepEqual(
    scheduledSampleLeadFromLocalObservation({
      scheduledSampleAtMs: target,
      decisionAtMs: target - 6 * 3600 * 1000,
      featureCompletedAtMs: target - 7 * 3600 * 1000,
    }),
    { seconds: 21600, atLeastSixHours: true },
  )
  assert.equal(
    scheduledSampleLeadFromLocalObservation({
      scheduledSampleAtMs: target,
      decisionAtMs: target - 6 * 3600 * 1000 + 1,
      featureCompletedAtMs: target - 7 * 3600 * 1000,
    }).atLeastSixHours,
    false,
  )
})
