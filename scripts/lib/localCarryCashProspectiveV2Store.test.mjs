import assert from 'node:assert/strict'
import test from 'node:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CASH_V2_POLICY } from '../research/carry-cash-prospective-v2-policy.mjs'
import {
  CashProspectiveV2LedgerError,
  evaluateCashProspectiveV2,
  issueCashProspectiveV2,
  registerCashProspectiveV2,
  scoreCashProspectiveV2,
  tickCashProspectiveV2,
  verifyCashProspectiveV2Ledger,
} from './localCarryCashProspectiveV2Store.mjs'

const at = (value) => Date.parse(value)
const hex = (character) => character.repeat(64)
function receipt(
  subject,
  manifestSha256,
  sequence,
  blockAt,
  firstLocalReceiptAt,
  cash,
  mode = 'current',
) {
  return {
    sequence,
    sha256: hex(String((sequence + (subject.id === 'sgho' ? 4 : 0)) % 10)),
    manifestSha256,
    collectionMode: mode,
    block: String(1000 + sequence),
    blockHash: `0x${hex('a')}`,
    blockAt,
    firstLocalReceiptAt,
    rows: [
      {
        routeKey: subject.routeKey,
        destination: subject.destination,
        asset: subject.asset,
        shareDecimals: subject.decimals,
        assetDecimals: subject.decimals,
        cashRaw: cash,
        state: 'observed',
        reason: null,
      },
    ],
  }
}
function markUnavailable(row, state, reason) {
  row.state = state
  row.asset = null
  row.shareDecimals = null
  row.assetDecimals = null
  row.cashRaw = null
  row.reason = reason
}
function setup() {
  const root = join(mkdtempSync(join(tmpdir(), 'cash-v2-test-')), 'ledger')
  const inputs = {}
  for (const subject of CASH_V2_POLICY.subjects) {
    const manifest = { sha256: hex(subject.id === 'sgho' ? 'b' : 'c') }
    const first = receipt(
      subject,
      manifest.sha256,
      1,
      '2026-10-05T12:00:00.000Z',
      '2026-10-05T12:04:00.000Z',
      '1000',
    )
    inputs[subject.cohort] = {
      manifest,
      verified: {
        count: 1,
        last: first,
        records: [first],
        manifestSha256: manifest.sha256,
      },
    }
  }
  const development = CASH_V2_POLICY.subjects.map((subject) => ({
    subjectId: subject.id,
    kind: 'pinned_test_source',
    physicalSha256: hex('d'),
    contentSha256: hex('e'),
    count: 120,
    throughUtc: '2026-09-30T00:00:00.000Z',
    parameters: {
      pairCount: 60,
      firstPairSourceAtUtc: '2026-01-01T00:00:00.000Z',
      lastPairTargetAtUtc: '2026-09-30T00:00:00.000Z',
      medianDeltaRaw: '10',
      p10DeltaRaw: '-100',
      p90DeltaRaw: '100',
    },
  }))
  const push = (subjectId, sequence, blockAt, firstLocalReceiptAt, cash) => {
    const subject = CASH_V2_POLICY.subjects.find((row) => row.id === subjectId)
    const source = inputs[subject.cohort]
    const row = receipt(
      subject,
      source.manifest.sha256,
      sequence,
      blockAt,
      firstLocalReceiptAt,
      cash,
    )
    source.verified.records.push(row)
    source.verified.count++
    source.verified.last = row
  }
  return { root, inputs, development, push }
}

