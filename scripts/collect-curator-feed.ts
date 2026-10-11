// collect-curator-feed.ts — the curator action feed collector (Ethereum mainnet).
//
//   pnpm curators:feed               incremental: read only blocks after the last run
//   pnpm curators:feed --full        re-read the whole window (CURATOR_FEED_DAYS, default 182)
//   pnpm curators:feed --publish     also refresh the canonical copy in the private datasets
//                                    repo (<datasets>/curator-feed + PROVENANCE.md, board N18)
//   pnpm curators:feed --exposure    force a fresh exposure snapshot
//   CURATOR_FEED_TO_BLOCK=<n>        stop at block n instead of the finalized head
//
// LOCAL-FIRST (lib/curatorFeed/paths.ts): the run resumes from .data/curator-feed (else the
// datasets-repo copy at $MEMBRANE_DATASETS_DIR or ../membrane-datasets, else a full window)
// and writes .data/curator-feed. The API reads that live copy before the datasets copy. The window rolls: CURATOR_FEED_MAX_DAYS (default 190) of blocks are
// kept, never less than CURATOR_FEED_DAYS once full; submits still open are never dropped.
//
// Each run, over [last block + 1, finalized head]:
//   1. Logs, EVERY chunk read from two endpoints and unioned (scripts/lib/curator-feed-rpc.ts):
//      curator config events incl. Vault V2 adapter timelocks and BurnShares (topic-only),
//      reallocation legs (topic-only), Vault V2 allocator moves (topic1 = known allocators),
//      Aave v3 PoolConfigurator events, ownership transfers, Morpho Blue AccrueInterest.
//   2. Every NEW emitter is verified against its factory (isMetaMorpho ×2, isVaultV2, Euler
//      Earn isVault, isMorphoMarketV1AdapterV2); verified kinds are carried in state.json.
//   3. Archive reads the events cannot supply: the cap before each SetCap, the timelock in
//      force at each submit, a vault's queue before its first queue event ever seen.
//   4. lib/curatorFeed classifies, resuming the carried replay state, so an incremental run
//      equals one run over the whole range (tests/unit/curatorFeed.test.ts proves the split).
//   5. Head reads of EVERY still-open V1 / Euler Earn submit (applyHeadPending).
//   6. Exit context (what the vault still had capped in that collateral) and write-off size.
//   7. Flows: netted per tx, daily rows merged onto the carried ones.
//   8. Exposure at the head, when older than CURATOR_FEED_EXPOSURE_MAX_AGE_H (default 6).
//   9. Attribution (withdrawal-first): ≥ $1M net reallocation withdrawals, market + IRM reads.
//  10. Spikes (spike-first): AccrueInterest rate jumps on markets curated vaults use, then
//      every Morpho Blue flow in the block that set the new rate (lib/curatorFeed/spikes.ts).
//  11. Flags (lib/curatorFeed/flags.ts) on the same markets: what the oracle prices from,
//      whether price() reverts or a feed is stale, the largest borrower (with each exposure
//      read), whether a market was fully borrowed at the head and 7 days earlier; and
//      curator shifts between a curator's own vaults followed by cuts. Exposure carries each
//      MetaMorpho v1.1 vault's lostAssets() (counted in its totalAssets()).
//
// RPC: env keys are never printed or stored (labels only). Labels: Morpho API curator
// registry + vault list, Euler labels entities.json. Prices: Morpho API, collection time.

import { execSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

import {
  decodeParams,
  eventByName,
  topicsFor,
  type AbiType,
  type EmitterKind,
  type RawLog,
} from '../lib/curatorFeed/abi'
import { attribute } from '../lib/curatorFeed/attribution'
import {
  applyHeadPending,
  classifyEvents,
  emptyClassifierState,
  headKey,
  needsHeadRead,
  type ClassifyContext,
} from '../lib/curatorFeed/classify'
import { decodeLog, type DecodedEvent } from '../lib/curatorFeed/decode'
import { toAssetsDown } from '../lib/curatorFeed/exposure'
import {
  aggregateDaily,
  decodeFlows,
  encodeUnitFlows,
  mergeUnitFlows,
  netPerTx,
  selectLargeWithdrawals,
  toUnitFlows,
  type UnitFlow,
} from '../lib/curatorFeed/flows'
import {
  FLAG_DEFAULTS,
  classifyOracle,
  detectShifts,
  hasMarketFlag,
  marketFlagKinds,
  revertOnset,
  utilization,
} from '../lib/curatorFeed/flags'
import { keccakText } from '../lib/curatorFeed/keccak'
import {
  detectSpikes,
  groupFlows,
  type BlueFlowLog,
  type RatePoint,
} from '../lib/curatorFeed/spikes'
import { datasetsRoot, liveDir, seedDir } from '../lib/curatorFeed/paths'
import {
  SCHEMA,
  encodeFeedFile,
  encodeStateFile,
  parseExposureFile,
  parseFeedFile,
  parseFlowsFile,
  parseStateFile,
  type CollectorState,
  type ExposureFile,
  type FeedFile,
  type FeedMeta,
} from '../lib/curatorFeed/store'
import type {
  AttributionCase,
  Entities,
  ExposureAlloc,
  ExposureVault,
  FeedAction,
  FeedFlags,
  MarketFlags,
  OraclePart,
  Protocol,
  Reallocation,
  SpikeCase,
} from '../lib/curatorFeed/types'
import { EXIT_KINDS } from '../lib/curatorFeed/types'
import {
  collateralIdData,
  decodeV2IdData,
  marketIdData,
  v2IdOf,
  type V2IdData,
} from '../lib/curatorFeed/v2ids'
import { BLOCKS_PER_DAY, trimFeed, trimFlows, windowStart } from '../lib/curatorFeed/window'
import { MAINNET } from './lib/curator-feed-chain'
import { FeedRpc, endpointsFromEnv, type RpcLog } from './lib/curator-feed-rpc'

const ARGS = new Set(process.argv.slice(2))
const FULL = ARGS.has('--full') || process.env.CURATOR_FEED_FULL === '1'
const PUBLISH = ARGS.has('--publish')
const FORCE_EXPOSURE = ARGS.has('--exposure')
const DAYS = Number(process.env.CURATOR_FEED_DAYS ?? 182)
const MAX_DAYS = Math.max(DAYS, Number(process.env.CURATOR_FEED_MAX_DAYS ?? 190))
const EXPOSURE_MAX_AGE_H = Number(process.env.CURATOR_FEED_EXPOSURE_MAX_AGE_H ?? 6)

const LARGE_WITHDRAW_USD = 1_000_000
const EXPOSURE_MIN_USD = 100_000
/** An attribution case is kept when the block cut the market's supply by at least this much (or spiked / drained it). */
const KEPT_SUPPLY_DROP = 0.2
/** Spike pre-filter: borrowed size implied by the accrual (interest ÷ rate·Δt), USD. */
const SPIKE_MIN_BORROW_USD = 500_000
/** Spike kept when the market had at least this much supply before the block, USD. */
const SPIKE_MIN_SUPPLY_USD = 1_000_000

const CHAIN = MAINNET
const ZERO = '0x0000000000000000000000000000000000000000'
const MORPHO_API = 'https://blue-api.morpho.org/graphql'

/** Vault V2 timelocks read per vault (selector → name used in VaultInfo.timelocks). */
const V2_TIMELOCK_FNS: [string, string][] = [
  ['0xf6f98fd5', 'increaseAbsoluteCap'],
  ['0x2438525b', 'increaseRelativeCap'],
  ['0x60d54d41', 'addAdapter'],
  ['0xb192a84a', 'setIsAllocator'],
]
const ADAPTER_BURN_SELECTOR = '0x3b2de5ac'

const rpc = new FeedRpc(endpointsFromEnv())
const log = (...a: unknown[]) =>
  console.log('[curator-feed]', ...a.map((x) => (typeof x === 'string' ? rpc.scrub(x) : x)))

// ── small helpers ──────────────────────────────────────────────────────────────

const selCache = new Map<string, string>()
const sel = (sig: string): string => {
  let s = selCache.get(sig)
  if (!s) selCache.set(sig, (s = keccakText(sig).slice(0, 10)))
  return s
}
const pad = (x: string | bigint | number): string =>
  typeof x === 'string'
    ? x.toLowerCase().replace(/^0x/, '').padStart(64, '0')
    : BigInt(x).toString(16).padStart(64, '0')
const hexN = (n: number): string => '0x' + n.toString(16)
const lc = (a: string): string => a.toLowerCase()
const call = (
  to: string,
  sig: string,
  args: (string | bigint | number)[] = [],
  block: number | 'latest' = 'latest',
) => ({
  method: 'eth_call',
  params: [
    { to, data: sel(sig) + args.map(pad).join('') },
    typeof block === 'number' ? hexN(block) : block,
  ],
})
/** A raw selector call (no signature string), e.g. timelock(bytes4) with a bytes4 arg. */
const rawCall = (to: string, data: string, block: number | 'latest' = 'latest') => ({
  method: 'eth_call',
  params: [{ to, data }, typeof block === 'number' ? hexN(block) : block],
})
const dec = (types: AbiType[], ret: string | null): any[] | null => {
  if (!ret || ret === '0x') return null
  try {
    return decodeParams(types, ret)
  } catch {
    return null
  }
}
const word = (ret: string | null): bigint | undefined =>
  dec(['uint256'], ret)?.[0] as bigint | undefined
const addrOf = (ret: string | null): string | undefined => {
  const a = dec(['address'], ret)?.[0] as string | undefined
  return a && a !== ZERO ? a : undefined
}
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)]
const chunked = <T>(xs: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))
const MARKET6: AbiType[] = ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256']

async function gql<T>(query: string): Promise<T | null> {
  try {
    const r = await fetch(MORPHO_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    })
    const j = (await r.json()) as { data?: T; errors?: unknown }
    if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200))
    return j.data ?? null
  } catch (e) {
    log(`morpho api: ${String(e).slice(0, 200)}`)
    return null
  }
}

async function paged<T>(field: string, selection: string, where: string): Promise<T[]> {
  const out: T[] = []
  for (let skip = 0; skip < 20_000; skip += 500) {
    const d = await gql<Record<string, { items: T[] }>>(
      `{ ${field}(first: 500, skip: ${skip}, where: ${where}) { items { ${selection} } } }`,
    )
    const items = d?.[field]?.items ?? []
    out.push(...items)
    if (items.length < 500) break
  }
  return out
}

const toRaw = (l: RpcLog, ts: number): RawLog => ({
  address: lc(l.address),
  topics: l.topics.map(lc),
  data: l.data,
  blockNumber: parseInt(l.blockNumber, 16),
  logIndex: parseInt(l.logIndex, 16),
  transactionHash: lc(l.transactionHash),
  timestamp: ts,
})

// ── previous run ───────────────────────────────────────────────────────────────

interface Prev {
  dir: string
  feed: FeedFile
  flows: UnitFlow[]
  exposure: ExposureFile
  state: CollectorState
}

function loadPrev(): Prev | null {
  for (const [rel, dir] of [
    ['.data/curator-feed', liveDir()],
    ['datasets/curator-feed', seedDir()],
  ]) {
    if (!existsSync(join(dir, 'state.json'))) continue
    try {
      const read = (n: string) => JSON.parse(readFileSync(join(dir, n), 'utf8'))
      return {
        dir: rel,
        feed: parseFeedFile(read('feed.json')),
        flows: decodeFlows(parseFlowsFile(read('flows.json'))),
        exposure: parseExposureFile(read('exposure.json')),
        state: parseStateFile(read('state.json')),
      }
    } catch (e) {
      log(`${rel}: unreadable previous run (${String(e).slice(0, 120)}) — trying the next location`)
    }
  }
  return null
}

const emptyEntities = (): Entities => ({
  tokens: {},
  markets: {},
  vaults: {},
  curators: {},
  strategies: {},
  aaveMarkets: { ...CHAIN.aave },
  v2Ids: {},
})

