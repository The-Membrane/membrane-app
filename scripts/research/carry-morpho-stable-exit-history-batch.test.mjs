import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  freezeFullPlan,
  saveCellOnce,
  stableSubjects,
  validatePlan,
} from './carry-morpho-stable-exit-history.mjs'
import { parseArgs, runBatch } from './carry-morpho-stable-exit-history-batch.mjs'

const byVault = new Map(stableSubjects().map((subject) => [subject.vault, subject]))
const block = (number) => ({
  number: BigInt(number),
  hash: `0x${number.toString(16).padStart(64, '0')}`,
  timestamp: BigInt(number) * 12n,
})
const plan = await freezeFullPlan({
  getChainId: async () => 1,
  getBlock: async ({ blockTag, blockNumber }) =>
    block(blockTag === 'finalized' ? 26_090_000 : Number(blockNumber)),
  readContract: async ({ address, functionName }) => {
    if (functionName === 'asset') return byVault.get(address).asset
    if (functionName === 'totalAssets') return 50_000_000n * 1_000_000n
    throw Error(`unexpected_read_${functionName}`)
  },
})
validatePlan(plan)

const missingCell = (frozen) => {
  const body = {
    planSha256: plan.planSha256,
    anchorBlock: frozen.anchorBlock,
    vault: frozen.vault,
    routeKey: frozen.routeKey,
    status: 'rpc_unavailable',
    row: {
      vault: frozen.vault,
      asset: frozen.asset,
      anchorBlock: frozen.anchorBlock,
      status: 'rpc_unavailable',
    },
  }
  return {
    ...body,
    cellSha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  }
}

test('CLI arguments keep each invocation bounded and summary read-only', () => {
  assert.deepEqual(parseArgs(['plan.json', 'results']), {
    planPath: 'plan.json',
    directory: 'results',
    limit: 1,
    summaryOnly: false,
  })
  assert.equal(parseArgs(['plan.json', 'results', '--limit', '10']).limit, 10)
  assert.equal(parseArgs(['plan.json', 'results', '--summary']).summaryOnly, true)
  for (const args of [
    ['plan.json', 'results', '--limit', '0'],
    ['plan.json', 'results', '--limit', '11'],
    ['plan.json', 'results', '--limit', '1.5'],
    ['plan.json', 'results', '--limit', '2', '--limit', '3'],
    ['plan.json', 'results', '--summary', '--limit', '1'],
  ])
    assert.throws(() => parseArgs(args))
})

test('saved cells replay; new cells run sequentially and persist explicit RPC missingness', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stable-batch-'))
  try {
    saveCellOnce(plan, missingCell(plan.cells[0]), directory)
    const calls = []
    let clients = 0
    const run = () => ({
      limit: 2,
      createClient: () => {
        clients++
        return {}
      },
      executeCell: async (_client, _plan, anchorBlock, vault) => {
        calls.push(`${anchorBlock}:${vault}`)
        return missingCell(
          plan.cells.find((x) => x.anchorBlock === anchorBlock && x.vault === vault),
        )
      },
    })
    const first = await runBatch(plan, directory, run())
    assert.equal(first.processedThisRun, 2)
    assert.equal(first.completedCells, 3)
    assert.equal(first.remainingCells, 157)
    assert.equal(first.cellStatus.rpc_unavailable, 3)
    assert.deepEqual(
      calls,
      plan.cells.slice(1, 3).map((x) => `${x.anchorBlock}:${x.vault}`),
    )
    assert.equal(clients, 1)

    const summary = await runBatch(plan, directory, {
      summaryOnly: true,
      createClient: () => {
        throw Error('summary_created_rpc_client')
      },
    })
    assert.equal(summary.processedThisRun, 0)
    assert.equal(summary.completedCells, 3)
    const printed = JSON.stringify(summary)
    assert.ok(!printed.includes(plan.cells[0].vault))
    assert.ok(!printed.includes(plan.cells[0].totalAssetsRaw))

    const second = await runBatch(plan, directory, run())
    assert.equal(second.completedCells, 5)
    assert.deepEqual(
      calls.slice(2),
      plan.cells.slice(3, 5).map((x) => `${x.anchorBlock}:${x.vault}`),
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('thrown cell error stops the batch and preserves its last checkpoint', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stable-batch-'))
  try {
    let calls = 0
    await assert.rejects(
      runBatch(plan, directory, {
        limit: 3,
        createClient: () => ({}),
        executeCell: async (_client, _plan, anchorBlock, vault) => {
          calls++
          if (calls === 2) throw Error('archive unavailable for holder 0xdeadbeef')
          return missingCell(
            plan.cells.find((x) => x.anchorBlock === anchorBlock && x.vault === vault),
          )
        },
      }),
      /batch_stopped cell=2 checkpointed=1 reason=cell_failed/,
    )
    assert.equal(calls, 2)
    const saved = await runBatch(plan, directory, { summaryOnly: true })
    assert.equal(saved.completedCells, 1)
    assert.equal(saved.remainingCells, 159)
    const resumed = await runBatch(plan, directory, {
      limit: 1,
      createClient: () => ({}),
      executeCell: async () => missingCell(plan.cells[1]),
    })
    assert.equal(resumed.completedCells, 2)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('corrupt saved evidence fails before client creation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stable-batch-'))
  try {
    const saved = saveCellOnce(plan, missingCell(plan.cells[0]), directory)
    writeFileSync(saved.path, '{}\n')
    let clients = 0
    await assert.rejects(
      runBatch(plan, directory, {
        createClient: () => {
          clients++
          return {}
        },
      }),
      /cell_plan_mismatch/,
    )
    assert.equal(clients, 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
