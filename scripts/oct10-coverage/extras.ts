/**
 * Extras step: every in-scope liquidation the scope scan found on chain that the owner's CSVs
 * lack, read exactly like the CSV events (./aaveEvents.ts, ./morphoEvents.ts), plus the minute
 * oracle paths of every market / oracle they add, plus CSV-equivalent rows decoded from the logs
 * so the census can take them as it takes the owner's rows.
 *
 * Outputs (never touching the original files):
 *   aave-events-extra.jsonl.gz, morpho-events-extra.jsonl.gz   same records + market/pool fields
 *   aave_liquidations_extra.csv, morpho_liquidations_extra.csv  the owner's columns (+ market, pool)
 *   aave-oracle-1m.<chain>.<market>.json.gz                     AaveOracle path of each new market
 *   morpho-oracle-1m.<chain>[.extra].json.gz                    Morpho oracles not covered before
 */
import { join } from 'path'
import { writeFileSync } from 'fs'
import { MORPHO_BY_CHAIN, morphoAbi } from './abi'
import { aaveOracleFor, marketTag, type AaveMarket } from './aaveOracle'
import { aaveEventsStep, type AaveRow } from './aaveEvents'
import { STEPS, type Ctx } from './ctx'
import { loadMinuteBlocks } from './minuteBlocks'
import { morphoEventsStep, type MorphoRow } from './morphoEvents'
import { morphoOracleFor, morphoSetup, type MorphoSetup } from './morphoOracle'
import type { ChainKey } from './rpc'
import { loadScope } from './scope'
import { setupMulticall } from './setupCall'
import { readJson, writeJson } from './store'

const lc = (s: string) => s.toLowerCase()

/** Exact decimal string of raw / 10^dec (trailing zeros trimmed). */
export function normalize(raw: bigint, dec: number): string {
  const neg = raw < 0n
  const v = neg ? -raw : raw
  const unit = 10n ** BigInt(dec)
  const i = v / unit
  let f = (v % unit).toString().padStart(dec, '0').replace(/0+$/, '')
  if (dec === 0) f = ''
  return (neg ? '-' : '') + i.toString() + (f ? '.' + f : '')
}
const ratio = (a: bigint, b: bigint) => (b === 0n ? '' : String(Number(a) / Number(b)))
const round8 = (x: number) => String(Math.round(x * 1e8) / 1e8)

function toCsv(header: string[], rows: Record<string, unknown>[]) {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return (
    [header.join(','), ...rows.map((r) => header.map((h) => esc(r[h])).join(','))].join('\n') + '\n'
  )
}

const AAVE_COLS = [
  'chain',
  'block_number',
  'ts',
  'tx_hash',
  'log_index',
  'collateral_asset',
  'collateral_symbol',
  'debt_asset',
  'debt_symbol',
  'user',
  'debt_to_cover_raw',
  'debt_to_cover_normalized',
  'liquidated_collateral_raw',
  'liquidated_collateral_normalized',
  'liquidator',
  'receive_atoken',
  'pre_debt_raw',
  'pre_debt_normalized',
  'pre_collateral_raw',
  'pre_collateral_normalized',
  'debt_fraction_repaid',
  'collateral_fraction_seized',
  'health_factor',
  'total_collateral_base_usd',
  'total_debt_base_usd',
  'intra_block_seq',
  'position_read_ok',
  'market',
  'pool',
]
const MORPHO_COLS = [
  'chain',
  'block_number',
  'ts',
  'tx_hash',
  'log_index',
  'market_id',
  'caller',
  'borrower',
  'repaid_assets',
  'repaid_assets_normalized',
  'repaid_shares',
  'seized_assets',
  'seized_assets_normalized',
  'bad_debt_assets',
  'bad_debt_assets_normalized',
  'bad_debt_shares',
  'collateral_token',
  'collateral_symbol',
  'loan_token',
  'loan_symbol',
  'lltv',
  'oracle',
  'irm',
  'pre_borrow_shares',
  'pre_debt_assets_raw_preaccrual',
  'pre_debt_assets_normalized_preaccrual',
  'pre_collateral_raw',
  'pre_collateral_normalized',
  'debt_fraction_repaid',
  'collateral_fraction_seized',
  'full_liquidation',
  'intra_block_seq',
  'position_read_ok',
  'morpho',
]