// ── main ───────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now()
  const startedAt = new Date().toISOString()
  if (PUBLISH && !existsSync(datasetsRoot()))
    throw new Error(
      '--publish writes to the private datasets repo: clone triccs/membrane-datasets next to the app or set MEMBRANE_DATASETS_DIR',
    )
  log(`endpoints: ${rpc.endpoints.map((e) => e.label).join(', ')}`)
  // CURATOR_FEED_TO_BLOCK pins the head (reproducing a run, or checking incremental = full).
  const pinned = process.env.CURATOR_FEED_TO_BLOCK
  const headBlock = await rpc.call<{ number: string; timestamp: string }>('eth_getBlockByNumber', [
    pinned ? hexN(Number(pinned)) : 'finalized',
    false,
  ])
  const toBlock = parseInt(headBlock.number, 16)
  const toTs = parseInt(headBlock.timestamp, 16)

  let prev = FULL ? null : loadPrev()
  if (prev && prev.state.toBlock >= toBlock) {
    log(`up to date at block ${prev.state.toBlock} (finalized head ${toBlock}); nothing to do`)
    return
  }
  if (prev && toBlock - prev.state.toBlock > MAX_DAYS * BLOCKS_PER_DAY) {
    log(`previous run is more than ${MAX_DAYS} days behind — starting a full window`)
    prev = null
  }
  const mode: 'full' | 'incremental' = prev ? 'incremental' : 'full'
  const fromBlock = prev ? prev.state.toBlock + 1 : toBlock - DAYS * BLOCKS_PER_DAY
  const windowFrom = prev ? windowStart(toBlock, MAX_DAYS, prev.state.fromBlock) : fromBlock
  const fromHdr = await rpc.call<{ timestamp: string }>('eth_getBlockByNumber', [
    hexN(fromBlock),
    false,
  ])
  const winHdr = await rpc.call<{ timestamp: string }>('eth_getBlockByNumber', [
    hexN(windowFrom),
    false,
  ])
  const windowFromTs = parseInt(winHdr.timestamp, 16)
  log(
    `${mode} run: blocks ${fromBlock}–${toBlock} (${((toTs - parseInt(fromHdr.timestamp, 16)) / 86400).toFixed(2)} days)` +
      (prev ? `, resuming ${prev.dir} at ${prev.state.toBlock}` : '') +
      `; window ${windowFrom}–${toBlock}`,
  )

  const state: CollectorState = prev
    ? structuredClone(prev.state)
    : {
        schema: SCHEMA,
        chainId: 1,
        toBlock: 0,
        fromBlock: windowFrom,
        kinds: Object.fromEntries(Object.keys(CHAIN.aave).map((a) => [a, 'aave' as EmitterKind])),
        adapters: {},
        allocators: {},
        classifier: emptyClassifierState(),
        rates: {},
        exposureBlock: 0,
      }
  const ent: Entities = prev ? structuredClone(prev.feed.entities) : emptyEntities()
  const kindOf = new Map<string, EmitterKind>(Object.entries(state.kinds))

  // ── labels (off-chain registries) ──
  type ApiAsset = {
    address: string
    symbol: string
    decimals: number
    price?: { usd: number | null } | null
  }
  const apiV1 = await paged<{
    address: string
    name: string
    asset: ApiAsset
    state: { totalAssetsUsd: number | null } | null
  }>(
    'vaults',
    'address name asset { address symbol decimals price { usd } } state { totalAssetsUsd }',
    `{ chainId_in: [${CHAIN.morphoApiChainId}] }`,
  )
  const apiV2 = await paged<{
    address: string
    name: string
    asset: ApiAsset
    totalAssetsUsd: number | null
  }>(
    'vaultV2s',
    'address name asset { address symbol decimals price { usd } } totalAssetsUsd',
    `{ chainId_in: [${CHAIN.morphoApiChainId}] }`,
  )
  const apiCurators =
    (
      await gql<{
        curators: { items: { name: string; addresses: { address: string; chainId: number }[] }[] }
      }>(`{ curators(first: 1000) { items { name addresses { address chainId } } } }`)
    )?.curators.items ?? []
  let eulerEntities: Record<string, { name: string; addresses?: Record<string, string> }> = {}
  try {
    eulerEntities = (await (await fetch(CHAIN.eulerLabels)).json()) as typeof eulerEntities
  } catch (e) {
    log(`euler labels: ${String(e).slice(0, 120)}`)
  }
  for (const a of [...apiV1, ...apiV2].map((v) => v.asset)) {
    if (!a?.address) continue
    const k = lc(a.address)
    ent.tokens[k] = {
      ...ent.tokens[k],
      symbol: a.symbol,
      decimals: a.decimals,
      priceUsd: a.price?.usd ?? ent.tokens[k]?.priceUsd ?? undefined,
    }
  }
  const apiTvl = new Map<string, number>([
    ...apiV1.map((v) => [lc(v.address), v.state?.totalAssetsUsd ?? 0] as const),
    ...apiV2.map((v) => [lc(v.address), v.totalAssetsUsd ?? 0] as const),
  ])
  log(`api: ${apiV1.length} V1 vaults, ${apiV2.length} V2 vaults, ${apiCurators.length} curators`)

  const eeLen =
    word(
      await rpc.call<string>('eth_call', call(CHAIN.eeFactory, 'getVaultListLength()').params),
    ) ?? 0n
  const eeList = (
    (dec(
      ['address[]'],
      await rpc.call<string>(
        'eth_call',
        call(CHAIN.eeFactory, 'getVaultListSlice(uint256,uint256)', [0n, eeLen]).params,
      ),
    )?.[0] ?? []) as string[]
  ).map(lc)

  // ── log scans over [fromBlock, toBlock], every chunk dual-read ──
  const highVolume = [
    eventByName('mm', 'ReallocateSupply').topic0,
    eventByName('mm', 'ReallocateWithdraw').topic0,
    eventByName('ee', 'ReallocateSupply').topic0,
    eventByName('ee', 'ReallocateWithdraw').topic0,
    eventByName('v2', 'Allocate').topic0,
    eventByName('v2', 'Deallocate').topic0,
    eventByName('v2', 'ForceDeallocate').topic0,
    eventByName('mm', 'OwnershipTransferred').topic0,
  ]
  const configTopics = uniq(
    (['mm', 'ee', 'v2', 'v2adapter'] as EmitterKind[]).flatMap((k) =>
      topicsFor(k).filter((t) => !highVolume.includes(t)),
    ),
  )
  const progress = (label: string) => (d: number, n: number) => {
    if (d % 25 === 0 || d === n) log(`${label}: ${d}/${n} chunks`)
  }
  const scan = (
    label: string,
    filter: Parameters<FeedRpc['getLogs']>[0],
    a = fromBlock,
    b = toBlock,
  ) => rpc.getLogs(filter, a, b, { dual: true, concurrency: 4, onChunk: progress(label) })

  const logsA = await scan('A config', { topics: [configTopics] })
  const logsB = await scan('B realloc', { topics: [highVolume.slice(0, 4)] })
  const logsE = await scan('E aave', {
    address: Object.keys(CHAIN.aave),
    topics: [topicsFor('aave')],
  })

  // ── verify new emitters (topic0 proves nothing) ──
  const candidates = uniq(
    [...logsA, ...logsB]
      .map((l) => lc(l.address))
      .concat(
        apiV1.map((v) => lc(v.address)),
        apiV2.map((v) => lc(v.address)),
        eeList,
      ),
  ).filter((a) => !kindOf.has(a))
  const checks = await rpc.batch(
    candidates.flatMap((a) => [
      call(CHAIN.mmFactories[0], 'isMetaMorpho(address)', [a]),
      call(CHAIN.mmFactories[1], 'isMetaMorpho(address)', [a]),
      call(CHAIN.v2Factory, 'isVaultV2(address)', [a]),
      call(CHAIN.eeFactory, 'isVault(address)', [a]),
      call(CHAIN.v2AdapterFactory, 'isMorphoMarketV1AdapterV2(address)', [a]),
    ]),
  )
  const truthy = (r: string | null) => word(r) === 1n
  const newAdapters: string[] = []
  candidates.forEach((a, i) => {
    const [m0, m1, v2, ee, ad] = checks.slice(i * 5, i * 5 + 5).map(truthy)
    if (m0 || m1) kindOf.set(a, 'mm')
    else if (v2) kindOf.set(a, 'v2')
    else if (ee) kindOf.set(a, 'ee')
    else if (ad) newAdapters.push(a)
  })
  // An adapter counts only when its parent is a verified Vault V2.
  const parents = await rpc.batch(newAdapters.map((a) => call(a, 'parentVault()')))
  newAdapters.forEach((a, i) => {
    const p = addrOf(parents[i])
    if (p && kindOf.get(lc(p)) === 'v2') {
      kindOf.set(a, 'v2adapter')
      state.adapters[a] = lc(p)
    }
  })
  const vaultsOf = (k: EmitterKind) =>
    [...kindOf.entries()].filter(([, x]) => x === k).map(([a]) => a)
  const unverified = uniq(
    [...logsA, ...logsB].map((l) => lc(l.address)).filter((a) => !kindOf.has(a)),
  )
  log(
    `verified: mm ${vaultsOf('mm').length}, v2 ${vaultsOf('v2').length}, v2 adapters ${vaultsOf('v2adapter').length}, ee ${vaultsOf('ee').length}; ${unverified.length} unverified emitters dropped this run`,
  )

  // Scan F: ownership transfers on V1 / Euler Earn vaults (address-filtered — the topic is everywhere).
  const logsF: RpcLog[] = []
  for (const grp of chunked([...vaultsOf('mm'), ...vaultsOf('ee')], 250)) {
    const got = await scan('F owners', {
      address: grp,
      topics: [[eventByName('mm', 'OwnershipTransferred').topic0]],
    })
    // A loop, not push(...got): a spread of 10⁵ logs overflows the call stack.
    for (const l of got) logsF.push(l)
  }

  // Scan C (first run only): V2 allocators ever set before the window. Then scan D.
  const allocTopic = eventByName('v2', 'SetIsAllocator').topic0
  const v2Set = new Set(vaultsOf('v2'))
  const preAlloc =
    !prev && CHAIN.v2FactoryDeploy < fromBlock
      ? await scan('C allocators', { topics: [[allocTopic]] }, CHAIN.v2FactoryDeploy, fromBlock - 1)
      : []
  for (const l of [...preAlloc, ...logsA]) {
    const a = lc(l.address)
    if (!v2Set.has(a) || lc(l.topics[0]) !== allocTopic) continue
    const r = decodeLog('v2', toRaw(l, 0))
    if (r.ok && r.event.args.isAllocator === true) {
      const set = new Set(state.allocators[a] ?? [])
      set.add(String(r.event.args.allocator))
      state.allocators[a] = [...set]
    }
  }
  const allAllocators = uniq(Object.values(state.allocators).flat())
  const logsD: RpcLog[] = []
  for (const grp of chunked(allAllocators, 100)) {
    const got = await scan('D v2 allocs', {
      topics: [
        [eventByName('v2', 'Allocate').topic0, eventByName('v2', 'Deallocate').topic0],
        grp.map((x) => '0x' + pad(x)),
      ],
    })
    for (const l of got) logsD.push(l)
  }
  log(
    `scans: config ${logsA.length}, realloc ${logsB.length}, aave ${logsE.length}, owners ${logsF.length}, v2 allocator moves ${logsD.length}`,
  )

  // ── timestamps + decode ──
  const allLogs = [...logsA, ...logsB, ...logsD, ...logsE, ...logsF]
  const tsOf = new Map<number, number>()
  for (const l of allLogs)
    if (l.blockTimestamp) tsOf.set(parseInt(l.blockNumber, 16), parseInt(l.blockTimestamp, 16))
  await fillTimestamps(tsOf, uniq(allLogs.map((l) => parseInt(l.blockNumber, 16))))
  const events: DecodedEvent[] = []
  let malformed = 0
  const seenLog = new Set<string>()
  for (const l of allLogs) {
    const kind = kindOf.get(lc(l.address))
    if (!kind) continue
    const uid = `${l.transactionHash}:${l.logIndex}`
    if (seenLog.has(uid)) continue
    seenLog.add(uid)
    const r = decodeLog(kind, toRaw(l, tsOf.get(parseInt(l.blockNumber, 16)) ?? 0))
    if (r.ok) events.push(r.event)
    else if (r.reason === 'malformed') malformed++
  }
  log(`decoded ${events.length} events (${malformed} malformed)`)

  // ── Vault V2 adapters (every run: maps Allocate ids, spikes, exposure, write-offs) ──
  const v2Vaults = vaultsOf('v2')
  const adLen = await rpc.batch(v2Vaults.map((a) => call(a, 'adaptersLength()')))
  const adCalls: { vault: string; i: number }[] = []
  v2Vaults.forEach((a, i) => {
    for (let j = 0; j < Math.min(Number(word(adLen[i]) ?? 0n), 32); j++)
      adCalls.push({ vault: a, i: j })
  })
  const adRes = await rpc.batch(
    adCalls.map(({ vault, i }) => call(vault, 'adapters(uint256)', [BigInt(i)])),
  )
  const adaptersOf = new Map<string, string[]>()
  adCalls.forEach(({ vault }, k) => {
    const a = addrOf(adRes[k])
    if (a) adaptersOf.set(vault, [...(adaptersOf.get(vault) ?? []), lc(a)])
  })
  const allAdapters = uniq([...adaptersOf.values()].flat())
  const adProbe = await rpc.batch(
    allAdapters.flatMap((a) => [
      call(a, 'marketIdsLength()'),
      call(a, 'morphoVaultV1()'),
      call(a, 'realAssets()'),
    ]),
  )
  const adapterKind = new Map<
    string,
    { kind: 'market' | 'vault' | 'other'; n?: number; v1?: string; real?: bigint }
  >()
  allAdapters.forEach((a, i) => {
    const n = word(adProbe[i * 3])
    const v1 = addrOf(adProbe[i * 3 + 1])
    const real = word(adProbe[i * 3 + 2])
    adapterKind.set(
      a,
      n !== undefined
        ? { kind: 'market', n: Number(n), real }
        : v1
          ? { kind: 'vault', v1: lc(v1), real }
          : { kind: 'other', real },
    )
  })
  for (const [vault, list] of adaptersOf) {
    for (const a of list) {
      if (adapterKind.get(a)?.kind !== 'market') continue
      state.adapters[a] = vault
      if (!kindOf.has(a)) kindOf.set(a, 'v2adapter')
    }
  }
  const midCalls: { adapter: string; i: number }[] = []
  for (const [a, k] of adapterKind)
    if (k.kind === 'market')
      for (let j = 0; j < Math.min(k.n ?? 0, 64); j++) midCalls.push({ adapter: a, i: j })
  const midRes = await rpc.batch(
    midCalls.map(({ adapter, i }) => call(adapter, 'marketIds(uint256)', [BigInt(i)])),
  )
  const marketIdsOfAdapter = new Map<string, string[]>()
  midCalls.forEach(({ adapter }, k) => {
    const id = dec(['bytes32'], midRes[k])?.[0] as string | undefined
    if (id) marketIdsOfAdapter.set(adapter, [...(marketIdsOfAdapter.get(adapter) ?? []), id])
  })
  log(
    `v2 adapters: ${allAdapters.length} (${[...adapterKind.values()].filter((k) => k.kind === 'market').length} Morpho market adapters, ${[...adapterKind.values()].filter((k) => k.kind === 'vault').length} MetaMorpho adapters)`,
  )
  // Adapter events from this run whose emitter only became known through the vault list.
  for (const l of logsA) {
    const a = lc(l.address)
    if (
      kindOf.get(a) !== 'v2adapter' ||
      events.some(
        (e) =>
          e.emitter === a &&
          e.logIndex === parseInt(l.logIndex, 16) &&
          e.tx === lc(l.transactionHash),
      )
    )
      continue
    const r = decodeLog('v2adapter', toRaw(l, tsOf.get(parseInt(l.blockNumber, 16)) ?? 0))
    if (r.ok) events.push(r.event)
  }

  // ── exposure refresh decision + vault info ──
  const refreshExposure =
    FORCE_EXPOSURE || !prev || toTs - (prev.exposure.ts ?? 0) > EXPOSURE_MAX_AGE_H * 3600
  const tvlOk = (a: string, total: bigint) =>
    (apiTvl.get(a) ?? 0) >= EXPOSURE_MIN_USD || (!apiTvl.has(a) && total > 0n)
  const infoTargets = uniq([
    ...events.map((e) =>
      e.kind === 'v2adapter' ? (state.adapters[e.emitter] ?? e.emitter) : e.emitter,
    ),
    ...(refreshExposure ? [...vaultsOf('mm'), ...vaultsOf('v2'), ...vaultsOf('ee')] : []),
  ]).filter((a) => ['mm', 'v2', 'ee'].includes(kindOf.get(a) ?? ''))
  const lostAssetsOf = new Map<string, bigint>()
  const totalAssetsOf = await readVaultInfo(
    infoTargets,
    kindOf,
    adaptersOf,
    adapterKind,
    ent,
    toBlock,
    lostAssetsOf,
  )

  // ── curator identity (current registries, every vault we hold) ──
  const nameByAddr = new Map<string, { name: string; source: 'morpho-api' | 'euler-labels' }>()
  for (const c of apiCurators)
    for (const ad of c.addresses)
      if (ad.chainId === CHAIN.chainId)
        nameByAddr.set(lc(ad.address), { name: c.name, source: 'morpho-api' })
  for (const e of Object.values(eulerEntities))
    for (const ad of Object.keys(e.addresses ?? {}))
      if (!nameByAddr.has(lc(ad))) nameByAddr.set(lc(ad), { name: e.name, source: 'euler-labels' })
  for (const [a, v] of Object.entries(ent.vaults)) {
    const hit = [v.curator, v.owner]
      .filter((x): x is string => Boolean(x && x !== ZERO))
      .map(lc)
      .map((x) => ({ x, n: nameByAddr.get(x) }))
      .find((h) => h.n)
    if (hit?.n) {
      const key = `name:${hit.n.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
      ent.curators[key] = { name: hit.n.name, source: hit.n.source }
      v.curatorKey = key
    } else {
      const addr = v.curator && v.curator !== ZERO ? lc(v.curator) : lc(v.owner ?? a)
      ent.curators[addr] = ent.curators[addr] ?? { name: addr, source: 'address' }
      v.curatorKey = addr
    }
  }
  for (const [a, label] of Object.entries(CHAIN.aave))
    ent.curators[`aave:${a}`] = { name: label, source: 'address' }

  // ── archive reads the events cannot supply ──
  const evOf = (k: EmitterKind, name: string) =>
    events.filter((e) => e.kind === k && e.name === name)
  const capEvents = [
    ...evOf('mm', 'SetCap'),
    ...evOf('mm', 'SubmitCap'),
    ...evOf('ee', 'SetCap'),
    ...evOf('ee', 'SubmitCap'),
  ]
  const capRes = await rpc.batch(
    capEvents.map((e) =>
      call(
        e.emitter,
        e.kind === 'mm' ? 'config(bytes32)' : 'config(address)',
        [String(e.args.id)],
        e.block - 1,
      ),
    ),
  )
  const prevCapMap = new Map<string, string>()
  capEvents.forEach((e, i) => {
    const w = dec(
      e.kind === 'mm' ? ['uint256', 'bool', 'uint256'] : ['uint256', 'uint256', 'bool', 'uint256'],
      capRes[i],
    )
    if (w)
      prevCapMap.set(
        `${e.emitter}|${String(e.args.id)}|${e.block}`,
        String(e.kind === 'mm' ? w[0] : w[1]),
      )
  })
  // The timelock in force at each V1 / Euler Earn submit (read at the block before).
  const submitEvents = events.filter(
    (e) => (e.kind === 'mm' || e.kind === 'ee') && /^Submit|^SetTimelock$/.test(e.name),
  )
  const tlRes = await rpc.batch(
    submitEvents.map((e) => call(e.emitter, 'timelock()', [], e.block - 1)),
  )
  const tlAt = new Map<string, number>()
  submitEvents.forEach((e, i) => {
    const t = word(tlRes[i])
    if (t !== undefined) tlAt.set(`${e.emitter}|${e.block}`, Number(t))
  })
  const timelockAt = (vault: string, block: number): number | undefined =>
    tlAt.get(`${vault}|${block}`) ??
    tlAt.get(`${vault}|${block + 1}`) ??
    ent.vaults[vault]?.timelock
  // Baseline queues: only for vaults whose queue the carried state does not hold yet.
  const firstQ = new Map<string, { block: number; which: 'supply' | 'withdraw' }>()
  for (const e of events) {
    if (
      (e.kind !== 'mm' && e.kind !== 'ee') ||
      (e.name !== 'SetSupplyQueue' && e.name !== 'SetWithdrawQueue')
    )
      continue
    const which = e.name === 'SetSupplyQueue' ? 'supply' : 'withdraw'
    if ((which === 'supply' ? state.classifier.supplyQ : state.classifier.withdrawQ)[e.emitter])
      continue
    const k = `${e.emitter}|${which}`
    const cur = firstQ.get(k)
    if (!cur || e.block < cur.block) firstQ.set(k, { block: e.block, which })
  }
  const baselines = await readQueues(
    [...firstQ.entries()].map(([k, q]) => ({
      vault: k.split('|')[0],
      which: q.which,
      block: q.block - 1,
    })),
    kindOf,
  )
  const baselineSupplyQueue: Record<string, string[]> = {}
  const baselineWithdrawQueue: Record<string, string[]> = {}
  for (const b of baselines)
    (b.which === 'supply' ? baselineSupplyQueue : baselineWithdrawQueue)[b.vault] = b.ids

  // ── V2 ids: from cap events, and derived for every market adapter's markets ──
  const v2Ids: Record<string, V2IdData> = {}
  for (const e of events) {
    if (e.kind !== 'v2') continue
    const idData = typeof e.args.idData === 'string' ? e.args.idData : undefined
    if (idData) v2Ids[v2IdOf(idData)] = decodeV2IdData(idData)
  }

  // ── Morpho Blue market params for every id we touch ──
  const morphoIds = new Set<string>()
  for (const e of events) {
    if ((e.kind === 'mm' || e.kind === 'v2adapter') && typeof e.args.id === 'string')
      morphoIds.add(e.args.id)
    if (e.kind === 'v2adapter' && typeof e.args.marketId === 'string')
      morphoIds.add(e.args.marketId)
    if (e.kind === 'mm' && Array.isArray(e.args.newWithdrawQueue))
      (e.args.newWithdrawQueue as string[]).forEach((x) => morphoIds.add(x))
    if (e.kind === 'mm' && Array.isArray(e.args.newSupplyQueue))
      (e.args.newSupplyQueue as string[]).forEach((x) => morphoIds.add(x))
    if (e.kind === 'v2adapter' && e.name === 'Submit') {
      const data = String(e.args.data)
      if (data.startsWith(ADAPTER_BURN_SELECTOR)) morphoIds.add('0x' + data.slice(10, 74))
    }
  }
  for (const b of baselines)
    if (kindOf.get(b.vault) === 'mm') b.ids.forEach((x) => morphoIds.add(x))
  for (const ids of marketIdsOfAdapter.values()) ids.forEach((x) => morphoIds.add(x))
  for (const d of Object.values(v2Ids)) if (d.type === 'market') morphoIds.add(d.market)
  const headQueue = new Map<string, string[]>()
  const exposureV1 = refreshExposure
    ? vaultsOf('mm').filter((a) => tvlOk(a, totalAssetsOf.get(a) ?? 0n))
    : []
  if (refreshExposure) {
    for (const q of await readQueues(
      exposureV1.map((vault) => ({ vault, which: 'withdraw' as const, block: toBlock })),
      kindOf,
    )) {
      headQueue.set(q.vault, q.ids)
      q.ids.forEach((x) => morphoIds.add(x))
    }
  }
  await resolveMarkets([...morphoIds], ent)
  for (const d of Object.values(v2Ids)) {
    if (d.type === 'market' && !ent.markets[d.market]) {
      const p = d.marketParams
      ent.markets[d.market] = {
        loan: p.loanToken,
        collateral: p.collateralToken,
        oracle: p.oracle,
        irm: p.irm,
        lltv: p.lltv.toString(),
      }
    }
  }
  for (const [adapter, ids] of marketIdsOfAdapter) {
    for (const mid of ids) {
      const m = ent.markets[mid]
      if (!m) continue
      const p = {
        loanToken: m.loan,
        collateralToken: m.collateral,
        oracle: m.oracle,
        irm: m.irm,
        lltv: BigInt(m.lltv),
      }
      v2Ids[v2IdOf(marketIdData(adapter, p))] = {
        type: 'market',
        adapter,
        marketParams: p,
        market: mid,
      }
    }
  }
  // V2 ids carried from earlier runs (cap ids seen before) keep mapping Allocate legs.
  for (const [id, d] of Object.entries(ent.v2Ids)) {
    if (v2Ids[id]) continue
    if (d.type === 'market' && d.market && ent.markets[d.market]) {
      const m = ent.markets[d.market]
      v2Ids[id] = {
        type: 'market',
        adapter: d.adapter ?? ZERO,
        market: d.market,
        marketParams: {
          loanToken: m.loan,
          collateralToken: m.collateral,
          oracle: m.oracle,
          irm: m.irm,
          lltv: BigInt(m.lltv),
        },
      }
    } else if (d.type === 'collateral' && d.collateral)
      v2Ids[id] = { type: 'collateral', collateral: d.collateral }
    else if (d.type === 'adapter' && d.adapter) v2Ids[id] = { type: 'adapter', adapter: d.adapter }
  }
  log(`${Object.keys(ent.markets).length} Morpho Blue markets known`)

  // ── Euler Earn strategies ──
  const eeQueue = new Map<string, string[]>()
  if (refreshExposure) {
    for (const q of await readQueues(
      vaultsOf('ee').map((vault) => ({ vault, which: 'withdraw' as const, block: toBlock })),
      kindOf,
    ))
      eeQueue.set(q.vault, q.ids)
  }
  await resolveStrategies(
    uniq([
      ...[...eeQueue.values()].flat(),
      ...events
        .filter((e) => e.kind === 'ee' && typeof e.args.id === 'string')
        .map((e) => String(e.args.id)),
    ]).filter((s) => !ent.strategies[s]),
    ent,
  )

  // ── classify, resuming the carried replay state ──
  const prevActions = prev?.feed.actions ?? []
  const ctx: ClassifyContext = {
    collateralOf: (_protocol, scope, target) => {
      if (scope === 'market') {
        const m = ent.markets[target]
        return m && m.collateral !== ZERO ? [lc(m.collateral)] : []
      }
      if (scope === 'strategy') return (ent.strategies[target]?.collateral ?? []).map(lc)
      return []
    },
    prevCap: (vault, target, block) => prevCapMap.get(`${vault}|${target}|${block}`),
    timelockAt,
    baselineSupplyQueue,
    baselineWithdrawQueue,
    v2Ids,
    publicAllocators: { mm: CHAIN.morphoPublicAllocator, ee: CHAIN.eulerPublicAllocator },
    isV2Allocator: (vault, sender) => (state.allocators[vault] ?? []).includes(sender),
    adapterParent: (adapter) => state.adapters[adapter],
  }
  const {
    actions: newActions,
    reallocations,
    stats,
    state: classifierState,
  } = classifyEvents(events, ctx, {
    state: state.classifier,
    actionsById: new Map(prevActions.map((a) => [a.id, a])),
  })
  state.classifier = classifierState
  for (const a of newActions)
    if (a.protocol !== 'aave-v3' && !a.loan) a.loan = ent.vaults[a.vault]?.asset
  let actions: FeedAction[] = [...prevActions, ...newActions]
  log(
    `actions: ${newActions.length} new (${prevActions.length} carried); reallocation legs ${reallocations.length}; ${JSON.stringify(stats)}`,
  )

  // ── head reads of every still-open V1 / Euler Earn submit ──
  const openSubs = actions.filter(needsHeadRead)
  const subRes = await rpc.batch(
    openSubs.map((a) => {
      const idSig = a.protocol === 'morpho-v1' ? 'bytes32' : 'address'
      if (a.kind === 'cap_submit')
        return call(a.vault, `pendingCap(${idSig})`, [a.target ?? ''], toBlock)
      if (a.kind === 'removal_submit')
        return call(a.vault, `config(${idSig})`, [a.target ?? ''], toBlock)
      if (a.kind === 'timelock_submit') return call(a.vault, 'pendingTimelock()', [], toBlock)
      return call(a.vault, 'pendingGuardian()', [], toBlock)
    }),
  )
  const heads: Record<string, number> = {}
  openSubs.forEach((a, i) => {
    const r = subRes[i]
    if (!r) return
    if (a.kind === 'removal_submit') {
      const w = dec(
        a.protocol === 'morpho-v1'
          ? ['uint256', 'bool', 'uint256']
          : ['uint256', 'uint256', 'bool', 'uint256'],
        r,
      )
      if (w) heads[headKey(a)] = Number(w[w.length - 1] as bigint)
      return
    }
    const w = dec(['uint256', 'uint256'], r)
    if (w) heads[headKey(a)] = Number(w[1] as bigint)
  })
  const clearedOnChain = applyHeadPending(actions, heads)
  log(
    `head reads: ${openSubs.length} open submits, ${clearedOnChain} cleared on chain without a collected event`,
  )

  // ── exit context + write-off size (new exits only) ──
  await exitContext(newActions, kindOf, ctx, adaptersOf, v2Ids, ent)

  // ── tokens: every address we may render; prices refreshed every run ──
  const tokenAddrs = uniq(
    [
      ...Object.values(ent.vaults).map((v) => v.asset),
      ...Object.values(ent.markets).flatMap((m) => [m.loan, m.collateral]),
      ...Object.values(ent.strategies).flatMap((s) => [s.asset, ...s.collateral]),
      ...actions.flatMap((a) => a.collateral),
      ...Object.values(v2Ids).flatMap((d) => (d.type === 'collateral' ? [d.collateral] : [])),
    ]
      .filter((x) => x && x !== ZERO)
      .map(lc),
  )
  await resolveTokens(tokenAddrs, ent)
  const exitTokens = uniq(
    newActions
      .filter((a) => EXIT_KINDS.has(a.kind) && a.collateral.length === 1)
      .map((a) => lc(a.collateral[0])),
  ).filter((t) => ent.tokens[t] && ent.tokens[t].expiry === undefined)
  const expRes = await rpc.batch(exitTokens.map((t) => call(t, 'expiry()')))
  exitTokens.forEach((t, i) => {
    const e = word(expRes[i])
    if (e !== undefined && e > 1_500_000_000n && e < 4_000_000_000n)
      ent.tokens[t].expiry = Number(e)
  })
  const usd = (token: string | undefined, amount: bigint): number | undefined => {
    const t = token ? ent.tokens[lc(token)] : undefined
    if (!t?.priceUsd) return undefined
    return (Number(amount) / 10 ** t.decimals) * t.priceUsd
  }

  // ── flows: this run's legs merged onto the carried days ──
  const netted = netPerTx(reallocations)
  const newFlows = toUnitFlows(
    aggregateDaily(netted),
    (vault) => ent.tokens[ent.vaults[vault]?.asset ?? '']?.decimals ?? 18,
  )
  const flows = trimFlows(mergeUnitFlows(prev?.flows ?? [], newFlows), windowFromTs)
  log(
    `flows: ${netted.length} netted legs → ${newFlows.length} new daily rows; ${flows.length} rows kept`,
  )

  // ── exposure ──
  let exposure: ExposureFile
  if (refreshExposure) {
    exposure = await readExposure(
      toBlock,
      toTs,
      headQueue,
      eeQueue,
      adaptersOf,
      adapterKind,
      marketIdsOfAdapter,
      totalAssetsOf,
      vaultsOf('v2').filter((a) => tvlOk(a, totalAssetsOf.get(a) ?? 0n)),
      ent,
      usd,
      lostAssetsOf,
    )
    state.exposureBlock = toBlock
    log(`exposure: ${exposure.vaults.length} vaults at block ${toBlock}`)
  } else {
    exposure = prev!.exposure
    log(`exposure: kept the snapshot from block ${exposure.block}`)
  }

  // ── attribution (withdrawal-first) ──
  const loanOfTarget = (r: Reallocation) =>
    ent.markets[r.target]?.loan ?? ent.vaults[r.vault]?.asset
  const cases = selectLargeWithdrawals(
    reallocations,
    (l) => usd(loanOfTarget(l), l.assets),
    (t) => Boolean(ent.markets[t]),
    LARGE_WITHDRAW_USD,
  )
  const keptCases = await readAttribution(cases, ent)
  log(`attribution: kept ${keptCases.length} of ${cases.length} candidates`)

  // ── spikes (spike-first) ──
  const universe = new Set<string>([
    ...actions
      .filter((a) => a.scope === 'market' && a.target && ent.markets[a.target])
      .map((a) => a.target!),
    ...netted.map((l) => l.target).filter((t) => ent.markets[t]),
    ...exposure.vaults
      .flatMap((v) => v.allocations.map((x) => x.target))
      .filter((t) => ent.markets[t]),
    ...[...marketIdsOfAdapter.values()].flat(),
    ...Object.values(state.classifier.withdrawQ)
      .flat()
      .filter((t) => ent.markets[t]),
  ])
  const spikes = await readSpikes(
    universe,
    fromBlock,
    toBlock,
    state,
    reallocations,
    kindOf,
    ent,
    usd,
  )
  log(`spikes: ${spikes.length} kept`)

  // ── flags 1, 2, 4, 5: oracle kind, reverting / stale, largest borrower, supply locked ──
  const marketFlags = await readMarketFlags([...universe], {
    head: toBlock,
    headTs: toTs,
    windowFrom,
    windowFromTs,
    refreshBorrowers: refreshExposure || !state.borrowers,
    state,
    ent,
    usd,
  })

  // ── merge, roll the window, prune, write ──
  const merged = trimFeed(
    {
      entities: ent,
      actions,
      attribution: [...(prev?.feed.attribution ?? []), ...keptCases],
      spikes: [...(prev?.feed.spikes ?? []), ...spikes],
    },
    windowFrom,
  )
  actions = merged.feed.actions
  if (merged.dropped.actions || merged.dropped.attribution || merged.dropped.spikes)
    log(`window: dropped ${JSON.stringify(merged.dropped)} from before block ${windowFrom}`)
  await ensureVaultInfo(
    uniq([
      ...actions.map((a) => a.vault),
      ...merged.feed.spikes.flatMap((s) =>
        s.flows.map((f) => f.vault).filter((x): x is string => Boolean(x)),
      ),
      ...merged.feed.attribution.flatMap((c) => c.legs.map((l) => l.vault)),
    ]).filter(
      (a) => !ent.vaults[a] && !CHAIN.aave[a] && ['mm', 'v2', 'ee'].includes(kindOf.get(a) ?? ''),
    ),
    kindOf,
    adaptersOf,
    adapterKind,
    ent,
    toBlock,
  )
  // ── flag 3: curator shifts between its own vaults, followed by cuts ──
  const shifts = detectShifts(flows, actions, {
    curatorOf: (v) => ent.vaults[v]?.curatorKey || v,
    collateralOf: (t) => {
      const m = ent.markets[t]
      return m && m.collateral !== ZERO ? lc(m.collateral) : undefined
    },
    usd: (t, amount) => {
      const tok = ent.tokens[lc(ent.markets[t]?.loan ?? '')]
      return tok?.priceUsd !== undefined ? amount * tok.priceUsd : undefined
    },
  })
  const flags: FeedFlags = { block: toBlock, ts: toTs, markets: marketFlags, shifts }
  const flagCounts: Record<string, number> = { flagShifts: shifts.length }
  for (const [m, f] of Object.entries(marketFlags)) {
    const w = ent.markets[m]
    for (const k of marketFlagKinds(
      f,
      w ? usd(w.loan, BigInt(f.borrowers?.totalBorrow ?? '0')) : undefined,
    ))
      flagCounts[`flag:${k}`] = (flagCounts[`flag:${k}`] ?? 0) + 1
  }
  log(`flags: ${JSON.stringify(flagCounts)}`)
  const entities = prune(
    ent,
    actions,
    flows,
    exposure,
    merged.feed.attribution,
    merged.feed.spikes,
    v2Ids,
    flags,
  )
  state.kinds = Object.fromEntries(kindOf)
  state.toBlock = toBlock
  state.fromBlock = windowFrom

  const meta: FeedMeta = {
    schema: SCHEMA,
    chainId: 1,
    fromBlock: windowFrom,
    toBlock,
    fromTs: windowFromTs,
    toTs,
    collectedAt: new Date().toISOString(),
    endpoints: rpc.endpoints.map((e) => e.label),
    // Cumulative since the last full run: the page states how the WHOLE dataset was read.
    logs: prev ? addLogStats(prev.feed.meta.logs, rpc.logStats) : rpc.logStats,
    counts: {
      actions: actions.length,
      newActions: newActions.length,
      flowRows: flows.length,
      exposureVaults: exposure.vaults.length,
      attributionCases: merged.feed.attribution.length,
      spikeCases: merged.feed.spikes.length,
      verifiedMetaMorpho: vaultsOf('mm').length,
      verifiedVaultV2: vaultsOf('v2').length,
      verifiedV2Adapters: vaultsOf('v2adapter').length,
      verifiedEulerEarn: vaultsOf('ee').length,
      unverifiedEmittersDropped: unverified.length,
      malformedLogs: malformed,
      openButClearedOnChain: clearedOnChain,
      rpcCalls: rpc.calls,
      ...stats,
      ...flagCounts,
    },
    thresholds: {
      largeWithdrawUsd: LARGE_WITHDRAW_USD,
      exposureMinUsd: EXPOSURE_MIN_USD,
      keptSupplyDrop: KEPT_SUPPLY_DROP,
      spikeMinSupplyUsd: SPIKE_MIN_SUPPLY_USD,
      flags: FLAG_DEFAULTS,
    },
    lastRun: {
      mode,
      fromBlock,
      toBlock,
      startedAt,
      minutes: Number(((Date.now() - t0) / 60000).toFixed(1)),
    },
    sources: [
      'Ethereum mainnet logs and eth_call (archive) — events listed in lib/curatorFeed/abi.ts',
      'Morpho API (blue-api.morpho.org): vault list, curator registry names, USD prices at collection time',
      'Euler labels (github.com/euler-xyz/euler-labels 1/entities.json): Euler curator names',
    ],
    caveats: CAVEATS,
  }
  const feed: FeedFile = {
    meta,
    entities,
    actions,
    attribution: merged.feed.attribution,
    spikes: merged.feed.spikes,
    flags,
  }

  const dirs: [string, string][] = [
    ['.data/curator-feed', liveDir()],
    ...(PUBLISH ? [['datasets/curator-feed', seedDir()] as [string, string]] : []),
  ]
  for (const [rel, dir] of dirs) {
    mkdirSync(dir, { recursive: true })
    const write = (name: string, obj: unknown) => {
      const s = JSON.stringify(obj) + '\n'
      // Write-then-rename: the API never reads a half-written file.
      writeFileSync(join(dir, `${name}.tmp`), s)
      renameSync(join(dir, `${name}.tmp`), join(dir, name))
      return s.length
    }
    const sizes = {
      feed: write('feed.json', encodeFeedFile(feed)),
      flows: write('flows.json', encodeUnitFlows(flows, toBlock)),
      exposure: write('exposure.json', exposure),
      state: write('state.json', encodeStateFile(state)),
    }
    log(
      `wrote ${rel}: ${Object.entries(sizes)
        .map(([k, v]) => `${k} ${(v / 1e6).toFixed(2)} MB`)
        .join(', ')}`,
    )
    if (rel.startsWith('datasets/')) writeProvenance(dir, meta)
  }
  log(
    `done in ${((Date.now() - t0) / 60000).toFixed(1)} min; getLogs ${JSON.stringify(rpc.logStats)}`,
  )
}

const CAVEATS = [
  'USD figures use prices at collection time, not at the time of each action.',
  'Curator identity is the vault’s CURRENT curator (or owner when no curator is set), named via the registries above; an unnamed curator is shown by address.',
  'Vault V2 allocator moves are Allocate/Deallocate events whose sender was ever set as an allocator of that vault; deposit-path allocations are excluded.',
  'Public Allocator reallocations are MetaMorpho / Euler Earn reallocation legs whose caller is the Public Allocator contract.',
  'A submitted change that was executed in the same transaction (zero timelock) is shown once, as the executed change; the vault’s zero-timelock functions are listed on its rows.',
  'Vault V2 market adapters keep their own timelocks; a write-off (burnShares) removes a market position from the vault’s books and is counted as an exit.',
  'Attribution compares market state at the end of block b−1 and block b; other transactions in block b are included in the difference. Kept: net vault withdrawals ≥ $1M in a block that cut market supply by ≥ 20%, spiked the borrow rate (≥ 1.5× and ≥ +2 APR points), or left utilization ≥ 99%.',
  'Rate spikes come from consecutive Morpho Blue AccrueInterest logs on markets curated vaults use (≥ 1.5× and ≥ +2 APR points, market supply ≥ $1M). Driver shares are first-order utilization effects at the state before the block (≈).',
  'Daily flows are netted per transaction and stored in whole loan-token units rounded to 6 significant digits.',
  'Exposure lists vaults with at least $100k (Morpho API TVL, or on-chain total assets when the API has no figure); it is refreshed every few hours, not every run.',
  'Euler Earn strategies can accept several collaterals; their exits are listed but not counted in collateral clusters.',
  'A cluster counts an exit only when the vault kept no other market with that collateral capped, read at the exit block; PT exits within 14 days of maturity are excluded as roll-offs.',
  'Flags: an oracle is "reported-value" when every input is a feed whose description names a fundamental / NAV / exchange-rate value, or a vault rate into another token; "fixed-price" when it has no input. Oracles of other types are not classified.',
  'Flags: the largest borrowers are ranked by the Morpho API and their debt read on chain (top two per market, with each exposure read); a curator shift uses daily net flows, so moves inside one day net out.',
]

/** PROVENANCE.md for the datasets-repo copy (format of triccs/membrane-datasets README). */
function writeProvenance(dir: string, meta: FeedMeta): void {
  const git = (cmd: string) => {
    try {
      return execSync(`git ${cmd}`, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim()
    } catch {
      return 'unknown'
    }
  }
  const rows = ['exposure.json', 'feed.json', 'flows.json', 'state.json'].map((f) => {
    const buf = readFileSync(join(dir, f))
    return `| \`${f}\` | ${buf.length} | \`${createHash('sha256').update(buf).digest('hex')}\` |`
  })
  const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ')
  const text = [
    '# curator-feed — provenance',
    '',
    `- **Source:** \`The-Membrane/membrane-app\` branch \`${git('rev-parse --abbrev-ref HEAD')}\` at \`${git('rev-parse HEAD')}\`, written by \`scripts/collect-curator-feed.ts --publish\``,
    `- **Collected:** ${meta.collectedAt} (${meta.lastRun?.mode ?? 'full'} run)`,
    `- **Window:** Ethereum mainnet blocks ${meta.fromBlock}–${meta.toBlock} (${day(meta.fromTs)} → ${day(meta.toTs)} UTC, finalized head)`,
    '- **Status:** CANONICAL. membrane-app reads it here ($MEMBRANE_DATASETS_DIR or ../membrane-datasets) and keeps no copy in `public/` (board rule N18).',
    '- **Format:** `lib/curatorFeed/store.ts` (schema ' +
      meta.schema +
      '); method: `docs/CURATOR_ACTION_FEED.md`.',
    '',
    '| file | bytes | sha256 |',
    '|---|---:|---|',
    ...rows,
    '',
  ].join('\n')
  writeFileSync(join(dir, 'PROVENANCE.md'), text)
  log(`wrote ${join('datasets/curator-feed', 'PROVENANCE.md')}`)
}

