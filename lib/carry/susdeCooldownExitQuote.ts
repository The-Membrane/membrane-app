import {
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem'

import { isEoaTransactionOriginCode } from './holderOriginCode'

const ROUTE_KEY = 'USDe → Staked USDe [USDe]'
const VAULT = '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497' as Address
const USDE = '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3' as Address
// Verified against silo() at Ethereum finalized block 26085852.
const SILO = '0x7FC7c91D556B400AFa565013E3F32055a0713425' as Address
const DECIMALS = 18
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const RAW_AMOUNT = /^[1-9][0-9]{0,77}$/
const MAX_UINT256 = (1n << 256n) - 1n
const MAX_SOURCE_AGE_MS = 2 * 60 * 60 * 1000
const MAX_CALL_GAS = 20_000_000n
// Ethena StakedUSDeV2. The public cooldowns getter returns uint104,uint256;
// the second member is not uint152. See Ethena's IStakedUSDeCooldown.
const vaultAbi = parseAbi([
  'function asset() view returns (address)',
  'function silo() view returns (address)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function cooldownDuration() view returns (uint24)',
  'function cooldowns(address) view returns (uint104 cooldownEnd, uint256 underlyingAmount)',
  'function cooldownAssets(uint256) returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
  'function unstake(address)',
])
const tokenAbi = parseAbi([
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
])

export type SusdeCooldownExitRequest = {
  routeKey: string
  destinationAddress: Address
  owner: Address
  assetsRaw: string
}
export type SusdeCooldownExitClient = Pick<
  PublicClient,
  'getChainId' | 'getBlock' | 'getCode' | 'readContract' | 'call' | 'request'
>

export type SusdeCooldownExitReadOptions = { includeCapacityFacts?: true }

/** Getter observations only; inherited conversion semantics remain unqualified. */
export type SusdeHolderFacts = {
  owner: Address
  originAgreement: 'not_compared' | 'two_provider_agreed'
  status: 'observed' | 'unknown_active_entitlement'
  activeSharesRaw: string
  activeEntitlementRaw: string | null
  method: 'preview_redeem_full_active_position'
  semanticQualification: 'UNQUALIFIED'
  sourceQualification: 'UNQUALIFIED'
  /** maxWithdraw does not check execution constraints such as restricted-staker roles. */
  ceilingQualification: 'getter_only_not_callability'
  source: {
    chainId: 1
    vaultAddress: Address
    assetAddress: Address
    blockNumber: number
    blockHash: `0x${string}`
    blockTime: string
  }
  pendingAssetsRaw: string
  storedCooldownEndUnix: string
  cooldownDurationSeconds: string
  maxInitiationAssetsRaw?: string
  maxDirectWithdrawalAssetsRaw?: string
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const isUint = (value: unknown): value is bigint => typeof value === 'bigint' && value >= 0n

export function resolveSusdeCooldownExitTarget(routeKey: string, destinationAddress: Address) {
  if (routeKey !== ROUTE_KEY || !same(destinationAddress, VAULT)) {
    throw new Error('susde_exit_target_unknown')
  }
  return { routeKey: ROUTE_KEY, vault: VAULT, asset: USDE, silo: SILO, decimals: DECIMALS }
}

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
  ) {
    return false
  }
  if (value.cause && value.cause !== error && !isEvmRevert(value.cause)) return false
  return (
    value.name === 'ContractFunctionRevertedError' ||
    /execution reverted|reverted with/.test(detail)
  )
}

