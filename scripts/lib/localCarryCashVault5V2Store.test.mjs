import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { buildSubjectManifest } from '../record-carry-cash-issues.mjs'
import { appendLocalCarryCash, LOCAL_CARRY_CASH_ROOT } from './localCarryCashStore.mjs'
import {
  VAULT5_SUBJECTS,
  VAULT5_V2_POLICY,
  VAULT5_V2_POLICY_SHA256,
} from '../research/carry-cash-vault5-v2-policy.mjs'
import {
  Vault5V2LedgerError,
  evaluateVault5V2,
  latestCurrentSource,
  registerVault5V2,
  scoreVault5V2,
  tickVault5V2,
  verifyVault5V2Ledger,
} from './localCarryCashVault5V2Store.mjs'

test('temp-root artifact and enrollment replay, with physical tamper rejection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'carry-vault5-v2-'))
  try {
    const manifest = await buildSubjectManifest()
    const options = { root }
    const before = verifyVault5V2Ledger(manifest, options)
    assert.equal(before.count, 0)
    const enrolled = registerVault5V2(manifest, options)
    assert.equal(enrolled.status, 'registered')
    const verified = verifyVault5V2Ledger(manifest, options)
    assert.equal(verified.count, 2)
    assert.equal(readdirSync(root).filter((name) => /^\d/.test(name)).length, 1)
    assert.equal(verified.artifact.content.subjects.length, 5)
    assert.equal(verified.artifact.content.development.receiptCount, 120)
    assert.equal(verified.issues.length, 0)
    const again = registerVault5V2(
      manifest,
      options,
      new Date(Date.parse(enrolled.cutoverAt) + 48 * 3_600_000).toISOString(),
    )
    assert.equal(again.status, 'already_registered')
    assert.equal(again.artifactSha256, enrolled.artifactSha256)
    assert.equal(again.enrollmentSha256, enrolled.enrollmentSha256)
    assert.equal(again.cutoverAt, enrolled.cutoverAt)
    assert.equal(verifyVault5V2Ledger(manifest, options).count, 2)
    const evaluation = evaluateVault5V2(manifest, options)
    assert.equal(evaluation.cohortPassed, false)
    assert.equal(evaluation.scoredClusters, 0)
    const path = join(root, '000000000001.json')
    const bytes = readFileSync(path, 'utf8')
    const row = JSON.parse(bytes)
    row.records[1].content.cutoverAt = '2000-01-01T00:00:00.000Z'
    writeFileSync(path, `${JSON.stringify(row)}\n`)
    assert.throws(() => verifyVault5V2Ledger(manifest, options), /vault5_hash/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(`${root}.head.json`, { force: true })
  }
})

test('source receipt exactly at enrollment cutoff is never selectable', () => {
  const cutover = '2026-10-05T12:00:00.000Z'
  const source = {
    collectionMode: 'current',
    firstLocalReceiptAt: cutover,
    blockAt: '2026-10-05T12:01:00.000Z',
    sequence: 1,
    rows: VAULT5_SUBJECTS.map((subject) => ({
      routeKey: subject.routeKey,
      destination: subject.destination,
      asset: subject.asset,
      state: 'observed',
      cashRaw: '100',
    })),
  }
  assert.equal(
    latestCurrentSource({ records: [source] }, { recordedAt: cutover }, '2026-10-05T12:02:00.000Z'),
    undefined,
  )
  source.firstLocalReceiptAt = '2026-10-05T12:01:30.000Z'
  assert.equal(
    latestCurrentSource({ records: [source] }, { recordedAt: cutover }, '2026-10-05T12:02:00.000Z'),
    source,
  )
})

