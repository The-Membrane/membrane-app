import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem'

import { isEoaTransactionOriginCode } from './holderOriginCode'

// The tracked August cohort contains GHO → UmbrellaStakeToken [GHO] at this proxy.
// The implementation address is the verified stkGHO.v1 implementation, not a generic ERC4626.
export const UMBRELLA_GHO_ROUTE = 'GHO → UmbrellaStakeToken [GHO]'
export const UMBRELLA_STKGHO = '0x4f827a63755855cdf3e8f3bcd20265c833f15033' as Address
export const ORIGINAL_GHO = '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f' as Address
export const VERIFIED_STKGHO_IMPLEMENTATION =
  '0x75e8ac0c063b6966e2a9954adedf39bde9370197' as Address

const IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const MAX_AGE_MS = 2 * 60 * 60 * 1000
const MAX_UINT256 = (1n << 256n) - 1n
const RAW_AMOUNT = /^[1-9][0-9]{0,77}$/
const MAX_CALL_GAS = 20_000_000n
const vaultAbi = parseAbi([
  'function asset() view returns (address)',
  'function paused() view returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function getCooldown() view returns (uint256)',
  'function getUnstakeWindow() view returns (uint256)',
  'function getStakerCooldown(address) view returns (uint192 amount, uint32 endOfCooldown, uint32 withdrawalWindow)',
  'function maxRedeem(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
  'function getMaxSlashableAssets() view returns (uint256)',
  'function redeem(uint256,address,address) returns (uint256)',
])

export type UmbrellaGhoExitClient = Pick<
  PublicClient,
  'getChainId' | 'getBlock' | 'getStorageAt' | 'getCode' | 'readContract' | 'call' | 'request'
>
export type UmbrellaGhoExitRequest = {
  routeKey: string
  destinationAddress: Address
  holder: Address
  /** Supply exactly one for an amount-specific check. Existing state-only reads may omit both. */
  assetsRaw?: string
  sharesRaw?: string
}
export type UmbrellaGhoAmountCheck = {
  requested: { unit: 'assets' | 'shares'; raw: string }
  sharesToRedeemRaw: string
  previewGhoRaw: string
  maxSlashableGhoRaw: string
  slashExposure: 'slashable_assets_present' | 'no_slashable_assets'
  gate:
    | 'no_shares'
    | 'cooldown_not_started'
    | 'waiting'
    | 'window_expired'
    | 'paused'
    | 'amount_exceeds_window'
    | 'window_open'
  simulation:
    | { status: 'success'; ghoRaw: string }
    | { status: 'evm_revert'; reason: 'unknown_execution_constraint' }
    | { status: 'not_attempted'; reason: 'amount_unconvertible' }
  delivery: 'not_observed'
}
export type UmbrellaGhoExitEvidence = {
  chainId: 1
  blockNumber: number
  blockHash: `0x${string}`
  blockTimestamp: number
  proxy: Address
  implementation: Address | null
  implementationSource: string
  mechanicsSource: string
  routeAsset: Address
}
export type UmbrellaGhoExitResult =
  | {
      status: 'unsupported'
      reason: 'implementation_unattested' | 'identity_mismatch' | 'invalid_state'
      evidence: UmbrellaGhoExitEvidence
    }
  | {
      status: 'observed'
      evidence: UmbrellaGhoExitEvidence
      state:
        | 'no_shares'
        | 'cooldown_not_started'
        | 'waiting'
        | 'window_open'
        | 'window_expired'
        | 'paused'
      paused: boolean
      holderSharesRaw: string
      cooldownSharesRaw: string
      cooldownEnd: number | null
      windowEndInclusive: number | null
      cooldownStartedAt: null
      ifStartedAtCheckedBlockEarliestAt: number | null
      currentCooldownSeconds: number
      currentUnstakeWindowSeconds: number
      maxRedeemSharesRaw: string
      previewSharesRaw: string
      previewGhoRawAtBlock: string
      totalAssetsGhoRaw: string
      totalSupplySharesRaw: string
      originalAsset: Address
      delivery: 'not_observed'
      holderExecution: 'not_simulated' | 'simulated_at_block'
      futureAmount: 'unknown_slashable'
      amountCheck: UmbrellaGhoAmountCheck | null
    }

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const isUint = (v: unknown): v is bigint => typeof v === 'bigint' && v >= 0n && v <= MAX_UINT256
const isUint32 = (v: unknown): v is bigint | number =>
  (typeof v === 'bigint' && v >= 0n && v <= 0xffffffffn) ||
  (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff)

