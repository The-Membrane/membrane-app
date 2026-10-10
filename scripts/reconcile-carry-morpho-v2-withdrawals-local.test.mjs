import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem'

import {
  appendLocalPayoutRecord,
  candidateTransactions,
  normalizedWitness,
  readLocalPayoutRecord,
  reconcileIndependent,
  rpcOrigin,
  summarizeVerifiedMorphoPayoutsBySubject,
} from './reconcile-carry-morpho-v2-withdrawals-local.mjs'

const vault = `0x${'1'.repeat(40)}`
const asset = `0x${'2'.repeat(40)}`
const receiver = `0x${'3'.repeat(40)}`
const owner = `0x${'4'.repeat(40)}`
const tx = `0x${'5'.repeat(64)}`
const blockHash = `0x${'6'.repeat(64)}`
const finalHash = `0x${'7'.repeat(64)}`
const subject = {
  vault,
  asset,
  routeKeys: ['USDC → VaultV2 [USDC]'],
  manifestSha256: 'a'.repeat(64),
  seedSha256: 'b'.repeat(64),
  boardSha256: 'c'.repeat(64),
  displayedRoutesSha256: 'd'.repeat(64),
  cohortId: 'aug-2026-ab-vault-routes',
}
const withdraw = parseAbiItem(
  'event Withdraw(address indexed sender,address indexed receiver,address indexed onBehalf,uint256 assets,uint256 shares)',
)
const transfer = parseAbiItem(
  'event Transfer(address indexed from,address indexed to,uint256 value)',
)
const source = {
  block: '100',
  block_hash: blockHash,
  transaction_hash: tx,
  transaction_index: 1,
  log_index: 2,
  event_kind: 'withdraw',
  sender: owner,
  owner,
  receiver,
  assets_raw: '100',
  shares_raw: '50',
  flow_class: 'external_receiver_unreconciled',
  force_event_in_transaction: false,
}
const candidate = candidateTransactions(subject, [
  {
    sha256: 'e'.repeat(64),
    fromBlock: '100',
    events: [source],
  },
])[0]

test('per-subject historical payout count excludes ambiguous and missing receipts', () => {
  const other = { ...candidate, transactionHash: `0x${'8'.repeat(64)}` }
  const existing = new Map([
    [`${vault}:${tx}`, { outcome: { status: 'receipt_reconciled' } }],
    [`${vault}:${other.transactionHash}`, { outcome: { status: 'ambiguous' } }],
  ])
  assert.deepEqual(
    summarizeVerifiedMorphoPayoutsBySubject([subject], [candidate, other], existing),
    [
      {
        routeKey: subject.routeKeys[0],
        destination: vault,
        asset,
        reconciledTransactions: 1,
      },
    ],
  )
  existing.delete(`${vault}:${other.transactionHash}`)
  assert.throws(
    () => summarizeVerifiedMorphoPayoutsBySubject([subject], [candidate, other], existing),
    /subject_summary_missing_or_duplicate/,
  )
})
const eventLog = (event, address, index, args, values) => ({
  address,
  topics: encodeEventTopics({ abi: [event], eventName: event.name, args }),
  data: encodeAbiParameters(
    values.map(() => ({ type: 'uint256' })),
    values,
  ),
  logIndex: index,
  blockHash,
  transactionHash: tx,
  transactionIndex: 1,
  blockNumber: 100n,
})
const proof = (amount = 100n) =>
  normalizedWitness({
    receipt: {
      transactionHash: tx,
      blockNumber: 100n,
      blockHash,
      transactionIndex: 1,
      status: 'success',
      logs: [
        eventLog(withdraw, vault, 2, { sender: owner, receiver, onBehalf: owner }, [100n, 50n]),
        eventLog(transfer, asset, 3, { from: vault, to: receiver }, [amount]),
      ],
    },
    header: { number: 100n, hash: blockHash },
    finalized: { number: 110n, hash: finalHash },
    liveAsset: asset,
  })

test('independent matching receipts seal exact external payout and tolerate advanced finalized head', () => {
  const first = proof()
  const second = proof()
  second.finalized.number = '111'
  const result = reconcileIndependent(candidate, first, second, ['alchemy.com', 'ankr.com'])
  assert.equal(result.status, 'receipt_reconciled')
  assert.equal(result.proofs[0].status, 'reconciled_external_supplier')
  assert.throws(
    () => reconcileIndependent(candidate, first, second, ['same.com', 'same.com']),
    /origins_not_independent/,
  )
})

test('receipt disagreement, missing transfer, and force classification cannot count payout', () => {
  assert.equal(
    reconcileIndependent(candidate, proof(), proof(99n), ['a.com', 'b.com']).status,
    'ambiguous',
  )
  const insufficient = reconcileIndependent(candidate, proof(99n), proof(99n), ['a.com', 'b.com'])
  assert.equal(insufficient.status, 'ambiguous')
  assert.equal(insufficient.proofs[0].status, 'unreconciled')
  const internal = {
    ...candidate,
    rows: candidate.rows.map((row) => ({
      ...row,
      receiver: vault,
      flow_class: 'internal_force_deallocate',
      force_event_in_transaction: true,
    })),
  }
  assert.notEqual(
    reconcileIndependent(internal, proof(), proof(), ['a.com', 'b.com']).status,
    'receipt_reconciled',
  )
})

test('append-only local record replays source and evidence, rejecting mutation', () => {
  const root = mkdtempSync(join(tmpdir(), 'morpho-payout-'))
  try {
    const record = appendLocalPayoutRecord(candidate, [proof(), proof()], ['a.com', 'b.com'], root)
    assert.equal(record.outcome.status, 'receipt_reconciled')
    assert.equal(readLocalPayoutRecord(candidate, root).sha256, record.sha256)
    assert.throws(
      () => appendLocalPayoutRecord(candidate, [proof(), proof()], ['a.com', 'b.com'], root),
      /already_sealed/,
    )
    const path = join(root, vault, `${tx}.json`)
    const mutated = JSON.parse(readFileSync(path, 'utf8'))
    mutated.witnesses[0].receipt.logs[1].data = '0x00'
    writeFileSync(path, `${JSON.stringify(mutated)}\n`)
    assert.throws(() => readLocalPayoutRecord(candidate, root), /hash_mismatch/)
    const outside = join(root, 'other.json')
    writeFileSync(outside, `${JSON.stringify(record)}\n`)
    unlinkSync(path)
    symlinkSync(outside, path)
    assert.throws(() => readLocalPayoutRecord(candidate, root), /ELOOP|unsafe_file/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('origin identity uses hosts and excludes duplicate aliases and credentials', () => {
  assert.equal(rpcOrigin('https://www.Example.org/a'), 'example.org')
  assert.equal(rpcOrigin('https://example.org/b?api-key=redacted'), 'example.org')
  assert.throws(() => rpcOrigin('https://user:password@example.org/'), /origin_invalid/)
})