test('registers once, records hourly ticks, issues before H24, scores current-only targets, and remains unvalidated', () => {
  const fixture = setup()
  const common = { root: fixture.root, minFreeBytes: 0 }
  const registered = registerCashProspectiveV2(fixture.inputs, fixture.development, {
    ...common,
    now: at('2026-10-05T12:07:00.000Z'),
  })
  assert.equal(registered.status, 'registered')
  assert.equal(
    registerCashProspectiveV2(fixture.inputs, fixture.development, {
      ...common,
      now: at('2026-10-05T12:08:00.000Z'),
    }).status,
    'already_registered',
  )
  const changedDevelopment = structuredClone(fixture.development)
  changedDevelopment[0].parameters.medianDeltaRaw = '11'
  assert.throws(
    () =>
      registerCashProspectiveV2(fixture.inputs, changedDevelopment, {
        ...common,
        now: at('2026-10-05T12:08:00.000Z'),
      }),
    /development_changed/,
  )
  for (const subject of CASH_V2_POLICY.subjects)
    fixture.push(subject.id, 2, '2026-10-05T13:03:00.000Z', '2026-10-05T13:08:00.000Z', '1000')
  assert.equal(
    tickCashProspectiveV2(fixture.inputs, { ...common, now: at('2026-10-05T13:15:00.000Z') })
      .ticks[0].payload.status,
    'on_time',
  )
  assert.equal(
    tickCashProspectiveV2(fixture.inputs, { ...common, now: at('2026-10-05T13:15:00.000Z') })
      .status,
    'already_recorded',
  )
  const first = issueCashProspectiveV2(fixture.inputs, {
    ...common,
    now: at('2026-10-05T13:15:00.000Z'),
  })
  assert.equal(first.issues.length, 2)
  assert.equal(first.issues[0].payload.targetAtUtc, '2026-10-06T13:03:00.000Z')
  assert.equal(verifyCashProspectiveV2Ledger(fixture.inputs, fixture.root).records.length, 4)
  assert.deepEqual(
    verifyCashProspectiveV2Ledger(fixture.inputs, fixture.root).ticks[0].payload.opportunities.map(
      (row) => row.status,
    ),
    ['issued', 'issued'],
  )
  assert.equal(
    issueCashProspectiveV2(fixture.inputs, { ...common, now: at('2026-10-05T13:15:00.000Z') })
      .issues.length,
    2,
  )
  for (const subject of CASH_V2_POLICY.subjects)
    fixture.push(subject.id, 3, '2026-10-06T13:00:00.000Z', '2026-10-06T13:10:00.000Z', '1010')
  const scored = scoreCashProspectiveV2(fixture.inputs, {
    ...common,
    now: at('2026-10-06T13:15:00.000Z'),
  })
  assert.equal(scored.scores.length, 0)
  const beforeMaturity = evaluateCashProspectiveV2(fixture.inputs, {
    ...common,
    now: at('2026-10-06T13:15:00.000Z'),
  })
  assert.ok(
    beforeMaturity.subjects.every(
      (row) =>
        row.independentObserved === 0 &&
        row.outcomeAvailabilityPercent === 0 &&
        !row.prospectiveValidated,
    ),
  )
  const matureScored = scoreCashProspectiveV2(fixture.inputs, {
    ...common,
    now: at('2026-10-06T16:04:00.000Z'),
  })
  assert.ok(
    matureScored.scores.every(
      (row) => row.payload.status === 'observed' && row.payload.outcome.covered,
    ),
  )
  assert.equal(
    scoreCashProspectiveV2(fixture.inputs, { ...common, now: at('2026-10-06T13:15:00.000Z') })
      .scores.length,
    0,
  )
  const state = verifyCashProspectiveV2Ledger(fixture.inputs, fixture.root)
  assert.deepEqual(
    [state.artifacts.size, state.ticks.length, state.issues.length, state.scores.length],
    [2, 1, 2, 2],
  )
  const maturedEvaluation = evaluateCashProspectiveV2(fixture.inputs, {
    ...common,
    now: at('2026-10-06T16:04:00.000Z'),
  })
  assert.ok(
    maturedEvaluation.subjects.every(
      (row) =>
        row.outcomeAvailabilityPercent === 100 &&
        row.independentObserved === 1 &&
        !row.prospectiveValidated &&
        !row.holderExecutableExit,
    ),
  )
})

