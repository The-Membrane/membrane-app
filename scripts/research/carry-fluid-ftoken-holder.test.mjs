import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { encodeEventTopics, parseAbiItem, toHex } from 'viem'

import {
  appendChain,
  HORIZONS_HOURS,
  holderEntitlement,
  holderPosition,
  nextScanPlan,
  planFluidScoreRoutes,
  qLadder,
  readChain,
  selectDueFluidHolderTargets,
  validSelection,
} from './carry-fluid-ftoken-holder.mjs'

test('fixed Fluid holder Q ladder uses raw underlying assets and deduplicates tiny claims', () => {
  assert.deepEqual(qLadder('1000'), [
    { label: 'holder_1pct', assetsRaw: '10' },
    { label: 'holder_10pct', assetsRaw: '100' },
    { label: 'holder_25pct', assetsRaw: '250' },
    { label: 'holder_50pct', assetsRaw: '500' },
    { label: 'holder_100pct', assetsRaw: '1000' },
  ])
  assert.deepEqual(qLadder('1'), [{ label: 'holder_100pct', assetsRaw: '1' }])
  assert.deepEqual(HORIZONS_HOURS, [1, 4, 24, 48, 168])
})

test('a live Fluid H1 target precedes an older expired score when score budget is one', () => {
  const nowMs = Date.parse('2026-10-04T06:00:00.000Z')
  const target = (horizonHours, targetAtUtc, deadlineUtc) => ({
    horizonHours,
    targetAtUtc,
    deadlineUtc,
  })
  const issues = [
    {
      sequence: 1,
      targets: [target(24, '2026-10-02T00:00:00.000Z', '2026-10-02T02:00:00.000Z')],
    },
    {
      sequence: 2,
      targets: [target(1, '2026-10-04T05:30:00.000Z', '2026-10-04T07:30:00.000Z')],
    },
  ]
  assert.equal(selectDueFluidHolderTargets(issues, [], nowMs, 1)[0].issue.sequence, 2)
  assert.equal(selectDueFluidHolderTargets(issues, [], nowMs, 2)[1].issue.sequence, 1)
  assert.equal(
    selectDueFluidHolderTargets(issues, [{ issueSequence: 2, horizonHours: 1 }], nowMs, 1)[0].issue
      .sequence,
    1,
  )
})

test('Fluid score sweeps run routes with live deadlines before overdue route zero', () => {
  const nowMs = Date.parse('2026-10-04T06:00:00.000Z')
  const target = (deadlineUtc) => ({
    horizonHours: 1,
    targetAtUtc: new Date(Date.parse(deadlineUtc) - 2 * 3_600_000).toISOString(),
    deadlineUtc,
  })
  const routeRows = [
    {
      routeIndex: 0,
      issues: [{ sequence: 1, targets: [target('2026-10-04T05:30:00.000Z')] }],
      scores: [],
    },
    {
      routeIndex: 1,
      issues: [{ sequence: 1, targets: [target('2026-10-04T08:00:00.000Z')] }],
      scores: [],
    },
    {
      routeIndex: 2,
      issues: [{ sequence: 1, targets: [target('2026-10-04T07:00:00.000Z')] }],
      scores: [],
    },
  ]
  assert.deepEqual(planFluidScoreRoutes(routeRows, nowMs), [
    { routeIndex: 2, maxScores: 1 },
    { routeIndex: 1, maxScores: 1 },
    { routeIndex: 0, maxScores: 1 },
  ])
})

test('Fluid score plan can revisit an urgent route before a later deadline', () => {
  const nowMs = Date.parse('2026-10-04T06:00:00.000Z')
  const target = (horizonHours, deadlineUtc) => ({
    horizonHours,
    targetAtUtc: new Date(Date.parse(deadlineUtc) - 2 * 3_600_000).toISOString(),
    deadlineUtc,
  })
  const routeRows = [
    {
      routeIndex: 0,
      issues: [
        { sequence: 1, targets: [target(1, '2026-10-04T06:01:00.000Z')] },
        { sequence: 2, targets: [target(1, '2026-10-04T06:03:00.000Z')] },
      ],
      scores: [],
    },
    {
      routeIndex: 1,
      issues: [{ sequence: 1, targets: [target(1, '2026-10-04T06:02:00.000Z')] }],
      scores: [],
    },
  ]
  assert.deepEqual(planFluidScoreRoutes(routeRows, nowMs), [
    { routeIndex: 0, maxScores: 1 },
    { routeIndex: 1, maxScores: 1 },
    { routeIndex: 0, maxScores: 1 },
  ])
})

