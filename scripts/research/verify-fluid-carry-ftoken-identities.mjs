// Reproduce the three August Carry Fluid fToken-to-underlying bindings from
// Fluid's Ethereum lending factory at one finalized, hash-checked block.
// This is contract identity evidence, not a holder-exit or forecast proof.
// node scripts/research/verify-fluid-carry-ftoken-identities.mjs
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAbi } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const MANIFEST = resolve(ROOT, 'lib/carry/other-vault-asset-identities.json')
const FACTORY = '0x54b91a0d94cb471f37f949c60f7fa7935b551d03'
const BLOCK = 26079829n
const BLOCK_HASH = '0xc46931b3ea03a1b67482fcf4f7239f027a17c7a4526922017c40fe12c60d1a6b'
const EXPECTED = new Map([
  ['0x9fb7b4477576fe5b32be4c1843afb1e55f251b33', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'],
  ['0x5c20b550819128074fd538edf79791733ccedd18', '0xdac17f958d2ee523a2206206994597c13d831ec7'],
  ['0x6a29a46e21c730dca1d8b23d637c101cec605c5b', '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f'],
])
const ADDRESS = /^0x[0-9a-f]{40}$/
const ABI = parseAbi([
  'function computeToken(address asset_, string fTokenType_) view returns (address token_)',
  'function allTokens() view returns (address[])',
  'function asset() view returns (address)',
])
const lower = (value) => String(value || '').toLowerCase()

function fail(code) {
  throw new Error(code)
}

export function validateFluidEntries(manifest) {
  if (manifest?.schemaVersion !== 1 || manifest.chainId !== 1 || !Array.isArray(manifest.entries))
    fail('manifest_metadata_invalid')
  const entries = manifest.entries.filter(
    (entry) => entry.evidenceKind === 'fluid_factory_computed_and_listed',
  )
  if (entries.length !== EXPECTED.size) fail('fluid_entry_count_invalid')
  const seen = new Set()
  for (const entry of entries) {
    if (
      !ADDRESS.test(entry.vault) ||
      !ADDRESS.test(entry.asset) ||
      seen.has(entry.vault) ||
      entry.asset !== EXPECTED.get(entry.vault) ||
      entry.factory !== FACTORY ||
      entry.verificationBlock !== Number(BLOCK) ||
      entry.verificationBlockHash !== BLOCK_HASH
    )
      fail('fluid_manifest_entry_invalid')
    seen.add(entry.vault)
  }
  if (seen.size !== EXPECTED.size || [...EXPECTED.keys()].some((vault) => !seen.has(vault)))
    fail('fluid_manifest_set_invalid')
  return entries
}

export async function verifyFluidCarryFtokens({ client, manifest }) {
  const entries = validateFluidEntries(manifest)
  if ((await client.getChainId()) !== 1) fail('chain_mismatch')
  const finalized = await client.getBlock({ blockTag: 'finalized' })
  if (finalized.number < BLOCK) fail('block_not_finalized')
  const block = await client.getBlock({ blockNumber: BLOCK })
  if (lower(block.hash) !== BLOCK_HASH || block.number !== BLOCK) fail('block_hash_mismatch')

  const listed = await client.readContract({
    address: FACTORY,
    abi: ABI,
    functionName: 'allTokens',
    blockNumber: BLOCK,
  })
  if (!Array.isArray(listed)) fail('factory_list_invalid')
  const members = new Set(listed.map(lower))
  for (const entry of entries) {
    const [computed, observedAsset] = await Promise.all([
      client.readContract({
        address: FACTORY,
        abi: ABI,
        functionName: 'computeToken',
        args: [entry.asset, 'fToken'],
        blockNumber: BLOCK,
      }),
      client.readContract({
        address: entry.vault,
        abi: ABI,
        functionName: 'asset',
        blockNumber: BLOCK,
      }),
    ])
    if (lower(computed) !== entry.vault) fail('factory_computation_mismatch')
    if (!members.has(entry.vault)) fail('factory_membership_missing')
    if (lower(observedAsset) !== entry.asset) fail('vault_asset_mismatch')
  }
  const after = await client.getBlock({ blockNumber: BLOCK })
  if (lower(after.hash) !== BLOCK_HASH || after.number !== BLOCK) fail('block_hash_changed')
  return {
    status: 'verified',
    chainId: 1,
    factory: FACTORY,
    verificationBlock: Number(BLOCK),
    verificationBlockHash: BLOCK_HASH,
    fTokenAssetPairs: entries.length,
    scope: 'factory_computation_membership_and_vault_asset_only',
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
    const rpc =
      process.env.RECORDER_RPC_URLS ||
      process.env.RECORDER_RPC_URL ||
      readEnv().get('RECORDER_RPC_URLS') ||
      readEnv().get('RECORDER_RPC_URL')
    if (!rpc) fail('rpc_missing')
    const result = await verifyFluidCarryFtokens({ client: makeClient(rpc), manifest })
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch {
    // Provider exceptions may contain credential-bearing RPC URLs.
    process.stderr.write('Fluid fToken identity verification failed closed.\n')
    process.exitCode = 1
  }
}
