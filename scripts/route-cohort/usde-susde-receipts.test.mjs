import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem'

import {
  COHORT_SIZE,
  POOL,
  ROUTE,
  SOURCE_SHA256,
  SUSDE,
  USDE,
  attestReceipt,
  collectReceipts,
  validateAttestation,
  validateSourceAndSeed,
} from './usde-susde-receipts.mjs'

const BORROW = parseAbiItem(
  'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
)
const OWNER = '0x086eb9c2b14dd657ae77d07df9115a2f946ce327'
const TX = `0x${'12'.repeat(32)}`
const BLOCK_HASH = `0x${'34'.repeat(32)}`
const sha = (value) => createHash('sha256').update(value).digest('hex')
const row = { owner: OWNER, vault: SUSDE, tx: TX, block: 25_000_000, amountRaw: '1' }

function receipt(options = {}) {
  const reserve = options.reserve ?? USDE
  const owner = options.owner ?? OWNER
  const mode = options.mode ?? 2
  const amount = options.amount ?? 1n
  const topics = encodeEventTopics({
    abi: [BORROW],
    eventName: 'Borrow',
    args: { reserve, onBehalfOf: owner, referralCode: 0 },
  })
  const data = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'uint256' }],
    [OWNER, amount, mode, 0n],
  )
  return {
    status: options.status ?? 'success',
    transactionHash: options.tx ?? TX,
    blockNumber: options.block ?? row.block,
    blockHash: BLOCK_HASH,
    logs: options.logs ?? [{ address: options.pool ?? POOL, topics, data, logIndex: 0 }],
  }
}

function fixture() {
  const source = JSON.stringify([
    {
      proto: 'Aave V3',
      borrower: OWNER,
      block: row.block,
      tx: TX,
      asset: USDE,
      market: null,
      amt: '100',
      dest: SUSDE,
      destKind: 'vault',
      route: ROUTE,
    },
  ])
  const seed = JSON.stringify({
    schemaVersion: 1,
    cohortId: 'aug-2026-ab-vault-routes',
    source: { name: 'routes_ab.json', sha256: sha(source) },
    positions: [{ owner: OWNER, vault: SUSDE, routeIds: [ROUTE] }],
  })
  return { source, seed, expected: { sourceSha256: sha(source), seedSha256: sha(seed), count: 1 } }
}

const LOCAL_SOURCE =
  '/Users/EBmic/.claude/projects/-Users-EBmic-membrane-solidity/lending-scan/routes_ab.json'

test(
  'physical August source/seed select all 25 exact seeded USDe→sUSDe pairs',
  {
    skip: !existsSync(LOCAL_SOURCE),
  },
  () => {
    const source = readFileSync(LOCAL_SOURCE)
    const seed = readFileSync(new URL('./aug-2026-ab-vault-seed.json', import.meta.url))
    const cohort = validateSourceAndSeed(source, seed)
    assert.equal(cohort.sourceSha256, SOURCE_SHA256)
    assert.equal(cohort.observations.length, COHORT_SIZE)
    assert.equal(new Set(cohort.observations.map((item) => item.owner)).size, COHORT_SIZE)
  },
)

test('physical source hash mismatch is fatal before receipt collection', () => {
  const { source, seed, expected } = fixture()
  assert.throws(
    () => validateSourceAndSeed(`${source} `, seed, expected),
    /usde_source_or_seed_hash_mismatch/,
  )
})

test('unknown or quiet source is not silently published as zero', () => {
  const { source, seed, expected } = fixture()
  const empty = JSON.stringify([])
  const emptySeed = JSON.stringify({
    ...JSON.parse(seed),
    source: { name: 'routes_ab.json', sha256: sha(empty) },
  })
  assert.throws(
    () =>
      validateSourceAndSeed(empty, emptySeed, {
        ...expected,
        sourceSha256: sha(empty),
        seedSha256: sha(emptySeed),
      }),
    /usde_cohort_count_mismatch/,
  )
  assert.equal(validateSourceAndSeed(source, seed, expected).observations.length, 1)
})

test('successful exact Pool Borrow receipt is attested', () => {
  const proof = attestReceipt(row, receipt())
  assert.equal(proof.tx, TX)
  assert.equal(proof.log.address, POOL)
  assert.equal(proof.status, 'success')
})

test('wrong Pool, reserve, owner, or non-variable mode does not attest', () => {
  for (const changed of [
    { pool: USDE },
    { reserve: SUSDE },
    { owner: USDE },
    { mode: 1 },
    { amount: 0n },
    { amount: 2n },
  ]) {
    assert.throws(
      () => attestReceipt(row, receipt(changed)),
      /usde_pool_borrow_unproved_or_ambiguous/,
    )
  }
})

test('a second Borrow in the same transaction cannot stand in for the source amount', () => {
  const wrongAmount = receipt({ amount: 2n }).logs[0]
  const exactAmount = { ...receipt().logs[0], logIndex: 1 }
  const proof = attestReceipt(row, receipt({ logs: [wrongAmount, exactAmount] }))
  assert.equal(proof.log.logIndex, 1)
  assert.throws(
    () => attestReceipt(row, receipt({ logs: [wrongAmount] })),
    /usde_pool_borrow_unproved_or_ambiguous/,
  )
})

test('missing, failed, wrong tx, wrong block, and ambiguous receipts are not zero', () => {
  assert.throws(() => attestReceipt(row, null), /usde_receipt_missing_or_mismatched/)
  assert.throws(
    () => attestReceipt(row, receipt({ status: 'reverted' })),
    /usde_receipt_missing_or_mismatched/,
  )
  assert.throws(
    () => attestReceipt(row, receipt({ tx: BLOCK_HASH })),
    /usde_receipt_missing_or_mismatched/,
  )
  assert.throws(
    () => attestReceipt(row, receipt({ block: row.block + 1 })),
    /usde_receipt_missing_or_mismatched/,
  )
  const duplicate = receipt()
  duplicate.logs.push({ ...duplicate.logs[0], logIndex: 1 })
  assert.throws(() => attestReceipt(row, duplicate), /usde_pool_borrow_unproved_or_ambiguous/)
})

test('collection uses chain 1 and rejects unknown receipt without emitting a row', async () => {
  const cohort = { sourceSha256: SOURCE_SHA256, seedSha256: sha('seed'), observations: [row] }
  await assert.rejects(
    () => collectReceipts({ getChainId: async () => 10 }, cohort),
    /usde_wrong_chain/,
  )
  await assert.rejects(
    () =>
      collectReceipts(
        { getChainId: async () => 1, getTransactionReceipt: async () => null },
        cohort,
      ),
    /usde_receipt_missing_or_mismatched/,
  )
})

test('sealed result verifies offline and rejects modified proof/hash', async () => {
  const cohort = { sourceSha256: SOURCE_SHA256, seedSha256: sha('seed'), observations: [row] }
  const client = { getChainId: async () => 1, getTransactionReceipt: async () => receipt() }
  const attested = await collectReceipts(client, cohort, '2026-09-27T00:00:00.000Z')
  assert.equal(validateAttestation(attested, cohort).checked, 1)
  assert.throws(
    () => validateAttestation({ ...attested, checked: 0 }, cohort),
    /usde_attestation_header_invalid/,
  )
  assert.throws(
    () =>
      validateAttestation(
        { ...attested, proofs: [{ ...attested.proofs[0], tx: BLOCK_HASH }] },
        cohort,
      ),
    /usde_attestation_hash_mismatch/,
  )
})
