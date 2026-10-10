import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { collectAnchor } from '../backfill-carry-cash-archive.mjs'
import { buildSubjectManifest } from '../record-carry-cash-issues.mjs'
import { appendLocalCarryCash, verifyLocalCarryCash } from './localCarryCashStore.mjs'
import {
  issueLocalCash,
  scoreLocalCash,
  verifyLocalCashIssueLedger,
} from './localCarryCashIssueStore.mjs'
import {
  buildLocalCashModelPlan,
  buildLocalCashModelScorecard,
  issueLocalCashModels,
  readLocalCarryCashModelEvidence,
  registerLocalCashModels,
  scoreLocalCashModels,
  verifyLocalCarryCashModelLedger,
  verifyLocalCarryCashModelLedgerFromVerified,
} from './localCarryCashModelStore.mjs'

const DAY = 86_400_000
const START = Date.parse('2026-06-01T00:00:00.000Z')
const TWYNE = '0x0af56afbddcb140323445bd7211ba90e54e5fd1c'

const block = (at, number) => ({
  number: BigInt(number),
  hash: `0x${createHash('sha256').update(String(number)).digest('hex')}`,
  timestamp: BigInt(Date.parse(at) / 1000),
  at,
})

async function fixture(retrospectiveTarget = null) {
  const manifest = await buildSubjectManifest()
  const assets = new Map(manifest.subjects.map((subject) => [subject.destination, subject.asset]))
  const cashRoot = mkdtempSync(join(tmpdir(), 'cash-model-cash-'))
  const baselineRoot = mkdtempSync(join(tmpdir(), 'cash-model-baseline-'))
  const modelRoot = mkdtempSync(join(tmpdir(), 'cash-model-ledger-'))
  async function capture({ at, number, cashRaw, collectionMode, receiptAt }) {
    const header = block(at, number)
    const rows = await collectAnchor({}, at, header, manifest, {
      readVaultCash: async (_, vault) =>
        vault === TWYNE
          ? { state: 'unassessed', reason: 'twyne_wrapped_atoken_cash_unassessed' }
          : {
              state: 'observed',
              reason: null,
              asset: assets.get(vault),
              shareDecimals: 18,
              assetDecimals: 6,
              cashRaw,
            },
      readDirectCash: async (_, market) => ({
        state: 'observed',
        reason: null,
        asset: market.underlying.toLowerCase(),
        shareDecimals: market.decimals,
        assetDecimals: market.decimals,
        cashRaw,
      }),
    })
    return appendLocalCarryCash(
      {
        collectionMode,
        anchorAt: at,
        block: header,
        rows,
        firstLocalReceiptAt: receiptAt,
      },
      manifest,
      cashRoot,
    )
  }
  for (let index = 0; index < 120; index++) {
    const at = new Date(START + index * DAY).toISOString()
    const cashRaw =
      index % 2 === 0 ? '1000' : (retrospectiveTarget?.(Math.floor(index / 2)) ?? 1_010n).toString()
    await capture({
      at,
      number: 25_000_000 + index,
      cashRaw,
      collectionMode: 'retrospective',
      receiptAt: '2026-09-30T21:00:00.000Z',
    })
  }
  return { manifest, cashRoot, baselineRoot, modelRoot, capture }
}