test('refuses retrospective or pre-cutover sources and detects a changed source cash identity', () => {
  const fixture = setup()
  const common = { root: fixture.root, minFreeBytes: 0 }
  registerCashProspectiveV2(fixture.inputs, fixture.development, {
    ...common,
    now: at('2026-10-05T12:07:00.000Z'),
  })
  const sgho = CASH_V2_POLICY.subjects[1]
  const frozen = fixture.inputs.frozen.verified
  const old = receipt(
    sgho,
    fixture.inputs.frozen.manifest.sha256,
    2,
    '2026-10-05T12:06:00.000Z',
    '2026-10-05T13:08:00.000Z',
    '1000',
    'retrospective',
  )
  frozen.records.push(old)
  frozen.count++
  frozen.last = old
  fixture.push('sgho', 3, '2026-10-05T13:03:00.000Z', '2026-10-05T13:08:00.000Z', '1000')
  tickCashProspectiveV2(fixture.inputs, { ...common, now: at('2026-10-05T13:15:00.000Z') })
  assert.equal(
    issueCashProspectiveV2(fixture.inputs, { ...common, now: at('2026-10-05T13:15:00.000Z') })
      .issues.length,
    1,
  )
  frozen.records[2].rows[0].cashRaw = '999'
  assert.throws(
    () => verifyCashProspectiveV2Ledger(fixture.inputs, fixture.root),
    /opportunity_invalid/,
  )
})

test('records missed hourly slots and explicit target-window censoring', () => {
  const fixture = setup()
  const common = { root: fixture.root, minFreeBytes: 0 }
  registerCashProspectiveV2(fixture.inputs, fixture.development, {
    ...common,
    now: at('2026-10-05T12:07:00.000Z'),
  })
  fixture.push('aave_usde', 2, '2026-10-05T13:03:00.000Z', '2026-10-05T13:08:00.000Z', '1000')
  tickCashProspectiveV2(fixture.inputs, { ...common, now: at('2026-10-05T13:15:00.000Z') })
  issueCashProspectiveV2(fixture.inputs, { ...common, now: at('2026-10-05T13:15:00.000Z') })
  assert.equal(
    scoreCashProspectiveV2(fixture.inputs, { ...common, now: at('2026-10-06T16:03:00.000Z') })
      .scores.length,
    0,
  )
  const censored = scoreCashProspectiveV2(fixture.inputs, {
    ...common,
    now: at('2026-10-06T16:04:00.000Z'),
  })
  assert.equal(censored.scores[0].payload.status, 'censored')
  assert.equal(censored.scores[0].payload.reason, 'target_window_unobserved')
  const ticks = tickCashProspectiveV2(fixture.inputs, {
    ...common,
    now: at('2026-10-06T17:15:00.000Z'),
  }).ticks
  assert.equal(ticks.at(-1).payload.status, 'on_time')
  assert.ok(ticks.slice(0, -1).every((row) => row.payload.status === 'missed'))
})

test('rejects local record tampering even when JSON remains parseable', () => {
  const fixture = setup()
  registerCashProspectiveV2(fixture.inputs, fixture.development, {
    root: fixture.root,
    minFreeBytes: 0,
    now: at('2026-10-05T12:07:00.000Z'),
  })
  const path = join(fixture.root, '000000000001.json')
  const record = JSON.parse(readFileSync(path, 'utf8'))
  record.payload.subject.destination = CASH_V2_POLICY.subjects[1].destination
  writeFileSync(path, `${JSON.stringify(record)}\n`)
  assert.throws(() => verifyCashProspectiveV2Ledger(fixture.inputs, fixture.root), /chain_invalid/)
})

