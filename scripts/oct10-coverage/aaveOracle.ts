/**
 * Step 2: Aave V3 oracle price path per chain, one AaveOracle.getAssetsPrices(reservesList) per
 * minute block. Setup reads (pool / oracle / data provider resolved from the
 * PoolAddressesProvider, reserve list, symbols, decimals, reserve ids, price sources, base unit,
 * e-mode categories) happen at the window's first and last minute blocks and are 100% verified.
 */
import { join } from 'path'
import { writeFileSync } from 'fs'
import { gzipSync } from 'zlib'
import type { Hex } from 'viem'
import { decodeAbiParameters } from 'viem'
import {
  ADDRESSES,
  dec,
  decMulticall,
  enc,
  encMulticall,
  erc20Abi,
  MULTICALL3,
  oracleAbi,
  poolAbi,
  providerAbi,
  revertReason,
  type SubCall,
} from './abi'
import { START_TS, STEP_SEC, STEPS, type Ctx } from './ctx'
import { loadMinuteBlocks } from './minuteBlocks'
import type { ChainKey } from './rpc'
import { errorRuns, runSeries } from './series'
import { setupCall, setupMulticall } from './setupCall'
import { readJson, writeJson } from './store'

export interface AaveAsset {
  address: string
  symbol: string
  decimals: number
  id: number
  source: string
  sourceEnd: string
  configStart: string
  configEnd: string
  inListStart: boolean
  inListEnd: boolean
}
export interface EModeCat {
  id: number
  label: string
  ltv: number
  lt: number
  bonus: number
  bitmap: string
}
export interface AaveSetup {
  chain: ChainKey
  pool: string
  oracle: string
  dataProvider: string
  poolRevision: string
  baseUnit: string
  baseCurrency: string
  fallbackOracle: string
  b0: number
  bEnd: number
  reserves: string[]
  assets: AaveAsset[]
  emodeStart: EModeCat[]
  emodeEnd: EModeCat[]
  notes: string[]
}

const OUT = 'aave-oracle-1m'
const lc = (s: string) => s.toLowerCase()

async function readEModes(
  ctx: Ctx,
  chain: ChainKey,
  pool: string,
  block: number,
): Promise<EModeCat[]> {
  const ids = [...Array(255).keys()].map((i) => i + 1)
  const labels = await setupMulticall(
    ctx,
    OUT,
    chain,
    ids.map((id) => ({ target: pool, abi: poolAbi, fn: 'getEModeCategoryLabel', args: [id] })),
    block,
  )
  const live = ids.filter((_, k) => labels[k].ok && String(labels[k].value).length > 0)
  const cfg = await setupMulticall(
    ctx,
    OUT,
    chain,
    live.flatMap((id) => [
      { target: pool, abi: poolAbi, fn: 'getEModeCategoryCollateralConfig', args: [id] },
      { target: pool, abi: poolAbi, fn: 'getEModeCategoryCollateralBitmap', args: [id] },
    ]),
    block,
  )
  return live.map((id, k) => {
    const c = cfg[2 * k]
    const bm = cfg[2 * k + 1]
    if (!c.ok || !bm.ok)
      throw new Error(`${chain} e-mode ${id}: v3.2+ getters failed (pool revision too old?)`)
    const v = c.value as { ltv: number; liquidationThreshold: number; liquidationBonus: number }
    return {
      id,
      label: String(labels[ids.indexOf(id)].value),
      ltv: v.ltv,
      lt: v.liquidationThreshold,
      bonus: v.liquidationBonus,
      bitmap: (bm.value as bigint).toString(),
    }
  })
}

