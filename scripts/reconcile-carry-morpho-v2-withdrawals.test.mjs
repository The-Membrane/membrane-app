import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem'
import {
  reconcilePending,
  reconcileTransaction,
  verifyReconciliationProof,
} from './reconcile-carry-morpho-v2-withdrawals.mjs'
import {
  assessCollectedEndpoint,
  certifiedWindowMaxima,
  maximumRollingFlow,
  verifyCanonicalIntervalBoundaries,
  verifyCoverage,
  verifySupplierGroups,
} from './audit-carry-morpho-v2-withdraw-flow.mjs'

const vault = `0x${'1'.repeat(40)}`
const asset = `0x${'2'.repeat(40)}`
const receiver = `0x${'3'.repeat(40)}`
const owner = `0x${'4'.repeat(40)}`
const sender = `0x${'5'.repeat(40)}`
const tx = `0x${'6'.repeat(64)}`
const blockHash = `0x${'7'.repeat(64)}`
const finalHash = `0x${'8'.repeat(64)}`
const wEvent = parseAbiItem(
  'event Withdraw(address indexed sender,address indexed receiver,address indexed onBehalf,uint256 assets,uint256 shares)',
)
const tEvent = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)')
const fEvent = parseAbiItem(
  'event ForceDeallocate(address indexed sender,address adapter,uint256 assets,address indexed onBehalf,bytes32[] ids,uint256 penaltyAssets)',
)
const header = { number: 101n, hash: blockHash }
const finalized = { number: 105n, hash: finalHash }
const row = (index = 3, amount = '100', recv = receiver, force = false) => ({
  vault,
  asset,
  manifest_sha256: 'a'.repeat(64),
  seed_sha256: 'b'.repeat(64),
  board_sha256: 'c'.repeat(64),
  displayed_routes_sha256: 'd'.repeat(64),
  cohort_id: 'test',
  interval_from_block: '100',
  block: '101',
  block_hash: blockHash,
  transaction_hash: tx,
  transaction_index: 2,
  log_index: index,
  event_kind: 'withdraw',
  sender,
  owner,
  receiver: recv,
  assets_raw: amount,
  shares_raw: '50',
  flow_class: 'external_receiver_unreconciled',
  force_event_in_transaction: force,
})
const log = (event, address, index, args, dataTypes, values) => ({
  address,
  blockNumber: 101n,
  blockHash,
  transactionHash: tx,
  transactionIndex: 2,
  logIndex: index,
  topics: encodeEventTopics({ abi: [event], eventName: event.name, args }),
  data: encodeAbiParameters(dataTypes, values),
})
const withdraw = (index = 3, amount = 100n, recv = receiver) =>
  log(
    wEvent,
    vault,
    index,
    { sender, receiver: recv, onBehalf: owner },
    [{ type: 'uint256' }, { type: 'uint256' }],
    [amount, 50n],
  )
const transfer = (index = 4, amount = 100n, recv = receiver) =>
  log(tEvent, asset, index, { from: vault, to: recv }, [{ type: 'uint256' }], [amount])
const force = () =>
  log(
    fEvent,
    vault,
    2,
    { sender, onBehalf: owner },
    [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32[]' }, { type: 'uint256' }],
    [asset, 100n, [], 0n],
  )
const receipt = (logs, overrides = {}) => ({
  transactionHash: tx,
  blockNumber: 101n,
  blockHash,
  transactionIndex: 2,
  status: 'success',
  logs,
  ...overrides,
})
const replayRows = (sources, proofs) =>
  sources.map((source) => ({
    ...source,
    ...proofs.find((proof) => proof.logIndex === source.log_index),
    source_sha256: proofs.find((proof) => proof.logIndex === source.log_index).sourceSha256,
    evidence_sha256: proofs.find((proof) => proof.logIndex === source.log_index).evidenceSha256,
  }))
const reorderObjectKeys = (value) =>
  Array.isArray(value)
    ? value.map(reorderObjectKeys)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, nested]) => [key, reorderObjectKeys(nested)]),
        )
      : value

test('one exact external payment is receipt reconciled and replay certified', () => {
  const source = row()
  const proofs = reconcileTransaction(
    [source],
    receipt([withdraw(), transfer()]),
    header,
    finalized,
    asset,
  )
  assert.equal(proofs[0].status, 'reconciled_external_supplier')
  assert.equal(proofs[0].evidence.group.paidAssetsRaw, '100')
  assert.equal(verifyReconciliationProof(source, replayRows([source], proofs)[0]), true)
  assert.equal(verifySupplierGroups(replayRows([source], proofs)), true)
  const dbRoundTrip = replayRows([source], proofs).map((entry) => ({
    ...entry,
    evidence: reorderObjectKeys(entry.evidence),
  }))
  assert.equal(verifySupplierGroups(dbRoundTrip), true)
})