test('selects nearest H24 target after grace, with the earlier time winning a tie', () => {
  const fixture = setup()
  const common = { root: fixture.root, minFreeBytes: 0 }
  registerCashProspectiveV2(fixture.inputs, fixture.development, {
    ...common,
    now: at('2026-10-05T12:07:00.000Z'),
  })
  fixture.push('aave_usde', 2, '2026-10-05T13:03:00.000Z', '2026-10-05T13:08:00.000Z', '1000')
  tickCashProspectiveV2(fixture.inputs, { ...common, now: at('2026-10-05T13:15:00.000Z') })
  fixture.push('aave_usde', 3, '2026-10-06T12:03:00.000Z', '2026-10-06T12:08:00.000Z', '990')
  fixture.push('aave_usde', 4, '2026-10-06T14:03:00.000Z', '2026-10-06T14:08:00.000Z', '1050')
  assert.equal(
    scoreCashProspectiveV2(fixture.inputs, { ...common, now: at('2026-10-06T16:03:00.000Z') })
      .scores.length,
    0,
  )
  const tied = scoreCashProspectiveV2(fixture.inputs, {
    ...common,
    now: at('2026-10-06T16:04:00.000Z'),
  }).scores[0]
  assert.equal(tied.payload.target.sourceAtUtc, '2026-10-06T12:03:00.000Z')

  const exact = setup()
  const exactCommon = { root: exact.root, minFreeBytes: 0 }
  registerCashProspectiveV2(exact.inputs, exact.development, {
    ...exactCommon,
    now: at('2026-10-05T12:07:00.000Z'),
  })
  exact.push('aave_usde', 2, '2026-10-05T13:03:00.000Z', '2026-10-05T13:08:00.000Z', '1000')
  tickCashProspectiveV2(exact.inputs, { ...exactCommon, now: at('2026-10-05T13:15:00.000Z') })
  exact.push('aave_usde', 3, '2026-10-06T12:03:00.000Z', '2026-10-06T12:08:00.000Z', '990')
  exact.push('aave_usde', 4, '2026-10-06T13:03:00.000Z', '2026-10-06T13:08:00.000Z', '1010')
  exact.push('aave_usde', 5, '2026-10-06T14:03:00.000Z', '2026-10-06T14:08:00.000Z', '1050')
  const chosen = scoreCashProspectiveV2(exact.inputs, {
    ...exactCommon,
    now: at('2026-10-06T16:04:00.000Z'),
  }).scores[0]
  assert.equal(chosen.payload.target.sourceAtUtc, '2026-10-06T13:03:00.000Z')

  const boundary = setup()
  const boundaryCommon = { root: boundary.root, minFreeBytes: 0 }
  registerCashProspectiveV2(boundary.inputs, boundary.development, {
    ...boundaryCommon,
    now: at('2026-10-05T12:07:00.000Z'),
  })
  boundary.push('aave_usde', 2, '2026-10-05T13:03:00.000Z', '2026-10-05T13:08:00.000Z', '1000')
  tickCashProspectiveV2(boundary.inputs, { ...boundaryCommon, now: at('2026-10-05T13:15:00.000Z') })
  boundary.push('aave_usde', 3, '2026-10-06T14:03:00.000Z', '2026-10-06T16:03:00.000Z', '1050')
  const atGrace = scoreCashProspectiveV2(boundary.inputs, {
    ...boundaryCommon,
    now: at('2026-10-06T16:03:00.000Z'),
  })
  assert.equal(atGrace.scores.length, 0)
  const upper = scoreCashProspectiveV2(boundary.inputs, {
    ...boundaryCommon,
    now: at('2026-10-06T16:03:00.001Z'),
  }).scores[0]
  assert.equal(upper.payload.target.sourceAtUtc, '2026-10-06T14:03:00.000Z')
})

test('head rejects root and tail deletion and repairs only a valid committed-prefix crash suffix', () => {
  const rootGone = setup()
  registerCashProspectiveV2(rootGone.inputs, rootGone.development, {
    root: rootGone.root,
    minFreeBytes: 0,
    now: at('2026-10-05T12:07:00.000Z'),
  })
  rmSync(rootGone.root, { recursive: true })
  assert.throws(() => verifyCashProspectiveV2Ledger(rootGone.inputs, rootGone.root), /head_ahead/)

  const tailGone = setup()
  registerCashProspectiveV2(tailGone.inputs, tailGone.development, {
    root: tailGone.root,
    minFreeBytes: 0,
    now: at('2026-10-05T12:07:00.000Z'),
  })
  unlinkSync(join(tailGone.root, '000000000003.json'))
  assert.throws(() => verifyCashProspectiveV2Ledger(tailGone.inputs, tailGone.root), /head_ahead/)

  const crashed = setup()
  registerCashProspectiveV2(crashed.inputs, crashed.development, {
    root: crashed.root,
    minFreeBytes: 0,
    now: at('2026-10-05T12:07:00.000Z'),
  })
  const second = JSON.parse(readFileSync(join(crashed.root, '000000000002.json'), 'utf8'))
  writeFileSync(
    `${crashed.root}.head.json`,
    `${JSON.stringify({
      study: 'carry-cash-prospective-h24-v2',
      sequence: 2,
      sha256: second.sha256,
    })}\n`,
  )
  const recovered = verifyCashProspectiveV2Ledger(crashed.inputs, crashed.root)
  assert.equal(recovered.records.length, 3)
  assert.equal(JSON.parse(readFileSync(`${crashed.root}.head.json`, 'utf8')).sequence, 3)
})

