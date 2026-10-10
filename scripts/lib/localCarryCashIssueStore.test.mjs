import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildSubjectManifest } from '../record-carry-cash-issues.mjs'
import { collectAnchor } from '../backfill-carry-cash-archive.mjs'
import {
  appendLocalCarryCash,
  readLocalCarryCashObservations,
  verifyLocalCarryCash,
} from './localCarryCashStore.mjs'
import {
  buildIssueAttempts,
  buildScoreAttempts,
  issueLocalCash,
  scoreLocalCash,
  verifyLocalCashIssueLedger,
  verifyLocalCashIssueLedgerFromVerified,
} from './localCarryCashIssueStore.mjs'

const at = '2026-09-30T22:00:00.000Z'
const block = (at, n, hashByte) => ({
  number: BigInt(n),
  hash: `0x${hashByte.repeat(64)}`,
  timestamp: BigInt(Date.parse(at) / 1000),
  at,
})

async function fixture() {
  const manifest = await buildSubjectManifest()
  const assets = new Map(manifest.subjects.map((subject) => [subject.destination, subject.asset]))
  const cashRoot = mkdtempSync(join(tmpdir(), 'carry-issue-cash-'))
  const root = mkdtempSync(join(tmpdir(), 'carry-issue-ledger-'))
  async function capture(at, n, hashByte, cashRaw, collectionMode = 'current', receiptAt = null) {
    const header = block(at, n, hashByte)
    const rows = await collectAnchor({}, at, header, manifest, {
      readVaultCash: async (_, vault) =>
        vault === '0x0af56afbddcb140323445bd7211ba90e54e5fd1c'
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
        firstLocalReceiptAt: receiptAt ?? new Date(Date.parse(at) + 60_000).toISOString(),
      },
      manifest,
      cashRoot,
    )
  }
  return { manifest, root, cashRoot, capture }
}

test('all 67 exact subjects × H1/H24 issue from already received current cash only', async () => {
  const f = await fixture()
  await f.capture(at, 26093001, 'a', '1000')
  await f.capture(
    '2026-09-30T21:00:00.000Z',
    26092901,
    'b',
    '999999',
    'retrospective',
    '2026-09-30T22:02:00.000Z',
  )
  const issuedAt = '2026-09-30T22:05:00.000Z'
  const result = issueLocalCash(f.manifest, f.cashRoot, f.root, issuedAt)
  assert.equal(result.status, 'recorded')
  assert.equal(issueLocalCash(f.manifest, f.cashRoot, f.root, issuedAt).status, 'already_recorded')
  const issue = verifyLocalCashIssueLedger(f.manifest, f.cashRoot, f.root).records[0]
  const verifiedCash = verifyLocalCarryCash(f.manifest, f.cashRoot)
  const reused = verifyLocalCashIssueLedgerFromVerified(f.manifest, verifiedCash, f.root)
  assert.deepEqual(
    reused.records.map((record) => record.sha256),
    [issue.sha256],
  )
  const wrongManifestCash = {
    ...verifiedCash,
    records: verifiedCash.records.map((record, index) =>
      index === 0 ? { ...record, manifestSha256: 'wrong' } : record,
    ),
  }
  assert.throws(
    () => verifyLocalCashIssueLedgerFromVerified(f.manifest, wrongManifestCash, f.root),
    /verified_manifest/,
  )
  assert.equal(issue.attempts.length, 134)
  assert.equal(issue.attempts.filter((row) => row.status === 'issued').length, 132)
  assert.equal(issue.attempts.filter((row) => row.status === 'unassessed').length, 2)
  assert.ok(
    issue.attempts
      .filter((row) => row.status === 'issued')
      .every(
        (row) => row.forecastCashRaw === '1000' && row.source.blockHash === `0x${'a'.repeat(64)}`,
      ),
  )
  const source = readLocalCarryCashObservations(f.manifest, f.cashRoot)
  const before = buildIssueAttempts(f.manifest, source, '2026-09-30T22:00:30.000Z')
  assert.ok(before.every((row) => row.status === 'source_missing'))
})

