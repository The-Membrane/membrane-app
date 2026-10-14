/**
 * Scope step: every Aave V3 pool and every Morpho Blue deployment on mainnet, Arbitrum,
 * Optimism and Base, and every LiquidationCall / Liquidate they emitted in the window
 * 2025-10-10T00:00:00Z .. 2025-10-11T23:59:59Z, diffed against the owner's CSVs.
 *
 *  - Aave markets: each chain's PoolAddressesProviderRegistry (getAddressesProvidersList at the
 *    window's first and last minute blocks); per provider getMarketId / getPool / getPriceOracle /
 *    getPoolDataProvider at both ends. Morpho Blue: the per-chain singleton (owner() answers).
 *  - Logs: ONE topic-only scan per chain (LiquidationCall OR Liquidate, any emitter), so a pool
 *    missing from a registry still shows up as an emitter. Every chain is scanned in full on two
 *    independent backend groups (Pocket excluded: it answers false empties; the builder relays
 *    are never in the pool); the two answers must be identical, a third group breaks a tie; every
 *    empty chunk of one host is confirmed by another host's scan of the same blocks; a log only
 *    one backend returned is confirmed from its transaction receipt on another group.
 *  - Emitters are classified on chain: ADDRESSES_PROVIDER() in the registry = Aave V3 market;
 *    ADDRESSES_PROVIDER() elsewhere = a V3 fork; getAddressesProvider() = Aave V2 or a V2 fork;
 *    the Morpho singleton = Morpho Blue. Out-of-scope emitters are listed, not used.
 */
import { join } from 'path'
import {
  AAVE_REGISTRY,
  ADDRESSES,
  LIQUIDATION_CALL_TOPIC,
  MORPHO_BY_CHAIN,
  MORPHO_LIQUIDATE_TOPIC,
  morphoAbi,
  poolAbi,
  poolV2Abi,
  providerAbi,
  registryAbi,
} from './abi'
import { header, START_TS, STEPS, type Ctx } from './ctx'
import { aaveEvents, morphoEvents } from './inputs'
import { logBody, scanLogs, type RawLog, type ScanResult } from './logs'
import { findLastLE, loadMinuteBlocks } from './minuteBlocks'
import { CHAINS, type ChainKey } from './rpc'
import { setupMulticall } from './setupCall'
import { pmap, readJson, writeJson } from './store'

const OUT = 'events-scan'
export const END_TS = 1760227199 // 2025-10-11T23:59:59Z
const lc = (s: string) => s.toLowerCase()
const addr = (topic: string) => '0x' + topic.slice(26)
const word = (data: string, i: number) => BigInt('0x' + data.slice(2 + 64 * i, 2 + 64 * (i + 1)))

export interface ScopeMarket {
  chain: ChainKey
  key: string
  provider: string
  marketId: string
  pool: string
  oracle: string
  dataProvider: string
  inRegistryStart: boolean
  inRegistryEnd: boolean
}
export interface AaveLiq {
  chain: ChainKey
  pool: string
  block_number: number
  ts: number
  tx_hash: string
  log_index: number
  collateral_asset: string
  debt_asset: string
  user: string
  debt_to_cover_raw: string
  liquidated_collateral_raw: string
  liquidator: string
  receive_atoken: boolean
}
export interface MorphoLiq {
  chain: ChainKey
  morpho: string
  block_number: number
  ts: number
  tx_hash: string
  log_index: number
  market_id: string
  caller: string
  borrower: string
  repaid_assets: string
  repaid_shares: string
  seized_assets: string
  bad_debt_assets: string
  bad_debt_shares: string
}
export interface ScopeState {
  ranges: Record<string, { from: number; to: number; fromTs: number; toTs: number }>
  markets: ScopeMarket[]
  morpho: Record<string, string>
  /** In-scope on-chain events NOT in the owner's CSVs. */
  extraAave: (AaveLiq & { market: string })[]
  extraMorpho: MorphoLiq[]
}

