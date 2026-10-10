import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BOARD_ROUTES } from '../research/carry-local-morpho-holder-v2.mjs'
import {
  discoverMorphoLocalPayoutCandidate,
  rankVerifiedPayoutOwners,
  validateMorphoLocalPayoutCandidateEvidence,
  verifyPayoutSourceRows,
} from './carry-exit-v2-morpho-local-payout-candidate.mjs'

const owners = ['0x' + '1'.repeat(40), '0x' + '2'.repeat(40)]
const receipt = (digit) => ({ sha256: digit.repeat(64), outcome: { status: 'receipt_reconciled' } })
const candidate = (owner, block) => ({
  rows: [{ owner, block: String(block), flow_class: 'external_receiver_unreconciled' }],
})

test('local payout shortlist ranks verified receipts by recency and deduplicates owners', () => {
  const rows = [candidate(owners[0], 1), candidate(owners[1], 3), candidate(owners[0], 2)]
  const ranked = rankVerifiedPayoutOwners(rows, (row) => receipt(row.rows[0].block))
  assert.deepEqual(ranked, [
    { owner: owners[1], receiptSha256: '3'.repeat(64) },
    { owner: owners[0], receiptSha256: '2'.repeat(64) },
  ])
  assert.throws(
    () => rankVerifiedPayoutOwners(rows, () => null),
    /morpho_local_payout_candidate_invalid/,
  )
})

test('local payout candidate needs two pinned agreeing hosts and keeps provenance separate', async () => {
  const route = BOARD_ROUTES[22]
  const hash = '0x' + 'a'.repeat(64)
  const baseline = {
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    targetBlock: '123',
    targetHash: hash,
    targetParentHash: '0x' + 'b'.repeat(64),
    totalAssetsRaw: '1000000000',
    assetDecimals: 6,
    canonicalityEvidenceDoc: {
      schema: 'carry_exit_v2_headers_v1',
      targetHeader: { hash, number: '123' },
    },
  }
  const primary = { provider: 'https://rpc.ankr.com/eth', request: async () => null }
  const secondary = {
    provider: 'https://eth-mainnet.g.alchemy.com/v2/test',
    request: async () => null,
  }
  const output = await discoverMorphoLocalPayoutCandidate({
    baseline,
    primary,
    secondary,
    readShortlist: async () => [
      { owner: owners[0], receiptSha256: 'a'.repeat(64) },
      { owner: owners[1], receiptSha256: 'b'.repeat(64) },
    ],
    pinnedRead: async (_request, _baseline, owner) => ({
      status: 'eligible_holder',
      sharesRaw: owner === owners[0] ? '10' : '20',
      claimRaw: owner === owners[0] ? '8' : '16',
    }),
  })
  assert.equal(output.holder, owners[1])
  assert.equal(output.evidenceDoc.discovery.historicalHolderProof, false)
  const hosts = output.evidenceDoc.screenedCandidates[0].pinnedProof.hostCommitments
  assert.equal(
    validateMorphoLocalPayoutCandidateEvidence(output.evidenceDoc, hosts),
    output.evidenceDoc,
  )
  assert.throws(
    () =>
      validateMorphoLocalPayoutCandidateEvidence(
        {
          ...output.evidenceDoc,
          selectedClaimRaw: '8',
        },
        hosts,
      ),
    /morpho_local_payout_candidate_invalid/,
  )
  assert.throws(
    () =>
      validateMorphoLocalPayoutCandidateEvidence(
        {
          ...output.evidenceDoc,
          discovery: { ...output.evidenceDoc.discovery, sourceRowsSha256: 'f'.repeat(64) },
        },
        hosts,
      ),
    /morpho_local_payout_candidate_invalid/,
  )
  assert.throws(
    () =>
      validateMorphoLocalPayoutCandidateEvidence(
        {
          ...output.evidenceDoc,
          ladder: { ...output.evidenceDoc.ladder, smallSentinelAssetsRaw: '1' },
        },
        hosts,
      ),
    /morpho_local_payout_candidate_invalid/,
  )
  const sourceCandidates = owners.map((owner, index) => ({
    block: '122',
    rows: [{ owner, flow_class: 'external_receiver_unreconciled' }],
    index,
  }))
  const recordFor = ({ index }) => receipt(index === 0 ? 'a' : 'b')
  assert.equal(verifyPayoutSourceRows(output.evidenceDoc, sourceCandidates, recordFor), true)
  assert.equal(
    verifyPayoutSourceRows(
      output.evidenceDoc,
      [...sourceCandidates, { block: '124', rows: [], index: 99 }],
      ({ index }) => (index === 99 ? null : recordFor({ index })),
    ),
    true,
  )
  assert.throws(
    () => verifyPayoutSourceRows(output.evidenceDoc, sourceCandidates, () => null),
    /morpho_local_payout_candidate_invalid/,
  )
  assert.throws(
    () => verifyPayoutSourceRows(output.evidenceDoc, sourceCandidates, () => receipt('f')),
    /morpho_local_payout_candidate_invalid/,
  )
  assert.throws(
    () =>
      verifyPayoutSourceRows(
        output.evidenceDoc,
        sourceCandidates.map((row) => ({ ...row, block: '124' })),
        recordFor,
      ),
    /morpho_local_payout_candidate_invalid/,
  )
})
