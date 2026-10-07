/**
 * VENUE STRESS HISTORY — measured exit-capacity analogs for the stress engine.
 *
 * Owner 2026-10-06: "The venue-capacity assumptions should directly analogize existing
 * protocols (assuming typical Aave capacity during stress over the last 3 years)." The
 * stress engine's EXIT_CAPACITY_PRESETS were arbitrary (x1 / x0.5 / x0.1 / x0 of the deployed
 * amount); this script measures how much a depositor could ACTUALLY have withdrawn from real
 * venues during real stress, 2023-10-01 -> now. The presets are now those analogs
 * (lib/position-sim/venueStressAnalogs.ts -> exitCapacityAnalogs.ts).
 *
 * WHAT IT READS (archive eth_call, one Multicall3.aggregate3 per sample block)
 *   Aave v3 Ethereum Core   USDC, USDT, WETH
 *   SparkLend               DAI, USDC, USDS, USDT, WETH
 *     cash   = underlying.balanceOf(aToken)      (what a withdrawal can be paid from)
 *     supply = aToken.totalSupply()              (depositor claims, interest included)
 *     debt   = variableDebtToken.totalSupply()
 *     util   = 1 - cash/supply
 *     flags  = Pool.getReserveData(asset).configuration bits: active(56) frozen(57) paused(60);
 *              a PAUSED reserve blocks withdrawals, a FROZEN one does not.
 *   MetaMorpho Steakhouse USDC (0xBEEF01...64CB, on Morpho Blue)
 *     cash   = the vault's PRO-RATA share of its markets' idle cash: sum over the vault's
 *              withdrawQueue markets of vault assets x idle / market totalSupplyAssets,
 *              idle = totalSupplyAssets - totalBorrowAssets — the same race the Aave/Spark
 *              figure assumes (every supplier exits at once), one level down
 *              (lib/position-sim/venueStressRules.ts metaMorphoCash)
 *     liquid = sum of min(vault assets in the market, idle) — the vault FIRST in line in every
 *              market, the walk MetaMorpho's own maxWithdraw does (without accruing interest
 *              since the market's lastUpdate); published as the vault's `liquid` column.
 *              Until 2026-10-07 this was the vault's `cash`, which put Steakhouse's f on a
 *              first-in-line basis against Aave's and Spark's pro-rata one (review finding).
 *     supply = vault.totalAssets(); util = 1 - cash/totalAssets
 *   Every sample also reads Multicall3.getCurrentBlockTimestamp(), so each row carries the
 *   block's real timestamp at no extra cost.
 *
 * CADENCE. An HOURLY BASELINE over the whole range (every UTC hour; it was 6-hourly until
 * 2026-10-07, and a 6-hourly pass stepped over 2 h util spikes the review found between
 * samples: Aave USDC 2024-03-13 03-04, Aave USDT 2024-03-12 07-08 and 2026-01-20 14-15,
 * Spark DAI 2024-02-29 14-15). Stress windows (timeline `dense` = 1) come from three triggers:
 *   eth-drop   ETH/USD hourly low <= -10% vs the max close of the prior 24 h
 *              (public/data/price-history/eth-usd-1h.json, oracle-grade primary series);
 *              window = first trigger - 24 h .. last trigger + 72 h (episodes merge within 24 h)
 *   util       any sample at util >= the venue's stress level (95%; 99% for the two Spark
 *              reserves whose operating point is above 95%) on a venue of material size,
 *              except a TRANSIENT — one hourly reading that the next hourly reading clears
 *              (the Aave USDC 00:00 UTC drain: venueStressRules.ts header); readings <= 72 h
 *              apart form one episode; window = +-24 h
 *   named      the owner's event list (2024-08-05, 2024-12, 2025-04, 2025-10-10/11, Feb-2026,
 *              Apr-2026 Kelp rsETH, Aug-2026 PT-reUSD)
 * The baseline is hourly because it is what FINDS the util windows: any coarser pass can
 * step over a short spike entirely. The dense phase is kept for a coarser --base-step.
 *
 * FALSE-EMPTY SAFE. Three guards:
 *   1. a multicall whose result is "0x"/undecodable, or whose block timestamp is missing,
 *      is an endpoint error and goes to the next endpoint (never stored as zeros);
 *   2. a reserve that getReserveData says is LISTED but whose aToken/debt reads fail, or a
 *      vault whose totalAssets answers but whose queue reads fail, throws the same way;
 *   3. AUDIT: after each pass, any venue that is null or zero INSIDE its covered span is
 *      re-read at the same block from a DIFFERENT host; it stays null only if that host
 *      agrees (recorded as confirmed).
 *
 * REUSE (read-only, never re-read from chain): the Codex capacity lane already holds
 *   - Aave V3 USDe full 400d pinned cash grid (3 h, 2025-08-27 -> 2026-09-25) — carried
 *     into history.json `reused` and scored per stress episode;
 *   - Aave Core USDC/USDT pinned forward panel — used as an exact-raw CROSS-CHECK of this
 *     reader (--phase=crosscheck);
 *   - Aave V3 cross-reserve freeze/pause census — cross-checks the frozen/paused flags.
 *
 * RESUMABLE + PACED. Every sample is appended to data/venue-stress/cache/samples.jsonl as it
 * lands; a rerun loads public/data/venue-stress/history.json and the cache and reads only
 * the missing blocks. `--phase=build` writes the published files from what is loaded; the
 * raw cache is deleted after a successful full run (keep it with --keep-cache). Lanes run
 * in parallel (default 4), each paced; errors back off and rotate across the keyed hosts.
 *
 * KEYS NEVER PRINTED. RPC URLs come from .env.local RECORDER_RPC_URL (first entry = the
 * keyed archive endpoint); every log line and error goes through `redact`.
 *
 * USAGE
 *   npx tsx scripts/position-sim/build-venue-stress-history.mjs            # every phase
 *   ... --phase=resolve | baseline | vault | dense | audit | crosscheck | build   (comma-separated)
 *   --lanes=4  --end=<ISO hour>  --keep-cache  --max-dense-hours=12000  --base-step=<hours>
 *   `vault` re-reads, at its stored block, every sample whose vault row predates the pro-rata
 *   field (history.json without a `liquid` column) and checks that the first-in-line walk
 *   reproduces the stored figure.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, parseAbi } from 'viem'
import { mainnet } from 'viem/chains'

import { readEnv, ROOT } from '../lib/venue-reads.mjs'

const { primaryGrid } = await import('../../lib/position-sim/drawdowns.ts')
const { metaMorphoCash, utilClusters } = await import('../../lib/position-sim/venueStressRules.ts')

// ------------------------------------------------------------------ env + redaction

const { get } = readEnv()
const ENV_URLS = String(get('RECORDER_RPC_URL') ?? process.env.RECORDER_RPC_URL ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
if (ENV_URLS.length === 0) throw new Error('RECORDER_RPC_URL is not set in .env.local')
const ENV_HOSTS = [...new Set(ENV_URLS.map((u) => new URL(u).host))]
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function redact(x) {
  let s = String(x)
  for (const host of ENV_HOSTS) {
    s = s.replace(new RegExp(`https?://${escapeRe(host)}[^\\s"'\`,)]*`, 'g'), `env:${host}`)
  }
  return s
}
const log = (...a) => console.log(redact(a.join(' ')))
for (const ev of ['unhandledRejection', 'uncaughtException']) {
  process.on(ev, (e) => {
    console.error(redact(e?.stack ?? e))
    process.exit(1)
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------ args

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? true]
  }),
)
const PHASES = String(ARGS.phase ?? 'resolve,baseline,vault,dense,audit,crosscheck,build').split(
  ',',
)
const LANES = Math.max(1, Number(ARGS.lanes ?? 4))
const MAX_DENSE_HOURS = Number(ARGS['max-dense-hours'] ?? 16_000)

// ------------------------------------------------------------------ constants

const H = 3600
const DAY = 86_400
const START = Date.UTC(2023, 9, 1) / 1000 // 2023-10-01T00:00Z
const BASE_STEP = Number(ARGS['base-step'] ?? 1) * H
const OUT_DIR = join(ROOT, 'public', 'data', 'venue-stress')
const CACHE = join(ROOT, 'data', 'venue-stress', 'cache')
const SAMPLES_PATH = join(CACHE, 'samples.jsonl')
const RESOLVE_PATH = join(CACHE, 'resolve.json')
const HISTORY_PATH = join(OUT_DIR, 'history.json')
const SUMMARY_PATH = join(OUT_DIR, 'summary.json')
const PRICE_PATH = join(ROOT, 'public', 'data', 'price-history', 'eth-usd-1h.json')
const CODEX = '/Users/EBmic/membrane-app/data/research/venue-signals'
const CODEX_USDE_GRID = join(
  CODEX,
  '8489c2135c2d0a981d948876b16fd40e409e710e9f1d169ef3c23aa99c7b9681.json',
)
const CODEX_FREEZE_CENSUS = join(
  CODEX,
  'b9492de70a178957531a810917232e7e50a3c4fbe85fe3cf464c88d772df120f.json',
)
const CODEX_CORE_PANEL = join(CODEX, 'aave-core-forward-panel-v1.json')

const MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const MERGE = { block: 15_537_394, ts: 1_663_224_179 }
const SLOT_S = 12.1 // 12 s slots, ~0.8% missed
const FINALITY = 64
const ZERO = '0x0000000000000000000000000000000000000000'
const MAX_DT = 15 * 60 // a sample more than 15 min off its target hour is re-aimed

const T = {
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  USDS: '0xdC035D45d973E3EC169d2276DDab16f1e407384F',
}
const POOLS = {
  'aave-core': {
    address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    label: 'Aave v3 Ethereum Core',
  },
  spark: { address: '0xC13e21B648A5Ee794902342038FF3aDAB66BE987', label: 'SparkLend Ethereum' },
}
/** Lending reserves read live. `minSize` = supply (token units) below which a high-util
 *  reading is not a stress trigger (a near-empty reserve is "fully utilized" trivially).
 *  `stressUtil` = the util that counts as stress for the venue: 95% by default; 99% for the
 *  two Spark reserves whose MEASURED operating point sits above 95% (baseline 2023-10 ->
 *  2026-10: spark-dai >= 95% in 723 of 4,409 six-hourly samples, D3M-backed so cash is
 *  topped up by the Sky Direct Deposit Module; spark-usdt parked at 95.0-96.0% for 540 h
 *  straight in Sep-Oct 2026). A 95% trigger there would densify months of normal state. */
