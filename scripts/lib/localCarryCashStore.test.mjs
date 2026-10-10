import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildSubjectManifest } from '../record-carry-cash-issues.mjs'
import { collectAnchor } from '../backfill-carry-cash-archive.mjs'
import {
  appendLocalCarryCash,
  localCarryCashObservationsFromVerified,
  readLocalCarryCashObservations,
  verifyLocalCarryCash,
} from './localCarryCashStore.mjs'
import { historicalAnchorGrid, parseOptions, subjectCoverage } from '../record-carry-cash-local.mjs'

const at = '2026-09-30T22:00:00.000Z'
const block = {
  number: 26093001n,
  hash: `0x${'a'.repeat(64)}`,
  timestamp: BigInt(Date.parse(at) / 1000),
  at,
}

async function fixture() {
  const manifest = await buildSubjectManifest()
  const assets = new Map(
    manifest.subjects
      .filter((row) => row.source_kind === 'vault')
      .map((row) => [row.destination, row.asset]),
  )
  const rows = await collectAnchor({}, at, block, manifest, {
    readVaultCash: async (_, vault) =>
      vault === '0x0af56afbddcb140323445bd7211ba90e54e5fd1c'
        ? { state: 'unassessed', reason: 'twyne_wrapped_atoken_cash_unassessed' }
        : {
            state: 'observed',
            reason: null,
            asset: assets.get(vault),
            shareDecimals: 18,
            assetDecimals: 6,
            cashRaw: '1000',
          },
    readDirectCash: async (_, market) => ({
      state: 'observed',
      reason: null,
      asset: market.underlying.toLowerCase(),
      shareDecimals: market.decimals,
      assetDecimals: market.decimals,
      cashRaw: '2000',
    }),
  })
  return { manifest, rows }
}

test('complete 67-subject receipt is immutable, chained and explicitly aggregate', async () => {
  const { manifest, rows } = await fixture()
  const root = mkdtempSync(join(tmpdir(), 'carry-cash-local-'))
  const input = {
    collectionMode: 'current',
    anchorAt: at,
    block,
    rows,
    firstLocalReceiptAt: '2026-09-30T22:01:00.000Z',
  }
  const first = appendLocalCarryCash(input, manifest, root)
  assert.equal(first.status, 'recorded')
  assert.equal(first.record.coverage.observed + first.record.coverage.unassessed, 67)
  assert.equal(first.record.holderExitAbility, 'not_measured')
  assert.equal(appendLocalCarryCash(input, manifest, root).status, 'already_recorded')
  const second = appendLocalCarryCash(
    { ...input, collectionMode: 'retrospective', firstLocalReceiptAt: '2026-09-30T22:02:00.000Z' },
    manifest,
    root,
  )
  assert.equal(second.record.previousSha256, first.record.sha256)
  assert.equal(verifyLocalCarryCash(manifest, root).count, 2)
  const subjects = subjectCoverage(manifest, verifyLocalCarryCash(manifest, root).records)
  assert.equal(subjects.length, 67)
  assert.equal(
    subjects.find((row) => row.destination === '0x0af56afbddcb140323445bd7211ba90e54e5fd1c')
      .retrospective.unassessed,
    1,
  )
  const path = join(root, '000000000002.json')
  const record = JSON.parse(readFileSync(path, 'utf8'))
  record.rows[0].cashRaw = '9999'
  writeFileSync(path, `${JSON.stringify(record)}\n`)
  assert.throws(() => verifyLocalCarryCash(manifest, root), /hash_mismatch/)
})

test('transient or incomplete anchors never seal', async () => {
  const { manifest, rows } = await fixture()
  const root = mkdtempSync(join(tmpdir(), 'carry-cash-local-'))
  const input = {
    collectionMode: 'current',
    anchorAt: at,
    block,
    firstLocalReceiptAt: '2026-09-30T22:01:00.000Z',
  }
  assert.throws(
    () => appendLocalCarryCash({ ...input, rows: rows.slice(1) }, manifest, root),
    /incomplete_archive_batch/,
  )
  assert.throws(
    () =>
      appendLocalCarryCash(
        {
          ...input,
          rows: rows.map((row, i) =>
            i === 0
              ? {
                  ...row,
                  state: 'read_unavailable',
                  reason: 'archive_state_read_failed',
                  asset: null,
                  shareDecimals: null,
                  assetDecimals: null,
                  cashRaw: null,
                }
              : row,
          ),
        },
        manifest,
        root,
      ),
    /transient_read/,
  )
  assert.equal(verifyLocalCarryCash(manifest, root).count, 0)
})

test('consumer view distinguishes current collection from retrospective rows', async () => {
  const { manifest, rows } = await fixture()
  const root = mkdtempSync(join(tmpdir(), 'carry-cash-local-'))
  appendLocalCarryCash(
    {
      collectionMode: 'current',
      anchorAt: at,
      block,
      rows,
      firstLocalReceiptAt: '2026-09-30T22:01:00.000Z',
    },
    manifest,
    root,
  )
  appendLocalCarryCash(
    {
      collectionMode: 'retrospective',
      anchorAt: at,
      block,
      rows,
      firstLocalReceiptAt: '2026-09-30T22:02:00.000Z',
    },
    manifest,
    root,
  )
  const raw = verifyLocalCarryCash(manifest, root).records
  assert.equal(raw[0].rows[0].captureKind, 'backfilled')
  assert.equal(raw[1].rows[0].captureKind, 'backfilled')
  const [current, history] = readLocalCarryCashObservations(manifest, root)
  assert.deepEqual(localCarryCashObservationsFromVerified(verifyLocalCarryCash(manifest, root)), [
    current,
    history,
  ])
  assert.throws(
    () => localCarryCashObservationsFromVerified({ count: 2, last: null, records: raw }),
    /verified_input/,
  )
  assert.equal(current.evidenceKind, 'current_finalized_observation')
  assert.equal(history.evidenceKind, 'retrospective_reconstruction')
  assert.equal(current.subjects.length, 67)
  assert.equal(history.subjects.length, 67)
  assert.ok(
    current.subjects.every(
      (row) =>
        row.collectionMode === 'current' &&
        row.evidenceKind === 'current_finalized_observation' &&
        !('captureKind' in row),
    ),
  )
  assert.ok(
    history.subjects.every(
      (row) =>
        row.collectionMode === 'retrospective' &&
        row.evidenceKind === 'retrospective_reconstruction' &&
        !('captureKind' in row),
    ),
  )
  assert.equal(current.subjects[0].receiptSha256, raw[0].sha256)
  assert.equal(current.subjects[0].firstLocalReceiptAt, raw[0].firstLocalReceiptAt)
  assert.equal(verifyLocalCarryCash(manifest, root).records[0].sha256, raw[0].sha256)
})

test('bounded retrospective grid and mode flags', () => {
  const options = parseOptions([
    '--history',
    '--as-of',
    at,
    '--lookback-hours',
    '72',
    '--step-hours',
    '24',
    '--max-anchors',
    '2',
  ])
  assert.deepEqual(historicalAnchorGrid(at, options), [
    '2026-09-27T22:00:00.000Z',
    '2026-09-28T22:00:00.000Z',
    '2026-09-29T22:00:00.000Z',
  ])
  assert.throws(() => parseOptions(['--history', '--lookback-hours', '2881']), /history_bounds/)
  assert.throws(() => parseOptions(['--current', '--history']), /multiple_modes/)
  assert.equal(historicalAnchorGrid(at, parseOptions(['--history']))[0], '2026-09-29T00:00:00.000Z')
})
