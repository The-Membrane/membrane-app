import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem'

export const STAKED_USDAT_ROUTE = 'AUSD → Staked USDat [USDat]'
export const STAKED_USDAT_VAULT = '0xd166337499e176bbc38a1fbd113ab144e5bd2df7' as Address
export const STAKED_USDAT_QUEUE = '0x4bc9fec04f0f95e9b42a3ef18f3c96fb57923d2e' as Address
export const USDAT_ASSET = '0x23238f20b894f29041f48d88ee91131c395aaa71' as Address
export const STAKED_USDAT_IMPLEMENTATION = '0x2b7074cf6681382b70e239063931ebe83c0f4e0a' as Address
export const STAKED_USDAT_IMPLEMENTATION_CODE_HASH =
  '0xec3b77f722a89eec23e7dfb2ddfe63e4d82f37adbc5f75a269ed2c82c3ad0300'
export const STAKED_USDAT_QUEUE_IMPLEMENTATION =
  '0xdaf6f8523d7a707d173a12041e1523fdf1373f23' as Address
export const STAKED_USDAT_QUEUE_IMPLEMENTATION_CODE_HASH =
  '0x537d27c7b1574e4ab94867b9f5719414169c5941387346bca88b84643612256d'

const IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const RAW = /^[1-9][0-9]{0,77}$/
const MAX_U256 = (1n << 256n) - 1n
const vaultAbi = parseAbi([
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
  'function paused() view returns (bool)',
  'function getWithdrawalQueue() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function maxRedeem(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function requestRedeem(uint256,uint256) returns (uint256)',
])
const queueAbi = parseAbi([
  'function paused() view returns (bool)',
  'function USDAT() view returns (address)',
  'function STAKED_USDAT() view returns (address)',
  'function ownerOf(uint256) view returns (address)',
  'function requests(uint256) view returns (uint256 shares,uint256 usdatOwed,uint256 timestamp,uint256 minSharePrice,uint8 status)',
  'function updateMinSharePrice(uint256 tokenId,uint256 newMinSharePrice)',
  'function claim(uint256) returns (uint256)',
])
const assetAbi = parseAbi(['function decimals() view returns (uint8)'])

export type StakedUsdatExitClient = Pick<
  PublicClient,
  'getChainId' | 'getBlock' | 'getStorageAt' | 'getCode' | 'readContract' | 'call'
>
export type StakedUsdatExitRequest = {
  routeKey: string
  destinationAddress: Address
  holder: Address
  sharesRaw: string
  requestTokenId?: string
}
type Simulated =
  | { status: 'success'; requestTokenId: string }
  | { status: 'evm_revert' }
  | { status: 'not_attempted'; reason: 'insufficient_shares' }

export type StakedUsdatRecordedRequest = {
  sharesRaw18: string
  usdatOwedRaw6: string
  requestedAtUnix: string
  minSharePriceRaw: string
  rawStatus: number
}

export type StakedUsdatExitResult = {
  status: 'observed' | 'unsupported'
  reason?: 'deployment_changed' | 'identity_mismatch'
  evidence: {
    chainId: 1
    blockNumber: number
    blockHash: `0x${string}`
    blockTimestamp: number
    vault: Address
    vaultImplementation: Address | null
    queue: Address
    queueImplementation: Address | null
    underlying: Address
    underlyingDecimals: number | null
    shareDecimals: number | null
    source: 'finalized_public_chain'
    implementationSourceAttested: false
  }
  current?: {
    requestedSharesRaw: string
    holderSharesRaw: string
    maxRedeemSharesRaw: string
    previewUsdatRaw: string | null
    vaultPaused: boolean
    queuePaused: boolean
    requestMinSharePriceRaw: '0'
    request: Simulated
    requestDelivery: 'queue_ticket_only'
    existingTicket: null | {
      tokenId: string
      ownership: 'holder' | 'other_owner' | 'not_found'
      claimSimulation: 'success' | 'evm_revert' | 'not_holder' | 'not_found'
      simulatedUsdatRaw: string | null
      /** Queue request timestamp from requests(tokenId), in Unix seconds at the pinned block. */
      requestedAtUnix: string | null
      /** Raw owned-ticket getter facts; no status interpretation or net-fee claim. */
      recordedRequest?: StakedUsdatRecordedRequest | null
      requestedLimit: null | {
        sharesRaw: string
        minSharePriceRaw: string
        currentQuoteUsdatRaw: string | null
        currentNetSharePriceRaw: string | null
        comparison: 'above_current_quote' | 'at_or_below_current_quote' | 'quote_unavailable'
        limitUpdateSimulation: 'success' | 'evm_revert'
      }
      delivery: 'not_observed'
    }
    originalAusdConversion: 'not_assayed'
    settlementDuration: 'unestimated'
  }
}

