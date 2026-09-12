/**
 * SERVER-ONLY. Pulls an address's REAL liquidation history off mainnet and replays
 * every event through `replayLiquidation`.
 *
 * NEVER import this from a component. It scans logs over the whole Aave V3 history and
 * is called once per address per day from pages/api/sim/history/[address].ts, behind a
 * Neon cache table (sim_history). The brief's constraint is explicit: cache on-chain
 * data, no per-render live requeries.
 *
 * WHAT IS OBSERVED
 *   - the LiquidationCall events themselves (Aave V3 Pool, user as topic3)
 *   - the block timestamp of each
 *   - the collateral/debt token amounts, scaled by the token's own decimals
 *   - the Chainlink AnswerUpdated rounds that priced the collateral over the 8 hours
 *     that followed, read from the feed's phase aggregators
 *
 * WHAT IS RECONSTRUCTED, AND WHY (this is the approximation the response `method`
 * string discloses verbatim — do not change one without the other):
 *   - `liqLine` is the RESERVE's liquidation threshold, read from Aave's
 *     PoolDataProvider at the event block when the RPC serves archive state, and at
 *     the current block (stamped 'current params') when it refuses. A multi-collateral
 *     account's real line is a value-weighted blend of its reserves, which needs the
 *     full account state at a historical block — several archive reads per event, which
 *     no keyless endpoint will serve. The single-reserve threshold is the honest
 *     approximation and it is named on screen.
 *   - `ltvAtEvent` = `liqLine`. An account being liquidated was, by definition, at or
 *     over its line. This is not a measurement; it is the definition of the event.
 *
 * WHAT IS NOT SCANNED
 *   - Morpho Blue. Its `Liquidate` event has the same borrower-as-topic3 shape, but
 *     pricing it needs an `idToMarketParams(id)` resolution per market plus each
 *     market's own LLTV, which is a second pricing path rather than the same one.
 *     TODO(history): add a morphoBlue scanner and drop it from `notScanned`.
 *   - Compound V3, Spark, Fluid. Same reason.
 */

import {
  createPublicClient,
  fallback,
  getAddress,
  http,
  parseAbiItem,
  type Address,
  type PublicClient,
} from 'viem'
import { mainnet } from 'viem/chains'

import {
  DEFAULT_REPLAY_PARAMS,
  replayLiquidation,
  totalHistory,
  type HistoryEvent,
  type HistoryResponse,
  type PriceRound,
} from './history'
import { PUBLIC_MAINNET_RPCS } from './rpc'

// ------------------------------------------------------------------ constants

/** Aave V3 mainnet Pool proxy — deployed at block 16291127 and never moved. Resolved
 *  through the addresses provider at run time; this is the fallback. */
const AAVE_V3_POOL_FALLBACK = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fa4E2' as Address
const AAVE_V3_ADDRESSES_PROVIDER = '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e' as Address
/** Aave V3 mainnet deploy block. Nothing before it can hold a LiquidationCall. */
export const AAVE_V3_START_BLOCK = 16_291_127n

/** ~12 s blocks. 8 hours of cure window is 2,400 of them; we take a little more so the
 *  window's last round is always inside the span, and look back for the anchor round. */
const BLOCKS_AFTER = 2_600n
const BLOCKS_BEFORE = 1_400n

/** Hard bound from the brief. A wallet with more history than this is truncated to the
 *  most recent 200 events and the response says so. */
export const MAX_EVENTS = 200

const LIQUIDATION_CALL = parseAbiItem(
  'event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)',
)

const ANSWER_UPDATED = parseAbiItem(
  'event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)',
)

const providerAbi = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'getPoolDataProvider',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const

