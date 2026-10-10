import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { encodeEventTopics, parseAbiItem } from 'viem'
import { loadUniverse } from './carry-morpho-exit-history-panel.mjs'
import {
  DESIGN,
  WIDE_DESIGN,
  aggregate,
  classifyProbe,
  lossIntervals,
  qLadder,
  receiptProvesTransfer,
  validateGrid,
} from './carry-morpho-exit-history-grid.mjs'

const sha = (x) => createHash('sha256').update(x).digest('hex')
const tx = `0x${'2'.repeat(64)}`
const hash = `0x${'3'.repeat(64)}`
const vault = DESIGN.vaults[0]
const owner = `0x${'4'.repeat(40)}`
const event = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)')

function transfer() {
  return {
    address: vault,
    transactionHash: tx,
    blockNumber: 100n,
    blockHash: hash,
    logIndex: 7,
    topics: encodeEventTopics({
      abi: [event],
      eventName: 'Transfer',
      args: { from: `0x${'0'.repeat(40)}`, to: owner },
    }),
    data: `0x${'a'.padStart(64, '0')}`,
  }
}

test('receipt proof binds exact successful transaction, vault, log and topics', () => {
  const log = transfer()
  const receipt = {
    status: 'success',
    transactionHash: tx,
    blockNumber: 100n,
    blockHash: hash,
    logs: [{ ...log }],
  }
  assert.equal(receiptProvesTransfer(log, receipt, vault), true)
  assert.equal(receiptProvesTransfer(log, { ...receipt, status: 'reverted' }, vault), false)
  assert.equal(
    receiptProvesTransfer(log, { ...receipt, logs: [{ ...log, address: owner }] }, vault),
    false,
  )
  assert.equal(
    receiptProvesTransfer(log, { ...receipt, logs: [{ ...log, data: '0x' }] }, vault),
    false,
  )
  assert.equal(receiptProvesTransfer(log, { ...receipt, blockHash: tx }, vault), false)
})

test('six frozen sizes never shrink to holder claim', () => {
  const items = qLadder(50_000_000n * 1_000_000n, 50_000n * 1_000_000n, 6)
  assert.deepEqual(
    items.map((x) => x.label),
    DESIGN.qLabels,
  )
  assert.equal(items[0].assetsRaw, '10000000000')
  assert.equal(items[1].assetsRaw, '100000000000')
  assert.equal(items[1].eligible, false)
  assert.equal(items[1].reason, 'exceeds_anchor_holder_claim')
  assert.equal(items[2].assetsRaw, '1000000000000')
  assert.equal(items[3].assetsRaw, '50000000000')
  assert.equal(items[4].eligible, false)
  assert.throws(() => qLadder(100n, 100n, 18), /identity_invalid/)
})

test('success outranks preview conflict; covered revert differs from attrition and RPC', () => {
  const state = { status: 'measured', eoa: true, sharesRaw: '99', previewSharesRaw: '100' }
  assert.equal(
    classifyProbe({ status: 'confirmed' }, state, { status: 'success', sharesBurnedRaw: '99' }),
    'success',
  )
  assert.equal(
    classifyProbe({ status: 'confirmed' }, state, { status: 'success', sharesBurnedRaw: '100' }),
    'result_inconsistent',
  )
  assert.equal(
    classifyProbe({ status: 'confirmed' }, state, { status: 'success', sharesBurnedRaw: '0' }),
    'result_inconsistent',
  )
  assert.equal(
    classifyProbe({ status: 'confirmed' }, state, { status: 'evm_revert' }),
    'holder_attrition',
  )
  assert.equal(
    classifyProbe(
      { status: 'confirmed' },
      { ...state, sharesRaw: '100' },
      { status: 'evm_revert' },
    ),
    'evm_revert',
  )
  assert.equal(
    classifyProbe({ status: 'confirmed' }, state, { status: 'rpc_unavailable' }),
    'rpc_unavailable',
  )
  assert.equal(
    classifyProbe({ status: 'identity_changed' }, state, { status: 'success' }),
    'identity_changed',
  )
})

test('first loss and recovery are intervals with right censoring', () => {
  const size = {
    eligible: true,
    baseline: { class: 'success' },
    horizons: [
      { hours: 1, class: 'success' },
      { hours: 4, class: 'evm_revert' },
      { hours: 24, class: 'success' },
    ],
  }
  assert.deepEqual(lossIntervals(size), {
    riskSet: true,
    firstLoss: { afterHours: 1, throughHours: 4, class: 'evm_revert' },
    recovery: { afterHours: 4, throughHours: 24 },
    censoring: null,
    missingHorizons: 0,
  })
  const allSuccess = { ...size, horizons: size.horizons.map((h) => ({ ...h, class: 'success' })) }
  assert.deepEqual(lossIntervals(allSuccess).firstLoss, { rightCensoredAtHours: 24 })
  assert.equal(lossIntervals({ ...size, eligible: false }).riskSet, false)
})