const LENDING = [
  {
    key: 'aave-core-usdc',
    pool: 'aave-core',
    symbol: 'USDC',
    asset: T.USDC,
    decimals: 6,
    minSize: 50e6,
  },
  {
    key: 'aave-core-usdt',
    pool: 'aave-core',
    symbol: 'USDT',
    asset: T.USDT,
    decimals: 6,
    minSize: 50e6,
  },
  {
    key: 'aave-core-weth',
    pool: 'aave-core',
    symbol: 'WETH',
    asset: T.WETH,
    decimals: 18,
    minSize: 20e3,
  },
  {
    key: 'spark-dai',
    pool: 'spark',
    symbol: 'DAI',
    asset: T.DAI,
    decimals: 18,
    minSize: 50e6,
    stressUtil: 0.99,
  },
  { key: 'spark-usdc', pool: 'spark', symbol: 'USDC', asset: T.USDC, decimals: 6, minSize: 50e6 },
  { key: 'spark-usds', pool: 'spark', symbol: 'USDS', asset: T.USDS, decimals: 18, minSize: 50e6 },
  {
    key: 'spark-usdt',
    pool: 'spark',
    symbol: 'USDT',
    asset: T.USDT,
    decimals: 6,
    minSize: 50e6,
    stressUtil: 0.99,
  },
  { key: 'spark-weth', pool: 'spark', symbol: 'WETH', asset: T.WETH, decimals: 18, minSize: 20e3 },
]
const VAULT = {
  key: 'morpho-steakhouse-usdc',
  label: 'MetaMorpho Steakhouse USDC (Morpho Blue)',
  address: '0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB',
  symbol: 'USDC',
  asset: T.USDC,
  decimals: 6,
  minSize: 50e6,
}
const VENUE_KEYS = [...LENDING.map((v) => v.key), VAULT.key]
const VENUE_BY_KEY = Object.fromEntries([...LENDING, VAULT].map((v) => [v.key, v]))

/** Owner-named events (2026-10-06 task). Dates are the event; the window pads around it. */
const NAMED_EVENTS = [
  {
    id: 'named-2024-08-05',
    label: '2024-08-05 yen-carry unwind',
    from: '2024-08-03T00:00Z',
    to: '2024-08-10T00:00Z',
  },
  {
    id: 'named-2024-12',
    label: 'Dec-2024 leverage peak / ETH drops',
    from: '2024-12-03T00:00Z',
    to: '2024-12-12T00:00Z',
  },
  {
    id: 'named-2025-04',
    label: 'Apr-2025 tariff crash',
    from: '2025-04-05T00:00Z',
    to: '2025-04-13T00:00Z',
  },
  {
    id: 'named-2025-10-10',
    label: '2025-10-10/11 liquidation cascade',
    from: '2025-10-09T12:00Z',
    to: '2025-10-16T00:00Z',
  },
  {
    id: 'named-2026-02',
    label: 'Feb-2026 ETH drawdown',
    from: '2026-01-30T00:00Z',
    to: '2026-02-10T00:00Z',
  },
  {
    id: 'named-2026-04-kelp',
    label: 'Apr-2026 Kelp rsETH / Aave cross-reserve freeze',
    from: '2026-04-16T00:00Z',
    to: '2026-04-30T00:00Z',
  },
  {
    id: 'named-2026-08-ptreusd',
    label: 'Aug-2026 PT-reUSD cascade (Morpho)',
    from: '2026-08-22T00:00Z',
    to: '2026-08-31T00:00Z',
  },
]

// ------------------------------------------------------------------ ABIs

const MC3_ABI = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
  'function getCurrentBlockTimestamp() view returns (uint256 timestamp)',
])
const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
])
const POOL_ABI = parseAbi([
  'function getReservesList() view returns (address[])',
  'function getReserveData(address) view returns ((uint256 configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt))',
])
const VAULT_ABI = parseAbi([
  'function totalAssets() view returns (uint256)',
  'function withdrawQueueLength() view returns (uint256)',
  'function withdrawQueue(uint256) view returns (bytes32)',
  'function asset() view returns (address)',
  'function name() view returns (string)',
  'function MORPHO() view returns (address)',
])
const MORPHO_ABI = parseAbi([
  'function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
  'function position(bytes32, address) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
])

// ------------------------------------------------------------------ io helpers

const iso = (sec) => new Date(sec * 1000).toISOString().replace(':00.000Z', 'Z')
const isoTs = (s) => Date.parse(s) / 1000
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}
function writeJson(path, obj) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(obj) + '\n')
  renameSync(tmp, path)
}
mkdirSync(CACHE, { recursive: true })
mkdirSync(OUT_DIR, { recursive: true })

// ------------------------------------------------------------------ RPC (keyed hosts only)

/** Archive eth_call goes to the keyed archive-capable hosts only: a protect/relay RPC
 *  (mevblocker, flashbots) is not an archive node and may answer at the head instead. */
const NON_ARCHIVE = /mevblocker|flashbots/i
const EPS = ENV_URLS.filter((url) => !NON_ARCHIVE.test(new URL(url).host)).map((url) => ({
  host: new URL(url).host,
  client: createPublicClient({
    chain: mainnet,
    transport: http(url, { timeout: 45_000, retryCount: 0 }),
  }),
  cold: 0,
  ok: 0,
  fail: 0,
  reasons: {},
}))

/** Run `fn(client)` on the primary keyed host first, then the others; back off between
 *  rounds. `avoid` = host to skip (the audit's second opinion must come from elsewhere). */
async function rpc(label, fn, { avoid = null } = {}) {
  let lastErr = null
  const order = EPS.filter((e) => e.host !== avoid)
  if (order.length === 0) throw new Error(`${label}: no host other than ${avoid}`)
  for (let round = 0; round < 4; round++) {
    for (const ep of order) {
      if (ep.cold > Date.now() && round < 3) continue
      try {
        const r = await fn(ep.client)
        ep.ok++
        return { r, host: ep.host }
      } catch (e) {
        ep.fail++
        lastErr = e
        const msg = String(e?.shortMessage ?? e?.message ?? e)
        const status = e?.status ?? e?.cause?.status
        const why = status
          ? `http-${status}`
          : /HTTP request failed/i.test(msg)
            ? 'http-error'
            : /429|too many|rate|limit|exceed|capacity/i.test(msg)
              ? 'rate-limit'
              : /timeout|timed out/i.test(msg)
                ? 'timeout'
                : /anchors predict/.test(msg)
                  ? 'wrong-block-state'
                  : /empty aggregate3|no block timestamp/.test(msg)
                    ? 'empty-result'
                    : /missing trie|header not found|archive|pruned|state/i.test(msg)
                      ? 'no-archive-state'
                      : 'other'
        ep.reasons[why] = (ep.reasons[why] ?? 0) + 1
        if (/429|rate|limit|exceed|capacity|timeout|timed out/i.test(msg))
          ep.cold = Date.now() + 5_000
      }
    }
    await sleep(500 * 2 ** round)
  }
  throw new Error(
    redact(
      `${label}: every host failed: ${String(lastErr?.shortMessage ?? lastErr).slice(0, 240)}`,
    ),
  )
}

let HEAD = null
async function head() {
  if (!HEAD || Date.now() - HEAD.seen > 60_000) {
    const { r } = await rpc('blockNumber', (c) => c.getBlockNumber())
    HEAD = { block: Number(r), seen: Date.now() }
  }
  return HEAD.block
}

/**
 * One Multicall3.aggregate3 at `block`. `calls` = [{ target, abi, functionName, args }].
 * Returns { ts, out: [decoded | null] , host }. A subcall is null when it reverted OR
 * returned no data (no code) — never zero. The whole call throws (-> next host) when the
 * aggregate itself returns nothing or the block timestamp subcall is missing: that is a
 * node that did not serve the archive state, not an empty venue.
 */