async function lifecycle() {
  const f = await fixture()
  await f.capture({
    at: '2026-09-30T22:00:00.000Z',
    number: 26_000_000,
    cashRaw: '2000',
    collectionMode: 'current',
    receiptAt: '2026-09-30T22:01:00.000Z',
  })
  issueLocalCash(f.manifest, f.cashRoot, f.baselineRoot, '2026-09-30T22:05:00.000Z')
  const staleLock = `${f.modelRoot}.lock`
  const liveOwner = {
    pid: process.pid,
    token: '00000000-0000-4000-8000-000000000000',
    processStartSource: 'unverified',
    processStartIdentity: `${process.pid}:test-fallback`,
    createdAt: new Date(Date.now() - 8 * 60 * 60_000).toISOString(),
  }
  writeFileSync(staleLock, `${JSON.stringify(liveOwner)}\n`)
  const oldLiveAt = new Date(Date.now() - 8 * 60 * 60_000)
  utimesSync(staleLock, oldLiveAt, oldLiveAt)
  assert.throws(
    () =>
      registerLocalCashModels(
        f.manifest,
        f.cashRoot,
        f.baselineRoot,
        f.modelRoot,
        '2026-09-30T22:06:00.000Z',
      ),
    /lock_busy/,
  )
  assert.equal(readFileSync(staleLock, 'utf8'), `${JSON.stringify(liveOwner)}\n`)
  rmSync(staleLock)
  mkdirSync(staleLock)
  const staleAt = new Date(Date.now() - 2 * 60_000)
  utimesSync(staleLock, staleAt, staleAt)
  const registration = registerLocalCashModels(
    f.manifest,
    f.cashRoot,
    f.baselineRoot,
    f.modelRoot,
    '2026-09-30T22:06:00.000Z',
  )
  await f.capture({
    at: '2026-09-30T23:00:00.000Z',
    number: 26_000_100,
    cashRaw: '2020',
    collectionMode: 'current',
    receiptAt: '2026-09-30T23:01:00.000Z',
  })
  issueLocalCash(f.manifest, f.cashRoot, f.baselineRoot, '2026-09-30T23:05:00.000Z')
  const issued = issueLocalCashModels(
    f.manifest,
    f.cashRoot,
    f.baselineRoot,
    f.modelRoot,
    '2026-09-30T23:06:00.000Z',
  )
  return { ...f, registration, issued }
}

let sharedLifecyclePromise
const sharedLifecycle = () => (sharedLifecyclePromise ??= lifecycle())

after(async () => {
  if (!sharedLifecyclePromise) return
  const fixture = await sharedLifecyclePromise.catch(() => null)
  if (!fixture) return
  for (const root of [fixture.cashRoot, fixture.baselineRoot, fixture.modelRoot])
    rmSync(root, { recursive: true, force: true })
})

test('registers receipt-bound v4 H24 artifacts and typed H1 abstentions', async () => {
  const f = await sharedLifecycle()
  assert.deepEqual(f.registration.byHorizon, [
    { horizonHours: 1, enrolled: 0, abstained: 67 },
    { horizonHours: 24, enrolled: 66, abstained: 1 },
  ])
  assert.equal(f.registration.artifactsRegistered, 66)
  assert.equal(f.issued.processed, 1)
  assert.equal(f.issued.issued, 66)
  assert.equal(f.issued.abstained, 68)

  const ledger = verifyLocalCarryCashModelLedger(
    f.manifest,
    f.cashRoot,
    f.baselineRoot,
    f.modelRoot,
  )
  assert.equal(ledger.artifacts.size, 66)
  assert.equal(ledger.enrollments.length, 1)
  assert.equal(ledger.ticks.length, 1)
  assert.equal(ledger.ticks[0].content.status, 'on_time')
  assert.equal(ledger.issues.length, 1)
  assert.equal(ledger.issues[0].content.baselineIssueSequence, 2)
  assert.equal(ledger.enrollments[0].content.qualificationPolicy, 'untouched_holdout_v1')
  assert.equal(ledger.issues[0].content.qualificationPolicy, 'untouched_holdout_v1')
  assert.ok(
    ledger.issues[0].content.attempts
      .filter((row) => row.status === 'issued')
      .every(
        (row) =>
          Date.parse(ledger.issues[0].content.issuedAt) < Date.parse(row.targetLowAt) &&
          Date.parse(row.targetLowAt) < Date.parse(row.targetAt) &&
          Date.parse(row.targetAt) < Date.parse(row.targetHighAt),
      ),
  )
  assert.ok(
    [...ledger.artifacts.values()].every(
      (record) =>
        record.content.pairs.length === 60 &&
        record.content.pairs.every((pair) => pair.sourceReceiptSha256 && pair.targetReceiptSha256),
    ),
  )
  assert.equal(
    registerLocalCashModels(
      f.manifest,
      f.cashRoot,
      f.baselineRoot,
      f.modelRoot,
      '2026-09-30T23:07:00.000Z',
    ).status,
    'already_recorded',
  )
})

