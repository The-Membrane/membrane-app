/**
 * Step 3: Morpho Blue oracle price path per chain: for every distinct oracle in
 * morpho_liquidations.csv, price() (1e36-scaled) at every minute block, batched per minute via
 * Multicall3 aggregate3 (allowFailure). Market params are read on chain (idToMarketParams) and
 * asserted against the CSV.
 */
import { join } from 'path'
import { writeFileSync } from 'fs'
import { gzipSync } from 'zlib'
import type { Hex } from 'viem'
import {
  decMulticall,
  encMulticall,
  erc20Abi,
  morphoAbi,
  morphoOracleAbi,
  MORPHO_BLUE,
  MULTICALL3,
  revertReason,
  type SubCall,
} from './abi'
import { START_TS, STEP_SEC, STEPS, type Ctx } from './ctx'
import { morphoEvents } from './inputs'
import { loadMinuteBlocks } from './minuteBlocks'
import type { ChainKey } from './rpc'
import { errorRuns, runSeries } from './series'
import { setupMulticall } from './setupCall'
import { readJson, writeJson } from './store'

const OUT = 'morpho-oracle-1m'
const lc = (s: string) => s.toLowerCase()

export interface MorphoMarket {
  id: string
  loanToken: string
  collateralToken: string
  oracle: string
  irm: string
  lltv: string
  loanDecimals: number
  collateralDecimals: number
  loanSymbol: string
  collateralSymbol: string
  events: number
}
export interface MorphoSetup {
  chain: ChainKey
  b0: number
  oracles: string[]
  markets: MorphoMarket[]
}

export async function morphoSetup(ctx: Ctx, chain: ChainKey): Promise<MorphoSetup> {
  const path = join(ctx.stateDir, `morpho-setup.${chain}.json`)
  const cached = readJson<MorphoSetup>(path)
  if (cached) return cached
  const rows = morphoEvents(ctx.inputsDir).filter((r) => r.chain === chain)
  const blocks = loadMinuteBlocks(ctx, chain)
  const b0 = blocks[0]
  const ids = [...new Set(rows.map((r) => r.market_id))].sort()
  const params = await setupMulticall(
    ctx,
    OUT,
    chain,
    ids.map((id) => ({ target: MORPHO_BLUE, abi: morphoAbi, fn: 'idToMarketParams', args: [id] })),
    b0,
  )
  const mp = ids.map((id, k) => {
    if (!params[k].ok) throw new Error(`${chain} market ${id}: idToMarketParams failed`)
    const [loanToken, collateralToken, oracle, irm, lltv] = params[k].value as [
      string,
      string,
      string,
      string,
      bigint,
    ]
    const csv = rows.find((r) => r.market_id === id)!
    const ok =
      lc(loanToken) === csv.loan_token &&
      lc(collateralToken) === csv.collateral_token &&
      lc(oracle) === csv.oracle &&
      lc(irm) === csv.irm &&
      Math.abs(Number(lltv) / 1e18 - Number(csv.lltv)) < 1e-12
    if (!ok) throw new Error(`${chain} market ${id}: on-chain params disagree with the CSV`)
    return {
      id,
      loanToken: lc(loanToken),
      collateralToken: lc(collateralToken),
      oracle: lc(oracle),
      irm: lc(irm),
      lltv: lltv.toString(),
      events: rows.filter((r) => r.market_id === id).length,
    }
  })
  const tokens = [...new Set(mp.flatMap((m) => [m.loanToken, m.collateralToken]))]
  const meta = await setupMulticall(
    ctx,
    OUT,
    chain,
    tokens.flatMap((t) => [
      { target: t, abi: erc20Abi, fn: 'decimals' },
      { target: t, abi: erc20Abi, fn: 'symbol' },
    ]),
    b0,
  )
  const dec = (t: string) => {
    const r = meta[2 * tokens.indexOf(t)]
    if (!r.ok) throw new Error(`${chain} ${t}: decimals() failed`)
    return Number(r.value)
  }
  const sym = (t: string) => {
    const r = meta[2 * tokens.indexOf(t) + 1]
    if (r.ok) return String(r.value)
    if (r.raw?.length === 66)
      return Buffer.from(r.raw.slice(2), 'hex').toString('utf8').replace(/\0+$/, '')
    return ''
  }
  const markets: MorphoMarket[] = mp.map((m) => ({
    ...m,
    loanDecimals: dec(m.loanToken),
    collateralDecimals: dec(m.collateralToken),
    loanSymbol: sym(m.loanToken),
    collateralSymbol: sym(m.collateralToken),
  }))
  const setup: MorphoSetup = {
    chain,
    b0,
    oracles: [...new Set(markets.map((m) => m.oracle))].sort(),
    markets,
  }
  writeJson(path, setup)
  return setup
}

export function morphoPriceCalls(oracles: string[]): SubCall[] {
  return oracles.map((o) => ({ target: o, abi: morphoOracleAbi, fn: 'price' }))
}

export async function morphoOracle(ctx: Ctx, chain: ChainKey) {
  const setup = await morphoSetup(ctx, chain)
  const blocks = loadMinuteBlocks(ctx, chain)
  const subs = morphoPriceCalls(setup.oracles)
  const O = subs.length
  const res = await runSeries(ctx, {
    output: OUT,
    chain,
    blocks,
    storePath: join(ctx.stateDir, `morpho-prices.${chain}.jsonl`),
    columns: O,
    call: () => ({ to: MULTICALL3, data: encMulticall(subs) }),
    decode(row) {
      if (row.a.rev !== undefined)
        return {
          values: Array(O).fill(null),
          errors: Array(O).fill(`multicall revert: ${row.a.rev}`),
        }
      const r = decMulticall(subs, row.a.r as Hex)
      return {
        values: r.map((s) => (s.ok ? (s.value as bigint).toString() : null)),
        errors: r.map((s) => (s.ok ? null : revertReason(s.err))),
      }
    },
  })
  const out = {
    chain,
    morpho: MORPHO_BLUE.toLowerCase(),
    startTs: START_TS,
    stepSeconds: STEP_SEC,
    count: STEPS,
    priceScale:
      '1e36 * 10^(loanDecimals - collateralDecimals): loan units per collateral unit, raw',
    call: 'Multicall3.aggregate3([oracle.price() for each oracle], allowFailure=true) at blocks[i]',
    oracles: setup.oracles.map((o) => ({
      address: o,
      markets: setup.markets.filter((m) => m.oracle === o).map((m) => m.id),
    })),
    markets: setup.markets,
    blocks,
    prices: Object.fromEntries(setup.oracles.map((o, c) => [o, res.values[c]])),
    nullRuns: Object.fromEntries(
      setup.oracles
        .map((o, c) => [o, errorRuns(res.errors.get(c))])
        .filter(([, v]) => (v as unknown[]).length),
    ),
    hosts: res.hosts,
    minuteHost: res.minuteHost,
    verification: ctx.verifier.stats(OUT, chain),
  }
  writeFileSync(
    join(ctx.outDir, `morpho-oracle-1m.${chain}.json.gz`),
    gzipSync(JSON.stringify(out)),
  )
  return out
}