async function multicall(block, calls, opts = {}) {
  const all = [
    { target: MC3, abi: MC3_ABI, functionName: 'getCurrentBlockTimestamp', args: [] },
    ...calls,
  ]
  const data = encodeFunctionData({
    abi: MC3_ABI,
    functionName: 'aggregate3',
    args: [
      all.map((c) => ({
        target: c.target,
        allowFailure: true,
        callData: encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args }),
      })),
    ],
  })
  const { r, host } = await rpc(
    `aggregate3@${block}`,
    async (client) => {
      const res = await client.call({ to: MC3, data, blockNumber: BigInt(block) })
      if (!res?.data || res.data === '0x') throw new Error('empty aggregate3 result')
      const decoded = decodeFunctionResult({
        abi: MC3_ABI,
        functionName: 'aggregate3',
        data: res.data,
      })
      if (decoded.length !== all.length) throw new Error('aggregate3 length mismatch')
      const tsRes = decoded[0]
      if (!tsRes.success || tsRes.returnData === '0x') throw new Error('no block timestamp')
      // A node that ignored the block tag answers with head state: its timestamp will not
      // sit where the observed (block, ts) anchors put this block.
      const want = predictTs(block)
      if (want != null) {
        const got = Number(
          decodeFunctionResult({
            abi: MC3_ABI,
            functionName: 'getCurrentBlockTimestamp',
            data: tsRes.returnData,
          }),
        )
        if (Math.abs(got - want) > 2 * H)
          throw new Error(`block ${block} answered with timestamp ${got}, anchors predict ${want}`)
      }
      return decoded
    },
    opts,
  )
  const out = r.map((res, i) => {
    if (!res.success || !res.returnData || res.returnData === '0x') return null
    try {
      return decodeFunctionResult({
        abi: all[i].abi,
        functionName: all[i].functionName,
        data: res.returnData,
      })
    } catch {
      return null
    }
  })
  return { ts: Number(out[0]), out: out.slice(1), host }
}

// ------------------------------------------------------------------ block <-> time

const anchors = [] // sorted [block, ts]
function addAnchor(block, ts) {
  let lo = 0
  let hi = anchors.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (anchors[m][0] < block) lo = m + 1
    else hi = m
  }
  if (anchors[lo]?.[0] === block) return
  anchors.splice(lo, 0, [block, ts])
}
/** Timestamp of `block` predicted from the nearest anchor within ~1 day; null if none. */
function predictTs(block) {
  let lo = 0
  let hi = anchors.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (anchors[m][0] < block) lo = m + 1
    else hi = m
  }
  const cands = [anchors[lo - 1], anchors[lo]].filter(Boolean)
  if (!cands.length) return null
  const a = cands.reduce((x, y) => (Math.abs(y[0] - block) < Math.abs(x[0] - block) ? y : x))
  if (Math.abs(a[0] - block) > 7200) return null
  return a[1] + Math.round((block - a[0]) * 12.05)
}
function estimateBlock(ts) {
  // last anchor with ts <= target, first with ts > target (anchors are monotone in both)
  let lo = 0
  let hi = anchors.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (anchors[m][1] <= ts) lo = m + 1
    else hi = m
  }
  const a = anchors[lo - 1]
  const b = anchors[lo]
  if (a && b && b[1] - a[1] <= 2 * DAY) {
    return { block: a[0] + Math.round(((ts - a[1]) * (b[0] - a[0])) / (b[1] - a[1])), good: true }
  }
  const near = !a ? b : !b ? a : ts - a[1] <= b[1] - ts ? a : b
  if (near && Math.abs(ts - near[1]) <= DAY) {
    return { block: near[0] + Math.round((ts - near[1]) / SLOT_S), good: true }
  }
  if (near) return { block: near[0] + Math.round((ts - near[1]) / SLOT_S), good: false }
  return { block: MERGE.block + Math.round((ts - MERGE.ts) / SLOT_S), good: false }
}
async function blockFor(ts) {
  const top = (await head()) - FINALITY
  let { block, good } = estimateBlock(ts)
  block = Math.min(block, top)
  if (good) return block
  for (let i = 0; i < 8; i++) {
    const { r } = await rpc(`getBlock ${block}`, (c) => c.getBlock({ blockNumber: BigInt(block) }))
    const bts = Number(r.timestamp)
    addAnchor(block, bts)
    const d = ts - bts
    if (Math.abs(d) <= 120) break
    block = Math.min(block + Math.round(d / 12), top)
  }
  return block
}

// ------------------------------------------------------------------ resolve (addresses)

async function phaseResolve() {
  const prev = readJson(RESOLVE_PATH)
  if (prev?.venues && !ARGS.force) {
    log(`resolve: cached (${Object.keys(prev.venues).length} venues)`)
    return prev
  }
  const top = (await head()) - FINALITY
  const calls = []
  for (const v of LENDING) {
    calls.push({
      target: POOLS[v.pool].address,
      abi: POOL_ABI,
      functionName: 'getReserveData',
      args: [v.asset],
    })
    calls.push({ target: v.asset, abi: ERC20_ABI, functionName: 'symbol', args: [] })
    calls.push({ target: v.asset, abi: ERC20_ABI, functionName: 'decimals', args: [] })
  }
  for (const fn of ['name', 'asset', 'MORPHO'])
    calls.push({ target: VAULT.address, abi: VAULT_ABI, functionName: fn, args: [] })
  const { out, ts } = await multicall(top, calls)
  const venues = {}
  LENDING.forEach((v, i) => {
    const rd = out[3 * i]
    const sym = out[3 * i + 1]
    const dec = out[3 * i + 2]
    if (!rd || rd.aTokenAddress === ZERO) throw new Error(`resolve: ${v.key} not listed at head`)
    if (sym !== v.symbol || Number(dec) !== v.decimals)
      throw new Error(`resolve: ${v.key} identity ${sym}/${dec} != ${v.symbol}/${v.decimals}`)
    venues[v.key] = {
      pool: POOLS[v.pool].address,
      asset: v.asset,
      aToken: rd.aTokenAddress,
      variableDebtToken: rd.variableDebtTokenAddress,
    }
  })
  const [name, asset, morpho] = out.slice(3 * LENDING.length)
  if (asset?.toLowerCase() !== VAULT.asset.toLowerCase())
    throw new Error(`resolve: vault asset ${asset}`)
  venues[VAULT.key] = { vault: VAULT.address, name, asset, morpho }
  const res = { resolvedAtBlock: top, resolvedAt: iso(ts), venues }
  writeFileSync(RESOLVE_PATH, JSON.stringify(res, null, 2) + '\n')
  for (const [k, v] of Object.entries(venues)) log(`resolve ${k}: ${JSON.stringify(v)}`)
  return res
}

// ------------------------------------------------------------------ one sample

const pctRay = (x) => Math.round((Number(x) / 1e27) * 10_000) / 100 // ray APR -> % (2 dp)

/** The vault's first-round calls (appended to a sample's multicall, or alone). */
function vaultCalls(R, queueHint) {
  const morpho = R.venues[VAULT.key].morpho
  const guess = Math.min(64, Math.max(6, queueHint.length + 3))
  const calls = [
    { target: VAULT.address, abi: VAULT_ABI, functionName: 'totalAssets', args: [] },
    { target: VAULT.address, abi: VAULT_ABI, functionName: 'withdrawQueueLength', args: [] },
  ]
  for (let i = 0; i < guess; i++)
    calls.push({
      target: VAULT.address,
      abi: VAULT_ABI,
      functionName: 'withdrawQueue',
      args: [BigInt(i)],
    })
  for (const id of queueHint) {
    calls.push({ target: morpho, abi: MORPHO_ABI, functionName: 'market', args: [id] })
    calls.push({
      target: morpho,
      abi: MORPHO_ABI,
      functionName: 'position',
      args: [id, VAULT.address],
    })
  }
  return { calls, guess }
}

/**
 * Finish the vault from the results `o` of `vaultCalls` (same order): walk the withdraw queue
 * (up to 3 more rounds at the same block) and price every market two ways
 * (venueStressRules.metaMorphoCash). Row: [proRata, totalAssets, totalAssets - proRata, 0,
 * marketsInQueue, liquid]; null when the vault is not deployed at `block`.
 */
