import { createHash } from 'node:crypto'

import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem'

import {
  STAKED_USDAT_IMPLEMENTATION,
  STAKED_USDAT_IMPLEMENTATION_CODE_HASH,
  STAKED_USDAT_QUEUE,
  STAKED_USDAT_QUEUE_IMPLEMENTATION,
  STAKED_USDAT_QUEUE_IMPLEMENTATION_CODE_HASH,
  STAKED_USDAT_VAULT,
  USDAT_ASSET,
} from './stakedUsdatExit'

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11' as Address
const IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const
const MAX_TICKETS = 5_000
const CHUNK = 100
const SHARE_SCALE = 10n ** 18n
const queueAbi = parseAbi([
  'function nextTokenId() view returns (uint256)',
  'function requests(uint256) view returns (uint256 shares,uint256 usdatOwed,uint256 timestamp,uint256 minSharePrice,uint8 status)',
])
const vaultAbi = parseAbi(['function previewRedeem(uint256) view returns (uint256)'])
const assetAbi = parseAbi(['function balanceOf(address) view returns (uint256)'])
const multicallAbi = parseAbi([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[] returnData)',
])

export type QueuePressureClient = Pick<
  PublicClient,
  'getChainId' | 'getBlock' | 'getStorageAt' | 'getCode' | 'readContract'
>

export type StakedUsdatQueuePressure = {
  status: 'observed'
  source: { blockNumber: number; blockHash: `0x${string}`; blockTime: string; origins: 2 }
  requested: {
    tickets: number
    sharesRaw: string
    quotedUsdatRaw: string
    quotedTickets: number
    belowLimitTickets: number
    meetingLimitTickets: number
  }
  processed: { tickets: number; owedUsdatRaw: string }
  vaultCashUsdatRaw: string
  change: {
    fromBlockNumber: number
    windowSeconds: number
    requestedTicketsDelta: number
    requestedSharesRawDelta: string
    belowLimitTicketsDelta: number
    processedTicketsDelta: number
    vaultCashUsdatRawDelta: string
  } | null
  claim: 'queue_state_and_prebatch_quotes_only'
  forecastValidated: false
}

type Ticket = {
  shares: bigint
  minSharePrice: bigint
  status: number
  owed: bigint
  timestamp: bigint
}

function addressFromSlot(slot: `0x${string}` | undefined): string | null {
  return slot && /^0x[0-9a-fA-F]{64}$/.test(slot) ? `0x${slot.slice(26)}`.toLowerCase() : null
}

async function attest(client: QueuePressureClient, blockHash: `0x${string}`) {
  const pinned = { blockHash, requireCanonical: true as const }
  const [vaultSlot, queueSlot, vaultCode, queueCode] = await Promise.all([
    client.getStorageAt({ address: STAKED_USDAT_VAULT, slot: IMPLEMENTATION_SLOT, ...pinned }),
    client.getStorageAt({ address: STAKED_USDAT_QUEUE, slot: IMPLEMENTATION_SLOT, ...pinned }),
    client.getCode({ address: STAKED_USDAT_IMPLEMENTATION, ...pinned }),
    client.getCode({ address: STAKED_USDAT_QUEUE_IMPLEMENTATION, ...pinned }),
  ])
  if (
    addressFromSlot(vaultSlot) !== STAKED_USDAT_IMPLEMENTATION ||
    addressFromSlot(queueSlot) !== STAKED_USDAT_QUEUE_IMPLEMENTATION ||
    !vaultCode ||
    !queueCode ||
    keccak256(vaultCode) !== STAKED_USDAT_IMPLEMENTATION_CODE_HASH ||
    keccak256(queueCode) !== STAKED_USDAT_QUEUE_IMPLEMENTATION_CODE_HASH
  )
    throw new Error('staked_usdat_queue_identity_changed')
}

