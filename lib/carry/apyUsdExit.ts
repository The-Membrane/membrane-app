import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem'

import { projectApyUsdNet, validApyUsdFeeCurve, type ApyUsdFeeCurve } from './apyUsdFeeOutlook'
import { isEoaTransactionOriginCode } from './holderOriginCode'

export const APYUSD_ROUTE = 'apxUSD → ApyUSD [apxUSD]'
export const APYUSD_VAULT = '0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a' as Address
export const APXUSD_ASSET = '0x98a878b1cd98131b271883b390f68d2c90674665' as Address
export const APXUSD_RECEIPT = '0x9bf51f33955ec70f87c4b5c49441815589043237' as Address
const VAULT_IMPLEMENTATION = '0xfd616567ecc1607f61073951a1e822f7315bb112'
const RECEIPT_IMPLEMENTATION = '0x54f1c7ffe10bc392f08ae9432a7e21a6e86bb982'
const VAULT_PROXY_CODE_HASH = '0x748fde5d195af5984cc16c81df36137e6599c6f50f9f5113d05994c1b90ebad7'
const RECEIPT_PROXY_CODE_HASH = '0x76f9f10f52a301cd5472850a4ac1f5421c8bb57f126e7bd171bd9d3ae70dc30b'
const VAULT_IMPLEMENTATION_CODE_HASH =
  '0x7427a665f82e79f9e1e3a5592339de70bffab25517bbad2f7127549874fbf670'
const RECEIPT_IMPLEMENTATION_CODE_HASH =
  '0xae89d4b99f8590a5045c314350c7e1a0a7fdd69fd1adeb11aa554d6e2edeb1eb'
const IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const RAW = /^[1-9][0-9]{0,77}$/
const MAX_U256 = (1n << 256n) - 1n
const vaultAbi = parseAbi([
  'function asset() view returns (address)',
  'function receipt() view returns (address)',
  'function paused() view returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
  'function withdrawForReceipt(uint256,address,address) returns (uint256,uint256)',
])
const receiptAbi = parseAbi([
  'function asset() view returns (address)',
  'function feeCurve() view returns (uint256 minFee,uint256 maxFee,uint48 minDuration,uint48 maxDuration,uint256 curvature)',
  'function ownerOf(uint256) view returns (address)',
  'function getReceipt(uint256) view returns (uint208,uint208,uint48,uint48)',
  'function isClaimable(uint256) view returns (bool)',
  'function previewClaim(uint256) view returns (uint256)',
  'function paused() view returns (bool)',
  'function claim(uint256,address) returns (uint256)',
])
const assetAbi = parseAbi(['function decimals() view returns (uint8)'])

export type ApyUsdExitClient = Pick<
  PublicClient,
  'getChainId' | 'getBlock' | 'getStorageAt' | 'getCode' | 'readContract' | 'call' | 'request'
>
export type ApyUsdExitRequest = {
  routeKey: string
  destinationAddress: Address
  holder: Address
  assetsRaw: string
  receiptTokenId?: string
}
type Simulation =
  | { status: 'success'; sharesRaw: string; receiptTokenId: string }
  | { status: 'evm_revert'; reason: 'unknown_execution_constraint' }

