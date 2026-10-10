// Fixed, finite Aave USDC supply-gap campaign. Local env holds the Alchemy
// archive credential; Ankr is the independent public RPC origin.
import { resolve } from 'node:path'
import { readEnv } from '../lib/venue-reads.mjs'
import { backfillDirectSupplierFlow } from './backfill-carry-direct-supplier-flow.mjs'

export const FROM_BLOCK = 26_084_071
export const TO_BLOCK = 26_093_529
export const OUT = resolve('data/research/venue-signals/direct-supplier-flow')

export async function tick({ rpcUrls, backfill = backfillDirectSupplierFlow } = {}) {
  const result = await backfill({
    marketKey: 'aaveV3Usdc',
    flowKind: 'supply',
    fromBlock: FROM_BLOCK,
    toBlock: TO_BLOCK,
    outDir: OUT,
    maxSegments: 4,
    rpcUrls,
  })
  return {
    status: result.status,
    throughBlock: result.throughBlock,
    requestedToBlock: result.requestedToBlock,
    newSegments: result.newSegments,
    reconciledSupplies: result.reconciledSupplies,
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  try {
    const archive = readEnv().get('RECORDER_RPC_URL')
    if (!archive) throw new Error('missing_archive_rpc')
    process.stdout.write(
      `${JSON.stringify(await tick({ rpcUrls: `${archive},https://rpc.ankr.com/eth` }))}\n`,
    )
  } catch {
    process.stderr.write('aave_usdc_supply_gap_tick_failed\n')
    process.exitCode = 1
  }
}
