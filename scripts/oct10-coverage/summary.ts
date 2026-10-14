/**
 * Step 7: coverage-summary.json and PROVENANCE.md for onchain/ (plus a pointer in the parent
 * PROVENANCE.md). Reads only the outputs of steps 1-6, the run ledger and the verification log.
 */
import { createHash } from 'crypto'
import { execSync } from 'child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { gunzipSync } from 'zlib'
import { STEPS, type Ctx } from './ctx'
import { aaveEvents, morphoEvents } from './inputs'
import { CHAINS, type ChainKey } from './rpc'
import { JsonlStore, readJson, writeJson } from './store'
import { inSample, type CheckRecord } from './verify'

const gz = (p: string) => JSON.parse(gunzipSync(readFileSync(p)).toString())
const gzLines = (p: string) =>
  gunzipSync(readFileSync(p))
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')

interface AaveEv {
  chain: ChainKey
  user: string
  block_number: number
  error?: string
  position?: {
    asset: string
    symbol: string
    aTokenBalance: string
    variableDebt: string
    stableDebt: string
    collateralFlag: boolean
    borrowingFlag: boolean
  }[]
  atN?: { liquidatable: boolean; hf: number; missingPrice: string[] }
  hfMatch?: { exact: boolean; relDiff: number }
}

/**
 * The scope-scan denominator: every Aave V3 pool and Morpho Blue deployment on the four chains
 * (events-scan.json), the owner's rows plus the extra rows. Accounts are keyed chain+market+user
 * (one user can hold positions in several Aave markets on a chain).
 */
function fullScopeSummary(
  out: string,
  fullCore: (c: ChainKey, a: string) => boolean,
  addMissing: (
    chain: string,
    x: { asset: string; symbol: string; protocol: string; reason: string },
  ) => void,
) {
  if (!existsSync(join(out, 'events-scan.json'))) return null
  const scan = JSON.parse(readFileSync(join(out, 'events-scan.json'), 'utf8')) as {
    totals: Record<string, number>
    chains: Record<
      string,
      {
        aaveMarkets: {
          key: string
          marketId: string
          pool: string
          liquidationCalls: number
          inCsv: number
          notInCsv: number
        }[]
        morphoBlue: { address: string; liquidates: number; inCsv: number; notInCsv: number }
      }
    >
  }
  const full = (prices: (string | null)[] | undefined) =>
    !!prices && prices.length === STEPS && prices.every((x) => x !== null && x !== '0')
  // Aave: the owner's rows (core) + the extras.
  const files = readdirSync(out)
  const marketPaths = new Map<
    string,
    { prices: Record<string, (string | null)[]>; assets: { address: string; symbol: string }[] }
  >()
  for (const f of files) {
    const m = f.match(/^aave-oracle-1m\.(\w+)\.(\w+)\.json\.gz$/)
    if (m) marketPaths.set(`${m[1]}.${m[2]}`, gz(join(out, f)))
  }
  const fullFor = (chain: ChainKey, market: string, a: string) =>
    market === 'core' ? fullCore(chain, a) : full(marketPaths.get(`${chain}.${market}`)?.prices[a])
  const core = gzLines(join(out, 'aave-events.jsonl.gz')) as AaveEv[]
  const extra = existsSync(join(out, 'aave-events-extra.jsonl.gz'))
    ? (gzLines(join(out, 'aave-events-extra.jsonl.gz')) as (AaveEv & { market: string })[])
    : []
  const accts = new Map<string, { chain: ChainKey; market: string; evs: AaveEv[] }>()
  for (const e of [...core.map((x) => ({ ...x, market: 'core' })), ...extra]) {
    const k = `${e.chain}:${e.market}:${e.user}`
    const a = accts.get(k) ?? { chain: e.chain, market: e.market, evs: [] }
    a.evs.push(e)
    accts.set(k, a)
  }
  const aave = {
    events: core.length + extra.length,
    eventsExtra: extra.length,
    accounts: accts.size,
    accountsExtra: 0,
    fullPath: 0,
    locatedHfNBelow1: 0,
    unlocatedHfNAtLeast1: 0,
    notFullPath: 0,
    byMarket: {} as Record<string, Record<string, number>>,
  }
  for (const [, a] of accts) {
    const tag = a.market === 'core' ? a.chain : `${a.chain}.${a.market}`
    const bm = (aave.byMarket[tag] ??= {
      accounts: 0,
      events: 0,
      fullPath: 0,
      located: 0,
      unlocated: 0,
    })
    bm.accounts++
    bm.events += a.evs.length
    if (
      a.market !== 'core' ||
      extra.some((x) => x.chain === a.chain && x.user === a.evs[0].user && x.market === a.market)
    )
      aave.accountsExtra++
    const held = new Set<string>()
    for (const e of a.evs)
      for (const p of e.position ?? [])
        if (
          BigInt(p.aTokenBalance) > 0n ||
          BigInt(p.variableDebt) > 0n ||
          BigInt(p.stableDebt) > 0n
        )
          held.add(p.asset)
    const ok = [...held].every((x) => fullFor(a.chain, a.market, x))
    for (const x of held)
      if (!fullFor(a.chain, a.market, x))
        addMissing(a.chain, {
          asset: x,
          symbol: '',
          protocol: `aave ${tag}`,
          reason: 'held reserve without a full minute path',
        })
    if (!ok) {
      aave.notFullPath++
      continue
    }
    aave.fullPath++
    bm.fullPath++
    if (a.evs.some((e) => e.atN?.liquidatable)) {
      aave.locatedHfNBelow1++
      bm.located++
    } else {
      aave.unlocatedHfNAtLeast1++
      bm.unlocated++
    }
  }
  // Morpho: every oracle path file, then positions over the owner's rows + extras.
  const oraclePaths = new Map<string, (string | null)[]>()
  for (const f of files) {
    const m = f.match(/^morpho-oracle-1m\.(\w+)(\.extra)?\.json\.gz$/)
    if (!m) continue
    const d = gz(join(out, f)) as { prices: Record<string, (string | null)[]> }
    for (const [o, p] of Object.entries(d.prices)) oraclePaths.set(`${m[1]}:${o}`, p)
  }
  type MEv = {
    chain: ChainKey
    market_id: string
    borrower: string
    oracle: string
    liquidatableN: boolean
  }
  const mCore = gzLines(join(out, 'morpho-events.jsonl.gz')) as MEv[]
  const mExtra = existsSync(join(out, 'morpho-events-extra.jsonl.gz'))
    ? (gzLines(join(out, 'morpho-events-extra.jsonl.gz')) as MEv[])
    : []
  const pos = new Map<string, MEv[]>()
  for (const e of [...mCore, ...mExtra]) {
    const k = `${e.chain}:${e.market_id}:${e.borrower}`
    pos.set(k, [...(pos.get(k) ?? []), e])
  }
  const morpho = {
    events: mCore.length + mExtra.length,
    eventsExtra: mExtra.length,
    positions: pos.size,
    fullOraclePath: 0,
    ltvNAboveLltv: 0,
    notLiquidatableAtN: 0,
    byChain: {} as Record<string, Record<string, number>>,
  }
  for (const [, list] of pos) {
    const e = list[0]
    const bc = (morpho.byChain[e.chain] ??= {
      positions: 0,
      events: 0,
      fullOraclePath: 0,
      ltvNAboveLltv: 0,
    })
    bc.positions++
    bc.events += list.length
    if (!full(oraclePaths.get(`${e.chain}:${e.oracle}`))) {
      addMissing(e.chain, {
        asset: `oracle ${e.oracle}`,
        symbol: '',
        protocol: 'morpho',
        reason: 'no full minute path',
      })
      continue
    }
    morpho.fullOraclePath++
    bc.fullOraclePath++
    if (list.some((x) => x.liquidatableN)) {
      morpho.ltvNAboveLltv++
      bc.ltvNAboveLltv++
    } else morpho.notLiquidatableAtN++
  }
  // Protocol fee.
  let fee: Record<string, unknown> | null = null
  if (existsSync(join(out, 'aave-protocol-fee.jsonl.gz'))) {
    const f = gzLines(join(out, 'aave-protocol-fee.jsonl.gz')) as {
      match: string
      market: string
      chain: string
    }[]
    const by = (m: string) => f.filter((x) => x.match === m).length
    fee = {
      events: f.length,
      computedEqualsTreasuryTransfer: by('equal'),
      equalAfterScaledRounding: by('equal-after-scaled-rounding'),
      mismatch: by('mismatch'),
      feeZero: by('fee-zero'),
      noTransferFound: by('no-transfer-found'),
    }
  }
  return {
    scope:
      'Aave V3 LiquidationCall on every pool in the PoolAddressesProviderRegistry and Morpho Blue Liquidate, on mainnet, Arbitrum, Optimism and Base, 2025-10-10T00:00:00Z .. 2025-10-11T23:59:59Z (events-scan.json); accounts keyed chain+market+user',
    onChainEvents: scan.totals,
    pools: Object.fromEntries(
      Object.entries(scan.chains).map(([c, x]) => [
        c,
        {
          aave: x.aaveMarkets.map((m) => ({
            market: m.key,
            marketId: m.marketId,
            pool: m.pool,
            onChain: m.liquidationCalls,
            inCsv: m.inCsv,
            notInCsv: m.notInCsv,
          })),
          morpho: {
            address: x.morphoBlue.address,
            onChain: x.morphoBlue.liquidates,
            inCsv: x.morphoBlue.inCsv,
            notInCsv: x.morphoBlue.notInCsv,
          },
        },
      ]),
    ),
    aave,
    morpho,
    protocolFee: fee,
  }
}