test('holder attrition censors the original episode, even when a later call succeeds', () => {
  const size = {
    label: 'fixed_10k',
    eligible: true,
    baseline: { class: 'success' },
    horizons: [
      { hours: 1, class: 'success' },
      { hours: 4, class: 'holder_attrition' },
      { hours: 24, class: 'success' },
    ],
  }
  assert.deepEqual(lossIntervals(size), {
    riskSet: true,
    firstLoss: { rightCensoredAtHours: 1 },
    recovery: null,
    censoring: { afterHours: 1, atHours: 4, class: 'holder_attrition' },
    missingHorizons: 0,
  })
  const summary = aggregate([{ vault, holder: owner, anchorBlock: 1, sizes: [size] }])
  assert.deepEqual(summary.riskSet.firstLoss, { right_censored: 1 })
  assert.deepEqual(summary.riskSet.censoring, { holder_attrition: 1 })
  assert.equal(summary.riskSet.missingHorizons, 0)
  for (const changed of ['identity_changed', 'holder_type_changed']) {
    const interval = lossIntervals({
      ...size,
      horizons: [
        { hours: 1, class: 'success' },
        { hours: 4, class: changed },
        { hours: 24, class: 'evm_revert' },
      ],
    })
    assert.deepEqual(interval.firstLoss, { rightCensoredAtHours: 1 })
    assert.deepEqual(interval.censoring, { afterHours: 1, atHours: 4, class: changed })
    assert.equal(interval.recovery, null)
  }
})

test('a covered revert followed by a success yields a sampled restriction interval', () => {
  const size = {
    label: 'fixed_10k',
    eligible: true,
    baseline: { class: 'success' },
    horizons: [
      { hours: 1, class: 'success' },
      { hours: 4, class: 'evm_revert' },
      { hours: 24, class: 'success' },
    ],
  }
  assert.deepEqual(lossIntervals(size), {
    riskSet: true,
    firstLoss: { afterHours: 1, throughHours: 4, class: 'evm_revert' },
    recovery: { afterHours: 4, throughHours: 24 },
    censoring: null,
    missingHorizons: 0,
  })
  const summary = aggregate([{ vault, holder: owner, anchorBlock: 1, sizes: [size] }])
  assert.deepEqual(summary.riskSet.firstLoss, { evm_revert: 1 })
  assert.deepEqual(summary.riskSet.censoring, { none: 1 })
})

test('missing observation remains separate and attrition after a revert censors recovery', () => {
  const interval = lossIntervals({
    eligible: true,
    baseline: { class: 'success' },
    horizons: [
      { hours: 1, class: 'evm_revert' },
      { hours: 4, class: 'rpc_unavailable' },
      { hours: 24, class: 'holder_attrition' },
    ],
  })
  assert.deepEqual(interval.firstLoss, { afterHours: 0, throughHours: 1, class: 'evm_revert' })
  assert.deepEqual(interval.recovery, { rightCensoredAtHours: 1 })
  assert.deepEqual(interval.censoring, { afterHours: 1, atHours: 24, class: 'holder_attrition' })
  assert.equal(interval.missingHorizons, 1)
  const unresolved = lossIntervals({
    eligible: true,
    baseline: { class: 'success' },
    horizons: [
      { hours: 1, class: 'success' },
      { hours: 4, class: 'rpc_unavailable' },
      { hours: 24, class: 'rpc_unavailable' },
    ],
  })
  assert.deepEqual(unresolved.firstLoss, { rightCensoredAtHours: 1 })
  assert.equal(unresolved.missingHorizons, 2)
})