export async function extrasStep(ctx: Ctx, chains: ChainKey[]) {
  const scope = loadScope(ctx)
  const summary: Record<string, unknown> = {}

  // ---------------------------------------------------------------- Aave
  const extraA = scope.extraAave.filter((e) => chains.includes(e.chain))
  const markets: AaveMarket[] = []
  for (const e of extraA) {
    if (e.market === 'core') continue
    const m = scope.markets.find((x) => x.chain === e.chain && x.key === e.market)!
    if (!markets.some((x) => x.chain === m.chain && x.key === m.key))
      markets.push({ chain: m.chain, key: m.key, provider: m.provider })
  }
  // Minute oracle paths of the new markets.
  const oracleFiles: string[] = []
  for (const m of markets) {
    await aaveOracleFor(ctx, m)
    oracleFiles.push(`aave-oracle-1m.${marketTag(m)}.json.gz`)
  }
  // Intra-block sequence as the owner's CSV counts it: 0-based per (block, user, collateral, debt)
  // within one pool.
  const seqA = new Map<string, number>()
  const sortedA = [...extraA].sort(
    (a, b) => a.block_number - b.block_number || a.log_index - b.log_index,
  )
  const seqOf = new Map<string, number>()
  for (const e of sortedA) {
    const g = `${e.chain}|${e.pool}|${e.block_number}|${e.user}|${e.collateral_asset}|${e.debt_asset}`
    const n = seqA.get(g) ?? 0
    seqA.set(g, n + 1)
    seqOf.set(`${e.tx_hash}:${e.log_index}`, n)
  }
  const aRows: AaveRow[] = sortedA.map((e) => ({
    chain: e.chain,
    block_number: e.block_number,
    ts: e.ts,
    tx_hash: e.tx_hash,
    log_index: e.log_index,
    user: e.user,
    collateral_asset: e.collateral_asset,
    debt_asset: e.debt_asset,
    health_factor: '',
    total_collateral_base_usd: '',
    total_debt_base_usd: '',
    debt_to_cover_raw: e.debt_to_cover_raw,
    liquidated_collateral_raw: e.liquidated_collateral_raw,
    liquidator: e.liquidator,
    receive_atoken: e.receive_atoken,
    pool: e.pool,
    market: e.market,
    ...(e.market === 'core' ? {} : { mkt: `${e.chain}.${e.market}` }),
  }))
  const csvA: Record<string, unknown>[] = []
  const aStats = aRows.length
    ? await aaveEventsStep(ctx, chains, {
        rows: aRows,
        markets,
        file: 'aave-events-extra.jsonl.gz',
        out: 'aave-events-extra',
        store: 'aave-events-extra-calls.jsonl',
        verifyEvery: true,
        extraFields(r, ev) {
          const k = (a: string) => ev.setup.reserves.indexOf(a)
          const kc = k(r.collateral_asset)
          const kd = k(r.debt_asset)
          const ac = ev.setup.assets[kc]
          const ad = ev.setup.assets[kd]
          const preDebt = ev.u.reserves[kd].variableDebt + ev.u.reserves[kd].stableDebt
          const preColl = ev.u.reserves[kc].aToken
          const dtc = BigInt(String(r.debt_to_cover_raw))
          const liq = BigInt(String(r.liquidated_collateral_raw))
          const unit = Number(ev.setup.baseUnit)
          const csv = {
            chain: r.chain,
            block_number: r.block_number,
            ts: r.ts,
            tx_hash: r.tx_hash,
            log_index: r.log_index,
            collateral_asset: r.collateral_asset,
            collateral_symbol: ac.symbol,
            debt_asset: r.debt_asset,
            debt_symbol: ad.symbol,
            user: r.user,
            debt_to_cover_raw: dtc.toString(),
            debt_to_cover_normalized: normalize(dtc, ad.decimals),
            liquidated_collateral_raw: liq.toString(),
            liquidated_collateral_normalized: normalize(liq, ac.decimals),
            liquidator: r.liquidator,
            receive_atoken: r.receive_atoken ? 'True' : 'False',
            pre_debt_raw: preDebt.toString(),
            pre_debt_normalized: normalize(preDebt, ad.decimals),
            pre_collateral_raw: preColl.toString(),
            pre_collateral_normalized: normalize(preColl, ac.decimals),
            debt_fraction_repaid: ratio(dtc, preDebt),
            collateral_fraction_seized: ratio(liq, preColl),
            health_factor: String(Number(ev.u.account.healthFactor) / 1e18),
            total_collateral_base_usd: String(Number(ev.u.account.totalCollateralBase) / unit),
            total_debt_base_usd: String(Number(ev.u.account.totalDebtBase) / unit),
            intra_block_seq: seqOf.get(`${r.tx_hash}:${r.log_index}`) ?? 0,
            position_read_ok: 'True',
            market: String(r.market),
            pool: String(r.pool),
          }
          csvA.push(csv)
          return { market: r.market, pool: r.pool, provider: ev.setup.provider ?? null, csv }
        },
      })
    : null
  if (csvA.length) {
    csvA.sort(
      (a, b) =>
        String(a.chain).localeCompare(String(b.chain)) ||
        Number(a.block_number) - Number(b.block_number) ||
        Number(a.log_index) - Number(b.log_index),
    )
    writeFileSync(join(ctx.outDir, 'aave_liquidations_extra.csv'), toCsv(AAVE_COLS, csvA))
  }
  summary.aave = {
    events: aRows.length,
    markets: markets.map(marketTag),
    oracleFiles,
    stats: aStats,
  }

  // ---------------------------------------------------------------- Morpho
  const extraM = scope.extraMorpho.filter((e) => chains.includes(e.chain))
  const byChain = new Map<ChainKey, typeof extraM>()
  for (const e of extraM) byChain.set(e.chain, [...(byChain.get(e.chain) ?? []), e])
  const setups = new Map<string, MorphoSetup>()
  const mRows: MorphoRow[] = []
  const morphoFiles: string[] = []
  for (const [chain, evs] of byChain) {
    const blocks = loadMinuteBlocks(ctx, chain)
    // Market params first (the rows carry them, as the owner's rows do).
    const ids = [...new Set(evs.map((e) => e.market_id))].sort()
    const params = new Map<string, string[]>()
    for (const b of [blocks[0], blocks[STEPS - 1]]) {
      const r = await setupMulticall(
        ctx,
        'morpho-oracle-1m.extra',
        chain,
        ids.map((id) => ({
          target: MORPHO_BY_CHAIN[chain],
          abi: morphoAbi,
          fn: 'idToMarketParams',
          args: [id],
        })),
        b,
      )
      ids.forEach((id, k) => {
        const v = r[k].ok ? (r[k].value as unknown[]).map((x) => lc(String(x))) : null
        if (v && v[0] !== '0x0000000000000000000000000000000000000000' && !params.has(id))
          params.set(id, v)
      })
    }
    // Chains the owner's CSV covers keep their file; the extras get chain.extra.
    const csvChain = !!readJson(join(ctx.stateDir, `morpho-setup.${chain}.json`))
    const tag = csvChain ? `${chain}.extra` : chain
    const seq = new Map<string, number>()
    const rows: MorphoRow[] = [...evs]
      .sort((a, b) => a.block_number - b.block_number || a.log_index - b.log_index)
      .map((e) => {
        const p = params.get(e.market_id)
        if (!p) throw new Error(`${chain} market ${e.market_id}: no params`)
        const g = `${e.block_number}|${e.borrower}|${e.market_id}`
        const n = (seq.get(g) ?? 0) + 1
        seq.set(g, n)
        return {
          chain,
          block_number: e.block_number,
          ts: e.ts,
          tx_hash: e.tx_hash,
          log_index: e.log_index,
          market_id: e.market_id,
          borrower: e.borrower,
          oracle: p[2],
          irm: p[3],
          lltv: String(Number(BigInt(p[4])) / 1e18),
          collateral_token: p[1],
          loan_token: p[0],
          pre_borrow_shares: '',
          pre_debt_assets_raw_preaccrual: '',
          pre_collateral_raw: '',
          caller: e.caller,
          repaid_assets: e.repaid_assets,
          repaid_shares: e.repaid_shares,
          seized_assets: e.seized_assets,
          bad_debt_assets: e.bad_debt_assets,
          bad_debt_shares: e.bad_debt_shares,
          intra_block_seq: String(n),
          morpho: e.morpho,
          mkt: tag,
        }
      })
    const setup = await morphoSetup(ctx, chain, { rows, tag })
    setups.set(tag, setup)
    mRows.push(...rows)
    // Minute paths for oracles no earlier file covers.
    const covered = new Set<string>()
    if (csvChain) for (const o of (await morphoSetup(ctx, chain)).oracles) covered.add(o)
    const fresh = setup.oracles.filter((o) => !covered.has(o))
    if (fresh.length) {
      await morphoOracleFor(ctx, chain, setup, tag, fresh)
      morphoFiles.push(`morpho-oracle-1m.${tag}.json.gz`)
    }
  }
  const csvM: Record<string, unknown>[] = []
  const mStats = mRows.length
    ? await morphoEventsStep(ctx, chains, {
        rows: mRows,
        setups,
        file: 'morpho-events-extra.jsonl.gz',
        out: 'morpho-events-extra',
        store: 'morpho-events-extra-calls.jsonl',
        verifyEvery: true,
        extraFields(r, e) {
          const m = e.m as {
            loanDecimals: number
            collateralDecimals: number
            loanSymbol: string
            collateralSymbol: string
          }
          const st = e.st as { borrowShares: bigint; collateral: bigint }
          const pre = e.borrowedPreDown as bigint
          const ra = BigInt(String(r.repaid_assets))
          const rs = BigInt(String(r.repaid_shares))
          const sa = BigInt(String(r.seized_assets))
          const ba = BigInt(String(r.bad_debt_assets))
          const csv = {
            chain: r.chain,
            block_number: r.block_number,
            ts: r.ts,
            tx_hash: r.tx_hash,
            log_index: r.log_index,
            market_id: r.market_id,
            caller: r.caller,
            borrower: r.borrower,
            repaid_assets: ra.toString(),
            repaid_assets_normalized: normalize(ra, m.loanDecimals),
            repaid_shares: rs.toString(),
            seized_assets: sa.toString(),
            seized_assets_normalized: normalize(sa, m.collateralDecimals),
            bad_debt_assets: ba.toString(),
            bad_debt_assets_normalized: normalize(ba, m.loanDecimals),
            bad_debt_shares: String(r.bad_debt_shares),
            collateral_token: r.collateral_token,
            collateral_symbol: m.collateralSymbol,
            loan_token: r.loan_token,
            loan_symbol: m.loanSymbol,
            lltv: r.lltv,
            oracle: r.oracle,
            irm: r.irm,
            pre_borrow_shares: st.borrowShares.toString(),
            pre_debt_assets_raw_preaccrual: pre.toString(),
            pre_debt_assets_normalized_preaccrual: normalize(pre, m.loanDecimals),
            pre_collateral_raw: st.collateral.toString(),
            pre_collateral_normalized: normalize(st.collateral, m.collateralDecimals),
            // The owner's convention, measured on its rows: repaid SHARES over pre-borrow shares,
            // capped at 1, 8 decimals; seized over pre-collateral, 8 decimals.
            debt_fraction_repaid: st.borrowShares
              ? round8(Math.min(1, Number(rs) / Number(st.borrowShares)))
              : '',
            collateral_fraction_seized: st.collateral
              ? round8(Number(sa) / Number(st.collateral))
              : '',
            full_liquidation: '',
            intra_block_seq: r.intra_block_seq,
            position_read_ok: '1',
            morpho: String(r.morpho),
          }
          csvM.push(csv)
          return { morpho: r.morpho, csv }
        },
      })
    : null
  if (csvM.length) {
    csvM.sort(
      (a, b) =>
        String(a.chain).localeCompare(String(b.chain)) ||
        Number(a.block_number) - Number(b.block_number) ||
        Number(a.log_index) - Number(b.log_index),
    )
    writeFileSync(join(ctx.outDir, 'morpho_liquidations_extra.csv'), toCsv(MORPHO_COLS, csvM))
  }
  summary.morpho = {
    events: mRows.length,
    setups: [...setups.keys()],
    oracleFiles: morphoFiles,
    stats: mStats,
  }
  writeJson(join(ctx.stateDir, 'extras.summary.json'), summary)
  return summary
}