async function aggregate(
  client: QueuePressureClient,
  blockHash: `0x${string}`,
  calls: Array<{ target: Address; allowFailure: boolean; callData: `0x${string}` }>,
) {
  return client.readContract({
    address: MULTICALL3,
    abi: multicallAbi,
    functionName: 'aggregate3',
    args: [calls],
    blockHash,
  })
}

async function readOne(client: QueuePressureClient, blockHash: `0x${string}`) {
  const pinned = { blockHash, requireCanonical: true as const }
  await attest(client, blockHash)
  const [nextId, cash] = await Promise.all([
    client.readContract({
      address: STAKED_USDAT_QUEUE,
      abi: queueAbi,
      functionName: 'nextTokenId',
      ...pinned,
    }),
    client.readContract({
      address: USDAT_ASSET,
      abi: assetAbi,
      functionName: 'balanceOf',
      args: [STAKED_USDAT_VAULT],
      ...pinned,
    }),
  ])
  if (nextId > BigInt(MAX_TICKETS)) throw new Error('staked_usdat_queue_range_exceeded')
  const tickets: Ticket[] = []
  for (let start = 0; start < Number(nextId); start += CHUNK) {
    const count = Math.min(CHUNK, Number(nextId) - start)
    const calls = Array.from({ length: count }, (_, i) => ({
      target: STAKED_USDAT_QUEUE,
      allowFailure: false,
      callData: encodeFunctionData({
        abi: queueAbi,
        functionName: 'requests',
        args: [BigInt(start + i)],
      }),
    }))
    const results = await aggregate(client, blockHash, calls)
    if (results.length !== count || results.some((row) => !row.success))
      throw new Error('staked_usdat_queue_incomplete')
    for (const result of results) {
      const [shares, owed, timestamp, minSharePrice, status] = decodeFunctionResult({
        abi: queueAbi,
        functionName: 'requests',
        data: result.returnData,
      })
      if (status > 5) throw new Error('staked_usdat_queue_state_invalid')
      tickets.push({ shares, owed, timestamp, minSharePrice, status })
    }
  }
  const rowsSha256 = createHash('sha256')
    .update(
      JSON.stringify(
        tickets.map((ticket) => [
          ticket.shares.toString(),
          ticket.owed.toString(),
          ticket.timestamp.toString(),
          ticket.minSharePrice.toString(),
          ticket.status,
        ]),
      ),
    )
    .digest('hex')
  let requestedShares = 0n
  let processedOwed = 0n
  let requestedTickets = 0
  let processedTickets = 0
  const requested = tickets.filter((ticket) => ticket.status === 1)
  for (const ticket of tickets) {
    if (ticket.status === 1) {
      requestedTickets++
      requestedShares += ticket.shares
    } else if (ticket.status === 3) {
      processedTickets++
      processedOwed += ticket.owed
    }
  }
  let quotedUsdat = 0n
  let quotedTickets = 0
  let belowLimitTickets = 0
  let meetingLimitTickets = 0
  for (let start = 0; start < requested.length; start += CHUNK) {
    const slice = requested.slice(start, start + CHUNK)
    const results = await aggregate(
      client,
      blockHash,
      slice.map((ticket) => ({
        target: STAKED_USDAT_VAULT,
        allowFailure: true,
        callData: encodeFunctionData({
          abi: vaultAbi,
          functionName: 'previewRedeem',
          args: [ticket.shares],
        }),
      })),
    )
    if (results.length !== slice.length) throw new Error('staked_usdat_queue_quote_incomplete')
    results.forEach((result, index) => {
      if (!result.success || slice[index].shares === 0n) return
      const quote = decodeFunctionResult({
        abi: vaultAbi,
        functionName: 'previewRedeem',
        data: result.returnData,
      })
      const price = (quote * SHARE_SCALE) / slice[index].shares
      quotedTickets++
      quotedUsdat += quote
      if (price < slice[index].minSharePrice) belowLimitTickets++
      else meetingLimitTickets++
    })
  }
  return {
    nextId: Number(nextId),
    rowsSha256,
    requestedTickets,
    requestedShares: requestedShares.toString(),
    quotedUsdat: quotedUsdat.toString(),
    quotedTickets,
    belowLimitTickets,
    meetingLimitTickets,
    processedTickets,
    processedOwed: processedOwed.toString(),
    cash: cash.toString(),
  }
}

