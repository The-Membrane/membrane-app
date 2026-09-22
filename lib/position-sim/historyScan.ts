/**
 * SERVER-ONLY. Pulls an address's REAL liquidation history off mainnet and replays it
 * through `replayEpisode`.
 *
 * NEVER import this from a component. It scans logs over the whole Aave V3 / Spark /
 * Morpho Blue history and is called once per address per day from
 * pages/api/sim/history/[address].ts, behind a Neon cache table (sim_history). The
 * brief's constraint is explicit: cache on-chain data, no per-render live requeries.
 *
 * WHAT IS OBSERVED
 *   - Aave V3 and Spark `LiquidationCall` events (user as topic3)
 *   - Morpho Blue `Liquidate` events (borrower as topic3), with the market's collateral
 *     token, loan token and LLTV resolved from `idToMarketParams(id)`
 *   - the block timestamp of each
 *   - the collateral/debt token amounts, scaled by the token's own decimals
 *   - the Chainlink AnswerUpdated rounds that priced the collateral across the EPISODE
 *     span, read from the feed's phase aggregators
 *
 * WHAT IS RECONSTRUCTED, AND WHY (this is the approximation the response `method`
 * string discloses verbatim — do not change one without the other):
 *   - Aave/Spark `liqLine` is the RESERVE's liquidation threshold, read from the
 *     PoolDataProvider at the event block when the RPC serves archive state, and at the
 *     current block (stamped 'current params') when it refuses. A multi-collateral
 *     account's real line is a value-weighted blend of its reserves, which needs the
 *     full account state at a historical block — several archive reads per event, which
 *     no keyless endpoint will serve. The single-reserve threshold is the honest
 *     approximation and it is named on screen. Morpho Blue needs no approximation: a
 *     market IS one collateral and one LLTV.
 *   - `ltvAtEvent` = `liqLine`. An account being liquidated was, by definition, at or
 *     over its line. This is not a measurement; it is the definition of the event.
 *   - The liquidation FEE charged to Membrane is the source venue's own liquidation
 *     bonus (Aave/Spark: `liquidationBonus − 1`; Morpho: its LIF formula), so no save is
 *     bought by handing Membrane a cheaper liquidator than the real one.
 *
 * EPISODES, NOT EVENTS (owner ruling 2026-09-12). Real events within 24h of each other
 * are ONE episode, and Membrane's side of an episode is a CHAIN walked over the 72h
 * after its last event: a repay-to-cap leaves a position 3pp under its line, and a
 * still-falling price re-crosses it, arms a new timer and takes another bite. The
 * state machine itself lives in history.ts.
 *
 * WHAT IS NOT SCANNED — with the reason, served to the UI in `notScanned` and printed
 * verbatim in its footer. See NOT_SCANNED below.
 */

import {
  createPublicClient,
  fallback,
  getAddress,
  http,
  parseAbiItem,
  type AbiEvent,
  type Address,
  type PublicClient,
} from 'viem'
import { mainnet } from 'viem/chains'

import {
  DEFAULT_REPLAY_PARAMS,
  EPISODE_GAP_SECONDS,
  EPISODE_SPAN_SECONDS,
  HISTORY_SCHEMA_VERSION,
  clusterEpisodes,
  replayEpisode,
  totalHistory,
  type HistoricLiquidation,
  type HistoryEpisode,
  type HistoryEvent,
  type HistoryResponse,
  type NotScanned,
  type PriceRound,
} from './history'
import { PUBLIC_MAINNET_RPCS } from './rpc'

// ------------------------------------------------------------------ constants

/** Aave V3 mainnet Pool proxy — deployed at block 16291127 and never moved. Resolved
 *  through the addresses provider at run time; this is the fallback. */
export const AAVE_V3_POOL_FALLBACK = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fa4E2' as Address
export const AAVE_V3_ADDRESSES_PROVIDER = '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e' as Address
/** Aave V3 mainnet deploy block. Nothing before it can hold a LiquidationCall. */
export const AAVE_V3_START_BLOCK = 16_291_127n