test('read-only verification refuses a valid lagging head without changing its bytes or mtime', () => {
  const fixture = setup()
  registerCashProspectiveV2(fixture.inputs, fixture.development, {
    root: fixture.root,
    minFreeBytes: 0,
    now: at('2026-10-05T12:07:00.000Z'),
  })
  const second = JSON.parse(readFileSync(join(fixture.root, '000000000002.json'), 'utf8'))
  const path = `${fixture.root}.head.json`
  writeFileSync(
    path,
    `${JSON.stringify({
      study: 'carry-cash-prospective-h24-v2',
      sequence: 2,
      sha256: second.sha256,
    })}\n`,
  )
  const beforeBytes = readFileSync(path)
  const beforeMtimeNs = statSync(path, { bigint: true }).mtimeNs
  assert.throws(
    () => verifyCashProspectiveV2Ledger(fixture.inputs, fixture.root, { recoverHead: false }),
    (error) =>
      error instanceof CashProspectiveV2LedgerError &&
      error.code === 'cash_v2_head_lag_recovery_required',
  )
  assert.deepEqual(readFileSync(path), beforeBytes)
  assert.equal(statSync(path, { bigint: true }).mtimeNs, beforeMtimeNs)
})

test('orphan temp and existing lock fail closed without consuming the lock', () => {
  const fixture = setup()
  const common = { root: fixture.root, minFreeBytes: 0 }
  registerCashProspectiveV2(fixture.inputs, fixture.development, {
    ...common,
    now: at('2026-10-05T12:07:00.000Z'),
  })
  const orphan = `${fixture.root}.pending.orphan.tmp`
  writeFileSync(orphan, 'incomplete')
  assert.throws(
    () => verifyCashProspectiveV2Ledger(fixture.inputs, fixture.root),
    /orphan_temp_manual_inspection_required/,
  )
  unlinkSync(orphan)
  const lock = `${fixture.root}.lock`
  mkdirSync(lock)
  assert.throws(
    () => tickCashProspectiveV2(fixture.inputs, { ...common, now: at('2026-10-05T13:15:00.000Z') }),
    /lock_manual_inspection_required/,
  )
  assert.ok(existsSync(lock))
  rmSync(lock, { recursive: true })
  assert.equal(
    tickCashProspectiveV2(fixture.inputs, { ...common, now: at('2026-10-05T13:15:00.000Z') }).ticks
      .length,
    1,
  )
})

test('records each subject source outage at on-time ticks and exposes the availability gate', () => {
  const fixture = setup()
  const common = { root: fixture.root, minFreeBytes: 0 }
  registerCashProspectiveV2(fixture.inputs, fixture.development, {
    ...common,
    now: at('2026-10-05T12:07:00.000Z'),
  })
  const tick = tickCashProspectiveV2(fixture.inputs, {
    ...common,
    now: at('2026-10-05T13:30:00.000Z'),
  }).ticks[0]
  assert.deepEqual(
    tick.payload.opportunities.map((row) => row.status),
    ['source_unavailable', 'source_unavailable'],
  )
  const evaluation = evaluateCashProspectiveV2(fixture.inputs, {
    ...common,
    now: at('2026-10-05T13:30:00.000Z'),
  })
  assert.ok(
    evaluation.subjects.every(
      (row) =>
        row.dueOpportunities === 1 &&
        row.sourceAvailabilityPercent === 0 &&
        !row.prospectiveValidated,
    ),
  )
  const late = setup()
  registerCashProspectiveV2(late.inputs, late.development, {
    root: late.root,
    minFreeBytes: 0,
    now: at('2026-10-05T12:07:00.000Z'),
  })
  const missed = tickCashProspectiveV2(late.inputs, {
    root: late.root,
    minFreeBytes: 0,
    now: at('2026-10-05T13:30:00.001Z'),
  }).ticks[0]
  assert.equal(missed.payload.status, 'missed')
  assert.deepEqual(missed.payload.opportunities, [])
})