function addLogStats(a: FeedMeta['logs'], b: FeedMeta['logs']): FeedMeta['logs'] {
  const sum = (x: Record<string, number>, y: Record<string, number>) => {
    const out = { ...x }
    for (const [k, v] of Object.entries(y)) out[k] = (out[k] ?? 0) + v
    return out
  }
  return {
    chunks: a.chunks + b.chunks,
    rechecked: a.rechecked + b.rechecked,
    disagreements: a.disagreements + b.disagreements,
    recovered: a.recovered + b.recovered,
    emptyConfirmed: a.emptyConfirmed + b.emptyConfirmed,
    servedBy: sum(a.servedBy, b.servedBy),
    shortBy: sum(a.shortBy, b.shortBy),
  }
}

// ── reads ──────────────────────────────────────────────────────────────────────

async function fillTimestamps(tsOf: Map<number, number>, blocks: number[]): Promise<void> {
  const missing = blocks.filter((b) => !tsOf.has(b))
  if (!missing.length) return
  log(`fetching ${missing.length} block timestamps`)
  const hdrs = await rpc.batch(
    missing.map((b) => ({ method: 'eth_getBlockByNumber', params: [hexN(b), false] })),
  )
  missing.forEach(
    (b, i) => hdrs[i] && tsOf.set(b, parseInt((hdrs[i] as { timestamp: string }).timestamp, 16)),
  )
}

