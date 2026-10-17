/**
 * Load every census input from the datasets clone: the owner's CSVs and the on-chain pull
 * (recall-coverage/inputs/oct10/onchain/, see its PROVENANCE.md and events-scan.json), at the
 * full scope — every Aave V3 registry pool and every Morpho Blue singleton on mainnet,
 * Arbitrum, Optimism and Base. build-census.ts and scripts/tests/wavefront-census.test.ts
 * both read through here so they can never load different inputs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

import { AAVE_CORE_POOL } from '../../lib/wavefront/pid'
import type { StreamWindow } from '../../lib/wavefront/stream'
import type { CensusInputs } from './census'
import { aaveEvents as readAaveCsv, morphoEvents as readMorphoCsv, parseCsv } from './inputs'

/** One AaveOracle minute path per Aave market with events; keyed in the inputs by the file's own `${chain}:${pool}`. */
export const AAVE_ORACLE_FILES: string[] = [
  'aave-oracle-1m.mainnet.json.gz',
  'aave-oracle-1m.arbitrum.json.gz',
  'aave-oracle-1m.optimism.json.gz',
  'aave-oracle-1m.base.json.gz',
  'aave-oracle-1m.mainnet.lido.json.gz',
]
export const MORPHO_ORACLE_FILES: Record<string, string> = {
  mainnet: 'morpho-oracle-1m.mainnet.json.gz',
  base: 'morpho-oracle-1m.base.json.gz',
  arbitrum: 'morpho-oracle-1m.arbitrum.json.gz',
}

const gzJson = (p: string) => JSON.parse(gunzipSync(fs.readFileSync(p)).toString())
const gzLines = (p: string) =>
  gunzipSync(fs.readFileSync(p))
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

/** The _extra.csv rows normalised the way inputs.ts normalises the owner's rows. */
function extraAaveCsv(file: string) {
  return parseCsv(fs.readFileSync(file, 'utf8')).map((r) => ({
    ...r,
    block_number: Number(r.block_number),
    ts: Number(r.ts),
    tx_hash: r.tx_hash.toLowerCase(),
    log_index: Number(r.log_index),
    user: r.user.toLowerCase(),
    collateral_asset: r.collateral_asset.toLowerCase(),
    debt_asset: r.debt_asset.toLowerCase(),
  }))
}
function extraMorphoCsv(file: string) {
  return parseCsv(fs.readFileSync(file, 'utf8')).map((r) => ({
    ...r,
    block_number: Number(r.block_number),
    ts: Number(r.ts),
    tx_hash: r.tx_hash.toLowerCase(),
    log_index: Number(r.log_index),
    market_id: r.market_id.toLowerCase(),
    borrower: r.borrower.toLowerCase(),
    oracle: r.oracle.toLowerCase(),
    collateral_token: r.collateral_token.toLowerCase(),
    loan_token: r.loan_token.toLowerCase(),
  }))
}

export function censusInputFiles(datasets: string): string[] {
  const inputs = path.join(datasets, 'recall-coverage', 'inputs', 'oct10')
  const on = path.join(inputs, 'onchain')
  return [
    path.join(inputs, 'aave_liquidations_enriched.csv'),
    path.join(inputs, 'morpho_liquidations.csv'),
    path.join(on, 'aave_liquidations_extra.csv'),
    path.join(on, 'morpho_liquidations_extra.csv'),
    path.join(on, 'aave-events.jsonl.gz'),
    path.join(on, 'aave-events-extra.jsonl.gz'),
    path.join(on, 'aave-protocol-fee.jsonl.gz'),
    path.join(on, 'morpho-events.jsonl.gz'),
    path.join(on, 'morpho-events-extra.jsonl.gz'),
    ...AAVE_ORACLE_FILES.map((f) => path.join(on, f)),
    ...Object.values(MORPHO_ORACLE_FILES).map((f) => path.join(on, f)),
  ]
}

export function loadCensusInputs(datasets: string): CensusInputs {
  for (const f of censusInputFiles(datasets)) {
    if (!fs.existsSync(f)) throw new Error(`census inputs: missing ${f}`)
  }
  const inputs = path.join(datasets, 'recall-coverage', 'inputs', 'oct10')
  const on = path.join(inputs, 'onchain')
  const aaveOracle = Object.fromEntries(
    AAVE_ORACLE_FILES.map((f) => {
      const o = gzJson(path.join(on, f))
      return [`${o.chain}:${String(o.pool).toLowerCase()}`, o]
    }),
  )
  const morphoOracle = Object.fromEntries(
    Object.entries(MORPHO_ORACLE_FILES).map(([k, f]) => [k, gzJson(path.join(on, f))]),
  )
  const ref = aaveOracle[`mainnet:${AAVE_CORE_POOL.mainnet}`]
  const window: StreamWindow = {
    startTs: ref.startTs,
    stepSeconds: ref.stepSeconds,
    minutes: ref.count,
  }
  for (const [k, f] of [...Object.entries(aaveOracle), ...Object.entries(morphoOracle)] as [
    string,
    any,
  ][]) {
    if (
      f.startTs !== window.startTs ||
      f.stepSeconds !== window.stepSeconds ||
      f.count !== window.minutes
    ) {
      throw new Error(`census inputs: the ${k} oracle file is on a different grid`)
    }
  }
  return {
    window,
    aaveCsv: [
      ...readAaveCsv(inputs),
      ...extraAaveCsv(path.join(on, 'aave_liquidations_extra.csv')),
    ] as any,
    aaveEvents: [
      ...gzLines(path.join(on, 'aave-events.jsonl.gz')),
      ...gzLines(path.join(on, 'aave-events-extra.jsonl.gz')),
    ],
    aaveFees: gzLines(path.join(on, 'aave-protocol-fee.jsonl.gz')),
    aaveOracle,
    morphoCsv: [
      ...readMorphoCsv(inputs),
      ...extraMorphoCsv(path.join(on, 'morpho_liquidations_extra.csv')),
    ] as any,
    morphoEvents: [
      ...gzLines(path.join(on, 'morpho-events.jsonl.gz')),
      ...gzLines(path.join(on, 'morpho-events-extra.jsonl.gz')),
    ],
    morphoOracle,
  }
}