export async function summaryStep(ctx: Ctx, appRoot: string) {
  const out = ctx.outDir
  const missingPaths: Record<
    string,
    { asset: string; symbol: string; protocol: string; reason: string }[]
  > = {}
  const addMissing = (
    chain: string,
    x: { asset: string; symbol: string; protocol: string; reason: string },
  ) => {
    ;(missingPaths[chain] ??= []).some((y) => y.asset === x.asset && y.protocol === x.protocol) ||
      missingPaths[chain].push(x)
  }

  // ---- Aave
  const aOracle = new Map<
    ChainKey,
    {
      prices: Record<string, (string | null)[]>
      assets: { address: string; symbol: string }[]
      nullRuns: Record<string, { from: number; to: number; reason: string }[]>
    }
  >()
  for (const c of CHAINS) aOracle.set(c, gz(join(out, `aave-oracle-1m.${c}.json.gz`)))
  const fullAave = (c: ChainKey, a: string) => {
    const p = aOracle.get(c)!.prices[a]
    return !!p && p.length === STEPS && p.every((x) => x !== null && x !== '0')
  }
  for (const r of aaveEvents(ctx.inputsDir)) {
    for (const a of [r.collateral_asset, r.debt_asset]) {
      const o = aOracle.get(r.chain)!
      if (!o.prices[a])
        addMissing(r.chain, {
          asset: a,
          symbol: '',
          protocol: 'aave',
          reason: 'not in the pool reserve list during the window',
        })
      else if (!fullAave(r.chain, a))
        addMissing(r.chain, {
          asset: a,
          symbol: o.assets.find((x) => x.address === a)?.symbol ?? '',
          protocol: 'aave',
          reason: JSON.stringify(o.nullRuns[a] ?? 'zero price'),
        })
    }
  }
  const evs = gzLines(join(out, 'aave-events.jsonl.gz')) as AaveEv[]
  const accounts = new Map<string, AaveEv[]>()
  for (const e of evs)
    accounts.set(`${e.chain}:${e.user}`, [...(accounts.get(`${e.chain}:${e.user}`) ?? []), e])
  const acct = {
    accounts: accounts.size,
    fullPath: 0,
    notFullPath: 0,
    locatedHfNBelow1: 0,
    unlocatedHfNAtLeast1: 0,
    readErrors: 0,
    byChain: {} as Record<string, Record<string, number>>,
  }
  const located = new Set<string>()
  const fullSet = new Set<string>()
  for (const [k, list] of accounts) {
    const chain = list[0].chain
    const bc = (acct.byChain[chain] ??= { accounts: 0, fullPath: 0, located: 0, unlocated: 0 })
    bc.accounts++
    if (list.some((e) => e.error)) acct.readErrors++
    const held = new Set<string>()
    for (const e of list)
      for (const p of e.position ?? [])
        if (
          BigInt(p.aTokenBalance) > 0n ||
          BigInt(p.variableDebt) > 0n ||
          BigInt(p.stableDebt) > 0n
        )
          held.add(p.asset)
    const full = [...held].every((a) => fullAave(chain, a))
    for (const a of held)
      if (!fullAave(chain, a))
        addMissing(chain, {
          asset: a,
          symbol: aOracle.get(chain)!.assets.find((x) => x.address === a)?.symbol ?? '',
          protocol: 'aave',
          reason: 'held reserve without a full minute path',
        })
    if (!full) {
      acct.notFullPath++
      continue
    }
    acct.fullPath++
    bc.fullPath++
    fullSet.add(k)
    if (list.some((e) => e.atN?.liquidatable)) {
      acct.locatedHfNBelow1++
      bc.located++
      located.add(k)
    } else {
      acct.unlocatedHfNAtLeast1++
      bc.unlocated++
    }
  }
  const evStats = {
    events: evs.length,
    hfNBelow1: evs.filter((e) => e.atN?.liquidatable).length,
    hfNAtLeast1: evs.filter((e) => e.atN && !e.atN.liquidatable && !e.atN.missingPrice.length)
      .length,
    missingPrice: evs.filter((e) => e.atN?.missingPrice.length).length,
    errors: evs.filter((e) => e.error).length,
    hfNm1RecomputeExact: evs.filter((e) => e.hfMatch?.exact).length,
    hfNm1RecomputeWithin1e6: evs.filter((e) => e.hfMatch && e.hfMatch.relDiff <= 1e-6).length,
  }
  // Census exclusions.
  const evidence = JSON.parse(
    readFileSync(join(appRoot, 'public', 'data', 'oct10-2025', 'evidence.json'), 'utf8'),
  ) as { cohort: { chain: string; user: string; excluded: boolean; collClass?: string }[] }
  const excluded = evidence.cohort.filter((r) => r.excluded)
  const exKeys = new Set(excluded.map((r) => `${r.chain}:${r.user.toLowerCase()}`))
  const byClass: Record<string, { excluded: number; fullPath: number; located: number }> = {}
  for (const r of excluded) {
    const k = `${r.chain}:${r.user.toLowerCase()}`
    const c = (byClass[r.collClass ?? 'unknown'] ??= { excluded: 0, fullPath: 0, located: 0 })
    c.excluded++
    if (fullSet.has(k)) c.fullPath++
    if (located.has(k)) c.located++
  }
  const census = {
    source:
      'membrane-app public/data/oct10-2025/evidence.json cohort rows with excluded: true, keyed chain+user',
    excludedAccounts: exKeys.size,
    inThisPull: [...exKeys].filter((k) => accounts.has(k)).length,
    nowFullPath: [...exKeys].filter((k) => fullSet.has(k)).length,
    nowLocatedHfNBelow1: [...exKeys].filter((k) => located.has(k)).length,
    stillUnlocatedHfNAtLeast1: [...exKeys].filter((k) => fullSet.has(k) && !located.has(k)).length,
    byCensusCollClass: byClass,
    censusCohortAccounts: evidence.cohort.length,
    censusIncluded: evidence.cohort.length - excluded.length,
  }

  // ---- Morpho
  const mOracle = new Map<
    ChainKey,
    {
      prices: Record<string, (string | null)[]>
      markets: {
        id: string
        oracle: string
        loanSymbol: string
        collateralSymbol: string
        loanToken: string
        collateralToken: string
      }[]
      nullRuns: Record<string, unknown>
    }
  >()
  for (const c of ['mainnet', 'base'] as ChainKey[])
    if (existsSync(join(out, `morpho-oracle-1m.${c}.json.gz`)))
      mOracle.set(c, gz(join(out, `morpho-oracle-1m.${c}.json.gz`)))
  const fullMorpho = (c: ChainKey, o: string) => {
    const p = mOracle.get(c)?.prices[o]
    return !!p && p.length === STEPS && p.every((x) => x !== null && x !== '0')
  }
  const mev = gzLines(join(out, 'morpho-events.jsonl.gz')) as {
    chain: ChainKey
    market_id: string
    borrower: string
    oracle: string
    liquidatableN: boolean
    ltvN: number | null
    lltvFloat: number
    error?: string
  }[]
  const positions = new Map<string, typeof mev>()
  for (const e of mev)
    positions.set(`${e.chain}:${e.market_id}:${e.borrower}`, [
      ...(positions.get(`${e.chain}:${e.market_id}:${e.borrower}`) ?? []),
      e,
    ])
  const morpho = {
    events: mev.length,
    positions: positions.size,
    fullOraclePath: 0,
    ltvNAboveLltv: 0,
    notLiquidatableAtN: 0,
    eventsLiquidatableN: mev.filter((e) => e.liquidatableN).length,
    eventsNotLiquidatableN: mev.filter((e) => !e.liquidatableN).length,
    byChain: {} as Record<string, Record<string, number>>,
  }
  for (const [, list] of positions) {
    const e = list[0]
    const bc = (morpho.byChain[e.chain] ??= { positions: 0, fullOraclePath: 0, ltvNAboveLltv: 0 })
    bc.positions++
    if (!fullMorpho(e.chain, e.oracle)) {
      const m = mOracle.get(e.chain)?.markets.find((x) => x.id === e.market_id)
      addMissing(e.chain, {
        asset: `${m?.collateralToken}/${m?.loanToken} oracle ${e.oracle}`,
        symbol: `${m?.collateralSymbol}/${m?.loanSymbol}`,
        protocol: 'morpho',
        reason: JSON.stringify(mOracle.get(e.chain)?.nullRuns[e.oracle] ?? 'no path'),
      })
      continue
    }
    morpho.fullOraclePath++
    bc.fullOraclePath++
    if (list.some((x) => x.liquidatableN)) {
      morpho.ltvNAboveLltv++
      bc.ltvNAboveLltv++
    } else morpho.notLiquidatableAtN++
  }
  for (const r of morphoEvents(ctx.inputsDir))
    if (!mOracle.get(r.chain)?.prices[r.oracle])
      addMissing(r.chain, {
        asset: r.oracle,
        symbol: '',
        protocol: 'morpho',
        reason: 'oracle not read',
      })

  const unreadable = Object.values(missingPaths)
    .flat()
    .filter((x) => /revert/i.test(x.reason))
  const summary = {
    generatedAt: new Date().toISOString(),
    window: { startTs: 1760054400, steps: STEPS, stepSeconds: 60 },
    definitions: {
      aaveAccountFullPath:
        'every reserve the account held (aToken balance or debt > 0 at N-1 of any of its events) has a non-null, non-zero AaveOracle price at all 2,880 minute blocks',
      located:
        "at least one of the account's events has HF_N < 1: HF recomputed with the N-1 composition and LTs and block-N oracle prices",
      unlocated: 'full path, but HF_N >= 1 for every event',
      morphoFullPath:
        'the market oracle price() is non-null and non-zero at all 2,880 minute blocks',
      morphoLiquidatableN:
        'borrowed (shares -> assets rounded up, interest accrued to ts(N)) > maxBorrow = collateral * price(N) / 1e36 * lltv',
    },
    aave: { ...acct, events: evStats, census },
    morpho,
    assetsWithoutFullPath: missingPaths,
    oraclesUnreadableOnChain: unreadable,
    dexTwapFallbackNeeded: unreadable.length
      ? unreadable
      : 'none: every Aave reserve and every Morpho oracle in the CSVs was readable on chain at every minute',
  }
  const fullScope = fullScopeSummary(out, fullAave, addMissing)
  if (fullScope) Object.assign(summary, { fullScope })
  writeJson(join(out, 'coverage-summary.json'), summary)

  // ---- PROVENANCE
  const git = (cmd: string) => execSync(cmd, { cwd: appRoot }).toString().trim()
  const commit = git('git rev-parse HEAD')
  const branch = git('git rev-parse --abbrev-ref HEAD')
  const dirty = git('git status --porcelain scripts/oct10-coverage')
  const runs = (readJson<Record<string, unknown>[]>(join(ctx.stateDir, 'runs.json')) ?? []) as {
    startedAt: string
    steps: string[]
    calls: number
    wallSeconds: number
    stepSeconds: Record<string, number>
    ledger: {
      chain: string
      host: string
      group: string
      calls: number
      ok: number
      rateLimited: number
      transient: number
      capability: number
      disabled: string | null
    }[]
  }[]
  const hostAgg = new Map<
    string,
    {
      chain: string
      host: string
      group: string
      calls: number
      ok: number
      rateLimited: number
      transient: number
      capability: number
    }
  >()
  for (const r of runs)
    for (const l of r.ledger ?? []) {
      if (!l.calls) continue
      const k = `${l.chain}|${l.host}`
      const a = hostAgg.get(k) ?? {
        chain: l.chain,
        host: l.host,
        group: l.group,
        calls: 0,
        ok: 0,
        rateLimited: 0,
        transient: 0,
        capability: 0,
      }
      a.calls += l.calls
      a.ok += l.ok
      a.rateLimited += l.rateLimited
      a.transient += l.transient
      a.capability += l.capability
      hostAgg.set(k, a)
    }
  const vlog = new JsonlStore<CheckRecord>(join(ctx.stateDir, 'verify.jsonl'))
  const outputs = [...new Set([...vlog.map.values()].map((r) => r.output))].sort()
  // Unit of work per output (a minute of a chain, or one event-step call) and how many exist, so
  // the table shows the share of units re-asked, not just a count of checks.
  const keyedKeys = (f: string) =>
    existsSync(join(ctx.stateDir, f)) ? [...new JsonlStore(join(ctx.stateDir, f)).map.keys()] : []
  const minuteUnits = (chains: string[]) =>
    chains.flatMap((c) => Array.from({ length: STEPS }, (_, i) => `${c}:${i}`))
  const scopeState = readJson<{ markets: { chain: string; key: string }[] }>(
    join(ctx.stateDir, 'scope.json'),
  )
  const morphoChains = CHAINS.filter((c) =>
    existsSync(join(ctx.stateDir, `morpho-prices.${c}.jsonl`)),
  )
  const allUnits: Record<string, string[]> = {
    'minute-blocks': minuteUnits(CHAINS),
    'aave-oracle-1m': minuteUnits(CHAINS),
    'morpho-oracle-1m': minuteUnits(morphoChains),
    'aave-events': keyedKeys('aave-events-calls.jsonl'),
    'morpho-events': keyedKeys('morpho-events-calls.jsonl'),
    'aave-events-extra': keyedKeys('aave-events-extra-calls.jsonl'),
    'morpho-events-extra': keyedKeys('morpho-events-extra-calls.jsonl'),
    'aave-protocol-fee': [
      ...keyedKeys('fee-calls.jsonl').filter((k) => k.startsWith('fee2:')),
      ...keyedKeys('receipts.jsonl').map((k) => `receipt:${k}`),
    ],
  }
  for (const m of scopeState?.markets ?? [])
    if (m.key !== 'core') allUnits[`aave-oracle-1m.${m.key}`] = minuteUnits([m.chain])
  if (
    existsSync(join(ctx.stateDir, 'morpho-prices.mainnet.extra.jsonl')) ||
    existsSync(join(ctx.stateDir, 'morpho-prices.base.extra.jsonl'))
  )
    allUnits['morpho-oracle-1m.extra'] = minuteUnits(
      ['mainnet', 'base'].filter((c) =>
        existsSync(join(ctx.stateDir, `morpho-prices.${c}.extra.jsonl`)),
      ),
    )
  // The key each step hashed to decide sample membership.
  const sampleKey = (o: string, u: string) =>
    o === 'minute-blocks' ? u.replace(':', ':minute:') : u.startsWith('receipt:') ? u.slice(8) : u
  const unitOf = (o: string, key: string) => {
    const k = key.slice(o.length + 1)
    if (k.startsWith('setup:')) return null
    if (o === 'minute-blocks' || /-1m(\.|$)/.test(o)) return k.split(':').slice(0, 2).join(':')
    return k.replace(/:requery$/, '')
  }
  const vrows = outputs.map((o) => {
    const entries = [...vlog.map.entries()].filter(([, r]) => r.output === o)
    const rows = entries.map(([, r]) => r)
    const known = allUnits[o] ? new Set(allUnits[o]) : null
    // Units of superseded call sets (e.g. the first fee multicall layout) do not count.
    const unitSet = new Set(
      entries
        .map(([k]) => unitOf(o, k))
        .filter((u): u is string => u !== null && (!known || known.has(u))),
    )
    // Deterministic sample: every unit whose key hashes under the rate. It must all have been
    // re-asked (as 'sample', or earlier as 'anomaly' when it was also anomalous).
    const sampled = (allUnits[o] ?? []).filter((u) => inSample(sampleKey(o, u)))
    const sampleUnits = {
      size: sampled.length,
      covered: sampled.filter((u) => unitSet.has(u)).length,
    }
    return {
      o,
      units: (allUnits[o] ?? []).length,
      unitsChecked: unitSet.size,
      sampleUnits: sampleUnits.size,
      sampleCovered: sampleUnits.covered,
      setup: entries.filter(([k]) => unitOf(o, k) === null).length,
      checked: rows.length,
      sample: rows.filter((r) => r.reason === 'sample').length,
      anomaly: rows.filter((r) => r.reason === 'anomaly').length,
      requery: rows.filter((r) => r.reason === 'requery').length,
      agree: rows.filter((r) => r.resolution === 'agree').length,
      disagree: rows.filter((r) => !r.agree && r.checkHost).length,
      unresolved: rows.filter((r) => r.resolution === 'unresolved').length,
    }
  })
  const quarantined =
    readJson<{ host: string; chain: string; reason: string }[]>(
      join(ctx.stateDir, 'quarantine.json'),
    ) ?? []
  const files = readdirSync(out)
    .filter((f) => f !== 'PROVENANCE.md')
    .sort()
    .map((f) => ({ f, size: statSync(join(out, f)).size, sha: sha(join(out, f)) }))
  const inputs = ['aave_liquidations_enriched.csv', 'morpho_liquidations.csv'].map((f) => ({
    f,
    sha: sha(join(ctx.inputsDir, f)),
  }))
  const totalCalls = runs.reduce((s, r) => s + (r.calls ?? 0), 0)
  const totalWall = runs.reduce((s, r) => s + (r.wallSeconds ?? 0), 0)
  const cl = readJson<{
    chains: Record<
      string,
      {
        symbol: string
        kind: string
        matchRate?: number
        minutesMatch?: number
        mismatchUnexplained?: number
        maxAgeSecOfLoggedRoundNotYetServed?: number
        feed?: {
          aggregators: { continuous: boolean; confirmed: boolean; typeAndVersion: string | null }[]
        }
        feeds?: {
          aggregators: { continuous: boolean; confirmed: boolean; typeAndVersion: string | null }[]
        }[]
      }[]
    >
    quarantinedForLogs: { chain: string; host: string; aggregator: string; missing: number }[]
  }>(join(out, 'chainlink-check.json'))
  const aggs = cl
    ? Object.values(cl.chains)
        .flat()
        .flatMap((r) => [...(r.feed ? [r.feed] : []), ...(r.feeds ?? [])])
        .flatMap((f) => f.aggregators)
    : []
  const md = `# Oct 10-11 2025 on-chain pull (protocol oracles, minute blocks, liquidation positions)

Every Aave V3 LiquidationCall and Morpho Blue Liquidate on mainnet, Arbitrum, Optimism and Base in
2025-10-10T00:00:00Z .. 2025-10-11T23:59:59Z, priced from the protocol's OWN oracle read on chain
at the block in force at each minute (2,880 one-minute steps), and every liquidation's position
re-read at block N-1.

**Scope.** Every Aave V3 pool registered in each chain's PoolAddressesProviderRegistry (mainnet:
Core, Lido, EtherFi; Arbitrum, Optimism, Base: Core) and the Morpho Blue singleton of each chain,
established on chain and scanned for events in \`events-scan.json\`. The owner's CSVs
(\`../aave_liquidations_enriched.csv\`, \`../morpho_liquidations.csv\`) cover the Core pools and
Morpho on mainnet and Base; every CSV row was found on chain, identical, and the on-chain events
the CSVs lack are read the same way into the \`*-extra\` files. Out of scope: every other chain
(Avalanche, for size: ${(() => {
    try {
      const sc = JSON.parse(readFileSync(join(out, 'events-scan.json'), 'utf8')) as {
        outOfScope?: { avalanche?: { liquidationCalls?: Record<string, unknown> } }
      }
      return JSON.stringify(sc.outOfScope?.avalanche?.liquidationCalls ?? 'not counted')
    } catch {
      return 'not counted'
    }
  })()} Aave V3 LiquidationCalls in the window, not pulled), Aave V2, and V3 forks (Spark, Seamless,
ZeroLend, Avalon, ...), listed per chain in \`events-scan.json\` under \`otherEmitters\`.

- **Source**: membrane-app \`scripts/oct10-coverage/pull-onchain.ts\` (+ modules beside it), branch
  \`${branch}\`, commit \`${commit}\`${dirty ? ' (WARNING: script dir had uncommitted changes when this was written)' : ''}.
  Command: \`npx tsx scripts/oct10-coverage/pull-onchain.ts --state <dir>\` (resumable; steps
  blocks, aave, morpho, aave-events, morpho-events, chainlink, scope, extras, fees, summary).
  The files of the first pull (minute blocks, the four core Aave paths, the mainnet / Base Morpho
  paths, aave-events, morpho-events, chainlink-check) are unchanged since membrane-app 62bf614;
  the verification statistics embedded in them are those of that run.
- **Path**: \`recall-coverage/inputs/oct10/onchain/\`
- **Date**: ${new Date().toISOString().slice(0, 10)}
- **Status**: canonical, frozen (re-running the script reproduces it from chain state).
- **Inputs** (read only): ${inputs.map((i) => `\`${i.f}\` sha256 \`${i.sha}\``).join('; ')}.

