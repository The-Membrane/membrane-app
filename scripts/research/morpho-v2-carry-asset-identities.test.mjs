import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { encodeAbiParameters, encodeEventTopics } from 'viem'
import { EVENT, FACTORY, TOPIC0 } from './morpho-v2-factory-census.mjs'
import {
  SOURCE_SHA256,
  loadSelection,
  selectCandidates,
  selectManifestCandidates,
  verifyCandidates,
} from './morpho-v2-carry-asset-identities.mjs'

const blockHash = `0x${'a'.repeat(64)}`
const txHash = `0x${'b'.repeat(64)}`
const pinHash = `0x${'c'.repeat(64)}`
const salt = `0x${'d'.repeat(64)}`
const owner = `0x${'1'.repeat(40)}`
const asset = `0x${'2'.repeat(40)}`
const vault = `0x${'3'.repeat(40)}`
const event = {
  block: 10,
  blockHash,
  transactionIndex: 2,
  txHash,
  logIndex: 5,
  timestamp: 100,
  owner,
  asset,
  vault,
  salt,
}
const log = {
  address: FACTORY,
  blockNumber: 10n,
  blockHash,
  transactionIndex: 2,
  transactionHash: txHash,
  logIndex: 5,
  topics: encodeEventTopics({
    abi: [EVENT],
    eventName: 'CreateVaultV2',
    args: { owner, asset, newVaultV2: vault },
  }),
  data: encodeAbiParameters([{ type: 'bytes32' }], [salt]),
}
const selection = { cohortId: 'test', sourceSha256: 'f'.repeat(64), candidates: [event] }
function client(overrides = {}) {
  return {
    getChainId: async () => 1,
    getBlock: async ({ blockTag }) =>
      blockTag === 'finalized'
        ? { number: 20n, hash: pinHash, timestamp: 200n }
        : { number: 10n, hash: blockHash, timestamp: 100n },
    getTransactionReceipt: async () => ({
      status: 'success',
      blockHash,
      blockNumber: 10n,
      transactionHash: txHash,
      transactionIndex: 2,
      logs: [log],
    }),
    ...overrides,
  }
}

test('accepts only exact canonical receipt, header, event and asset identity', async () => {
  const result = await verifyCandidates({ client: client(), selection })
  assert.equal(result.entries.length, 1)
  assert.deepEqual(result.entries[0], {
    vault,
    asset,
    creation: { blockNumber: 10, blockHash, txHash, transactionIndex: 2, logIndex: 5 },
  })
  assert.equal(result.verification.blockNumber, 20)
  await assert.rejects(
    verifyCandidates({
      client: client({ getBlock: async () => ({ number: null, hash: pinHash, timestamp: 200n }) }),
      selection,
    }),
    /invalid_verification_block/,
  )
  await assert.rejects(
    verifyCandidates({ client: client({ getChainId: async () => 137 }), selection }),
    /wrong_chain/,
  )
  await assert.rejects(
    verifyCandidates({
      client: client({
        getTransactionReceipt: async () => ({
          status: 'success',
          blockHash,
          blockNumber: 10n,
          transactionHash: txHash,
          transactionIndex: 2,
          logs: [{ ...log, data: encodeAbiParameters([{ type: 'bytes32' }], [pinHash]) }],
        }),
      }),
      selection,
    }),
    /factory_event_payload_mismatch/,
  )
  await assert.rejects(
    verifyCandidates({
      client: client({
        getTransactionReceipt: async () => ({
          status: 'success',
          blockHash,
          blockNumber: 10n,
          transactionHash: txHash,
          transactionIndex: 2,
          logs: [],
        }),
      }),
      selection,
    }),
    /factory_log_missing_or_duplicate/,
  )
  await assert.rejects(
    verifyCandidates({
      client: client({
        getBlock: async () => ({
          number: 10n,
          hash: pinHash,
          timestamp: 100n,
        }),
      }),
      selection,
    }),
    /factory_receipt_coordinate_mismatch/,
  )
})