test('future holder disposal is ineligible before the venue withdrawal assay', async () => {
  const origins = [0, 1].map(() => ({
    client: { readContract: async () => 101n },
  }))
  const route = { vault: '0x0000000000000000000000000000000000000001' }
  const header = { number: 123n }
  const holder = '0x0000000000000000000000000000000000000002'
  assert.deepEqual(await holderEntitlement(origins, route, header, holder, 100n, null), {
    status: 'holder_ineligible',
    reason: 'no_current_shares',
    requiredSharesRaw: null,
  })
  assert.deepEqual(
    await holderEntitlement(origins, route, header, holder, 100n, {
      sharesRaw: '100',
      claimAssetsRaw: '100',
    }),
    { status: 'holder_ineligible', reason: 'shares_below_fixed_amount', requiredSharesRaw: '101' },
  )
  assert.equal(
    (
      await holderEntitlement(origins, route, header, holder, 100n, {
        sharesRaw: '101',
        claimAssetsRaw: '100',
      })
    ).status,
    'covered',
  )
})

test('empty EOA runtime from viem is eligible for a pinned holder position', async () => {
  const client = {
    getCode: async () => undefined,
    readContract: async ({ functionName }) =>
      functionName === 'balanceOf' ? 100n : functionName === 'previewRedeem' ? 101n : 100n,
  }
  const origins = [{ client }, { client }]
  const route = { vault: '0x0000000000000000000000000000000000000001' }
  const header = { number: 123n }
  const holder = '0x0000000000000000000000000000000000000002'
  assert.deepEqual(await holderPosition(origins, route, header, holder), {
    sharesRaw: '100',
    claimAssetsRaw: '101',
    maxWithdrawRaw: '100',
  })
  client.getCode = async () => '0x1234'
  assert.equal(await holderPosition(origins, route, header, holder), null)
})

test('screen budget keeps the same window and advances its candidate cursor', () => {
  assert.deepEqual(nextScanPlan([]), { scanWindow: 0, scanOffset: 0 })
  const first = [{ status: 'scan_budget_exhausted', result: { scanWindow: 0, nextOffset: 64 } }]
  assert.deepEqual(nextScanPlan(first), { scanWindow: 0, scanOffset: 64 })
  const second = [
    ...first,
    { status: 'scan_budget_exhausted', result: { scanWindow: 0, nextOffset: 128 } },
  ]
  assert.deepEqual(nextScanPlan(second), { scanWindow: 0, scanOffset: 128 })
  assert.deepEqual(nextScanPlan([...second, { status: 'no_fresh_holder', result: {} }]), {
    scanWindow: 1,
    scanOffset: 0,
  })
  assert.deepEqual(
    nextScanPlan(Array.from({ length: 16 }, () => ({ status: 'no_fresh_holder' }))),
    { scanWindow: 16, scanOffset: 0 },
  )
  assert.deepEqual(
    nextScanPlan(Array.from({ length: 64 }, () => ({ status: 'no_fresh_holder' }))),
    { scanWindow: 0, scanOffset: 0 },
  )
})

test('selected holder Transfer requires an exact mined receipt on both origins', () => {
  const vault = '0x0000000000000000000000000000000000000001'
  const holder = '0x0000000000000000000000000000000000000002'
  const sender = '0x0000000000000000000000000000000000000003'
  const event = parseAbiItem(
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  )
  const log = {
    address: vault,
    topics: encodeEventTopics({
      abi: [event],
      eventName: 'Transfer',
      args: { from: sender, to: holder },
    }).map((x) => x.toLowerCase()),
    data: toHex(5n, { size: 32 }),
    tx: `0x${'a'.repeat(64)}`,
    blockHash: `0x${'b'.repeat(64)}`,
    index: 4,
    block: 100,
  }
  const receipt = {
    status: 'success',
    transactionHash: log.tx,
    blockHash: log.blockHash,
    blockNumber: log.block,
    logs: [log],
  }
  const selection = {
    fromBlock: 90,
    toBlock: 110,
    selectedBlock: 100,
    transferTx: log.tx,
    transferLogIndex: 4,
    transferRole: 'recipient',
    witnesses: ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'].map((origin) => ({
      origin,
      selectedBlockHash: log.blockHash,
      rawSelectedLog: log,
      receipt,
    })),
  }
  assert.equal(validSelection(selection, { vault }, holder, { number: 120 }), true)
  selection.witnesses[1] = {
    ...selection.witnesses[1],
    receipt: { ...receipt, logs: [] },
  }
  assert.equal(validSelection(selection, { vault }, holder, { number: 120 }), false)
})

test('immutable numbered Fluid chain links records and rejects a tampered record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluid-holder-ledger-'))
  try {
    const first = appendChain(dir, { study: 'fixture', amount: '100' })
    const second = appendChain(dir, { study: 'fixture', amount: '200' })
    assert.equal(second.previousSha256, first.sha256)
    assert.equal(readChain(dir).length, 2)
    const file = join(dir, '00000002.json')
    const row = JSON.parse(readFileSync(file, 'utf8'))
    row.amount = '201'
    writeFileSync(file, `${JSON.stringify(row)}\n`)
    assert.throws(() => readChain(dir), /fluid_holder_ledger_chain/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('symlinked Fluid ledger records fail closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluid-holder-symlink-'))
  try {
    const outside = join(dir, 'outside')
    writeFileSync(outside, '{}\n')
    symlinkSync(outside, join(dir, '00000001.json'))
    assert.throws(() => readChain(dir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