test('one current source and one current target score one cluster of five without pooling', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'carry-vault5-v2-cluster-'))
  const root = join(parent, 'model')
  const cashRoot = join(parent, 'cash')
  try {
    cpSync(LOCAL_CARRY_CASH_ROOT, cashRoot, { recursive: true })
    const manifest = await buildSubjectManifest()
    const options = { root, cashRoot }
    registerVault5V2(manifest, options)
    const enrollment = verifyVault5V2Ledger(manifest, options).enrollment
    const slotMs = Date.parse(enrollment.content.firstSlotAt)
    const template = verifyVault5V2Ledger(manifest, options)
      .cash.records.filter((row) => row.collectionMode === 'current')
      .at(-1)
    const makeReceipt = (blockAtMs, blockNumber, cashBump, incomplete = false) => {
      const blockAt = new Date(blockAtMs).toISOString()
      const blockHash = `0x${blockNumber.toString(16).padStart(64, '0')}`
      const rows = template.rows.map((row) => {
        const copy = {
          ...row,
          anchorAt: blockAt,
          block: String(blockNumber),
          blockHash,
          blockAt,
          cashRaw:
            row.state === 'observed' ? (BigInt(row.cashRaw) + BigInt(cashBump)).toString() : null,
        }
        if (incomplete && row.destination === VAULT5_SUBJECTS[0].destination) {
          Object.assign(copy, {
            state: 'no_code',
            asset: null,
            shareDecimals: null,
            assetDecimals: null,
            cashRaw: null,
            reason: 'test_incomplete_target',
          })
        }
        return copy
      })
      return appendLocalCarryCash(
        {
          collectionMode: 'current',
          anchorAt: blockAt,
          block: {
            number: BigInt(blockNumber),
            hash: blockHash,
            at: blockAt,
            timestamp: BigInt(Math.floor(blockAtMs / 1000)),
          },
          firstLocalReceiptAt: new Date(blockAtMs + 60_000).toISOString(),
          rows,
        },
        manifest,
        cashRoot,
      ).record
    }
    const sourceMs = slotMs + 5 * 60_000
    const source = makeReceipt(sourceMs, Number(template.block) + 100, 0)
    const incompleteSource = makeReceipt(sourceMs + 60_000, Number(template.block) + 101, 0, true)
    const tickAt = new Date(sourceMs + 2 * 60_000).toISOString()
    assert.equal(
      latestCurrentSource({ records: [source, incompleteSource] }, enrollment, tickAt)?.sha256,
      source.sha256,
    )
    assert.equal(
      latestCurrentSource({ records: [incompleteSource] }, enrollment, tickAt),
      undefined,
    )
    const issued = tickVault5V2(manifest, options, tickAt)
    assert.equal(issued.status, 'issued')
    const issuedState = verifyVault5V2Ledger(manifest, options)
    assert.equal(issuedState.ticks.length, 1)
    assert.equal(issuedState.issues.length, 1)
    assert.equal(issuedState.issues[0].content.sourceReceiptSha256, source.sha256)
    assert.equal(issuedState.issues[0].content.attempts.length, 5)
    const physical = JSON.parse(readFileSync(join(root, '000000000003.json'), 'utf8'))
    assert.equal(physical.kind, 'cohort_bundle')
    assert.deepEqual(
      physical.records.map((row) => row.kind),
      ['cohort_tick', 'cohort_issue'],
    )
    assert.equal(readdirSync(root).filter((name) => /^\d/.test(name)).length, 2)
    // A crash before the atomic link can leave only a private temporary file.
    writeFileSync(join(root, '.11111111-1111-4111-8111-111111111111.tmp'), 'partial')
    assert.equal(verifyVault5V2Ledger(manifest, options).issues.length, 1)
    const pending = scoreVault5V2(
      manifest,
      options,
      new Date(sourceMs + 22 * 3_600_000).toISOString(),
    )
    assert.equal(pending.status, 'pending')
    const incompleteH23 = makeReceipt(
      sourceMs + 23 * 3_600_000,
      Number(template.block) + 150,
      5,
      true,
    )
    const targetMs = sourceMs + 24 * 3_600_000
    const target = makeReceipt(targetMs, Number(template.block) + 200, 10)
    const deadlineMs = Date.parse(issuedState.issues[0].content.targetReceiptDeadline)
    assert.equal(
      scoreVault5V2(manifest, options, new Date(deadlineMs).toISOString()).status,
      'pending',
    )
    const scored = scoreVault5V2(manifest, options, new Date(deadlineMs + 60_000).toISOString())
    assert.equal(scored.status, 'observed')
    const state = verifyVault5V2Ledger(manifest, options)
    assert.equal(state.scores.length, 1)
    assert.equal(state.scores[0].content.targetReceiptSha256, target.sha256)
    assert.notEqual(state.scores[0].content.targetReceiptSha256, incompleteH23.sha256)
    assert.equal(state.scores[0].content.outcomes.length, 5)
    const summary = evaluateVault5V2(manifest, options)
    assert.equal(summary.scoredClusters, 1)
    assert.equal(
      summary.bySubject.every((row) => row.completeClusters === 1),
      true,
    )
    assert.equal(summary.cohortPassed, false)
    const secondSlotMs = slotMs + 27 * 3_600_000
    const secondSourceMs = secondSlotMs + 5 * 60_000
    makeReceipt(secondSourceMs, Number(template.block) + 300, 0)
    const secondIssue = tickVault5V2(
      manifest,
      options,
      new Date(secondSourceMs + 2 * 60_000).toISOString(),
    )
    assert.equal(secondIssue.status, 'issued')
    const second = verifyVault5V2Ledger(manifest, options).issues.at(-1)
    makeReceipt(secondSourceMs + 24 * 3_600_000, Number(template.block) + 400, 10, true)
    const censored = scoreVault5V2(
      manifest,
      options,
      new Date(Date.parse(second.content.targetReceiptDeadline) + 60_000).toISOString(),
    )
    assert.equal(censored.status, 'censored')
    const final = verifyVault5V2Ledger(manifest, options)
    assert.equal(final.scores.length, 2)
    assert.equal(final.scores[1].content.targetReceiptSha256, null)
    assert.equal(
      final.scores[1].content.outcomes.every((row) => row.status === 'censored'),
      true,
    )
    assert.equal(evaluateVault5V2(manifest, options).bySubject[0].completeClusters, 1)
    const thirdSlotMs = slotMs + 54 * 3_600_000
    makeReceipt(thirdSlotMs + 5 * 60_000, Number(template.block) + 500, 0, true)
    assert.deepEqual(
      tickVault5V2(manifest, options, new Date(thirdSlotMs + 7 * 60_000).toISOString()),
      {
        status: 'pending',
        reason: 'current_source_missing',
        slotAt: new Date(thirdSlotMs).toISOString(),
      },
    )
    assert.equal(
      tickVault5V2(manifest, options, new Date(thirdSlotMs + 60 * 60_000).toISOString()).status,
      'missed',
    )
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('existing lock fails clearly and is never removed by a competing writer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'carry-vault5-v2-lock-'))
  try {
    const manifest = await buildSubjectManifest()
    const options = { root }
    const enrolled = registerVault5V2(manifest, options)
    const lock = `${root}.lock`
    writeFileSync(lock, 'active-or-stale-owner')
    assert.throws(
      () =>
        tickVault5V2(
          manifest,
          options,
          new Date(Date.parse(enrolled.firstSlotAt) + 3_600_000).toISOString(),
        ),
      /vault5_lock_held_manual_inspection_required/,
    )
    assert.equal(readFileSync(lock, 'utf8'), 'active-or-stale-owner')
    assert.equal(verifyVault5V2Ledger(manifest, options).count, 2)
    unlinkSync(lock)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(`${root}.head.json`, { force: true })
  }
})

