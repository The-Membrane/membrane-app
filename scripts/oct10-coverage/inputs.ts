/** Read the owner's Oct 10 CSV pulls (read only). */
import { readFileSync } from 'fs'
import { join } from 'path'
import type { ChainKey } from './rpc'

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else q = false
      } else cell += ch
    } else if (ch === '"') q = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      cell = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else cell += ch
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  const [head, ...body] = rows
  return body.map((r) => Object.fromEntries(head.map((h, k) => [h, r[k] ?? ''])))
}

export interface AaveEventRow {
  chain: ChainKey
  block_number: number
  ts: number
  tx_hash: string
  log_index: number
  user: string
  collateral_asset: string
  debt_asset: string
  health_factor: string
  total_collateral_base_usd: string
  total_debt_base_usd: string
  [k: string]: unknown
}
export interface MorphoEventRow {
  chain: ChainKey
  block_number: number
  ts: number
  tx_hash: string
  log_index: number
  market_id: string
  borrower: string
  oracle: string
  irm: string
  lltv: string
  collateral_token: string
  loan_token: string
  pre_borrow_shares: string
  pre_debt_assets_raw_preaccrual: string
  pre_collateral_raw: string
  [k: string]: unknown
}

export function aaveEvents(inputsDir: string): AaveEventRow[] {
  return parseCsv(readFileSync(join(inputsDir, 'aave_liquidations_enriched.csv'), 'utf8')).map(
    (r) => ({
      ...r,
      chain: r.chain as ChainKey,
      block_number: Number(r.block_number),
      ts: Number(r.ts),
      tx_hash: r.tx_hash.toLowerCase(),
      log_index: Number(r.log_index),
      user: r.user.toLowerCase(),
      collateral_asset: r.collateral_asset.toLowerCase(),
      debt_asset: r.debt_asset.toLowerCase(),
      health_factor: r.health_factor,
      total_collateral_base_usd: r.total_collateral_base_usd,
      total_debt_base_usd: r.total_debt_base_usd,
    }),
  )
}

export function morphoEvents(inputsDir: string): MorphoEventRow[] {
  return parseCsv(readFileSync(join(inputsDir, 'morpho_liquidations.csv'), 'utf8')).map((r) => ({
    ...r,
    chain: r.chain as ChainKey,
    block_number: Number(r.block_number),
    ts: Number(r.ts),
    tx_hash: r.tx_hash.toLowerCase(),
    log_index: Number(r.log_index),
    market_id: r.market_id.toLowerCase(),
    borrower: r.borrower.toLowerCase(),
    oracle: r.oracle.toLowerCase(),
    irm: r.irm.toLowerCase(),
    lltv: r.lltv,
    collateral_token: r.collateral_token.toLowerCase(),
    loan_token: r.loan_token.toLowerCase(),
    pre_borrow_shares: r.pre_borrow_shares,
    pre_debt_assets_raw_preaccrual: r.pre_debt_assets_raw_preaccrual,
    pre_collateral_raw: r.pre_collateral_raw,
  }))
}
