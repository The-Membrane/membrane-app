// Read-only USDS expansion of the fixed Compound III weekly prevalence screen.
// node scripts/research/compound-comet-usds-weekly-screen.mjs --out /private/tmp/compound-comet-usds-weekly-400d.json
import { pathToFileURL } from 'node:url'
import {
  GRID,
  EXPECTED,
  SCENARIOS_USD,
  blocks,
  collect as collectComet,
  coverage as coverageComet,
  summarize as summarizeComet,
  validRow as validCometRow,
} from './compound-comet-weekly-screen.mjs'

export { GRID, EXPECTED, SCENARIOS_USD, blocks }
export const STUDY = 'Compound III Ethereum USDS weekly cash prevalence expansion'
export const MARKETS = Object.freeze([
  {
    name: 'cUSDSv3',
    comet: '0x5D409e56D886231aDAf00c8775665AD0f9897b56',
    base: '0xdC035D45d973E3EC169d2276DDab16f1e407384F',
    decimals: 18,
  },
])

export const validRow = (row) => validCometRow(row, MARKETS)
export const coverage = (rows) => coverageComet(rows, MARKETS)
export const summarize = (rows) => summarizeComet(rows, MARKETS)
export const collect = (options) => collectComet({ ...options, study: STUDY, markets: MARKETS })

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2),
    opts = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || args[i + 1] === undefined)
      throw new Error(
        'Usage: --out ABSOLUTE_PATH [--max-new COUNT] [--batch-size COUNT] [--rpc URL]',
      )
    opts[args[i].slice(2)] = args[i + 1]
  }
  const result = await collect({
    out: opts.out,
    maxNew: opts['max-new'] === undefined ? Infinity : Number(opts['max-new']),
    batchSize: opts['batch-size'] === undefined ? 4 : Number(opts['batch-size']),
    rpc: opts.rpc,
  })
  console.log(
    JSON.stringify({
      status: result.status,
      coverage: result.coverage,
      failedReadCount: result.failedReadCount,
      summary: result.status === 'complete' ? summarize(result.rows) : null,
    }),
  )
}