/** name / asset / curator / owner / timelock(s) / totalAssets at the head, into ent.vaults. */
async function readVaultInfo(
  targets: string[],
  kindOf: Map<string, EmitterKind>,
  adaptersOf: Map<string, string[]>,
  adapterKind: Map<string, { kind: string }>,
  ent: Entities,
  block: number,
  lostOf?: Map<string, bigint>,
): Promise<Map<string, bigint>> {
  const res = await rpc.batch(
    targets.flatMap((a) => [
      call(a, 'name()', [], block),
      call(a, 'asset()', [], block),
      call(a, 'curator()', [], block),
      call(a, 'owner()', [], block),
      kindOf.get(a) === 'v2'
        ? call(a, 'adaptersLength()', [], block)
        : call(a, 'timelock()', [], block),
      call(a, 'totalAssets()', [], block),
    ]),
  )
  const totals = new Map<string, bigint>()
  targets.forEach((a, i) => {
    const r = res.slice(i * 6, i * 6 + 6)
    const k = kindOf.get(a)
    const protocol: Protocol = k === 'mm' ? 'morpho-v1' : k === 'v2' ? 'morpho-v2' : 'euler-earn'
    const old = ent.vaults[a]
    ent.vaults[a] = {
      protocol,
      name: (dec(['string'], r[0])?.[0] as string | undefined) ?? old?.name ?? a,
      asset: lc(addrOf(r[1]) ?? old?.asset ?? ZERO),
      curator: (dec(['address'], r[2])?.[0] as string | undefined) ?? old?.curator,
      owner: (dec(['address'], r[3])?.[0] as string | undefined) ?? old?.owner,
      curatorKey: old?.curatorKey ?? '',
      timelock: k === 'v2' ? undefined : Number(word(r[4]) ?? BigInt(old?.timelock ?? 0)),
      timelocks: old?.timelocks,
    }
    totals.set(a, word(r[5]) ?? 0n)
  })
  // MetaMorpho v1.1 counts written-off assets in totalAssets(); lostAssets() says how much
  // (v1.0 has no such getter: the batch answers null).
  if (lostOf) {
    const mm = targets.filter((a) => kindOf.get(a) === 'mm')
    const lost = await rpc.batch(mm.map((a) => call(a, 'lostAssets()', [], block)))
    mm.forEach((a, i) => {
      const w = word(lost[i])
      if (w !== undefined && w > 0n) lostOf.set(a, w)
      else lostOf.delete(a)
    })
  }
  // Vault V2: per-function timelocks, and the market adapter's burnShares timelock.
  const v2 = targets.filter((a) => kindOf.get(a) === 'v2')
  const tl = await rpc.batch(
    v2.flatMap((a) => [
      ...V2_TIMELOCK_FNS.map(([s]) =>
        rawCall(a, sel('timelock(bytes4)') + s.slice(2).padEnd(64, '0'), block),
      ),
      ...(adaptersOf.get(a) ?? [])
        .filter((ad) => adapterKind.get(ad)?.kind === 'market')
        .slice(0, 1)
        .map((ad) =>
          rawCall(
            ad,
            sel('timelock(bytes4)') + ADAPTER_BURN_SELECTOR.slice(2).padEnd(64, '0'),
            block,
          ),
        ),
    ]),
  )
  let k = 0
  for (const a of v2) {
    const t: Record<string, number> = {}
    for (const [, name] of V2_TIMELOCK_FNS) {
      const v = word(tl[k++])
      if (v !== undefined) t[name] = Number(v)
    }
    const hasMarketAdapter = (adaptersOf.get(a) ?? []).some(
      (ad) => adapterKind.get(ad)?.kind === 'market',
    )
    if (hasMarketAdapter) {
      const v = word(tl[k++])
      if (v !== undefined) t['adapter.burnShares'] = Number(v)
    }
    ent.vaults[a].timelocks = t
  }
  return totals
}