test('withholds persistence enrollment after selection passes but untouched holdout fails', async () => {
  const f = await fixture((pair) => {
    if (pair === 20 || (pair >= 40 && pair < 50)) return 1_000n
    if (pair >= 50) return 1_020n
    return 1_010n
  })
  try {
    const cash = verifyLocalCarryCash(f.manifest, f.cashRoot)
    const plan = buildLocalCashModelPlan(f.manifest, cash.records, '2026-09-30T22:06:00.000Z')
    const untouchedFailures = plan.cells.filter(
      (cell) => cell.horizonHours === 24 && cell.reason === 'untouched_holdout_failed',
    )
    assert.equal(untouchedFailures.length, 66)
    assert.equal(plan.cells.filter((cell) => cell.status === 'enrolled').length, 0)
    assert.equal(plan.artifacts.length, 0)

    const learnedPointFailureRecords = cash.records.map((record, index) => {
      const pair = Math.floor(index / 2)
      const target = pair === 20 || pair >= 50 ? '1000' : '1010'
      return index % 2 === 0
        ? record
        : {
            ...record,
            rows: record.rows.map((row) =>
              row.state === 'observed' ? { ...row, cashRaw: target } : row,
            ),
          }
    })
    const learnedPointPlan = buildLocalCashModelPlan(
      f.manifest,
      learnedPointFailureRecords,
      '2026-09-30T22:06:00.000Z',
    )
    assert.equal(
      learnedPointPlan.cells.filter(
        (cell) => cell.horizonHours === 24 && cell.reason === 'untouched_holdout_failed',
      ).length,
      66,
    )
    assert.equal(learnedPointPlan.artifacts.length, 0)
  } finally {
    for (const root of [f.cashRoot, f.baselineRoot, f.modelRoot])
      rmSync(root, { recursive: true, force: true })
  }
})

test('training excludes receipts that were not locally available by registration time', async () => {
  const f = await sharedLifecycle()
  const cash = verifyLocalCarryCash(f.manifest, f.cashRoot)
  const beforeReceipt = buildLocalCashModelPlan(
    f.manifest,
    cash.records,
    '2026-09-30T20:59:59.999Z',
  )
  assert.equal(beforeReceipt.artifacts.length, 0)
  assert.ok(beforeReceipt.cells.every((cell) => cell.status === 'abstained'))
})