/** Spark's PoolAddressesProvider — the same constant the live adapter uses
 *  (lib/position-sim/adapters/aaveV3.ts:150). Spark is a near-verbatim Aave V3 fork, so
 *  its Pool emits the identical LiquidationCall with the identical user topic and its
 *  data provider serves the identical reserve config; only the registry differs. */
const SPARK_ADDRESSES_PROVIDER = '0x02C3eA4e34C0cBd694D2adFa2c690EECbC1793eE' as Address
/** Spark went live on mainnet in May 2023. A conservative floor — starting early costs
 *  a request or two, starting late would silently hide events. */
export const SPARK_START_BLOCK = 17_000_000n

/** Morpho Blue — one singleton for every market (adapters/morphoBlue.ts:93), deployed
 *  2023-12-28. Every market's liquidation lands on this one address. */
const MORPHO_BLUE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as Address
export const MORPHO_BLUE_START_BLOCK = 18_883_124n

/** ~12 s blocks. The episode chain runs 72h past the last event (21,600 blocks); we
 *  take a little more so the span's last round is always inside it, and look back for
 *  the anchor round. */
const BLOCKS_SPAN = BigInt(Math.ceil(EPISODE_SPAN_SECONDS / 12) + 400)
const BLOCKS_BEFORE = 1_400n

/** Hard bound from the brief. A wallet with more history than this is truncated to the
 *  most recent 200 events and the response says so. */
export const MAX_EVENTS = 200

export const LIQUIDATION_CALL = parseAbiItem(
  'event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)',
)

const MORPHO_LIQUIDATE = parseAbiItem(
  'event Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)',
)

const ANSWER_UPDATED = parseAbiItem(
  'event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)',
)

