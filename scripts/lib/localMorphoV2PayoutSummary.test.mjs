import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  summarizeVerifiedMorphoPayoutRoute,
  verifySelectedMorphoProofFiles,
} from './localMorphoV2PayoutSummary.mjs'

const vault = `0x${'a'.repeat(40)}`
const asset = `0x${'b'.repeat(40)}`
const routeKey = 'USDC → VaultV2 [USDC]'
const subject = { vault, asset, routeKeys: [routeKey] }
const candidate = (n) => ({ vault, asset, transactionHash: `0x${String(n).padStart(64, '0')}` })

test('route summary counts reconciled transactions separately from external proof rows', () => {
  const candidates = [1, 2, 3, 4].map(candidate)
  const records = [
    {
      outcome: {
        status: 'receipt_reconciled',
        proofs: [
          { status: 'reconciled_external_supplier' },
          { status: 'reconciled_external_supplier' },
          { status: 'internal_vault_receiver' },
        ],
      },
    },
    { outcome: { status: 'ambiguous', proofs: [{ status: 'reconciled_external_supplier' }] } },
    null,
    {
      outcome: {
        status: 'receipt_reconciled',
        proofs: [{ status: 'reconciled_external_supplier' }],
      },
    },
  ]
  const summary = summarizeVerifiedMorphoPayoutRoute(
    subject,
    routeKey,
    [
      { toBlock: '10', toObservedAt: '2026-10-01T00:00:00.000Z' },
      { toBlock: '20', toObservedAt: '2026-10-01T00:01:00.000Z' },
    ],
    candidates,
    records,
  )
  assert.deepEqual(
    [
      summary.candidateTransactions,
      summary.sealedTransactions,
      summary.receiptReconciledTransactions,
      summary.externalPayoutProofRows,
      summary.ambiguousTransactions,
      summary.pendingTransactions,
    ],
    [4, 3, 2, 3, 1, 1],
  )
  assert.equal(summary.calibratedForecast, false)
  assert.equal(summary.sameHolderExit, 'not_established')
  assert.equal(summary.sourceCompleteness, 'not_independently_proven')
  assert.equal(summary.latestCoveredBlock, '20')
  assert.equal(summary.latestCoveredAt, '2026-10-01T00:01:00.000Z')
})

test('route summary rejects identity drift and empty receipt classification', () => {
  assert.throws(
    () => summarizeVerifiedMorphoPayoutRoute(subject, 'USDT → VaultV2 [USDT]', [], [], []),
    /route_identity_invalid/,
  )
  assert.throws(
    () =>
      summarizeVerifiedMorphoPayoutRoute(
        subject,
        routeKey,
        [],
        [{ ...candidate(1), asset: vault }],
        [null],
      ),
    /candidate_identity_invalid/,
  )
  assert.throws(
    () =>
      summarizeVerifiedMorphoPayoutRoute(
        subject,
        routeKey,
        [],
        [candidate(1)],
        [{ outcome: { status: 'receipt_reconciled', proofs: [] } }],
      ),
    /empty_reconciliation/,
  )
})

test('selected vault fails closed on orphan receipt files', () => {
  const root = mkdtempSync(join(tmpdir(), 'morpho-payout-summary-'))
  try {
    const directory = join(root, vault)
    mkdirSync(directory)
    const expected = candidate(1)
    const expectedName = `${expected.transactionHash}.json`
    writeFileSync(join(directory, expectedName), '{}')
    assert.doesNotThrow(() => verifySelectedMorphoProofFiles(subject, [expected], root))
    writeFileSync(join(directory, `${expectedName}.12345678-1234-1234-1234-123456789abc.tmp`), '{}')
    assert.doesNotThrow(() => verifySelectedMorphoProofFiles(subject, [expected], root))
    writeFileSync(join(directory, `${candidate(2).transactionHash}.json`), '{}')
    assert.throws(
      () => verifySelectedMorphoProofFiles(subject, [expected], root),
      /morpho_payout_orphan_proof/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