test('later enrollment cannot move the original prospective cutover', async () => {
  const f = await sharedLifecycle()
  const copy = mkdtempSync(join(tmpdir(), 'cash-model-cutover-'))
  try {
    cpSync(f.modelRoot, copy, { recursive: true })
    const ledger = verifyLocalCarryCashModelLedger(f.manifest, f.cashRoot, f.baselineRoot, copy)
    const original = ledger.enrollments[0]
    const recordedAt = '2026-09-30T23:07:00.000Z'
    const content = {
      ...structuredClone(original.content),
      plannedAt: recordedAt,
      baselineCutoverSequence: original.content.baselineCutoverSequence + 1,
      baselineCutoverSha256:
        ledger.baseline.records[original.content.baselineCutoverSequence].sha256,
    }
    const body = {
      study: original.study,
      schemaVersion: 4,
      sequence: ledger.count + 1,
      previousSha256: ledger.last.sha256,
      manifestSha256: f.manifest.sha256,
      kind: 'enrollment',
      recordedAt,
      contentSha256: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
      content,
    }
    const record = {
      ...body,
      sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    }
    writeFileSync(
      join(copy, `${String(record.sequence).padStart(12, '0')}.json`),
      `${JSON.stringify(record)}\n`,
    )
    assert.throws(
      () => verifyLocalCarryCashModelLedger(f.manifest, f.cashRoot, f.baselineRoot, copy),
      /cutover_changed/,
    )
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
})

test('a model issue canonically moved into its target window fails replay', async () => {
  const f = await sharedLifecycle()
  const copy = mkdtempSync(join(tmpdir(), 'cash-model-late-'))
  try {
    cpSync(f.modelRoot, copy, { recursive: true })
    const ledger = verifyLocalCarryCashModelLedger(f.manifest, f.cashRoot, f.baselineRoot, copy)
    const issue = structuredClone(ledger.issues[0])
    issue.recordedAt = issue.content.attempts.find((row) => row.status === 'issued').targetLowAt
    issue.content.issuedAt = issue.recordedAt
    issue.contentSha256 = createHash('sha256').update(JSON.stringify(issue.content)).digest('hex')
    const { sha256: ignored, ...body } = issue
    void ignored
    issue.sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    const issuePath = join(copy, `${String(issue.sequence).padStart(12, '0')}.json`)
    writeFileSync(issuePath, `${JSON.stringify(issue)}\n`)
    assert.throws(
      () => verifyLocalCarryCashModelLedger(f.manifest, f.cashRoot, f.baselineRoot, copy),
      /issue_replay|chain_identity/,
    )
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
})

test('reads only a still-future prospective issue and never models the cutover baseline', async () => {
  const f = await sharedLifecycle()
  const ledger = verifyLocalCarryCashModelLedger(
    f.manifest,
    f.cashRoot,
    f.baselineRoot,
    f.modelRoot,
  )
  const artifact = [...ledger.artifacts.values()][0].content
  const question = {
    routeKey: artifact.routeKey,
    destination: artifact.destination,
    asset: artifact.asset,
    horizonHours: 24,
  }
  const evidence = readLocalCarryCashModelEvidence(ledger, question, '2026-09-30T23:10:00.000Z')
  assert.match(evidence.status, /historical_projection/)
  assert.equal(evidence.claim, 'aggregate_cash_proxy_only')
  assert.equal(evidence.projection.pointRaw, '2030')
  assert.equal(evidence.projection.targetAt, '2026-10-01T23:05:00.000Z')
  assert.deepEqual(evidence.backtest, {
    fit: 20,
    calibration: 20,
    selection: 10,
    selectionCovered: 10,
    selectionCoveragePassed: true,
    holdout: 10,
    holdoutCovered: 10,
    holdoutCoveragePassed: true,
    holdoutPointBeatsPersistence: true,
    holdoutModelMae: { numeratorRaw: '0', denominator: 10 },
    holdoutPersistenceMae: { numeratorRaw: '100', denominator: 10 },
  })
  assert.equal(
    readLocalCarryCashModelEvidence(ledger, question, '2026-10-02T00:00:00.000Z').reason,
    'no_current_issue',
  )
  assert.equal(ledger.issues[0].content.baselineIssueSequence, 2)
})

test('reader withholds an enrolled artifact when its untouched evidence is unqualified', async () => {
  const f = await sharedLifecycle()
  const ledger = verifyLocalCarryCashModelLedger(
    f.manifest,
    f.cashRoot,
    f.baselineRoot,
    f.modelRoot,
  )
  const [artifactSha, artifactRecord] = [...ledger.artifacts].find(
    ([, record]) => record.content.modelKind === 'learned_delta',
  )
  const unqualified = structuredClone(artifactRecord)
  unqualified.content.untouchedTest.pointBeatsPersistence = false
  const artifacts = new Map(ledger.artifacts)
  artifacts.set(artifactSha, unqualified)
  const question = {
    routeKey: artifactRecord.content.routeKey,
    destination: artifactRecord.content.destination,
    asset: artifactRecord.content.asset,
    horizonHours: artifactRecord.content.horizonHours,
  }

  assert.deepEqual(
    readLocalCarryCashModelEvidence({ ...ledger, artifacts }, question, '2026-09-30T23:10:00.000Z'),
    {
      status: 'unavailable',
      reason: 'not_enrolled',
      detailReason: 'untouched_holdout_failed',
      prospective: null,
    },
  )
})

test('reader resolves equal issue timestamps by the newest source observation', async () => {
  const f = await sharedLifecycle()
  const ledger = verifyLocalCarryCashModelLedger(
    f.manifest,
    f.cashRoot,
    f.baselineRoot,
    f.modelRoot,
  )
  const artifact = [...ledger.artifacts.values()][0].content
  const question = {
    routeKey: artifact.routeKey,
    destination: artifact.destination,
    asset: artifact.asset,
    horizonHours: 24,
  }
  const newer = structuredClone(ledger.issues[0])
  newer.contentSha256 = createHash('sha256').update('newer-reader-issue').digest('hex')
  newer.content.baselineIssueSequence++
  const attempt = newer.content.attempts.find(
    (row) =>
      row.status === 'issued' &&
      row.routeKey === question.routeKey &&
      row.destination === question.destination &&
      row.horizonHours === question.horizonHours,
  )
  attempt.source.blockAt = '2026-09-30T23:01:00.000Z'
  attempt.forecast.pointRaw = '9999'
  const evidence = readLocalCarryCashModelEvidence(
    { ...ledger, issues: [...ledger.issues, newer] },
    question,
    '2026-09-30T23:10:00.000Z',
  )
  assert.equal(evidence.projection.pointRaw, '9999')
  assert.equal(evidence.projection.sourceBlockAt, '2026-09-30T23:01:00.000Z')
})

test('reuses already verified cash and baseline dependencies without rescanning their roots', async () => {
  const f = await sharedLifecycle()
  const dependencies = {
    cash: verifyLocalCarryCash(f.manifest, f.cashRoot),
    baseline: verifyLocalCashIssueLedger(f.manifest, f.cashRoot, f.baselineRoot),
  }
  const ledger = verifyLocalCarryCashModelLedgerFromVerified(f.manifest, dependencies, f.modelRoot)
  assert.equal(ledger.issues.length, 1)
  assert.equal(
    verifyLocalCarryCashModelLedger(
      f.manifest,
      '/definitely/not/a/cash/root',
      '/definitely/not/a/baseline/root',
      f.modelRoot,
      dependencies,
    ).count,
    ledger.count,
  )
  assert.throws(
    () =>
      verifyLocalCarryCashModelLedgerFromVerified(
        f.manifest,
        { ...dependencies, cash: { ...dependencies.cash, count: dependencies.cash.count + 1 } },
        f.modelRoot,
      ),
    /verified_dependency_identity/,
  )
})

test('a tick sealed under an older enrollment cannot wedge later issue runs', async () => {
  const f = await sharedLifecycle()
  const copy = mkdtempSync(join(tmpdir(), 'cash-model-reenroll-'))
  try {
    cpSync(f.modelRoot, copy, { recursive: true })
    const prior = verifyLocalCarryCashModelLedger(f.manifest, f.cashRoot, f.baselineRoot, copy)
    rmSync(join(copy, `${String(prior.issues[0].sequence).padStart(12, '0')}.json`))
    const tickOnly = verifyLocalCarryCashModelLedger(f.manifest, f.cashRoot, f.baselineRoot, copy)
    assert.equal(tickOnly.ticks.length, 1)
    assert.equal(tickOnly.issues.length, 0)

    await f.capture({
      at: '2026-09-29T00:00:00.000Z',
      number: 25_000_120,
      cashRaw: '1020',
      collectionMode: 'retrospective',
      receiptAt: '2026-09-30T23:07:00.000Z',
    })
    const registration = registerLocalCashModels(
      f.manifest,
      f.cashRoot,
      f.baselineRoot,
      copy,
      '2026-09-30T23:08:00.000Z',
    )
    assert.equal(registration.enrollmentRecorded, 1)
    const issue = issueLocalCashModels(
      f.manifest,
      f.cashRoot,
      f.baselineRoot,
      copy,
      '2026-09-30T23:09:00.000Z',
    )
    assert.equal(issue.processed, 0)
    assert.equal(
      verifyLocalCarryCashModelLedger(f.manifest, f.cashRoot, f.baselineRoot, copy).issues.length,
      0,
    )
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
})

test('links model outcome to the sealed persistence score and exact target receipt', async () => {
  const f = await sharedLifecycle()
  await f.capture({
    at: '2026-10-01T23:02:00.000Z',
    number: 26_010_000,
    cashRaw: '2030',
    collectionMode: 'current',
    receiptAt: '2026-10-01T23:03:00.000Z',
  })
  const scoreAt = '2026-10-02T01:06:00.000Z'
  scoreLocalCash(f.manifest, f.cashRoot, f.baselineRoot, scoreAt)
  const result = scoreLocalCashModels(f.manifest, f.cashRoot, f.baselineRoot, f.modelRoot, scoreAt)
  assert.equal(result.processed, 1)
  assert.equal(result.observed, 66)
  const ledger = verifyLocalCarryCashModelLedger(
    f.manifest,
    f.cashRoot,
    f.baselineRoot,
    f.modelRoot,
  )
  assert.equal(ledger.scores.length, 1)
  const row = ledger.scores[0].content.outcomes[0]
  assert.equal(row.status, 'observed')
  assert.equal(row.outcome.cashRaw, '2030')
  assert.equal(row.pointAbsoluteErrorRaw, '0')
  assert.equal(row.persistenceAbsoluteErrorRaw, '10')
  assert.match(row.outcome.receiptSha256, /^[0-9a-f]{64}$/)
  assert.equal(ledger.scorecard.bySubject[0].independentObserved, 1)
  assert.equal(ledger.scorecard.bySubject[0].prospectiveValidated, false)
})

test('canonically rehashed score tampering still fails deterministic replay', async () => {
  const f = await sharedLifecycle()
  await f.capture({
    at: '2026-10-01T23:02:00.000Z',
    number: 26_010_000,
    cashRaw: '2030',
    collectionMode: 'current',
    receiptAt: '2026-10-01T23:03:00.000Z',
  })
  const scoreAt = '2026-10-02T01:06:00.000Z'
  scoreLocalCash(f.manifest, f.cashRoot, f.baselineRoot, scoreAt)
  scoreLocalCashModels(f.manifest, f.cashRoot, f.baselineRoot, f.modelRoot, scoreAt)
  const ledger = verifyLocalCarryCashModelLedger(
    f.manifest,
    f.cashRoot,
    f.baselineRoot,
    f.modelRoot,
  )
  const path = join(f.modelRoot, `${String(ledger.count).padStart(12, '0')}.json`)
  const record = JSON.parse(readFileSync(path, 'utf8'))
  record.content.outcomes[0].bandCovered = !record.content.outcomes[0].bandCovered
  record.contentSha256 = createHash('sha256').update(JSON.stringify(record.content)).digest('hex')
  const { sha256: ignored, ...body } = record
  void ignored
  record.sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  writeFileSync(path, `${JSON.stringify(record)}\n`)
  assert.throws(
    () => verifyLocalCarryCashModelLedger(f.manifest, f.cashRoot, f.baselineRoot, f.modelRoot),
    /score_replay/,
  )
})

test('prospective scorecard uses greedy nonoverlapping outcomes for validation', () => {
  const artifact = 'a'.repeat(64)
  const enrollment = 'e'.repeat(64)
  const routeKey = 'route'
  const destination = `0x${'1'.repeat(40)}`
  const asset = `0x${'2'.repeat(40)}`
  const records = [
    {
      kind: 'artifact',
      contentSha256: artifact,
      recordedAt: new Date(START).toISOString(),
      content: {
        modelKind: 'learned_delta',
        untouchedTest: { coveragePassed: true, pointBeatsPersistence: true },
      },
    },
    {
      kind: 'enrollment',
      contentSha256: enrollment,
      recordedAt: new Date(START).toISOString(),
      content: {
        activatedAt: new Date(START).toISOString(),
        schedule: { firstSlotAt: new Date(START).toISOString() },
        cells: [
          {
            routeKey,
            destination,
            asset,
            horizonHours: 24,
            status: 'enrolled',
            artifactContentSha256: artifact,
          },
        ],
      },
    },
  ]
  for (let hour = 0; hour < 520; hour++) {
    const sourceMs = START + hour * 3_600_000
    const targetMs = sourceMs + DAY
    const slotAt = new Date(sourceMs).toISOString()
    const issueSha = createHash('sha256').update(`issue-${hour}`).digest('hex')
    records.push({
      kind: 'model_tick',
      recordedAt: new Date(sourceMs + 6 * 60_000).toISOString(),
      content: {
        enrollmentContentSha256: enrollment,
        slotAt,
        status: 'on_time',
      },
    })
    records.push({
      kind: 'model_issue',
      contentSha256: issueSha,
      recordedAt: new Date(sourceMs + 6 * 60_000).toISOString(),
      content: {
        enrollmentContentSha256: enrollment,
        baselineIssueSha256: createHash('sha256').update(`baseline-${hour}`).digest('hex'),
        baselineIssueSlotAt: slotAt,
        tickSlotAt: slotAt,
        attempts: [
          {
            status: 'issued',
            routeKey,
            destination,
            asset,
            horizonHours: 24,
            artifactContentSha256: artifact,
            modelKind: 'learned_delta',
            targetHighAt: new Date(targetMs + 3_600_000).toISOString(),
          },
        ],
      },
    })
    records.push({
      kind: 'model_score',
      recordedAt: new Date(targetMs + 2 * 3_600_000).toISOString(),
      content: {
        modelIssueContentSha256: issueSha,
        horizonHours: 24,
        outcomes: [
          {
            status: 'observed',
            routeKey,
            destination,
            sourceAt: new Date(sourceMs).toISOString(),
            targetAt: new Date(targetMs).toISOString(),
            targetHighAt: new Date(targetMs + 3_600_000).toISOString(),
            bandCovered: true,
            pointAbsoluteErrorRaw: '1',
            persistenceAbsoluteErrorRaw: '2',
          },
        ],
      },
    })
  }
  const asOf = new Date(START + 520 * 3_600_000).toISOString()
  const scorecard = buildLocalCashModelScorecard(records, { asOf })
  assert.equal(scorecard.bySubject[0].observed, 495)
  assert.equal(scorecard.bySubject[0].independentObserved, 20)
  assert.equal(scorecard.bySubject[0].pendingImmature, 25)
  assert.equal(scorecard.bySubject[0].pendingOverdue, 0)
  assert.equal(scorecard.bySubject[0].scheduleExpected, 520)
  assert.equal(scorecard.bySubject[0].scheduleOnTime, 520)
  assert.equal(scorecard.bySubject[0].scheduleIssued, 520)
  assert.equal(scorecard.bySubject[0].prospectiveValidated, true)
  assert.equal(scorecard.validatedSubjects, 1)

  const stoppedRecorder = records.filter(
    (record) =>
      record.kind !== 'model_tick' ||
      record.content.slotAt !== new Date(START + 519 * 3_600_000).toISOString(),
  )
  const staleScorecard = buildLocalCashModelScorecard(stoppedRecorder, { asOf })
  assert.equal(staleScorecard.bySubject[0].scheduleMissing, 1)
  assert.equal(staleScorecard.bySubject[0].scheduleFresh, false)
  assert.equal(staleScorecard.bySubject[0].scheduleCoveragePassed, true)
  assert.equal(staleScorecard.bySubject[0].prospectiveValidated, false)

  const caughtUpAfterOneLateTick = records.map((record) =>
    record.kind === 'model_tick' &&
    record.content.slotAt === new Date(START + 3_600_000).toISOString()
      ? { ...record, content: { ...record.content, status: 'late' } }
      : record,
  )
  const caughtUpScorecard = buildLocalCashModelScorecard(caughtUpAfterOneLateTick, { asOf })
  assert.equal(caughtUpScorecard.bySubject[0].scheduleFresh, true)
  assert.equal(caughtUpScorecard.bySubject[0].scheduleAbstentions.tick_late, 1)
  assert.equal(caughtUpScorecard.bySubject[0].scheduleCoveragePassed, true)
  assert.equal(caughtUpScorecard.bySubject[0].prospectiveValidated, true)

  const missedSchedule = records.map((record) =>
    record.kind === 'model_tick' && Date.parse(record.content.slotAt) >= START + 415 * 3_600_000
      ? { ...record, content: { ...record.content, status: 'baseline_missing' } }
      : record,
  )
  const missedScorecard = buildLocalCashModelScorecard(missedSchedule, { asOf })
  assert.equal(missedScorecard.bySubject[0].scheduleOnTime, 415)
  assert.equal(missedScorecard.bySubject[0].scheduleIssued, 415)
  assert.equal(missedScorecard.bySubject[0].scheduleAbstained, 105)
  assert.equal(missedScorecard.bySubject[0].scheduleAbstentions.tick_baseline_missing, 105)
  assert.equal(missedScorecard.bySubject[0].scheduleCoveragePassed, false)
  assert.equal(missedScorecard.bySubject[0].prospectiveValidated, false)

  let withheld = 0
  const unscored = records.filter((record) => {
    if (record.kind !== 'model_score' || withheld >= 100) return true
    const sourceHour = (Date.parse(record.content.outcomes[0].sourceAt) - START) / 3_600_000
    if (sourceHour % 26 === 0) return true
    withheld++
    return false
  })
  const unscoredScorecard = buildLocalCashModelScorecard(unscored, { asOf })
  assert.equal(unscoredScorecard.bySubject[0].independentObserved, 20)
  assert.equal(unscoredScorecard.bySubject[0].pendingOverdue, 100)
  assert.equal(unscoredScorecard.bySubject[0].pendingImmature, 25)
  assert.equal(unscoredScorecard.bySubject[0].outcomeAvailabilityPassed, false)
  assert.equal(unscoredScorecard.bySubject[0].prospectiveValidated, false)
})