export async function aaveSetup(ctx: Ctx, chain: ChainKey): Promise<AaveSetup> {
  const path = join(ctx.stateDir, `aave-setup.${chain}.json`)
  const cached = readJson<AaveSetup>(path)
  if (cached) return cached
  const blocks = loadMinuteBlocks(ctx, chain)
  const b0 = blocks[0]
  const bEnd = blocks[STEPS - 1]
  const A = ADDRESSES[chain]
  const notes: string[] = []
  const resolve = async (b: number) => {
    const r = await setupMulticall(
      ctx,
      OUT,
      chain,
      (['getPool', 'getPriceOracle', 'getPoolDataProvider'] as const).map((fn) => ({
        target: A.provider,
        abi: providerAbi,
        fn,
      })),
      b,
    )
    return r.map((x) => lc(String(x.value)))
  }
  const [pool, oracle, dp] = await resolve(b0)
  const [pool2, oracle2, dp2] = await resolve(bEnd)
  if (pool !== pool2 || oracle !== oracle2 || dp !== dp2)
    throw new Error(`${chain}: pool/oracle/dataProvider changed inside the window`)
  if (oracle !== lc(A.oracle)) throw new Error(`${chain}: oracle ${oracle} != expected ${A.oracle}`)
  if (!pool.startsWith(A.poolPrefix))
    throw new Error(`${chain}: pool ${pool} != expected ${A.poolPrefix}…`)

  const list = async (b: number) => {
    const s = await setupCall(
      ctx,
      OUT,
      chain,
      pool,
      enc({ target: pool, abi: poolAbi, fn: 'getReservesList' }),
      b,
    )
    return (
      dec<string[]>({ abi: poolAbi, fn: 'getReservesList' }, s.ans.result as Hex) as string[]
    ).map(lc)
  }
  const startList = await list(b0)
  const endList = await list(bEnd)
  const reserves = [...startList, ...endList.filter((a) => !startList.includes(a))]
  if (reserves.length !== startList.length || endList.length !== startList.length)
    notes.push(
      `reserve list changed in window: start ${startList.length}, end ${endList.length}, union ${reserves.length}`,
    )

  const misc = await setupMulticall(
    ctx,
    OUT,
    chain,
    [
      { target: oracle, abi: oracleAbi, fn: 'BASE_CURRENCY_UNIT' },
      { target: oracle, abi: oracleAbi, fn: 'BASE_CURRENCY' },
      { target: oracle, abi: oracleAbi, fn: 'getFallbackOracle' },
      { target: pool, abi: poolAbi, fn: 'POOL_REVISION' },
    ],
    b0,
  )
  const perAsset = (b: number) =>
    setupMulticall(
      ctx,
      OUT,
      chain,
      reserves.flatMap((a) => [
        { target: a, abi: erc20Abi, fn: 'symbol' },
        { target: a, abi: erc20Abi, fn: 'decimals' },
        { target: oracle, abi: oracleAbi, fn: 'getSourceOfAsset', args: [a] },
        { target: pool, abi: poolAbi, fn: 'getReserveData', args: [a] },
      ]),
      b,
    )
  const s0 = await perAsset(b0)
  const s1 = await perAsset(bEnd)
  const assets: AaveAsset[] = reserves.map((a, k) => {
    const sym = s0[4 * k]
    let symbol = sym.ok ? String(sym.value) : ''
    if (!sym.ok && sym.raw && sym.raw.length === 66) {
      // bytes32 symbol (MKR-style)
      symbol = Buffer.from(sym.raw.slice(2), 'hex').toString('utf8').replace(/\0+$/, '')
    }
    const rd0 = s0[4 * k + 3].value as { id: number; configuration: bigint } | undefined
    const rd1 = s1[4 * k + 3].value as { id: number; configuration: bigint } | undefined
    const src0 = lc(String(s0[4 * k + 2].value))
    const src1 = lc(String(s1[4 * k + 2].value))
    if (src0 !== src1) notes.push(`${a} (${symbol}) price source changed: ${src0} -> ${src1}`)
    if (rd0 && rd1 && rd0.configuration !== rd1.configuration)
      notes.push(`${a} (${symbol}) reserve configuration changed in window`)
    return {
      address: a,
      symbol,
      decimals: Number(s0[4 * k + 1].value),
      id: Number(rd0?.id ?? rd1?.id ?? -1),
      source: src0,
      sourceEnd: src1,
      configStart: rd0 ? rd0.configuration.toString() : '',
      configEnd: rd1 ? rd1.configuration.toString() : '',
      inListStart: startList.includes(a),
      inListEnd: endList.includes(a),
    }
  })
  const emodeStart = await readEModes(ctx, chain, pool, b0)
  const emodeEnd = await readEModes(ctx, chain, pool, bEnd)
  if (JSON.stringify(emodeStart) !== JSON.stringify(emodeEnd))
    notes.push('e-mode categories changed in window')
  const setup: AaveSetup = {
    chain,
    pool,
    oracle,
    dataProvider: dp,
    poolRevision: String(misc[3].value),
    baseUnit: String(misc[0].value),
    baseCurrency: lc(String(misc[1].value)),
    fallbackOracle: lc(String(misc[2].value)),
    b0,
    bEnd,
    reserves,
    assets,
    emodeStart,
    emodeEnd,
    notes,
  }
  writeJson(path, setup)
  return setup
}