const dataProviderAbi = [
  {
    type: 'function',
    name: 'getReserveConfigurationData',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'decimals', type: 'uint256' },
      { name: 'ltv', type: 'uint256' },
      { name: 'liquidationThreshold', type: 'uint256' },
      { name: 'liquidationBonus', type: 'uint256' },
      { name: 'reserveFactor', type: 'uint256' },
      { name: 'usageAsCollateralEnabled', type: 'bool' },
      { name: 'borrowingEnabled', type: 'bool' },
      { name: 'stableBorrowRateEnabled', type: 'bool' },
      { name: 'isActive', type: 'bool' },
      { name: 'isFrozen', type: 'bool' },
    ],
  },
] as const

const proxyAbi = [
  {
    type: 'function',
    name: 'phaseId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint16' }],
  },
  {
    type: 'function',
    name: 'phaseAggregators',
    stateMutability: 'view',
    inputs: [{ type: 'uint16' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'aggregator',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const

const wstEthAbi = [
  {
    type: 'function',
    name: 'stEthPerToken',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const

/** Chainlink mainnet USD feed PROXIES, 8 decimals. The proxy is the stable address; the
 *  AnswerUpdated logs live on its phase aggregators, resolved at run time below.
 *
 *  NOT FOUND IN THIS REPO: the Oct 10 dataset was built from Chainlink logs
 *  (public/data/oct10-2025/manifest.json) but scripts/build-oct10-dataset.ts consumes a
 *  CSV produced outside the repo, so no feed address is committed anywhere. These are
 *  the canonical mainnet proxies and each one's `description()` is checkable on chain. */
const FEEDS = {
  ETH_USD: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419' as Address,
  BTC_USD: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c' as Address,
  STETH_USD: '0xCfE54B5cD566aB89272946F602D76Ea879CAb4a8' as Address,
}

const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0' as Address

type Pricing =
  | { kind: 'feed'; feed: Address }
  /** wstETH has no USD feed: stETH/USD × stEthPerToken. The wrap ratio cancels out of
   *  the LTV walk (it is a constant over 8 hours), so it only scales the USD figure. */
  | { kind: 'wsteth'; feed: Address }
  | { kind: 'stable' }

interface TokenMeta {
  symbol: string
  decimals: number
  pricing: Pricing
}

/** Only what we can price honestly. Anything absent is reported 'unpriced' and counted
 *  in NEITHER direction — never approximated by a neighbouring asset. */
const TOKENS: Record<string, TokenMeta> = {
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': {
    symbol: 'WETH',
    decimals: 18,
    pricing: { kind: 'feed', feed: FEEDS.ETH_USD },
  },
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': {
    symbol: 'WBTC',
    decimals: 8,
    pricing: { kind: 'feed', feed: FEEDS.BTC_USD },
  },
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': {
    symbol: 'cbBTC',
    decimals: 8,
    pricing: { kind: 'feed', feed: FEEDS.BTC_USD },
  },
  '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0': {
    symbol: 'wstETH',
    decimals: 18,
    pricing: { kind: 'wsteth', feed: FEEDS.STETH_USD },
  },
  '0xae7ab96520de3a18e5e111b5eaab095312d7fe84': {
    symbol: 'stETH',
    decimals: 18,
    pricing: { kind: 'feed', feed: FEEDS.STETH_USD },
  },
  // Stables, held at $1.00 for the whole window. Stated in `method`, never silent.
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': {
    symbol: 'USDC',
    decimals: 6,
    pricing: { kind: 'stable' },
  },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': {
    symbol: 'USDT',
    decimals: 6,
    pricing: { kind: 'stable' },
  },
  '0x6b175474e89094c44da98b954eedeac495271d0f': {
    symbol: 'DAI',
    decimals: 18,
    pricing: { kind: 'stable' },
  },
  '0xdc035d45d973e3ec169d2276ddab16f1e407384f': {
    symbol: 'USDS',
    decimals: 18,
    pricing: { kind: 'stable' },
  },
  '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f': {
    symbol: 'GHO',
    decimals: 18,
    pricing: { kind: 'stable' },
  },
  '0x5f98805a4e8be255a32880fdec7f6728c6568ba0': {
    symbol: 'LUSD',
    decimals: 18,
    pricing: { kind: 'stable' },
  },
  '0x853d955acef822db058eb8505911ed77f175b99e': {
    symbol: 'FRAX',
    decimals: 18,
    pricing: { kind: 'stable' },
  },
  '0xf939e0a03fb07f59a73314e73794be0e57ac1b4e': {
    symbol: 'crvUSD',
    decimals: 18,
    pricing: { kind: 'stable' },
  },
  '0x6c3ea9036406852006290770bedfcaba0e23a0e8': {
    symbol: 'PYUSD',
    decimals: 6,
    pricing: { kind: 'stable' },
  },
  '0x4c9edd5852cd905f086c759e8383e09bff1e68b3': {
    symbol: 'USDe',
    decimals: 18,
    pricing: { kind: 'stable' },
  },
}

