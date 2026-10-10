import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeEventTopics, parseAbiItem } from 'viem'
import { lossIntervals } from './carry-morpho-exit-history-grid.mjs'

import {
  DESIGN,
  freezeCell,
  freezeFullPlan,
  runCell,
  readSavedCell,
  saveCellOnce,
  savePlanOnce,
  stableSubjects,
  summarize,
  validatePlan,
  verifySavedCellWithRpc,
} from './carry-morpho-stable-exit-history.mjs'

const subjects = stableSubjects()
const byVault = new Map(subjects.map((x) => [x.vault, x]))
const hash = (n) => `0x${Number(n).toString(16).padStart(64, '0')}`
const reseal = ({ cellSha256, ...body }) => ({
  ...body,
  cellSha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
})
const block = (n) => ({ number: BigInt(n), hash: hash(n), timestamp: BigInt(n) * 12n })

function client() {
  let holderReads = 0
  return {
    get holderReads() {
      return holderReads
    },
    async getChainId() {
      return 1
    },
    async getBlock({ blockTag, blockNumber }) {
      return block(blockTag === 'finalized' ? 26_090_000 : Number(blockNumber))
    },
    async readContract({ address, functionName }) {
      if (functionName === 'asset') return byVault.get(address).asset
      if (functionName === 'totalAssets') return 50_000_000n * 1_000_000n
      holderReads++
      if (functionName === 'decimals') return address in Object.fromEntries(byVault) ? 18 : 6
      throw Error(`unexpected_read_${functionName}`)
    },
    async getCode() {
      return '0x1234'
    },
    async getLogs() {
      return []
    },
  }
}

test('manifest selects exactly 40 pinned USDC/USDT direct-underlying vaults', () => {
  assert.equal(subjects.length, 40)
  assert.deepEqual(
    subjects.map((x) => x.vault),
    [...subjects.map((x) => x.vault)].sort(),
  )
  assert.ok(
    subjects.every((x) => DESIGN.assets.includes(x.asset) && x.creationBlock < DESIGN.anchors[0]),
  )
  assert.ok(
    subjects.every(
      (x) =>
        x.routeKey ===
        (x.asset === DESIGN.assets[0] ? 'USDC → VaultV2 [USDC]' : 'USDT → VaultV2 [USDT]'),
    ),
  )
  assert.equal(DESIGN.forecast, false)
  assert.equal(DESIGN.prospectiveValidated, false)
  assert.match(DESIGN.cohortSelection, /current pinned tracked-set survivors/)
  assert.equal(DESIGN.reservedHoldoutAnchor, 26_000_000)
})

test('full schedule and six Q per cell freeze before any holder search', async () => {
  const rpc = client()
  const plan = await freezeFullPlan(rpc)
  assert.equal(validatePlan(plan), true)
  assert.equal(rpc.holderReads, 0)
  assert.equal(plan.cells.length, 160)
  assert.ok(plan.cells.every((x) => x.status === 'frozen' && x.sizes.length === 6))
  assert.deepEqual(
    plan.schedule.anchors.map((x) => x.anchor.number),
    DESIGN.anchors,
  )
  assert.ok(plan.schedule.anchors.every((x) => x.horizons.length === 5))
  assert.ok(plan.schedule.anchors.every((x) => x.horizons.every((h) => h.status === 'fixed')))
  assert.equal(plan.cells[0].sizes[0].assetsRaw, '10000000000')
  assert.equal(plan.cells[0].sizes[3].assetsRaw, '50000000000')
  assert.equal(
    plan.schedule.anchors[1].anchor.timestamp - plan.schedule.anchors[0].anchor.timestamp,
    2_400_000,
  )
  assert.equal(summarize(plan, []).unmeasuredSizeCells, 960)
  assert.equal(summarize(plan, []).unmeasuredHorizonSizeCells, 4_800)
})

