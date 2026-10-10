import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { planModelAttempts } from './record-carry-cash-model.mjs'

const MANIFEST = 'a'.repeat(64)
const ISSUE_AT = '2026-09-29T06:55:00.000Z'
const FIRST = '2026-09-17T04:00:00.000Z'
const LAST = '2026-09-29T03:00:00.000Z'
const HOUR = 3_600_000
const START = Date.parse('2026-09-17T04:00:00.000Z')

function fixture() {
  const subjects = []
  const baselines = []
  for (let index = 0; index < 67; index++) {
    const routeKey = `route-${index}`
    const destination = `0x${String(index + 1).padStart(40, '0')}`
    const asset = `0x${String(index + 101).padStart(40, '0')}`
    const key = `${routeKey}\0${destination}`
    const pairs = Array.from({ length: 60 }, (_, pairIndex) => {
      const at = START + pairIndex * 2 * HOUR
      return {
        subjectKey: key,
        sourceAt: new Date(at).toISOString(),
        targetAt: new Date(at + HOUR).toISOString(),
        sourceCashRaw: '1000',
        targetCashRaw: index === 0 ? '1010' : '1000',
      }
    })
    subjects.push({
      routeKey,
      destination,
      asset,
      assetDecimals: 6,
      firstAnchorAt: FIRST,
      lastAnchorAt: LAST,
      horizons: [
        {
          horizonHours: 1,
          independentSelection: 'earliest_anchor_greedy_disjoint_endpoints',
          counts: { independentPairs: 60 },
          pairs,
        },
        {
          horizonHours: 24,
          independentSelection: 'earliest_anchor_greedy_disjoint_endpoints',
          counts: { independentPairs: 0 },
          pairs: [],
        },
      ],
    })
    for (const horizonHours of [1, 24]) {
      baselines.push({
        slot_at: '2026-09-29T06:00:00.000Z',
        route_key: routeKey,
        destination,
        asset,
        asset_decimals: 6,
        horizon_hours: horizonHours,
        status: index === 66 ? 'unassessed' : 'issued',
        issued_at: ISSUE_AT,
        source_observed_at:
          index === 66 ? null : new Date(Date.parse(ISSUE_AT) - 5 * 60_000).toISOString(),
        source_cash_raw: index === 66 ? null : '1000',
      })
    }
  }
  return {
    corpus: {
      captureKind: 'backfilled',
      subjectManifestSha256: MANIFEST,
      subjectCount: 67,
      whollyMissingArchiveAnchors: 0,
      missingSubjectAnchorRows: 0,
      subjects,
    },
    baselines,
  }
}

test('issues qualified H1 delta and persistence bands with separate immutable evidence', () => {
  const { corpus, baselines } = fixture()
  const plan = planModelAttempts(corpus, baselines, MANIFEST)
  assert.equal(plan.attempts.length, 134)
  assert.equal(plan.artifacts.length, 66)
  assert.deepEqual(
    Object.fromEntries(
      ['issued', 'historical_backtest_failed', 'insufficient_history', 'unassessed'].map(
        (status) => [status, plan.attempts.filter((attempt) => attempt.status === status).length],
      ),
    ),
    {
      issued: 66,
      historical_backtest_failed: 0,
      insufficient_history: 66,
      unassessed: 2,
    },
  )
  const artifact = plan.artifacts.find(
    (item) => JSON.parse(item.payloadBytes).kind === 'historical_cash_delta_model_v1',
  )
  assert.ok(artifact)
  assert.equal(artifact.sha256, createHash('sha256').update(artifact.payloadBytes).digest('hex'))
  const payload = JSON.parse(artifact.payloadBytes)
  assert.equal(payload.pairs.length, 60)
  assert.deepEqual(payload.counts, {
    total: 60,
    fit: 20,
    calibration: 20,
    selection: 10,
    holdout: 10,
  })
  assert.equal(artifact.selectionPairs, 10)
  assert.equal(artifact.holdoutPairs, 10)
  assert.match(artifact.modelVersion, /^hdelta4-/)
  assert.equal(payload.selection.total, 10)
  assert.equal(payload.holdout.total, 10)
  assert.equal(payload.assetDecimals, 6)
  assert.equal(artifact.payloadBytes.includes('\\u0000'), false)
  assert.equal(payload.historicalBacktestOnly, true)
  assert.equal(payload.prospectiveValidated, false)
  assert.equal(
    plan.attempts.find((attempt) => attempt.routeKey === 'route-0' && attempt.horizonHours === 1)
      .modelArtifactSha256,
    artifact.sha256,
  )
  const band = plan.artifacts.find(
    (item) => JSON.parse(item.payloadBytes).kind === 'historical_cash_persistence_band_v1',
  )
  assert.ok(band)
  assert.match(band.modelVersion, /^hband4-/)
  assert.equal(JSON.parse(band.payloadBytes).baselineBand.selectionCoveragePassed, true)
  assert.equal(JSON.parse(band.payloadBytes).baselineBand.coveragePassed, true)
  assert.equal(
    plan.attempts.find((attempt) => attempt.routeKey === 'route-1' && attempt.horizonHours === 1)
      .forecastPointRaw,
    '1000',
  )
})