/** Current holder's protocol initiation and claim state at one finalized block. */
export async function readSusdeCooldownExitQuote(
  client: SusdeCooldownExitClient,
  request: SusdeCooldownExitRequest,
  now: number | (() => number) = () => Date.now(),
  options: SusdeCooldownExitReadOptions = {},
) {
  if (
    !request ||
    typeof request.routeKey !== 'string' ||
    request.routeKey.length > 160 ||
    !ADDRESS.test(request.destinationAddress) ||
    !ADDRESS.test(request.owner) ||
    typeof request.assetsRaw !== 'string' ||
    !RAW_AMOUNT.test(request.assetsRaw)
  ) {
    throw new Error('susde_exit_request_invalid')
  }
  const amount = BigInt(request.assetsRaw)
  if (amount > MAX_UINT256) throw new Error('susde_exit_request_invalid')
  const target = resolveSusdeCooldownExitTarget(request.routeKey, request.destinationAddress)
  if ((await client.getChainId()) !== 1) throw new Error('susde_exit_chain_mismatch')

  const readNow = typeof now === 'function' ? now : () => now
  const startedAt = readNow()
  const block = await client.getBlock({ blockTag: 'finalized' })
  const blockNumber = block?.number
  const blockHash = block?.hash
  const blockSeconds = Number(block?.timestamp)
  const blockMs = blockSeconds * 1000
  if (
    typeof blockNumber !== 'bigint' ||
    blockNumber < 0n ||
    blockNumber > BigInt(Number.MAX_SAFE_INTEGER) ||
    !HASH.test(blockHash ?? '') ||
    !Number.isSafeInteger(blockSeconds) ||
    !Number.isSafeInteger(blockMs) ||
    !Number.isSafeInteger(startedAt) ||
    startedAt - blockMs < -120_000 ||
    startedAt - blockMs > MAX_SOURCE_AGE_MS
  ) {
    throw new Error('susde_exit_finalized_block_unavailable')
  }
  const pinnedHash = blockHash as `0x${string}`
  const confirmBlock = async () => {
    const header = await client.getBlock({ blockNumber })
    if (header?.number !== blockNumber || !header.hash || !same(header.hash, pinnedHash)) {
      throw new Error('susde_exit_block_hash_changed')
    }
  }
  await confirmBlock()
  const holderCode = await client.request({
    method: 'eth_getCode',
    params: [request.owner, { blockHash: pinnedHash, requireCanonical: true }],
  })
  if (!isEoaTransactionOriginCode(holderCode)) {
    throw new Error('susde_exit_holder_unavailable')
  }

  const pinned = { blockHash: pinnedHash, requireCanonical: true as const }
  const [
    asset,
    silo,
    vaultDecimals,
    assetDecimals,
    duration,
    holderShares,
    maxWithdraw,
    previewShares,
    cooldown,
  ] = await Promise.all([
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: 'asset', ...pinned }),
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: 'silo', ...pinned }),
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: 'decimals', ...pinned }),
    client.readContract({ address: USDE, abi: tokenAbi, functionName: 'decimals', ...pinned }),
    client.readContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: 'cooldownDuration',
      ...pinned,
    }),
    client.readContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: 'balanceOf',
      args: [request.owner],
      ...pinned,
    }),
    client.readContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: 'maxWithdraw',
      args: [request.owner],
      ...pinned,
    }),
    client.readContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: 'previewWithdraw',
      args: [amount],
      ...pinned,
    }),
    client.readContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: 'cooldowns',
      args: [request.owner],
      ...pinned,
    }),
  ])
  const [cooldownEnd, pendingAssets] = cooldown
  if (
    !same(asset, USDE) ||
    !same(silo, SILO) ||
    Number(vaultDecimals) !== DECIMALS ||
    Number(assetDecimals) !== DECIMALS ||
    !Number.isSafeInteger(duration) ||
    duration > 90 * 24 * 60 * 60 ||
    !isUint(holderShares) ||
    !isUint(maxWithdraw) ||
    !isUint(previewShares) ||
    !isUint(cooldownEnd) ||
    !isUint(pendingAssets) ||
    (pendingAssets > 0n && cooldownEnd === 0n) ||
    cooldownEnd > BigInt(Math.floor(8_640_000_000_000 / 1000))
  ) {
    throw new Error('susde_exit_identity_or_state_invalid')
  }
  // Full active-position conversion is independent of entered Q and queued M.
  // Failure of this optional getter must not discard the core execution assay.
  let activeEntitlementRaw: string | null = null
  if (options.includeCapacityFacts === true) {
    try {
      if (holderShares > MAX_UINT256) throw new Error('susde_exit_active_shares_invalid')
      const entitlement = await client.readContract({
        address: VAULT,
        abi: vaultAbi,
        functionName: 'previewRedeem',
        args: [holderShares],
        ...pinned,
      })
      if (!isUint(entitlement) || entitlement > MAX_UINT256) {
        throw new Error('susde_exit_active_entitlement_invalid')
      }
      activeEntitlementRaw = entitlement.toString()
    } catch {
      activeEntitlementRaw = null
    }
  }
  const aggregateSiloUsdeRaw = await client.readContract({
    address: USDE,
    abi: tokenAbi,
    functionName: 'balanceOf',
    args: [SILO],
    ...pinned,
  })
  if (!isUint(aggregateSiloUsdeRaw) || aggregateSiloUsdeRaw > MAX_UINT256) {
    throw new Error('susde_exit_identity_or_state_invalid')
  }

  const cooldownEnabled = duration > 0
  let initiation:
    | { status: 'success'; sharesBurnedRaw: string }
    | { status: 'evm_revert'; reason: string }
    | { status: 'not_applicable' }
  let directWithdrawal:
    | { status: 'success'; sharesBurnedRaw: string }
    | { status: 'evm_revert'; reason: string }
    | null = null
  if (cooldownEnabled) {
    try {
      const result = await client.call({
        account: request.owner,
        to: VAULT,
        data: encodeFunctionData({
          abi: vaultAbi,
          functionName: 'cooldownAssets',
          args: [amount],
        }),
        gas: MAX_CALL_GAS,
        ...pinned,
      })
      if (!result.data) throw new Error('susde_exit_initiation_result_invalid')
      const returned = decodeFunctionResult({
        abi: vaultAbi,
        functionName: 'cooldownAssets',
        data: result.data,
      })
      if (
        returned !== previewShares ||
        returned === 0n ||
        amount > maxWithdraw ||
        returned > holderShares
      ) {
        throw new Error('susde_exit_initiation_result_invalid')
      }
      initiation = { status: 'success', sharesBurnedRaw: returned.toString() }
    } catch (error) {
      if (!isEvmRevert(error)) throw error
      initiation = { status: 'evm_revert', reason: 'unknown_execution_constraint' }
    }
  } else {
    initiation = { status: 'not_applicable' }
    try {
      const result = await client.call({
        account: request.owner,
        to: VAULT,
        data: encodeFunctionData({
          abi: vaultAbi,
          functionName: 'withdraw',
          args: [amount, request.owner, request.owner],
        }),
        gas: MAX_CALL_GAS,
        ...pinned,
      })
      if (!result.data) throw new Error('susde_exit_direct_withdrawal_result_invalid')
      const returned = decodeFunctionResult({
        abi: vaultAbi,
        functionName: 'withdraw',
        data: result.data,
      })
      if (
        returned !== previewShares ||
        returned === 0n ||
        amount > maxWithdraw ||
        returned > holderShares
      ) {
        throw new Error('susde_exit_direct_withdrawal_result_invalid')
      }
      directWithdrawal = { status: 'success', sharesBurnedRaw: returned.toString() }
    } catch (error) {
      if (!isEvmRevert(error)) throw error
      directWithdrawal = { status: 'evm_revert', reason: 'unknown_execution_constraint' }
    }
  }

  const hasPending = pendingAssets > 0n
  const eligibleByTime = hasPending && (cooldownEnd <= BigInt(blockSeconds) || !cooldownEnabled)
  let claim:
    | { status: 'success' }
    | { status: 'evm_revert'; reason: string }
    | { status: 'not_yet_eligible' }
    | { status: 'no_pending_claim' }
  if (!hasPending) {
    claim = { status: 'no_pending_claim' }
  } else if (!eligibleByTime) {
    claim = { status: 'not_yet_eligible' }
  } else {
    try {
      const result = await client.call({
        account: request.owner,
        to: VAULT,
        data: encodeFunctionData({ abi: vaultAbi, functionName: 'unstake', args: [request.owner] }),
        gas: MAX_CALL_GAS,
        ...pinned,
      })
      if (result.data !== undefined && result.data !== '0x') {
        throw new Error('susde_exit_claim_result_invalid')
      }
      claim = { status: 'success' }
    } catch (error) {
      if (!isEvmRevert(error)) throw error
      claim = { status: 'evm_revert', reason: 'unknown_execution_constraint' }
    }
  }

  await confirmBlock()
  const completedAt = readNow()
  if (
    !Number.isSafeInteger(completedAt) ||
    completedAt < startedAt ||
    completedAt - blockMs < -120_000 ||
    completedAt - blockMs > MAX_SOURCE_AGE_MS
  ) {
    throw new Error('susde_exit_finalized_block_unavailable')
  }
  const canInitiateNow = initiation.status === 'success'
  const canWithdrawNow = directWithdrawal?.status === 'success'
  const canClaimNow = claim.status === 'success'
  const ifInitiatedAtCheckedBlockEarliestAt = new Date(
    (blockSeconds + duration) * 1000,
  ).toISOString()
  return {
    ...(options.includeCapacityFacts === true
      ? {
          susdeHolderFacts: {
            owner: request.owner,
            originAgreement: 'not_compared',
            status: activeEntitlementRaw === null ? 'unknown_active_entitlement' : 'observed',
            activeSharesRaw: holderShares.toString(),
            activeEntitlementRaw,
            method: 'preview_redeem_full_active_position',
            semanticQualification: 'UNQUALIFIED',
            sourceQualification: 'UNQUALIFIED',
            ceilingQualification: 'getter_only_not_callability',
            source: {
              chainId: 1,
              vaultAddress: target.vault,
              assetAddress: target.asset,
              blockNumber: Number(blockNumber),
              blockHash: pinnedHash,
              blockTime: new Date(blockMs).toISOString(),
            },
            pendingAssetsRaw: pendingAssets.toString(),
            storedCooldownEndUnix: cooldownEnd.toString(),
            cooldownDurationSeconds: String(duration),
            ...(cooldownEnabled
              ? { maxInitiationAssetsRaw: maxWithdraw.toString() }
              : { maxDirectWithdrawalAssetsRaw: maxWithdraw.toString() }),
          } satisfies SusdeHolderFacts,
        }
      : {}),
    status: 'checked_at_finalized_block' as const,
    source: {
      chainId: 1 as const,
      blockNumber: Number(blockNumber),
      blockHash: pinnedHash,
      blockTime: new Date(blockMs).toISOString(),
      observedAt: new Date(completedAt).toISOString(),
      ageSeconds: Math.max(0, Math.floor((completedAt - blockMs) / 1000)),
      method: cooldownEnabled
        ? ('eth_call_cooldown_and_mature_claim_at_finalized_block' as const)
        : ('eth_call_direct_withdraw_and_pending_claim_at_finalized_block' as const),
    },
    exitMode: cooldownEnabled ? ('cooldown' as const) : ('direct_withdrawal' as const),
    routeKey: target.routeKey,
    vault: {
      address: target.vault,
      assetAddress: target.asset,
      siloAddress: target.silo,
      assetDecimals: target.decimals,
      cooldownDurationSeconds: Number(duration),
      identity: 'pinned_vault_asset_and_silo' as const,
    },
    // Shared silo inventory is not earmarked for this holder or proof of a mined payout.
    aggregateSiloUsde: {
      balanceRaw: aggregateSiloUsdeRaw.toString(),
      balance: formatUnits(aggregateSiloUsdeRaw, DECIMALS),
    },
    position: {
      sharesRaw: holderShares.toString(),
      shares: formatUnits(holderShares, DECIMALS),
      maxInitiationAssetsRaw: cooldownEnabled ? maxWithdraw.toString() : '0',
      maxInitiationAssets: cooldownEnabled ? formatUnits(maxWithdraw, DECIMALS) : '0',
      maxDirectWithdrawalAssetsRaw: cooldownEnabled ? '0' : maxWithdraw.toString(),
      maxDirectWithdrawalAssets: cooldownEnabled ? '0' : formatUnits(maxWithdraw, DECIMALS),
    },
    request: {
      assetsRaw: amount.toString(),
      assets: formatUnits(amount, DECIMALS),
      previewSharesRaw: previewShares.toString(),
      previewShares: formatUnits(previewShares, DECIMALS),
    },
    pending: {
      assetsRaw: pendingAssets.toString(),
      assets: formatUnits(pendingAssets, DECIMALS),
      cooldownEnd: hasPending ? new Date(Number(cooldownEnd) * 1000).toISOString() : null,
    },
    initiation,
    directWithdrawal,
    claim,
    canInitiateNow,
    canWithdrawNow,
    currentClaimEarliestAt: hasPending
      ? new Date((cooldownEnabled ? Number(cooldownEnd) : blockSeconds) * 1000).toISOString()
      : null,
    canClaimNow,
    ifInitiatedAtCheckedBlockEarliestAt: canInitiateNow
      ? ifInitiatedAtCheckedBlockEarliestAt
      : null,
    newRequestWouldResetPending: canInitiateNow && hasPending,
    forecast: {
      futureExit: 'unavailable' as const,
      ownerClaimTime: 'unavailable' as const,
      prospectiveValidated: false as const,
    },
    caveat: cooldownEnabled
      ? 'Cooldown initiation burns sUSDe and queues USDe in the silo; it is not a completed exit. The current queue can be claimed only in one full unstake after eligibility. The scheduled time assumes no additional request resets it. Wallet gas funding, future protocol state, and owner action time are unassessed.'
      : 'Cooldown is disabled at the checked block. A direct same-holder ERC4626 withdraw for the requested amount and a full existing-queue unstake are simulated separately. Neither simulation proves a mined payout or future execution. Wallet gas funding, future protocol state, and owner action time are unassessed.',
  }
}