function isEvmRevert(error: unknown): boolean {
  const value = error as {
    name?: unknown
    shortMessage?: unknown
    message?: unknown
    details?: unknown
    cause?: unknown
  } | null
  if (!value || typeof value !== 'object') return false
  const detail = [value.shortMessage, value.message, value.details]
    .filter((item): item is string => typeof item === 'string')
    .join(' ')
    .toLowerCase()
  if (
    /gas required exceeds allowance|out of gas|exceeds block gas|intrinsic gas|gas limit/.test(
      detail,
    )
  )
    return false
  if (value.cause && value.cause !== error && !isEvmRevert(value.cause)) return false
  return (
    value.name === 'ContractFunctionRevertedError' ||
    /execution reverted|reverted with/.test(detail)
  )
}

/** Public-chain state only. A future window or preview is not a mined GHO transfer. */
export async function readUmbrellaGhoExit(
  client: UmbrellaGhoExitClient,
  request: UmbrellaGhoExitRequest,
  now: number | (() => number) = () => Date.now(),
): Promise<UmbrellaGhoExitResult> {
  if (
    request?.routeKey !== UMBRELLA_GHO_ROUTE ||
    !ADDRESS.test(request.destinationAddress ?? '') ||
    !same(request.destinationAddress, UMBRELLA_STKGHO) ||
    !ADDRESS.test(request.holder ?? '')
  )
    throw new Error('umbrella_gho_exit_target_invalid')
  const hasAssets = request.assetsRaw !== undefined
  const hasShares = request.sharesRaw !== undefined
  if (hasAssets && hasShares) throw new Error('umbrella_gho_exit_amount_invalid')
  const amountRaw = hasAssets ? request.assetsRaw : request.sharesRaw
  if (amountRaw !== undefined && (!RAW_AMOUNT.test(amountRaw) || BigInt(amountRaw) > MAX_UINT256)) {
    throw new Error('umbrella_gho_exit_amount_invalid')
  }
  if ((await client.getChainId()) !== 1) throw new Error('umbrella_gho_exit_chain_mismatch')

  const checkedAt = typeof now === 'function' ? now() : now
  const block = await client.getBlock({ blockTag: 'finalized' })
  const blockSeconds = Number(block?.timestamp)
  const blockNumber = block?.number
  if (
    typeof blockNumber !== 'bigint' ||
    blockNumber < 0n ||
    blockNumber > BigInt(Number.MAX_SAFE_INTEGER) ||
    !HASH.test(block?.hash ?? '') ||
    !Number.isSafeInteger(blockSeconds) ||
    !Number.isSafeInteger(checkedAt) ||
    checkedAt - blockSeconds * 1000 < -120_000 ||
    checkedAt - blockSeconds * 1000 > MAX_AGE_MS
  )
    throw new Error('umbrella_gho_exit_finalized_block_unavailable')
  const pinned = { blockHash: block.hash!, requireCanonical: true as const }
  const confirmBlock = async () => {
    const header = await client.getBlock({ blockNumber })
    if (header?.number !== blockNumber || !header.hash || !same(header.hash, block.hash!)) {
      throw new Error('umbrella_gho_exit_block_hash_changed')
    }
  }
  await confirmBlock()
  const rawImpl = await client.getStorageAt({
    address: UMBRELLA_STKGHO,
    slot: IMPLEMENTATION_SLOT,
    ...pinned,
  })
  const implementation =
    rawImpl && HASH.test(rawImpl) && !/^0x0{64}$/i.test(rawImpl)
      ? (`0x${rawImpl.slice(26)}` as Address)
      : null
  const evidence: UmbrellaGhoExitEvidence = {
    chainId: 1,
    blockNumber: Number(blockNumber),
    blockHash: block.hash!,
    blockTimestamp: blockSeconds,
    proxy: UMBRELLA_STKGHO,
    implementation,
    implementationSource:
      'https://etherscan.io/address/0x75e8ac0c063b6966e2a9954adedf39bde9370197#code',
    mechanicsSource:
      'https://github.com/aave-dao/aave-umbrella/blob/main/src/contracts/stakeToken/extension/ERC4626StakeTokenUpgradeable.sol',
    routeAsset: ORIGINAL_GHO,
  }
  if (!implementation || !same(implementation, VERIFIED_STKGHO_IMPLEMENTATION)) {
    return { status: 'unsupported', reason: 'implementation_unattested', evidence }
  }
  const [proxyCode, implementationCode] = await Promise.all([
    client.getCode({ address: UMBRELLA_STKGHO, ...pinned }),
    client.getCode({ address: VERIFIED_STKGHO_IMPLEMENTATION, ...pinned }),
  ])
  if (!proxyCode || proxyCode === '0x' || !implementationCode || implementationCode === '0x') {
    return { status: 'unsupported', reason: 'implementation_unattested', evidence }
  }
  const read = <T extends (typeof vaultAbi)[number]['name']>(
    functionName: T,
    args?: readonly [Address] | readonly [bigint],
  ) =>
    client.readContract({
      address: UMBRELLA_STKGHO,
      abi: vaultAbi,
      functionName,
      args,
      ...pinned,
    } as Parameters<typeof client.readContract>[0])
  const [
    asset,
    paused,
    shares,
    totalAssets,
    totalSupply,
    cooldown,
    unstakeWindow,
    snapshot,
    maxRedeem,
  ] = await Promise.all([
    read('asset'),
    read('paused'),
    read('balanceOf', [request.holder]),
    read('totalAssets'),
    read('totalSupply'),
    read('getCooldown'),
    read('getUnstakeWindow'),
    read('getStakerCooldown', [request.holder]),
    read('maxRedeem', [request.holder]),
  ])
  if (typeof asset !== 'string' || !same(asset, ORIGINAL_GHO)) {
    return { status: 'unsupported', reason: 'identity_mismatch', evidence }
  }
  if (
    typeof paused !== 'boolean' ||
    !isUint(shares) ||
    !isUint(totalAssets) ||
    !isUint(totalSupply) ||
    !isUint(cooldown) ||
    !isUint(unstakeWindow) ||
    !Array.isArray(snapshot) ||
    snapshot.length !== 3 ||
    !isUint(snapshot[0]) ||
    !isUint32(snapshot[1]) ||
    !isUint32(snapshot[2]) ||
    !isUint(maxRedeem) ||
    cooldown > 0xffffffffn ||
    unstakeWindow > 0xffffffffn ||
    maxRedeem > shares
  )
    return { status: 'unsupported', reason: 'invalid_state', evidence }
  const cooldownShares = snapshot[0] as bigint
  const end = BigInt(snapshot[1] as bigint | number)
  const window = BigInt(snapshot[2] as bigint | number)
  const windowEnd = end + window
  if (BigInt(blockSeconds) <= windowEnd && cooldownShares > shares) {
    return { status: 'unsupported', reason: 'invalid_state', evidence }
  }
  const inWindow =
    cooldownShares > 0n && BigInt(blockSeconds) >= end && BigInt(blockSeconds) <= windowEnd
  if (maxRedeem !== (inWindow ? cooldownShares : 0n) && !(paused && maxRedeem === 0n)) {
    return { status: 'unsupported', reason: 'invalid_state', evidence }
  }
  const previewShares = maxRedeem > 0n ? maxRedeem : shares
  const preview = await read('previewRedeem', [previewShares])
  if (!isUint(preview)) return { status: 'unsupported', reason: 'invalid_state', evidence }
  const state = paused
    ? 'paused'
    : shares === 0n
      ? 'no_shares'
      : cooldownShares === 0n || end === 0n
        ? 'cooldown_not_started'
        : BigInt(blockSeconds) < end
          ? 'waiting'
          : BigInt(blockSeconds) <= windowEnd
            ? 'window_open'
            : 'window_expired'
  let amountCheck: UmbrellaGhoAmountCheck | null = null
  if (amountRaw !== undefined) {
    const holderCode = await client.request({
      method: 'eth_getCode',
      params: [request.holder, pinned],
    })
    if (!isEoaTransactionOriginCode(holderCode)) {
      throw new Error('umbrella_gho_exit_contract_holder_unavailable')
    }
    const requestedAmount = BigInt(amountRaw)
    const sharesToRedeem = hasAssets
      ? await read('previewWithdraw', [requestedAmount])
      : requestedAmount
    const maxSlashable = await read('getMaxSlashableAssets')
    if (!isUint(sharesToRedeem) || !isUint(maxSlashable)) {
      return { status: 'unsupported', reason: 'invalid_state', evidence }
    }
    const amountPreview = await read('previewRedeem', [sharesToRedeem])
    if (!isUint(amountPreview)) return { status: 'unsupported', reason: 'invalid_state', evidence }
    const gate = paused
      ? 'paused'
      : shares === 0n
        ? 'no_shares'
        : cooldownShares === 0n || end === 0n
          ? 'cooldown_not_started'
          : BigInt(blockSeconds) < end
            ? 'waiting'
            : BigInt(blockSeconds) > windowEnd
              ? 'window_expired'
              : sharesToRedeem > maxRedeem || sharesToRedeem > shares
                ? 'amount_exceeds_window'
                : 'window_open'
    let simulation: UmbrellaGhoAmountCheck['simulation']
    if (sharesToRedeem === 0n || (hasAssets && amountPreview < requestedAmount)) {
      simulation = { status: 'not_attempted', reason: 'amount_unconvertible' }
    } else {
      try {
        const result = await client.call({
          account: request.holder,
          to: UMBRELLA_STKGHO,
          data: encodeFunctionData({
            abi: vaultAbi,
            functionName: 'redeem',
            args: [sharesToRedeem, request.holder, request.holder],
          }),
          gas: MAX_CALL_GAS,
          ...pinned,
        })
        if (!result.data) throw new Error('umbrella_gho_exit_result_invalid')
        const gho = decodeFunctionResult({
          abi: vaultAbi,
          functionName: 'redeem',
          data: result.data,
        })
        if (typeof gho !== 'bigint' || gho <= 0n || (hasAssets && gho < requestedAmount)) {
          throw new Error('umbrella_gho_exit_result_invalid')
        }
        simulation = { status: 'success', ghoRaw: gho.toString() }
      } catch (error) {
        if (!isEvmRevert(error)) throw error
        simulation = { status: 'evm_revert', reason: 'unknown_execution_constraint' }
      }
    }
    amountCheck = {
      requested: { unit: hasAssets ? 'assets' : 'shares', raw: amountRaw },
      sharesToRedeemRaw: sharesToRedeem.toString(),
      previewGhoRaw: amountPreview.toString(),
      maxSlashableGhoRaw: maxSlashable.toString(),
      slashExposure: maxSlashable > 0n ? 'slashable_assets_present' : 'no_slashable_assets',
      gate,
      simulation,
      delivery: 'not_observed',
    }
  }
  await confirmBlock()
  return {
    status: 'observed',
    evidence,
    state,
    paused,
    holderSharesRaw: shares.toString(),
    cooldownSharesRaw: cooldownShares.toString(),
    cooldownEnd: end === 0n ? null : Number(end),
    windowEndInclusive: end === 0n ? null : Number(windowEnd),
    // The snapshot stores maturity and window, not the actual initiation timestamp.
    cooldownStartedAt: null,
    ifStartedAtCheckedBlockEarliestAt:
      shares > 0n && !paused ? blockSeconds + Number(cooldown) : null,
    currentCooldownSeconds: Number(cooldown),
    currentUnstakeWindowSeconds: Number(unstakeWindow),
    maxRedeemSharesRaw: maxRedeem.toString(),
    previewSharesRaw: previewShares.toString(),
    previewGhoRawAtBlock: preview.toString(),
    totalAssetsGhoRaw: totalAssets.toString(),
    totalSupplySharesRaw: totalSupply.toString(),
    originalAsset: ORIGINAL_GHO,
    delivery: 'not_observed',
    holderExecution:
      amountCheck && amountCheck.simulation.status !== 'not_attempted'
        ? 'simulated_at_block'
        : 'not_simulated',
    futureAmount: 'unknown_slashable',
    amountCheck,
  }
}