function marketKey(chain: ChainKey, provider: string, marketId: string, taken: Set<string>) {
  if (lc(provider) === lc(ADDRESSES[chain].provider)) return 'core'
  let k = lc(marketId)
    .replace(/aave|ethereum|arbitrum|optimism|base|market|v3/g, '')
    .replace(/[^a-z0-9]/g, '')
  if (!k || taken.has(k)) k = 'p' + lc(provider).slice(2, 8)
  taken.add(k)
  return k
}

/** Window block range: first block with ts >= START_TS .. last block with ts <= END_TS. */
async function windowRange(ctx: Ctx, chain: ChainKey) {
  const blocks = loadMinuteBlocks(ctx, chain)
  const rate = (blocks[STEPS - 1] - blocks[0]) / (60 * (STEPS - 1))
  const s = await findLastLE(ctx, chain, START_TS - 1, blocks[0], rate)
  const e = await findLastLE(ctx, chain, END_TS, blocks[STEPS - 1] + 59 * rate, rate)
  if (!(s.lo.ts < START_TS && s.hi.ts >= START_TS && e.lo.ts <= END_TS && e.hi.ts > END_TS))
    throw new Error(`${chain}: window range check failed`)
  return { from: s.hi.n, to: e.lo.n, fromTs: s.hi.ts, toTs: e.lo.ts }
}

async function discoverMarkets(ctx: Ctx, chain: ChainKey) {
  const blocks = loadMinuteBlocks(ctx, chain)
  const b0 = blocks[0]
  const bEnd = blocks[STEPS - 1]
  const reg = AAVE_REGISTRY[chain]
  const list = async (b: number) => {
    const r = await setupMulticall(
      ctx,
      OUT,
      chain,
      [{ target: reg, abi: registryAbi, fn: 'getAddressesProvidersList' }],
      b,
    )
    if (!r[0].ok) throw new Error(`${chain}: registry ${reg} did not answer`)
    return (r[0].value as string[])
      .map(lc)
      .filter((a) => a !== '0x0000000000000000000000000000000000000000')
  }
  const l0 = await list(b0)
  const l1 = await list(bEnd)
  if (!l0.includes(lc(ADDRESSES[chain].provider)))
    throw new Error(`${chain}: core provider not in the registry list`)
  const providers = [...new Set([...l0, ...l1])]
  const taken = new Set<string>()
  const out: ScopeMarket[] = []
  for (const p of providers) {
    const read = async (b: number) => {
      const r = await setupMulticall(
        ctx,
        OUT,
        chain,
        (['getMarketId', 'getPool', 'getPriceOracle', 'getPoolDataProvider'] as const).map(
          (fn) => ({ target: p, abi: providerAbi, fn }),
        ),
        b,
      )
      return r.map((x) => (x.ok ? String(x.value) : ''))
    }
    const [id0, pool0, or0, dp0] = await read(b0)
    const [, pool1, or1, dp1] = await read(bEnd)
    if (lc(pool0) !== lc(pool1) || lc(or0) !== lc(or1) || lc(dp0) !== lc(dp1))
      throw new Error(`${chain} provider ${p}: pool/oracle/data provider changed in the window`)
    out.push({
      chain,
      key: marketKey(chain, p, id0, taken),
      provider: p,
      marketId: id0,
      pool: lc(pool0),
      oracle: lc(or0),
      dataProvider: lc(dp0),
      inRegistryStart: l0.includes(p),
      inRegistryEnd: l1.includes(p),
    })
  }
  return out
}

interface BackendScan {
  host: string
  group: string
  res: ScanResult
}

const TOPICS = [[LIQUIDATION_CALL_TOPIC, MORPHO_LIQUIDATE_TOPIC]]

/**
 * Two independent full scans of the in-scope emitters (a third on disagreement), empty chunks
 * cross-confirmed. The address list comes from the registries and the Morpho singleton, read on
 * chain, so it does not depend on either log backend.
 */