// --------------------------------------------------------------------- client

/**
 * The RPC ring, widest-capability first.
 *
 * Tenderly's public gateway leads because the Oct 10 pull established it as the only
 * keyless endpoint that reliably served both archive state and large getLogs spans
 * (public/data/oct10-2025/manifest.json). RECORDER_RPC_URL's own comma list follows —
 * it is the recorder's ring and is set on the box that runs the hourly tick. Note that
 * two of its members are BUILDER RELAYS (mevblocker, flashbots) which do not serve
 * eth_getLogs at all; viem's fallback moves past them on error.
 */
export function historyRpcUrls(): string[] {
  const out: string[] = []
  const push = (u?: string | null) => {
    for (const part of String(u ?? '').split(',')) {
      const s = part.trim()
      if (s && !out.includes(s)) out.push(s)
    }
  }
  push(process.env.NEXT_PUBLIC_MAINNET_RPC_URL)
  push(PUBLIC_MAINNET_RPCS[0])
  push(process.env.RECORDER_RPC_URL)
  for (const u of PUBLIC_MAINNET_RPCS.slice(1)) push(u)
  return out
}

export function makeHistoryClient(urls: string[] = historyRpcUrls()): PublicClient {
  return createPublicClient({
    chain: mainnet,
    transport: fallback(
      urls.map((u) => http(u, { timeout: 20_000, retryCount: 1 })),
      { rank: false, retryCount: 1 },
    ),
  }) as PublicClient
}

// ---------------------------------------------------------------- chunked logs

export interface ChunkedLogsResult<T> {
  logs: T[]
  /** False when the scan gave up before reaching `toBlock`. */
  complete: boolean
  /** The first block of the span that failed, when `complete` is false. */
  failedAtBlock?: bigint
  failure?: string
  requests: number
  /** The span that actually worked, for the log line. */
  spanUsed: bigint
}

/**
 * getLogs over a very wide range, adaptively.
 *
 * A full Aave V3 history is ~7.5M blocks. At the recorder's 2k-block chunk that is
 * ~3,700 round trips, which no request can afford — so we START WIDE and only narrow
 * on failure: 2M → 400k → 80k → 16k → 2k (the recorder's floor). An endpoint that
 * serves the whole range in one call costs one request; one that caps at 10k costs a
 * bounded, reported number. When the budget runs out we return what we have and say
 * exactly which block we stopped at, rather than pretending the wallet is clean.
 */