async function finishVault(block, R, o, guess, queueHint, avoid) {
  const morpho = R.venues[VAULT.key].morpho
  const MB = 2 + guess
  const totalAssets = o[0]
  if (totalAssets == null) return { row: null, queue: [] } // not deployed yet
  const len = o[1]
  if (len == null)
    throw new Error(`${VAULT.key}@${block}: totalAssets answered but queue length failed`)
  const n = Number(len)
  const ids = new Array(n).fill(null)
  for (let i = 0; i < Math.min(n, guess); i++) ids[i] = o[2 + i]
  const mk = new Map()
  queueHint.forEach((id, j) => {
    const m = o[MB + 2 * j]
    const p = o[MB + 2 * j + 1]
    if (m && p) mk.set(id, { m, p })
  })
  for (let round = 0; round < 3; round++) {
    const missingIdx = ids.map((x, i) => (x == null ? i : -1)).filter((i) => i >= 0)
    const needMk = ids.filter((id) => id != null && !mk.has(id))
    if (missingIdx.length === 0 && needMk.length === 0) break
    const c3 = []
    for (const i of missingIdx)
      c3.push({
        target: VAULT.address,
        abi: VAULT_ABI,
        functionName: 'withdrawQueue',
        args: [BigInt(i)],
      })
    for (const id of needMk) {
      c3.push({ target: morpho, abi: MORPHO_ABI, functionName: 'market', args: [id] })
      c3.push({
        target: morpho,
        abi: MORPHO_ABI,
        functionName: 'position',
        args: [id, VAULT.address],
      })
    }
    const { out: o3 } = await multicall(block, c3, { avoid })
    missingIdx.forEach((i, j) => {
      if (o3[j] == null) throw new Error(`${VAULT.key}@${block}: withdrawQueue(${i}) failed`)
      ids[i] = o3[j]
    })
    needMk.forEach((id, j) => {
      const m = o3[missingIdx.length + 2 * j]
      const p = o3[missingIdx.length + 2 * j + 1]
      if (!m || !p) throw new Error(`${VAULT.key}@${block}: market/position read failed`)
      mk.set(id, { m, p })
    })
  }
  const markets = ids.map((id) => {
    const got = mk.get(id)
    if (!got) throw new Error(`${VAULT.key}@${block}: market ${id} unread after 3 rounds`)
    const [tsa, tss, tba] = got.m
    const shares = got.p[0]
    return {
      owned: (shares * (tsa + 1n)) / (tss + 1_000_000n), // SharesMathLib.toAssetsDown
      totalSupplyAssets: tsa,
      totalBorrowAssets: tba,
    }
  })
  const { liquid, proRata } = metaMorphoCash(markets)
  const scale = 10 ** VAULT.decimals
  const ta = Number(totalAssets) / scale
  const pr = Number(proRata) / scale
  return {
    row: [pr, ta, Math.max(0, ta - pr), 0, ids.length, Number(liquid) / scale],
    queue: ids,
  }
}

/** The vault alone at `block` (the `vault` phase re-reads legacy rows with it). */
async function readVaultOnly(block, R, { queueHint = [], avoid = null } = {}) {
  const { calls, guess } = vaultCalls(R, queueHint)
  const { out, ts, host } = await multicall(block, calls, { avoid })
  const { row, queue } = await finishVault(block, R, out, guess, queueHint, avoid)
  return { ts, host, row, queue }
}

/**
 * Read every venue at `block`. Returns { ts, host, v: { key: [cash, supply, debt, flags, apr|n] | null }, queue }.
 *   flags: 1 active, 2 frozen, 4 paused, 8 aToken differs from head (re-read with the historical one)
 *   vault row: [proRata, totalAssets, totalAssets - proRata, 0, marketsInQueue, liquid]
 */
async function readSample(block, R, { queueHint = [], avoid = null } = {}) {
  const calls = []
  for (const v of LENDING) {
    const r = R.venues[v.key]
    calls.push({ target: v.asset, abi: ERC20_ABI, functionName: 'balanceOf', args: [r.aToken] })
    calls.push({ target: r.aToken, abi: ERC20_ABI, functionName: 'totalSupply', args: [] })
    calls.push({
      target: r.variableDebtToken,
      abi: ERC20_ABI,
      functionName: 'totalSupply',
      args: [],
    })
    calls.push({ target: r.pool, abi: POOL_ABI, functionName: 'getReserveData', args: [v.asset] })
  }
  const VB = calls.length
  const vc = vaultCalls(R, queueHint)
  calls.push(...vc.calls)
  const first = await multicall(block, calls, { avoid })
  const { out, ts } = first
  const host = first.host
  const v = {}
  const redo = []
  LENDING.forEach((ven, i) => {
    const [cash, supply, debt, rd] = out.slice(4 * i, 4 * i + 4)
    if (!rd) throw new Error(`${ven.key}@${block}: getReserveData failed on a live pool`)
    if (rd.aTokenAddress === ZERO) {
      v[ven.key] = null // not listed yet
      return
    }
    const cfg = rd.configuration
    let flags =
      Number((cfg >> 56n) & 1n) |
      (Number((cfg >> 57n) & 1n) << 1) |
      (Number((cfg >> 60n) & 1n) << 2)
    const scale = 10 ** ven.decimals
    if (rd.aTokenAddress.toLowerCase() !== R.venues[ven.key].aToken.toLowerCase()) {
      redo.push({ ven, rd, flags: flags | 8 })
      return
    }
    if (cash == null || supply == null || debt == null)
      throw new Error(`${ven.key}@${block}: listed but token reads failed`)
    v[ven.key] = [
      Number(cash) / scale,
      Number(supply) / scale,
      Number(debt) / scale,
      flags,
      pctRay(rd.currentVariableBorrowRate),
    ]
  })
  if (redo.length) {
    const c2 = []
    for (const { ven, rd } of redo) {
      c2.push({
        target: ven.asset,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [rd.aTokenAddress],
      })
      c2.push({ target: rd.aTokenAddress, abi: ERC20_ABI, functionName: 'totalSupply', args: [] })
      c2.push({
        target: rd.variableDebtTokenAddress,
        abi: ERC20_ABI,
        functionName: 'totalSupply',
        args: [],
      })
    }
    const { out: o2 } = await multicall(block, c2, { avoid })
    redo.forEach(({ ven, rd, flags }, j) => {
      const [cash, supply, debt] = o2.slice(3 * j, 3 * j + 3)
      if (cash == null || supply == null || debt == null)
        throw new Error(`${ven.key}@${block}: historical aToken reads failed`)
      const scale = 10 ** ven.decimals
      v[ven.key] = [
        Number(cash) / scale,
        Number(supply) / scale,
        Number(debt) / scale,
        flags,
        pctRay(rd.currentVariableBorrowRate),
      ]
    })
  }

  // ---- MetaMorpho: walk the withdraw queue (up to 3 rounds at the same block)
  const vault = await finishVault(block, R, out.slice(VB), vc.guess, queueHint, avoid)
  v[VAULT.key] = vault.row
  const queue = vault.queue
  return { ts, host, v, queue }
}

// ------------------------------------------------------------------ sample store

/** t (target hour) -> { t, b, dt, src, v } */
const SAMPLES = new Map()
/** Every row is held at PUBLICATION precision (stables 1 unit, WETH 0.001), so a build from
 *  the raw cache and a build resumed from history.json give the identical summary. */
function roundSample(s) {
  const v = {}
  for (const k of VENUE_KEYS) {
    const r = s.v[k]
    const dp = k === VAULT.key || VENUE_BY_KEY[k].symbol !== 'WETH' ? 0 : 3
    const f = 10 ** dp
    v[k] =
      r == null
        ? null
        : [
            Math.round(r[0] * f) / f,
            Math.round(r[1] * f) / f,
            Math.round(r[2] * f) / f,
            r[3],
            r[4],
            // the vault's first-in-line `liquid` (absent on a legacy row: `vault` phase)
            ...(r.length > 5 ? [Math.round(r[5] * f) / f] : []),
          ]
  }
  return { ...s, v }
}
/** A vault row read before the pro-rata field (cash was the first-in-line walk). */
const legacyVault = (r) => r != null && r.length < 6
function loadSamples() {
  const hist = readJson(HISTORY_PATH)
  if (hist?.timeline) {
    const tl = hist.timeline
    // history.json without a vault `liquid` column predates the pro-rata field: its vault
    // cash is the first-in-line walk, loaded as a 5-field legacy row for the `vault` phase
    const liquid = hist.venues[VAULT.key]?.liquid
    for (let i = 0; i < tl.t.length; i++) {
      const v = {}
      for (const k of VENUE_KEYS) {
        const c = hist.venues[k]
        v[k] = c.cash[i] == null ? null : [c.cash[i], c.supply[i], c.debt[i], c.flags[i], c.apr[i]]
        if (k === VAULT.key && v[k] && liquid?.[i] != null) v[k].push(liquid[i])
      }
      SAMPLES.set(tl.t[i], {
        t: tl.t[i],
        b: tl.b[i],
        dt: tl.dt[i],
        src: hist.hosts[tl.src[i]] ?? null,
        v,
      })
    }
  }
  if (existsSync(SAMPLES_PATH)) {
    for (const line of readFileSync(SAMPLES_PATH, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const s = roundSample(JSON.parse(line))
        SAMPLES.set(s.t, s)
      } catch {
        /* torn last line from a killed run */
      }
    }
  }
  for (const s of SAMPLES.values()) addAnchor(s.b, s.t + s.dt)
  log(`loaded ${SAMPLES.size} samples`)
}
function putSample(s) {
  SAMPLES.set(s.t, roundSample(s))
  appendFileSync(SAMPLES_PATH, JSON.stringify(s) + '\n')
}

/** Read one target hour (re-aim the block when the landed block is > 15 min off). */
async function sampleAt(t, R, lane) {
  let block = await blockFor(t)
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await readSample(block, R, { queueHint: lane.queue })
    addAnchor(block, r.ts)
    const dt = r.ts - t
    if (Math.abs(dt) > MAX_DT && attempt < 2) {
      block = Math.min(block - Math.round(dt / 12), (await head()) - FINALITY)
      continue
    }
    lane.queue = r.queue
    putSample({ t, b: block, dt, src: r.host, v: r.v })
    return
  }
}

async function runTargets(label, targets, R) {
  const todo = targets.filter((t) => !SAMPLES.has(t)).sort((a, b) => a - b)
  if (todo.length === 0) {
    log(`${label}: nothing to read`)
    return
  }
  await runLanes(label, todo, (t, lane) => sampleAt(t, R, lane))
}

