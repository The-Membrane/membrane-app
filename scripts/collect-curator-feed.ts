// collect-curator-feed.ts — collect the curator action feed (Ethereum mainnet) into
// public/data/curator-feed/{feed,flows,exposure}.json.
//
//   pnpm curators:feed                       (tsx; from the membrane-app root)
//   CURATOR_FEED_DAYS=182 pnpm curators:feed (window; default 182 days)
//
//   1. Window: the finalized head back DAYS × 7,200 blocks (post-merge ≤ 7,200/day, so
//      the window covers at least DAYS days).
//   2. Logs, EVERY chunk read from two endpoints and unioned (scripts/lib/curator-feed-rpc.ts):
//      curator config events (topic-only), reallocation legs (topic-only), Vault V2
//      allocator moves (topic1 = known allocators), Aave v3 PoolConfigurator events
//      (address-filtered), ownership transfers (address-filtered).
//   3. Every emitter is VERIFIED against its factory (isMetaMorpho ×2, isVaultV2, Euler
//      Earn isVault) before its logs count: topic0 alone proves nothing.
//   4. Archive reads the events cannot supply: the cap before each SetCap, the timelock at
//      the window start, each queue before its first in-window change, and head reads of
//      every still-open submit (pendingCap / removableAt / pendingTimelock / …).
//   5. lib/curatorFeed classifies; flows are netted per tx and aggregated per UTC day.
//   6. Exposure at the head: V1 withdraw queues × Morpho Blue positions, V2 adapters,
//      Euler Earn strategies. USD at Morpho-API prices at collection time.
//   7. Attribution: for every net reallocation withdrawal ≥ $1M from a Morpho Blue market,
//      market(id) and the IRM's borrowRateView at the end of blocks b−1 and b.
//
// RPC: scripts/lib/curator-feed-rpc.ts (env keys never printed or stored; labels only).
// Labels: Morpho API curator registry + vault list, Euler labels entities.json.

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

import {
  decodeParams,
  eventByName,
  topicsFor,
  type AbiType,
  type EmitterKind,
  type RawLog,
} from '../lib/curatorFeed/abi'
import { classifyEvents, type ClassifyContext } from '../lib/curatorFeed/classify'
import { decodeLog, type DecodedEvent } from '../lib/curatorFeed/decode'
import {
  aggregateDaily,
  encodeFlows,
  netPerTx,
  selectLargeWithdrawals,
} from '../lib/curatorFeed/flows'
import { attribute } from '../lib/curatorFeed/attribution'
import { toAssetsDown } from '../lib/curatorFeed/exposure'
import { keccakText } from '../lib/curatorFeed/keccak'
import {
  SCHEMA,
  encodeFeedFile,
  type ExposureFile,
  type FeedFile,
  type FlowsFile,
} from '../lib/curatorFeed/store'
import type {
  AttributionCase,
  Entities,
  ExposureAlloc,
  ExposureVault,
  Protocol,
  Reallocation,
} from '../lib/curatorFeed/types'
import { EXIT_KINDS } from '../lib/curatorFeed/types'
import {
  collateralIdData,
  decodeV2IdData,
  marketIdData,
  v2IdOf,
  type V2IdData,
} from '../lib/curatorFeed/v2ids'
import { FeedRpc, endpointsFromEnv, type RpcLog } from './lib/curator-feed-rpc'

const DAYS = Number(process.env.CURATOR_FEED_DAYS ?? 182)
const OUT_DIR = join(process.cwd(), 'public', 'data', 'curator-feed')
const LARGE_WITHDRAW_USD = 1_000_000
const EXPOSURE_MIN_USD = 100_000
/** An attribution case is kept when the block cut the market's supply by at least this much (or spiked / drained it). */
const KEPT_SUPPLY_DROP = 0.2

const MORPHO = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb'
const MM_FACTORIES = [
  '0xa9c3d3a366466fa809d1ae982fb2c46e5fc41101',
  '0x1897a8997241c1cd4bd0698647e4eb7213535c24',
]
const V2_FACTORY = '0xa1d94f746defa1928926b84fb2596c06926c0405'
const EE_FACTORY = '0x59709b029b140c853fe28d277f83c3a65e308af4'
const MORPHO_PA = '0xfd32fa2ca22c76dd6e550706ad913fc6ce91c75d'
const EULER_PA = '0x8fdcb80a2894f0dc052c8d52d22544dc90274800'
const AAVE: Record<string, string> = {
  '0x64b761d848206f447fe2dd461b0c635ec39ebb27': 'Aave v3 Core',
  '0x342631c6cefc9cfbf97b2fe4aa242a236e1fd517': 'Aave v3 Prime',
  '0x8438f4d29d895d75c86bdc25360c25ef0607e65d': 'Aave v3 EtherFi',
  '0x83cb1b4af26eef6463ac20afbac9c0e2e017202f': 'Aave v3 Horizon',
}
const MORPHO_API = 'https://blue-api.morpho.org/graphql'
const EULER_ENTITIES =
  'https://raw.githubusercontent.com/euler-xyz/euler-labels/master/1/entities.json'

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
const dec = (types: AbiType[], ret: string | null): any[] | null => {
  if (!ret || ret === '0x') return null
  try {
    return decodeParams(types, ret)
  } catch {
    return null
  }
}
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)]
const chunked = <T>(xs: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))

async function gql<T>(query: string): Promise<T | null> {
  try {
    const r = await fetch(MORPHO_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    })
    const j: any = await r.json()
    if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200))
    return j.data as T
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