async function ensureVaultInfo(
  missing: string[],
  kindOf: Map<string, EmitterKind>,
  adaptersOf: Map<string, string[]>,
  adapterKind: Map<string, { kind: string }>,
  ent: Entities,
  block: number,
): Promise<void> {
  if (!missing.length) return
  await readVaultInfo(missing, kindOf, adaptersOf, adapterKind, ent, block)
  for (const a of missing) {
    const v = ent.vaults[a]
    if (!v || v.curatorKey) continue
    const addr = v.curator && v.curator !== ZERO ? lc(v.curator) : lc(v.owner ?? a)
    ent.curators[addr] = ent.curators[addr] ?? { name: addr, source: 'address' }
    v.curatorKey = addr
  }
}

/** Withdraw / supply queues at a block; EE ids are addresses, MetaMorpho ids bytes32. */
async function readQueues(
  qs: { vault: string; which: 'supply' | 'withdraw'; block: number }[],
  kindOf: Map<string, EmitterKind>,
): Promise<{ vault: string; which: 'supply' | 'withdraw'; block: number; ids: string[] }[]> {
  const lens = await rpc.batch(qs.map((q) => call(q.vault, `${q.which}QueueLength()`, [], q.block)))
  const items: { q: number; i: number }[] = []
  qs.forEach((_, qi) => {
    const n = Number(word(lens[qi]) ?? -1n)
    for (let j = 0; j < Math.min(n, 64); j++) items.push({ q: qi, i: j })
  })
  const res = await rpc.batch(
    items.map(({ q, i }) =>
      call(qs[q].vault, `${qs[q].which}Queue(uint256)`, [BigInt(i)], qs[q].block),
    ),
  )
  const out: { vault: string; which: 'supply' | 'withdraw'; block: number; ids: string[] }[] = []
  qs.forEach((q, qi) => {
    const n = Number(word(lens[qi]) ?? -1n)
    if (n < 0) return
    const mine = items.map((it, j) => ({ it, r: res[j] })).filter(({ it }) => it.q === qi)
    if (mine.some(({ r }) => !r)) return
    const ee = kindOf.get(q.vault) === 'ee'
    out.push({
      vault: q.vault,
      which: q.which,
      block: q.block,
      ids: mine.map(({ r }) => {
        const w = lc((r as string).slice(0, 66))
        return ee ? '0x' + w.slice(-40) : w
      }),
    })
  })
  return out
}

async function resolveMarkets(ids: string[], ent: Entities): Promise<void> {
  const need = ids.filter((id) => !ent.markets[id])
  const res = await rpc.batch(
    need.map((id) => call(CHAIN.morpho, 'idToMarketParams(bytes32)', [id])),
  )
  need.forEach((id, i) => {
    const w = dec(['address', 'address', 'address', 'address', 'uint256'], res[i])
    if (w && w[0] !== ZERO)
      ent.markets[id] = {
        loan: w[0] as string,
        collateral: w[1] as string,
        oracle: w[2] as string,
        irm: w[3] as string,
        lltv: String(w[4]),
      }
  })
}

async function resolveStrategies(strats: string[], ent: Entities): Promise<void> {
  const res = await rpc.batch(
    strats.flatMap((s) => [call(s, 'name()'), call(s, 'asset()'), call(s, 'LTVList()')]),
  )
  const coll = new Map<string, string[]>()
  strats.forEach((s, i) => {
    coll.set(s, ((dec(['address[]'], res[i * 3 + 2])?.[0] as string[] | undefined) ?? []).map(lc))
    ent.strategies[s] = {
      name: (dec(['string'], res[i * 3])?.[0] as string | undefined) ?? s,
      asset: lc(addrOf(res[i * 3 + 1]) ?? ZERO),
      collateral: [],
    }
  })
  const cvs = uniq([...coll.values()].flat())
  const cvRes = await rpc.batch(cvs.map((c) => call(c, 'asset()')))
  const asset = new Map<string, string>()
  cvs.forEach((c, i) => {
    const a = addrOf(cvRes[i])
    if (a) asset.set(c, lc(a))
  })
  for (const [s, list] of coll)
    ent.strategies[s].collateral = uniq(
      list.map((c) => asset.get(c)).filter((x): x is string => Boolean(x)),
    )
}

