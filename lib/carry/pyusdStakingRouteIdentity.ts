import { keccak256, parseAbi, type Address, type PublicClient } from 'viem'

export const PYUSD_STAKING_ROUTE = 'PYUSD → StakingVault [wYLDS]' as const
export const HASTRA_STAKING_VAULT = '0x19ebb35279a16207ec4ba82799cc64715065f7f6' as Address
export const HASTRA_YIELD_VAULT = '0x6ad038ca6c04e885630851278ca0a856ad9a66cc' as Address
export const PYUSD_TOKEN = '0x6c3ea9036406852006290770bedfcaba0e23a0e8' as Address
export const USDC_TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address
const STAKING_IMPLEMENTATION = '0x881fe0e5e91c54fabbf0198a1bb2fc6e5747d4c5' as Address
const YIELD_IMPLEMENTATION = '0x06e0b9155a3cf07f41ac826ccfee7ef8413a9723' as Address
const PROXY_CODE_HASH = '0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6'
const STAKING_IMPLEMENTATION_CODE_HASH =
  '0x0e8044f306a768cfd365491bfb983ed4415c56263156d9a1a40b1341e56c4cae'
const YIELD_IMPLEMENTATION_CODE_HASH =
  '0x38dcc95686d703a0a5fa9f9cd707c5cdcc077879b5c60c0d63e4ff9264067851'
const IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const
const HASH = /^0x[0-9a-fA-F]{64}$/
const abi = parseAbi([
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
])

export type PyusdStakingIdentityClient = Pick<
  PublicClient,
  'getChainId' | 'getBlock' | 'getStorageAt' | 'getCode' | 'readContract'
>