test('two Withdraw logs and split Transfer logs count one receiver group exactly', () => {
  const sources = [row(3, '60'), row(5, '40')]
  const proofs = reconcileTransaction(
    sources,
    receipt([withdraw(3, 60n), transfer(4, 55n), withdraw(5, 40n), transfer(6, 45n)]),
    header,
    finalized,
    asset,
  )
  assert.deepEqual(
    proofs.map((proof) => proof.status),
    ['reconciled_external_supplier', 'reconciled_external_supplier'],
  )
  assert.equal(proofs[0].evidence.group.withdrawAssetsRaw, '100')
  assert.equal(proofs[0].evidence.group.transferCount, 2)
  assert.equal(verifySupplierGroups(replayRows(sources, proofs)), true)
  assert.equal(verifySupplierGroups(replayRows(sources, proofs).slice(0, 1)), false)
})

test('extra underlying Transfer blocks reconciliation rather than double counting', () => {
  const proofs = reconcileTransaction(
    [row()],
    receipt([withdraw(), transfer(), transfer(5, 1n)]),
    header,
    finalized,
    asset,
  )
  assert.equal(proofs[0].status, 'ambiguous')
})

test('receipt identity, missing Withdraw, and failed receipt fail closed', () => {
  assert.equal(
    reconcileTransaction(
      [row()],
      receipt([withdraw(), transfer()], { blockHash: finalHash }),
      header,
      finalized,
      asset,
    )[0].status,
    'ambiguous',
  )
  assert.equal(
    reconcileTransaction([row()], receipt([transfer()]), header, finalized, asset)[0].status,
    'ambiguous',
  )
  assert.equal(
    reconcileTransaction(
      [row()],
      receipt([withdraw(), transfer()], { status: 'reverted' }),
      header,
      finalized,
      asset,
    )[0].status,
    'ambiguous',
  )
  assert.equal(
    reconcileTransaction([row()], receipt([withdraw(), transfer()]), header, finalized, vault)[0]
      .status,
    'ambiguous',
  )
})

test('large canonical receipt remains replayable within 256 KiB and oversize remains unavailable', () => {
  const unrelated = (index, repeated) => ({
    address: owner,
    blockNumber: 101n,
    blockHash,
    transactionHash: tx,
    transactionIndex: 2,
    logIndex: index,
    topics: [finalHash],
    data: `0x${'ab'.repeat(repeated)}`,
  })
  const accepted = reconcileTransaction(
    [row()],
    receipt([withdraw(), transfer(), unrelated(5, 40_000)]),
    header,
    finalized,
    asset,
  )
  assert.equal(accepted[0].status, 'reconciled_external_supplier')
  assert.equal(verifySupplierGroups(replayRows([row()], accepted)), true)
  const oversize = reconcileTransaction(
    [row()],
    receipt([withdraw(), transfer(), unrelated(5, 140_000)]),
    header,
    finalized,
    asset,
  )
  assert.equal(oversize[0].status, 'unavailable')
  assert.equal(oversize[0].reason, 'receipt_log_bound_exceeded')
})

test('ForceDeallocate and vault receivers never become external supplier flow', () => {
  const forceRow = row(3, '100', vault, true)
  assert.equal(
    reconcileTransaction(
      [forceRow],
      receipt([force(), withdraw(3, 100n, vault)]),
      header,
      finalized,
      asset,
    )[0].status,
    'internal_force_deallocate',
  )
  const mixed = [row(3, '100', vault, true), row(5, '50', receiver, true)]
  assert.deepEqual(
    reconcileTransaction(
      mixed,
      receipt([force(), withdraw(3, 100n, vault), withdraw(5, 50n, receiver), transfer(6, 50n)]),
      header,
      finalized,
      asset,
    ).map((proof) => proof.status),
    ['ambiguous', 'ambiguous'],
  )
  assert.equal(
    reconcileTransaction(
      [row(3, '100', vault)],
      receipt([withdraw(3, 100n, vault)]),
      header,
      finalized,
      asset,
    )[0].status,
    'internal_vault_receiver',
  )
})

test('stored proof rejects tampered source, group, and receipt logs', () => {
  const source = row()
  const proof = reconcileTransaction(
    [source],
    receipt([withdraw(), transfer()]),
    header,
    finalized,
    asset,
  )[0]
  const stored = replayRows([source], [proof])[0]
  assert.equal(verifyReconciliationProof({ ...stored, assets_raw: '101' }, stored), false)
  assert.equal(
    verifySupplierGroups([
      {
        ...stored,
        evidence: {
          ...stored.evidence,
          receiptLogs: [stored.evidence.receiptLogs[0]],
        },
      },
    ]),
    false,
  )
})

test('coverage requires a contiguous chain of block ranges and linked hashes', () => {
  const rows = [
    { from_block: '100', to_block: '101', prior_hash: blockHash, to_hash: finalHash },
    { from_block: '102', to_block: '104', prior_hash: finalHash, to_hash: blockHash },
  ]
  assert.equal(verifyCoverage(rows, 100, 104), true)
  assert.equal(verifyCoverage(rows.slice(0, 1), 100, 104), false)
  assert.equal(verifyCoverage([{ ...rows[1], from_block: '103' }, rows[0]], 100, 104), false)
  assert.equal(verifyCoverage([rows[0], { ...rows[1], prior_hash: blockHash }], 100, 104), false)
})