async function scanChain(ctx: Ctx, chain: ChainKey, from: number, to: number, address: string[]) {
  const filter = { address, topics: TOPICS }
  const order = [
    'tenderly',
    'nownodes',
    'arb-official',
    'op-official',
    'drpc',
    'thirdweb',
    'blockpi',
    'base-official',
    'tatum',
    'onfinality',
  ]
  const rank = (g: string) => (order.includes(g) ? order.indexOf(g) : order.length)
  const hosts = ctx.pool.logEndpoints(chain).filter((h) => h.group !== 'pokt')
  const groups = [...new Set(hosts.map((h) => h.group))].sort((a, b) => rank(a) - rank(b))
  const scans: BackendScan[] = []
  const attempts: Record<string, unknown>[] = []
  const bodies = (s: BackendScan) => new Set(s.res.logs.map(logBody))
  const same = (a: BackendScan, b: BackendScan) => {
    const x = bodies(a)
    const y = bodies(b)
    return x.size === y.size && [...x].every((k) => y.has(k))
  }
  for (const g of groups) {
    if (scans.length >= 3) break
    if (scans.length >= 2 && scans.every((s) => same(s, scans[0]))) break
    for (const h of hosts.filter((x) => x.group === g)) {
      // Slow free tiers rate-limit hard: be patient (progress is checkpointed per chunk).
      const r = await scanLogs(ctx, chain, h.host, filter, from, to, {
        rateStrikes: 30,
        maxCalls: 1500,
      })
      if ('error' in r) {
        attempts.push({ host: h.host, group: g, error: r.error })
        continue
      }
      scans.push({ host: h.host, group: g, res: r })
      attempts.push({ host: h.host, group: g, calls: r.calls, logs: r.logs.length, span: r.span })
      break
    }
  }
  if (scans.length < 2) throw new Error(`${chain}: fewer than two backends completed the log scan`)
  // Support per log, union.
  const support = new Map<string, { log: RawLog; hosts: string[] }>()
  for (const s of scans)
    for (const l of s.res.logs) {
      const k = logBody(l)
      const v = support.get(k) ?? { log: l, hosts: [] }
      v.hosts.push(s.host)
      support.set(k, v)
    }
  // A log only one backend returned: confirm it from its receipt on another group.
  const single = [...support.values()].filter((v) => v.hosts.length < 2)
  const receiptChecks: Record<string, unknown>[] = []
  for (const v of single) {
    const g = scans.find((s) => s.host === v.hosts[0])!.group
    const rc = await ctx.pool.request(chain, 'eth_getTransactionReceipt', [v.log.tx], {
      excludeGroups: [g],
    })
    const logs = (
      rc.result as { logs: { logIndex: string; address: string; topics: string[]; data: string }[] }
    ).logs
    const ok = logs.some(
      (l) =>
        Number(BigInt(l.logIndex)) === v.log.logIndex &&
        lc(l.address) === v.log.address &&
        l.topics.map(lc).join(',') === v.log.topics.join(',') &&
        lc(l.data) === v.log.data,
    )
    receiptChecks.push({ tx: v.log.tx, logIndex: v.log.logIndex, confirmedBy: rc.host, ok })
    if (!ok) support.delete(logBody(v.log))
  }
  const union = [...support.values()]
    .map((v) => v.log)
    .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
  // Empty-chunk confirmation, and per-backend shortfall against the union.
  const perBackend = scans.map((s) => {
    const mine = bodies(s)
    let empty = 0
    let confirmed = 0
    let contradicted = 0
    for (const [a, b, n] of s.res.chunks) {
      if (n !== 0) continue
      empty++
      const others = scans.filter((o) => o !== s)
      const otherHas = others.some((o) => o.res.logs.some((l) => l.block >= a && l.block <= b))
      if (otherHas) contradicted++
      else confirmed++
    }
    return {
      host: s.host,
      group: s.group,
      calls: s.res.calls,
      span: s.res.span,
      logs: s.res.logs.length,
      missingVsUnion: union.filter((l) => !mine.has(logBody(l))).length,
      emptyChunks: empty,
      emptyChunksConfirmedByAnotherBackend: confirmed,
      emptyChunksContradicted: contradicted,
    }
  })
  return { union, perBackend, attempts, receiptChecks }
}