export const providerAbi = [
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

export const dataProviderAbi = [
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

const morphoAbi = [
  {
    type: 'function',
    name: 'idToMarketParams',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'loanToken', type: 'address' },
      { name: 'collateralToken', type: 'address' },
      { name: 'oracle', type: 'address' },
      { name: 'irm', type: 'address' },
      { name: 'lltv', type: 'uint256' },
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
   *  the LTV walk (it is a constant over the window), so it only scales the USD figure. */
  | { kind: 'wsteth'; feed: Address }
  | { kind: 'stable' }

export interface TokenMeta {
  symbol: string
  decimals: number
  pricing: Pricing
}

/** Only what we can price honestly. Anything absent is reported 'unpriced' and counted
 *  in NEITHER direction — never approximated by a neighbouring asset. */
export const TOKENS: Record<string, TokenMeta> = {
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

/** The venues this scan does NOT cover, each with its reason. The UI prints these
 *  verbatim: a bare name reads as "we forgot", a reason reads as a boundary. */
const NOT_SCANNED: NotScanned[] = [
  {
    protocol: 'Compound V3',
    reason:
      'one Comet contract per base asset, each with its own AbsorbCollateral event and its own price feeds — a per-market scan, not this one shape.',
  },
  {
    protocol: 'Fluid',
    reason:
      'liquidations settle against vault ticks rather than named borrowers, so an address’s own liquidations are not readable from a borrower-filtered log.',
  },
]

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

/** Widest-first ladder for a full-history scan. */
const WIDE_SPANS = [2_000_000n, 400_000n, 80_000n, 16_000n, 2_000n]
/** Narrower ladder for one episode's oracle rounds — a 72h span is ~22k blocks, so
 *  starting at 2M only buys a guaranteed rejection on every capped endpoint. */
const ROUND_SPANS = [80_000n, 16_000n, 2_000n]

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
    event: AbiEvent
    eventArgs?: Record<string, unknown>
    fromBlock: bigint
    toBlock: bigint
    /** Override the span ladder. Defaults to WIDE_SPANS. */
    spans?: bigint[]
  },
  budget: { maxRequests: number; deadlineMs: number },
): Promise<ChunkedLogsResult<T>> {
  const spans = args.spans ?? WIDE_SPANS
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
          failure: `getLogs failed at the ${spans[spanIdx]}-block floor from block ${cursor}: ${lastFailure}`,
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
//
// EXPORTED ON PURPOSE (2026-09-22). The multi-year corpus scan
// (scripts/scan-aave-liquidations.mjs) imports `feedAggregators`, `feedRounds`,
// `priceAt`, `bonusToFee`, `stEthPerToken`, `TOKENS`, `dataProviderAbi` and the Aave
// constants from here rather than re-deriving them, so the corpus figure and the
// per-wallet figure cannot describe the same measurement two different ways. Do not
// narrow these back to module-private without moving that scan onto the replacement.

const aggregatorCache = new Map<string, Address[]>()

/** Every phase aggregator a feed proxy has ever pointed at. AnswerUpdated is emitted by
 *  the AGGREGATOR, not the proxy, and an old event sits on an old phase — reading only
 *  `aggregator()` would silently return zero rounds for anything before the last phase
 *  change. */
export async function feedAggregators(client: PublicClient, proxy: Address): Promise<Address[]> {
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

/** AnswerUpdated rounds for one feed over a block span, as {ts, price} in USD. The span
 *  is a whole episode (72h+), so it is chunked like any other wide getLogs. */
export async function feedRounds(
  client: PublicClient,
  proxy: Address,
  fromBlock: bigint,
  toBlock: bigint,
  deadlineMs: number,
): Promise<PriceRound[]> {
  const aggs = await feedAggregators(client, proxy)
  if (aggs.length === 0) return []
  const rounds: PriceRound[] = []
  for (const agg of aggs) {
    const got = await getLogsChunked<{ args: { current?: bigint; updatedAt?: bigint } }>(
      client,
      { address: agg, event: ANSWER_UPDATED, fromBlock, toBlock, spans: ROUND_SPANS },
      { maxRequests: 40, deadlineMs },
    )
    // One dead phase aggregator must not blank the window: getLogsChunked returns what
    // it got and reports the rest, and the other phases still contribute.
    for (const l of got.logs) {
      const a = l.args
      if (a.current === undefined || a.updatedAt === undefined) continue
      if (a.current <= 0n) continue
      rounds.push({ ts: Number(a.updatedAt), price: Number(a.current) / 1e8 })
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

interface AaveLog {
  args: {
    collateralAsset?: Address
    debtAsset?: Address
    user?: Address
    debtToCover?: bigint
    liquidatedCollateralAmount?: bigint
  }
  blockNumber: bigint
}

interface MorphoLog {
  args: {
    id?: `0x${string}`
    borrower?: Address
    repaidAssets?: bigint
    seizedAssets?: bigint
  }
  blockNumber: bigint
}

/** One decoded event, before it is priced. */
interface RawHit {
  protocol: string
  blockNumber: bigint
  ts: number
  collAddr: Address
  debtAddr: Address
  collRaw: bigint
  debtRaw: bigint
  /** Aave/Spark: the venue's data provider. Morpho: null — the market carries its own. */
  dataProvider: Address | null
  /** Morpho only. Its LLTV is exact, so no data-provider read is needed. */
  lltv?: number
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

  const base = {
    address: user,
    since: { firstEventTs: null as number | null },
    episodes: [] as HistoryEpisode[],
    events: [] as HistoryEvent[],
    totals: totalHistory([]),
    provenance: 'observed' as const,
    scannedAt: new Date().toISOString(),
    notScanned: NOT_SCANNED,
    version: HISTORY_SCHEMA_VERSION,
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

  // ---------------------------------------------------------- venue discovery
  interface Venue {
    label: string
    pool: Address
    dataProvider: Address | null
    startBlock: bigint
  }
  const venues: Venue[] = []
  for (const v of [
    { label: 'Aave V3', provider: AAVE_V3_ADDRESSES_PROVIDER, start: AAVE_V3_START_BLOCK },
    { label: 'Spark', provider: SPARK_ADDRESSES_PROVIDER, start: SPARK_START_BLOCK },
  ]) {
    let pool: Address | null = v.label === 'Aave V3' ? AAVE_V3_POOL_FALLBACK : null
    let dataProvider: Address | null = null
    try {
      pool = (await client.readContract({
        address: v.provider,
        abi: providerAbi,
        functionName: 'getPool',
      })) as Address
      dataProvider = (await client.readContract({
        address: v.provider,
        abi: providerAbi,
        functionName: 'getPoolDataProvider',
      })) as Address
    } catch {
      /* keep whatever we have; a missing data provider only costs us the line read */
    }
    if (pool) venues.push({ label: v.label, pool, dataProvider, startBlock: v.start })
  }

  // ------------------------------------------------------------- the log pulls
  const failures: string[] = []
  let anyIncomplete = false
  let firstFailedBlock: bigint | undefined
  const hits: RawHit[] = []
  const budget = { maxRequests: opts.maxRequests ?? 400, deadlineMs }

  for (const v of venues) {
    const scan = await getLogsChunked<AaveLog>(
      client,
      {
        address: v.pool,
        event: LIQUIDATION_CALL,
        eventArgs: { user },
        fromBlock: v.startBlock,
        toBlock: head,
      },
      budget,
    )
    if (!scan.complete) {
      anyIncomplete = true
      firstFailedBlock = firstFailedBlock ?? scan.failedAtBlock
      failures.push(`${v.label}: ${scan.failure ?? 'unknown'}`)
    }
    for (const log of scan.logs) {
      hits.push({
        protocol: v.label,
        blockNumber: log.blockNumber,
        ts: 0,
        collAddr: (log.args.collateralAsset ?? '0x') as Address,
        debtAddr: (log.args.debtAsset ?? '0x') as Address,
        collRaw: log.args.liquidatedCollateralAmount ?? 0n,
        debtRaw: log.args.debtToCover ?? 0n,
        dataProvider: v.dataProvider,
      })
    }
  }

  // Morpho Blue: one contract, borrower as topic3, market params resolved per id.
  {
    const scan = await getLogsChunked<MorphoLog>(
      client,
      {
        address: MORPHO_BLUE,
        event: MORPHO_LIQUIDATE,
        eventArgs: { borrower: user },
        fromBlock: MORPHO_BLUE_START_BLOCK,
        toBlock: head,
      },
      budget,
    )
    if (!scan.complete) {
      anyIncomplete = true
      firstFailedBlock = firstFailedBlock ?? scan.failedAtBlock
      failures.push(`Morpho Blue: ${scan.failure ?? 'unknown'}`)
    }
    const params = new Map<string, { loan: Address; coll: Address; lltv: number }>()
    for (const log of scan.logs) {
      const id = log.args.id
      if (!id) continue
      if (!params.has(id)) {
        try {
          const p = (await client.readContract({
            address: MORPHO_BLUE,
            abi: morphoAbi,
            functionName: 'idToMarketParams',
            args: [id],
          })) as readonly unknown[]
          params.set(id, {
            loan: p[0] as Address,
            coll: p[1] as Address,
            lltv: Number(p[4] as bigint) / 1e18,
          })
        } catch {
          continue
        }
      }
      const p = params.get(id)
      if (!p) continue
      hits.push({
        protocol: 'Morpho Blue',
        blockNumber: log.blockNumber,
        ts: 0,
        collAddr: p.coll,
        debtAddr: p.loan,
        collRaw: log.args.seizedAssets ?? 0n,
        debtRaw: log.args.repaidAssets ?? 0n,
        dataProvider: null,
        lltv: p.lltv,
      })
    }
  }

  if (hits.length === 0 && anyIncomplete) {
    return {
      ...base,
      method:
        'The liquidation log scan did not complete, so no history can be reported for this address.',
      error: `Liquidation scan failed — ${failures.join('; ')} (RPC ring: ${historyRpcUrls().length} endpoints).`,
    }
  }

  hits.sort((a, b) => Number(a.blockNumber - b.blockNumber))
  const truncated = hits.length > MAX_EVENTS
  const kept = truncated ? hits.slice(-MAX_EVENTS) : hits

  // ------------------------------------------------------------- block stamps
  const tsByBlock = new Map<string, number>()
  for (const h of kept) {
    const key = h.blockNumber.toString()
    if (tsByBlock.has(key)) continue
    if (Date.now() > deadlineMs) break
    try {
      const block = await client.getBlock({ blockNumber: h.blockNumber })
      tsByBlock.set(key, Number(block.timestamp))
    } catch {
      /* leave it unset — the event is reported unpriced below */
    }
  }
  for (const h of kept) h.ts = tsByBlock.get(h.blockNumber.toString()) ?? 0

  // ---------------------------------------------------------------- episodes
  // Cluster ACROSS protocols: Oct 10's WETH hit and USDT hit are one crash, one
  // position, one Membrane replay. Events whose timestamp we could not read cannot be
  // placed on the timeline at all, so each becomes its own 'unknown' episode.
  const timed = kept.filter((h) => h.ts > 0)
  const untimed = kept.filter((h) => h.ts <= 0)
  const clusters = clusterEpisodes(timed, EPISODE_GAP_SECONDS)

  let usedCurrentParams = false
  let anyArchive = false
  const roundsCache = new Map<string, PriceRound[]>()
  const lineCache = new Map<string, { line: number; fee: number } | null>()
  const episodes: HistoryEpisode[] = []
  const allEvents: HistoryEvent[] = []

  for (const [ci, cluster] of clusters.entries()) {
    if (Date.now() > deadlineMs) break
    const firstBlock = cluster[0].blockNumber
    const lastBlock = cluster[cluster.length - 1].blockNumber
    const from = firstBlock > BLOCKS_BEFORE ? firstBlock - BLOCKS_BEFORE : 0n
    const toRaw = lastBlock + BLOCKS_SPAN
    const to = toRaw > head ? head : toRaw
    // The chain walks up to 72h past the last event — but never INTO the next real
    // episode, or Membrane's side would be charged twice for the same days (owner
    // boundary ruling 2026-09-12). Cap the span at the next episode's first event.
    const nextStartTs = clusters[ci + 1]?.[0]?.ts
    const lastTs = cluster[cluster.length - 1].ts
    const spanSeconds =
      nextStartTs !== undefined
        ? Math.max(0, Math.min(EPISODE_SPAN_SECONDS, nextStartTs - lastTs))
        : EPISODE_SPAN_SECONDS
    const spanEndTs = lastTs + spanSeconds

    /** The collateral's rounds over the WHOLE episode span, fetched once per feed. */
    const roundsFor = async (meta: TokenMeta, ts: number): Promise<PriceRound[]> => {
      if (meta.pricing.kind === 'stable') {
        // A stable does not move: one flat round before the first event and one at the
        // span end. Honest, and it makes the verdict deterministic rather than absent.
        return [
          { ts: ts - 1, price: 1 },
          { ts: spanEndTs, price: 1 },
        ]
      }
      const key = `${meta.pricing.feed}:${from}:${to}`
      const hit = roundsCache.get(key)
      if (hit) return hit
      const got = await feedRounds(client, meta.pricing.feed, from, to, deadlineMs)
      roundsCache.set(key, got)
      return got
    }

    /** The market's liquidation line, and the venue's OWN bonus as Membrane's fee. */
    const lineFor = async (h: RawHit): Promise<{ line: number; fee: number } | null> => {
      if (h.lltv !== undefined) {
        // Morpho's Liquidation Incentive Factor: min(1.15, 1/(1 − 0.3·(1 − LLTV))).
        // Same shape as an Aave bonus, and it is the fee Membrane is charged here.
        if (!(h.lltv > 0)) return null
        return { line: h.lltv, fee: Math.min(1.15, 1 / (1 - 0.3 * (1 - h.lltv))) - 1 }
      }
      if (!h.dataProvider) return null
      const key = `${h.dataProvider}:${h.collAddr}:${h.blockNumber}`
      if (lineCache.has(key)) return lineCache.get(key) ?? null
      const read = async (blockNumber?: bigint) =>
        (await client.readContract({
          address: h.dataProvider as Address,
          abi: dataProviderAbi,
          functionName: 'getReserveConfigurationData',
          args: [h.collAddr],
          ...(blockNumber === undefined ? {} : { blockNumber }),
        })) as readonly bigint[]
      let out: { line: number; fee: number } | null = null
      try {
        const cfg = await read(h.blockNumber)
        anyArchive = true
        out = { line: Number(cfg[2]) / 10_000, fee: bonusToFee(cfg[3]) }
      } catch {
        try {
          const cfg = await read()
          usedCurrentParams = true
          out = { line: Number(cfg[2]) / 10_000, fee: bonusToFee(cfg[3]) }
        } catch {
          out = null
        }
      }
      if (out && !(out.line > 0)) out = null
      lineCache.set(key, out)
      return out
    }

    const events: HistoryEvent[] = []
    const priced: Array<{ hl: HistoricLiquidation; meta: TokenMeta; fee: number }> = []

    for (const h of cluster) {
      const coll = TOKENS[h.collAddr.toLowerCase()]
      const debt = TOKENS[h.debtAddr.toLowerCase()]
      const label = coll?.symbol ?? shortAddr(h.collAddr)
      if (!coll || !debt) {
        events.push({
          ts: h.ts,
          protocol: h.protocol,
          collateral: label,
          actualSeizedUsd: 0,
          unpriced: true,
          why: 'unpriced — no committed price source for this asset pair',
        })
        continue
      }

      const cfg = await lineFor(h)
      if (!cfg) {
        events.push({
          ts: h.ts,
          protocol: h.protocol,
          collateral: label,
          actualSeizedUsd: 0,
          unpriced: true,
          why: 'unpriced — the liquidation line for this market could not be read',
        })
        continue
      }

      const collRounds = await roundsFor(coll, h.ts)
      const collPrice = coll.pricing.kind === 'stable' ? 1 : priceAt(collRounds, h.ts)
      const debtPrice =
        debt.pricing.kind === 'stable' ? 1 : priceAt(await roundsFor(debt, h.ts), h.ts)
      if (collPrice === null || debtPrice === null) {
        events.push({
          ts: h.ts,
          protocol: h.protocol,
          collateral: label,
          actualSeizedUsd: 0,
          unpriced: true,
          why: 'unpriced — no oracle round covers this event',
        })
        continue
      }

      const collWrap =
        coll.pricing.kind === 'wsteth' ? await stEthPerToken(client, h.blockNumber) : 1
      const debtWrap =
        debt.pricing.kind === 'wsteth' ? await stEthPerToken(client, h.blockNumber) : 1
      const collateralSeizedUsd = (Number(h.collRaw) / 10 ** coll.decimals) * collPrice * collWrap
      const debtRepaidUsd = (Number(h.debtRaw) / 10 ** debt.decimals) * debtPrice * debtWrap

      events.push({
        ts: h.ts,
        protocol: h.protocol,
        collateral: label,
        actualSeizedUsd: collateralSeizedUsd,
        debtRepaidUsd,
      })
      priced.push({
        hl: {
          ts: h.ts,
          collateralSeizedUsd,
          debtRepaidUsd,
          ltvAtEvent: cfg.line,
          liqLine: cfg.line,
        },
        meta: coll,
        fee: cfg.fee,
      })
    }

    allEvents.push(...events)
    const startTs = cluster[0].ts
    const endTs = cluster[cluster.length - 1].ts
    const protocol = uniqueJoin(cluster.map((h) => h.protocol))
    const collateral = uniqueJoin(events.map((e) => e.collateral))
    // The ACTUAL side counts every event in the episode; an unpriced one contributes 0
    // rather than being dropped from the list.
    const actualSeizedUsd = events.reduce((a, e) => a + e.actualSeizedUsd, 0)

    if (priced.length === 0) {
      episodes.push({
        startTs,
        endTs,
        protocol,
        collateral,
        events,
        actualSeizedUsd,
        membraneSeizedUsd: 0,
        membraneLiquidations: 0,
        verdict: 'unknown',
        membraneShare: null,
        why: events[0]?.why ?? 'unpriced — nothing in this episode could be priced',
      })
      continue
    }

    // The ANCHOR is the first priced event: its collateral carries the price path, its
    // market carries the line and the fee. Every priced event's repaid debt is summed
    // into the slice by replayEpisode.
    const anchor = priced[0]
    const anchorRounds = await roundsFor(anchor.meta, anchor.hl.ts)
    const r = replayEpisode(
      priced.map((p) => p.hl),
      anchorRounds,
      { ...DEFAULT_REPLAY_PARAMS, liqFee: anchor.fee, spanSeconds },
    )

    episodes.push({
      startTs,
      endTs,
      protocol,
      collateral,
      events,
      actualSeizedUsd,
      membraneSeizedUsd: r.membraneSeizedUsd,
      membraneLiquidations: r.membraneLiquidations,
      verdict: r.verdict,
      membraneShare: actualSeizedUsd > 0 ? r.membraneSeizedUsd / actualSeizedUsd : null,
      recoveredAt: r.recoveredAt,
      brokeAt: r.brokeAt,
      wiped: r.wiped || undefined,
      why: r.why,
    })
  }

  for (const h of untimed) {
    const label = TOKENS[h.collAddr.toLowerCase()]?.symbol ?? shortAddr(h.collAddr)
    const why = 'unpriced — the block timestamp could not be read'
    const ev: HistoryEvent = {
      ts: 0,
      protocol: h.protocol,
      collateral: label,
      actualSeizedUsd: 0,
      unpriced: true,
      why,
    }
    allEvents.push(ev)
    episodes.push({
      startTs: 0,
      endTs: 0,
      protocol: h.protocol,
      collateral: label,
      events: [ev],
      actualSeizedUsd: 0,
      membraneSeizedUsd: 0,
      membraneLiquidations: 0,
      verdict: 'unknown',
      membraneShare: null,
      why,
    })
  }

  allEvents.sort((a, b) => a.ts - b.ts)
  episodes.sort((a, b) => a.startTs - b.startTs)
  const timedEvents = allEvents.filter((e) => e.ts > 0)
  const firstEventTs = timedEvents.length > 0 ? Math.min(...timedEvents.map((e) => e.ts)) : null

  return {
    ...base,
    since: { firstEventTs },
    episodes,
    events: allEvents,
    totals: totalHistory(episodes),
    scannedAt: new Date().toISOString(),
    scannedToBlock: head.toString(),
    method: buildMethod({
      truncated,
      incomplete: anyIncomplete,
      failedAtBlock: firstFailedBlock,
      usedCurrentParams,
      anyArchive,
      venues: [...venues.map((v) => v.label), 'Morpho Blue'],
    }),
    ...(anyIncomplete
      ? {
          error: `The liquidation log scan stopped early — ${failures.join('; ')}. Events before that block are missing.`,
        }
      : {}),
  }
}

/** Aave/Spark store the bonus as a 1e4-scaled multiplier: 10500 = a 5% bonus. That
 *  bonus IS Membrane's fee here, so Membrane never gets a cheaper liquidator than the
 *  one that actually took the collateral. */
export function bonusToFee(bonus: bigint | undefined): number {
  const b = Number(bonus ?? 0n) / 10_000
  if (!(b > 1)) return DEFAULT_REPLAY_PARAMS.liqFee ?? 0.05
  return b - 1
}

/** Last round at or before `target`, else the earliest round we have. */
export function priceAt(rounds: PriceRound[], target: number): number | null {
  const before = rounds.filter((r) => r.ts <= target)
  if (before.length > 0) return before[before.length - 1].price
  return rounds.length > 0 ? rounds[0].price : null
}

function uniqueJoin(xs: string[]): string {
  const out: string[] = []
  for (const x of xs) if (x && !out.includes(x)) out.push(x)
  return out.join(' + ')
}

export async function stEthPerToken(client: PublicClient, blockNumber: bigint): Promise<number> {
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

const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

/**
 * THE METHOD STRING. Rendered verbatim as one fine-print bullet, so it has to be one
 * readable paragraph and it has to name every approximation the scan actually made.
 */
function buildMethod(x: {
  truncated: boolean
  incomplete: boolean
  failedAtBlock?: bigint
  usedCurrentParams: boolean
  anyArchive: boolean
  venues: string[]
}): string {
  const parts: string[] = []
  parts.push(
    `Every liquidation with this address as the liquidated borrower on ${x.venues.join(', ')}, decoded from mainnet logs from each venue's deploy block to the current head (Aave V3 16,291,127; Spark 17,000,000; Morpho Blue 18,883,124).`,
  )
  parts.push(
    `Events within 24 hours of each other are ONE EPISODE — one crash, one position — and Membrane's side of an episode is a CHAIN, not a single sale: the position starts at its liquidation line carrying the debt the liquidators actually repaid, is repriced by the Chainlink rounds that really printed, and is walked for 72 hours past the episode's last event. Crossing the line arms an 8-hour timer; a climb past the 4% break band sells immediately; a return to the borrow line (liquidation line − 3pp) clears the timer with nothing sold; a window that expires still over the cap is a repay-to-cap. AFTER EVERY SALE THE POSITION CONTINUES — a repay-to-cap leaves it only 3pp under its line, so a still-falling price re-crosses it, arms a new timer and is liquidated again. Each episode reports how many Membrane liquidations that chain came to, and an episode whose chain cost MORE than the real liquidator did is reported as worse, not hidden.`,
  )
  parts.push(
    `On Aave V3 and Spark the account's liquidation line is approximated by the SEIZED RESERVE's own liquidation threshold${
      x.usedCurrentParams
        ? ' (read at the current block and stamped current params where the node refused archive state)'
        : x.anyArchive
          ? ' read at the event block'
          : ''
    }, and the LTV at the event is taken to equal that line — an account being liquidated was at or over it by definition. A multi-collateral account's true blended line is not cheaply readable at a historical block. A Morpho Blue market needs no such approximation: its LLTV is exact.`,
  )
  parts.push(
    `Membrane is charged the SOURCE venue's own liquidation bonus as its fee (Aave/Spark liquidationBonus − 1, Morpho's LIF), never a cheaper one. Position size is the liquidated slice itself: debt = the USD the liquidators repaid across the episode, collateral = that debt at the event LTV, so "Membrane would have sold $Y" is measured against the $X the liquidators actually closed, and "you keep" is the difference. Stablecoins are held at $1.00; wstETH is priced as stETH/USD × stEthPerToken. Assets with no committed price source are listed unpriced and counted in neither direction.`,
  )
  if (x.truncated) parts.push(`Only the most recent ${MAX_EVENTS} events were replayed.`)
  if (x.incomplete)
    parts.push(
      `The log scan stopped at block ${x.failedAtBlock ?? '?'} — earlier events are missing from this total.`,
    )
  parts.push(`Not scanned: ${NOT_SCANNED.map((n) => `${n.protocol} — ${n.reason}`).join(' ')}`)
  return parts.join(' ')
}
