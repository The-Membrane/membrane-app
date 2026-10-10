import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  validateFluidEntries,
  verifyFluidCarryFtokens,
} from './verify-fluid-carry-ftoken-identities.mjs'

const manifest = JSON.parse(readFileSync('lib/carry/other-vault-asset-identities.json', 'utf8'))
const entries = validateFluidEntries(manifest)
const block = BigInt(entries[0].verificationBlock)
const hash = entries[0].verificationBlockHash
const altered = (entry, changes) => ({
  ...manifest,
  entries: manifest.entries.map((candidate) =>
    candidate === entry ? { ...candidate, ...changes } : candidate,
  ),
})

function client(overrides = {}) {
  let calls = 0
  return {
    getChainId: async () => overrides.chainId ?? 1,
    getBlock: async ({ blockTag, blockNumber }) => {
      if (blockTag === 'finalized') return { number: overrides.finalized ?? block + 1n }
      assert.equal(blockNumber, block)
      calls += 1
      return {
        number: block,
        hash: calls === 1 ? (overrides.blockHash ?? hash) : (overrides.afterHash ?? hash),
      }
    },
    readContract: async ({ address, functionName, args, blockNumber }) => {
      assert.equal(blockNumber, block)
      if (functionName === 'allTokens') {
        assert.equal(address, entries[0].factory)
        return overrides.members ?? entries.map((entry) => entry.vault)
      }
      if (functionName === 'computeToken') {
        assert.equal(args[1], 'fToken')
        return overrides.computed ?? entries.find((entry) => entry.asset === args[0])?.vault
      }
      assert.equal(functionName, 'asset')
      return overrides.observedAsset ?? entries.find((entry) => entry.vault === address)?.asset
    },
  }
}

test('the fixed three-pair manifest rejects wrong vault, asset and pinned block hash', () => {
  assert.equal(entries.length, 3)
  assert.throws(
    () =>
      validateFluidEntries(
        altered(entries[0], {
          vault: '0x0000000000000000000000000000000000000001',
        }),
      ),
    /fluid_manifest_entry_invalid/,
  )
  assert.throws(
    () =>
      validateFluidEntries(
        altered(entries[0], {
          asset: '0x0000000000000000000000000000000000000001',
        }),
      ),
    /fluid_manifest_entry_invalid/,
  )
  assert.throws(
    () =>
      validateFluidEntries(
        altered(entries[0], {
          verificationBlockHash: `0x${'0'.repeat(64)}`,
        }),
      ),
    /fluid_manifest_entry_invalid/,
  )
})

test('same-block factory computation, membership and asset all agree', async () => {
  const result = await verifyFluidCarryFtokens({ client: client(), manifest })
  assert.equal(result.status, 'verified')
  assert.equal(result.fTokenAssetPairs, 3)
})

test('fails closed on chain, finality, block hash, factory address and membership failures', async () => {
  await assert.rejects(
    verifyFluidCarryFtokens({ client: client({ chainId: 10 }), manifest }),
    /chain_mismatch/,
  )
  await assert.rejects(
    verifyFluidCarryFtokens({ client: client({ finalized: block - 1n }), manifest }),
    /block_not_finalized/,
  )
  await assert.rejects(
    verifyFluidCarryFtokens({ client: client({ blockHash: `0x${'0'.repeat(64)}` }), manifest }),
    /block_hash_mismatch/,
  )
  await assert.rejects(
    verifyFluidCarryFtokens({ client: client({ afterHash: `0x${'0'.repeat(64)}` }), manifest }),
    /block_hash_changed/,
  )
  await assert.rejects(
    verifyFluidCarryFtokens({ client: client({ computed: entries[1].vault }), manifest }),
    /factory_computation_mismatch/,
  )
  await assert.rejects(
    verifyFluidCarryFtokens({
      client: client({ members: entries.slice(1).map((entry) => entry.vault) }),
      manifest,
    }),
    /factory_membership_missing/,
  )
  await assert.rejects(
    verifyFluidCarryFtokens({ client: client({ observedAsset: entries[1].asset }), manifest }),
    /vault_asset_mismatch/,
  )
})