test('source selection excludes other factory vaults and refuses cohort drift', () => {
  const morpho = Array.from({ length: 7 }, (_, i) => `Route ${i} → VaultV2 [USDC]`)
  const other = Array.from({ length: 18 }, (_, i) => `Other ${i}`)
  const boardSource = [...morpho, ...other].map((routeKey) => `routeKey: '${routeKey}',`).join('\n')
  const positions = Array.from({ length: 63 }, (_, i) => ({
    vault: `0x${(i + 1).toString(16).padStart(40, '0')}`,
    routeIds: [i < 49 ? morpho[i % morpho.length] : other[i - 49]],
  }))
  const events = positions.slice(0, 49).map((position) => ({ ...event, vault: position.vault }))
  const args = {
    boardSource,
    seed: { cohortId: 'test', positions },
    census: {
      status: 'complete',
      factory: FACTORY,
      topic0: TOPIC0,
      events: [...events, { ...event, vault: positions[50].vault }],
    },
    sourceHash: SOURCE_SHA256,
  }
  assert.equal(selectCandidates(args).candidates.length, 49)
  assert.throws(
    () =>
      selectCandidates({
        ...args,
        census: {
          ...args.census,
          events: events.slice(1),
        },
      }),
    /missing_factory_event/,
  )
  assert.throws(
    () =>
      selectCandidates({
        ...args,
        seed: {
          ...args.seed,
          positions: positions.slice(1),
        },
      }),
    /displayed_cohort_changed/,
  )
  assert.throws(
    () =>
      selectCandidates({
        ...args,
        census: {
          ...args.census,
          events: [...events, events[0]],
        },
      }),
    /duplicate_factory_event/,
  )
})

test('ignored census absent: tracked manifest has exact displayed membership', () => {
  const manifest = JSON.parse(readFileSync('lib/carry/morpho-v2-asset-identities.json', 'utf8'))
  const seed = JSON.parse(readFileSync('scripts/route-cohort/aug-2026-ab-vault-seed.json', 'utf8'))
  const boardSource = readFileSync('components/Carry/fixtures.ts', 'utf8')
  const args = { boardSource, seed, manifest }
  const selection = selectManifestCandidates(args)
  assert.equal(selection.provenance, 'manifest')
  assert.equal(selection.candidates.length, 49)
  assert.deepEqual(
    loadSelection(manifest, join(tmpdir(), 'nonexistent-morpho-factory-census.json')),
    selection,
  )
  assert.throws(
    () =>
      selectManifestCandidates({
        ...args,
        manifest: {
          ...manifest,
          entries: manifest.entries.slice(1),
        },
      }),
    /manifest_cohort_incomplete/,
  )
  assert.throws(
    () =>
      selectManifestCandidates({
        ...args,
        manifest: {
          ...manifest,
          entries: [...manifest.entries.slice(1), manifest.entries[1]],
        },
      }),
    /invalid_manifest_entry/,
  )
  assert.throws(
    () =>
      selectManifestCandidates({
        ...args,
        manifest: {
          ...manifest,
          sourceArtifact: { ...manifest.sourceArtifact, sha256: 'f'.repeat(64) },
        },
      }),
    /invalid_manifest_metadata/,
  )
})

test('receipt replay refutes an altered manifest asset or creation coordinate', async () => {
  const manifestSelection = { ...selection, provenance: 'manifest' }
  assert.equal(
    (await verifyCandidates({ client: client(), selection: manifestSelection })).entries[0].asset,
    asset,
  )
  await assert.rejects(
    verifyCandidates({
      client: client(),
      selection: {
        ...manifestSelection,
        candidates: [{ ...event, asset: owner }],
      },
    }),
    /factory_event_payload_mismatch/,
  )
  await assert.rejects(
    verifyCandidates({
      client: client(),
      selection: {
        ...manifestSelection,
        candidates: [{ ...event, txHash: pinHash }],
      },
    }),
    /factory_receipt_coordinate_mismatch/,
  )
})
