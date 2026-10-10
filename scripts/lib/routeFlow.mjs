// Finalized, route-aligned secondary-exit flow evidence. Swaps describe use of
// the route; endpoint inventory is the observed capacity change. Neither is a
// forecast, and a swap sum is not an attribution of the inventory delta.
import { createHash } from 'node:crypto'
import { decodeEventLog, getAddress, parseAbiItem, toEventHash } from 'viem'

const HASH = /^0x[0-9a-fA-F]{64}$/
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/
const CURVE_SWAP = parseAbiItem(
  'event TokenExchange(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)',
)
const BUY_GEM = parseAbiItem('event BuyGem(address indexed owner, uint256 value, uint256 fee)')
const SELL_GEM = parseAbiItem('event SellGem(address indexed owner, uint256 value, uint256 fee)')
const PSM_LEG_SCOPE = 'shared_psm_buy_sell_gem_leg'
const CURVE_ABI = [
  {
    type: 'function',
    name: 'coins',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'balances',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
]
const PSM_ABI = [
  {
    type: 'function',
    name: 'pocket',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'gem',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
]
const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
]
const lower = (value) => getAddress(value).toLowerCase()
export const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function routeFor(venue) {
  if (!['sUSDe', 'sUSDS', 'scrvUSD'].includes(venue.name) || venue.enabled !== true)
    throw new Error('route_flow_unsupported_venue')
  const markets = (venue.depthMarkets ?? []).filter((market) => market.enabled)
  if (markets.length !== (venue.name === 'scrvUSD' ? 2 : 1))
    throw new Error('route_flow_market_set_changed')
  const route = markets.map((market) => {
    if (market.kind === 'curve-stableswap') {
      const token0 = lower(market.token0)
      const token1 = lower(market.token1)
      const exitFrom = lower(market.exitFrom)
      if (token0 === token1 || ![token0, token1].includes(exitFrom))
        throw new Error('route_flow_invalid_curve_direction')
      return {
        kind: 'curve-stableswap',
        address: lower(market.address),
        token0,
        token1,
        exitFrom,
        outputIndex: token0 === exitFrom ? 1 : 0,
      }
    }
    if (market.kind === 'psm-buffer') {
      if (lower(market.exitFrom) !== lower(venue.underlying))
        throw new Error('route_flow_invalid_psm_exit')
      return {
        kind: 'psm-buffer',
        address: lower(market.address),
        pocket: lower(market.buffer),
        gem: lower(market.bufferToken),
        exitFrom: lower(market.exitFrom),
        legScope: PSM_LEG_SCOPE,
        outputIndex: null,
      }
    }
    throw new Error('route_flow_unsupported_amm')
  })
  if (
    venue.name === 'sUSDS'
      ? route[0].kind !== 'psm-buffer'
      : route.some((r) => r.kind !== 'curve-stableswap')
  )
    throw new Error('route_flow_wrong_market_kind')
  return route
}

function checkedBlock(block, expected) {
  if (
    block?.number !== expected ||
    !HASH.test(block.hash ?? '') ||
    typeof block.timestamp !== 'bigint'
  )
    throw new Error('route_flow_invalid_block')
  return {
    number: String(expected),
    hash: block.hash.toLowerCase(),
    timestamp: Number(block.timestamp),
  }
}

export async function inventoryAt(client, route, blockNumber) {
  const result = []
  for (const market of route) {
    if (market.kind === 'curve-stableswap') {
      const [token0, token1, balance, decimals] = await Promise.all([
        client.readContract({
          address: market.address,
          abi: CURVE_ABI,
          functionName: 'coins',
          args: [0n],
          blockNumber,
        }),
        client.readContract({
          address: market.address,
          abi: CURVE_ABI,
          functionName: 'coins',
          args: [1n],
          blockNumber,
        }),
        client.readContract({
          address: market.address,
          abi: CURVE_ABI,
          functionName: 'balances',
          args: [BigInt(market.outputIndex)],
          blockNumber,
        }),
        client.readContract({
          address: market.outputIndex === 0 ? market.token0 : market.token1,
          abi: ERC20_ABI,
          functionName: 'decimals',
          blockNumber,
        }),
      ])
      if (
        lower(token0) !== market.token0 ||
        lower(token1) !== market.token1 ||
        typeof balance !== 'bigint' ||
        balance < 0n ||
        !Number.isInteger(Number(decimals)) ||
        Number(decimals) > 36
      )
        throw new Error('route_flow_curve_identity_mismatch')
      result.push({
        address: market.address,
        outputToken: market.outputIndex === 0 ? market.token0 : market.token1,
        outputDecimals: Number(decimals),
        inventoryRaw: String(balance),
        source: 'curve_balances',
      })
    } else {
      const [pocket, gem, balance, decimals] = await Promise.all([
        client.readContract({
          address: market.address,
          abi: PSM_ABI,
          functionName: 'pocket',
          blockNumber,
        }),
        client.readContract({
          address: market.address,
          abi: PSM_ABI,
          functionName: 'gem',
          blockNumber,
        }),
        client.readContract({
          address: market.gem,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [market.pocket],
          blockNumber,
        }),
        client.readContract({
          address: market.gem,
          abi: ERC20_ABI,
          functionName: 'decimals',
          blockNumber,
        }),
      ])
      if (
        lower(pocket) !== market.pocket ||
        lower(gem) !== market.gem ||
        typeof balance !== 'bigint' ||
        balance < 0n ||
        !Number.isInteger(Number(decimals)) ||
        Number(decimals) > 36
      )
        throw new Error('route_flow_psm_identity_mismatch')
      result.push({
        address: market.address,
        outputToken: market.gem,
        outputDecimals: Number(decimals),
        inventoryRaw: String(balance),
        source: 'gem_balance_of_pocket',
      })
    }
  }
  return result
}

function swapStreams(market) {
  return market.kind === 'curve-stableswap' ? [CURVE_SWAP] : [BUY_GEM, SELL_GEM]
}
export function routeStreamIdentities(route) {
  return route.flatMap((market) =>
    swapStreams(market).map((event) => ({
      market: market.address,
      topic0: toEventHash(event).toLowerCase(),
    })),
  )
}

// Raw topics/data let replay derive every projected amount and direction.
// BuyGem/SellGem describe a shared LitePSM leg, not an sUSDS holder or wrapper.
export function projectRouteLog(market, topics, data) {
  if (
    !Array.isArray(topics) ||
    topics.length !== 2 ||
    !topics.every((topic) => HASH.test(topic)) ||
    !HEX.test(data ?? '')
  )
    throw new Error('route_flow_invalid_raw_log')
  const normalizedTopics = topics.map((topic) => topic.toLowerCase())
  const normalizedData = data.toLowerCase()
  const event = swapStreams(market).find(
    (candidate) => toEventHash(candidate).toLowerCase() === normalizedTopics[0],
  )
  if (!event) throw new Error('route_flow_wrong_event_signature')
  const decoded = decodeEventLog({
    abi: [event],
    topics: normalizedTopics,
    data: normalizedData,
    strict: true,
  })
  let direction, outputRaw, inputRaw, scope
  if (market.kind === 'curve-stableswap') {
    const sold = decoded.args.sold_id
    const bought = decoded.args.bought_id
    if (![0n, 1n].includes(sold) || ![0n, 1n].includes(bought) || sold === bought)
      throw new Error('route_flow_unexpected_coin_ids')
    direction = Number(bought) === market.outputIndex ? 'toward_exit' : 'toward_entry'
    outputRaw = direction === 'toward_exit' ? decoded.args.tokens_bought : decoded.args.tokens_sold
    inputRaw = direction === 'toward_exit' ? decoded.args.tokens_sold : decoded.args.tokens_bought
    scope = 'configured_curve_pool_swap'
  } else {
    direction = decoded.eventName === 'BuyGem' ? 'buyGem' : 'sellGem'
    outputRaw = decoded.args.value
    inputRaw = null // DAI input and any USDS wrapper flow cannot be inferred from gem units.
    scope = PSM_LEG_SCOPE
  }
  if (
    typeof outputRaw !== 'bigint' ||
    outputRaw < 0n ||
    (inputRaw !== null && (typeof inputRaw !== 'bigint' || inputRaw < 0n))
  )
    throw new Error('route_flow_invalid_amount')
  return {
    topic0: normalizedTopics[0],
    topics: normalizedTopics,
    data: normalizedData,
    direction,
    outputRaw: String(outputRaw),
    inputRaw: inputRaw === null ? null : String(inputRaw),
    scope,
  }
}

async function getLogsSplit(client, request) {
  try {
    const logs = await client.getLogs(request)
    if (!Array.isArray(logs)) throw new Error('route_flow_invalid_logs')
    return logs
  } catch (error) {
    if (request.fromBlock === request.toBlock) throw error
    const mid = request.fromBlock + (request.toBlock - request.fromBlock) / 2n
    return [
      ...(await getLogsSplit(client, { ...request, toBlock: mid })),
      ...(await getLogsSplit(client, { ...request, fromBlock: mid + 1n })),
    ]
  }
}

export async function collectRouteRange({ client, venue, from, to, finalized }) {
  if ((await client.getChainId()) !== 1 || from < 1n || from > to || to > finalized.number)
    throw new Error('route_flow_invalid_finalized_range')
  const route = routeFor(venue)
  const source = checkedBlock(finalized, finalized.number)
  const [anchorBlock, endBlock] = await Promise.all([
    client.getBlock({ blockNumber: from - 1n }),
    client.getBlock({ blockNumber: to }),
  ])
  const anchor = checkedBlock(anchorBlock, from - 1n)
  const end = checkedBlock(endBlock, to)
  const [before, after] = await Promise.all([
    inventoryAt(client, route, from - 1n),
    inventoryAt(client, route, to),
  ])
  const knownBlocks = new Map([
    [anchor.number, anchor],
    [end.number, end],
  ])
  const events = []
  const streams = []
  const seen = new Set()
  for (const [marketIndex, market] of route.entries()) {
    for (const event of swapStreams(market)) {
      const topic0 = toEventHash(event).toLowerCase()
      const logs = await getLogsSplit(client, {
        address: market.address,
        event,
        fromBlock: from,
        toBlock: to,
      })
      streams.push({
        market: market.address,
        topic0,
        status: 'rpc_returned_not_independently_proven',
        count: logs.length,
      })
      for (const log of logs) {
        if (
          typeof log.blockNumber !== 'bigint' ||
          log.blockNumber < from ||
          log.blockNumber > to ||
          !HASH.test(log.blockHash ?? '') ||
          !HASH.test(log.transactionHash ?? '') ||
          !Number.isSafeInteger(log.logIndex) ||
          log.logIndex < 0 ||
          log.removed === true ||
          lower(log.address) !== market.address ||
          log.topics?.[0]?.toLowerCase() !== topic0
        )
          throw new Error('route_flow_invalid_log')
        const key = `${log.transactionHash.toLowerCase()}:${log.logIndex}`
        if (seen.has(key)) throw new Error('route_flow_duplicate_log')
        seen.add(key)
        let block = knownBlocks.get(String(log.blockNumber))
        if (!block) {
          block = checkedBlock(
            await client.getBlock({ blockNumber: log.blockNumber }),
            log.blockNumber,
          )
          knownBlocks.set(block.number, block)
        }
        if (log.blockHash.toLowerCase() !== block.hash)
          throw new Error('route_flow_log_block_hash_mismatch')
        const projection = projectRouteLog(market, log.topics, log.data)
        events.push({
          market: market.address,
          marketIndex,
          block: block.number,
          blockHash: block.hash,
          blockTime: block.timestamp,
          txHash: log.transactionHash.toLowerCase(),
          logIndex: log.logIndex,
          ...projection,
          outputToken: after[marketIndex].outputToken,
          outputDecimals: after[marketIndex].outputDecimals,
        })
      }
    }
  }
  events.sort((a, b) => Number(BigInt(a.block) - BigInt(b.block)) || a.logIndex - b.logIndex)
  const eventBlockNumbers = [...new Set(events.map((event) => event.block))].sort((a, b) =>
    Number(BigInt(a) - BigInt(b)),
  )
  const eventBlocks = eventBlockNumbers.map((number) => knownBlocks.get(number))
  const [anchorAgain, endAgain, finalAgain] = await Promise.all([
    client.getBlock({ blockNumber: from - 1n }),
    client.getBlock({ blockNumber: to }),
    client.getBlock({ blockNumber: finalized.number }),
  ])
  if (
    JSON.stringify(checkedBlock(anchorAgain, from - 1n)) !== JSON.stringify(anchor) ||
    JSON.stringify(checkedBlock(endAgain, to)) !== JSON.stringify(end) ||
    JSON.stringify(checkedBlock(finalAgain, finalized.number)) !== JSON.stringify(source)
  )
    throw new Error('route_flow_boundary_hash_changed')
  for (const header of eventBlocks) {
    const again = checkedBlock(
      await client.getBlock({ blockNumber: BigInt(header.number) }),
      BigInt(header.number),
    )
    if (JSON.stringify(again) !== JSON.stringify(header))
      throw new Error('route_flow_event_header_changed')
  }
  return {
    study: 'venue-route-flow-v3',
    venue: venue.name,
    chainId: 1,
    route,
    routeHash: sha(route),
    fromBlock: String(from),
    toBlock: String(to),
    anchor,
    end,
    finalized: source,
    before,
    after,
    streams,
    eventBlocks,
    events,
    eventSetHash: sha(events),
    firstAvailableAtUtc: new Date().toISOString(),
    limits: {
      providerCompleteness: 'not_independently_proven',
      inventoryAttribution: 'unassigned',
      futureFlow: 'unavailable',
      holderExecution: 'unverified',
      psmHolderAttribution: 'unavailable_shared_psm_leg',
    },
  }
}