/** `work(t, lane)` over sorted `todo` in LANES parallel lanes, each paced. */
async function runLanes(label, todo, work) {
  log(`${label}: ${todo.length} blocks to read across ${LANES} lanes`)
  // Contiguous chronological chunks per lane keep block estimates anchored and the
  // MetaMorpho queue hint warm.
  const per = Math.ceil(todo.length / LANES)
  const chunks = Array.from({ length: LANES }, (_, i) => todo.slice(i * per, (i + 1) * per)).filter(
    (c) => c.length,
  )
  let done = 0
  const t0 = Date.now()
  await Promise.all(
    chunks.map(async (chunk) => {
      const lane = { queue: [] }
      for (const t of chunk) {
        await work(t, lane)
        done++
        if (done % 200 === 0) {
          const rate = done / ((Date.now() - t0) / 1000)
          log(
            `${label}: ${done}/${todo.length} (${rate.toFixed(1)}/s, eta ${Math.round((todo.length - done) / rate / 60)} min)`,
          )
        }
        await sleep(40)
      }
    }),
  )
  log(`${label}: done ${todo.length} in ${Math.round((Date.now() - t0) / 1000)} s`)
}

// ------------------------------------------------------------------ grid end

function gridEnd() {
  if (ARGS.end) return Math.floor(isoTs(String(ARGS.end)) / H) * H
  return Math.floor((Date.now() / 1000 - 30 * 60) / H) * H // last complete hour, finality slack
}

// ------------------------------------------------------------------ stress windows

function ethDropEpisodes(end) {
  const file = JSON.parse(readFileSync(PRICE_PATH, 'utf8'))
  const g = primaryGrid(file)
  const i0 = Math.max(24, Math.round((START - g.startTs) / H))
  const i1 = Math.min(g.close.length - 1, Math.round((end - g.startTs) / H))
  const eps = []
  for (let i = i0; i <= i1; i++) {
    let mx = -Infinity
    for (let k = i - 24; k < i; k++) if (g.close[k] != null) mx = Math.max(mx, g.close[k])
    const lo = g.low?.[i] ?? g.close[i]
    if (lo == null || !Number.isFinite(mx)) continue
    const d = lo / mx - 1
    if (d > -0.1) continue
    const t = g.startTs + i * H
    const last = eps[eps.length - 1]
    if (last && t - last.lastTrigger <= DAY) {
      last.lastTrigger = t
      if (d < last.worstDrop) {
        last.worstDrop = d
        last.worstAt = t
      }
      last.triggerHours++
    } else eps.push({ firstTrigger: t, lastTrigger: t, worstDrop: d, worstAt: t, triggerHours: 1 })
  }
  return eps.map((e) => ({
    id: `eth-drop-${iso(e.firstTrigger).slice(0, 10)}`,
    trigger: 'eth-drop',
    label: `ETH ${(e.worstDrop * 100).toFixed(1)}% vs prior-24h max close (worst ${iso(e.worstAt)}, ${e.triggerHours} trigger hours)`,
    from: e.firstTrigger - DAY,
    to: Math.min(end, e.lastTrigger + 3 * DAY),
    detail: {
      worstDropPct: Math.round(e.worstDrop * 1000) / 10,
      worstAt: iso(e.worstAt),
      firstTrigger: iso(e.firstTrigger),
      lastTrigger: iso(e.lastTrigger),
      triggerHours: e.triggerHours,
    },
  }))
}

/** One venue on the sample timeline `ts`, as venueStressRules reads it. */
function venueSeries(k, ts) {
  const col = (j) => ts.map((t) => SAMPLES.get(t).v[k]?.[j] ?? null)
  return { t: ts, cash: col(0), supply: col(1), flags: col(3), minSize: VENUE_BY_KEY[k].minSize }
}

/** High-util EPISODES per venue, from every sample loaded — venueStressRules.utilClusters, the
 *  code venueStressAnalogs.utilWindowsFromSeries runs: readings at util >= the venue's
 *  stressUtil (95% unless set) on a venue of material size, TRANSIENTS dropped (one hourly
 *  reading the next one clears: the Aave USDC 00:00 UTC drain), clustered while consecutive
 *  stress readings are <= UTIL_EPISODE_GAP_H (72 h) apart; window = +-24 h. */
function utilEpisodes(end) {
  const ts = [...SAMPLES.keys()].sort((a, b) => a - b)
  const out = []
  for (const k of VENUE_KEYS) {
    const thr = VENUE_BY_KEY[k].stressUtil ?? 0.95
    for (const c of utilClusters(venueSeries(k, ts), thr).clusters) {
      out.push({
        id: `util-${k}-${iso(c.first).slice(0, 13)}`,
        trigger: `util>=${Math.round(thr * 100)}`,
        venue: k,
        label: `${k} utilization >= ${Math.round(thr * 100)}% (${c.n} readings, peak ${(c.peak * 100).toFixed(2)}% at ${iso(c.peakAt)})`,
        from: c.first - DAY,
        to: Math.min(end, c.last + DAY),
        detail: {
          firstAt: iso(c.first),
          lastAt: iso(c.last),
          readings: c.n,
          peakUtilPct: Math.round(c.peak * 10_000) / 100,
          peakAt: iso(c.peakAt),
        },
      })
    }
  }
  return out
}

/** The stressed readings each venue's util rule dropped as transients (venueStressRules.ts). */
function transientStats(ts) {
  const out = {}
  for (const k of VENUE_KEYS) {
    const { transients } = utilClusters(venueSeries(k, ts), VENUE_BY_KEY[k].stressUtil ?? 0.95)
    if (!transients.length) continue
    const byUtcHour = {}
    for (const t of transients) {
      const hr = new Date(t * 1000).getUTCHours()
      byUtcHour[hr] = (byUtcHour[hr] ?? 0) + 1
    }
    out[k] = {
      count: transients.length,
      byUtcHour,
      first: iso(transients[0]),
      last: iso(transients[transients.length - 1]),
    }
  }
  return out
}

function namedEpisodes(end) {
  return NAMED_EVENTS.map((e) => ({
    id: e.id,
    trigger: 'named',
    label: e.label,
    from: isoTs(e.from),
    to: Math.min(end, isoTs(e.to)),
    detail: {},
  })).filter((e) => e.from < end)
}

function allEpisodes(end) {
  return [...namedEpisodes(end), ...ethDropEpisodes(end), ...utilEpisodes(end)].sort(
    (a, b) => a.from - b.from,
  )
}