test('every interval boundary checks canonical RPC, including an empty interior interval', async () => {
  const a = `0x${'a'.repeat(64)}`
  const b = `0x${'b'.repeat(64)}`
  const c = `0x${'c'.repeat(64)}`
  const d = `0x${'d'.repeat(64)}`
  const intervals = [
    { from_block: '100', to_block: '101', prior_hash: a, to_hash: b },
    { from_block: '102', to_block: '103', prior_hash: b, to_hash: c },
    { from_block: '104', to_block: '105', prior_hash: c, to_hash: d },
  ]
  const canonical = new Map([
    ['99', a],
    ['101', b],
    ['103', c],
    ['105', d],
  ])
  const header = async (number) => ({ number, hash: canonical.get(String(number)) })
  assert.equal(verifyCoverage(intervals, 100, 105), true)
  assert.equal(await verifyCanonicalIntervalBoundaries(intervals, header), true)
  canonical.set('103', finalHash)
  assert.equal(await verifyCanonicalIntervalBoundaries(intervals, header), false)
})

test('ordinary recorder lag uses the canonical collected endpoint; stale capture is unavailable', () => {
  const current = { number: 120n, hash: finalHash, timestamp: 10_000n }
  const collected = { to_block: '110', to_hash: blockHash }
  const endpoint = { number: 110n, hash: blockHash, timestamp: 9_100n }
  assert.deepEqual(assessCollectedEndpoint(current, collected, endpoint, 10_100n), {
    status: 'usable',
    headLagSeconds: '900',
    finalizedHeadAgeSeconds: '100',
    collectedAgeSeconds: '1000',
  })
  assert.equal(
    assessCollectedEndpoint(
      { number: 120n, hash: finalHash, timestamp: 9_000n },
      collected,
      { number: 110n, hash: blockHash, timestamp: 2_000n },
      10_000n,
    ).reason,
    'collected_endpoint_stale',
  )
  assert.equal(
    assessCollectedEndpoint(current, collected, { ...endpoint, timestamp: 2_000n }, 10_100n).reason,
    'collected_endpoint_stale',
  )
  assert.equal(
    assessCollectedEndpoint(current, collected, { ...endpoint, hash: finalHash }, 10_100n).reason,
    'collected_endpoint_not_canonical',
  )
  assert.equal(
    assessCollectedEndpoint(current, collected, endpoint, 20_000n).reason,
    'finalized_head_stale',
  )
})

test('rolling maximum uses full windows and keeps venue flow separate from forecast', () => {
  const events = [
    { time: '100', assets_raw: '20' },
    { time: '120', assets_raw: '30' },
    { time: '180', assets_raw: '7' },
  ]
  assert.equal(maximumRollingFlow(events, 0, 200, 100), '57')
  assert.equal(maximumRollingFlow(events, 0, 50, 100), null)
  assert.equal(maximumRollingFlow([], 0, 200, 100), '0')
  const short = certifiedWindowMaxima([], 0, 2n * 86_400n)
  assert.equal(short['24h'].status, 'certified')
  assert.equal(short['7d'].status, 'unavailable')
})

test('same slot replay carries identical sealed evidence and no duplicate insertion', async () => {
  const source = row()
  const saved = new Map()
  let inserts = 0
  const sql = async (strings, ...values) => {
    const query = strings.join('?')
    if (query.includes('WITH latest AS')) return [{ vault, transaction_hash: tx, block: '101' }]
    if (query.includes('SELECT e.*')) return [source]
    if (query.includes('carry_morpho_v2_record_withdraw_reconciliation')) {
      const payload = JSON.parse(values[0])
      const key = `${payload.vault}:${payload.transactionHash}:${payload.logIndex}:${payload.attemptSlot}`
      if (saved.has(key)) {
        assert.deepEqual(payload, saved.get(key))
        return [{ inserted: false }]
      }
      saved.set(key, payload)
      inserts++
      return [{ inserted: true }]
    }
    throw new Error('unexpected_query')
  }
  const client = {
    getChainId: async () => 1,
    getBlock: async ({ blockTag }) => (blockTag === 'finalized' ? finalized : header),
    getTransactionReceipt: async () => receipt([withdraw(), transfer()]),
    call: async () => ({ data: encodeAbiParameters([{ type: 'address' }], [asset]) }),
  }
  const options = { dryRun: false, maxTransactions: 1, now: 900_000, clock: () => 0 }
  const first = await reconcilePending(sql, client, options)
  const second = await reconcilePending(sql, client, options)
  assert.equal(first.statuses.reconciled_external_supplier, 1)
  assert.equal(second.statuses.reconciled_external_supplier, 1)
  assert.equal(inserts, 1)
  assert.equal(saved.size, 1)
})
