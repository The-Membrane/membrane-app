import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeEventTopics, parseAbiItem } from 'viem'

import { lossIntervals } from './carry-morpho-exit-history-grid.mjs'
import {
  DESIGN,
  freezeFullPlan,
  runCell,
  saveCellOnce,
  savePlanOnce,
  stableSubjects,
  verifySavedCellExactHolderProbesWithRpc,
} from './carry-morpho-stable-exit-history.mjs'
import {
  describeLedger,
  Q_ASSETS_RAW,
  readSavedLedger,
  ROUTE_KEY,
} from './morpho-v2-usdc-10k-holder-risk-ledger.mjs'

const subjects = stableSubjects()
const byVault = new Map(subjects.map((subject) => [subject.vault, subject]))
const hash = (number) => `0x${Number(number).toString(16).padStart(64, '0')}`
const holder = `0x${'4'.repeat(40)}`
const event = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)')
const reseal = ({ cellSha256, ...body }) => ({
  ...body,
  cellSha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
})

function client(vault, anchors = []) {
  const logs = anchors.map((anchor, index) => ({
    address: vault,
    transactionHash: `0x${String(index + 5).repeat(64)}`,
    blockNumber: BigInt(anchor - 1),
    blockHash: hash(anchor - 1),
    transactionIndex: 0,
    logIndex: 0,
    topics: encodeEventTopics({
      abi: [event],
      eventName: 'Transfer',
      args: { from: `0x${'0'.repeat(40)}`, to: holder },
    }),
    data: `0x${'1'.padStart(64, '0')}`,
  }))
  return {
    async getChainId() {
      return 1
    },
    async getBlock({ blockTag, blockNumber }) {
      const n = blockTag === 'finalized' ? 26_090_000 : Number(blockNumber)
      return { number: BigInt(n), hash: hash(n), timestamp: BigInt(n) * 12n }
    },
    async readContract({ address, functionName }) {
      if (functionName === 'asset') return byVault.get(address).asset
      if (functionName === 'totalAssets') return 50_000_000n * 1_000_000n
      if (functionName === 'decimals') return address === vault ? 18 : 6
      if (functionName === 'balanceOf') return 1_000_000_000_000_000_000_000_000n
      if (functionName === 'previewRedeem') return 1_000_000n * 1_000_000n
      if (functionName === 'previewWithdraw') return 100n
      throw Error(`unexpected_read_${functionName}`)
    },
    async getCode({ address }) {
      return address === holder ? '0x' : '0x1234'
    },
    async getLogs({ fromBlock, toBlock }) {
      return logs.filter((log) => fromBlock <= log.blockNumber && toBlock >= log.blockNumber)
    },
    async getTransactionReceipt({ hash: transactionHash }) {
      const log = logs.find((item) => item.transactionHash === transactionHash)
      return {
        status: 'success',
        transactionHash,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        logs: [{ ...log }],
      }
    },
    async call() {
      return { data: `0x${'1'.padStart(64, '0')}` }
    },
  }
}

function withRevert(cell, hours) {
  const changed = structuredClone(cell)
  const size = changed.row.sizes.find((item) => item.label === 'fixed_10k')
  const sample = size.horizons.find((item) => item.hours === hours)
  sample.call = { status: 'evm_revert' }
  sample.class = 'evm_revert'
  size.exitInterval = lossIntervals(size)
  return reseal(changed)
}

test('keeps all planned USDC cells and the reserved anchor as explicit denominators', async () => {
  const usdc = subjects.find((subject) => subject.routeKey === ROUTE_KEY)
  const plan = await freezeFullPlan(client(usdc.vault))
  const ledger = describeLedger(plan, [])
  assert.equal(ledger.qAssetsRaw, Q_ASSETS_RAW)
  assert.equal(ledger.counts.all.plannedCells, 132)
  assert.equal(ledger.counts.all.missingCells, 132)
  assert.equal(ledger.counts.reservedHoldout.plannedCells, 33)
  assert.equal(ledger.counts.development.plannedCells, 99)
  assert.equal(ledger.counts.all.baselineSuccessEpisodes, 0)
  assert.equal(ledger.limits.forecastValidated, false)
  assert.equal(ledger.limits.prospectiveSamples, 0)
  const usdt = subjects.find((subject) => subject.routeKey !== ROUTE_KEY)
  const usdtCell = await runCell(client(usdc.vault), plan, DESIGN.anchors[0], usdt.vault)
  assert.throws(() => describeLedger(plan, [usdtCell]), /ledger_non_usdc_cell/)
})