async function resolveTokens(addrs: string[], ent: Entities): Promise<void> {
  const need = addrs.filter((t) => !ent.tokens[t])
  const res = await rpc.batch(need.flatMap((t) => [call(t, 'symbol()'), call(t, 'decimals()')]))
  need.forEach((t, i) => {
    let symbol = dec(['string'], res[i * 2])?.[0] as string | undefined
    const raw = res[i * 2] as string | null
    if (symbol === undefined && raw && raw.length === 66) {
      symbol = new TextDecoder().decode(
        Uint8Array.from(
          (raw.slice(2).match(/../g) ?? []).map((b) => parseInt(b, 16)).filter((b) => b !== 0),
        ),
      )
    }
    ent.tokens[t] = {
      symbol: symbol ?? t.slice(0, 8),
      decimals: Number(word(res[i * 2 + 1]) ?? 18n),
    }
  })
  // The Morpho API rejects address_in lists longer than 100 (measured 2026-10-07).
  for (const grp of chunked(addrs, 100)) {
    const d = await gql<{
      assets: { items: { address: string; price: { usd: number | null } | null }[] }
    }>(
      `{ assets(first: 500, where: { chainId_in: [${CHAIN.morphoApiChainId}], address_in: [${grp.map((a) => `"${a}"`).join(',')}] }) { items { address price { usd } } } }`,
    )
    for (const it of d?.assets.items ?? [])
      if (ent.tokens[lc(it.address)] && it.price?.usd != null)
        ent.tokens[lc(it.address)].priceUsd = it.price.usd
  }
}

/**
 * For each new exit, read what the vault still had capped in that collateral at the exit
 * block (stillCapped), and for each new write-off the position size it dropped.
 */
async function exitContext(
  newActions: FeedAction[],
  kindOf: Map<string, EmitterKind>,
  ctx: ClassifyContext,
  adaptersOf: Map<string, string[]>,
  v2Ids: Record<string, V2IdData>,
  ent: Entities,
): Promise<void> {
  const exits = newActions.filter(
    (a) => EXIT_KINDS.has(a.kind) && a.collateral.length === 1 && a.protocol !== 'aave-v3',
  )
  const v1Exits = exits.filter((a) => a.protocol !== 'morpho-v2')
  const qs = uniq(v1Exits.map((a) => `${a.vault}|${a.block}`)).map((k) => ({
    vault: k.split('|')[0],
    which: 'withdraw' as const,
    block: Number(k.split('|')[1]),
  }))
  const items = new Map((await readQueues(qs, kindOf)).map((q) => [`${q.vault}|${q.block}`, q.ids]))
  await resolveMarkets(
    uniq(
      [...items.entries()]
        .filter(([k]) => kindOf.get(k.split('|')[0]) === 'mm')
        .flatMap(([, ids]) => ids),
    ),
    ent,
  )
  const capCalls = [...items.entries()].flatMap(([key, ids]) => ids.map((id) => ({ key, id })))
  const capRes = await rpc.batch(
    capCalls.map(({ key, id }) => {
      const [vault, block] = key.split('|')
      return call(
        vault,
        kindOf.get(vault) === 'ee' ? 'config(address)' : 'config(bytes32)',
        [id],
        Number(block),
      )
    }),
  )
  const capAt = new Map<string, bigint>()
  capCalls.forEach(({ key, id }, j) => {
    const ee = kindOf.get(key.split('|')[0]) === 'ee'
    const w = dec(
      ee ? ['uint256', 'uint256', 'bool', 'uint256'] : ['uint256', 'bool', 'uint256'],
      capRes[j],
    )
    if (w) capAt.set(`${key}|${id}`, (ee ? w[1] : w[0]) as bigint)
  })
  for (const a of v1Exits) {
    const key = `${a.vault}|${a.block}`
    const ids = items.get(key)
    if (!ids) continue
    const c = lc(a.collateral[0])
    const others = ids.filter(
      (id) =>
        id !== a.target &&
        ctx
          .collateralOf(a.protocol, a.protocol === 'euler-earn' ? 'strategy' : 'market', id)
          .map(lc)
          .includes(c),
    )
    if (others.some((id) => !capAt.has(`${key}|${id}`))) continue
    a.stillCapped = others.some((id) => (capAt.get(`${key}|${id}`) ?? 0n) > 0n)
  }
  // Vault V2 (cap exits and adapter write-offs).
  const v2Exits = exits.filter((a) => a.protocol === 'morpho-v2')
  const v2Calls = v2Exits.map((a) => {
    const c = lc(a.collateral[0])
    const mine = new Set(adaptersOf.get(a.vault) ?? [])
    // A write-off's target is the Morpho market id; a cap exit's target is the cap id.
    const self = a.kind === 'writeoff' || a.kind === 'writeoff_submit' ? a.target : undefined
    const marketIds = Object.entries(v2Ids)
      .filter(
        ([id, d]) =>
          d.type === 'market' &&
          mine.has(d.adapter) &&
          lc(d.marketParams.collateralToken) === c &&
          id !== a.target &&
          d.market !== self,
      )
      .map(([id]) => id)
    return { a, ids: [v2IdOf(collateralIdData(c)), ...marketIds] }
  })
  const v2Res = await rpc.batch(
    v2Calls.flatMap(({ a, ids }) =>
      ids.flatMap((id) => [
        call(a.vault, 'absoluteCap(bytes32)', [id], a.block),
        call(a.vault, 'relativeCap(bytes32)', [id], a.block),
      ]),
    ),
  )
  let k = 0
  for (const { a, ids } of v2Calls) {
    const open = ids.map(() => {
      const abs = word(v2Res[k++])
      const rel = word(v2Res[k++])
      return abs === undefined || rel === undefined ? undefined : abs > 0n && rel > 0n
    })
    if (open.some((x) => x === undefined)) continue
    a.stillCapped =
      a.scope === 'collateral' ? false : Boolean(open[0]) && open.slice(1).some(Boolean)
  }
  // Write-off size: shares priced at the end of the block before.
  const wos = newActions.filter((a) => a.kind === 'writeoff' && a.target && a.to)
  const mres = await rpc.batch(
    wos.map((a) => call(CHAIN.morpho, 'market(bytes32)', [a.target!], a.block - 1)),
  )
  wos.forEach((a, i) => {
    const w = dec(MARKET6, mres[i]) as bigint[] | null
    if (w) a.assets = toAssetsDown(BigInt(a.to!), w[0], w[1]).toString()
  })
  log(
    `exit context: ${exits.length} new exits; ${exits.filter((a) => a.stillCapped === true).length} still capped elsewhere, ${exits.filter((a) => a.stillCapped === false).length} last cap, ${exits.filter((a) => a.stillCapped === undefined).length} unread; ${wos.length} write-offs`,
  )
}

/** Exposure at the head: V1 queues × positions, V2 adapters (look-through), Euler strategies. */
async function readExposure(
  block: number,
  ts: number,
  headQueue: Map<string, string[]>,
  eeQueue: Map<string, string[]>,
  adaptersOf: Map<string, string[]>,
  adapterKind: Map<
    string,
    { kind: 'market' | 'vault' | 'other'; n?: number; v1?: string; real?: bigint }
  >,
  marketIdsOfAdapter: Map<string, string[]>,
  totalAssetsOf: Map<string, bigint>,
  v2Exposure: string[],
  ent: Entities,
  usd: (token: string | undefined, amount: bigint) => number | undefined,
  lostAssetsOf: Map<string, bigint> = new Map(),
): Promise<ExposureFile> {
  const vaults: ExposureVault[] = []
  const collOf = (id: string) => {
    const m = ent.markets[id]
    return m && m.collateral !== ZERO ? [lc(m.collateral)] : []
  }
  const finish = (vault: string, protocol: Protocol, allocs: ExposureAlloc[], total: bigint) => {
    const sum = allocs.reduce((s, a) => s + BigInt(a.assets), 0n)
    const den = total > sum ? total : sum
    for (const a of allocs)
      a.share = den === 0n ? 0 : Number((BigInt(a.assets) * 1_000_000n) / den) / 1e6
    const lost = lostAssetsOf.get(vault)
    vaults.push({
      vault,
      protocol,
      totalAssets: total.toString(),
      totalUsd: usd(ent.vaults[vault]?.asset, total),
      ...(lost ? { lostAssets: lost.toString() } : {}),
      allocations: allocs
        .filter((a) => BigInt(a.assets) > 0n)
        .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0)),
    })
  }
  // MetaMorpho
  const v1Pairs = [...headQueue.entries()].flatMap(([vault, ids]) =>
    ids.map((id) => ({ vault, id })),
  )
  const posRes = await rpc.batch(
    v1Pairs.flatMap(({ vault, id }) => [
      call(CHAIN.morpho, 'position(bytes32,address)', [id, vault], block),
      call(vault, 'config(bytes32)', [id], block),
    ]),
  )
  const mktIds = uniq(v1Pairs.map((p) => p.id))
  const mktRes = await rpc.batch(
    mktIds.map((id) => call(CHAIN.morpho, 'market(bytes32)', [id], block)),
  )
  const mkt = new Map<string, bigint[]>()
  mktIds.forEach((id, i) => {
    const w = dec(MARKET6, mktRes[i]) as bigint[] | null
    if (w) mkt.set(id, w)
  })
  const v1Alloc = new Map<string, ExposureAlloc[]>()
  v1Pairs.forEach(({ vault, id }, i) => {
    const pos = dec(['uint256', 'uint256', 'uint256'], posRes[i * 2])
    const cfg = dec(['uint256', 'bool', 'uint256'], posRes[i * 2 + 1])
    const st = mkt.get(id)
    if (!pos || !st) return
    const assets = toAssetsDown(pos[0] as bigint, st[0], st[1])
    v1Alloc.set(vault, [
      ...(v1Alloc.get(vault) ?? []),
      {
        target: id,
        scope: 'market',
        collateral: collOf(id),
        assets: assets.toString(),
        usd: usd(ent.markets[id]?.loan, assets),
        share: 0,
        cap: cfg ? String(cfg[0]) : undefined,
      },
    ])
  })
  for (const [vault, allocs] of v1Alloc)
    finish(vault, 'morpho-v1', allocs, totalAssetsOf.get(vault) ?? 0n)
  // Vault V2
  const v2Calls = v2Exposure.flatMap((vault) =>
    (adaptersOf.get(vault) ?? [])
      .filter((a) => adapterKind.get(a)?.kind === 'market')
      .flatMap((adapter) =>
        (marketIdsOfAdapter.get(adapter) ?? []).map((id) => ({ vault, adapter, id })),
      ),
  )
  const v2Res = await rpc.batch(
    v2Calls.map(({ adapter, id }) => call(adapter, 'expectedSupplyAssets(bytes32)', [id], block)),
  )
  const v2Alloc = new Map<string, ExposureAlloc[]>()
  v2Calls.forEach(({ vault, adapter, id }, i) => {
    const assets = word(v2Res[i]) ?? 0n
    v2Alloc.set(vault, [
      ...(v2Alloc.get(vault) ?? []),
      {
        target: id,
        scope: 'market',
        collateral: collOf(id),
        assets: assets.toString(),
        usd: usd(ent.markets[id]?.loan, assets),
        share: 0,
        via: adapter,
      },
    ])
  })
  for (const vault of v2Exposure) {
    for (const adapter of adaptersOf.get(vault) ?? []) {
      const k = adapterKind.get(adapter)
      if (k?.kind !== 'vault' || !k.v1 || !k.real) continue
      const inner = vaults.find((x) => x.vault === k.v1)
      const innerTotal = inner ? BigInt(inner.totalAssets) : 0n
      if (!inner || innerTotal === 0n) {
        v2Alloc.set(vault, [
          ...(v2Alloc.get(vault) ?? []),
          {
            target: k.v1,
            scope: 'market',
            collateral: [],
            assets: k.real.toString(),
            usd: usd(ent.vaults[vault]?.asset, k.real),
            share: 0,
            via: adapter,
          },
        ])
        continue
      }
      for (const a of inner.allocations) {
        const part = (BigInt(a.assets) * k.real) / innerTotal
        v2Alloc.set(vault, [
          ...(v2Alloc.get(vault) ?? []),
          {
            ...a,
            assets: part.toString(),
            usd: usd(ent.vaults[vault]?.asset, part),
            share: 0,
            via: k.v1,
            cap: undefined,
          },
        ])
      }
    }
  }
  for (const vault of v2Exposure)
    finish(vault, 'morpho-v2', v2Alloc.get(vault) ?? [], totalAssetsOf.get(vault) ?? 0n)
  // Euler Earn
  const eePairs = [...eeQueue.entries()].flatMap(([vault, ss]) => ss.map((s) => ({ vault, s })))
  const eeCfg = await rpc.batch(
    eePairs.map(({ vault, s }) => call(vault, 'config(address)', [s], block)),
  )
  const eeConv = await rpc.batch(
    eePairs.map(({ s }, i) =>
      call(
        s,
        'convertToAssets(uint256)',
        [
          (dec(['uint256', 'uint256', 'bool', 'uint256'], eeCfg[i])?.[0] as bigint | undefined) ??
            0n,
        ],
        block,
      ),
    ),
  )
  const eeAlloc = new Map<string, ExposureAlloc[]>()
  eePairs.forEach(({ vault, s }, i) => {
    const w = dec(['uint256', 'uint256', 'bool', 'uint256'], eeCfg[i])
    const assets = word(eeConv[i]) ?? 0n
    eeAlloc.set(vault, [
      ...(eeAlloc.get(vault) ?? []),
      {
        target: s,
        scope: 'strategy',
        collateral: (ent.strategies[s]?.collateral ?? []).map(lc),
        assets: assets.toString(),
        usd: usd(ent.vaults[vault]?.asset, assets),
        share: 0,
        cap: w ? String(w[1]) : undefined,
      },
    ])
  })
  for (const [vault, allocs] of eeAlloc) {
    const total = totalAssetsOf.get(vault) ?? 0n
    if ((usd(ent.vaults[vault]?.asset, total) ?? 0) < EXPOSURE_MIN_USD) continue
    finish(vault, 'euler-earn', allocs, total)
  }
  return { schema: SCHEMA, block, ts, vaults }
}