type RequestedTicketLimit = NonNullable<
  NonNullable<NonNullable<StakedUsdatExitResult['current']>['existingTicket']>['requestedLimit']
>

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const implFromSlot = (slot: `0x${string}` | undefined) =>
  slot && HASH.test(slot) && !/^0x0{64}$/i.test(slot)
    ? (`0x${slot.slice(26)}`.toLowerCase() as Address)
    : null

function isEvmRevert(error: unknown): boolean {
  const e = error as { name?: string; shortMessage?: string; message?: string; cause?: unknown }
  const message = `${e?.shortMessage ?? ''} ${e?.message ?? ''}`.toLowerCase()
  if (/http request|network|timeout|rate limit|gas limit|out of gas/.test(message)) return false
  if (/execution reverted|reverted with|contract function reverted/.test(message)) return true
  return Boolean(e?.cause && e.cause !== error && isEvmRevert(e.cause))
}

/** Current exact-share queue request and optional existing ticket claim simulations. */
export async function readStakedUsdatExit(
  client: StakedUsdatExitClient,
  input: StakedUsdatExitRequest,
  nowMs = Date.now(),
): Promise<StakedUsdatExitResult> {
  if (
    input.routeKey !== STAKED_USDAT_ROUTE ||
    !ADDRESS.test(input.destinationAddress) ||
    !same(input.destinationAddress, STAKED_USDAT_VAULT) ||
    !ADDRESS.test(input.holder) ||
    !RAW.test(input.sharesRaw) ||
    BigInt(input.sharesRaw) > MAX_U256 ||
    (input.requestTokenId !== undefined &&
      (!/^(0|[1-9][0-9]{0,77})$/.test(input.requestTokenId) ||
        BigInt(input.requestTokenId) > MAX_U256))
  )
    throw new Error('staked_usdat_exit_request_invalid')
  if ((await client.getChainId()) !== 1) throw new Error('staked_usdat_exit_chain_mismatch')

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
    nowMs - blockTimestamp * 1000 > 7_200_000
  )
    throw new Error('staked_usdat_exit_finalized_block_unavailable')
  const pinned = { blockHash: block.hash!, requireCanonical: true as const }
  const confirm = async () => {
    const repeated = await client.getBlock({ blockNumber })
    if (repeated.number !== blockNumber || !repeated.hash || !same(repeated.hash, block.hash!))
      throw new Error('staked_usdat_exit_block_changed')
  }
  await confirm()

  const [vaultSlot, queueSlot] = await Promise.all([
    client.getStorageAt({ address: STAKED_USDAT_VAULT, slot: IMPLEMENTATION_SLOT, ...pinned }),
    client.getStorageAt({ address: STAKED_USDAT_QUEUE, slot: IMPLEMENTATION_SLOT, ...pinned }),
  ])
  const vaultImplementation = implFromSlot(vaultSlot)
  const queueImplementation = implFromSlot(queueSlot)
  const evidence: StakedUsdatExitResult['evidence'] = {
    chainId: 1,
    blockNumber: Number(blockNumber),
    blockHash: block.hash!,
    blockTimestamp,
    vault: STAKED_USDAT_VAULT,
    vaultImplementation,
    queue: STAKED_USDAT_QUEUE,
    queueImplementation,
    underlying: USDAT_ASSET,
    underlyingDecimals: null,
    shareDecimals: null,
    source: 'finalized_public_chain',
    implementationSourceAttested: false,
  }
  if (
    !vaultImplementation ||
    !queueImplementation ||
    !same(vaultImplementation, STAKED_USDAT_IMPLEMENTATION) ||
    !same(queueImplementation, STAKED_USDAT_QUEUE_IMPLEMENTATION)
  )
    return { status: 'unsupported', reason: 'deployment_changed', evidence }

  const [vaultCode, queueCode] = await Promise.all([
    client.getCode({ address: vaultImplementation, ...pinned }),
    client.getCode({ address: queueImplementation, ...pinned }),
  ])
  if (
    !vaultCode ||
    !queueCode ||
    !same(keccak256(vaultCode), STAKED_USDAT_IMPLEMENTATION_CODE_HASH) ||
    !same(keccak256(queueCode), STAKED_USDAT_QUEUE_IMPLEMENTATION_CODE_HASH)
  )
    return { status: 'unsupported', reason: 'deployment_changed', evidence }

  const [underlying, shareDecimals, underlyingDecimals, queue, queueAsset, queueVault] =
    await Promise.all([
      client.readContract({
        address: STAKED_USDAT_VAULT,
        abi: vaultAbi,
        functionName: 'asset',
        ...pinned,
      }),
      client.readContract({
        address: STAKED_USDAT_VAULT,
        abi: vaultAbi,
        functionName: 'decimals',
        ...pinned,
      }),
      client.readContract({
        address: USDAT_ASSET,
        abi: assetAbi,
        functionName: 'decimals',
        ...pinned,
      }),
      client.readContract({
        address: STAKED_USDAT_VAULT,
        abi: vaultAbi,
        functionName: 'getWithdrawalQueue',
        ...pinned,
      }),
      client.readContract({
        address: STAKED_USDAT_QUEUE,
        abi: queueAbi,
        functionName: 'USDAT',
        ...pinned,
      }),
      client.readContract({
        address: STAKED_USDAT_QUEUE,
        abi: queueAbi,
        functionName: 'STAKED_USDAT',
        ...pinned,
      }),
    ])
  evidence.shareDecimals = shareDecimals
  evidence.underlyingDecimals = underlyingDecimals
  if (
    !same(underlying, USDAT_ASSET) ||
    shareDecimals !== 18 ||
    underlyingDecimals !== 6 ||
    !same(queue, STAKED_USDAT_QUEUE) ||
    !same(queueAsset, USDAT_ASSET) ||
    !same(queueVault, STAKED_USDAT_VAULT)
  )
    return { status: 'unsupported', reason: 'identity_mismatch', evidence }

  const [vaultPaused, queuePaused, holderShares, maxRedeemShares] = await Promise.all([
    client.readContract({
      address: STAKED_USDAT_VAULT,
      abi: vaultAbi,
      functionName: 'paused',
      ...pinned,
    }),
    client.readContract({
      address: STAKED_USDAT_QUEUE,
      abi: queueAbi,
      functionName: 'paused',
      ...pinned,
    }),
    client.readContract({
      address: STAKED_USDAT_VAULT,
      abi: vaultAbi,
      functionName: 'balanceOf',
      args: [input.holder],
      ...pinned,
    }),
    client.readContract({
      address: STAKED_USDAT_VAULT,
      abi: vaultAbi,
      functionName: 'maxRedeem',
      args: [input.holder],
      ...pinned,
    }),
  ])
  let previewUsdatRaw: string | null = null
  try {
    const preview = await client.readContract({
      address: STAKED_USDAT_VAULT,
      abi: vaultAbi,
      functionName: 'previewRedeem',
      args: [BigInt(input.sharesRaw)],
      ...pinned,
    })
    previewUsdatRaw = preview.toString()
  } catch (error) {
    if (!isEvmRevert(error)) throw error
  }
  let request: Simulated
  if (BigInt(input.sharesRaw) > holderShares || BigInt(input.sharesRaw) > maxRedeemShares) {
    request = { status: 'not_attempted', reason: 'insufficient_shares' }
  } else {
    try {
      const call = await client.call({
        to: STAKED_USDAT_VAULT,
        account: input.holder,
        data: encodeFunctionData({
          abi: vaultAbi,
          functionName: 'requestRedeem',
          args: [BigInt(input.sharesRaw), 0n],
        }),
        gas: 15_000_000n,
        ...pinned,
      })
      if (!call.data) throw new Error('staked_usdat_exit_simulation_empty')
      request = {
        status: 'success',
        requestTokenId: decodeFunctionResult({
          abi: vaultAbi,
          functionName: 'requestRedeem',
          data: call.data,
        }).toString(),
      }
    } catch (error) {
      if (!isEvmRevert(error)) throw error
      request = { status: 'evm_revert' }
    }
  }

  let existingTicket: NonNullable<StakedUsdatExitResult['current']>['existingTicket'] = null
  if (input.requestTokenId !== undefined) {
    const tokenId = BigInt(input.requestTokenId)
    let ownership: 'holder' | 'other_owner' | 'not_found' = 'not_found'
    try {
      const owner = await client.readContract({
        address: STAKED_USDAT_QUEUE,
        abi: queueAbi,
        functionName: 'ownerOf',
        args: [tokenId],
        ...pinned,
      })
      ownership = same(owner, input.holder) ? 'holder' : 'other_owner'
    } catch (error) {
      if (!isEvmRevert(error)) throw error
    }
    let claimSimulation: NonNullable<
      NonNullable<StakedUsdatExitResult['current']>['existingTicket']
    >['claimSimulation'] =
      ownership === 'holder'
        ? 'evm_revert'
        : ownership === 'other_owner'
          ? 'not_holder'
          : 'not_found'
    let simulatedUsdatRaw: string | null = null
    let requestedAtUnix: string | null = null
    let recordedRequest: StakedUsdatRecordedRequest | null = null
    let requestedLimit: RequestedTicketLimit | null = null
    if (ownership === 'holder') {
      const ticket = await client.readContract({
        address: STAKED_USDAT_QUEUE,
        abi: queueAbi,
        functionName: 'requests',
        args: [tokenId],
        ...pinned,
      })
      const requestedAt = ticket[2]
      const validTimestamp =
        typeof requestedAt === 'bigint' && requestedAt > 0n && requestedAt <= BigInt(blockTimestamp)
      requestedAtUnix = validTimestamp ? requestedAt.toString() : null
      const validTuple =
        [ticket[0], ticket[1], requestedAt, ticket[3]].every(
          (v) => typeof v === 'bigint' && v >= 0n && v <= MAX_U256,
        ) &&
        ticket[0] > 0n &&
        validTimestamp &&
        Number.isSafeInteger(ticket[4]) &&
        ticket[4] >= 0 &&
        ticket[4] <= 255
      if (validTuple) {
        recordedRequest = {
          sharesRaw18: ticket[0].toString(),
          usdatOwedRaw6: ticket[1].toString(),
          requestedAtUnix: requestedAt.toString(),
          minSharePriceRaw: ticket[3].toString(),
          rawStatus: ticket[4],
        }
      }
      if (validTuple && ticket[4] === 1) {
        const ticketShares = ticket[0]
        const minSharePrice = ticket[3]
        if (ticketShares <= 0n || minSharePrice < 0n)
          throw new Error('staked_usdat_ticket_state_invalid')
        let currentQuoteUsdatRaw: string | null = null
        let currentNetSharePriceRaw: string | null = null
        let comparison: RequestedTicketLimit['comparison'] = 'quote_unavailable'
        try {
          const quote = await client.readContract({
            address: STAKED_USDAT_VAULT,
            abi: vaultAbi,
            functionName: 'previewRedeem',
            args: [ticketShares],
            ...pinned,
          })
          const price = (quote * 10n ** 18n) / ticketShares
          currentQuoteUsdatRaw = quote.toString()
          currentNetSharePriceRaw = price.toString()
          comparison = price < minSharePrice ? 'above_current_quote' : 'at_or_below_current_quote'
        } catch (error) {
          if (!isEvmRevert(error)) throw error
        }
        let limitUpdateSimulation: RequestedTicketLimit['limitUpdateSimulation'] = 'evm_revert'
        try {
          await client.call({
            to: STAKED_USDAT_QUEUE,
            account: input.holder,
            data: encodeFunctionData({
              abi: queueAbi,
              functionName: 'updateMinSharePrice',
              args: [tokenId, minSharePrice],
            }),
            gas: 15_000_000n,
            ...pinned,
          })
          limitUpdateSimulation = 'success'
        } catch (error) {
          if (!isEvmRevert(error)) throw error
        }
        requestedLimit = {
          sharesRaw: ticketShares.toString(),
          minSharePriceRaw: minSharePrice.toString(),
          currentQuoteUsdatRaw,
          currentNetSharePriceRaw,
          comparison,
          limitUpdateSimulation,
        }
      }
      try {
        const call = await client.call({
          to: STAKED_USDAT_QUEUE,
          account: input.holder,
          data: encodeFunctionData({ abi: queueAbi, functionName: 'claim', args: [tokenId] }),
          gas: 15_000_000n,
          ...pinned,
        })
        if (!call.data) throw new Error('staked_usdat_claim_simulation_empty')
        simulatedUsdatRaw = decodeFunctionResult({
          abi: queueAbi,
          functionName: 'claim',
          data: call.data,
        }).toString()
        claimSimulation = 'success'
      } catch (error) {
        if (!isEvmRevert(error)) throw error
      }
    }
    existingTicket = {
      tokenId: input.requestTokenId,
      ownership,
      claimSimulation,
      simulatedUsdatRaw,
      requestedAtUnix,
      recordedRequest,
      requestedLimit,
      delivery: 'not_observed',
    }
  }

  await confirm()
  return {
    status: 'observed',
    evidence,
    current: {
      requestedSharesRaw: input.sharesRaw,
      holderSharesRaw: holderShares.toString(),
      maxRedeemSharesRaw: maxRedeemShares.toString(),
      previewUsdatRaw,
      vaultPaused,
      queuePaused,
      requestMinSharePriceRaw: '0',
      request,
      requestDelivery: 'queue_ticket_only',
      existingTicket,
      originalAusdConversion: 'not_assayed',
      settlementDuration: 'unestimated',
    },
  }
}
