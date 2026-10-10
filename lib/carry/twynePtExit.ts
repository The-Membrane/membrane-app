import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem'

export const TWYNE_PT_ROUTE = 'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]' as const
export const TWYNE_PT_WRAPPER = '0x0af56afbddcb140323445bd7211ba90e54e5fd1c' as Address
export const TWYNE_PT_ASSET = '0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34' as Address
export const TWYNE_PT_ATOKEN = '0x01e69a58ca3ddc695820ce6f66fbdf3fa55d0545' as Address
export const TWYNE_AAVE_POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2' as Address
const WRAPPER_IMPLEMENTATION = '0x41695d3304e38bc806f077a3541c5cd34f8f034b' as Address
const ATOKEN_IMPLEMENTATION = '0xadc45df3cf1584624c97338bef33363bf5b97ada' as Address
const POOL_IMPLEMENTATION = '0x728a138a4823392c2efa55e028d434f526fe03cf' as Address
const PT_YT = '0xfe6040719cca36aeb85e352f48fe956057728814' as Address
const PT_SY = '0xc9bfebc79a722c05dc34bd2a227ef2db19fd1b8e' as Address
const PT_EXPIRY = 1_792_627_200
const IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const
const DEPLOYMENT_CODES = [
  [TWYNE_PT_WRAPPER, '0x815c4d3d433b86ca34f214b94aafd3660ed5cd228f0205cc77600da6679f0a11'],
  [WRAPPER_IMPLEMENTATION, '0xe3dca07a6a6730d4a8d90ed26b440937c3cbe51ca0f1e8a3f90c73e4cf2f8c62'],
  [TWYNE_PT_ASSET, '0x65e3bb254bd1e1ba2fb04f71ae9f8b30ec8e90ed5252b9d1719ced24620df5a3'],
  [TWYNE_PT_ATOKEN, '0x3935a620a6917734e2ab10f7d244650670b6d1af1e269359de8cc2aa62f583c8'],
  [ATOKEN_IMPLEMENTATION, '0x3bd38f9cd664b4169375c69f362dc585ed97adf6da6f8b6d5569ecb8690d9eb5'],
  [TWYNE_AAVE_POOL, '0x96107dc4006b4c7fecd1827cfb275ffeef31e6194cd50466f85f8eb24ccf2679'],
  [POOL_IMPLEMENTATION, '0x530cdbba5eb9487cd5d041bb74b7a1936ad3230bf9e361893ecd025373c7fbe5'],
] as const
const HASH = /^0x[0-9a-fA-F]{64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const RAW = /^[1-9][0-9]{0,77}$/
const MAX_U256 = (1n << 256n) - 1n
const abi = parseAbi([
  'function asset() view returns (address)',
  'function aToken() view returns (address)',
  'function POOL() view returns (address)',
  'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
  'function decimals() view returns (uint8)',
  'function YT() view returns (address)',
  'function SY() view returns (address)',
  'function expiry() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
  'function redeem(uint256,address,address) returns (uint256)',
])

export type TwynePtExitClient = Pick<
  PublicClient,
  'getChainId' | 'getBlock' | 'getStorageAt' | 'getCode' | 'readContract' | 'call'
>
export type TwynePtExitRequest = {
  routeKey: string
  destinationAddress: Address
  holder: Address
  assetsRaw: string
}
export type TwynePtExitResult = {
  status: 'component_observed' | 'unsupported'
  reason?: 'deployment_unattested' | 'identity_changed'
  routeKey: typeof TWYNE_PT_ROUTE
  destination: typeof TWYNE_PT_WRAPPER
  evidence: {
    chainId: 1
    blockNumber: number
    blockHash: `0x${string}`
    blockTimestamp: number
    wrapperImplementation: Address | null
    aTokenImplementation: Address | null
    poolImplementation: Address | null
    ptAsset: Address | null
    aToken: Address | null
    pool: Address | null
    ptDecimals: number | null
    wrapperDecimals: number | null
    yt: Address | null
    sy: Address | null
    ptExpiry: number | null
    ptMaturity: 'before_expiry' | 'at_or_after_expiry' | null
  }
  amountCheck?: {
    requestedPtRaw: string
    holderSharesRaw: string
    previewSharesToBurnRaw: string
    aavePtCashRaw: string
    simulation:
      | { status: 'success'; sharesBurnedRaw: string }
      | { status: 'evm_revert'; reason: 'unknown_execution_constraint' }
      | { status: 'position_insufficient' }
    redeemSimulation:
      | { status: 'success'; ptAssetsRaw: string }
      | { status: 'below_requested'; ptAssetsRaw: string }
      | { status: 'evm_revert'; reason: 'unknown_execution_constraint' }
      | { status: 'not_attempted' }
    ptDelivery: 'not_observed'
    ptToUsde: 'not_assessed'
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const fromSlot = (raw: `0x${string}` | undefined): Address | null =>
  raw && HASH.test(raw) && !/^0x0{64}$/i.test(raw)
    ? (`0x${raw.slice(26)}`.toLowerCase() as Address)
    : null
function isEvmRevert(error: unknown): boolean {
  const e = error as { name?: string; shortMessage?: string; message?: string; cause?: unknown }
  const detail = `${e?.shortMessage ?? ''} ${e?.message ?? ''}`.toLowerCase()
  if (/timeout|http request|network|gas limit|out of gas|rate limit/.test(detail)) return false
  if (e?.cause && e.cause !== error && !isEvmRevert(e.cause)) return false
  return (
    e?.name === 'ContractFunctionRevertedError' || /execution reverted|reverted with/.test(detail)
  )
}

/** Counterfactual wrapper component probe; the Twyne borrower exits through its collateral vault. */
export async function readTwynePtExit(
  client: TwynePtExitClient,
  input: TwynePtExitRequest,
  nowMs = Date.now(),
): Promise<TwynePtExitResult> {
  if (
    input.routeKey !== TWYNE_PT_ROUTE ||
    !same(input.destinationAddress, TWYNE_PT_WRAPPER) ||
    !ADDRESS.test(input.holder) ||
    !RAW.test(input.assetsRaw) ||
    BigInt(input.assetsRaw) > MAX_U256
  )
    throw new Error('twyne_pt_exit_request_invalid')
  if ((await client.getChainId()) !== 1) throw new Error('twyne_pt_exit_chain_mismatch')
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
    throw new Error('twyne_pt_exit_finalized_block_unavailable')
  const confirmation = await client.getBlock({ blockNumber: block.number })
  if (confirmation.number !== block.number || !same(confirmation.hash ?? '', block.hash!))
    throw new Error('twyne_pt_exit_block_changed')
  const pinned = { blockHash: block.hash!, requireCanonical: true as const }
  const [wrapperSlot, aTokenSlot, poolSlot, ...codes] = await Promise.all([
    client.getStorageAt({ address: TWYNE_PT_WRAPPER, slot: IMPLEMENTATION_SLOT, ...pinned }),
    client.getStorageAt({ address: TWYNE_PT_ATOKEN, slot: IMPLEMENTATION_SLOT, ...pinned }),
    client.getStorageAt({ address: TWYNE_AAVE_POOL, slot: IMPLEMENTATION_SLOT, ...pinned }),
    ...DEPLOYMENT_CODES.map(([address]) => client.getCode({ address, ...pinned })),
  ])
  const wrapperImplementation = fromSlot(wrapperSlot)
  const aTokenImplementation = fromSlot(aTokenSlot)
  const poolImplementation = fromSlot(poolSlot)
  const evidence: TwynePtExitResult['evidence'] = {
    chainId: 1,
    blockNumber: Number(block.number),
    blockHash: block.hash!,
    blockTimestamp,
    wrapperImplementation,
    aTokenImplementation,
    poolImplementation,
    ptAsset: null,
    aToken: null,
    pool: null,
    ptDecimals: null,
    wrapperDecimals: null,
    yt: null,
    sy: null,
    ptExpiry: null,
    ptMaturity: null,
  }
  const base = { routeKey: TWYNE_PT_ROUTE, destination: TWYNE_PT_WRAPPER, evidence }
  if (
    !same(wrapperImplementation ?? '', WRAPPER_IMPLEMENTATION) ||
    !same(aTokenImplementation ?? '', ATOKEN_IMPLEMENTATION) ||
    !same(poolImplementation ?? '', POOL_IMPLEMENTATION) ||
    codes.some((code) => !code) ||
    codes.some((code, i) => !same(keccak256(code!), DEPLOYMENT_CODES[i][1]))
  )
    return { ...base, status: 'unsupported', reason: 'deployment_unattested' }
  const [
    ptAsset,
    aToken,
    wrapperPool,
    aTokenUnderlying,
    aTokenPool,
    ptDecimals,
    wrapperDecimals,
    yt,
    sy,
    expiryRaw,
  ] = await Promise.all([
    client.readContract({ address: TWYNE_PT_WRAPPER, abi, functionName: 'asset', ...pinned }),
    client.readContract({ address: TWYNE_PT_WRAPPER, abi, functionName: 'aToken', ...pinned }),
    client.readContract({ address: TWYNE_PT_WRAPPER, abi, functionName: 'POOL', ...pinned }),
    client.readContract({
      address: TWYNE_PT_ATOKEN,
      abi,
      functionName: 'UNDERLYING_ASSET_ADDRESS',
      ...pinned,
    }),
    client.readContract({ address: TWYNE_PT_ATOKEN, abi, functionName: 'POOL', ...pinned }),
    client.readContract({ address: TWYNE_PT_ASSET, abi, functionName: 'decimals', ...pinned }),
    client.readContract({ address: TWYNE_PT_WRAPPER, abi, functionName: 'decimals', ...pinned }),
    client.readContract({ address: TWYNE_PT_ASSET, abi, functionName: 'YT', ...pinned }),
    client.readContract({ address: TWYNE_PT_ASSET, abi, functionName: 'SY', ...pinned }),
    client.readContract({ address: TWYNE_PT_ASSET, abi, functionName: 'expiry', ...pinned }),
  ])
  evidence.ptAsset = ptAsset
  evidence.aToken = aToken
  evidence.pool = wrapperPool
  evidence.ptDecimals = ptDecimals
  evidence.wrapperDecimals = wrapperDecimals
  evidence.yt = yt
  evidence.sy = sy
  evidence.ptExpiry = Number(expiryRaw)
  evidence.ptMaturity = blockTimestamp < Number(expiryRaw) ? 'before_expiry' : 'at_or_after_expiry'
  if (
    !same(ptAsset, TWYNE_PT_ASSET) ||
    !same(aToken, TWYNE_PT_ATOKEN) ||
    !same(wrapperPool, TWYNE_AAVE_POOL) ||
    !same(aTokenUnderlying, TWYNE_PT_ASSET) ||
    !same(aTokenPool, TWYNE_AAVE_POOL) ||
    ptDecimals !== 18 ||
    wrapperDecimals !== 18 ||
    !same(yt, PT_YT) ||
    !same(sy, PT_SY) ||
    expiryRaw !== BigInt(PT_EXPIRY)
  )
    return { ...base, status: 'unsupported', reason: 'identity_changed' }
  const q = BigInt(input.assetsRaw)
  const [holderShares, sharesNeeded, aavePtCash] = await Promise.all([
    client.readContract({
      address: TWYNE_PT_WRAPPER,
      abi,
      functionName: 'balanceOf',
      args: [input.holder],
      ...pinned,
    }),
    client.readContract({
      address: TWYNE_PT_WRAPPER,
      abi,
      functionName: 'previewWithdraw',
      args: [q],
      ...pinned,
    }),
    client.readContract({
      address: TWYNE_PT_ASSET,
      abi,
      functionName: 'balanceOf',
      args: [TWYNE_PT_ATOKEN],
      ...pinned,
    }),
  ])
  if (sharesNeeded <= 0n) throw new Error('twyne_pt_exit_preview_invalid')
  const amountCheck: NonNullable<TwynePtExitResult['amountCheck']> = {
    requestedPtRaw: input.assetsRaw,
    holderSharesRaw: holderShares.toString(),
    previewSharesToBurnRaw: sharesNeeded.toString(),
    aavePtCashRaw: aavePtCash.toString(),
    simulation: { status: 'position_insufficient' },
    redeemSimulation: { status: 'not_attempted' },
    ptDelivery: 'not_observed',
    ptToUsde: 'not_assessed',
  }
  if (holderShares >= sharesNeeded) {
    const data = encodeFunctionData({
      abi,
      functionName: 'withdraw',
      args: [q, input.holder, input.holder],
    })
    try {
      const result = await client.call({
        to: TWYNE_PT_WRAPPER,
        data,
        account: input.holder,
        ...pinned,
      })
      if (!result.data) throw new Error('twyne_pt_exit_empty_simulation')
      const burned = decodeFunctionResult({ abi, functionName: 'withdraw', data: result.data })
      if (burned <= 0n || burned > holderShares) throw new Error('twyne_pt_exit_bad_simulation')
      amountCheck.simulation = { status: 'success', sharesBurnedRaw: burned.toString() }
    } catch (error) {
      if (!isEvmRevert(error)) throw error
      amountCheck.simulation = { status: 'evm_revert', reason: 'unknown_execution_constraint' }
    }
    const redeemData = encodeFunctionData({
      abi,
      functionName: 'redeem',
      args: [sharesNeeded, input.holder, input.holder],
    })
    try {
      const result = await client.call({
        to: TWYNE_PT_WRAPPER,
        data: redeemData,
        account: input.holder,
        ...pinned,
      })
      if (!result.data) throw new Error('twyne_pt_exit_empty_redeem_simulation')
      const assets = decodeFunctionResult({ abi, functionName: 'redeem', data: result.data })
      if (assets <= 0n) throw new Error('twyne_pt_exit_bad_redeem_simulation')
      amountCheck.redeemSimulation = {
        status: assets >= q ? 'success' : 'below_requested',
        ptAssetsRaw: assets.toString(),
      }
    } catch (error) {
      if (!isEvmRevert(error)) throw error
      amountCheck.redeemSimulation = {
        status: 'evm_revert',
        reason: 'unknown_execution_constraint',
      }
    }
  }
  return { ...base, status: 'component_observed', amountCheck }
}