test('uses selection for model choice and keeps the final holdout untouched', () => {
  const { corpus, baselines } = fixture()
  const learned = corpus.subjects[0].horizons[0].pairs
  for (let index = 50; index < 60; index++) learned[index].targetCashRaw = '1000'
  const persistence = corpus.subjects[1].horizons[0].pairs
  for (let index = 50; index < 60; index++) persistence[index].targetCashRaw = '1010'

  const plan = planModelAttempts(corpus, baselines, MANIFEST)
  const learnedAttempt = plan.attempts.find(
    (attempt) => attempt.routeKey === 'route-0' && attempt.horizonHours === 1,
  )
  const learnedArtifact = plan.artifacts.find(
    (artifact) => artifact.sha256 === learnedAttempt.modelArtifactSha256,
  )
  assert.ok(learnedArtifact)
  const learnedPayload = JSON.parse(learnedArtifact.payloadBytes)
  assert.equal(learnedPayload.kind, 'historical_cash_delta_model_v1')
  assert.equal(learnedPayload.selection.pointBeatsPersistence, true)
  assert.equal(learnedPayload.holdout.pointBeatsPersistence, false)
  assert.equal(learnedPayload.holdout.coveragePassed, false)

  const persistenceAttempt = plan.attempts.find(
    (attempt) => attempt.routeKey === 'route-1' && attempt.horizonHours === 1,
  )
  const persistenceArtifact = plan.artifacts.find(
    (artifact) => artifact.sha256 === persistenceAttempt.modelArtifactSha256,
  )
  assert.ok(persistenceArtifact)
  const persistencePayload = JSON.parse(persistenceArtifact.payloadBytes)
  assert.equal(persistencePayload.kind, 'historical_cash_persistence_band_v1')
  assert.equal(persistencePayload.baselineBand.selectionCoveragePassed, true)
  assert.equal(persistencePayload.baselineBand.coveragePassed, false)
})

test('refuses incomplete or identity-drifted baseline grid before issuing anything', () => {
  const { corpus, baselines } = fixture()
  assert.throws(() => planModelAttempts(corpus, baselines.slice(1), MANIFEST), /incomplete_grid/)
  assert.throws(
    () =>
      planModelAttempts(
        corpus,
        [{ ...baselines[0], asset: '0x' + 'f'.repeat(40) }, ...baselines.slice(1)],
        MANIFEST,
      ),
    /subject_mismatch/,
  )
  assert.throws(
    () =>
      planModelAttempts(
        corpus,
        [{ ...baselines[0], asset_decimals: 18 }, ...baselines.slice(1)],
        MANIFEST,
      ),
    /subject_mismatch/,
  )
  assert.throws(
    () => planModelAttempts({ ...corpus, whollyMissingArchiveAnchors: 1 }, baselines, MANIFEST),
    /incomplete_grid/,
  )
})

test('a frozen artifact does not change when the later live source cash changes', () => {
  const { corpus, baselines } = fixture()
  const first = planModelAttempts(corpus, baselines, MANIFEST)
  const later = planModelAttempts(
    corpus,
    baselines.map((row) => (row.status === 'issued' ? { ...row, source_cash_raw: '2000' } : row)),
    MANIFEST,
  )
  assert.deepEqual(
    first.artifacts.map((artifact) => artifact.sha256),
    later.artifacts.map((artifact) => artifact.sha256),
  )
  assert.notEqual(first.attempts[0].forecastPointRaw, later.attempts[0].forecastPointRaw)
})

test('uses the source observation clock and rejects history learned during receipt delay', () => {
  const { corpus, baselines } = fixture()
  const lastTarget = corpus.subjects[0].horizons[0].pairs.at(-1).targetAt
  const delayed = baselines.map((row) =>
    row.route_key === 'route-0' && row.horizon_hours === 1
      ? {
          ...row,
          source_observed_at: new Date(Date.parse(lastTarget) - 1).toISOString(),
          issued_at: new Date(Date.parse(lastTarget) + 60_000).toISOString(),
        }
      : row,
  )
  const plan = planModelAttempts(corpus, delayed, MANIFEST)
  const attempt = plan.attempts.find(
    (item) => item.routeKey === 'route-0' && item.horizonHours === 1,
  )
  assert.equal(attempt.status, 'model_unavailable')
  assert.equal(attempt.reason, 'future_outcome')
  assert.equal(
    plan.artifacts.some(
      (artifact) => artifact.routeKey === 'route-0' && artifact.horizonHours === 1,
    ),
    false,
  )
})
