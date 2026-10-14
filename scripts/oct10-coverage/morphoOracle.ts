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
  MORPHO_BY_CHAIN,
  MULTICALL3,
  revertReason,
  type SubCall,
} from './abi'
import { START_TS, STEP_SEC, STEPS, type Ctx } from './ctx'
import { morphoEvents, type MorphoEventRow } from './inputs'
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

/**
 * Market params, decimals and symbols for the markets of `rows` (default: the owner's CSV rows of
 * the chain), cached as morpho-setup.<tag>.json. Params are read at the window's first minute
 * block, or at its last for a market created inside the window.
 */
export async function morphoSetup(
  ctx: Ctx,
  chain: ChainKey,
  opts: { rows?: MorphoEventRow[]; tag?: string } = {},
): Promise<MorphoSetup> {
  const path = join(ctx.stateDir, `morpho-setup.${opts.tag ?? chain}.json`)
  const cached = readJson<MorphoSetup>(path)
  if (cached) return cached
  const SOUT = (opts.tag ?? chain) === chain ? OUT : `${OUT}.extra`
  const rows = opts.rows ?? morphoEvents(ctx.inputsDir).filter((r) => r.chain === chain)
  const blocks = loadMinuteBlocks(ctx, chain)
  const b0 = blocks[0]
  const morpho = MORPHO_BY_CHAIN[chain]
  const ids = [...new Set(rows.map((r) => r.market_id))].sort()
  const readParams = (b: number) =>
    setupMulticall(
      ctx,
      SOUT,
      chain,
      ids.map((id) => ({ target: morpho, abi: morphoAbi, fn: 'idToMarketParams', args: [id] })),
      b,
    )
  const params = await readParams(b0)
  const zero = (k: number) =>
    !params[k].ok ||
    (params[k].value as string[])[0] === '0x0000000000000000000000000000000000000000'
  if (ids.some((_, k) => zero(k))) {
    const late = await readParams(blocks[STEPS - 1])
    ids.forEach((_, k) => {
      if (zero(k)) params[k] = late[k]
    })
  }
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
    SOUT,
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
  return morphoOracleFor(ctx, chain, await morphoSetup(ctx, chain), chain)
}

/**
 * The minute path of `oracles` (default: every oracle of the setup), written as
 * morpho-oracle-1m.<tag>.json.gz. Tag = the chain for the CSV markets (and for a chain the CSV
 * does not cover); chain.extra for markets added by the scope scan on a CSV chain.
 */
export async function morphoOracleFor(
  ctx: Ctx,
  chain: ChainKey,
  setup: MorphoSetup,
  tag: string,
  oracles: string[] = setup.oracles,
) {
  const seriesOut = tag === chain ? OUT : `${OUT}.extra`
  const blocks = loadMinuteBlocks(ctx, chain)
  const subs = morphoPriceCalls(oracles)
  const O = subs.length
  const res = await runSeries(ctx, {
    output: seriesOut,
    chain,
    blocks,
    storePath: join(ctx.stateDir, `morpho-prices.${tag}.jsonl`),
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
    morpho: MORPHO_BY_CHAIN[chain].toLowerCase(),
    startTs: START_TS,
    stepSeconds: STEP_SEC,
    count: STEPS,
    priceScale:
      '1e36 * 10^(loanDecimals - collateralDecimals): loan units per collateral unit, raw',
    call: 'Multicall3.aggregate3([oracle.price() for each oracle], allowFailure=true) at blocks[i]',
    oracles: oracles.map((o) => ({
      address: o,
      markets: setup.markets.filter((m) => m.oracle === o).map((m) => m.id),
    })),
    markets: setup.markets.filter((m) => oracles.includes(m.oracle)),
    blocks,
    prices: Object.fromEntries(oracles.map((o, c) => [o, res.values[c]])),
    nullRuns: Object.fromEntries(
      oracles
        .map((o, c) => [o, errorRuns(res.errors.get(c))])
        .filter(([, v]) => (v as unknown[]).length),
    ),
    hosts: res.hosts,
    minuteHost: res.minuteHost,
    verification: ctx.verifier.stats(seriesOut, chain),
  }
  writeFileSync(join(ctx.outDir, `morpho-oracle-1m.${tag}.json.gz`), gzipSync(JSON.stringify(out)))
  return out
}
