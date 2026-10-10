import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'

import {
  CASH_CANDIDATE_POLICY,
  evaluateCashCandidateSubject,
  exactH24PairsFromObservations,
  pinnedCandidateObservations,
  CASH_CANDIDATE_V1_SNAPSHOTS,
  CASH_CANDIDATE_CONTRACT_SHA256,
  runCurrentCashCandidateSweep,
} from './carry-cash-candidate-sweep.mjs'

const ROUTE = 'Synthetic → exact venue'
const DESTINATION = '0x1111111111111111111111111111111111111111'
const ASSET = '0x2222222222222222222222222222222222222222'
const subject = { routeKey: ROUTE, destination: DESTINATION, asset: ASSET, assetDecimals: 6 }
const subjectKey = `${ROUTE}\0${DESTINATION}\0${ASSET}`
const start = Date.parse('2026-01-01T00:00:00.000Z')

function returnPairs(holdoutMultiplier = 2n) {
  return Array.from({ length: 60 }, (_, index) => {
    const sourceAt = new Date(start + index * 2 * 86_400_000).toISOString()
    const targetAt = new Date(start + (index * 2 + 1) * 86_400_000).toISOString()
    const source =
      index < 20
        ? 100n + BigInt(index)
        : index < 40
          ? 200n + BigInt(index)
          : index < 50
            ? 1_000n + BigInt(index)
            : 2_000n + BigInt(index)
    const multiplier = index >= 50 ? holdoutMultiplier : 2n
    return {
      subjectKey,
      sourceAt,
      targetAt,
      sourceCashRaw: source.toString(),
      targetCashRaw: (source * multiplier).toString(),
    }
  })
}

function evaluate(pairs) {
  return evaluateCashCandidateSubject({
    subject,
    payoutAsset: ASSET,
    pairs,
    source: { cohort: 'synthetic' },
  })
}

test('a source-relative candidate is selected before holdout and can honestly qualify', () => {
  const result = evaluate(returnPairs())

  assert.equal(result.legacy.modelSelectionFailed, true)
  assert.match(result.candidateSearch.selected.id, /lower_median_return_e18/)
  assert.equal(result.candidateSearch.selected.selection.coveragePassed, true)
  assert.equal(result.candidateSearch.selected.selection.pointBeatsPersistence, true)
  assert.equal(result.untouchedHoldout.coveragePercent, 100)
  assert.equal(result.untouchedHoldout.pointBeatsPersistence, true)
  assert.equal(result.historicalCandidateQualified, true)
  assert.equal(result.prospectiveValidated, false)
  assert.equal(result.holderExecutableExit, false)
})

test('pinned 120 receipts survive later appends and reject missing or mutated rows', () => {
  const rows = Array.from({ length: 120 }, (_, index) => ({
    collectionMode: 'retrospective',
    anchorAt: new Date(start + index * 86_400_000).toISOString(),
    receiptSha256: String(index).padStart(64, '0'),
  }))
  const digest = createHash('sha256')
    .update(
      JSON.stringify(rows.map(({ anchorAt, receiptSha256 }) => ({ anchorAt, receiptSha256 }))),
    )
    .digest('hex')
  const pin = {
    manifestSha256: 'manifest',
    anchorFrom: rows[0].anchorAt,
    anchorThrough: rows.at(-1).anchorAt,
    firstReceiptSha256: rows[0].receiptSha256,
    lastReceiptSha256: rows.at(-1).receiptSha256,
    orderedReceiptsSha256: digest,
  }
  const append = Array.from({ length: 121 }, (_, index) => ({
    ...rows[0],
    anchorAt: new Date(start + (120 + index) * 86_400_000).toISOString(),
    receiptSha256: String(120 + index).padStart(64, '0'),
  }))
  assert.deepEqual(pinnedCandidateObservations([...rows, ...append], pin, 'manifest'), rows)
  assert.throws(
    () => pinnedCandidateObservations([...rows.slice(1), ...append], pin, 'manifest'),
    /snapshot_receipts/,
  )
  assert.throws(
    () =>
      pinnedCandidateObservations(
        [{ ...rows[0], receiptSha256: 'f'.repeat(64) }, ...rows.slice(1)],
        pin,
        'manifest',
      ),
    /snapshot_receipts/,
  )
  assert.throws(() => pinnedCandidateObservations(rows, pin, 'wrong'), /snapshot_manifest/)
})

