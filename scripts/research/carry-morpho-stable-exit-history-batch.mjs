// Bounded, resumable collection of the already-frozen retrospective cells.
// This is historical research only; it does not issue or score forecasts.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import {
  readSavedCell,
  runCell,
  saveCellOnce,
  summarize,
  validatePlan,
} from './carry-morpho-stable-exit-history.mjs'

const MAX_CELLS_PER_RUN = 10

export function parseArgs(args) {
  if (args.length < 2) throw Error('usage: <plan.json> <directory> [--limit N | --summary]')
  const [planPath, directory, ...flags] = args
  if (!planPath || !directory || planPath.startsWith('--') || directory.startsWith('--'))
    throw Error('batch_arguments_invalid')

  let limit = 1
  let summaryOnly = false
  let limitSeen = false
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--summary' && !summaryOnly) {
      summaryOnly = true
    } else if (flags[i] === '--limit' && !limitSeen) {
      limitSeen = true
      const value = flags[++i]
      if (!/^[1-9]\d*$/.test(value || '')) throw Error('batch_limit_invalid')
      limit = Number(value)
      if (!Number.isSafeInteger(limit) || limit > MAX_CELLS_PER_RUN)
        throw Error('batch_limit_invalid')
    } else {
      throw Error('batch_arguments_invalid')
    }
  }
  if (summaryOnly && limitSeen) throw Error('batch_arguments_invalid')
  return { planPath, directory, limit, summaryOnly }
}

const safeReason = (error) =>
  /^[a-z][a-z0-9_]*$/i.test(error?.message || '') ? error.message : 'cell_failed'

/** Sequential execution. Saved cells are integrity-checked before any new RPC work. */
export async function runBatch(
  plan,
  directory,
  {
    limit = 1,
    summaryOnly = false,
    createClient,
    readCell = readSavedCell,
    executeCell = runCell,
    saveCell = saveCellOnce,
  } = {},
) {
  validatePlan(plan)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CELLS_PER_RUN)
    throw Error('batch_limit_invalid')

  const completed = []
  const pending = []
  for (const frozen of plan.cells) {
    const saved = readCell(plan, frozen.anchorBlock, frozen.vault, directory)
    if (saved) completed.push(saved.cell)
    else pending.push(frozen)
  }
  if (summaryOnly || pending.length === 0)
    return { processedThisRun: 0, remainingCells: pending.length, ...summarize(plan, completed) }

  const client =
    createClient?.() ??
    (() => {
      const rpc = process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
      if (!rpc) throw Error('rpc_required')
      return makeClient(rpc)
    })()

  let processedThisRun = 0
  for (const frozen of pending.slice(0, limit)) {
    try {
      const cell = await executeCell(client, plan, frozen.anchorBlock, frozen.vault)
      saveCell(plan, cell, directory)
      completed.push(cell)
      processedThisRun++
    } catch (error) {
      throw Error(
        `batch_stopped cell=${plan.cells.indexOf(frozen) + 1} checkpointed=${completed.length} reason=${safeReason(error)}`,
      )
    }
  }
  return {
    processedThisRun,
    remainingCells: pending.length - processedThisRun,
    ...summarize(plan, completed),
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const main = async () => {
    if (process.argv[2] === '--help') {
      process.stdout.write(
        'usage: <plan.json> <directory> [--limit N | --summary] (default N=1, maximum N=10)\n',
      )
      return
    }
    const { planPath, directory, limit, summaryOnly } = parseArgs(process.argv.slice(2))
    const plan = JSON.parse(readFileSync(planPath, 'utf8'))
    const result = await runBatch(plan, directory, { limit, summaryOnly })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  }
  main().catch((error) => {
    const message = error?.message || ''
    process.stderr.write(
      `${/^batch_stopped cell=\d+ checkpointed=\d+ reason=[a-z0-9_]+$/i.test(message) ? message : safeReason(error)}\n`,
    )
    process.exitCode = 1
  })
}