/**
 * Emitter census: one topic-only scan (any emitter) on the first backend that completes it, to
 * list every contract that emitted LiquidationCall / Liquidate (out-of-scope ones included) and
 * to cross-check the in-scope scan. Single backend: informational for out-of-scope emitters.
 */
async function emitterCensus(ctx: Ctx, chain: ChainKey, from: number, to: number) {
  const order = [
    'tenderly',
    'arb-official',
    'op-official',
    'blockpi',
    'base-official',
    'onfinality',
  ]
  const rank = (g: string) => (order.includes(g) ? order.indexOf(g) : order.length)
  const hosts = ctx.pool
    .logEndpoints(chain)
    .filter((h) => h.group !== 'pokt')
    .sort((a, b) => rank(a.group) - rank(b.group))
  const attempts: Record<string, unknown>[] = []
  for (const h of hosts) {
    const r = await scanLogs(ctx, chain, h.host, { topics: TOPICS }, from, to)
    if ('error' in r) {
      attempts.push({ host: h.host, error: r.error })
      continue
    }
    attempts.push({ host: h.host, calls: r.calls, logs: r.logs.length })
    return { host: h.host, logs: r.logs, attempts }
  }
  return { host: null, logs: [] as RawLog[], attempts }
}

/**
 * Out of scope, stated for size only: Aave V3 LiquidationCall on Avalanche's core pool over the
 * same window, counted on two public endpoints (raw fetch; Avalanche is not a pool chain here).
 */
async function avalancheCount() {
  const urls = ['https://avalanche.gateway.tenderly.co', 'https://api.avax.network/ext/bc/C/rpc']
  const pool = '0x794a61358D6845594F94dc1DB02A252b5b4814aD'
  const rpc = async (url: string, method: string, params: unknown[]) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'curl/8.5.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(60_000),
    })
    const j = (await r.json()) as { result?: unknown; error?: unknown }
    if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 160))
    return j.result
  }
  const u = urls[0]
  const ts = async (n: number) =>
    Number(
      BigInt(
        (
          (await rpc(u, 'eth_getBlockByNumber', ['0x' + n.toString(16), false])) as {
            timestamp: string
          }
        ).timestamp,
      ),
    )
  const lastLE = async (t: number) => {
    let lo = 60_000_000
    let hi = Number(BigInt((await rpc(u, 'eth_blockNumber', [])) as string))
    while (hi - lo > 1) {
      const m = Math.floor((lo + hi) / 2)
      if ((await ts(m)) <= t) lo = m
      else hi = m
    }
    return lo
  }
  const from = (await lastLE(START_TS - 1)) + 1
  const to = await lastLE(END_TS)
  const counts: Record<string, number | string> = {}
  for (const url of urls) {
    try {
      const r = (await rpc(url, 'eth_getLogs', [
        {
          address: pool,
          topics: [LIQUIDATION_CALL_TOPIC],
          fromBlock: '0x' + from.toString(16),
          toBlock: '0x' + to.toString(16),
        },
      ])) as unknown[]
      counts[new URL(url).host] = r.length
    } catch (e) {
      counts[new URL(url).host] = `error: ${(e as Error).message}`
    }
  }
  return {
    chain: 'avalanche',
    pool: lc(pool),
    blockRange: [from, to],
    liquidationCalls: counts,
    note: 'out of scope; count only, not pulled',
  }
}

