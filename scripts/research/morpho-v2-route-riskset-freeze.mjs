// Offline B-1 eligibility roster. No holder, fixed-q, B outcome or causal match is inferred.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPinnedSlots, verifyReceipts } from './morpho-v2-route-prestate-screen.mjs'

const SHA = (bytes) => createHash('sha256').update(bytes).digest('hex')
const DEFAULT_OUT = resolve('data/research/venue-signals/morpho-v2-route-prestate-screen')
const ZERO = `0x${'0'.repeat(40)}`
const ROW_KEYS = new Set([
  'index',
  'slot',
  'anchorHeader',
  'preHeader',
  'status',
  'runtimeCodeHash',
  'observedAsset',
  'observedAdapter',
  'adapterSourceStatus',
  'totalSupplyRaw',
  'totalAssetsRaw',
  'totalsScreen',
  'failure',
])
const SLOT_KEYS = [
  'planSha256',
  'anchorIndex',
  'eventKey',
  'role',
  'vault',
  'asset',
  'creationBlock',
  'anchorBlock',
  'anchorBlockHash',
  'preBlock',
  'expectedPreRoute',
  'sourceExpectedPreRoute',
]
const EXCLUDED = [
  'unfunded-screen',
  'discordant-screen',
  'inactive-zero-adapter',
  'adapter-unattested',
  'missing-code',
  'identity-mismatch',
  'read-failure',
]

function checkedRow(slot, row, index) {
  if (!row || row.index !== index || Object.keys(row).some((key) => !ROW_KEYS.has(key)))
    throw new Error(`Unexpected or outcome-bearing receipt row ${index}`)
  if (!row.slot || Object.keys(row.slot).some((key) => !SLOT_KEYS.includes(key)))
    throw new Error(`Outcome-bearing slot identity ${index}`)
  for (const key of SLOT_KEYS) {
    if (row.slot?.[key] !== slot[key]) throw new Error(`Slot identity mismatch ${index}`)
  }
  if (![...EXCLUDED, 'funded-screen'].includes(row.status))
    throw new Error(`Unknown screen status ${index}`)
  if (row.status === 'funded-screen') {
    if (
      row.totalsScreen !== 'positive-both' ||
      !/^[1-9][0-9]*$/.test(row.totalSupplyRaw) ||
      !/^[1-9][0-9]*$/.test(row.totalAssetsRaw) ||
      row.observedAsset !== slot.asset ||
      !slot.sourceExpectedPreRoute ||
      slot.sourceExpectedPreRoute === ZERO ||
      row.observedAdapter !== slot.sourceExpectedPreRoute
    )
      throw new Error(`Unqualified funded screen ${index}`)
  }
  return row
}