/** Merge episodes into dense hourly intervals. */
function denseIntervals(eps) {
  const iv = eps
    .map((e) => [Math.floor(e.from / H) * H, Math.ceil(e.to / H) * H])
    .sort((a, b) => a[0] - b[0])
  const out = []
  for (const [a, b] of iv) {
    const last = out[out.length - 1]
    if (last && a <= last[1] + H) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

// ------------------------------------------------------------------ phases

async function phaseBaseline(R, end) {
  const targets = []
  for (let t = START; t <= end; t += BASE_STEP) targets.push(t)
  await runTargets('baseline', targets, R)
}

function phaseWindows(end) {
  const eps = allEpisodes(end)
  const iv = denseIntervals(eps)
  let hours = 0
  for (const [a, b] of iv) hours += Math.round((Math.min(b, end) - a) / H) + 1
  for (const e of eps)
    log(`episode ${e.trigger.padEnd(8)} ${iso(e.from)} -> ${iso(e.to)}  ${e.label}`)
  log(`windows: ${eps.length} episodes -> ${iv.length} dense intervals, ${hours} hours`)
}

async function phaseDense(R, end) {
  for (let iter = 0; iter < 6; iter++) {
    const iv = denseIntervals(allEpisodes(end))
    const targets = []
    for (const [a, b] of iv) for (let t = a; t <= Math.min(b, end); t += H) targets.push(t)
    const hours = targets.length
    if (hours > MAX_DENSE_HOURS)
      throw new Error(
        `dense: ${hours} hours > --max-dense-hours=${MAX_DENSE_HOURS}; inspect the util windows before widening`,
      )
    const todo = targets.filter((t) => !SAMPLES.has(t))
    log(`dense iter ${iter}: ${iv.length} intervals, ${hours} hours, ${todo.length} missing`)
    if (todo.length === 0) return
    await runTargets(`dense#${iter}`, targets, R)
  }
}

/**
 * VAULT PRO-RATA (review 2026-10-07): every sample whose vault row predates the pro-rata field
 * is re-read — the vault alone, at the SAME block — for its pro-rata cash and first-in-line
 * `liquid`. The walk must reproduce the stored first-in-line cash and totalAssets (published
 * precision, 1 unit); a sample that does not is reported, and the build refuses until every
 * row carries the field.
 */
async function phaseVault(R) {
  const todo = [...SAMPLES.values()]
    .filter((s) => legacyVault(s.v[VAULT.key]))
    .map((s) => s.t)
    .sort((a, b) => a - b)
  if (todo.length === 0) {
    log('vault: every vault row carries the pro-rata field')
    return { reread: 0, mismatches: [] }
  }
  const mismatches = []
  const hostsUsed = {}
  await runLanes('vault', todo, async (t, lane) => {
    const s = SAMPLES.get(t)
    const old = s.v[VAULT.key]
    const r = await readVaultOnly(s.b, R, { queueHint: lane.queue })
    if (r.ts !== s.t + s.dt)
      throw new Error(`vault: block ${s.b} answered at ${r.ts}, stored ${s.t + s.dt}`)
    if (r.row == null) throw new Error(`vault: block ${s.b} has no vault, stored row has one`)
    lane.queue = r.queue
    hostsUsed[r.host] = (hostsUsed[r.host] ?? 0) + 1
    const liq = Math.round(r.row[5])
    const ta = Math.round(r.row[1])
    if (Math.abs(liq - old[0]) > 1 || Math.abs(ta - old[1]) > 1 || r.row[4] !== old[4])
      mismatches.push({
        at: iso(t),
        block: s.b,
        stored: old,
        reread: [liq, ta, r.row[4]],
        hosts: [s.src, r.host],
      })
    putSample({ ...s, v: { ...s.v, [VAULT.key]: r.row } })
  })
  log(`vault: ${todo.length} rows re-read, ${mismatches.length} first-in-line mismatches`)
  if (mismatches.length) log(JSON.stringify(mismatches.slice(0, 20)))
  return { reread: todo.length, hostsUsed, mismatches }
}

/** Re-read every null/zero inside a venue's covered span from a different host. */
/** Same reading? Published rows are rounded (stables to 1 unit, WETH to 0.001), so compare
 *  at that resolution. */
function sameRow(k, a, b) {
  if (a == null || b == null) return a == null && b == null
  const tol = 10 ** -dpOf(k)
  return a.every((x, i) =>
    i === 3 || i === 4 ? x === b[i] : Math.abs(x - b[i]) <= Math.max(tol, Math.abs(x) * 1e-9),
  )
}

async function phaseAudit(R) {
  const ts = [...SAMPLES.keys()].sort((a, b) => a - b)
  const suspects = new Set()
  for (const k of VENUE_KEYS) {
    const idx = ts.map((t) => SAMPLES.get(t).v[k]).map((r) => r != null && r[1] > 0)
    const first = idx.indexOf(true)
    const last = idx.lastIndexOf(true)
    if (first < 0) continue
    for (let i = first; i <= last; i++) {
      const r = SAMPLES.get(ts[i]).v[k]
      if (r == null || !(r[1] > 0) || (k !== VAULT.key && !(r[3] & 1))) suspects.add(ts[i])
    }
  }
  const audit = readJson(join(CACHE, 'audit.json')) ?? { confirmed: {} }
  const todo = [...suspects].filter((t) => !audit.confirmed[t])
  log(
    `audit: ${suspects.size} samples with a null/zero/inactive venue inside its span, ${todo.length} unconfirmed`,
  )
  let changed = 0
  for (const t of todo) {
    const s = SAMPLES.get(t)
    const r = await readSample(s.b, R, { avoid: s.src })
    if (r.ts !== s.t + s.dt) throw new Error(`audit: block ${s.b} timestamp disagrees across hosts`)
    const diff = VENUE_KEYS.filter((k) => !sameRow(k, r.v[k], s.v[k]))
    if (diff.length) {
      changed++
      log(
        `audit ${iso(t)} block ${s.b}: ${r.host} differs from ${s.src} on ${diff.join(',')} — keeping the non-empty answer`,
      )
      const v = { ...s.v }
      for (const k of diff) {
        const a = s.v[k]
        const b = r.v[k]
        v[k] = a == null || !(a[1] > 0) ? b : a
      }
      putSample({ ...s, v, audited: r.host })
    }
    audit.confirmed[t] = r.host
    await sleep(40)
  }
  writeFileSync(join(CACHE, 'audit.json'), JSON.stringify(audit) + '\n')

  // SECOND OPINION: a deterministic spread of ~40 samples, every venue's lowest-cash material
  // reading, and the first isolated 00:00 blips — each re-read at the same block from a host
  // other than the one that served it. Any difference is reported, never silently merged.
  const pick = new Set()
  const step = Math.max(1, Math.floor(ts.length / 40))
  for (let i = 0; i < ts.length; i += step) pick.add(ts[i])
  for (const k of VENUE_KEYS) {
    let best = null
    for (const t of ts) {
      const r = SAMPLES.get(t).v[k]
      if (material(k, r) && (best == null || r[0] < SAMPLES.get(best).v[k][0])) best = t
    }
    if (best != null) pick.add(best)
  }
  for (const b of Object.values(blipStats(ts))) {
    let n = 0
    for (const t of ts) {
      if (n >= 3 || t < isoTs(b.first)) continue
      const r = SAMPLES.get(t).v['aave-core-usdc']
      if (
        material('aave-core-usdc', r) &&
        1 - r[0] / r[1] >= 0.99 &&
        new Date(t * 1000).getUTCHours() === 0
      ) {
        pick.add(t)
        n++
      }
    }
  }
  const mismatches = []
  const hostsUsed = {}
  for (const t of [...pick].sort((a, b) => a - b)) {
    const s = SAMPLES.get(t)
    const r = await readSample(s.b, R, { avoid: s.src })
    hostsUsed[r.host] = (hostsUsed[r.host] ?? 0) + 1
    if (r.ts !== s.t + s.dt) mismatches.push({ at: iso(t), block: s.b, what: 'timestamp' })
    for (const k of VENUE_KEYS)
      if (!sameRow(k, r.v[k], s.v[k]))
        mismatches.push({
          at: iso(t),
          block: s.b,
          venue: k,
          first: s.v[k],
          second: r.v[k],
          hosts: [s.src, r.host],
        })
    await sleep(40)
  }
  log(
    `audit second opinion: ${pick.size} samples re-read on another host, ${mismatches.length} mismatches`,
  )
  return {
    suspects: suspects.size,
    reread: todo.length,
    changed,
    confirmedByHost: Object.keys(audit.confirmed).length,
    secondOpinion: { samples: pick.size, hostsUsed, mismatches },
  }
}

/** Exact-raw check of this reader against the Codex pinned Aave Core panel. */
async function phaseCrosscheck(R) {
  const panel = readJson(CODEX_CORE_PANEL)?.payload
  if (!panel) return { status: 'codex panel missing' }
  const rows = []
  for (const smp of panel.samples) {
    const calls = []
    for (const m of smp.markets) {
      calls.push({
        target: m.underlying,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [m.aToken],
      })
      calls.push({ target: m.aToken, abi: ERC20_ABI, functionName: 'totalSupply', args: [] })
      calls.push({
        target: m.variableDebtToken,
        abi: ERC20_ABI,
        functionName: 'totalSupply',
        args: [],
      })
    }
    const { out, ts } = await multicall(smp.block, calls)
    smp.markets.forEach((m, i) => {
      const got = out.slice(3 * i, 3 * i + 3).map(String)
      const want = [m.cashRaw, m.aTokenSupplyRaw, m.variableDebtSupplyRaw]
      rows.push({
        block: smp.block,
        at: iso(ts),
        market: m.name,
        exact: got.every((x, j) => x === want[j]),
      })
    })
  }
  const ok = rows.every((r) => r.exact)
  log(
    `crosscheck vs Codex aave-core-forward-panel-v1: ${rows.length} market rows, ${ok ? 'ALL EXACT' : 'MISMATCH'}`,
  )
  if (!ok) log(JSON.stringify(rows))
  return { source: CODEX_CORE_PANEL, rows, allExact: ok }
}

// ------------------------------------------------------------------ build

const round = (x, dp) => (x == null ? null : Math.round(x * 10 ** dp) / 10 ** dp)
const dpOf = (k) => (VENUE_BY_KEY[k].symbol === 'WETH' ? 3 : 0)

function quantile(sorted, q) {
  if (!sorted.length) return null
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}

function loadCodexUsde() {
  const j = readJson(CODEX_USDE_GRID)
  if (!j) return null
  const p = j.payload ?? j
  return {
    source: CODEX_USDE_GRID,
    study: p.study,
    semantics: `${p.semantics}; supply here = cash + debt (the grid did not read aToken.totalSupply)`,
    grid: p.grid,
    coverage: p.coverage,
    rows: p.rows,
  }
}

/** A reading counts once the venue is of material size (a just-listed reserve or a
 *  just-deployed vault with a few dollars in it is "100% utilized" or "100% liquid" trivially). */
const material = (k, r) => r != null && r[1] >= VENUE_BY_KEY[k].minSize

function episodeStats(ep, ts) {
  const inWin = ts.filter((t) => t >= ep.from && t <= ep.to)
  const hourly = new Set(inWin.filter((t) => t % H === 0))
  const per = {}
  for (const k of VENUE_KEYS) {
    let peak = null
    let peakAt = null
    let minCash = null
    let minCashAt = null
    let minFrac = null
    let ge99 = 0
    let ge95 = 0
    let run = 0
    let longest = 0
    let n = 0
    let paused = 0
    let frozen = 0
    let prevT = null
    let sustained = 0
    let singles = 0
    const endRun = () => {
      if (run >= 6) sustained += run
      if (run === 1) singles++
    }
    for (const t of inWin) {
      const r = SAMPLES.get(t).v[k]
      if (!material(k, r)) continue
      n++
      const u = 1 - r[0] / r[1]
      if (peak == null || u > peak) {
        peak = u
        peakAt = t
      }
      if (minCash == null || r[0] < minCash) {
        minCash = r[0]
        minCashAt = t
      }
      const f = r[0] / r[1]
      if (minFrac == null || f < minFrac) minFrac = f
      if (r[3] & 4) paused++
      if (r[3] & 2) frozen++
      if (u >= 0.99) {
        ge99++
        if (prevT != null && t - prevT <= H && run > 0) run++
        else {
          endRun()
          run = 1
        }
        longest = Math.max(longest, run)
      } else {
        endRun()
        run = 0
      }
      if (u >= 0.95) ge95++
      prevT = t
    }
    endRun()
    if (n === 0) continue
    per[k] = {
      samples: n,
      peakUtilPct: round(peak * 100, 3),
      peakAt: iso(peakAt),
      minCash: round(minCash, dpOf(k)),
      minCashAt: iso(minCashAt),
      minCashFracPct: round(minFrac * 100, 3),
      hoursGe99: ge99,
      hoursGe99InRunsGe6h: sustained,
      singleHourRunsGe99: singles,
      hoursGe95: ge95,
      longestRunGe99H: longest,
      pausedSamples: paused,
      frozenSamples: frozen,
    }
  }
  const spanH = Math.round((ep.to - ep.from) / H) + 1
  return {
    id: ep.id,
    trigger: ep.trigger,
    label: ep.label,
    venue: ep.venue,
    from: iso(ep.from),
    to: iso(ep.to),
    hours: spanH,
    hourlyCoveragePct: round((hourly.size / spanH) * 100, 1),
    detail: ep.detail,
    perVenue: per,
  }
}

function usdeEpisode(usde, ep) {
  if (!usde) return null
  const rows = usde.rows.filter((r) => r.at >= ep.from && r.at <= ep.to)
  if (!rows.length) return null
  let peak = -1
  let peakAt = null
  let minCash = Infinity
  let minCashAt = null
  let ge99 = 0
  for (const r of rows) {
    const s = r.cash + r.debt
    const u = s > 0 ? 1 - r.cash / s : 0
    if (u > peak) {
      peak = u
      peakAt = r.at
    }
    if (r.cash < minCash) {
      minCash = r.cash
      minCashAt = r.at
    }
    if (u >= 0.99) ge99++
  }
  return {
    samples3h: rows.length,
    peakUtilPct: round(peak * 100, 3),
    peakAt: iso(peakAt),
    minCash: Math.round(minCash),
    minCashAt: iso(minCashAt),
    samplesGe99: ge99,
    approxHoursGe99: ge99 * 3,
  }
}

function venueAnalog(k, ts, denseSet) {
  const fr = []
  const cash = []
  const all = []
  for (const t of ts) {
    const r = SAMPLES.get(t).v[k]
    if (!material(k, r)) continue
    const f = r[0] / r[1]
    all.push(f)
    if (denseSet.has(t)) {
      fr.push(f)
      cash.push(r[0])
    }
  }
  fr.sort((a, b) => a - b)
  cash.sort((a, b) => a - b)
  all.sort((a, b) => a - b)
  const pct = (x) => round(x * 100, 3)
  return {
    stressHours: fr.length,
    stressCashFracPct: {
      min: pct(fr[0]),
      p1: pct(quantile(fr, 0.01)),
      p5: pct(quantile(fr, 0.05)),
      p10: pct(quantile(fr, 0.1)),
      p50: pct(quantile(fr, 0.5)),
    },
    stressCash: {
      min: round(cash[0], dpOf(k)),
      p5: round(quantile(cash, 0.05), dpOf(k)),
      p50: round(quantile(cash, 0.5), dpOf(k)),
    },
    allSamplesCashFracPct: {
      min: pct(all[0]),
      p5: pct(quantile(all, 0.05)),
      p50: pct(quantile(all, 0.5)),
    },
  }
}

/**
 * ISOLATED BLIPS: hourly readings at util >= 99% whose neighbours one hour either side are
 * both < 95%. Measured: Aave Core USDC's cash goes to ~0 in the block read for 00:00 UTC on
 * most days of Q4-2024 and May-Oct 2026 (supply drops by exactly the cash, debt unchanged —
 * one supplier withdrawing every idle dollar and re-supplying within the hour). Counting
 * those as "hours at 99%" would overstate persistent stress, so they are reported apart.
 */
function blipStats(ts) {
  const out = {}
  const set = new Set(ts)
  for (const k of VENUE_KEYS) {
    const byHour = {}
    let count = 0
    let first = null
    let last = null
    for (const t of ts) {
      if (!set.has(t - H) || !set.has(t + H)) continue
      const r = SAMPLES.get(t).v[k]
      if (!material(k, r) || 1 - r[0] / r[1] < 0.99) continue
      const a = SAMPLES.get(t - H).v[k]
      const b = SAMPLES.get(t + H).v[k]
      if (!material(k, a) || !material(k, b)) continue
      if (1 - a[0] / a[1] >= 0.95 || 1 - b[0] / b[1] >= 0.95) continue
      count++
      const hr = new Date(t * 1000).getUTCHours()
      byHour[hr] = (byHour[hr] ?? 0) + 1
      first ??= t
      last = t
    }
    if (count) out[k] = { count, byUtcHour: byHour, first: iso(first), last: iso(last) }
  }
  return out
}

/** Frozen/paused bits vs the Codex Aave Core configuration census (exact event blocks). */
function freezeCheck(freeze, R, ts) {
  if (!freeze?.events) return null
  const from = Number(freeze.from)
  const to = Number(freeze.to)
  const rows = []
  for (const k of VENUE_KEYS.filter((x) => VENUE_BY_KEY[x].pool === 'aave-core')) {
    const asset = R.venues[k].asset.toLowerCase()
    for (const [type, bit] of [
      ['ReserveFrozen', 2],
      ['ReservePaused', 4],
    ]) {
      const ev = freeze.events
        .filter((e) => e.type === type && e.asset.toLowerCase() === asset)
        .sort((a, b) => a.block - b.block)
      let checked = 0
      let agree = 0
      for (const t of ts) {
        const s = SAMPLES.get(t)
        const r = s.v[k]
        if (!r || s.b < from || s.b > to) continue
        // state at the END of block s.b = the last event at or before it (if none: not set,
        // because the census window opens on an unfrozen, unpaused reserve for these assets)
        let want = false
        for (const e of ev) if (e.block <= s.b) want = e.enabled
        checked++
        if (Boolean(r[3] & bit) === want) agree++
      }
      rows.push({
        venue: k,
        type,
        events: ev.length,
        samplesChecked: checked,
        agree,
        disagree: checked - agree,
      })
    }
  }
  return rows
}

function phaseBuild(R, extras) {
  const end = gridEnd()
  const ts = [...SAMPLES.keys()].filter((t) => t <= end).sort((a, b) => a - b)
  const legacy = ts.filter((t) => legacyVault(SAMPLES.get(t).v[VAULT.key]))
  if (legacy.length)
    throw new Error(
      `build: ${legacy.length} vault rows predate the pro-rata field (first ${iso(legacy[0])}); run --phase=vault`,
    )
  const hosts = [...new Set(ts.map((t) => SAMPLES.get(t).src).filter(Boolean))]
  const eps = allEpisodes(end)
  const iv = denseIntervals(eps)
  const inDense = (t) => iv.some(([a, b]) => t >= a && t <= b)
  const denseSet = new Set(ts.filter((t) => t % H === 0 && inDense(t)))
  const timeline = { t: [], b: [], dt: [], src: [], dense: [] }
  const venues = Object.fromEntries(
    VENUE_KEYS.map((k) => [
      k,
      {
        cash: [],
        supply: [],
        debt: [],
        util: [],
        flags: [],
        apr: [],
        ...(k === VAULT.key ? { liquid: [] } : {}),
      },
    ]),
  )
  for (const t of ts) {
    const s = SAMPLES.get(t)
    timeline.t.push(t)
    timeline.b.push(s.b)
    timeline.dt.push(s.dt)
    timeline.src.push(hosts.indexOf(s.src))
    timeline.dense.push(denseSet.has(t) ? 1 : 0)
    for (const k of VENUE_KEYS) {
      const r = s.v[k]
      const c = venues[k]
      const dp = dpOf(k)
      c.cash.push(r ? round(r[0], dp) : null)
      c.supply.push(r ? round(r[1], dp) : null)
      c.debt.push(r ? round(r[2], dp) : null)
      c.util.push(r && r[1] > 0 ? round(1 - r[0] / r[1], 5) : null)
      c.flags.push(r ? r[3] : null)
      c.apr.push(r ? r[4] : null)
      if (c.liquid) c.liquid.push(r ? round(r[5], dp) : null)
    }
  }
  const usde = loadCodexUsde()
  const reused = usde
    ? {
        'aave-core-usde': {
          source: usde.source,
          study: usde.study,
          semantics: usde.semantics,
          t: usde.rows.map((r) => r.at),
          b: usde.rows.map((r) => r.block),
          cash: usde.rows.map((r) => Math.round(r.cash)),
          supply: usde.rows.map((r) => Math.round(r.cash + r.debt)),
          util: usde.rows.map((r) => round(1 - r.cash / (r.cash + r.debt), 5)),
          flags: usde.rows.map((r) => (r.active ? 1 : 0) | (r.frozen ? 2 : 0) | (r.paused ? 4 : 0)),
          apr: usde.rows.map((r) => round(r.borrowRatePct, 2)),
        },
      }
    : {}
  const history = {
    schema: 'venue-stress-history/v1',
    generatedAt: new Date().toISOString(),
    startTs: START,
    endTs: end,
    semantics: {
      t: 'target hour (unix s); every UTC hour (dense=1 marks the hours inside stress windows)',
      b: 'archive block read',
      dt: 'block timestamp - t (s)',
      src: 'index into hosts[] (keyed host that served the read; hosts only, never URLs)',
      cash: "withdrawable now, token units: Aave/Spark underlying.balanceOf(aToken); MetaMorpho = the vault's PRO-RATA share of its markets' idle cash, sum over withdrawQueue of vault assets in market x market idle / market totalSupplyAssets",
      liquid:
        'MetaMorpho only: the vault FIRST in line, sum over withdrawQueue of min(vault assets in market, market idle) (MetaMorpho maxWithdraw walk, no interest accrual)',
      supply: 'Aave/Spark aToken.totalSupply(); MetaMorpho totalAssets()',
      debt: 'Aave/Spark variableDebtToken.totalSupply(); MetaMorpho = totalAssets - cash',
      util: '1 - cash/supply',
      flags:
        'bit0 active, bit1 frozen (withdrawals still allowed), bit2 PAUSED (withdrawals blocked), bit3 aToken differed from head and was re-read with the historical one; MetaMorpho always 0',
      apr: 'Aave/Spark current variable borrow APR %; MetaMorpho = number of markets in the withdraw queue',
    },
    hosts,
    timeline,
    venues,
    reused,
  }
  writeJson(HISTORY_PATH, history)

  const coverage = {}
  for (const k of VENUE_KEYS) {
    const rows = ts.map((t) => [t, SAMPLES.get(t).v[k]])
    const live = rows.filter(([, r]) => r && r[1] > 0)
    if (!live.length) {
      coverage[k] = { samples: 0 }
      continue
    }
    const first = live[0][0]
    const last = live[live.length - 1][0]
    const inSpan = rows.filter(([t]) => t >= first && t <= last)
    let maxGap = 0
    for (let i = 1; i < live.length; i++) maxGap = Math.max(maxGap, live[i][0] - live[i - 1][0])
    const mat = live.find(([, r]) => material(k, r))
    coverage[k] = {
      first: iso(first),
      last: iso(last),
      materialFrom: mat ? iso(mat[0]) : null,
      minSize: VENUE_BY_KEY[k].minSize,
      samples: live.length,
      hourlyStressSamples: live.filter(([t]) => denseSet.has(t)).length,
      nullOrZeroInsideSpan: inSpan.length - live.length,
      maxGapHours: maxGap / H,
      pausedSamples: live.filter(([, r]) => r[3] & 4).length,
      frozenSamples: live.filter(([, r]) => r[3] & 2).length,
    }
  }
  if (usde) {
    coverage['aave-core-usde'] = {
      reusedFrom: usde.source,
      first: iso(usde.rows[0].at),
      last: iso(usde.rows[usde.rows.length - 1].at),
      samples: usde.rows.length,
      gridBlocks: usde.grid.step,
      maxGapHours: round(usde.coverage.maxGapSeconds / H, 2),
    }
  }
  const episodes = eps.map((e) => {
    const s = episodeStats(e, ts)
    const u = usdeEpisode(usde, e)
    if (u) s.reusedAaveCoreUsde = u
    return s
  })
  const maxDt = Math.max(...ts.map((t) => Math.abs(SAMPLES.get(t).dt)))
  const freeze = readJson(CODEX_FREEZE_CENSUS)
  const summary = {
    schema: 'venue-stress-summary/v1',
    generatedAt: new Date().toISOString(),
    range: { from: iso(START), to: iso(end) },
    owner:
      '2026-10-06: venue-capacity assumptions should directly analogize existing protocols (typical Aave capacity during stress over the last 3 years)',
    method: {
      baseline: `archive reads every ${BASE_STEP / H} h (hourly since 2026-10-07; 6-hourly before, which stepped over 2 h spikes)`,
      dense: 'hourly inside stress windows (dense=1)',
      triggers: {
        'eth-drop':
          'ETH/USD hourly low <= -10% vs max close of the prior 24 h (public/data/price-history/eth-usd-1h.json primary series); window first-24h .. last+72h',
        util: 'readings at util >= stressUtil (95%; 99% for spark-dai and spark-usdt, whose operating point is above 95%) on a venue with supply >= minSize, TRANSIENTS dropped (a stressed reading the reading one hour later clears, with no stressed reading the hour before: the Aave USDC 00:00 UTC drain; see transients), clustered while <= 72 h apart into one episode; window +-24 h (lib/position-sim/venueStressRules.ts utilClusters)',
        named: NAMED_EVENTS,
      },
      minSize: Object.fromEntries(VENUE_KEYS.map((k) => [k, VENUE_BY_KEY[k].minSize])),
      stressUtil: Object.fromEntries(
        VENUE_KEYS.map((k) => [k, VENUE_BY_KEY[k].stressUtil ?? 0.95]),
      ),
      falseEmptyGuards: [
        'empty/undecodable aggregate3 or missing block timestamp = endpoint error, retried on the next keyed host',
        'listed reserve with failing token reads, or vault with failing queue reads, throws instead of storing zeros',
        'audit: every null/zero/inactive venue inside its covered span re-read from a different host',
      ],
      blockAim: `block interpolated between observed (block, timestamp) anchors, re-aimed when > ${MAX_DT / 60} min off; max |dt| = ${maxDt} s`,
    },
    venues: Object.fromEntries(
      VENUE_KEYS.map((k) => [
        k,
        {
          protocol: k === VAULT.key ? VAULT.label : POOLS[VENUE_BY_KEY[k].pool].label,
          symbol: VENUE_BY_KEY[k].symbol,
          ...R.venues[k],
        },
      ]),
    ),
    coverage,
    samples: {
      total: ts.length,
      hourlyStress: denseSet.size,
      denseIntervals: iv.map(([a, b]) => [iso(a), iso(b)]),
    },
    episodes,
    analogs: Object.fromEntries(VENUE_KEYS.map((k) => [k, venueAnalog(k, ts, denseSet)])),
    blips: blipStats(ts),
    transients: transientStats(ts),
    vaultProRata: extras.vault ?? null,
    reuse: {
      'aave-core-usde': usde
        ? {
            path: usde.source,
            rows: usde.rows.length,
            use: 'carried into history.json reused + episode stats (3 h grid)',
          }
        : null,
      crossCheck: extras.crosscheck ?? null,
      freezeCensus: freeze
        ? {
            path: CODEX_FREEZE_CENSUS,
            window: `${freeze.from}-${freeze.to}`,
            events: freeze.events.length,
            positiveEvents: freeze.events.filter((e) => e.enabled).length,
            use: 'cross-check of the frozen/paused bits read at every sample: the census covers ReserveFrozen/ReservePaused logs on Aave Core, Aug 2025-Sep 2026',
            flagAgreement: freezeCheck(freeze, R, ts),
          }
        : null,
    },
    audit: extras.audit ?? null,
    // hosts that served THIS run's reads; a build-only run (no reads) keeps the last reading run's
    endpoints: EPS.some((e) => e.ok || e.fail)
      ? EPS.map((e) => ({ host: e.host, ok: e.ok, failed: e.fail, failReasons: e.reasons }))
      : (prevSummary?.endpoints ?? []),
  }
  writeJson(SUMMARY_PATH, summary)
  const sz = (p) => (existsSync(p) ? (readFileSync(p).length / 1e6).toFixed(2) : '0')
  log(
    `build: history.json ${sz(HISTORY_PATH)} MB, summary.json ${sz(SUMMARY_PATH)} MB, ${ts.length} samples (${denseSet.size} hourly stress)`,
  )
  return summary
}

// ------------------------------------------------------------------ main

const end = gridEnd()
log(
  `range ${iso(START)} -> ${iso(end)}; phases ${PHASES.join(',')}; hosts ${EPS.map((e) => e.host).join(', ')}`,
)
const R = await phaseResolve()
loadSamples()
const prevSummary = readJson(SUMMARY_PATH)
const extras = readJson(join(CACHE, 'extras.json')) ?? {
  audit: prevSummary?.audit ?? undefined,
  crosscheck: prevSummary?.reuse?.crossCheck ?? undefined,
  vault: prevSummary?.vaultProRata ?? undefined,
}
if (PHASES.includes('baseline')) await phaseBaseline(R, end)
if (PHASES.includes('vault')) {
  const vr = await phaseVault(R)
  if (vr.reread > 0 || !extras.vault) extras.vault = vr // a no-op pass keeps the last report
}
if (PHASES.includes('windows')) phaseWindows(end)
if (PHASES.includes('dense')) await phaseDense(R, end)
if (PHASES.includes('audit')) extras.audit = await phaseAudit(R)
if (PHASES.includes('crosscheck')) extras.crosscheck = await phaseCrosscheck(R)
writeFileSync(join(CACHE, 'extras.json'), JSON.stringify(extras) + '\n')
if (PHASES.includes('build')) {
  phaseBuild(R, extras)
  const full = ['baseline', 'dense', 'audit', 'build'].every((p) => PHASES.includes(p))
  if (full && !ARGS['keep-cache']) {
    rmSync(SAMPLES_PATH, { force: true })
    log('build: raw sample cache removed (history.json is the resume source)')
  }
}
log(
  `endpoints: ${EPS.map((e) => `${e.host} ok=${e.ok} fail=${e.fail} ${JSON.stringify(e.reasons)}`).join('; ')}`,
)