## Files

| file | bytes | sha256 | contents |
| --- | ---: | --- | --- |
${files.map((x) => `| \`${x.f}\` | ${x.size.toLocaleString('en-US')} | \`${x.sha}\` | ${describe(x.f)} |`).join('\n')}

## Method

- **Minute blocks**: block in force at minute start t_i = the HIGHEST block with timestamp <= t_i
  (post-state of that block). Found by interpolation + bracket search, accepted only with both
  headers in hand: ts(b) <= t_i < ts(b+1).
- **Aave**: Pool, AaveOracle and PoolDataProvider resolved from each chain's PoolAddressesProvider
  at the first and last minute blocks and asserted (unchanged in the window; oracle = the
  expected AaveOracle). One \`AaveOracle.getAssetsPrices(reservesList)\` per minute per chain (no
  call reverted, so the per-asset fallback was never used). Base unit 1e8 USD on every chain.
- **Morpho**: \`price()\` of every oracle in the CSV, one Multicall3 \`aggregate3\` (allowFailure)
  per minute per chain; market params read with \`idToMarketParams\` and asserted against the CSV.
  Prices are raw 1e36-scaled decimal strings.
- **Aave events**: at N-1, \`getUserAccountData\`, \`getUserEMode\`, \`getUserConfiguration\` and
  \`getUserReserveData\` for EVERY reserve (one Multicall3); per (chain, block) for N-1 and N,
  \`getAssetsPrices\`, \`Pool.getConfiguration\` of every reserve and every e-mode category's
  collateral config + bitmap (all four pools are revision 9, v3.2+ e-mode). HF is recomputed as
  GenericLogic does with the v3.5 rounding: collateral counted iff the user's collateral bit is set
  and the reserve LT != 0, bal = floor(aToken * price / 10^dec); e-mode LT iff the reserve's bit is
  set in the user's category bitmap; debt = ceil(debt * price / 10^dec) per reserve;
  HF = floor(sum(bal * LT) * 1e18 / (totalDebt * 1e4)). It is compared with
  \`getUserAccountData\` at N-1. HF at N keeps the N-1 composition and LTs and uses block-N prices.
- **Morpho events**: position, market, params and \`price()\` at N-1; \`borrowRateView\` at N-1;
  \`price()\` at N; interest accrued to ts(N) with wTaylorCompounded; borrowed = shares -> assets
  rounded UP (VIRTUAL_SHARES 1e6, VIRTUAL_ASSETS 1); liquidatable iff borrowed > maxBorrow.
- **Chainlink check**: the WETH and BTC (WBTC / cbBTC) sources of each chain; AnswerUpdated logs
  over the window from >= 2 backend groups, round-id continuity checked against
  \`latestRound()\` at both ends, minute path compared with the round in force.
- **Scope scan** (\`events-scan.json\`): Aave markets from each chain's registry
  (\`getAddressesProvidersList\` at both window ends; each provider's pool / oracle / data provider);
  Morpho Blue singletons checked with \`owner()\`. The in-scope emitters' LiquidationCall /
  Liquidate logs over the exact window (first block with ts >= start .. last block with ts <= end)
  were scanned in full on two independent backend groups per chain (Pocket excluded for logs; the
  builder relays are never used) and compared log by log: identical on all four chains; every empty
  chunk of one host is covered by the other's scan. A topic-only scan (any emitter) lists the
  out-of-scope emitters and agrees with the in-scope scan on every chain.
- **Extras**: the on-chain events the CSVs lack (\`*-extra\`) are read exactly as the CSV events,
  every read re-asked on a second backend (100%, not a sample). CSV-equivalent rows
  (\`*_liquidations_extra.csv\`, the owner's columns + market / pool) are decoded from the logs and
  the N-1 reads; the Morpho fractions follow the owner's convention measured on its rows (repaid
  shares / pre-borrow shares capped at 1, seized / pre-collateral, 8 decimals); \`full_liquidation\`
  is left empty (the owner's rule could not be reproduced). Minute paths: the AaveOracle of every
  new market and every Morpho oracle no earlier file covers.
- **Protocol fee** (\`aave-protocol-fee.jsonl.gz\`, every Aave event): LiquidationLogic
  (v3.3-3.5) seizes collateralAmount, of which bonusCollateral = collateralAmount -
  collateralAmount.percentDiv(liquidationBonus) and fee = bonusCollateral.percentMul(
  liquidationProtocolFee) go to the treasury, and the event's liquidatedCollateralAmount =
  collateralAmount - fee. The fee is recovered from the event by inverting that (bonus = the
  user's e-mode category bonus when the collateral is in the category bitmap, else the reserve's;
  fee bps from PoolDataProvider.getLiquidationProtocolFee at N) and checked against the
  Transfer(user -> RESERVE_TREASURY_ADDRESS) of the collateral aToken in the event's own receipt.
  \`protocolFeeRaw\` is that on-chain transfer.

## Verification

Every result that feeds a file was cross-verified: a deterministic sample (sha256 of the key < 4%)
plus every anomaly (revert, zero or null value, >20% one-minute move, HF recompute mismatch, CSV
mismatch, Morpho position not liquidatable) re-asked on a DIFFERENT backend group and required to
be byte-equal; a disagreement goes to a third group and the loser is quarantined (and everything it
answered re-asked). Setup reads (addresses, reserve lists, sources, market params, feed state) are
verified at 100%.

Units are minutes of a chain (minute paths) or keyed event-step calls (events). "sample" is the
deterministic sample (units whose key hashes under 4%; >= 3% required) and how many of them were
re-asked; "units checked" counts units re-asked for any reason (sample, anomaly, requery).

| output | units | sample | sample % | sample re-asked | units checked | checked % | setup checks | checks | anomaly | requery | agree | disagree | unresolved |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${vrows.map((v) => `| ${v.o} | ${v.units || ''} | ${v.sampleUnits || ''} | ${v.units ? ((100 * v.sampleUnits) / v.units).toFixed(2) + '%' : ''} | ${v.units ? v.sampleCovered : ''} | ${v.unitsChecked} | ${v.units ? ((100 * v.unitsChecked) / v.units).toFixed(1) + '%' : ''} | ${v.setup} | ${v.checked} | ${v.anomaly} | ${v.requery} | ${v.agree} | ${v.disagree} | ${v.unresolved} |`).join('\n')}

Quarantined hosts (all calls): ${quarantined.length ? quarantined.map((q) => `${q.chain} ${q.host} (${q.reason})`).join('; ') : 'none: no backend disagreed with another on any re-asked value'}.
Quarantined for getLogs only (chainlink check): ${cl?.quarantinedForLogs?.length ? cl.quarantinedForLogs.map((q) => `${q.chain} ${q.host} (short by ${q.missing} logs on ${q.aggregator})`).join('; ') : 'none'}.

## Results

- Aave HF recompute at N-1 equals \`getUserAccountData\` to the wei for ${summary.aave.events.hfNm1RecomputeExact} of ${summary.aave.events.events} events.
- Aave: ${summary.aave.fullPath} of ${summary.aave.accounts} (chain, user) accounts have every held reserve priced at every minute; ${summary.aave.locatedHfNBelow1} have HF_N < 1 (located), ${summary.aave.unlocatedHfNAtLeast1} have HF_N >= 1 for every event. Of the census's ${summary.aave.census.excludedAccounts} excluded accounts, ${summary.aave.census.nowLocatedHfNBelow1} are now located.
- Morpho: ${summary.morpho.fullOraclePath} of ${summary.morpho.positions} positions have a full oracle path; ${summary.morpho.ltvNAboveLltv} are liquidatable at N (LTV_N > LLTV).
- Assets without a full path: ${Object.keys(summary.assetsWithoutFullPath).length ? JSON.stringify(summary.assetsWithoutFullPath) : 'none'}.
${(() => {
  const fs = (summary as { fullScope?: ReturnType<typeof fullScopeSummary> }).fullScope
  if (!fs) return ''
  const t = fs.onChainEvents
  const pools = Object.entries(fs.pools)
    .map(
      ([c, x]) =>
        `${c}: ${x.aave.map((m) => `Aave ${m.market} ${m.onChain} (CSV ${m.inCsv})`).join(', ')}, Morpho ${x.morpho.onChain} (CSV ${x.morpho.inCsv})`,
    )
    .join('; ')
  const f = fs.protocolFee as Record<string, number> | null
  return `- Scope: ${t.aaveOnChain} Aave V3 LiquidationCalls and ${t.morphoOnChain} Morpho Liquidates on chain; the CSVs hold ${t.aaveCsv} and ${t.morphoCsv}, every one found on chain identical; ${t.aaveNotInCsv} Aave and ${t.morphoNotInCsv} Morpho events are added (per pool: ${pools}).