test('registration retry preserves the first activation clock and source cutoffs after a partial crash', () => {
  const fixture = setup()
  const common = { root: fixture.root, minFreeBytes: 0 }
  registerCashProspectiveV2(fixture.inputs, fixture.development, {
    ...common,
    now: at('2026-10-05T12:07:00.000Z'),
  })
  const first = JSON.parse(readFileSync(join(fixture.root, '000000000001.json'), 'utf8'))
  unlinkSync(join(fixture.root, '000000000003.json'))
  unlinkSync(join(fixture.root, '000000000002.json'))
  writeFileSync(
    `${fixture.root}.head.json`,
    `${JSON.stringify({
      study: 'carry-cash-prospective-h24-v2',
      sequence: 1,
      sha256: first.sha256,
    })}\n`,
  )
  fixture.push('aave_usde', 2, '2026-10-05T12:50:00.000Z', '2026-10-05T12:55:00.000Z', '1200')
  fixture.push('sgho', 2, '2026-10-05T12:50:00.000Z', '2026-10-05T12:55:00.000Z', '1200')
  const retried = registerCashProspectiveV2(fixture.inputs, fixture.development, {
    ...common,
    now: at('2026-10-05T13:00:00.000Z'),
  })
  assert.equal(retried.enrollment.recordedAtUtc, '2026-10-05T12:07:00.000Z')
  assert.deepEqual(
    retried.enrollment.payload.subjects.map((row) => row.cutoff.sequence),
    [1, 1],
  )
  const state = verifyCashProspectiveV2Ledger(fixture.inputs, fixture.root)
  assert.deepEqual(
    state.records.map((row) => row.recordedAtUtc),
    Array(3).fill('2026-10-05T12:07:00.000Z'),
  )
})

test('no_code cash rows are unavailable while later observed rows remain eligible', () => {
  const fixture = setup()
  const common = { root: fixture.root, minFreeBytes: 0 }
  registerCashProspectiveV2(fixture.inputs, fixture.development, {
    ...common,
    now: at('2026-10-05T12:07:00.000Z'),
  })
  const subject = CASH_V2_POLICY.subjects[0]
  const ledger = fixture.inputs.supplemental.verified
  const unavailable = receipt(
    subject,
    fixture.inputs.supplemental.manifest.sha256,
    2,
    '2026-10-05T13:01:00.000Z',
    '2026-10-05T13:05:00.000Z',
    null,
  )
  markUnavailable(unavailable.rows[0], 'no_code', 'market_or_asset_not_deployed')
  ledger.records.push(unavailable)
  ledger.count++
  ledger.last = unavailable
  const first = tickCashProspectiveV2(fixture.inputs, {
    ...common,
    now: at('2026-10-05T13:15:00.000Z'),
  }).ticks[0]
  assert.equal(first.payload.opportunities[0].status, 'source_unavailable')
  assert.equal(verifyCashProspectiveV2Ledger(fixture.inputs, fixture.root).issues.length, 0)
  fixture.push('aave_usde', 3, '2026-10-05T14:03:00.000Z', '2026-10-05T14:08:00.000Z', '1000')
  const second = tickCashProspectiveV2(fixture.inputs, {
    ...common,
    now: at('2026-10-05T14:15:00.000Z'),
  }).ticks[0]
  assert.equal(second.payload.opportunities[0].status, 'issued')
  assert.equal(second.payload.opportunities[0].issue.source.sequence, 3)
  assert.equal(verifyCashProspectiveV2Ledger(fixture.inputs, fixture.root).issues.length, 1)
  unavailable.rows[0].asset = CASH_V2_POLICY.subjects[1].asset
  assert.throws(
    () => verifyCashProspectiveV2Ledger(fixture.inputs, fixture.root),
    /subject_unavailable_shape/,
  )

  const sameTick = setup()
  const sameCommon = { root: sameTick.root, minFreeBytes: 0 }
  registerCashProspectiveV2(sameTick.inputs, sameTick.development, {
    ...sameCommon,
    now: at('2026-10-05T12:07:00.000Z'),
  })
  const sameLedger = sameTick.inputs.supplemental.verified
  const noCode = receipt(
    subject,
    sameTick.inputs.supplemental.manifest.sha256,
    2,
    '2026-10-05T13:01:00.000Z',
    '2026-10-05T13:05:00.000Z',
    null,
  )
  markUnavailable(noCode.rows[0], 'no_code', 'market_or_asset_not_deployed')
  sameLedger.records.push(noCode)
  sameLedger.count++
  sameLedger.last = noCode
  sameTick.push('aave_usde', 3, '2026-10-05T13:06:00.000Z', '2026-10-05T13:10:00.000Z', '1000')
  const bundled = tickCashProspectiveV2(sameTick.inputs, {
    ...sameCommon,
    now: at('2026-10-05T13:15:00.000Z'),
  }).ticks[0]
  assert.equal(bundled.payload.opportunities[0].issue.source.sequence, 3)
  assert.equal(
    verifyCashProspectiveV2Ledger(sameTick.inputs, sameTick.root).issues[0].payload.source.sequence,
    3,
  )
})