/** Two independent origins at the same finalized block; no recorder or user wallet required. */
export async function readStakedUsdatQueuePressure(
  clients: readonly [QueuePressureClient, QueuePressureClient],
  nowMs = Date.now(),
): Promise<StakedUsdatQueuePressure> {
  const chains = await Promise.all(clients.map((client) => client.getChainId()))
  if (chains.some((chain) => chain !== 1)) throw new Error('staked_usdat_queue_chain_invalid')
  const tips = await Promise.all(
    clients.map((client) => client.getBlock({ blockTag: 'finalized' })),
  )
  const number = tips[0].number < tips[1].number ? tips[0].number : tips[1].number
  const blocks = await Promise.all(
    clients.map((client) => client.getBlock({ blockNumber: number })),
  )
  const [block] = blocks
  if (
    !block.hash ||
    blocks[1].hash !== block.hash ||
    !Number.isSafeInteger(Number(block.timestamp)) ||
    nowMs - Number(block.timestamp) * 1000 < -120_000 ||
    nowMs - Number(block.timestamp) * 1000 > 2 * 60 * 60_000
  )
    throw new Error('staked_usdat_queue_block_unavailable')
  const rows = await Promise.all(clients.map((client) => readOne(client, block.hash!)))
  if (JSON.stringify(rows[0]) !== JSON.stringify(rows[1]))
    throw new Error('staked_usdat_queue_origins_disagree')
  const row = rows[0]
  let change: StakedUsdatQueuePressure['change'] = null
  if (number > 256n) {
    try {
      const priorNumber = number - 256n
      const priorBlocks = await Promise.all(
        clients.map((client) => client.getBlock({ blockNumber: priorNumber })),
      )
      if (priorBlocks[0].hash && priorBlocks[0].hash === priorBlocks[1].hash) {
        const priorRows = await Promise.all(
          clients.map((client) => readOne(client, priorBlocks[0].hash!)),
        )
        if (JSON.stringify(priorRows[0]) === JSON.stringify(priorRows[1])) {
          const prior = priorRows[0]
          change = {
            fromBlockNumber: Number(priorNumber),
            windowSeconds: Number(block.timestamp - priorBlocks[0].timestamp),
            requestedTicketsDelta: row.requestedTickets - prior.requestedTickets,
            requestedSharesRawDelta: (
              BigInt(row.requestedShares) - BigInt(prior.requestedShares)
            ).toString(),
            belowLimitTicketsDelta: row.belowLimitTickets - prior.belowLimitTickets,
            processedTicketsDelta: row.processedTickets - prior.processedTickets,
            vaultCashUsdatRawDelta: (BigInt(row.cash) - BigInt(prior.cash)).toString(),
          }
        }
      }
    } catch {
      // Current queue state remains valid if historical RPC state is unavailable.
    }
  }
  return {
    status: 'observed',
    source: {
      blockNumber: Number(number),
      blockHash: block.hash,
      blockTime: new Date(Number(block.timestamp) * 1000).toISOString(),
      origins: 2,
    },
    requested: {
      tickets: row.requestedTickets,
      sharesRaw: row.requestedShares,
      quotedUsdatRaw: row.quotedUsdat,
      quotedTickets: row.quotedTickets,
      belowLimitTickets: row.belowLimitTickets,
      meetingLimitTickets: row.meetingLimitTickets,
    },
    processed: { tickets: row.processedTickets, owedUsdatRaw: row.processedOwed },
    vaultCashUsdatRaw: row.cash,
    change,
    claim: 'queue_state_and_prebatch_quotes_only',
    forecastValidated: false,
  }
}