test('plan tampering and anchor overlap fail closed', async () => {
  const plan = await freezeFullPlan(client())
  assert.throws(() => validatePlan({ ...plan, cells: plan.cells.slice(1) }), /stable_plan_invalid/)
  const changed = structuredClone(plan)
  changed.cells[0].sizes[0].assetsRaw = '1'
  assert.throws(() => validatePlan(changed), /stable_plan_invalid/)
  const overlap = structuredClone(plan)
  overlap.schedule.anchors[1].anchor.timestamp = overlap.schedule.anchors[0].anchor.timestamp + 1
  assert.throws(() => validatePlan(overlap), /stable_plan_invalid/)
})

test('preflight preserves route mismatch and RPC missing rather than dropping cells', async () => {
  const subject = subjects[0]
  const anchor = {
    number: DESIGN.anchors[0],
    hash: hash(DESIGN.anchors[0]),
    timestamp: DESIGN.anchors[0] * 12,
  }
  const mismatch = await freezeCell(
    {
      readContract: async ({ functionName }) =>
        functionName === 'asset' ? `0x${'0'.repeat(40)}` : 1n,
    },
    subject,
    anchor,
  )
  assert.equal(mismatch.status, 'asset_identity_mismatch')
  const missing = await freezeCell(
    {
      readContract: async () => {
        throw Error('archive unavailable')
      },
    },
    subject,
    anchor,
  )
  assert.equal(missing.status, 'preflight_rpc_unavailable')
})

test('one-cell execution reuses grid and keeps a no-holder denominator', async () => {
  const rpc = client()
  const plan = await freezeFullPlan(rpc)
  const result = await runCell(rpc, plan, DESIGN.anchors[0], subjects[0].vault)
  assert.equal(result.status, 'no_eligible_holder')
  assert.equal(result.row.candidateWindow.screened, 0)
  assert.equal(result.row.sizes, undefined)
  const summary = summarize(plan, [result])
  assert.equal(summary.completedCells, 1)
  assert.equal(summary.cellStatus.no_eligible_holder, 1)
  assert.equal(summary.cellStatus.pending, 159)
  assert.equal(summary.unmeasuredSizeCells, 960)
  assert.equal(summary.independentObservations, false)
  assert.throws(() => summarize(plan, [result, result]), /cell_duplicate/)
})