test('external head detects rollback and repairs only a complete valid crash suffix', async () => {
  const root = mkdtempSync(join(tmpdir(), 'carry-vault5-v2-head-'))
  try {
    const manifest = await buildSubjectManifest()
    const options = { root }
    const enrolled = registerVault5V2(manifest, options)
    const missed = tickVault5V2(
      manifest,
      options,
      new Date(Date.parse(enrolled.firstSlotAt) + 3_600_000).toISOString(),
    )
    assert.equal(missed.status, 'missed')
    const verified = verifyVault5V2Ledger(manifest, options)
    assert.equal(verified.count, 3)
    const path = `${root}.head.json`
    const currentHead = JSON.parse(readFileSync(path, 'utf8'))
    const { sha256: _ignored, ...body } = currentHead
    body.sequence = 2
    body.lastSha256 = verified.enrollment.sha256
    writeFileSync(
      path,
      `${JSON.stringify({
        ...body,
        sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
      })}\n`,
    )
    assert.equal(verifyVault5V2Ledger(manifest, options).count, 3)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).sequence, 3)
    unlinkSync(join(root, '000000000003.json'))
    assert.throws(
      () => verifyVault5V2Ledger(manifest, options),
      /vault5_head_ahead_ledger_rollback/,
    )
    rmSync(root, { recursive: true })
    assert.throws(
      () => verifyVault5V2Ledger(manifest, options),
      /vault5_head_ahead_ledger_rollback/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(`${root}.head.json`, { force: true })
  }
})