test('current v1 snapshot and target identities stay fixed', async () => {
  const result = await runCurrentCashCandidateSweep()
  assert.equal(
    createHash('sha256').update(JSON.stringify(result)).digest('hex'),
    '3eb9f5b14d0914f542d6055b4473c2b5b08954c8d27551abad4eab39f3153256',
  )
  assert.equal(
    CASH_CANDIDATE_CONTRACT_SHA256,
    '1ea1e24b4ed33c46fc51ff1b002787bfe7fce59eb55ede9a6a76f3134b438ae4',
  )
  assert.equal(result.corpus.exactPublicSubjects, 68)
  assert.equal(result.corpus.exactPayoutIdentityWith60Pairs, 63)
  assert.deepEqual(
    result.subjects.map(({ destination }) => destination),
    [
      '0x32401b9fb79065bc15949de0bd43927492f02f0c',
      '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d',
      '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
      '0x069662d2588fcac24b5c209456db965d151556f0',
      '0x153bd1abe60104bd46aa05a27fa12d1346d64a57',
      '0xd5cce260e7a755ddf0fb9cdf06443d593aaeaa13',
      '0xf1ca44eea3a4effcb195a970a2f1d8553f76f9a1',
      '0x4f5923fc5fd4a93352581b38b7cd26943012decf',
    ],
  )
  assert.equal(result.summary.selectionGatePassed, 0)
  assert.equal(result.summary.historicallyQualifiedCandidates, 0)
  assert.deepEqual(result.snapshots, CASH_CANDIDATE_V1_SNAPSHOTS)
})

test('changing only untouched outcomes cannot change selection and can only fail qualification', () => {
  const passing = evaluate(returnPairs(2n))
  const failing = evaluate(returnPairs(3n))

  assert.deepEqual(passing.candidateSearch.selected, failing.candidateSearch.selected)
  assert.equal(passing.historicalCandidateQualified, true)
  assert.equal(failing.untouchedHoldout.coveragePassed, false)
  assert.equal(failing.historicalCandidateQualified, false)
  assert.equal(failing.result, 'still_abstained')
})

test('a failed-selection diagnostic is locked before holdout and can never qualify', () => {
  const build = (holdoutDelta) =>
    returnPairs().map((pair, index) => {
      const source = BigInt(pair.sourceCashRaw)
      const delta = index < 40 ? 0n : index < 50 ? 10_000n : holdoutDelta
      return { ...pair, targetCashRaw: (source + delta).toString() }
    })
  const first = evaluate(build(0n))
  const second = evaluate(build(999_999n))

  assert.equal(first.legacy.modelSelectionFailed, true)
  assert.equal(first.candidateSearch.selected.lockKind, 'diagnostic_selection_failure')
  assert.equal(first.candidateSearch.selected.selectionQualified, false)
  assert.deepEqual(first.candidateSearch.selected, second.candidateSearch.selected)
  assert.notDeepEqual(first.untouchedHoldout, second.untouchedHoldout)
  assert.equal(first.historicalCandidateQualified, false)
  assert.equal(second.historicalCandidateQualified, false)
})

test('identity, payout asset, pair floors, and horizon embargo fail closed', () => {
  assert.throws(
    () =>
      evaluateCashCandidateSubject({
        subject,
        payoutAsset: '0x3333333333333333333333333333333333333333',
        pairs: returnPairs(),
        source: {},
      }),
    /candidate_sweep_subject_payout_identity/,
  )
  assert.throws(() => evaluate(returnPairs().slice(1)), /candidate_sweep_pair_floor/)

  const wrongSubject = returnPairs()
  wrongSubject[12] = { ...wrongSubject[12], subjectKey: 'wrong' }
  assert.throws(() => evaluate(wrongSubject), /candidate_sweep_pair_subject_identity/)

  const overlap = returnPairs()
  overlap[12] = { ...overlap[12], sourceAt: overlap[11].targetAt }
  assert.throws(() => evaluate(overlap), /candidate_sweep_horizon_embargo/)
})

test('verified-observation seam preserves exact subject, asset, decimals, and 60 disjoint pairs', () => {
  const observations = Array.from({ length: 120 }, (_, index) => {
    const at = new Date(start + index * 86_400_000).toISOString()
    return {
      receiptSha256: String(index).padStart(64, '0'),
      collectionMode: 'retrospective',
      anchorAt: at,
      source: { blockAt: at },
      subjects: [
        {
          routeKey: ROUTE,
          destination: DESTINATION,
          asset: ASSET,
          assetDecimals: 6,
          cashRaw: String(1_000 + index),
          state: 'observed',
        },
      ],
    }
  })
  const extracted = exactH24PairsFromObservations(observations, subject)

  assert.equal(extracted.status, 'pairs')
  assert.equal(extracted.pairs.length, 60)
  assert.equal(extracted.pairs[0].subjectKey, subjectKey)
  assert.equal(extracted.assetDecimals, 6)
  assert.deepEqual(CASH_CANDIDATE_POLICY.split, {
    fit: 20,
    calibration: 20,
    selection: 10,
    untouchedHoldout: 10,
  })

  observations[0].subjects[0].asset = '0x3333333333333333333333333333333333333333'
  assert.throws(
    () => exactH24PairsFromObservations(observations, subject),
    /candidate_sweep_observation_asset_identity/,
  )
})