test('frozen unassessed is skipped, while identity_mismatch fails closed', () => {
  const fixture = setup()
  const common = { root: fixture.root, minFreeBytes: 0 }
  registerCashProspectiveV2(fixture.inputs, fixture.development, {
    ...common,
    now: at('2026-10-05T12:07:00.000Z'),
  })
  const subject = CASH_V2_POLICY.subjects[1]
  const frozen = fixture.inputs.frozen.verified
  const unassessed = receipt(
    subject,
    fixture.inputs.frozen.manifest.sha256,
    2,
    '2026-10-05T13:01:00.000Z',
    '2026-10-05T13:05:00.000Z',
    null,
  )
  markUnavailable(unassessed.rows[0], 'unassessed', 'subject_unassessed')
  frozen.records.push(unassessed)
  frozen.count++
  frozen.last = unassessed
  fixture.push('sgho', 3, '2026-10-05T13:06:00.000Z', '2026-10-05T13:10:00.000Z', '1000')
  const tick = tickCashProspectiveV2(fixture.inputs, {
    ...common,
    now: at('2026-10-05T13:15:00.000Z'),
  }).ticks[0]
  assert.equal(tick.payload.opportunities[1].issue.source.sequence, 3)
  assert.equal(
    verifyCashProspectiveV2Ledger(fixture.inputs, fixture.root).issues[0].payload.source.sequence,
    3,
  )
  markUnavailable(unassessed.rows[0], 'identity_mismatch', 'pinned_expected_asset_mismatch')
  assert.throws(
    () => verifyCashProspectiveV2Ledger(fixture.inputs, fixture.root),
    /subject_cash_identity/,
  )

  const invalid = setup()
  registerCashProspectiveV2(invalid.inputs, invalid.development, {
    root: invalid.root,
    minFreeBytes: 0,
    now: at('2026-10-05T12:07:00.000Z'),
  })
  const wrong = receipt(
    subject,
    invalid.inputs.frozen.manifest.sha256,
    2,
    '2026-10-05T13:01:00.000Z',
    '2026-10-05T13:05:00.000Z',
    null,
  )
  markUnavailable(wrong.rows[0], 'identity_mismatch', 'pinned_expected_asset_mismatch')
  invalid.inputs.frozen.verified.records.push(wrong)
  invalid.inputs.frozen.verified.count++
  invalid.inputs.frozen.verified.last = wrong
  assert.throws(
    () =>
      tickCashProspectiveV2(invalid.inputs, {
        root: invalid.root,
        minFreeBytes: 0,
        now: at('2026-10-05T13:15:00.000Z'),
      }),
    /subject_cash_identity/,
  )
})

test('virgin scoring is a read-only no-op but committed-head deletion still fails closed', () => {
  const fixture = setup()
  assert.deepEqual(scoreCashProspectiveV2(fixture.inputs, { root: fixture.root }), {
    status: 'not_enrolled',
    scores: [],
  })
  assert.equal(existsSync(fixture.root), false)
  registerCashProspectiveV2(fixture.inputs, fixture.development, {
    root: fixture.root,
    minFreeBytes: 0,
    now: at('2026-10-05T12:07:00.000Z'),
  })
  rmSync(fixture.root, { recursive: true })
  assert.throws(() => scoreCashProspectiveV2(fixture.inputs, { root: fixture.root }), /head_ahead/)
})