test('receipt-verified measured holder retains frozen Q, five horizons and dependent cluster', async () => {
  const rpc = client()
  const plan = await freezeFullPlan(rpc)
  const subject = subjects[0]
  const anchorBlock = DESIGN.anchors[0]
  const holder = `0x${'4'.repeat(40)}`
  const tx = `0x${'5'.repeat(64)}`
  const event = parseAbiItem(
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  )
  const log = {
    address: subject.vault,
    transactionHash: tx,
    blockNumber: BigInt(anchorBlock - 1),
    blockHash: hash(anchorBlock - 1),
    transactionIndex: 0,
    logIndex: 0,
    topics: encodeEventTopics({
      abi: [event],
      eventName: 'Transfer',
      args: { from: `0x${'0'.repeat(40)}`, to: holder },
    }),
    data: `0x${'1'.padStart(64, '0')}`,
  }
  const oldRead = rpc.readContract
  rpc.readContract = async (args) => {
    if (args.functionName === 'decimals') return args.address === subject.vault ? 18 : 6
    if (args.functionName === 'balanceOf') return 1_000_000_000_000_000_000_000_000n
    if (args.functionName === 'previewRedeem') return 1_000_000n * 1_000_000n
    if (args.functionName === 'previewWithdraw') return 100n
    return oldRead(args)
  }
  rpc.getCode = async ({ address }) => (address === holder ? '0x' : '0x1234')
  rpc.getLogs = async ({ fromBlock, toBlock }) =>
    fromBlock <= log.blockNumber && toBlock >= log.blockNumber ? [log] : []
  rpc.getTransactionReceipt = async () => ({
    status: 'success',
    transactionHash: tx,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    logs: [{ ...log }],
  })
  rpc.call = async () => ({ data: `0x${'1'.padStart(64, '0')}` })
  const result = await runCell(rpc, plan, anchorBlock, subject.vault)
  assert.equal(result.status, 'measured')
  assert.equal(result.row.holder, holder)
  assert.equal(result.row.holderDiscovery.receiptVerified, true)
  assert.deepEqual(
    result.row.sizes.map((x) => ({ label: x.label, assetsRaw: x.assetsRaw })),
    plan.cells[0].sizes,
  )
  assert.ok(result.row.sizes.filter((x) => x.eligible).every((x) => x.horizons.length === 5))
  const summary = summarize(plan, [result])
  assert.equal(summary.baselineSuccessEpisodes, 1)
  assert.equal(summary.uniqueHolderVaultClusters, 1)
  assert.equal(summary.independentObservations, false)

  const tiny = {
    ...result.row.holderDiscovery,
    owner: `0x${'6'.repeat(40)}`,
    discoveryBlock: anchorBlock - 2,
    discoveryBlockHash: hash(anchorBlock - 2),
    discoveryTransactionHash: `0x${'7'.repeat(64)}`,
    sharesRaw: '1000000000000000000',
    claimRaw: '100000000',
  }
  const forgedTinySelection = reseal({
    ...result,
    row: {
      ...result.row,
      holder: tiny.owner,
      holderDiscovery: tiny,
      candidateWindow: {
        ...result.row.candidateWindow,
        transferLogs: 2,
        distinctRecipients: 2,
        screened: 2,
      },
      screenedCandidates: [tiny, result.row.holderDiscovery],
    },
  })
  assert.throws(() => summarize(plan, [forgedTinySelection]), /holder_selection_invalid/)
  const forgedClaim = reseal({
    ...result,
    row: { ...result.row, anchorClaimRaw: (BigInt(result.row.anchorClaimRaw) + 1n).toString() },
  })
  assert.throws(() => summarize(plan, [forgedClaim]), /holder_selection_invalid/)
  const forgedShares = reseal({
    ...result,
    row: { ...result.row, anchorSharesRaw: (BigInt(result.row.anchorSharesRaw) + 1n).toString() },
  })
  assert.throws(() => summarize(plan, [forgedShares]), /holder_selection_invalid/)

  const incident = structuredClone(result)
  const eligible = incident.row.sizes.filter((x) => x.eligible)
  for (const size of eligible.slice(0, 2)) {
    const atFour = size.horizons.find((x) => x.hours === 4)
    atFour.call = { status: 'evm_revert' }
    atFour.class = 'evm_revert'
    size.exitInterval = lossIntervals(size)
  }
  eligible[2].baseline.call = { status: 'evm_revert' }
  eligible[2].baseline.class = 'evm_revert'
  eligible[2].horizons.find((x) => x.hours === 4).call = { status: 'evm_revert' }
  eligible[2].horizons.find((x) => x.hours === 4).class = 'evm_revert'
  eligible[2].exitInterval = lossIntervals(eligible[2])
  const atFourAttrition = eligible[3].horizons.find((x) => x.hours === 4)
  atFourAttrition.state.sharesRaw = '0'
  atFourAttrition.call = { status: 'evm_revert' }
  atFourAttrition.class = 'holder_attrition'
  eligible[3].exitInterval = lossIntervals(eligible[3])
  const sealedIncident = reseal(incident)
  const otherCells = []
  for (const subject of plan.subjects.slice(1, 12))
    otherCells.push(await runCell(client(), plan, anchorBlock, subject.vault))
  const incidentSummary = summarize(plan, [sealedIncident, ...otherCells])
  assert.equal(incidentSummary.completedCells, 12)
  assert.equal(incidentSummary.cellStatus.no_eligible_holder, 11)
  assert.equal(incidentSummary.horizonSizeStatus['4h:evm_revert'], 3)
  assert.equal(incidentSummary.riskSet.baselineSuccessSizeRows, 4)
  assert.equal(incidentSummary.riskSet.firstCoveredLossSizeRows, 2)
  assert.equal(incidentSummary.riskSet.distinctFirstCoveredLossEpisodes, 1)
  assert.equal(incidentSummary.riskSet.observedRecoverySizeRows, 2)
  assert.equal(incidentSummary.riskSet.distinctObservedRecoveryEpisodes, 1)
  assert.equal(incidentSummary.riskSet.attritionCensoredRiskSizeRows, 1)
  assert.equal(incidentSummary.riskSet.rightCensoredRiskSizeRows, 2)
  assert.equal(incidentSummary.riskSet.independentObservations, false)
})