export async function getLogsChunked<T>(
  client: PublicClient,
  args: {
    address: Address
    event: typeof LIQUIDATION_CALL | typeof ANSWER_UPDATED
    eventArgs?: Record<string, unknown>
    fromBlock: bigint
    toBlock: bigint
  },
  budget: { maxRequests: number; deadlineMs: number },
): Promise<ChunkedLogsResult<T>> {
  const spans = [2_000_000n, 400_000n, 80_000n, 16_000n, 2_000n]
  const logs: T[] = []
  let requests = 0
  let cursor = args.fromBlock
  let spanIdx = 0
  let lastFailure: string | undefined

  while (cursor <= args.toBlock) {
    if (requests >= budget.maxRequests || Date.now() > budget.deadlineMs) {
      return {
        logs,
        complete: false,
        failedAtBlock: cursor,
        failure:
          requests >= budget.maxRequests
            ? `ran out of RPC requests (${requests}) at block ${cursor}`
            : `ran out of time at block ${cursor}`,
        requests,
        spanUsed: spans[spanIdx],
      }
    }
    const span = spans[spanIdx]
    const to = cursor + span - 1n > args.toBlock ? args.toBlock : cursor + span - 1n
    requests += 1
    try {
      const got = (await client.getLogs({
        address: args.address,
        event: args.event as never,
        args: args.eventArgs as never,
        fromBlock: cursor,
        toBlock: to,
      })) as unknown as T[]
      logs.push(...got)
      cursor = to + 1n
    } catch (e) {
      lastFailure = e instanceof Error ? e.message : String(e)
      if (spanIdx === spans.length - 1) {
        return {
          logs,
          complete: false,
          failedAtBlock: cursor,
          failure: `getLogs failed at the 2,000-block floor from block ${cursor}: ${lastFailure}`,
          requests,
          spanUsed: span,
        }
      }
      spanIdx += 1
    }
  }
  return { logs, complete: true, requests, spanUsed: spans[spanIdx] }
}

// ------------------------------------------------------------------- pricing

const aggregatorCache = new Map<string, Address[]>()

/** Every phase aggregator a feed proxy has ever pointed at. AnswerUpdated is emitted by
 *  the AGGREGATOR, not the proxy, and an old event sits on an old phase — reading only
 *  `aggregator()` would silently return zero rounds for anything before the last phase
 *  change. */
async function feedAggregators(client: PublicClient, proxy: Address): Promise<Address[]> {
  const key = proxy.toLowerCase()
  const hit = aggregatorCache.get(key)
  if (hit) return hit
  const out: Address[] = []
  try {
    const phase = (await client.readContract({
      address: proxy,
      abi: proxyAbi,
      functionName: 'phaseId',
    })) as number
    for (let i = 1; i <= Number(phase); i++) {
      try {
        const a = (await client.readContract({
          address: proxy,
          abi: proxyAbi,
          functionName: 'phaseAggregators',
          args: [i],
        })) as Address
        if (a && a !== '0x0000000000000000000000000000000000000000') out.push(a)
      } catch {
        /* a missing phase is not fatal — keep the ones we have */
      }
    }
  } catch {
    /* fall through to the single-aggregator read */
  }
  if (out.length === 0) {
    try {
      const a = (await client.readContract({
        address: proxy,
        abi: proxyAbi,
        functionName: 'aggregator',
      })) as Address
      if (a) out.push(a)
    } catch {
      /* no aggregator: the caller will see zero rounds and mark the event unpriced */
    }
  }
  aggregatorCache.set(key, out)
  return out
}