test('validator pins design, schedule, row map and recomputed aggregate', () => {
  const universe = loadUniverse()
  const anchor = { number: DESIGN.anchors[0], hash, timestamp: 1_800_000_000 }
  const horizons = DESIGN.horizonsHours.map((hours) => ({
    hours,
    number: anchor.number + hours * 300,
    hash,
    timestamp: anchor.timestamp + hours * 3600,
    requestedTimestamp: anchor.timestamp + hours * 3600,
    priorTimestamp: anchor.timestamp + hours * 3600 - 12,
    realizedLagSeconds: 0,
  }))
  const schedule = { design: DESIGN, anchors: [{ anchor, horizons }] }
  const rows = DESIGN.vaults.map((v) => ({
    vault: v,
    asset: universe.find((x) => x.vault === v).asset,
    anchorBlock: anchor.number,
    status: 'no_eligible_holder',
  }))
  const grid = {
    schemaVersion: 2,
    study: DESIGN.study,
    chainId: 1,
    mode: 'historical_read_only',
    prospectiveValidated: false,
    futureExitForecast: false,
    design: DESIGN,
    schedule,
    planSha256: sha(JSON.stringify(schedule)),
    rows,
    aggregates: aggregate(rows),
  }
  assert.equal(validateGrid(grid), true)
  assert.throws(() => validateGrid({ ...grid, futureExitForecast: true }), /grid_invalid/)
  assert.throws(
    () =>
      validateGrid({
        ...grid,
        aggregates: { ...grid.aggregates, riskSet: { ...grid.aggregates.riskSet, sizeRows: 999 } },
      }),
    /grid_invalid/,
  )
  assert.throws(
    () => validateGrid({ ...grid, rows: [{ ...rows[0], vault: owner }, ...rows.slice(1)] }),
    /grid_row_identity_invalid/,
  )
})

test('wider stage freezes six later anchors and six stablecoin vaults with candidate denominators', () => {
  assert.equal(WIDE_DESIGN.anchors.length, 6)
  assert.equal(WIDE_DESIGN.vaults.length, 6)
  assert.ok(WIDE_DESIGN.anchors.every((b) => b > 26_052_740))
  const universe = loadUniverse()
  assert.ok(
    WIDE_DESIGN.vaults.every((v) => {
      const entry = universe.find((x) => x.vault === v)
      return (
        entry &&
        [
          '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          '0xdac17f958d2ee523a2206206994597c13d831ec7',
        ].includes(entry.asset)
      )
    }),
  )
  const rows = WIDE_DESIGN.vaults.map((v) => ({
    vault: v,
    status: 'no_eligible_holder',
    candidateWindow: { transferLogs: 7, distinctRecipients: 4, screened: 2 },
    screenedCandidates: [{ receiptVerified: true }, { receiptVerified: false }],
  }))
  const result = aggregate(rows, WIDE_DESIGN)
  assert.deepEqual(result.sampling, {
    vaultAnchorRows: 6,
    transferLogs: 42,
    distinctRecipientSlots: 24,
    screenedCandidateSlots: 12,
    receiptVerifiedCandidateSlots: 6,
    selectedHolderRows: 0,
    selectedUniqueHolders: 0,
  })
})

test('corrected sealed artifact preserves raw evidence and separates eight attritions from loss', () => {
  const priorBytes = readFileSync(
    new URL(
      '../../lib/carry/carry-morpho-exit-history-grid-e78853a13b566abd.json',
      import.meta.url,
    ),
  )
  const correctedBytes = readFileSync(
    new URL(
      '../../lib/carry/carry-morpho-exit-history-grid-7c11d54e020ddd37.json',
      import.meta.url,
    ),
  )
  assert.equal(sha(priorBytes), 'e78853a13b566abd9fc6b2face7ec7ac6ec9e305192a28772fe96fbedcd0466c')
  assert.equal(
    sha(correctedBytes),
    '7c11d54e020ddd375eeed4e62ca58eb06ba915192f5704206658ee3ca6dc35e2',
  )
  const prior = JSON.parse(priorBytes)
  const corrected = JSON.parse(correctedBytes)
  assert.deepEqual(corrected.schedule, prior.schedule)
  assert.equal(corrected.planSha256, prior.planSha256)
  const withoutDerived = (rows) =>
    rows.map((row) => ({
      ...row,
      sizes: row.sizes?.map(({ exitInterval: _derived, ...size }) => size),
    }))
  assert.deepEqual(withoutDerived(corrected.rows), withoutDerived(prior.rows))
  assert.equal(prior.aggregates.riskSet.firstLoss.holder_attrition, 8)
  assert.deepEqual(corrected.aggregates.riskSet.firstLoss, { right_censored: 59 })
  assert.deepEqual(corrected.aggregates.riskSet.censoring, {
    holder_attrition: 8,
    none: 51,
  })
  assert.equal(corrected.aggregates.riskSet.missingHorizons, 0)
  assert.equal(validateGrid(corrected), true)
  assert.throws(() => validateGrid(prior), /grid_invalid/)
})
