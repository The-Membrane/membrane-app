// Reproduce the last two August Carry vault-to-asset bindings at one pinned
// finalized Ethereum block. This does not certify a withdrawal or forecast.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { parseAbi } from 'viem'

import { makeClient, readEnv } from '../lib/venue-reads.mjs'

const BLOCK = 26080019n
const HASH = '0xcba995492763cfa851b8de0ceabaf5fab922887d52eb5ee05a05c88c3332366e'
const USD3 = '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const TWYNE = '0x0af56afbddcb140323445bd7211ba90e54e5fd1c'
const PT = '0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34'
const ATOKEN = '0x01e69a58ca3ddc695820ce6f66fbdf3fa55d0545'
const IMPLEMENTATION = '0x41695d3304e38bc806f077a3541c5cd34f8f034b'
const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function aToken() view returns (address)',
  'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
])
const lower = (value) => String(value ?? '').toLowerCase()
const equal = (actual, expected, label) => {
  if (lower(actual) !== expected) throw new Error(label)
}

export async function verifyCarryUsd3TwyneIdentities(client) {
  if ((await client.getChainId()) !== 1) throw new Error('chain_mismatch')
  const finalized = await client.getBlock({ blockTag: 'finalized' })
  if (finalized.number < BLOCK) throw new Error('block_not_finalized')
  const block = await client.getBlock({ blockNumber: BLOCK })
  if (block.number !== BLOCK || lower(block.hash) !== HASH) throw new Error('block_hash_mismatch')
  const [usd3Asset, twyneAsset, twyneAToken, implementationSlot] = await Promise.all([
    client.readContract({ address: USD3, abi: ABI, functionName: 'asset', blockNumber: BLOCK }),
    client.readContract({ address: TWYNE, abi: ABI, functionName: 'asset', blockNumber: BLOCK }),
    client.readContract({ address: TWYNE, abi: ABI, functionName: 'aToken', blockNumber: BLOCK }),
    client.getStorageAt({ address: TWYNE, slot: EIP1967_IMPL_SLOT, blockNumber: BLOCK }),
  ])
  equal(usd3Asset, USDC, 'usd3_asset_mismatch')
  equal(twyneAsset, PT, 'twyne_asset_mismatch')
  equal(twyneAToken, ATOKEN, 'twyne_atoken_mismatch')
  if (!/^0x[0-9a-fA-F]{64}$/.test(implementationSlot ?? ''))
    throw new Error('implementation_slot_invalid')
  equal(`0x${implementationSlot.slice(-40)}`, IMPLEMENTATION, 'implementation_mismatch')
  const aTokenUnderlying = await client.readContract({
    address: ATOKEN,
    abi: ABI,
    functionName: 'UNDERLYING_ASSET_ADDRESS',
    blockNumber: BLOCK,
  })
  equal(aTokenUnderlying, PT, 'atoken_underlying_mismatch')
  const after = await client.getBlock({ blockNumber: BLOCK })
  if (after.number !== BLOCK || lower(after.hash) !== HASH) throw new Error('block_hash_changed')
  return {
    status: 'verified',
    chainId: 1,
    verificationBlock: Number(BLOCK),
    verificationBlockHash: HASH,
    usd3: { vault: USD3, asset: USDC },
    twyne: { vault: TWYNE, asset: PT, aToken: ATOKEN, implementation: IMPLEMENTATION },
    scope: 'vault_asset_and_wrapper_implementation_only',
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { get } = readEnv()
    const rpc =
      process.env.RECORDER_RPC_URLS ||
      process.env.RECORDER_RPC_URL ||
      get('RECORDER_RPC_URLS') ||
      get('RECORDER_RPC_URL')
    if (!rpc) throw new Error('rpc_missing')
    process.stdout.write(
      JSON.stringify(await verifyCarryUsd3TwyneIdentities(makeClient(rpc))) + '\n',
    )
  } catch {
    // Provider exceptions can contain credential-bearing RPC URLs.
    process.stderr.write('USD3/Twyne identity verification failed closed.\n')
    process.exitCode = 1
  }
}