test('H1 scores when its own window closes; H24 stays pending until its window closes', async () => {
  const f = await fixture()
  await f.capture(at, 26093001, 'a', '1000')
  issueLocalCash(f.manifest, f.cashRoot, f.root, '2026-09-30T22:05:00.000Z')
  await f.capture('2026-09-30T23:02:00.000Z', 26093002, 'b', '1050')
  assert.equal(scoreLocalCash(f.manifest, f.cashRoot, f.root, '2026-10-01T00:00:00.000Z').due, 0)
  const h1At = '2026-10-01T00:21:00.000Z'
  const h1 = scoreLocalCash(f.manifest, f.cashRoot, f.root, h1At)
  assert.equal(h1.due, 1)
  assert.equal(h1.results[0].status, 'recorded')
  assert.equal(scoreLocalCash(f.manifest, f.cashRoot, f.root, h1At).results.length, 0)
  const h1Ledger = verifyLocalCashIssueLedger(f.manifest, f.cashRoot, f.root)
  assert.equal(h1Ledger.count, 2)
  assert.equal(h1Ledger.records[1].horizonHours, 1)
  assert.equal(h1Ledger.records[1].attempts.length, 67)
  assert.equal(h1Ledger.records[1].attempts.filter((row) => row?.status === 'scored').length, 66)
  assert.equal(
    h1Ledger.records[1].attempts.find((row) => row?.status === 'scored').absoluteErrorRaw,
    '50',
  )
  const scoredAt = '2026-10-02T00:06:00.000Z'
  const score = scoreLocalCash(f.manifest, f.cashRoot, f.root, scoredAt)
  assert.equal(score.results[0].status, 'recorded')
  assert.equal(scoreLocalCash(f.manifest, f.cashRoot, f.root, scoredAt).results.length, 0)
  const ledger = verifyLocalCashIssueLedger(f.manifest, f.cashRoot, f.root)
  assert.equal(ledger.count, 3)
  assert.equal(ledger.records[2].horizonHours, 24)
  const attempts = ledger.records[2].attempts
  assert.equal(attempts.filter((row) => row?.status === 'censored_no_target').length, 66)
  assert.deepEqual(
    buildScoreAttempts(ledger.records[0], f.manifest, ledger.observations, scoredAt, 24),
    attempts,
  )
})

test('retrospective target cannot score and tampering breaks chain replay', async () => {
  const f = await fixture()
  await f.capture(at, 26093001, 'a', '1000')
  issueLocalCash(f.manifest, f.cashRoot, f.root, '2026-09-30T22:05:00.000Z')
  await f.capture('2026-09-30T23:02:00.000Z', 26093002, 'b', '5000', 'retrospective')
  scoreLocalCash(f.manifest, f.cashRoot, f.root, '2026-10-02T00:06:00.000Z')
  const ledger = verifyLocalCashIssueLedger(f.manifest, f.cashRoot, f.root)
  assert.equal(ledger.records[1].attempts.filter((row) => row?.status === 'scored').length, 0)
  const path = join(f.root, '000000000002.json')
  const score = JSON.parse(readFileSync(path, 'utf8'))
  score.attempts[0].status = 'scored'
  writeFileSync(path, `${JSON.stringify(score)}\n`)
  assert.throws(() => verifyLocalCashIssueLedger(f.manifest, f.cashRoot, f.root), /hash_mismatch/)
})

test('legacy two-horizon score replays and prevents new duplicate horizon scores', async () => {
  const f = await fixture()
  await f.capture(at, 26093001, 'a', '1000')
  issueLocalCash(f.manifest, f.cashRoot, f.root, '2026-09-30T22:05:00.000Z')
  const issue = verifyLocalCashIssueLedger(f.manifest, f.cashRoot, f.root).records[0]
  const scoredAt = '2026-10-02T00:06:00.000Z'
  const body = {
    sequence: 2,
    previousSha256: issue.sha256,
    manifestSha256: f.manifest.sha256,
    kind: 'score',
    issueSlotAt: issue.slotAt,
    issueSha256: issue.sha256,
    scoredAt,
    clock: 'local_mac_wall_clock_unanchored',
    attempts: buildScoreAttempts(
      issue,
      f.manifest,
      readLocalCarryCashObservations(f.manifest, f.cashRoot),
      scoredAt,
    ),
  }
  const sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  writeFileSync(join(f.root, '000000000002.json'), `${JSON.stringify({ ...body, sha256 })}\n`)
  assert.equal(verifyLocalCashIssueLedger(f.manifest, f.cashRoot, f.root).count, 2)
  assert.deepEqual(scoreLocalCash(f.manifest, f.cashRoot, f.root, scoredAt), {
    due: 0,
    results: [],
  })
})

test('a canonically rehashed duplicate partial H1 score fails replay', async () => {
  const f = await fixture()
  await f.capture(at, 26093001, 'a', '1000')
  issueLocalCash(f.manifest, f.cashRoot, f.root, '2026-09-30T22:05:00.000Z')
  scoreLocalCash(f.manifest, f.cashRoot, f.root, '2026-10-01T00:21:00.000Z')
  const prior = verifyLocalCashIssueLedger(f.manifest, f.cashRoot, f.root).last
  const { sha256: ignored, ...scoreBody } = prior
  void ignored
  const duplicate = { ...scoreBody, sequence: 3, previousSha256: prior.sha256 }
  const sha256 = createHash('sha256').update(JSON.stringify(duplicate)).digest('hex')
  writeFileSync(join(f.root, '000000000003.json'), `${JSON.stringify({ ...duplicate, sha256 })}\n`)
  assert.throws(() => verifyLocalCashIssueLedger(f.manifest, f.cashRoot, f.root), /replay_mismatch/)
})