// ── main ───────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now()
  log(`endpoints: ${rpc.endpoints.map((e) => e.label).join(', ')}`)
  const headBlock = await rpc.call<any>('eth_getBlockByNumber', ['finalized', false])
  const toBlock = parseInt(headBlock.number, 16)
  const toTs = parseInt(headBlock.timestamp, 16)
  const fromBlock = toBlock - DAYS * 7200
  const fromHdr = await rpc.call<any>('eth_getBlockByNumber', [hexN(fromBlock), false])
  const fromTs = parseInt(fromHdr.timestamp, 16)
  log(`window ${fromBlock}–${toBlock} (${((toTs - fromTs) / 86400).toFixed(1)} days)`)

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
    state: {
      curator: string
      owner: string
      timelock: number
      totalAssetsUsd: number | null
    } | null
  }>(
    'vaults',
    'address name asset { address symbol decimals price { usd } } state { curator owner timelock totalAssetsUsd }',
    '{ chainId_in: [1] }',
  )
  const apiV2 = await paged<{
    address: string
    name: string
    asset: ApiAsset
    curator: { address: string } | null
    owner: { address: string } | null
    totalAssetsUsd: number | null
  }>(
    'vaultV2s',
    'address name asset { address symbol decimals price { usd } } curator { address } owner { address } totalAssetsUsd',
    '{ chainId_in: [1] }',
  )
  const apiCurators =
    (
      await gql<{
        curators: { items: { name: string; addresses: { address: string; chainId: number }[] }[] }
      }>(`{ curators(first: 1000) { items { name addresses { address chainId } } } }`)
    )?.curators.items ?? []
  let eulerEntities: Record<string, { name: string; addresses?: Record<string, string> }> = {}
  try {
    eulerEntities = (await (await fetch(EULER_ENTITIES)).json()) as typeof eulerEntities
  } catch (e) {
    log(`euler labels: ${String(e).slice(0, 120)}`)
  }
  log(
    `api: ${apiV1.length} V1 vaults, ${apiV2.length} V2 vaults, ${apiCurators.length} curators; euler entities ${Object.keys(eulerEntities).length}`,
  )

  const tokens: Entities['tokens'] = {}
  const noteAsset = (a: ApiAsset | undefined) => {
    if (!a?.address) return
    const k = lc(a.address)
    tokens[k] = {
      symbol: a.symbol,
      decimals: a.decimals,
      priceUsd: a.price?.usd ?? tokens[k]?.priceUsd ?? undefined,
    }
  }
  apiV1.forEach((v) => noteAsset(v.asset))
  apiV2.forEach((v) => noteAsset(v.asset))

  // Euler Earn vaults from the factory.
  const eeLen = BigInt(
    (await rpc.call<string>('eth_call', [
      call(EE_FACTORY, 'getVaultListLength()').params[0],
      'latest',
    ])) ?? '0x0',
  )
  const eeList = (dec(
    ['address[]'],
    await rpc.call<string>('eth_call', [
      call(EE_FACTORY, 'getVaultListSlice(uint256,uint256)', [0n, eeLen]).params[0],
      'latest',
    ]),
  )?.[0] ?? []) as string[]
  log(`euler earn factory: ${eeList.length} vaults`)

  // ── log scans ──
  const kindTopics = (k: EmitterKind, exclude: string[]) =>
    topicsFor(k).filter((t) => !exclude.includes(t))
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
  const configTopics = uniq([
    ...kindTopics('mm', highVolume),
    ...kindTopics('ee', highVolume),
    ...kindTopics('v2', highVolume),
  ])
  const progress = (label: string) => (d: number, n: number) => {
    if (d % 25 === 0 || d === n) log(`${label}: ${d}/${n} chunks`)
  }

  log(`scan A: ${configTopics.length} config topics, dual-read`)
  const logsA = await rpc.getLogs({ topics: [configTopics] }, fromBlock, toBlock, {
    dual: true,
    concurrency: 4,
    onChunk: progress('A config'),
  })
  log(`scan B: reallocation legs`)
  const reallocTopics = highVolume.slice(0, 4)
  const logsB = await rpc.getLogs({ topics: [reallocTopics] }, fromBlock, toBlock, {
    dual: true,
    concurrency: 4,
    onChunk: progress('B realloc'),
  })
  log(`scan E: aave configurators, dual-read`)
  const logsE = await rpc.getLogs(
    { address: Object.keys(AAVE), topics: [topicsFor('aave')] },
    fromBlock,
    toBlock,
    { dual: true, concurrency: 4, onChunk: progress('E aave') },
  )

  // ── verify emitters ──
  const kindOf = new Map<string, EmitterKind>()
  for (const a of Object.keys(AAVE)) kindOf.set(a, 'aave')
  const candidates = uniq(
    [...logsA, ...logsB]
      .map((l) => lc(l.address))
      .concat(
        apiV1.map((v) => lc(v.address)),
        apiV2.map((v) => lc(v.address)),
        eeList.map(lc),
      ),
  )
  const checks = await rpc.batch(
    candidates.flatMap((a) => [
      call(MM_FACTORIES[0], 'isMetaMorpho(address)', [a]),
      call(MM_FACTORIES[1], 'isMetaMorpho(address)', [a]),
      call(V2_FACTORY, 'isVaultV2(address)', [a]),
      call(EE_FACTORY, 'isVault(address)', [a]),
    ]),
  )
  const truthy = (r: string | null) => Boolean(r && BigInt(r) === 1n)
  candidates.forEach((a, i) => {
    const [m0, m1, v2, ee] = checks.slice(i * 4, i * 4 + 4).map(truthy)
    if (m0 || m1) kindOf.set(a, 'mm')
    else if (v2) kindOf.set(a, 'v2')
    else if (ee) kindOf.set(a, 'ee')
  })
  const vaultsOf = (k: EmitterKind) =>
    [...kindOf.entries()].filter(([, x]) => x === k).map(([a]) => a)
  const unverified = uniq(
    [...logsA, ...logsB].map((l) => lc(l.address)).filter((a) => !kindOf.has(a)),
  )
  log(
    `verified vaults: mm ${vaultsOf('mm').length}, v2 ${vaultsOf('v2').length}, ee ${vaultsOf('ee').length}; ${unverified.length} unverified emitters dropped`,
  )

  // Scan F: ownership transfers on V1 / Euler Earn vaults (address-filtered — the topic is everywhere).
  const v1ee = [...vaultsOf('mm'), ...vaultsOf('ee')]
  const logsF: RpcLog[] = []
  for (const grp of chunked(v1ee, 250)) {
    logsF.push(
      ...(await rpc.getLogs(
        { address: grp, topics: [[eventByName('mm', 'OwnershipTransferred').topic0]] },
        fromBlock,
        toBlock,
        { dual: true, concurrency: 4 },
      )),
    )
  }
  log(`scan F: ${logsF.length} ownership transfers`)

  // Scan C: V2 allocators ever set (factory deployment → head), then scan D: their moves.
  const v2Set = new Set(vaultsOf('v2'))
  let v2Deploy = fromBlock
  {
    let lo = 18_000_000
    let hi = toBlock
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      const code = await rpc.call<string>('eth_getCode', [V2_FACTORY, hexN(mid)])
      if (code && code !== '0x') hi = mid
      else lo = mid + 1
    }
    v2Deploy = lo
  }
  const allocTopic = eventByName('v2', 'SetIsAllocator').topic0
  const preAlloc =
    v2Deploy < fromBlock
      ? await rpc.getLogs({ topics: [[allocTopic]] }, v2Deploy, fromBlock - 1, {
          dual: true,
          concurrency: 4,
          onChunk: progress('C allocators'),
        })
      : []
  const everAllocator = new Map<string, Set<string>>()
  for (const l of [...preAlloc, ...logsA]) {
    const a = lc(l.address)
    if (!v2Set.has(a) || l.topics[0] !== allocTopic) continue
    const r = decodeLog('v2', toRaw(l, 0))
    if (r.ok && r.event.args.isAllocator === true) {
      const s = everAllocator.get(a) ?? new Set<string>()
      s.add(String(r.event.args.allocator))
      everAllocator.set(a, s)
    }
  }
  const allAllocators = uniq([...everAllocator.values()].flatMap((s) => [...s]))
  log(`V2 factory deployed at ${v2Deploy}; ${allAllocators.length} distinct V2 allocators`)
  const logsD: RpcLog[] = []
  for (const grp of chunked(allAllocators, 100)) {
    logsD.push(
      ...(await rpc.getLogs(
        {
          topics: [
            [eventByName('v2', 'Allocate').topic0, eventByName('v2', 'Deallocate').topic0],
            grp.map(pad).map((x) => '0x' + x),
          ],
        },
        fromBlock,
        toBlock,
        {
          dual: true,
          concurrency: 4,
          onChunk: progress('D v2 allocs'),
        },
      )),
    )
  }
  log(`scan D: ${logsD.length} V2 allocator allocate/deallocate logs`)

  // ── timestamps ──
  const allLogs = [...logsA, ...logsB, ...logsD, ...logsE, ...logsF]
  const tsOf = new Map<number, number>()
  for (const l of allLogs)
    if (l.blockTimestamp) tsOf.set(parseInt(l.blockNumber, 16), parseInt(l.blockTimestamp, 16))
  const missingTs = uniq(
    allLogs.map((l) => parseInt(l.blockNumber, 16)).filter((b) => !tsOf.has(b)),
  )
  if (missingTs.length) {
    log(`fetching ${missingTs.length} block timestamps`)
    const hdrs = await rpc.batch(
      missingTs.map((b) => ({ method: 'eth_getBlockByNumber', params: [hexN(b), false] })),
    )
    missingTs.forEach((b, i) => hdrs[i] && tsOf.set(b, parseInt(hdrs[i].timestamp, 16)))
  }

  // ── decode ──
  const events: DecodedEvent[] = []
  let malformed = 0
  const seenLog = new Set<string>()
  for (const l of allLogs) {
    const addr = lc(l.address)
    const kind = kindOf.get(addr)
    if (!kind) continue
    const uid = `${l.transactionHash}:${l.logIndex}`
    if (seenLog.has(uid)) continue
    seenLog.add(uid)
    const r = decodeLog(kind, toRaw(l, tsOf.get(parseInt(l.blockNumber, 16)) ?? 0))
    if (r.ok) events.push(r.event)
    else if (r.reason === 'malformed') malformed++
  }
  log(`decoded ${events.length} events (${malformed} malformed)`)

  // ── vault info (head) ──
  const vaultInfoReads = [...kindOf.entries()].filter(
    ([, k]) => k === 'mm' || k === 'ee' || k === 'v2',
  )
  const infoRes = await rpc.batch(
    vaultInfoReads.flatMap(([a, k]) => [
      call(a, 'name()'),
      call(a, 'asset()'),
      call(a, 'curator()'),
      call(a, 'owner()'),
      k === 'v2' ? call(a, 'adaptersLength()') : call(a, 'timelock()'),
      call(a, 'totalAssets()'),
    ]),
  )
  const vaults: Entities['vaults'] = {}
  const totalAssetsOf = new Map<string, bigint>()
  vaultInfoReads.forEach(([a, k], i) => {
    const r = infoRes.slice(i * 6, i * 6 + 6)
    const protocol: Protocol = k === 'mm' ? 'morpho-v1' : k === 'v2' ? 'morpho-v2' : 'euler-earn'
    const api1 = apiV1.find((v) => lc(v.address) === a)
    const api2 = apiV2.find((v) => lc(v.address) === a)
    vaults[a] = {
      protocol,
      name: (dec(['string'], r[0])?.[0] as string) ?? api1?.name ?? api2?.name ?? a,
      asset: lc(
        (dec(['address'], r[1])?.[0] as string) ??
          api1?.asset.address ??
          api2?.asset.address ??
          '0x',
      ),
      curator: (dec(['address'], r[2])?.[0] as string) ?? undefined,
      owner: (dec(['address'], r[3])?.[0] as string) ?? undefined,
      curatorKey: '',
      timelock: k === 'v2' ? undefined : Number((dec(['uint256'], r[4])?.[0] as bigint) ?? 0n),
    }
    totalAssetsOf.set(a, (dec(['uint256'], r[5])?.[0] as bigint) ?? 0n)
  })

  // ── curator identity ──
  const nameByAddr = new Map<string, { name: string; source: 'morpho-api' | 'euler-labels' }>()
  for (const c of apiCurators)
    for (const ad of c.addresses)
      if (ad.chainId === 1) nameByAddr.set(lc(ad.address), { name: c.name, source: 'morpho-api' })
  for (const e of Object.values(eulerEntities))
    for (const ad of Object.keys(e.addresses ?? {}))
      if (!nameByAddr.has(lc(ad))) nameByAddr.set(lc(ad), { name: e.name, source: 'euler-labels' })
  const curators: Entities['curators'] = {}
  const ZERO = '0x0000000000000000000000000000000000000000'
  for (const [a, v] of Object.entries(vaults)) {
    const hit = [v.curator, v.owner]
      .filter((x): x is string => Boolean(x && x !== ZERO))
      .map(lc)
      .map((x) => ({ x, n: nameByAddr.get(x) }))
      .find((h) => h.n)
    if (hit?.n) {
      const key = `name:${hit.n.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
      curators[key] = { name: hit.n.name, source: hit.n.source }
      v.curatorKey = key
    } else {
      const addr = v.curator && v.curator !== ZERO ? lc(v.curator) : lc(v.owner ?? a)
      curators[addr] = curators[addr] ?? { name: addr, source: 'address' }
      v.curatorKey = addr
    }
  }
  for (const [a, label] of Object.entries(AAVE)) {
    curators[`aave:${a}`] = { name: label, source: 'address' }
  }

  // ── archive reads the events cannot supply ──
  const evOf = (k: EmitterKind, name: string) =>
    events.filter((e) => e.kind === k && e.name === name)
  // Cap before each SetCap / SubmitCap.
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
  // Timelock at the window start, for vaults with submit-type events.
  const submitVaults = uniq(
    events
      .filter((e) => (e.kind === 'mm' || e.kind === 'ee') && /^Submit|^SetTimelock/.test(e.name))
      .map((e) => e.emitter),
  )
  const tlRes = await rpc.batch(submitVaults.map((a) => call(a, 'timelock()', [], fromBlock)))
  const tlTimeline = new Map<string, { block: number; value: number }[]>()
  submitVaults.forEach((a, i) => {
    const v = dec(['uint256'], tlRes[i])?.[0] as bigint | undefined
    tlTimeline.set(a, v !== undefined ? [{ block: fromBlock, value: Number(v) }] : [])
  })
  for (const e of [...evOf('mm', 'SetTimelock'), ...evOf('ee', 'SetTimelock')]) {
    const t = tlTimeline.get(e.emitter) ?? []
    t.push({ block: e.block, value: Number(e.args.newTimelock as bigint) })
    tlTimeline.set(e.emitter, t)
  }
  for (const t of tlTimeline.values()) t.sort((a, b) => a.block - b.block)
  const timelockAt = (vault: string, block: number): number | undefined => {
    const t = tlTimeline.get(vault)
    if (!t?.length) return vaults[vault]?.timelock
    let v: number | undefined
    for (const x of t) if (x.block <= block) v = x.value
    return v ?? t[0].value
  }
  // Queues before each vault's first in-window queue event.
  const firstQ = new Map<
    string,
    { kind: EmitterKind; block: number; which: 'supply' | 'withdraw' }
  >()
  for (const e of events) {
    if (
      (e.kind !== 'mm' && e.kind !== 'ee') ||
      (e.name !== 'SetSupplyQueue' && e.name !== 'SetWithdrawQueue')
    )
      continue
    const which = e.name === 'SetSupplyQueue' ? 'supply' : 'withdraw'
    const k = `${e.emitter}|${which}`
    const cur = firstQ.get(k)
    if (!cur || e.block < cur.block) firstQ.set(k, { kind: e.kind, block: e.block, which })
  }
  const qKeys = [...firstQ.entries()]
  const qLen = await rpc.batch(
    qKeys.map(([k, q]) => call(k.split('|')[0], `${q.which}QueueLength()`, [], q.block - 1)),
  )
  const qItemCalls: { key: string; i: number }[] = []
  qKeys.forEach(([k], i) => {
    const n = Number((dec(['uint256'], qLen[i])?.[0] as bigint | undefined) ?? -1n)
    for (let j = 0; j < n; j++) qItemCalls.push({ key: k, i: j })
  })
  const qItems = await rpc.batch(
    qItemCalls.map(({ key, i }) => {
      const q = firstQ.get(key)!
      return call(key.split('|')[0], `${q.which}Queue(uint256)`, [BigInt(i)], q.block - 1)
    }),
  )
  const baselineSupplyQueue: Record<string, string[]> = {}
  const baselineWithdrawQueue: Record<string, string[]> = {}
  qKeys.forEach(([k], i) => {
    const n = Number((dec(['uint256'], qLen[i])?.[0] as bigint | undefined) ?? -1n)
    if (n < 0) return
    const [vault, which] = k.split('|')
    const ids = qItemCalls.map((c, j) => ({ c, r: qItems[j] })).filter(({ c }) => c.key === k)
    if (ids.some(({ r }) => !r)) return
    // A queue item is one word: a bytes32 market id (MetaMorpho) or an address (Euler Earn).
    const list = ids.map(({ r }) => lc((r as string).slice(0, 66)))
    const norm = kindOf.get(vault) === 'ee' ? list.map((w) => '0x' + w.slice(-40)) : list
    ;(which === 'supply' ? baselineSupplyQueue : baselineWithdrawQueue)[vault] = norm
  })
  // Head reads of every submit (only still-open ones are used).
  const submits = events.filter(
    (e) =>
      (e.kind === 'mm' || e.kind === 'ee') &&
      ['SubmitCap', 'SubmitMarketRemoval', 'SubmitTimelock', 'SubmitGuardian'].includes(e.name),
  )
  const subRes = await rpc.batch(
    submits.map((e) => {
      const idSig = e.kind === 'mm' ? 'bytes32' : 'address'
      if (e.name === 'SubmitCap')
        return call(e.emitter, `pendingCap(${idSig})`, [String(e.args.id)], toBlock)
      if (e.name === 'SubmitMarketRemoval')
        return call(e.emitter, `config(${idSig})`, [String(e.args.id)], toBlock)
      if (e.name === 'SubmitTimelock') return call(e.emitter, 'pendingTimelock()', [], toBlock)
      return call(e.emitter, 'pendingGuardian()', [], toBlock)
    }),
  )
  const chainValidAt: Record<string, number> = {}
  submits.forEach((e, i) => {
    const r = subRes[i]
    if (!r) return
    if (e.name === 'SubmitMarketRemoval') {
      const w = dec(
        e.kind === 'mm'
          ? ['uint256', 'bool', 'uint256']
          : ['uint256', 'uint256', 'bool', 'uint256'],
        r,
      )
      if (w)
        chainValidAt[`${e.emitter}:removal_submit:${String(e.args.id)}`] = Number(
          w[w.length - 1] as bigint,
        )
      return
    }
    const w = dec(['uint256', 'uint256'], r)
    if (!w) return
    const key =
      e.name === 'SubmitCap'
        ? `${e.emitter}:cap_submit:${String(e.args.id)}`
        : e.name === 'SubmitTimelock'
          ? `${e.emitter}:timelock_submit:`
          : `${e.emitter}:guardian_submit:`
    chainValidAt[key] = Number(w[1] as bigint)
  })

  // ── V2: adapters → market ids (for exposure and to map Allocate ids) ──
  const v2Ids: Record<string, V2IdData> = {}
  for (const e of events) {
    if (e.kind !== 'v2') continue
    const idData = typeof e.args.idData === 'string' ? e.args.idData : undefined
    if (idData) v2Ids[v2IdOf(idData)] = decodeV2IdData(idData)
  }
  const v2Vaults = vaultsOf('v2')
  const adLen = await rpc.batch(v2Vaults.map((a) => call(a, 'adaptersLength()')))
  const adCalls: { vault: string; i: number }[] = []
  v2Vaults.forEach((a, i) => {
    const n = Number((dec(['uint256'], adLen[i])?.[0] as bigint | undefined) ?? 0n)
    for (let j = 0; j < Math.min(n, 32); j++) adCalls.push({ vault: a, i: j })
  })
  const adRes = await rpc.batch(
    adCalls.map(({ vault, i }) => call(vault, 'adapters(uint256)', [BigInt(i)])),
  )
  const adaptersOf = new Map<string, string[]>()
  adCalls.forEach(({ vault }, k) => {
    const a = dec(['address'], adRes[k])?.[0] as string | undefined
    if (a) adaptersOf.set(vault, [...(adaptersOf.get(vault) ?? []), a])
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
    const n = dec(['uint256'], adProbe[i * 3])?.[0] as bigint | undefined
    const v1 = dec(['address'], adProbe[i * 3 + 1])?.[0] as string | undefined
    const real = dec(['uint256'], adProbe[i * 3 + 2])?.[0] as bigint | undefined
    adapterKind.set(
      a,
      n !== undefined
        ? { kind: 'market', n: Number(n), real }
        : v1
          ? { kind: 'vault', v1, real }
          : { kind: 'other', real },
    )
  })
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

  // ── Morpho Blue market params for every id we touch ──
  const morphoIds = new Set<string>()
  for (const e of events)
    if (e.kind === 'mm' && typeof e.args.id === 'string') morphoIds.add(e.args.id)
  for (const q of [
    ...Object.entries(baselineWithdrawQueue),
    ...Object.entries(baselineSupplyQueue),
  ])
    if (vaults[q[0]]?.protocol === 'morpho-v1') q[1].forEach((x) => morphoIds.add(x))
  for (const e of events)
    if (e.kind === 'mm' && Array.isArray(e.args.newWithdrawQueue))
      (e.args.newWithdrawQueue as string[]).forEach((x) => morphoIds.add(x))
  for (const e of events)
    if (e.kind === 'mm' && Array.isArray(e.args.newSupplyQueue))
      (e.args.newSupplyQueue as string[]).forEach((x) => morphoIds.add(x))
  for (const ids of marketIdsOfAdapter.values()) ids.forEach((x) => morphoIds.add(x))
  for (const d of Object.values(v2Ids)) if (d.type === 'market') morphoIds.add(d.market)

  // V1 exposure needs the head withdraw queues too.
  const mmVaults = vaultsOf('mm')
  const apiTvl = new Map<string, number>([
    ...apiV1.map((v) => [lc(v.address), v.state?.totalAssetsUsd ?? 0] as const),
    ...apiV2.map((v) => [lc(v.address), v.totalAssetsUsd ?? 0] as const),
  ])
  const exposureV1 = mmVaults.filter(
    (a) =>
      (apiTvl.get(a) ?? 0) >= EXPOSURE_MIN_USD ||
      (!apiTvl.has(a) && (totalAssetsOf.get(a) ?? 0n) > 0n),
  )
  const wqLen = await rpc.batch(
    exposureV1.map((a) => call(a, 'withdrawQueueLength()', [], toBlock)),
  )
  const wqCalls: { vault: string; i: number }[] = []
  exposureV1.forEach((a, i) => {
    const n = Number((dec(['uint256'], wqLen[i])?.[0] as bigint | undefined) ?? 0n)
    for (let j = 0; j < Math.min(n, 64); j++) wqCalls.push({ vault: a, i: j })
  })
  const wqRes = await rpc.batch(
    wqCalls.map(({ vault, i }) => call(vault, 'withdrawQueue(uint256)', [BigInt(i)], toBlock)),
  )
  const headQueue = new Map<string, string[]>()
  wqCalls.forEach(({ vault }, k) => {
    const id = dec(['bytes32'], wqRes[k])?.[0] as string | undefined
    if (id) {
      headQueue.set(vault, [...(headQueue.get(vault) ?? []), id])
      morphoIds.add(id)
    }
  })

  const idList = [...morphoIds]
  const mpRes = await rpc.batch(idList.map((id) => call(MORPHO, 'idToMarketParams(bytes32)', [id])))
  const markets: Entities['markets'] = {}
  idList.forEach((id, i) => {
    const w = dec(['address', 'address', 'address', 'address', 'uint256'], mpRes[i])
    if (w && w[0] !== ZERO)
      markets[id] = {
        loan: w[0] as string,
        collateral: w[1] as string,
        oracle: w[2] as string,
        irm: w[3] as string,
        lltv: String(w[4]),
      }
  })
  for (const d of Object.values(v2Ids)) {
    if (d.type === 'market' && !markets[d.market]) {
      const p = d.marketParams
      markets[d.market] = {
        loan: p.loanToken,
        collateral: p.collateralToken,
        oracle: p.oracle,
        irm: p.irm,
        lltv: p.lltv.toString(),
      }
    }
  }
  // V2 ids derived from adapters (so Allocate/Deallocate ids map to markets).
  for (const [adapter, ids] of marketIdsOfAdapter) {
    for (const mid of ids) {
      const m = markets[mid]
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
  log(`${Object.keys(markets).length} Morpho Blue markets resolved`)

  // ── Euler Earn strategies ──
  const eeVaults = vaultsOf('ee')
  const eeWq = await rpc.batch(eeVaults.map((a) => call(a, 'withdrawQueueLength()', [], toBlock)))
  const eeWqCalls: { vault: string; i: number }[] = []
  eeVaults.forEach((a, i) => {
    const n = Number((dec(['uint256'], eeWq[i])?.[0] as bigint | undefined) ?? 0n)
    for (let j = 0; j < Math.min(n, 64); j++) eeWqCalls.push({ vault: a, i: j })
  })
  const eeWqRes = await rpc.batch(
    eeWqCalls.map(({ vault, i }) => call(vault, 'withdrawQueue(uint256)', [BigInt(i)], toBlock)),
  )
  const eeQueue = new Map<string, string[]>()
  eeWqCalls.forEach(({ vault }, k) => {
    const s = dec(['address'], eeWqRes[k])?.[0] as string | undefined
    if (s) eeQueue.set(vault, [...(eeQueue.get(vault) ?? []), s])
  })
  const strategyAddrs = uniq([
    ...[...eeQueue.values()].flat(),
    ...events
      .filter((e) => e.kind === 'ee' && typeof e.args.id === 'string')
      .map((e) => String(e.args.id)),
  ])
  const stRes = await rpc.batch(
    strategyAddrs.flatMap((s) => [call(s, 'name()'), call(s, 'asset()'), call(s, 'LTVList()')]),
  )
  const strategies: Entities['strategies'] = {}
  const collVaults = new Map<string, string[]>()
  strategyAddrs.forEach((s, i) => {
    const list = (dec(['address[]'], stRes[i * 3 + 2])?.[0] as string[] | undefined) ?? []
    collVaults.set(s, list)
    strategies[s] = {
      name: (dec(['string'], stRes[i * 3])?.[0] as string) ?? s,
      asset: lc((dec(['address'], stRes[i * 3 + 1])?.[0] as string) ?? ZERO),
      collateral: [],
    }
  })
  const cvs = uniq([...collVaults.values()].flat())
  const cvRes = await rpc.batch(cvs.map((c) => call(c, 'asset()')))
  const cvAsset = new Map<string, string>()
  cvs.forEach((c, i) => {
    const a = dec(['address'], cvRes[i])?.[0] as string | undefined
    if (a) cvAsset.set(c, a)
  })
  for (const [s, list] of collVaults)
    strategies[s].collateral = uniq(
      list.map((c) => cvAsset.get(c)).filter((x): x is string => Boolean(x)),
    )

  // ── classify ──
  const ctx: ClassifyContext = {
    collateralOf: (protocol, scope, target) => {
      if (scope === 'market') {
        const m = markets[target]
        return m && m.collateral !== ZERO ? [m.collateral] : []
      }
      if (scope === 'strategy') return strategies[target]?.collateral ?? []
      return []
    },
    prevCap: (vault, target, block) => prevCapMap.get(`${vault}|${target}|${block}`),
    timelockAt,
    baselineSupplyQueue,
    baselineWithdrawQueue,
    chainValidAt,
    v2Ids,
    publicAllocators: { mm: MORPHO_PA, ee: EULER_PA },
    isV2Allocator: (vault, sender) => Boolean(everAllocator.get(vault)?.has(sender)),
  }
  const { actions, reallocations, stats } = classifyEvents(events, ctx)
  for (const a of actions) if (a.protocol !== 'aave-v3' && !a.loan) a.loan = vaults[a.vault]?.asset
  log(
    `actions ${actions.length}; reallocation legs ${reallocations.length}; stats ${JSON.stringify(stats)}`,
  )

  // ── exit context: what each vault still had capped in the same collateral ──
  // Read at the exit's block (state after the whole block). V1 / Euler Earn: the withdraw
  // queue and each entry's cap; Vault V2: the collateral cap and every other market cap of
  // that collateral on the vault's adapters.
  const exits = actions.filter(
    (a) => EXIT_KINDS.has(a.kind) && a.collateral.length === 1 && a.protocol !== 'aave-v3',
  )
  {
    const v1Exits = exits.filter((a) => a.protocol !== 'morpho-v2')
    const keyOf = (a: { vault: string; block: number }) => `${a.vault}|${a.block}`
    const qKeys2 = uniq(v1Exits.map(keyOf))
    const lenRes = await rpc.batch(
      qKeys2.map((k) =>
        call(k.split('|')[0], 'withdrawQueueLength()', [], Number(k.split('|')[1])),
      ),
    )
    const itemCalls: { key: string; i: number }[] = []
    qKeys2.forEach((k, i) => {
      const n = Number((dec(['uint256'], lenRes[i])?.[0] as bigint | undefined) ?? -1n)
      for (let j = 0; j < Math.min(n, 64); j++) itemCalls.push({ key: k, i: j })
    })
    const itemRes = await rpc.batch(
      itemCalls.map(({ key, i }) =>
        call(key.split('|')[0], 'withdrawQueue(uint256)', [BigInt(i)], Number(key.split('|')[1])),
      ),
    )
    const items = new Map<string, string[]>()
    itemCalls.forEach(({ key }, j) => {
      const r = itemRes[j]
      if (!r) return
      const w = lc(r.slice(0, 66))
      const id = kindOf.get(key.split('|')[0]) === 'ee' ? '0x' + w.slice(-40) : w
      items.set(key, [...(items.get(key) ?? []), id])
    })
    const capCalls = [...items.entries()].flatMap(([key, ids]) => ids.map((id) => ({ key, id })))
    const capRes3 = await rpc.batch(
      capCalls.map(({ key, id }) =>
        call(
          key.split('|')[0],
          kindOf.get(key.split('|')[0]) === 'ee' ? 'config(address)' : 'config(bytes32)',
          [id],
          Number(key.split('|')[1]),
        ),
      ),
    )
    const capAt = new Map<string, bigint>()
    capCalls.forEach(({ key, id }, j) => {
      const ee = kindOf.get(key.split('|')[0]) === 'ee'
      const w = dec(
        ee ? ['uint256', 'uint256', 'bool', 'uint256'] : ['uint256', 'bool', 'uint256'],
        capRes3[j],
      )
      if (w) capAt.set(`${key}|${id}`, (ee ? w[1] : w[0]) as bigint)
    })
    // Queue entries can be markets never seen in events or at the head: resolve them too.
    const unknownIds = uniq(
      [...items.entries()]
        .filter(([k]) => kindOf.get(k.split('|')[0]) === 'mm')
        .flatMap(([, ids]) => ids),
    ).filter((id) => !markets[id])
    const upRes = await rpc.batch(
      unknownIds.map((id) => call(MORPHO, 'idToMarketParams(bytes32)', [id])),
    )
    unknownIds.forEach((id, i) => {
      const w = dec(['address', 'address', 'address', 'address', 'uint256'], upRes[i])
      if (w && w[0] !== ZERO)
        markets[id] = {
          loan: w[0] as string,
          collateral: w[1] as string,
          oracle: w[2] as string,
          irm: w[3] as string,
          lltv: String(w[4]),
        }
    })
    for (const a of v1Exits) {
      const key = keyOf(a)
      const ids = items.get(key)
      if (!ids) continue
      const c = a.collateral[0]
      const others = ids.filter(
        (id) =>
          id !== a.target &&
          ctx
            .collateralOf(a.protocol, a.protocol === 'euler-earn' ? 'strategy' : 'market', id)
            .map(lc)
            .includes(lc(c)),
      )
      if (others.some((id) => !capAt.has(`${key}|${id}`))) continue
      a.stillCapped = others.some((id) => (capAt.get(`${key}|${id}`) ?? 0n) > 0n)
    }
    // Vault V2.
    const v2Exits = exits.filter((a) => a.protocol === 'morpho-v2')
    const v2Calls: { a: (typeof v2Exits)[number]; ids: string[] }[] = v2Exits.map((a) => {
      const c = lc(a.collateral[0])
      const mine = new Set(adaptersOf.get(a.vault) ?? [])
      const marketIds = Object.entries(v2Ids)
        .filter(
          ([id, d]) =>
            d.type === 'market' &&
            mine.has(d.adapter) &&
            lc(d.marketParams.collateralToken) === c &&
            id !== a.target,
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
        const abs = dec(['uint256'], v2Res[k++])?.[0] as bigint | undefined
        const rel = dec(['uint256'], v2Res[k++])?.[0] as bigint | undefined
        return abs === undefined || rel === undefined ? undefined : abs > 0n && rel > 0n
      })
      if (open.some((x) => x === undefined)) continue
      // The collateral cap itself is the exit → nothing left; else it must be open AND
      // another market of that collateral must be open.
      a.stillCapped =
        a.scope === 'collateral' ? false : Boolean(open[0]) && open.slice(1).some(Boolean)
    }
    log(
      `exit context: ${exits.length} exits, ${exits.filter((a) => a.stillCapped === true).length} still capped elsewhere, ${exits.filter((a) => a.stillCapped === false).length} last cap, ${exits.filter((a) => a.stillCapped === undefined).length} unread`,
    )
  }

  // ── tokens: every address we will render ──
  const tokenAddrs = uniq(
    [
      ...Object.values(vaults).map((v) => v.asset),
      ...Object.values(markets).flatMap((m) => [m.loan, m.collateral]),
      ...Object.values(strategies).flatMap((s) => [s.asset, ...s.collateral]),
      ...actions.flatMap((a) => a.collateral),
      ...Object.values(v2Ids).flatMap((d) => (d.type === 'collateral' ? [d.collateral] : [])),
    ]
      .filter((x) => x && x !== ZERO)
      .map(lc),
  )
  const need = tokenAddrs.filter((t) => !tokens[t])
  const tkRes = await rpc.batch(need.flatMap((t) => [call(t, 'symbol()'), call(t, 'decimals()')]))
  need.forEach((t, i) => {
    let symbol = dec(['string'], tkRes[i * 2])?.[0] as string | undefined
    if (symbol === undefined && tkRes[i * 2] && (tkRes[i * 2] as string).length === 66) {
      symbol = new TextDecoder().decode(
        Uint8Array.from(
          ((tkRes[i * 2] as string).slice(2).match(/../g) ?? [])
            .map((b) => parseInt(b, 16))
            .filter((b) => b !== 0),
        ),
      )
    }
    tokens[t] = {
      symbol: symbol ?? t.slice(0, 8),
      decimals: Number((dec(['uint256'], tkRes[i * 2 + 1])?.[0] as bigint | undefined) ?? 18n),
    }
  })
  for (const grp of chunked(tokenAddrs, 100)) {
    // The Morpho API rejects address_in lists longer than 100 (measured 2026-10-07).
    const d = await gql<{
      assets: { items: { address: string; price: { usd: number | null } | null }[] }
    }>(
      `{ assets(first: 500, where: { chainId_in: [1], address_in: [${grp.map((a) => `"${a}"`).join(',')}] }) { items { address price { usd } } } }`,
    )
    for (const it of d?.assets.items ?? [])
      if (tokens[lc(it.address)] && it.price?.usd != null)
        tokens[lc(it.address)].priceUsd = it.price.usd
  }
  // Pendle PT maturity: expiry() on every exit collateral (reverts / 0x on other tokens).
  const exitTokens = uniq(exits.map((a) => lc(a.collateral[0])))
  const expRes = await rpc.batch(exitTokens.map((t) => call(t, 'expiry()')))
  exitTokens.forEach((t, i) => {
    const e = dec(['uint256'], expRes[i])?.[0] as bigint | undefined
    if (e !== undefined && e > 1_500_000_000n && e < 4_000_000_000n && tokens[t])
      tokens[t].expiry = Number(e)
  })
  const usd = (token: string | undefined, amount: bigint): number | undefined => {
    const t = token ? tokens[lc(token)] : undefined
    if (!t?.priceUsd) return undefined
    return (Number(amount) / 10 ** t.decimals) * t.priceUsd
  }

  // ── flows ──
  const netted = netPerTx(reallocations)
  const flows = aggregateDaily(netted)
  log(`flows: ${netted.length} netted legs → ${flows.length} daily rows`)

  // ── exposure (head) ──
  const exposure: ExposureVault[] = []
  const v1Pairs = [...headQueue.entries()].flatMap(([vault, ids]) =>
    ids.map((id) => ({ vault, id })),
  )
  const posRes = await rpc.batch(
    v1Pairs.flatMap(({ vault, id }) => [
      call(MORPHO, 'position(bytes32,address)', [id, vault], toBlock),
      call(vault, 'config(bytes32)', [id], toBlock),
    ]),
  )
  const mktIds = uniq(v1Pairs.map((p) => p.id).concat([...marketIdsOfAdapter.values()].flat()))
  const mktRes = await rpc.batch(mktIds.map((id) => call(MORPHO, 'market(bytes32)', [id], toBlock)))
  const mktState = new Map<string, bigint[]>()
  mktIds.forEach((id, i) => {
    const w = dec(['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'], mktRes[i])
    if (w) mktState.set(id, w as bigint[])
  })
  const v1Alloc = new Map<string, ExposureAlloc[]>()
  v1Pairs.forEach(({ vault, id }, i) => {
    const pos = dec(['uint256', 'uint256', 'uint256'], posRes[i * 2])
    const cfg = dec(['uint256', 'bool', 'uint256'], posRes[i * 2 + 1])
    const st = mktState.get(id)
    if (!pos || !st) return
    const assets = toAssetsDown(pos[0] as bigint, st[0], st[1])
    const m = markets[id]
    const list = v1Alloc.get(vault) ?? []
    list.push({
      target: id,
      scope: 'market',
      collateral: m && m.collateral !== ZERO ? [lc(m.collateral)] : [],
      assets: assets.toString(),
      usd: usd(m?.loan, assets),
      share: 0,
      cap: cfg ? String(cfg[0]) : undefined,
    })
    v1Alloc.set(vault, list)
  })
  const finish = (vault: string, protocol: Protocol, allocs: ExposureAlloc[], total: bigint) => {
    const sum = allocs.reduce((s, a) => s + BigInt(a.assets), 0n)
    const den = total > sum ? total : sum
    for (const a of allocs)
      a.share = den === 0n ? 0 : Number((BigInt(a.assets) * 1_000_000n) / den) / 1e6
    const nonzero = allocs
      .filter((a) => BigInt(a.assets) > 0n)
      .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
    exposure.push({
      vault,
      protocol,
      totalAssets: total.toString(),
      totalUsd: usd(vaults[vault]?.asset, total),
      allocations: nonzero,
    })
  }
  for (const [vault, allocs] of v1Alloc)
    finish(vault, 'morpho-v1', allocs, totalAssetsOf.get(vault) ?? 0n)

  // V2: market adapters → expectedSupplyAssets per market; V1-vault adapters → look through.
  const v2Exposure = v2Vaults.filter(
    (a) =>
      (apiTvl.get(a) ?? 0) >= EXPOSURE_MIN_USD ||
      (!apiTvl.has(a) && (totalAssetsOf.get(a) ?? 0n) > 0n),
  )
  const v2MktCalls = v2Exposure.flatMap((vault) =>
    (adaptersOf.get(vault) ?? [])
      .filter((a) => adapterKind.get(a)?.kind === 'market')
      .flatMap((adapter) =>
        (marketIdsOfAdapter.get(adapter) ?? []).map((id) => ({ vault, adapter, id })),
      ),
  )
  const v2MktRes = await rpc.batch(
    v2MktCalls.map(({ adapter, id }) =>
      call(adapter, 'expectedSupplyAssets(bytes32)', [id], toBlock),
    ),
  )
  const v2Alloc = new Map<string, ExposureAlloc[]>()
  v2MktCalls.forEach(({ vault, adapter, id }, i) => {
    const assets = (dec(['uint256'], v2MktRes[i])?.[0] as bigint | undefined) ?? 0n
    const m = markets[id]
    v2Alloc.set(vault, [
      ...(v2Alloc.get(vault) ?? []),
      {
        target: id,
        scope: 'market',
        collateral: m && m.collateral !== ZERO ? [lc(m.collateral)] : [],
        assets: assets.toString(),
        usd: usd(m?.loan, assets),
        share: 0,
        via: adapter,
      },
    ])
  })
  for (const vault of v2Exposure) {
    for (const adapter of adaptersOf.get(vault) ?? []) {
      const k = adapterKind.get(adapter)
      if (k?.kind !== 'vault' || !k.v1 || k.real === undefined || k.real === 0n) continue
      const inner = exposure.find((x) => x.vault === lc(k.v1!))
      const innerTotal = inner ? BigInt(inner.totalAssets) : 0n
      if (!inner || innerTotal === 0n) {
        v2Alloc.set(vault, [
          ...(v2Alloc.get(vault) ?? []),
          {
            target: lc(k.v1),
            scope: 'market',
            collateral: [],
            assets: k.real.toString(),
            usd: usd(vaults[vault]?.asset, k.real),
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
            usd: usd(vaults[vault]?.asset, part),
            share: 0,
            via: lc(k.v1),
            cap: undefined,
          },
        ])
      }
    }
  }
  for (const vault of v2Exposure)
    finish(vault, 'morpho-v2', v2Alloc.get(vault) ?? [], totalAssetsOf.get(vault) ?? 0n)

  // Euler Earn: config(strategy).balance (strategy shares) → convertToAssets.
  const eePairs = [...eeQueue.entries()].flatMap(([vault, ss]) => ss.map((s) => ({ vault, s })))
  const eeCfg = await rpc.batch(
    eePairs.map(({ vault, s }) => call(vault, 'config(address)', [s], toBlock)),
  )
  const eeConv = await rpc.batch(
    eePairs.map(({ s }, i) => {
      const w = dec(['uint256', 'uint256', 'bool', 'uint256'], eeCfg[i])
      return call(s, 'convertToAssets(uint256)', [(w?.[0] as bigint | undefined) ?? 0n], toBlock)
    }),
  )
  const eeAlloc = new Map<string, ExposureAlloc[]>()
  eePairs.forEach(({ vault, s }, i) => {
    const w = dec(['uint256', 'uint256', 'bool', 'uint256'], eeCfg[i])
    const assets = (dec(['uint256'], eeConv[i])?.[0] as bigint | undefined) ?? 0n
    eeAlloc.set(vault, [
      ...(eeAlloc.get(vault) ?? []),
      {
        target: s,
        scope: 'strategy',
        collateral: (strategies[s]?.collateral ?? []).map(lc),
        assets: assets.toString(),
        usd: usd(vaults[vault]?.asset, assets),
        share: 0,
        cap: w ? String(w[1]) : undefined,
      },
    ])
  })
  for (const [vault, allocs] of eeAlloc) {
    const total = totalAssetsOf.get(vault) ?? 0n
    if ((usd(vaults[vault]?.asset, total) ?? 0) < EXPOSURE_MIN_USD) continue
    finish(vault, 'euler-earn', allocs, total)
  }
  log(`exposure: ${exposure.length} vaults`)

  // ── attribution ──
  const loanOfTarget = (r: Reallocation) => markets[r.target]?.loan ?? vaults[r.vault]?.asset
  const cases: AttributionCase[] = selectLargeWithdrawals(
    reallocations,
    (l) => usd(loanOfTarget(l), l.assets),
    (t) => Boolean(markets[t]),
    LARGE_WITHDRAW_USD,
  )
  log(
    `attribution: ${cases.length} (market, block) cases ≥ $${LARGE_WITHDRAW_USD.toLocaleString()}`,
  )
  // Phase 1: market(id) at the end of b−1 and b for every candidate.
  const stCalls = cases.flatMap((c) => [
    call(MORPHO, 'market(bytes32)', [c.market], c.block - 1),
    call(MORPHO, 'market(bytes32)', [c.market], c.block),
  ])
  const stRes2 = await rpc.batch(stCalls, 30)
  const words = new Map<number, [bigint[] | null, bigint[] | null]>()
  cases.forEach((c, i) => {
    const w0 = dec(
      ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
      stRes2[i * 2],
    ) as bigint[] | null
    const w1 = dec(
      ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
      stRes2[i * 2 + 1],
    ) as bigint[] | null
    words.set(i, [w0, w1])
    if (w0) c.before = { totalSupplyAssets: String(w0[0]), totalBorrowAssets: String(w0[2]) }
    if (w1) c.after = { totalSupplyAssets: String(w1[0]), totalBorrowAssets: String(w1[2]) }
  })
  // Phase 2: IRM rates only where the block moved the market (supply −5% or more, or
  // utilization ending ≥ 85%); a 1% supply move on a deep market cannot spike the rate.
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
    const m = markets[c.market]
    if (!m || m.irm === ZERO || !moved(i)) return
    for (const side of [0, 1] as const) {
      const w = words.get(i)?.[side]
      if (!w) continue
      irmCalls.push({ i, side })
      const data =
        sel(
          'borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128))',
        ) +
        [m.loan, m.collateral, m.oracle, m.irm].map(pad).join('') +
        pad(BigInt(m.lltv)) +
        w.map(pad).join('')
      irmReq.push({
        method: 'eth_call',
        params: [{ to: m.irm, data }, hexN(side === 0 ? c.block - 1 : c.block)],
      })
    }
  })
  const irmRes = await rpc.batch(irmReq, 30)
  irmCalls.forEach(({ i, side }, k) => {
    const r = dec(['uint256'], irmRes[k])?.[0] as bigint | undefined
    const s = cases[i][side === 0 ? 'before' : 'after']
    if (s && r !== undefined) s.borrowRate = r.toString()
  })
  // Keep the cases that moved the market: supply −20% or more, a rate spike, or drained.
  const examined = cases.length
  const kept = cases.filter((c) => {
    const a = attribute(c)
    if (!a) return false
    const drop =
      a.supplyBefore > 0n ? Number((-a.supplyDelta * 10_000n) / a.supplyBefore) / 10_000 : 0
    return drop >= KEPT_SUPPLY_DROP || a.spike || a.drained
  })
  log(
    `attribution: kept ${kept.length} of ${examined} (supply −${KEPT_SUPPLY_DROP * 100}%+, spike, or drained); ${irmReq.length} IRM reads`,
  )

  // ── keep only the entities the dataset references ──
  const usedVaults = new Set([
    ...actions.map((a) => a.vault),
    ...flows.map((f) => f.vault),
    ...exposure.map((x) => x.vault),
    ...kept.flatMap((c) => c.legs.map((l) => l.vault)),
  ])
  const keptVaults = Object.fromEntries(Object.entries(vaults).filter(([a]) => usedVaults.has(a)))
  const usedV2Ids = new Set(
    actions.filter((a) => a.protocol === 'morpho-v2').map((a) => a.target ?? ''),
  )
  const keptV2Ids: Entities['v2Ids'] = {}
  for (const [id, d] of Object.entries(v2Ids)) {
    if (!usedV2Ids.has(id)) continue
    keptV2Ids[id] =
      d.type === 'collateral'
        ? { type: 'collateral', collateral: d.collateral }
        : d.type === 'market'
          ? {
              type: 'market',
              market: d.market,
              adapter: d.adapter,
              collateral: d.marketParams.collateralToken,
            }
          : d.type === 'adapter'
            ? { type: 'adapter', adapter: d.adapter }
            : { type: 'adapter' }
  }
  const usedMarkets = new Set([
    ...actions.map((a) => a.target ?? ''),
    ...flows.map((f) => f.target),
    ...exposure.flatMap((x) => x.allocations.map((a) => a.target)),
    ...kept.map((c) => c.market),
    ...Object.values(keptV2Ids).map((d) => d.market ?? ''),
  ])
  const keptMarkets = Object.fromEntries(
    Object.entries(markets).filter(([id]) => usedMarkets.has(id)),
  )
  const usedTokens = new Set<string>([
    ...Object.values(keptVaults).map((v) => v.asset),
    ...Object.values(keptMarkets).flatMap((m) => [lc(m.loan), lc(m.collateral)]),
    ...actions.flatMap((a) => a.collateral.map(lc)),
    ...exposure.flatMap((x) => x.allocations.flatMap((a) => a.collateral)),
    ...Object.values(strategies).flatMap((s) => [s.asset, ...s.collateral.map(lc)]),
  ])
  const keptTokens = Object.fromEntries(Object.entries(tokens).filter(([a]) => usedTokens.has(a)))
  const usedCurators = new Set([
    ...Object.values(keptVaults).map((v) => v.curatorKey),
    ...Object.keys(curators).filter((k) => k.startsWith('aave:')),
  ])
  const keptCurators = Object.fromEntries(
    Object.entries(curators).filter(([k]) => usedCurators.has(k)),
  )
  const usedStrategies = new Set([
    ...actions.map((a) => a.target ?? ''),
    ...exposure.flatMap((x) => x.allocations.map((a) => a.target)),
  ])
  const keptStrategies = Object.fromEntries(
    Object.entries(strategies).filter(([s]) => usedStrategies.has(s)),
  )

  const entities: Entities = {
    tokens: keptTokens,
    markets: keptMarkets,
    vaults: keptVaults,
    curators: keptCurators,
    strategies: keptStrategies,
    aaveMarkets: AAVE,
    v2Ids: keptV2Ids,
  }

  const feed: FeedFile = {
    meta: {
      schema: SCHEMA,
      chainId: 1,
      fromBlock,
      toBlock,
      fromTs,
      toTs,
      collectedAt: new Date().toISOString(),
      endpoints: rpc.endpoints.map((e) => e.label),
      logs: rpc.logStats,
      counts: {
        actions: actions.length,
        reallocationLegs: reallocations.length,
        nettedLegs: netted.length,
        flowRows: flows.length,
        exposureVaults: exposure.length,
        attributionCandidates: examined,
        attributionCases: kept.length,
        verifiedMetaMorpho: vaultsOf('mm').length,
        verifiedVaultV2: vaultsOf('v2').length,
        verifiedEulerEarn: vaultsOf('ee').length,
        unverifiedEmittersDropped: unverified.length,
        malformedLogs: malformed,
        rpcCalls: rpc.calls,
        ...stats,
      },
      thresholds: {
        largeWithdrawUsd: LARGE_WITHDRAW_USD,
        exposureMinUsd: EXPOSURE_MIN_USD,
        keptSupplyDrop: KEPT_SUPPLY_DROP,
      },
      sources: [
        'Ethereum mainnet logs and eth_call (archive) — events listed in lib/curatorFeed/abi.ts',
        'Morpho API (blue-api.morpho.org): vault list, curator registry names, USD prices at collection time',
        'Euler labels (github.com/euler-xyz/euler-labels 1/entities.json): Euler curator names',
      ],
      caveats: [
        'USD figures use prices at collection time, not at the time of each action.',
        'Curator identity is the vault’s CURRENT curator (or owner when no curator is set), named via the registries above; an unnamed curator is shown by address.',
        'Vault V2 allocator moves are Allocate/Deallocate events whose sender was ever set as an allocator of that vault; deposit-path allocations are excluded.',
        'Public Allocator reallocations are MetaMorpho / Euler Earn reallocation legs whose caller is the Public Allocator contract.',
        'A submitted change that was executed in the same transaction (zero timelock) is shown once, as the executed change.',
        'Attribution compares market state at the end of block b−1 and block b; other transactions in block b are included in the difference. Kept: net vault withdrawals ≥ $1M in a block that cut market supply by ≥ 20%, spiked the borrow rate (≥ 1.5× and ≥ +2 APR points), or left utilization ≥ 99%.',
        'Daily flows are netted per transaction (a withdraw-and-resupply of one market inside one call nets out) and stored in whole loan-token units rounded to 6 significant digits.',
        'Exposure lists vaults with at least $100k (Morpho API TVL, or on-chain total assets when the API has no figure).',
        'Euler Earn strategies can accept several collaterals; their exits are listed but not counted in collateral clusters.',
        'A cluster counts an exit only when the vault kept no other market with that collateral capped, read at the exit block (Vault V2: the collateral cap and another market cap of that collateral both open); PT exits within 14 days of maturity are excluded as roll-offs.',
      ],
    },
    entities,
    actions,
    attribution: kept,
  }
  const flowsFile: FlowsFile = encodeFlows(
    flows,
    toBlock,
    (vault) => tokens[vaults[vault]?.asset ?? '']?.decimals ?? 18,
  )
  const exposureFile: ExposureFile = { schema: SCHEMA, block: toBlock, ts: toTs, vaults: exposure }

  mkdirSync(OUT_DIR, { recursive: true })
  const write = (name: string, obj: unknown) => {
    const s = JSON.stringify(obj)
    writeFileSync(join(OUT_DIR, name), s + '\n')
    return s.length
  }
  const sizes = {
    feed: write('feed.json', encodeFeedFile(feed)),
    flows: write('flows.json', flowsFile),
    exposure: write('exposure.json', exposureFile),
  }
  log(
    `wrote ${Object.entries(sizes)
      .map(([k, v]) => `${k} ${(v / 1e6).toFixed(2)} MB`)
      .join(', ')} in ${((Date.now() - t0) / 60000).toFixed(1)} min`,
  )
  log(`getLogs: ${JSON.stringify(rpc.logStats)}`)
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`[curator-feed] failed: ${rpc.scrub(String(e?.stack ?? e))}`)
    process.exit(1)
  },
)