- Full scope: ${fs.aave.fullPath} of ${fs.aave.accounts} Aave (chain, market, user) accounts fully priced, ${fs.aave.locatedHfNBelow1} located (HF_N < 1), ${fs.aave.unlocatedHfNAtLeast1} not; Morpho ${fs.morpho.fullOraclePath} of ${fs.morpho.positions} positions fully priced, ${fs.morpho.ltvNAboveLltv} liquidatable at N.
${f ? `- Protocol fee: ${f.events} Aave events; the computed fee equals the treasury transfer for ${f.computedEqualsTreasuryTransfer}, and equals it after the aToken's scaled-balance rounding (rayMulFloor(rayDivFloor(fee, index), index), v3.5) for ${f.equalAfterScaledRounding}; mismatches ${f.mismatch}; no transfer found ${f.noTransferFound}.` : ''}`
})()}

${
  cl
    ? `Chainlink check: ${Object.entries(cl.chains)
        .flatMap(([c, rows]) =>
          rows.map(
            (r) =>
              `${c} ${r.symbol} ${r.kind}${r.matchRate !== undefined ? ` ${(r.matchRate * 100).toFixed(2)}% minutes match` : ''}`,
          ),
        )
        .join(
          '; ',
        )}. Feeds behind them: ${aggs.length} aggregators, ${aggs.filter((a) => a.continuous).length} with continuous round ids, ${aggs.filter((a) => a.confirmed).length} confirmed by two backends; types ${[...new Set(aggs.map((a) => a.typeAndVersion))].join(', ')}. Mainnet sources are Chainlink SVR \`DualAggregator\` feeds, which serve a transmitted round with a delay: every mismatching minute there holds an older round (unexplained: ${Object.values(
        cl.chains,
      )
        .flat()
        .reduce(
          (x, r) => x + (r.mismatchUnexplained ?? 0),
          0,
        )}), the newest unserved round at most ${Math.max(
        0,
        ...Object.values(cl.chains)
          .flat()
          .map((r) => r.maxAgeSecOfLoggedRoundNotYetServed ?? 0),
      )} s old.`
    : ''
}