export async function scopeStep(ctx: Ctx, chains: ChainKey[] = CHAINS) {
  const statePath = join(ctx.stateDir, 'scope.json')
  const csvAave = aaveEvents(ctx.inputsDir)
  const csvMorpho = morphoEvents(ctx.inputsDir)
  const state: ScopeState = { ranges: {}, markets: [], morpho: {}, extraAave: [], extraMorpho: [] }
  const report: Record<string, unknown> = {
    window: {
      startTs: START_TS,
      endTs: END_TS,
      start: '2025-10-10T00:00:00Z',
      end: '2025-10-11T23:59:59Z',
    },
    scope:
      'Aave V3 LiquidationCall on every pool registered in the PoolAddressesProviderRegistry, and Morpho Blue Liquidate, on mainnet, Arbitrum, Optimism and Base',
    method:
      'topic-only eth_getLogs (LiquidationCall OR Liquidate, any emitter) over the whole window on two independent backend groups per chain (Pocket excluded), compared log by log; empty chunks cross-confirmed; single-backend logs confirmed from receipts; emitters classified on chain',
    chains: {},
  }
  const totals = {
    aaveOnChain: 0,
    aaveCsv: 0,
    aaveCsvFound: 0,
    aaveNotInCsv: 0,
    morphoOnChain: 0,
    morphoCsv: 0,
    morphoCsvFound: 0,
    morphoNotInCsv: 0,
  }
  for (const chain of chains) {
    const range = await windowRange(ctx, chain)
    state.ranges[chain] = range
    const markets = await discoverMarkets(ctx, chain)
    state.markets.push(...markets)
    const morpho = lc(MORPHO_BY_CHAIN[chain])
    state.morpho[chain] = morpho
    const own = await setupMulticall(
      ctx,
      OUT,
      chain,
      [{ target: morpho, abi: morphoAbi, fn: 'owner' }],
      loadMinuteBlocks(ctx, chain)[0],
    )
    if (!own[0].ok) throw new Error(`${chain}: Morpho Blue ${morpho} does not answer owner()`)

    const inScope = [...new Set([...markets.map((m) => m.pool), morpho])].sort()
    const scan = await scanChain(ctx, chain, range.from, range.to, inScope)
    const census = await emitterCensus(ctx, chain, range.from, range.to)
    const unionBodies = new Set(scan.union.map(logBody))
    const censusInScope = census.logs.filter((l) => inScope.includes(l.address))
    const censusCheck = {
      host: census.host,
      attempts: census.attempts,
      logsAllEmitters: census.logs.length,
      inScopeLogs: censusInScope.length,
      inScopeAgreesWithScan:
        censusInScope.length === scan.union.length &&
        censusInScope.every((l) => unionBodies.has(logBody(l))),
    }
    // Classify emitters (every emitter the census saw, plus the in-scope ones).
    const emitters = [
      ...new Set([...census.logs.map((l) => l.address), ...scan.union.map((l) => l.address)]),
    ].sort()
    const allLogs = [...scan.union, ...census.logs.filter((l) => !inScope.includes(l.address))]
    const b0 = loadMinuteBlocks(ctx, chain)[0]
    const cls = new Map<
      string,
      { kind: string; label: string; inScope: boolean; market?: string; provider?: string }
    >()
    const poolToMarket = new Map(markets.map((m) => [m.pool, m]))
    for (const a of emitters) {
      const m = poolToMarket.get(a)
      if (m) {
        cls.set(a, {
          kind: 'aave-v3',
          label: m.marketId,
          inScope: true,
          market: m.key,
          provider: m.provider,
        })
        continue
      }
      if (a === morpho) {
        cls.set(a, { kind: 'morpho-blue', label: 'Morpho Blue', inScope: true })
        continue
      }
      const r = await setupMulticall(
        ctx,
        OUT,
        chain,
        [
          { target: a, abi: poolAbi, fn: 'ADDRESSES_PROVIDER' },
          { target: a, abi: poolV2Abi, fn: 'getAddressesProvider' },
        ],
        b0,
      )
      const prov = r[0].ok ? lc(String(r[0].value)) : r[1].ok ? lc(String(r[1].value)) : null
      let label = ''
      if (prov) {
        const id = await setupMulticall(
          ctx,
          OUT,
          chain,
          [{ target: prov, abi: providerAbi, fn: 'getMarketId' }],
          b0,
        )
        label = id[0].ok ? String(id[0].value) : ''
      }
      cls.set(a, {
        kind: r[0].ok
          ? 'v3-interface, provider not in the Aave registry'
          : r[1].ok
            ? 'aave-v2 interface (V2 pool or V2 fork)'
            : 'unknown',
        label,
        inScope: false,
        ...(prov ? { provider: prov } : {}),
      })
    }
    // Decode in-scope events.
    const aaveLogs: (AaveLiq & { market: string })[] = []
    const morphoLogs: MorphoLiq[] = []
    const tsOf = new Map<number, number>()
    const needTs = [
      ...new Set(scan.union.filter((l) => cls.get(l.address)!.inScope).map((l) => l.block)),
    ]
    await pmap(needTs, 8, async (b) => {
      tsOf.set(b, (await header(ctx, chain, b)).ts)
    })
    for (const l of scan.union) {
      const c = cls.get(l.address)!
      if (!c.inScope) continue
      if (c.kind === 'aave-v3' && l.topics[0] === LIQUIDATION_CALL_TOPIC) {
        aaveLogs.push({
          chain,
          pool: l.address,
          market: c.market!,
          block_number: l.block,
          ts: tsOf.get(l.block)!,
          tx_hash: l.tx,
          log_index: l.logIndex,
          collateral_asset: addr(l.topics[1]),
          debt_asset: addr(l.topics[2]),
          user: addr(l.topics[3]),
          debt_to_cover_raw: word(l.data, 0).toString(),
          liquidated_collateral_raw: word(l.data, 1).toString(),
          liquidator: '0x' + word(l.data, 2).toString(16).padStart(40, '0'),
          receive_atoken: word(l.data, 3) !== 0n,
        })
      } else if (c.kind === 'morpho-blue' && l.topics[0] === MORPHO_LIQUIDATE_TOPIC) {
        morphoLogs.push({
          chain,
          morpho: l.address,
          block_number: l.block,
          ts: tsOf.get(l.block)!,
          tx_hash: l.tx,
          log_index: l.logIndex,
          market_id: l.topics[1],
          caller: addr(l.topics[2]),
          borrower: addr(l.topics[3]),
          repaid_assets: word(l.data, 0).toString(),
          repaid_shares: word(l.data, 1).toString(),
          seized_assets: word(l.data, 2).toString(),
          bad_debt_assets: word(l.data, 3).toString(),
          bad_debt_shares: word(l.data, 4).toString(),
        })
      }
    }
    // Diff against the CSVs.
    const k = (x: { tx_hash: string; log_index: number }) => `${x.tx_hash}:${x.log_index}`
    const onA = new Map(aaveLogs.map((x) => [k(x), x]))
    const onM = new Map(morphoLogs.map((x) => [k(x), x]))
    const csvA = csvAave.filter((r) => r.chain === chain)
    const csvM = csvMorpho.filter((r) => r.chain === chain)
    const aMis: unknown[] = []
    let aMatch = 0
    for (const r of csvA) {
      const o = onA.get(k(r))
      const ok =
        !!o &&
        o.block_number === r.block_number &&
        o.market === 'core' &&
        o.user === r.user &&
        o.collateral_asset === r.collateral_asset &&
        o.debt_asset === r.debt_asset &&
        o.debt_to_cover_raw === String(r.debt_to_cover_raw) &&
        o.liquidated_collateral_raw === String(r.liquidated_collateral_raw) &&
        o.liquidator === lc(String(r.liquidator)) &&
        String(o.receive_atoken) === lc(String(r.receive_atoken))
      if (ok) aMatch++
      else aMis.push({ tx: r.tx_hash, log_index: r.log_index, onChain: o ?? null })
    }
    const mMis: unknown[] = []
    let mMatch = 0
    for (const r of csvM) {
      const o = onM.get(k(r))
      const ok =
        !!o &&
        o.block_number === r.block_number &&
        o.market_id === r.market_id &&
        o.borrower === r.borrower &&
        o.caller === lc(String(r.caller)) &&
        o.repaid_assets === String(r.repaid_assets) &&
        o.repaid_shares === String(r.repaid_shares) &&
        o.seized_assets === String(r.seized_assets) &&
        o.bad_debt_assets === String(r.bad_debt_assets) &&
        o.bad_debt_shares === String(r.bad_debt_shares)
      if (ok) mMatch++
      else mMis.push({ tx: r.tx_hash, log_index: r.log_index, onChain: o ?? null })
    }
    const csvKeysA = new Set(csvA.map(k))
    const csvKeysM = new Set(csvM.map(k))
    const extraA = aaveLogs.filter((x) => !csvKeysA.has(k(x)))
    const extraM = morphoLogs.filter((x) => !csvKeysM.has(k(x)))
    state.extraAave.push(...extraA)
    state.extraMorpho.push(...extraM)
    totals.aaveOnChain += aaveLogs.length
    totals.aaveCsv += csvA.length
    totals.aaveCsvFound += aMatch
    totals.aaveNotInCsv += extraA.length
    totals.morphoOnChain += morphoLogs.length
    totals.morphoCsv += csvM.length
    totals.morphoCsvFound += mMatch
    totals.morphoNotInCsv += extraM.length
    ;(report.chains as Record<string, unknown>)[chain] = {
      blockRange: [range.from, range.to],
      blockTs: [range.fromTs, range.toTs],
      backends: scan.perBackend,
      attempts: scan.attempts,
      singleBackendLogsConfirmedByReceipt: scan.receiptChecks,
      inScopeEmitters: inScope,
      logsInScope: scan.union.length,
      emitterCensus: censusCheck,
      aaveMarkets: markets.map((m) => ({
        ...m,
        liquidationCalls: aaveLogs.filter((x) => x.market === m.key).length,
        inCsv: aaveLogs.filter((x) => x.market === m.key && csvKeysA.has(k(x))).length,
        notInCsv: extraA.filter((x) => x.market === m.key).length,
      })),
      morphoBlue: {
        address: morpho,
        liquidates: morphoLogs.length,
        inCsv: morphoLogs.filter((x) => csvKeysM.has(k(x))).length,
        notInCsv: extraM.length,
        marketsNotInCsv: [...new Set(extraM.map((x) => x.market_id))].length,
      },
      csvCheck: {
        aave: { rows: csvA.length, foundOnChainIdentical: aMatch, problems: aMis },
        morpho: { rows: csvM.length, foundOnChainIdentical: mMatch, problems: mMis },
      },
      otherEmitters: emitters
        .filter((a) => !cls.get(a)!.inScope)
        .map((a) => ({
          address: a,
          ...cls.get(a),
          liquidationCall: allLogs.filter(
            (l) => l.address === a && l.topics[0] === LIQUIDATION_CALL_TOPIC,
          ).length,
          liquidate: allLogs.filter(
            (l) => l.address === a && l.topics[0] === MORPHO_LIQUIDATE_TOPIC,
          ).length,
        })),
    }
    writeJson(join(ctx.stateDir, 'events-scan.partial.json'), report)
  }
  report.totals = totals
  try {
    report.outOfScope = {
      chains:
        'every chain other than mainnet, Arbitrum, Optimism and Base (Avalanche, Polygon, Gnosis, BNB, Scroll, ...), and on the four chains every emitter that is not an Aave V3 registry pool or the Morpho Blue singleton (listed per chain under otherEmitters: Aave V2, Spark and other forks)',
      avalanche: await avalancheCount(),
    }
  } catch (e) {
    report.outOfScope = { avalanche: `not counted: ${(e as Error).message}` }
  }
  report.verification = ctx.verifier.stats(OUT)
  report.quarantined = ctx.pool.quarantined()
  writeJson(statePath, state)
  writeJson(join(ctx.outDir, 'events-scan.json'), report)
  return { state, report }
}

export function loadScope(ctx: Ctx): ScopeState {
  const s = readJson<ScopeState>(join(ctx.stateDir, 'scope.json'))
  if (!s) throw new Error('run step scope first')
  return s
}