export function freezeCandidateRiskSet(input) {
  if (!input || Object.keys(input).some((key) => !['slots', 'rows', 'coverage'].includes(key)))
    throw new Error('Only pre-B slots, screen rows and coverage are accepted')
  const { slots, rows, coverage } = input
  if (!Array.isArray(slots) || !Array.isArray(rows) || !coverage)
    throw new Error('Missing pre-B screen inputs')
  const denominators = {
    planned: slots.length,
    attempted: coverage.attemptedSlots,
    resolved: coverage.resolvedSlots,
    byStatus: Object.fromEntries(['funded-screen', ...EXCLUDED].map((status) => [status, 0])),
  }
  const indexed = new Map()
  for (const row of rows) {
    if (!Number.isInteger(row?.index) || indexed.has(row.index) || !slots[row.index])
      throw new Error('Missing, duplicate or out-of-plan screen row')
    indexed.set(row.index, checkedRow(slots[row.index], row, row.index))
    denominators.byStatus[row.status]++
  }
  const resolved = new Set(
    [...indexed].filter(([, row]) => row.status !== 'read-failure').map(([i]) => i),
  )
  const gaps = []
  for (let i = 0; i < slots.length; ) {
    if (resolved.has(i)) {
      i++
      continue
    }
    const fromIndex = i
    while (i < slots.length && !resolved.has(i)) i++
    gaps.push({ fromIndex, toIndex: i - 1 })
  }
  if (
    coverage.attemptedSlots !== indexed.size ||
    coverage.resolvedSlots !== resolved.size ||
    coverage.attemptCoverageComplete !== (indexed.size === slots.length) ||
    coverage.resolvedScreenCoverageComplete !== (resolved.size === slots.length) ||
    JSON.stringify(coverage.gaps) !== JSON.stringify(gaps)
  )
    throw new Error('Screen coverage and final statuses disagree')
  if (!coverage.resolvedScreenCoverageComplete) {
    return {
      study: 'morpho-v2-route-riskset-freeze-v1',
      status: 'coverage-incomplete',
      denominators,
      anchors: [],
      matchedControls: [],
      fixedRawWithdrawalQ: null,
      assurance:
        'Caller-supplied inputs only; use the verified receipt reader for physical source checks.',
      abstention:
        'Complete verified B-1 screen receipts are required before freezing an eligibility roster.',
    }
  }
  if (indexed.size !== slots.length) throw new Error('Incomplete indexed screen')
  const groups = new Map()
  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index],
      row = indexed.get(index)
    if (!row) throw new Error('Missing screen row')
    if (!groups.has(slot.anchorIndex)) groups.set(slot.anchorIndex, [])
    groups.get(slot.anchorIndex).push({ slot, row })
  }
  const anchors = [...groups]
    .sort(([a], [b]) => a - b)
    .map(([anchorIndex, group]) => {
      const treated = group.filter(({ slot }) => slot.role === 'treated')
      if (treated.length !== 1) throw new Error('Expected one treated slot per anchor')
      const { slot: target, row: targetRow } = treated[0]
      if (
        group.some(({ slot }) => slot.asset !== target.asset || slot.preBlock !== target.preBlock)
      )
        throw new Error('Mixed asset or B-1 state in anchor')
      const counts = Object.fromEntries(['funded-screen', ...EXCLUDED].map((status) => [status, 0]))
      const controls = group.filter(({ slot }) => slot.role === 'candidate-control')
      if (controls.length !== group.length - 1) throw new Error('Unknown anchor role')
      for (const { row } of controls) counts[row.status]++
      const sameRoute = controls
        .filter(
          ({ slot, row }) =>
            targetRow.status === 'funded-screen' &&
            row.status === 'funded-screen' &&
            slot.sourceExpectedPreRoute === target.sourceExpectedPreRoute,
        )
        .map(({ slot, row }) => ({
          vault: slot.vault,
          preBlock: slot.preBlock,
          screenTotalSupplyRaw: row.totalSupplyRaw,
          screenTotalAssetsRaw: row.totalAssetsRaw,
        }))
        .sort((a, b) => (a.vault < b.vault ? -1 : a.vault > b.vault ? 1 : 0))
      return {
        anchorIndex,
        eventKey: target.eventKey,
        anchorBlock: target.anchorBlock,
        preBlock: target.preBlock,
        asset: target.asset,
        treatedVault: target.vault,
        treatedScreenStatus: targetRow.status,
        treatedPreRoute: target.sourceExpectedPreRoute,
        controlDenominator: controls.length,
        controlStatusCounts: counts,
        fundedDifferentRouteControls: controls.filter(
          ({ slot, row }) =>
            row.status === 'funded-screen' &&
            slot.sourceExpectedPreRoute !== target.sourceExpectedPreRoute,
        ).length,
        sameRouteFundedScreenCandidates: sameRoute,
        matchedControls: [],
        fixedRawWithdrawalQ: null,
        abstention:
          'Positive vault totals are not a complete holder ledger or same-holder fixed-q executable withdrawal.',
      }
    })
  return {
    study: 'morpho-v2-route-riskset-freeze-v1',
    status: 'unverified-input-candidates-only',
    denominators,
    anchors,
    matchedControls: [],
    fixedRawWithdrawalQ: null,
    assurance:
      'Caller-supplied inputs only; use the verified receipt reader for physical source checks.',
    abstention:
      'No physically verified complete holder ledger or treated-derived one fixed raw withdrawal q; no matches or exit inference.',
  }
}

export function readVerifiedCandidateRiskSet({ out = DEFAULT_OUT } = {}) {
  const coverage = verifyReceipts({ out })
  const pinned = loadPinnedSlots()
  const rows = new Map()
  for (const receiptRef of coverage.receipts) {
    const bytes = readFileSync(join(out, receiptRef.file))
    if (SHA(bytes) !== receiptRef.receiptFileSha256)
      throw new Error('Verified receipt changed before freeze')
    const receipt = JSON.parse(bytes)
    if (
      receipt.planSha256 !== pinned.plan.planSha256 ||
      JSON.stringify(receipt.sourcePhysicalSha256) !== JSON.stringify(pinned.sourcePhysicalSha256)
    )
      throw new Error('Sealed source changed before freeze')
    for (const row of receipt.rows) rows.set(row.index, row)
  }
  const result = freezeCandidateRiskSet({ slots: pinned.slots, rows: [...rows.values()], coverage })
  return {
    ...result,
    status:
      result.status === 'unverified-input-candidates-only'
        ? 'eligibility-candidates-only'
        : result.status,
    screenSourcesPhysicalSha256: pinned.sourcePhysicalSha256,
    receiptFileSha256: coverage.receipts.map(({ file, receiptFileSha256 }) => ({
      file,
      receiptFileSha256,
    })),
    assurance:
      'Offline consistency of physically checked local sources and collector receipts; no independent RPC witness or externally anchored timestamp.',
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2)
  if (args.length > 2 || (args.length && args[0] !== '--out'))
    throw new Error('Usage: node morpho-v2-route-riskset-freeze.mjs [--out receipt-directory]')
  const result = readVerifiedCandidateRiskSet({ out: args[1] || DEFAULT_OUT })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