export type PyusdStakingRouteIdentity = {
  status: 'route_asset_mismatch' | 'unsupported'
  reason: 'pyusd_leg_not_verified' | 'deployment_unattested' | 'identity_changed'
  routeKey: typeof PYUSD_STAKING_ROUTE
  destination: typeof HASTRA_STAKING_VAULT
  evidence: {
    chainId: 1
    blockNumber: number
    blockHash: `0x${string}`
    blockTimestamp: number
    stakingImplementation: Address | null
    yieldImplementation: Address | null
    stakingAsset: Address | null
    yieldAsset: Address | null
    stakingShareDecimals: number | null
    yieldShareDecimals: number | null
    stakingAssetDecimals: number | null
    yieldAssetDecimals: number | null
    pyusdDecimals: number | null
  }
  assetLinks: 'staking_asset_wYLDS_yield_asset_USDC' | null
  pyusdPayout: 'not_attested'
  holderAmountCheck: 'not_performed_route_incomplete'
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const fromSlot = (raw: `0x${string}` | undefined): Address | null =>
  raw && HASH.test(raw) && !/^0x0{64}$/i.test(raw)
    ? (`0x${raw.slice(26)}`.toLowerCase() as Address)
    : null

/** Route identity only: the frozen PYUSD label has no verified path from this vault to PYUSD. */
export async function readPyusdStakingRouteIdentity(
  client: PyusdStakingIdentityClient,
  nowMs = Date.now(),
): Promise<PyusdStakingRouteIdentity> {
  if ((await client.getChainId()) !== 1) throw new Error('pyusd_staking_chain_mismatch')
  const block = await client.getBlock({ blockTag: 'finalized' })
  const blockTimestamp = Number(block.timestamp)
  if (
    typeof block.number !== 'bigint' ||
    block.number < 0n ||
    block.number > BigInt(Number.MAX_SAFE_INTEGER) ||
    !HASH.test(block.hash ?? '') ||
    !Number.isSafeInteger(blockTimestamp) ||
    !Number.isSafeInteger(nowMs) ||
    nowMs - blockTimestamp * 1000 < -120_000 ||
    nowMs - blockTimestamp * 1000 > 7_200_000
  )
    throw new Error('pyusd_staking_finalized_block_unavailable')
  const pinned = { blockHash: block.hash!, requireCanonical: true as const }
  const confirmation = await client.getBlock({ blockNumber: block.number })
  if (confirmation.number !== block.number || !same(confirmation.hash ?? '', block.hash!))
    throw new Error('pyusd_staking_block_changed')
  const [
    stakingSlot,
    yieldSlot,
    stakingCode,
    yieldCode,
    stakingImplementationCode,
    yieldImplementationCode,
  ] = await Promise.all([
    client.getStorageAt({ address: HASTRA_STAKING_VAULT, slot: IMPLEMENTATION_SLOT, ...pinned }),
    client.getStorageAt({ address: HASTRA_YIELD_VAULT, slot: IMPLEMENTATION_SLOT, ...pinned }),
    client.getCode({ address: HASTRA_STAKING_VAULT, ...pinned }),
    client.getCode({ address: HASTRA_YIELD_VAULT, ...pinned }),
    client.getCode({ address: STAKING_IMPLEMENTATION, ...pinned }),
    client.getCode({ address: YIELD_IMPLEMENTATION, ...pinned }),
  ])
  const stakingImplementation = fromSlot(stakingSlot)
  const yieldImplementation = fromSlot(yieldSlot)
  const evidence: PyusdStakingRouteIdentity['evidence'] = {
    chainId: 1,
    blockNumber: Number(block.number),
    blockHash: block.hash!,
    blockTimestamp,
    stakingImplementation,
    yieldImplementation,
    stakingAsset: null,
    yieldAsset: null,
    stakingShareDecimals: null,
    yieldShareDecimals: null,
    stakingAssetDecimals: null,
    yieldAssetDecimals: null,
    pyusdDecimals: null,
  }
  const base = {
    routeKey: PYUSD_STAKING_ROUTE,
    destination: HASTRA_STAKING_VAULT,
    evidence,
    assetLinks: null,
    pyusdPayout: 'not_attested' as const,
    holderAmountCheck: 'not_performed_route_incomplete' as const,
  }
  if (
    !same(stakingImplementation ?? '', STAKING_IMPLEMENTATION) ||
    !same(yieldImplementation ?? '', YIELD_IMPLEMENTATION) ||
    !stakingCode ||
    !same(keccak256(stakingCode), PROXY_CODE_HASH) ||
    !yieldCode ||
    !same(keccak256(yieldCode), PROXY_CODE_HASH) ||
    !stakingImplementationCode ||
    !same(keccak256(stakingImplementationCode), STAKING_IMPLEMENTATION_CODE_HASH) ||
    !yieldImplementationCode ||
    !same(keccak256(yieldImplementationCode), YIELD_IMPLEMENTATION_CODE_HASH)
  )
    return { ...base, status: 'unsupported', reason: 'deployment_unattested' }

  const [
    stakingAsset,
    yieldAsset,
    stakingShareDecimals,
    wyldsDecimals,
    yieldAssetDecimals,
    pyusdDecimals,
  ] = await Promise.all([
    client.readContract({ address: HASTRA_STAKING_VAULT, abi, functionName: 'asset', ...pinned }),
    client.readContract({ address: HASTRA_YIELD_VAULT, abi, functionName: 'asset', ...pinned }),
    client.readContract({
      address: HASTRA_STAKING_VAULT,
      abi,
      functionName: 'decimals',
      ...pinned,
    }),
    client.readContract({ address: HASTRA_YIELD_VAULT, abi, functionName: 'decimals', ...pinned }),
    client.readContract({ address: USDC_TOKEN, abi, functionName: 'decimals', ...pinned }),
    client.readContract({ address: PYUSD_TOKEN, abi, functionName: 'decimals', ...pinned }),
  ])
  Object.assign(evidence, {
    stakingAsset,
    yieldAsset,
    stakingShareDecimals,
    yieldShareDecimals: wyldsDecimals,
    stakingAssetDecimals: wyldsDecimals,
    yieldAssetDecimals,
    pyusdDecimals,
  })
  if (
    !same(stakingAsset, HASTRA_YIELD_VAULT) ||
    !same(yieldAsset, USDC_TOKEN) ||
    stakingShareDecimals !== 6 ||
    wyldsDecimals !== 6 ||
    yieldAssetDecimals !== 6 ||
    pyusdDecimals !== 6
  )
    return { ...base, status: 'unsupported', reason: 'identity_changed' }
  return {
    ...base,
    status: 'route_asset_mismatch',
    reason: 'pyusd_leg_not_verified',
    assetLinks: 'staking_asset_wYLDS_yield_asset_USDC',
  }
}