test('records interval-censored loss/recovery once per episode and holder-vault cluster', async () => {
  const usdc = subjects.find((subject) => subject.routeKey === ROUTE_KEY)
  const anchors = [DESIGN.anchors[0], DESIGN.reservedHoldoutAnchor]
  const rpc = client(usdc.vault, anchors)
  const plan = await freezeFullPlan(rpc)
  const first = withRevert(await runCell(rpc, plan, anchors[0], usdc.vault), 4)
  const holdout = await runCell(rpc, plan, anchors[1], usdc.vault)
  const ledger = describeLedger(plan, [first, holdout])
  assert.equal(ledger.counts.all.baselineSuccessEpisodes, 2)
  assert.equal(ledger.counts.all.holderVaultClusters, 1)
  assert.equal(ledger.counts.sharedHolderVaultClustersAcrossSplits, 1)
  assert.equal(ledger.counts.development.observedFirstLossEpisodes, 1)
  assert.equal(ledger.counts.development.observedRecoveryEpisodes, 1)
  assert.equal(ledger.counts.reservedHoldout.baselineSuccessEpisodes, 1)
  assert.equal(ledger.counts.reservedHoldout.observedFirstLossEpisodes, 0)
  assert.deepEqual(ledger.episodes[0].firstObservedLossIntervalHours, {
    after: 1,
    through: 4,
    hasMissingInterveningSample: false,
  })
  assert.deepEqual(ledger.episodes[0].observedRecoveryIntervalHours, {
    after: 4,
    through: 24,
    hasMissingInterveningSample: false,
  })
  assert.equal(ledger.episodes[1].firstLossRightCensoredAtHours, 168)
  const gap = structuredClone(first)
  const gapSize = gap.row.sizes.find((item) => item.label === 'fixed_10k')
  const atOne = gapSize.horizons.find((item) => item.hours === 1)
  atOne.call = { status: 'rpc_unavailable' }
  atOne.class = 'rpc_unavailable'
  gapSize.exitInterval = lossIntervals(gapSize)
  const gapLedger = describeLedger(plan, [reseal(gap)])
  assert.deepEqual(gapLedger.episodes[0].firstObservedLossIntervalHours, {
    after: 0,
    through: 4,
    hasMissingInterveningSample: true,
  })
  assert.equal(gapLedger.counts.development.episodesWithMissingHorizonSamples, 1)
  assert.throws(() => describeLedger(plan, [first, first]), /ledger_duplicate_cell/)
  const forged = structuredClone(holdout)
  const forgedSize = forged.row.sizes.find((item) => item.label === 'fixed_10k')
  const forgedH1 = forgedSize.horizons.find((item) => item.hours === 1)
  forgedH1.call = { status: 'bogus' }
  forgedH1.class = 'evm_revert'
  forgedSize.exitInterval = lossIntervals(forgedSize)
  assert.throws(() => describeLedger(plan, [reseal(forged)]), /ledger_call_status_invalid/)
  assert.throws(
    () =>
      describeLedger(plan, [
        first,
        {
          ...first,
          routeKey: 'USDT → VaultV2 [USDT]',
        },
      ]),
    /cell_route_invalid|cell_plan_mismatch/,
  )
})

test('holder attrition censors risk, and the disk reader rejects noncanonical plan bytes', async () => {
  const usdc = subjects.find((subject) => subject.routeKey === ROUTE_KEY)
  const rpc = client(usdc.vault, [DESIGN.anchors[0]])
  const plan = await freezeFullPlan(rpc)
  const original = await runCell(rpc, plan, DESIGN.anchors[0], usdc.vault)
  const attrition = structuredClone(original)
  const size = attrition.row.sizes.find((item) => item.label === 'fixed_10k')
  const sample = size.horizons.find((item) => item.hours === 1)
  sample.state.sharesRaw = '0'
  sample.call = { status: 'evm_revert' }
  sample.class = 'holder_attrition'
  size.exitInterval = lossIntervals(size)
  const cell = reseal(attrition)
  const directory = mkdtempSync(join(tmpdir(), 'morpho-usdc-ledger-'))
  try {
    const planFile = savePlanOnce(plan, directory)
    saveCellOnce(plan, cell, directory)
    const ledger = readSavedLedger(directory)
    assert.equal(ledger.source, 'saved_retrospective_cells_disk_integrity_only')
    assert.equal(ledger.counts.development.baselineSuccessEpisodes, 1)
    assert.equal(ledger.counts.development.observedFirstLossEpisodes, 0)
    assert.equal(ledger.counts.development.holderAttritionCensoredEpisodes, 1)
    assert.equal(ledger.episodes[0].censoring.class, 'holder_attrition')
    appendFileSync(planFile.path, '\n')
    assert.throws(() => readSavedLedger(directory), /ledger_plan_artifact_invalid/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('replays a saved exact holder and fixed Q at frozen hashes without log rediscovery', async () => {
  const usdc = subjects.find((subject) => subject.routeKey === ROUTE_KEY)
  const anchor = DESIGN.anchors[0]
  const rpc = client(usdc.vault, [anchor])
  const plan = await freezeFullPlan(rpc)
  const original = await runCell(rpc, plan, anchor, usdc.vault)
  const directory = mkdtempSync(join(tmpdir(), 'morpho-usdc-probe-'))
  const forgedDirectory = mkdtempSync(join(tmpdir(), 'morpho-usdc-forged-'))
  try {
    savePlanOnce(plan, directory)
    saveCellOnce(plan, original, directory)
    const replay = await verifySavedCellExactHolderProbesWithRpc(
      rpc,
      plan,
      anchor,
      usdc.vault,
      directory,
    )
    assert.equal(replay.probesSourceRevalidated, true)
    assert.equal(replay.holderDiscoveryRevalidated, false)
    assert.deepEqual(replay.verifiedHours, [0, 1, 4, 24, 48, 168])

    savePlanOnce(plan, forgedDirectory)
    saveCellOnce(plan, withRevert(original, 1), forgedDirectory)
    await assert.rejects(
      verifySavedCellExactHolderProbesWithRpc(rpc, plan, anchor, usdc.vault, forgedDirectory),
      /cell_probe_rpc_mismatch_1/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
    rmSync(forgedDirectory, { recursive: true, force: true })
  }
})