/** Withdrawal-first attribution: market(id) at b−1 and b; IRM rates only where it moved. */
async function readAttribution(
  cases: AttributionCase[],
  ent: Entities,
): Promise<AttributionCase[]> {
  const st = await rpc.batch(
    cases.flatMap((c) => [
      call(CHAIN.morpho, 'market(bytes32)', [c.market], c.block - 1),
      call(CHAIN.morpho, 'market(bytes32)', [c.market], c.block),
    ]),
    30,
  )
  const words = new Map<number, [bigint[] | null, bigint[] | null]>()
  cases.forEach((c, i) => {
    const w0 = dec(MARKET6, st[i * 2]) as bigint[] | null
    const w1 = dec(MARKET6, st[i * 2 + 1]) as bigint[] | null
    words.set(i, [w0, w1])
    if (w0) c.before = { totalSupplyAssets: String(w0[0]), totalBorrowAssets: String(w0[2]) }
    if (w1) c.after = { totalSupplyAssets: String(w1[0]), totalBorrowAssets: String(w1[2]) }
  })
  const moved = (i: number): boolean => {
    const a = attribute(cases[i])
    if (!a) return false
    const drop =
      a.supplyBefore > 0n ? Number((-a.supplyDelta * 10_000n) / a.supplyBefore) / 10_000 : 0
    return drop >= 0.05 || a.utilAfter >= 0.85
  }
  const irmCalls: { i: number; side: 0 | 1 }[] = []
  const irmReq: { method: string; params: unknown[] }[] = []
  cases.forEach((c, i) => {
    const m = ent.markets[c.market]
    if (!m || m.irm === ZERO || !moved(i)) return
    for (const side of [0, 1] as const) {
      const w = words.get(i)?.[side]
      if (!w) continue
      irmCalls.push({ i, side })
      irmReq.push(irmRateCall(c.market, ent, w, side === 0 ? c.block - 1 : c.block))
    }
  })
  const irmRes = await rpc.batch(irmReq, 30)
  irmCalls.forEach(({ i, side }, k) => {
    const r = word(irmRes[k])
    const s = cases[i][side === 0 ? 'before' : 'after']
    if (s && r !== undefined) s.borrowRate = r.toString()
  })
  return cases.filter((c) => {
    const a = attribute(c)
    if (!a) return false
    const drop =
      a.supplyBefore > 0n ? Number((-a.supplyDelta * 10_000n) / a.supplyBefore) / 10_000 : 0
    return drop >= KEPT_SUPPLY_DROP || a.spike || a.drained
  })
}

const irmRateCall = (market: string, ent: Entities, w: bigint[], block: number) => {
  const m = ent.markets[market]
  const data =
    sel(
      'borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128))',
    ) +
    [m.loan, m.collateral, m.oracle, m.irm].map(pad).join('') +
    pad(BigInt(m.lltv)) +
    w.map(pad).join('')
  return rawCall(m.irm, data, block)
}

/**
 * Spike-first attribution over [from, to]: stream Morpho Blue AccrueInterest, keep the
 * markets curated vaults use, find jumps (carrying each market's last rate in state.rates),
 * pre-filter by the borrow size the accrual implies, read market state around each cause
 * block, then every Supply / Withdraw / Borrow / Repay / Liquidate in it.
 */
async function readSpikes(
  universe: Set<string>,
  from: number,
  to: number,
  state: CollectorState,
  reallocations: Reallocation[],
  kindOf: Map<string, EmitterKind>,
  ent: Entities,
  usd: (token: string | undefined, amount: bigint) => number | undefined,
): Promise<SpikeCase[]> {
  const accrue = eventByName('blue', 'AccrueInterest').topic0
  const series = new Map<string, (RatePoint & { interest: bigint; ts?: number })[]>()
  let seen = 0
  await rpc.getLogs({ address: CHAIN.morpho, topics: [[accrue]] }, from, to, {
    dual: true,
    concurrency: 4,
    onChunk: (d, n) => {
      if (d % 25 === 0 || d === n) log(`G accrue: ${d}/${n} chunks (${seen} logs)`)
    },
    onLogs: (logs) => {
      seen += logs.length
      for (const l of logs) {
        const id = lc(l.topics[1] ?? '')
        if (!universe.has(id)) continue
        const r = decodeLog('blue', toRaw(l, l.blockTimestamp ? parseInt(l.blockTimestamp, 16) : 0))
        if (!r.ok) continue
        const list = series.get(id) ?? []
        list.push({
          block: r.event.block,
          logIndex: r.event.logIndex,
          rate: r.event.args.prevBorrowRate as bigint,
          interest: r.event.args.interest as bigint,
          ts: r.event.ts || undefined,
        })
        series.set(id, list)
      }
    },
  })
  // Candidates, with the borrow size implied by the accrual that revealed the jump.
  type Cand = { market: string; block: number; rateBefore: bigint; rateAfter: bigint }
  const cands: Cand[] = []
  for (const [market, pts] of series) {
    pts.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
    const carried = state.rates[market]
    const found = detectSpikes(
      market,
      pts,
      carried ? { block: carried[0], rate: BigInt(carried[1]) } : undefined,
    )
    const byBlock = new Map(pts.map((p, i) => [p.block, { p, prev: pts[i - 1] }]))
    for (const s of found) {
      const seenAt = byBlock.get(s.seenAt)
      const m = ent.markets[market]
      if (!seenAt || !m) continue
      const dt = BigInt(Math.max(1, (s.seenAt - s.block) * 12))
      const borrow = s.rateAfter > 0n ? (seenAt.p.interest * 10n ** 18n) / (s.rateAfter * dt) : 0n
      if ((usd(m.loan, borrow) ?? 0) < SPIKE_MIN_BORROW_USD) continue
      cands.push({ market, block: s.block, rateBefore: s.rateBefore, rateAfter: s.rateAfter })
    }
    const last = pts[pts.length - 1]
    if (last) state.rates[market] = [last.block, last.rate.toString()]
  }
  log(
    `spikes: ${seen} accrual logs, ${[...series.values()].reduce((s, x) => s + x.length, 0)} on ${series.size} curated markets → ${cands.length} candidates`,
  )
  if (!cands.length) return []
  // Market state around the cause block; keep markets with ≥ $1M supply.
  const st = await rpc.batch(
    cands.flatMap((c) => [
      call(CHAIN.morpho, 'market(bytes32)', [c.market], c.block - 1),
      call(CHAIN.morpho, 'market(bytes32)', [c.market], c.block),
    ]),
    30,
  )
  const kept: (Cand & { before: bigint[]; after: bigint[] })[] = []
  cands.forEach((c, i) => {
    const w0 = dec(MARKET6, st[i * 2]) as bigint[] | null
    const w1 = dec(MARKET6, st[i * 2 + 1]) as bigint[] | null
    if (!w0 || !w1) return
    if ((usd(ent.markets[c.market]?.loan, w0[0]) ?? 0) < SPIKE_MIN_SUPPLY_USD) return
    kept.push({ ...c, before: w0, after: w1 })
  })
  // Every flow in the cause block.
  const flowTopics = ['Supply', 'Withdraw', 'Borrow', 'Repay', 'Liquidate'].map(
    (n) => eventByName('blue', n).topic0,
  )
  const flowLogs = await rpc.getLogsMany(
    kept.map((c) => ({
      filter: { address: CHAIN.morpho, topics: [flowTopics, c.market] },
      from: c.block,
      to: c.block,
    })),
  )
  const tsOf = new Map<number, number>()
  for (const ls of flowLogs)
    for (const l of ls)
      if (l.blockTimestamp) tsOf.set(parseInt(l.blockNumber, 16), parseInt(l.blockTimestamp, 16))
  await fillTimestamps(
    tsOf,
    kept.map((c) => c.block),
  )
  const reallocOut = new Map<string, Reallocation['source']>()
  for (const r of reallocations) if (r.dir === 'out') reallocOut.set(`${r.tx}|${r.vault}`, r.source)
  const vaultOf = (a: string): string | undefined => {
    const k = kindOf.get(a)
    if (k === 'mm' || k === 'v2' || k === 'ee') return a
    return state.adapters[a]
  }
  return kept.map((c, i) => {
    const logs: BlueFlowLog[] = []
    for (const l of flowLogs[i]) {
      const r = decodeLog('blue', toRaw(l, 0))
      if (!r.ok) continue
      const e = r.event
      logs.push({
        name: e.name as BlueFlowLog['name'],
        tx: e.tx,
        onBehalf: typeof e.args.onBehalf === 'string' ? e.args.onBehalf : undefined,
        assets: typeof e.args.assets === 'bigint' ? e.args.assets : undefined,
        repaidAssets: typeof e.args.repaidAssets === 'bigint' ? e.args.repaidAssets : undefined,
        badDebtAssets: typeof e.args.badDebtAssets === 'bigint' ? e.args.badDebtAssets : undefined,
      })
    }
    return {
      market: c.market,
      block: c.block,
      ts: tsOf.get(c.block) ?? 0,
      rateBefore: c.rateBefore.toString(),
      rateAfter: c.rateAfter.toString(),
      before: { totalSupplyAssets: String(c.before[0]), totalBorrowAssets: String(c.before[2]) },
      after: { totalSupplyAssets: String(c.after[0]), totalBorrowAssets: String(c.after[2]) },
      flows: groupFlows(logs, {
        vaultOf,
        reallocationIn: (tx, vault) => reallocOut.get(`${tx}|${vault}`),
      }),
    }
  })
}

/**
 * Flags 1, 2, 4 and 5 (lib/curatorFeed/flags.ts) for the given markets. An oracle's inputs
 * are read once (MorphoChainlinkOracleV2 is immutable) and carried in state. Every run:
 * price() and each feed's latestRoundData() at the head; a newly reverting oracle gets
 * a binary search for its first reverting block; market() at the head, and `lockedDays`
 * earlier for the markets fully borrowed at the head. With each exposure refresh: the two
 * largest borrowers per market (Morpho API ranking), their debt read on chain.
 */