export function aaveMinuteCalls(setup: AaveSetup) {
  const perAsset: SubCall[] = setup.reserves.map((a) => ({
    target: setup.oracle,
    abi: oracleAbi,
    fn: 'getAssetPrice',
    args: [a],
  }))
  return {
    perAsset,
    call(mode: string) {
      if (mode === 'primary')
        return {
          to: setup.oracle,
          data: enc({
            target: setup.oracle,
            abi: oracleAbi,
            fn: 'getAssetsPrices',
            args: [setup.reserves],
          }),
        }
      return { to: MULTICALL3, data: encMulticall(perAsset) }
    },
  }
}

export async function aaveOracle(ctx: Ctx, chain: ChainKey) {
  const setup = await aaveSetup(ctx, chain)
  const blocks = loadMinuteBlocks(ctx, chain)
  const calls = aaveMinuteCalls(setup)
  const R = setup.reserves.length
  const res = await runSeries(ctx, {
    output: OUT,
    chain,
    blocks,
    storePath: join(ctx.stateDir, `aave-prices.${chain}.jsonl`),
    columns: R,
    call: calls.call,
    fallbackMode: 'per-asset',
    decode(row) {
      if (row.a.rev !== undefined)
        return { values: Array(R).fill(null), errors: Array(R).fill(`revert: ${row.a.rev}`) }
      if (row.mode === 'primary') {
        const [arr] = decodeAbiParameters([{ type: 'uint256[]' }], row.a.r as Hex)
        if (arr.length !== R) throw new Error('getAssetsPrices length mismatch')
        return { values: arr.map((x) => x.toString()), errors: Array(R).fill(null) }
      }
      const sub = decMulticall(calls.perAsset, row.a.r as Hex)
      return {
        values: sub.map((s) => (s.ok ? (s.value as bigint).toString() : null)),
        errors: sub.map((s) => (s.ok ? null : revertReason(s.err))),
      }
    },
  })
  const out = {
    chain,
    oracle: setup.oracle,
    pool: setup.pool,
    poolRevision: setup.poolRevision,
    baseUnit: setup.baseUnit,
    baseCurrency: setup.baseCurrency,
    startTs: START_TS,
    stepSeconds: STEP_SEC,
    count: STEPS,
    call: 'AaveOracle.getAssetsPrices(reservesList) at blocks[i] (eth_call, block = highest block with ts <= startTs + 60*i); on a revert, Multicall3 aggregate3 of getAssetPrice(asset) per asset',
    assets: setup.assets.map((a) => ({
      address: a.address,
      symbol: a.symbol,
      decimals: a.decimals,
      id: a.id,
      source: a.source,
      sourceEnd: a.sourceEnd,
      inListStart: a.inListStart,
      inListEnd: a.inListEnd,
    })),
    setupNotes: setup.notes,
    blocks,
    prices: Object.fromEntries(setup.reserves.map((a, c) => [a, res.values[c]])),
    nullRuns: Object.fromEntries(
      setup.reserves
        .filter((_, c) => res.errors.has(c))
        .map((a) => [a, errorRuns(res.errors.get(setup.reserves.indexOf(a)))]),
    ),
    callModes: res.modes,
    hosts: res.hosts,
    minuteHost: res.minuteHost,
    verification: ctx.verifier.stats(OUT, chain),
  }
  writeFileSync(join(ctx.outDir, `aave-oracle-1m.${chain}.json.gz`), gzipSync(JSON.stringify(out)))
  return out
}