/** AnswerUpdated rounds for one feed over a block span, as {ts, price} in USD. */
async function feedRounds(
  client: PublicClient,
  proxy: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<PriceRound[]> {
  const aggs = await feedAggregators(client, proxy)
  if (aggs.length === 0) return []
  const rounds: PriceRound[] = []
  for (const agg of aggs) {
    try {
      const logs = await client.getLogs({ address: agg, event: ANSWER_UPDATED, fromBlock, toBlock })
      for (const l of logs) {
        const a = l.args as { current?: bigint; updatedAt?: bigint }
        if (a.current === undefined || a.updatedAt === undefined) continue
        if (a.current <= 0n) continue
        rounds.push({ ts: Number(a.updatedAt), price: Number(a.current) / 1e8 })
      }
    } catch {
      /* one dead phase aggregator must not blank the window */
    }
  }
  return rounds.sort((a, b) => a.ts - b.ts)
}

// ---------------------------------------------------------------------- scan

export interface ScanOptions {
  /** Wall-clock budget for the whole scan. */
  timeoutMs?: number
  maxRequests?: number
  client?: PublicClient
}

interface LiqLog {
  args: {
    collateralAsset?: Address
    debtAsset?: Address
    user?: Address
    debtToCover?: bigint
    liquidatedCollateralAmount?: bigint
  }
  blockNumber: bigint
  transactionHash: `0x${string}`
}

/**
 * Scan and replay. Returns the exact shape the API serves, including the `method`
 * string, so the offline script and the route cannot describe the same scan two ways.
 */
export async function scanHistory(
  address: string,
  opts: ScanOptions = {},
): Promise<HistoryResponse> {
  const started = Date.now()
  const deadlineMs = started + (opts.timeoutMs ?? 55_000)
  const client = opts.client ?? makeHistoryClient()
  const user = getAddress(address)
  const notScanned = ['Morpho Blue', 'Compound V3', 'Spark', 'Fluid']

  const base = {
    address: user,
    since: { firstEventTs: null as number | null },
    events: [] as HistoryEvent[],
    totals: totalHistory([]),
    provenance: 'observed' as const,
    scannedAt: new Date().toISOString(),
    notScanned,
  }

  let pool: Address = AAVE_V3_POOL_FALLBACK
  let dataProvider: Address | null = null
  try {
    pool = (await client.readContract({
      address: AAVE_V3_ADDRESSES_PROVIDER,
      abi: providerAbi,
      functionName: 'getPool',
    })) as Address
    dataProvider = (await client.readContract({
      address: AAVE_V3_ADDRESSES_PROVIDER,
      abi: providerAbi,
      functionName: 'getPoolDataProvider',
    })) as Address
  } catch {
    /* keep the fallback pool; a missing data provider only costs us the read line */
  }

  let head: bigint
  try {
    head = await client.getBlockNumber()
  } catch (e) {
    return {
      ...base,
      method: 'The scan could not reach an Ethereum node.',
      error: `No RPC in the ring answered eth_blockNumber: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  const scan = await getLogsChunked<LiqLog>(
    client,
    {
      address: pool,
      event: LIQUIDATION_CALL,
      eventArgs: { user },
      fromBlock: AAVE_V3_START_BLOCK,
      toBlock: head,
    },
    { maxRequests: opts.maxRequests ?? 400, deadlineMs },
  )

  if (!scan.complete && scan.logs.length === 0) {
    return {
      ...base,
      method:
        'The Aave V3 log scan did not complete, so no history can be reported for this address.',
      error: `Aave V3 LiquidationCall scan failed: ${scan.failure ?? 'unknown'} (RPC ring: ${historyRpcUrls().length} endpoints, ${scan.requests} requests made).`,
    }
  }

  const all = scan.logs.slice().sort((a, b) => Number(a.blockNumber - b.blockNumber))
  const truncated = all.length > MAX_EVENTS
  const logs = truncated ? all.slice(-MAX_EVENTS) : all

  let usedCurrentParams = false
  let anyArchive = false
  const events: HistoryEvent[] = []

  for (const log of logs) {
    if (Date.now() > deadlineMs) break
    const collAddr = (log.args.collateralAsset ?? '0x') as Address
    const debtAddr = (log.args.debtAsset ?? '0x') as Address
    const coll = TOKENS[collAddr.toLowerCase()]
    const debt = TOKENS[debtAddr.toLowerCase()]

    let ts = 0
    try {
      const block = await client.getBlock({ blockNumber: log.blockNumber })
      ts = Number(block.timestamp)
    } catch {
      /* leave ts 0 — handled as unpriced below */
    }

    const label = coll?.symbol ?? shortAddr(collAddr)

    if (!coll || !debt || ts === 0) {
      events.push({
        ts,
        protocol: 'Aave V3',
        collateral: label,
        actualSeizedUsd: 0,
        verdict: 'unknown',
        membraneSeizedUsd: 0,
        membraneShare: null,
        why:
          !coll || !debt
            ? 'unpriced — no committed price source for this asset pair'
            : 'unpriced — the block timestamp could not be read',
      })
      continue
    }

    // ---- the reserve's liquidation threshold, at the event block if we can get it
    let liqLine = 0
    if (dataProvider) {
      const read = async (blockNumber?: bigint) =>
        (await client.readContract({
          address: dataProvider as Address,
          abi: dataProviderAbi,
          functionName: 'getReserveConfigurationData',
          args: [collAddr],
          ...(blockNumber === undefined ? {} : { blockNumber }),
        })) as readonly bigint[]
      try {
        const cfg = await read(log.blockNumber)
        liqLine = Number(cfg[2]) / 10_000
        anyArchive = true
      } catch {
        try {
          const cfg = await read()
          liqLine = Number(cfg[2]) / 10_000
          usedCurrentParams = true
        } catch {
          liqLine = 0
        }
      }
    }
    if (!(liqLine > 0)) {
      events.push({
        ts,
        protocol: 'Aave V3',
        collateral: label,
        actualSeizedUsd: 0,
        verdict: 'unknown',
        membraneSeizedUsd: 0,
        membraneShare: null,
        why: 'unpriced — the reserve liquidation threshold could not be read',
      })
      continue
    }

    // ---- the rounds that priced this collateral across the window
    const from = log.blockNumber > BLOCKS_BEFORE ? log.blockNumber - BLOCKS_BEFORE : 0n
    const to = log.blockNumber + BLOCKS_AFTER
    let rounds: PriceRound[] = []
    let wrap = 1
    if (coll.pricing.kind === 'stable') {
      // A stable collateral does not move: one flat round at the event and one at the
      // window end. Honest, and it makes the verdict deterministic rather than absent.
      rounds = [
        { ts: ts - 1, price: 1 },
        { ts: ts + DEFAULT_REPLAY_PARAMS.cureWindowSeconds, price: 1 },
      ]
    } else {
      rounds = await feedRounds(client, coll.pricing.feed, from, to)
      if (coll.pricing.kind === 'wsteth') {
        wrap = await stEthPerToken(client, log.blockNumber)
      }
    }

    const collAmount = Number(log.args.liquidatedCollateralAmount ?? 0n) / 10 ** coll.decimals
    const debtAmount = Number(log.args.debtToCover ?? 0n) / 10 ** debt.decimals

    const priceAt = (target: number): number | null => {
      const before = rounds.filter((r) => r.ts <= target)
      if (before.length > 0) return before[before.length - 1].price
      return rounds.length > 0 ? rounds[0].price : null
    }
    const collPrice = coll.pricing.kind === 'stable' ? 1 : priceAt(ts)
    const debtPrice =
      debt.pricing.kind === 'stable' ? 1 : await spotPrice(client, debt, log.blockNumber, ts)

    if (collPrice === null || debtPrice === null) {
      events.push({
        ts,
        protocol: 'Aave V3',
        collateral: label,
        actualSeizedUsd: 0,
        verdict: 'unknown',
        membraneSeizedUsd: 0,
        membraneShare: null,
        why: 'unpriced — no oracle round covers this event',
      })
      continue
    }

    const collateralSeizedUsd = collAmount * collPrice * wrap
    const debtRepaidUsd = debtAmount * debtPrice

    const r = replayLiquidation(
      { ts, collateralSeizedUsd, debtRepaidUsd, ltvAtEvent: liqLine, liqLine },
      rounds,
    )

    events.push({
      ts,
      protocol: 'Aave V3',
      collateral: label,
      actualSeizedUsd: r.actualSeizedUsd,
      verdict: r.verdict,
      membraneSeizedUsd: r.membraneSeizedUsd,
      membraneShare: r.membraneShare,
      recoveredAt: r.recoveredAt,
      brokeAt: r.brokeAt,
      why: r.why,
    })
  }

  const priced = events.filter((e) => e.ts > 0)
  const firstEventTs = priced.length > 0 ? Math.min(...priced.map((e) => e.ts)) : null

  return {
    ...base,
    since: { firstEventTs },
    events,
    totals: totalHistory(events),
    scannedAt: new Date().toISOString(),
    scannedToBlock: head.toString(),
    method: buildMethod({
      eventCount: events.length,
      truncated,
      incomplete: !scan.complete,
      failedAtBlock: scan.failedAtBlock,
      usedCurrentParams,
      anyArchive,
      notScanned,
    }),
    ...(scan.complete
      ? {}
      : {
          error: `The Aave V3 log scan stopped early: ${scan.failure}. Events before that block are missing.`,
        }),
  }
}

async function stEthPerToken(client: PublicClient, blockNumber: bigint): Promise<number> {
  const read = async (b?: bigint) =>
    (await client.readContract({
      address: WSTETH,
      abi: wstEthAbi,
      functionName: 'stEthPerToken',
      ...(b === undefined ? {} : { blockNumber: b }),
    })) as bigint
  try {
    return Number(await read(blockNumber)) / 1e18
  } catch {
    try {
      return Number(await read()) / 1e18
    } catch {
      return 1
    }
  }
}

/** One price for a DEBT asset at the event. Debt only needs a point, not a path. */
async function spotPrice(
  client: PublicClient,
  token: TokenMeta,
  blockNumber: bigint,
  ts: number,
): Promise<number | null> {
  if (token.pricing.kind === 'stable') return 1
  const from = blockNumber > BLOCKS_BEFORE ? blockNumber - BLOCKS_BEFORE : 0n
  const rounds = await feedRounds(client, token.pricing.feed, from, blockNumber)
  if (rounds.length === 0) return null
  const before = rounds.filter((r) => r.ts <= ts)
  const p = before.length > 0 ? before[before.length - 1].price : rounds[0].price
  if (token.pricing.kind === 'wsteth') return p * (await stEthPerToken(client, blockNumber))
  return p
}

const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

/**
 * THE METHOD STRING. Rendered verbatim as one fine-print bullet, so it has to be one
 * readable paragraph and it has to name every approximation the scan actually made.
 */
function buildMethod(x: {
  eventCount: number
  truncated: boolean
  incomplete: boolean
  failedAtBlock?: bigint
  usedCurrentParams: boolean
  anyArchive: boolean
  notScanned: string[]
}): string {
  const parts: string[] = []
  parts.push(
    `Every Aave V3 LiquidationCall with this address as the liquidated user, from the Aave V3 deploy block (16,291,127) to the current head, decoded from mainnet logs. ` +
      `Each event is replayed against Membrane's 8-hour cure window and 4% break band: debt is held fixed, the collateral is repriced by the Chainlink rounds that actually printed over the following 8 hours, and the event counts as SAVED only if the price came back under the borrow line (liquidation line − 3pp) inside the window.`,
  )
  parts.push(
    `The account's liquidation line is approximated by the SEIZED RESERVE's own liquidation threshold${
      x.usedCurrentParams
        ? ' (read at the current block and stamped current params where the node refused archive state)'
        : x.anyArchive
          ? ' read at the event block'
          : ''
    }, and the LTV at the event is taken to equal that line — an account being liquidated was at or over it by definition. A multi-collateral account's true blended line is not cheaply readable at a historical block.`,
  )
  parts.push(
    `Position size is the liquidated slice itself: debt = the USD the liquidator repaid, collateral = that debt at the event LTV, so "x% instead of 100%" means x% of what was actually closed. Stablecoins are held at $1.00; wstETH is priced as stETH/USD × stEthPerToken. Assets with no committed price source are listed unpriced and counted in neither direction.`,
  )
  if (x.truncated) parts.push(`Only the most recent ${MAX_EVENTS} events were replayed.`)
  if (x.incomplete)
    parts.push(
      `The log scan stopped at block ${x.failedAtBlock ?? '?'} — earlier events are missing from this total.`,
    )
  parts.push(`Not scanned: ${x.notScanned.join(', ')}.`)
  return parts.join(' ')
}