test('read-only verification refuses a valid lagging head without changing its bytes or mtime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'carry-vault5-v2-read-only-head-'))
  try {
    const manifest = await buildSubjectManifest()
    const options = { root }
    const enrolled = registerVault5V2(manifest, options)
    tickVault5V2(
      manifest,
      options,
      new Date(Date.parse(enrolled.firstSlotAt) + 3_600_000).toISOString(),
    )
    const verified = verifyVault5V2Ledger(manifest, options)
    const path = `${root}.head.json`
    const currentHead = JSON.parse(readFileSync(path, 'utf8'))
    const { sha256: _ignored, ...body } = currentHead
    body.sequence = 2
    body.lastSha256 = verified.enrollment.sha256
    const lagging = {
      ...body,
      sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    }
    writeFileSync(path, `${JSON.stringify(lagging)}\n`)
    const beforeBytes = readFileSync(path)
    const beforeMtimeNs = statSync(path, { bigint: true }).mtimeNs
    assert.throws(
      () => verifyVault5V2Ledger(manifest, { ...options, recoverHead: false }),
      (error) =>
        error instanceof Vault5V2LedgerError && error.code === 'vault5_head_lag_recovery_required',
    )
    assert.deepEqual(readFileSync(path), beforeBytes)
    assert.equal(statSync(path, { bigint: true }).mtimeNs, beforeMtimeNs)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(`${root}.head.json`, { force: true })
  }
})

test('pre-link crash leaves head zero and later retry cleanly bootstraps one frozen clock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'carry-vault5-v2-prelink-'))
  try {
    const manifest = await buildSubjectManifest()
    const body = {
      schema: 'carry_vault5_v2_head_v1',
      study: VAULT5_V2_POLICY.study,
      policySha256: VAULT5_V2_POLICY_SHA256,
      manifestSha256: manifest.sha256,
      sequence: 0,
      lastSha256: null,
    }
    writeFileSync(
      `${root}.head.json`,
      `${JSON.stringify({
        ...body,
        sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
      })}\n`,
    )
    writeFileSync(join(root, '.11111111-1111-4111-8111-111111111111.tmp'), 'unlinked bundle')
    const retryAt = new Date(Date.now() + 48 * 3_600_000).toISOString()
    const registered = registerVault5V2(manifest, { root }, retryAt)
    assert.equal(registered.status, 'registered')
    assert.equal(registered.cutoverAt, new Date(Date.parse(retryAt) + 1).toISOString())
    const state = verifyVault5V2Ledger(manifest, { root })
    assert.equal(state.artifact.content.development.cutoffAt, retryAt)
    assert.equal(state.count, 2)
    assert.equal(readdirSync(root).filter((name) => /^\d/.test(name)).length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(`${root}.head.json`, { force: true })
  }
})
