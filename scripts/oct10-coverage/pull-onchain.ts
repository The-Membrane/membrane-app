/**
 * Oct 10-11 2025 liquidation replay: resumable on-chain data pull.
 *
 * Prices every liquidated Aave V3 / Morpho Blue position from the protocol's OWN oracle, read on
 * chain at the block in force at each minute of the window, on each chain (mainnet, Arbitrum,
 * Optimism, Base), and reads every liquidation's position at block N-1.
 *
 *   tsx scripts/oct10-coverage/pull-onchain.ts [--steps blocks,aave,morpho,aave-events,morpho-events,chainlink,summary]
 *        [--chains mainnet,arbitrum,optimism,base] [--state /tmp/oct10-pull-state]
 *
 * Inputs (read only): <datasets>/recall-coverage/inputs/oct10/{aave_liquidations_enriched,morpho_liquidations}.csv
 * Outputs:            <datasets>/recall-coverage/inputs/oct10/onchain/
 * State (resumable):  --state (default $OCT10_PULL_STATE or /tmp/oct10-pull-state). Every unit of
 *                     work is checkpointed; a re-run skips finished work.
 *
 * Every result that feeds a dataset is cross-verified (./verify.ts): a deterministic >= 4% sample,
 * plus every anomalous value (zero, revert, >20% one-minute jump), is re-asked on a different
 * backend group and must be byte-equal; a disagreement goes to a third group and the loser is
 * quarantined (its other answers are re-asked).
 */
import { join } from 'path'
import { mkdirSync } from 'fs'
import { datasetPath } from '../lib/datasetsDir.mjs'
import { RpcPool, CHAINS, type ChainKey } from './rpc'
import { Verifier } from './verify'
import { readJson, writeJson } from './store'
import type { Ctx } from './ctx'
import { minuteBlocks } from './minuteBlocks'
import { aaveOracle } from './aaveOracle'
import { morphoOracle } from './morphoOracle'
import { morphoEvents as morphoRows } from './inputs'
import { aaveEventsStep } from './aaveEvents'
import { morphoEventsStep } from './morphoEvents'
import { chainlinkCheck } from './chainlinkCheck'
import { summaryStep } from './summary'

const STEP_NAMES = [
  'blocks',
  'aave',
  'morpho',
  'aave-events',
  'morpho-events',
  'chainlink',
  'summary',
] as const
type StepName = (typeof STEP_NAMES)[number]

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const t0 = Date.now()
  const steps = (arg('steps') ?? STEP_NAMES.join(',')).split(',') as StepName[]
  for (const s of steps) if (!STEP_NAMES.includes(s)) throw new Error(`unknown step ${s}`)
  const chains = (arg('chains') ?? CHAINS.join(',')).split(',') as ChainKey[]
  const stateDir = arg('state') ?? process.env.OCT10_PULL_STATE ?? '/tmp/oct10-pull-state'
  const inputsDir = datasetPath(process.cwd(), 'recall-coverage', 'inputs', 'oct10') as string
  const outDir = join(inputsDir, 'onchain')
  mkdirSync(outDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })

  const qPath = join(stateDir, 'quarantine.json')
  const pool = new RpcPool(undefined, readJson(qPath) ?? [])
  const verifier = new Verifier(pool, join(stateDir, 'verify.jsonl'))
  const ctx: Ctx = { pool, verifier, stateDir, outDir, inputsDir }
  const runLog = readJson<Record<string, unknown>[]>(join(stateDir, 'runs.json')) ?? []
  const run: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    steps,
    chains,
    stepSeconds: {} as Record<string, number>,
  }

  const saveState = () => {
    writeJson(qPath, pool.quarantined())
    run.calls = pool.calls
    run.wallSeconds = Math.round((Date.now() - t0) / 1000)
    run.ledger = pool.ledger()
    writeJson(join(stateDir, 'runs.json'), [...runLog, run])
  }
  const timer = setInterval(saveState, 60_000)
  try {
    for (const step of steps) {
      const s0 = Date.now()
      process.stderr.write(`== step ${step} ${new Date().toISOString()}\n`)
      if (step === 'blocks') await minuteBlocks(ctx, chains)
      // The two oracle paths share nothing but the endpoints: run them together when both asked.
      if (step === 'aave' || step === 'morpho') {
        const both = steps.includes('aave') && steps.includes('morpho')
        if (step === 'morpho' && both) continue
        const mc = [...new Set(morphoRows(inputsDir).map((r) => r.chain))].filter((c) =>
          chains.includes(c),
        )
        await Promise.all([
          ...(step === 'aave' ? chains.map((c) => aaveOracle(ctx, c)) : []),
          ...(step === 'morpho' || both ? mc.map((c) => morphoOracle(ctx, c)) : []),
        ])
      }
      if (step === 'aave-events')
        writeJson(join(stateDir, 'aave-events.summary.json'), await aaveEventsStep(ctx, chains))
      if (step === 'morpho-events')
        writeJson(join(stateDir, 'morpho-events.summary.json'), await morphoEventsStep(ctx, chains))
      if (step === 'chainlink') await chainlinkCheck(ctx, chains)
      if (step === 'summary') {
        // The summary reads the ledger: write this run's entry first.
        saveState()
        await summaryStep(ctx, process.cwd())
      }
      ;(run.stepSeconds as Record<string, number>)[step] = Math.round((Date.now() - s0) / 1000)
      saveState()
    }
  } finally {
    clearInterval(timer)
    saveState()
  }
  process.stderr.write(`done in ${Math.round((Date.now() - t0) / 1000)}s, ${pool.calls} calls\n`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