async function readMarketFlags(
  markets: string[],
  o: {
    head: number
    headTs: number
    windowFrom: number
    windowFromTs: number
    refreshBorrowers: boolean
    state: CollectorState
    ent: Entities
    usd: (token: string | undefined, amount: bigint) => number | undefined
  },
): Promise<Record<string, MarketFlags>> {
  const { head, headTs, state, ent } = o
  const oracleCfg = (state.oracles ??= {})
  const reverts = (state.oracleRevert ??= {})
  const borrowers = (state.borrowers ??= {})
  const ms = markets.filter((m) => ent.markets[m])
  const oracles = uniq(ms.map((m) => lc(ent.markets[m].oracle))).filter((a) => a !== ZERO)
  const isRevert = (e: unknown) => /revert/i.test(String(e))

  // 1. Inputs, once per oracle.
  const ROLES = [
    ['baseFeed1', 'BASE_FEED_1()'],
    ['baseFeed2', 'BASE_FEED_2()'],
    ['quoteFeed1', 'QUOTE_FEED_1()'],
    ['quoteFeed2', 'QUOTE_FEED_2()'],
    ['baseVault', 'BASE_VAULT()'],
    ['quoteVault', 'QUOTE_VAULT()'],
  ] as const
  const fresh = oracles.filter((a) => !(a in oracleCfg))
  const cfg = await rpc.batch(fresh.flatMap((a) => ROLES.map(([, sig]) => call(a, sig))))
  const newParts: OraclePart[] = []
  for (const [i, a] of fresh.entries()) {
    const r = cfg.slice(i * 6, i * 6 + 6)
    if (r.every((x) => x === null)) {
      // Not a MorphoChainlinkOracleV2 only if a single call confirms the revert.
      try {
        await rpc.call('eth_call', call(a, 'BASE_FEED_1()').params)
      } catch (e) {
        if (isRevert(e)) oracleCfg[a] = null
      }
      continue
    }
    const parts: OraclePart[] = []
    ROLES.forEach(([role], k) => {
      const x = addrOf(r[k])
      if (x) parts.push({ role, address: lc(x) })
    })
    oracleCfg[a] = parts
    newParts.push(...parts)
  }
  const det = await rpc.batch(
    newParts.map((p) =>
      p.role.endsWith('Vault') ? call(p.address, 'asset()') : call(p.address, 'description()'),
    ),
  )
  newParts.forEach((p, i) => {
    if (p.role.endsWith('Vault')) {
      const x = addrOf(det[i])
      if (x) p.asset = lc(x)
    } else {
      const d = dec(['string'], det[i])?.[0]
      if (typeof d === 'string') p.description = d
    }
  })

  // 2. price() and each feed's last update at the head.
  const feeds = uniq(
    oracles.flatMap((a) =>
      (oracleCfg[a] ?? []).filter((p) => !p.role.endsWith('Vault')).map((p) => p.address),
    ),
  )
  const res = await rpc.batch([
    ...oracles.map((a) => call(a, 'price()', [], head)),
    ...feeds.map((f) => call(f, 'latestRoundData()', [], head)),
  ])
  const priceOf = new Map<string, string | null>()
  for (const [i, a] of oracles.entries()) {
    const w = word(res[i])
    if (w !== undefined) {
      priceOf.set(a, w.toString())
      continue
    }
    // A batch null is a revert; one call confirms it (a transport failure is not).
    try {
      const r = await rpc.call<string>('eth_call', call(a, 'price()', [], head).params)
      const w2 = word(r)
      if (w2 !== undefined) priceOf.set(a, w2.toString())
    } catch (e) {
      if (isRevert(e)) priceOf.set(a, null)
    }
  }
  const updatedAt = new Map<string, number>()
  feeds.forEach((f, i) => {
    const r = res[oracles.length + i] as string | null
    if (r && r.length >= 2 + 64 * 4)
      updatedAt.set(f, Number(BigInt('0x' + r.slice(2 + 192, 2 + 256))))
  })

  // 3. When the current run of reverts began (flags.ts revertOnset), for oracles that
  //    revert now and did not at the last run.
  const revertsAt =
    (a: string) =>
    async (b: number): Promise<boolean> => {
      try {
        await rpc.call('eth_call', call(a, 'price()', [], b).params)
        return false
      } catch (e) {
        if (isRevert(e)) return true
        throw e
      }
    }
  //    The search reaches back to Morpho Blue's deployment, not the window start: an oracle
  //    that stopped before the window (sdeUSD/USDC: block 24,055,805, 2025-12-20) gets its
  //    real onset. An entry from an earlier run that stopped at a later floor is redone.
  const floor = CHAIN.morphoDeploy
  for (const a of oracles) {
    if (priceOf.get(a) !== null) {
      if (priceOf.has(a)) delete reverts[a]
      continue
    }
    if (reverts[a] && !(reverts[a].beforeWindow && reverts[a].since > floor)) continue
    const on = await revertOnset(revertsAt(a), head, floor)
    if (on.beforeWindow) {
      const h = await rpc.call<{ timestamp: string }>('eth_getBlockByNumber', [hexN(floor), false])
      reverts[a] = { since: floor, sinceTs: parseInt(h.timestamp, 16), beforeWindow: true }
      continue
    }
    const h = await rpc.call<{ timestamp: string }>('eth_getBlockByNumber', [hexN(on.since), false])
    reverts[a] = { since: on.since, sinceTs: parseInt(h.timestamp, 16) }
    log(`oracle ${a} reverts since block ${on.since}`)
  }

  // 4. Largest borrowers (with each exposure refresh).
  const mres = await rpc.batch(ms.map((m) => call(CHAIN.morpho, 'market(bytes32)', [m], head)))
  const mstate = new Map(ms.map((m, i) => [m, dec(MARKET6, mres[i]) as bigint[] | null]))
  if (o.refreshBorrowers) {
    const cand = ms.filter((m) => {
      const w = mstate.get(m)
      return w && (o.usd(ent.markets[m].loan, w[2]) ?? 0) >= FLAG_DEFAULTS.minBorrowUsd
    })
    const ranked = new Map<string, string[]>()
    for (const grp of chunked(cand, 20)) {
      const q = grp
        .map(
          (m, i) =>
            `m${i}: marketPositions(first: 2, orderBy: BorrowShares, orderDirection: Desc, where: { marketUniqueKey_in: ["${m}"], chainId_in: [${CHAIN.morphoApiChainId}] }) { items { user { address } } }`,
        )
        .join(' ')
      const d = await gql<Record<string, { items: { user: { address: string } }[] }>>(`{ ${q} }`)
      grp.forEach((m, i) => {
        const users = (d?.[`m${i}`]?.items ?? []).map((x) => lc(x.user.address))
        if (users.length) ranked.set(m, users)
      })
    }
    const pairs = [...ranked].flatMap(([m, us]) => us.map((u) => ({ m, u })))
    const pos = await rpc.batch(
      pairs.map(({ m, u }) => call(CHAIN.morpho, 'position(bytes32,address)', [m, u], head)),
    )
    const debt = new Map<string, { u: string; assets: bigint }[]>()
    pairs.forEach(({ m, u }, i) => {
      const w = mstate.get(m)
      const p = dec(['uint256', 'uint256', 'uint256'], pos[i])
      if (!w || !p) return
      const shares = p[1] as bigint
      // Borrow shares → assets, rounded up (SharesMathLib toAssetsUp).
      const den = w[3] + 1_000_000n
      const assets = (shares * (w[2] + 1n) + den - 1n) / den
      debt.set(m, [...(debt.get(m) ?? []), { u, assets }])
    })
    for (const [m, list] of debt) {
      const w = mstate.get(m)!
      const sorted = list.sort((a, b) => (b.assets > a.assets ? 1 : b.assets < a.assets ? -1 : 0))
      borrowers[m] = {
        top: sorted[0].u,
        topAssets: sorted[0].assets.toString(),
        secondAssets: sorted[1]?.assets.toString(),
        totalBorrow: w[2].toString(),
        totalSupply: w[0].toString(),
        block: head,
      }
    }
    log(`flags: largest borrowers read for ${debt.size} of ${cand.length} markets ≥ $1M borrowed`)
  }

  // 5. Flag 5: market() `lockedDays` back for the markets fully borrowed at the head.
  const full = ms.filter((m) => {
    const w = mstate.get(m)
    return w && (utilization(w[0], w[2]) ?? 0) >= FLAG_DEFAULTS.lockedUtil
  })
  const prevBlock = Math.max(0, head - FLAG_DEFAULTS.lockedDays * 7200)
  const [prevHdr, ...prevRes] = await rpc.batch([
    { method: 'eth_getBlockByNumber', params: [hexN(prevBlock), false] },
    ...full.map((m) => call(CHAIN.morpho, 'market(bytes32)', [m], prevBlock)),
  ])
  const prevTs = parseInt((prevHdr as { timestamp?: string } | null)?.timestamp ?? '0x0', 16)
  const fill = new Map<string, NonNullable<MarketFlags['fill']>>()
  full.forEach((m, i) => {
    const w = mstate.get(m)!
    const p = dec(MARKET6, prevRes[i]) as bigint[] | null
    if (!p || !prevTs) return
    fill.set(m, {
      block: head,
      supply: w[0].toString(),
      borrow: w[2].toString(),
      lastUpdate: Number(w[4]),
      prevBlock,
      prevTs,
      prevSupply: p[0].toString(),
      prevBorrow: p[2].toString(),
    })
  })

  // 6. Keep the markets that carry a flag.
  const out: Record<string, MarketFlags> = {}
  for (const m of ms) {
    const info = ent.markets[m]
    const a = lc(info.oracle)
    const parts = oracleCfg[a]
    if (parts === undefined) continue
    const times = (parts ?? [])
      .filter((p) => !p.role.endsWith('Vault'))
      .map((p) => updatedAt.get(p.address))
      .filter((x): x is number => x !== undefined && x > 0)
    const price = priceOf.get(a)
    const f: MarketFlags = {
      oracle: a,
      oracleKind: classifyOracle(parts, info.loan),
      parts: parts ?? [],
      price: price ?? undefined,
      reverting: price === null ? reverts[a] : undefined,
      staleSeconds: times.length ? headTs - Math.min(...times) : undefined,
      borrowers: borrowers[m],
      fill: fill.get(m),
    }
    // The one-borrower floor uses the borrows read with the borrower (as the API view does).
    const borrowUsd = f.borrowers ? o.usd(info.loan, BigInt(f.borrowers.totalBorrow)) : undefined
    if (hasMarketFlag(f, borrowUsd)) out[m] = f
  }
  log(
    `flags: ${oracles.length} oracles (${fresh.length} read for the first time), ${[...priceOf.values()].filter((x) => x === null).length} reverting, ${full.length} markets fully borrowed; ${Object.keys(out).length} markets flagged`,
  )
  return out
}

// ── prune ──────────────────────────────────────────────────────────────────────

/** Keep only the entities the dataset references. */
function prune(
  ent: Entities,
  actions: FeedAction[],
  flows: UnitFlow[],
  exposure: ExposureFile,
  attribution: AttributionCase[],
  spikes: SpikeCase[],
  v2Ids: Record<string, V2IdData>,
  flags: FeedFlags,
): Entities {
  const usedV2 = new Set(
    actions.filter((a) => a.protocol === 'morpho-v2').map((a) => a.target ?? ''),
  )
  const keptV2: Entities['v2Ids'] = {}
  for (const [id, d] of Object.entries({ ...ent.v2Ids, ...v2Ids })) {
    if (!usedV2.has(id)) continue
    if ('marketParams' in d)
      keptV2[id] = {
        type: 'market',
        market: d.market,
        adapter: d.adapter,
        collateral: d.marketParams.collateralToken,
      }
    else if (d.type === 'collateral') keptV2[id] = { type: 'collateral', collateral: d.collateral }
    else if (d.type === 'adapter') keptV2[id] = { type: 'adapter', adapter: d.adapter }
    else if (d.type === 'market') keptV2[id] = d as Entities['v2Ids'][string]
    else keptV2[id] = { type: 'adapter' }
  }
  const usedVaults = new Set([
    ...actions.map((a) => a.vault),
    ...flows.map((f) => f.vault),
    ...exposure.vaults.map((x) => x.vault),
    ...attribution.flatMap((c) => c.legs.map((l) => l.vault)),
    ...spikes.flatMap((s) => s.flows.map((f) => f.vault ?? '')),
    ...flags.shifts.flatMap((x) => [...x.from, ...x.to].map((v) => v.vault)),
  ])
  const vaults = Object.fromEntries(Object.entries(ent.vaults).filter(([a]) => usedVaults.has(a)))
  const usedMarkets = new Set([
    ...actions.map((a) => a.target ?? ''),
    ...flows.map((f) => f.target),
    ...exposure.vaults.flatMap((x) => x.allocations.map((a) => a.target)),
    ...attribution.map((c) => c.market),
    ...spikes.map((s) => s.market),
    ...Object.values(keptV2).map((d) => d.market ?? ''),
    ...Object.keys(flags.markets),
    ...flags.shifts.map((x) => x.market),
  ])
  const markets = Object.fromEntries(
    Object.entries(ent.markets).filter(([id]) => usedMarkets.has(id)),
  )
  const usedStrategies = new Set([
    ...actions.map((a) => a.target ?? ''),
    ...exposure.vaults.flatMap((x) => x.allocations.map((a) => a.target)),
  ])
  const strategies = Object.fromEntries(
    Object.entries(ent.strategies).filter(([s]) => usedStrategies.has(s)),
  )
  const usedTokens = new Set<string>([
    ...Object.values(vaults).map((v) => v.asset),
    ...Object.values(markets).flatMap((m) => [lc(m.loan), lc(m.collateral)]),
    ...actions.flatMap((a) => a.collateral.map(lc)),
    ...exposure.vaults.flatMap((x) => x.allocations.flatMap((a) => a.collateral)),
    ...Object.values(strategies).flatMap((s) => [s.asset, ...s.collateral.map(lc)]),
    ...Object.values(keptV2).flatMap((d) => (d.collateral ? [lc(d.collateral)] : [])),
  ])
  const tokens = Object.fromEntries(Object.entries(ent.tokens).filter(([a]) => usedTokens.has(a)))
  const usedCurators = new Set([
    ...Object.values(vaults).map((v) => v.curatorKey),
    ...Object.keys(ent.curators).filter((k) => k.startsWith('aave:')),
  ])
  const curators = Object.fromEntries(
    Object.entries(ent.curators).filter(([k]) => usedCurators.has(k)),
  )
  return {
    tokens,
    markets,
    vaults,
    curators,
    strategies,
    aaveMarkets: { ...CHAIN.aave },
    v2Ids: keptV2,
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`[curator-feed] failed: ${rpc.scrub(String(e?.stack ?? e))}`)
    process.exit(1)
  },
)