test('caller-authored non-measured labels and false discovery shapes cannot enter summary', async () => {
  const plan = await freezeFullPlan(client())
  const good = await runCell(client(), plan, DESIGN.anchors[0], subjects[0].vault)
  const forgedRevert = reseal({
    ...good,
    status: 'evm_revert',
    row: { ...good.row, status: 'evm_revert' },
  })
  assert.throws(() => summarize(plan, [forgedRevert]), /cell_status_invalid/)
  const forgedNoHolder = reseal({
    ...good,
    row: { ...good.row, candidateWindow: { ...good.row.candidateWindow, screened: 1 } },
  })
  assert.throws(() => summarize(plan, [forgedNoHolder]), /cell_discovery_evidence_invalid/)
  const forgedEarly = reseal({
    ...good,
    status: 'rpc_unavailable',
    row: { ...good.row, status: 'rpc_unavailable' },
  })
  assert.throws(() => summarize(plan, [forgedEarly]), /early_exit_cell_shape_invalid/)
  const inconsistentUnfunded = reseal({
    ...good,
    status: 'unfunded_at_anchor',
    row: {
      vault: good.vault,
      asset: good.row.asset,
      anchorBlock: good.anchorBlock,
      status: 'unfunded_at_anchor',
    },
  })
  assert.throws(() => summarize(plan, [inconsistentUnfunded]), /cell_status_invalid/)
})

test('immutable per-cell artifacts support replay and refuse changed content', async () => {
  const plan = await freezeFullPlan(client())
  const directory = mkdtempSync(join(tmpdir(), 'carry-morpho-stable-history-'))
  try {
    const saved = savePlanOnce(plan, directory)
    assert.equal(saved.replay, false)
    assert.equal(savePlanOnce(plan, directory).replay, true)
    assert.equal(JSON.parse(readFileSync(saved.path)).planSha256, plan.planSha256)
    const cell = await runCell(client(), plan, DESIGN.anchors[0], subjects[0].vault)
    const first = saveCellOnce(plan, cell, directory)
    assert.equal(first.replay, false)
    assert.equal(saveCellOnce(plan, cell, directory).replay, true)
    assert.equal(
      readSavedCell(plan, cell.anchorBlock, cell.vault, directory).sourceRevalidated,
      false,
    )
    assert.equal(
      (await verifySavedCellWithRpc(client(), plan, cell.anchorBlock, cell.vault, directory))
        .sourceRevalidated,
      true,
    )
    const unavailable = client()
    unavailable.getLogs = async () => {
      throw Error('RPC unavailable')
    }
    await assert.rejects(
      verifySavedCellWithRpc(unavailable, plan, cell.anchorBlock, cell.vault, directory),
      /cell_rpc_replay_mismatch/,
    )
    assert.throws(
      () => saveCellOnce(plan, reseal({ ...cell, note: 'changed' }), directory),
      /artifact_conflict/,
    )
    assert.throws(
      () => saveCellOnce(plan, reseal({ ...cell, status: 'success' }), directory),
      /measured_cell_identity_invalid/,
    )
    assert.throws(
      () => saveCellOnce(plan, reseal({ ...cell, routeKey: 'USDT → VaultV2 [USDT]' }), directory),
      /cell_route_invalid/,
    )
    writeFileSync(first.path, `${JSON.stringify({ ...cell, status: 'success' }, null, 2)}\n`)
    assert.throws(
      () => readSavedCell(plan, cell.anchorBlock, cell.vault, directory),
      /cell_plan_mismatch/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