export type ApyUsdExitResult = {
  status: 'observed' | 'unsupported'
  reason?: 'deployment_unattested' | 'identity_mismatch'
  evidence: {
    chainId: 1
    blockNumber: number
    blockHash: `0x${string}`
    blockTimestamp: number
    vault: Address
    implementation: Address | null
    receipt: Address | null
    receiptImplementation: Address | null
    originalAsset: Address
    assetDecimals: number | null
    source: string
  }
  current?: {
    holderSharesRaw: string
    maxWithdrawEscrowRaw: string
    requestedEscrowRaw: string
    previewSharesToBurnRaw: string
    vaultPaused: boolean
    initiation: Simulation
    currentFeeCurve: ApyUsdFeeCurve | null
    currentMinimumClaimDelaySeconds: number | null
    ifInitiatedAtCheckedBlockClaimableAt: number | null
    ifInitiatedAtCheckedBlockEarliestNetRaw: string | null
    ifInitiatedAtCheckedBlockMinimumFeeAt: number | null
    ifInitiatedAtCheckedBlockMinimumFeeNetRaw: string | null
    payout: 'not_delivered_by_initiation'
    existingReceipt: null | {
      tokenId: string
      ownership: 'holder' | 'other_owner' | 'not_found'
      escrowRaw: string | null
      currentFeeRaw: string | null
      /** Original getReceipt issue clock; never the current checked-block clock. */
      createdAt: number | null
      claimableAt: number | null
      claimableNow: boolean | null
      receiptPaused: boolean
      currentPreviewPayoutRaw: string | null
      claimSimulation: 'success' | 'evm_revert' | 'not_holder' | 'not_found'
      simulatedClaimPayoutRaw: string | null
      delivery: 'not_observed'
    }
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const nativeTimestamp = (value: unknown): number | null => {
  if (typeof value !== 'number' && typeof value !== 'bigint') return null
  const seconds = Number(value)
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 8_640_000_000_000
    ? seconds
    : null
}
const nativeFeeCurve = (value: unknown): ApyUsdFeeCurve | null => {
  if (
    !Array.isArray(value) ||
    value.length !== 5 ||
    ![value[0], value[1], value[4]].every(
      (item) => typeof item === 'bigint' && item >= 0n && item <= MAX_U256,
    ) ||
    typeof value[2] !== 'number' ||
    typeof value[3] !== 'number'
  )
    return null
  const curve = {
    minFeeWad: value[0].toString(),
    maxFeeWad: value[1].toString(),
    minDurationSeconds: value[2],
    maxDurationSeconds: value[3],
    curvatureWad: value[4].toString(),
  }
  return validApyUsdFeeCurve(curve) ? curve : null
}
const addressFromSlot = (raw: `0x${string}` | undefined) =>
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

/** A finalized, same-holder simulation. Withdrawal issues a receipt; payout is a separate claim. */
export async function readApyUsdExit(
  client: ApyUsdExitClient,
  input: ApyUsdExitRequest,
  nowMs = Date.now(),
): Promise<ApyUsdExitResult> {
  if (
    input.routeKey !== APYUSD_ROUTE ||
    !same(input.destinationAddress, APYUSD_VAULT) ||
    !ADDRESS.test(input.holder) ||
    !RAW.test(input.assetsRaw) ||
    BigInt(input.assetsRaw) > MAX_U256 ||
    (input.receiptTokenId !== undefined &&
      (!RAW.test(input.receiptTokenId) || BigInt(input.receiptTokenId) > MAX_U256))
  )
    throw new Error('apyusd_exit_request_invalid')
  if ((await client.getChainId()) !== 1) throw new Error('apyusd_exit_chain_mismatch')
  const block = await client.getBlock({ blockTag: 'finalized' })
  const blockNumber = block.number
  const blockTimestamp = Number(block.timestamp)
  if (
    typeof blockNumber !== 'bigint' ||
    blockNumber < 0n ||
    blockNumber > BigInt(Number.MAX_SAFE_INTEGER) ||
    !HASH.test(block.hash ?? '') ||
    !Number.isSafeInteger(blockTimestamp) ||
    !Number.isSafeInteger(nowMs) ||
    nowMs - blockTimestamp * 1000 < -120_000 ||
    nowMs - blockTimestamp * 1000 > 2 * 60 * 60 * 1000
  )
    throw new Error('apyusd_exit_finalized_block_unavailable')
  const pinned = { blockHash: block.hash!, requireCanonical: true as const }
  const confirmation = await client.getBlock({ blockNumber })
  if (
    confirmation.number !== blockNumber ||
    !confirmation.hash ||
    !same(confirmation.hash, block.hash!)
  )
    throw new Error('apyusd_exit_block_changed')

  const [
    vaultSlot,
    receiptSlot,
    vaultCode,
    receiptCode,
    vaultImplementationCode,
    receiptImplementationCode,
  ] = await Promise.all([
    client.getStorageAt({ address: APYUSD_VAULT, slot: IMPLEMENTATION_SLOT, ...pinned }),
    client.getStorageAt({ address: APXUSD_RECEIPT, slot: IMPLEMENTATION_SLOT, ...pinned }),
    client.getCode({ address: APYUSD_VAULT, ...pinned }),
    client.getCode({ address: APXUSD_RECEIPT, ...pinned }),
    client.getCode({ address: VAULT_IMPLEMENTATION, ...pinned }),
    client.getCode({ address: RECEIPT_IMPLEMENTATION, ...pinned }),
  ])
  const implementation = addressFromSlot(vaultSlot)
  const receiptImplementation = addressFromSlot(receiptSlot)
  const evidence: ApyUsdExitResult['evidence'] = {
    chainId: 1,
    blockNumber: Number(blockNumber),
    blockHash: block.hash!,
    blockTimestamp,
    vault: APYUSD_VAULT,
    implementation,
    receipt: APXUSD_RECEIPT,
    receiptImplementation,
    originalAsset: APXUSD_ASSET,
    assetDecimals: null,
    source: 'https://github.com/apyx-labs/evm-contracts/blob/main/src/ApyUSD.sol',
  }
  if (
    !implementation ||
    !same(implementation, VAULT_IMPLEMENTATION) ||
    !receiptImplementation ||
    !same(receiptImplementation, RECEIPT_IMPLEMENTATION) ||
    !vaultCode ||
    !same(keccak256(vaultCode), VAULT_PROXY_CODE_HASH) ||
    !receiptCode ||
    !same(keccak256(receiptCode), RECEIPT_PROXY_CODE_HASH) ||
    !vaultImplementationCode ||
    !same(keccak256(vaultImplementationCode), VAULT_IMPLEMENTATION_CODE_HASH) ||
    !receiptImplementationCode ||
    !same(keccak256(receiptImplementationCode), RECEIPT_IMPLEMENTATION_CODE_HASH)
  )
    return { status: 'unsupported', reason: 'deployment_unattested', evidence }

  const [vaultAsset, configuredReceipt, receiptAsset, assetDecimals] = await Promise.all([
    client.readContract({ address: APYUSD_VAULT, abi: vaultAbi, functionName: 'asset', ...pinned }),
    client.readContract({
      address: APYUSD_VAULT,
      abi: vaultAbi,
      functionName: 'receipt',
      ...pinned,
    }),
    client.readContract({
      address: APXUSD_RECEIPT,
      abi: receiptAbi,
      functionName: 'asset',
      ...pinned,
    }),
    client.readContract({
      address: APXUSD_ASSET,
      abi: assetAbi,
      functionName: 'decimals',
      ...pinned,
    }),
  ])
  evidence.assetDecimals = assetDecimals
  if (
    !same(vaultAsset, APXUSD_ASSET) ||
    !same(configuredReceipt, APXUSD_RECEIPT) ||
    !same(receiptAsset, APXUSD_ASSET) ||
    assetDecimals !== 18
  )
    return { status: 'unsupported', reason: 'identity_mismatch', evidence }

  // viem getCode normalizes empty EOA code `0x` to undefined. Use the raw
  // EIP-1898 response: a valid EIP-7702 delegation also permits EOA transaction
  // origination. Neither code shape proves that the user controls its key.
  const holderCode = await client.request({
    method: 'eth_getCode',
    params: [input.holder, { blockHash: block.hash!, requireCanonical: true }],
  })
  if (!isEoaTransactionOriginCode(holderCode))
    throw new Error('apyusd_exit_holder_control_unverified')

  const assets = BigInt(input.assetsRaw)
  const [holderShares, maxWithdraw, previewShares, vaultPaused, receiptPaused, feeCurve] =
    await Promise.all([
      client.readContract({
        address: APYUSD_VAULT,
        abi: vaultAbi,
        functionName: 'balanceOf',
        args: [input.holder],
        ...pinned,
      }),
      client.readContract({
        address: APYUSD_VAULT,
        abi: vaultAbi,
        functionName: 'maxWithdraw',
        args: [input.holder],
        ...pinned,
      }),
      client.readContract({
        address: APYUSD_VAULT,
        abi: vaultAbi,
        functionName: 'previewWithdraw',
        args: [assets],
        ...pinned,
      }),
      client.readContract({
        address: APYUSD_VAULT,
        abi: vaultAbi,
        functionName: 'paused',
        ...pinned,
      }),
      client.readContract({
        address: APXUSD_RECEIPT,
        abi: receiptAbi,
        functionName: 'paused',
        ...pinned,
      }),
      client
        .readContract({
          address: APXUSD_RECEIPT,
          abi: receiptAbi,
          functionName: 'feeCurve',
          ...pinned,
        })
        .catch(() => null),
    ])
  const currentFeeCurve = nativeFeeCurve(feeCurve)
  const minimumClaimDelay = currentFeeCurve?.minDurationSeconds ?? null
  let initiation: Simulation
  try {
    const result = await client.call({
      to: APYUSD_VAULT,
      account: input.holder,
      data: encodeFunctionData({
        abi: vaultAbi,
        functionName: 'withdrawForReceipt',
        args: [assets, input.holder, input.holder],
      }),
      gas: 15_000_000n,
      ...pinned,
    })
    if (!result.data) throw new Error('apyusd_exit_simulation_empty')
    const [shares, tokenId] = decodeFunctionResult({
      abi: vaultAbi,
      functionName: 'withdrawForReceipt',
      data: result.data,
    })
    initiation = {
      status: 'success',
      sharesRaw: shares.toString(),
      receiptTokenId: tokenId.toString(),
    }
  } catch (error) {
    if (!isEvmRevert(error)) throw error
    initiation = { status: 'evm_revert', reason: 'unknown_execution_constraint' }
  }

  let existingReceipt: NonNullable<
    NonNullable<ApyUsdExitResult['current']>['existingReceipt']
  > | null = null
  if (input.receiptTokenId !== undefined) {
    const tokenId = BigInt(input.receiptTokenId)
    let owner: Address | null = null
    try {
      owner = await client.readContract({
        address: APXUSD_RECEIPT,
        abi: receiptAbi,
        functionName: 'ownerOf',
        args: [tokenId],
        ...pinned,
      })
    } catch (error) {
      if (!isEvmRevert(error)) throw error
    }
    if (!owner) {
      existingReceipt = {
        tokenId: input.receiptTokenId,
        ownership: 'not_found',
        escrowRaw: null,
        currentFeeRaw: null,
        createdAt: null,
        claimableAt: null,
        claimableNow: null,
        receiptPaused,
        currentPreviewPayoutRaw: null,
        claimSimulation: 'not_found',
        simulatedClaimPayoutRaw: null,
        delivery: 'not_observed',
      }
    } else {
      const [position, claimable, payout] = await Promise.all([
        client.readContract({
          address: APXUSD_RECEIPT,
          abi: receiptAbi,
          functionName: 'getReceipt',
          args: [tokenId],
          ...pinned,
        }),
        client.readContract({
          address: APXUSD_RECEIPT,
          abi: receiptAbi,
          functionName: 'isClaimable',
          args: [tokenId],
          ...pinned,
        }),
        client.readContract({
          address: APXUSD_RECEIPT,
          abi: receiptAbi,
          functionName: 'previewClaim',
          args: [tokenId],
          ...pinned,
        }),
      ])
      let claimSimulation: 'success' | 'evm_revert' | 'not_holder' = 'not_holder'
      let simulatedClaimPayoutRaw: string | null = null
      if (same(owner, input.holder)) {
        try {
          const result = await client.call({
            to: APXUSD_RECEIPT,
            account: input.holder,
            data: encodeFunctionData({
              abi: receiptAbi,
              functionName: 'claim',
              args: [tokenId, input.holder],
            }),
            gas: 15_000_000n,
            ...pinned,
          })
          if (!result.data) throw new Error('apyusd_claim_simulation_empty')
          const claimed = decodeFunctionResult({
            abi: receiptAbi,
            functionName: 'claim',
            data: result.data,
          })
          simulatedClaimPayoutRaw = claimed.toString()
          claimSimulation = 'success'
        } catch (error) {
          if (!isEvmRevert(error)) throw error
          claimSimulation = 'evm_revert'
        }
      }
      const claimableAt = nativeTimestamp(position[3])
      const issueAt = nativeTimestamp(position[2])
      existingReceipt = {
        tokenId: input.receiptTokenId,
        ownership: same(owner, input.holder) ? 'holder' : 'other_owner',
        escrowRaw: position[0].toString(),
        currentFeeRaw: position[1].toString(),
        createdAt:
          issueAt !== null &&
          claimableAt !== null &&
          issueAt <= blockTimestamp &&
          issueAt <= claimableAt
            ? issueAt
            : null,
        claimableAt,
        claimableNow: claimable,
        receiptPaused,
        currentPreviewPayoutRaw: payout.toString(),
        claimSimulation,
        simulatedClaimPayoutRaw,
        delivery: 'not_observed',
      }
    }
  }
  const repeat = await client.getBlock({ blockNumber })
  if (repeat.number !== blockNumber || !repeat.hash || !same(repeat.hash, block.hash!))
    throw new Error('apyusd_exit_block_changed')
  return {
    status: 'observed',
    evidence,
    current: {
      holderSharesRaw: holderShares.toString(),
      maxWithdrawEscrowRaw: maxWithdraw.toString(),
      requestedEscrowRaw: input.assetsRaw,
      previewSharesToBurnRaw: previewShares.toString(),
      vaultPaused,
      initiation,
      currentFeeCurve,
      currentMinimumClaimDelaySeconds: minimumClaimDelay,
      ifInitiatedAtCheckedBlockClaimableAt:
        initiation.status === 'success' && minimumClaimDelay !== null
          ? blockTimestamp + minimumClaimDelay
          : null,
      ifInitiatedAtCheckedBlockEarliestNetRaw:
        initiation.status === 'success' && minimumClaimDelay !== null && currentFeeCurve !== null
          ? (projectApyUsdNet(input.assetsRaw, minimumClaimDelay, currentFeeCurve)?.netRaw ?? null)
          : null,
      ifInitiatedAtCheckedBlockMinimumFeeAt:
        initiation.status === 'success' && currentFeeCurve !== null
          ? blockTimestamp + currentFeeCurve.maxDurationSeconds
          : null,
      ifInitiatedAtCheckedBlockMinimumFeeNetRaw:
        initiation.status === 'success' && currentFeeCurve !== null
          ? (projectApyUsdNet(input.assetsRaw, currentFeeCurve.maxDurationSeconds, currentFeeCurve)
              ?.netRaw ?? null)
          : null,
      payout: 'not_delivered_by_initiation',
      existingReceipt,
    },
  }
}