## Endpoints (hosts only; all public, keyless)

| chain | host | backend group | calls | ok | rate-limited | transient | refused (capability) |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
${[...hostAgg.values()]
  .sort((a, b) => a.chain.localeCompare(b.chain) || b.calls - a.calls)
  .map(
    (h) =>
      `| ${h.chain} | ${h.host} | ${h.group} | ${h.calls} | ${h.ok} | ${h.rateLimited} | ${h.transient} | ${h.capability} |`,
  )
  .join('\n')}

Total JSON-RPC calls ${totalCalls.toLocaleString('en-US')} over ${runs.length} runs, ${Math.round(totalWall / 60)} min wall time.
`
  writeFileSync(join(out, 'PROVENANCE.md'), md)

  // Pointer in the parent PROVENANCE.md.
  const parent = join(ctx.inputsDir, 'PROVENANCE.md')
  const ptxt = readFileSync(parent, 'utf8')
  const marker = '## On-chain pull (`onchain/`)'
  const pointer = `${marker}

\`onchain/\` holds the protocol-oracle minute paths, minute -> block tables and N-1 position re-reads
for every row of the two CSVs above, the on-chain scope scan (every Aave V3 pool and Morpho Blue
deployment on mainnet, Arbitrum, Optimism and Base: \`events-scan.json\`), the events the CSVs
lack read the same way (\`*-extra\` files, \`*_liquidations_extra.csv\`), and the protocol fee
of every Aave event, pulled on chain by membrane-app \`scripts/oct10-coverage/pull-onchain.ts\`
(commit \`${commit}\`). See \`onchain/PROVENANCE.md\`.
`
  writeFileSync(
    parent,
    ptxt.includes(marker)
      ? ptxt.slice(0, ptxt.indexOf(marker)) + pointer
      : ptxt.trimEnd() + '\n\n' + pointer,
  )
  return summary
}

function describe(f: string): string {
  const generic = f.replace(/\.(mainnet|arbitrum|optimism|base)\./, '.<chain>.')
  if (DESCRIBE[generic]) return DESCRIBE[generic]
  const m = f.match(/^aave-oracle-1m\.(\w+)\.(\w+)\.json\.gz$/)
  if (m)
    return `AaveOracle path of the ${m[1]} ${m[2]} market (not in the owner's CSV), same layout as the core files`
  if (/^morpho-oracle-1m\.\w+\.extra\.json\.gz$/.test(f))
    return 'price() of the Morpho oracles the extra events add on a CSV chain'
  return ''
}

const DESCRIBE: Record<string, string> = {
  'events-scan.json':
    'scope: Aave registries and Morpho deployments per chain, every in-scope LiquidationCall / Liquidate in the window (two backends), CSV diff, out-of-scope emitters',
  'aave-events-extra.jsonl.gz':
    'the on-chain Aave events the CSV lacks, same records as aave-events + market, pool, CSV-equivalent fields',
  'morpho-events-extra.jsonl.gz':
    'the on-chain Morpho events the CSV lacks (Arbitrum), same records as morpho-events + CSV-equivalent fields',
  'aave_liquidations_extra.csv':
    "the extra Aave events in the owner's CSV columns (+ market, pool)",
  'morpho_liquidations_extra.csv':
    "the extra Morpho events in the owner's CSV columns (+ morpho address)",
  'aave-protocol-fee.jsonl.gz':
    'every Aave event: liquidation protocol fee bps at N, bonus used, computed fee, treasury aToken transfer from the receipt',
  'minute-blocks.json':
    'per chain, the block in force at each minute start (highest block with ts <= t_i), its ts, ts(b+1), hash',
  'aave-oracle-1m.<chain>.json.gz':
    'AaveOracle.getAssetsPrices(reservesList) at every minute block; reserves, symbols, decimals, sources',
  'morpho-oracle-1m.<chain>.json.gz':
    'price() of every Morpho oracle in the CSV at every minute block; market params',
  'aave-events.jsonl.gz':
    'one line per Aave LiquidationCall: full position at N-1, LTs, e-mode, account data, HF recompute at N-1 and N',
  'morpho-events.jsonl.gz':
    'one line per Morpho Liquidate: position/market at N-1, price at N-1 and N, accrued debt, LTV, liquidatable',
  'chainlink-check.json':
    'WETH / BTC sources per chain: feed rounds over the window (>= 2 backends), continuity, minute-path match',
  'coverage-summary.json':
    'coverage counts: Aave accounts with full paths, located / unlocated, census exclusions; Morpho positions',
}
