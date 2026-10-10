import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeFunctionData, encodeFunctionResult, parseAbi } from 'viem'
import { collectPrestate, loadPinnedSlots } from './morpho-v2-route-prestate-screen.mjs'
import {
  freezeCandidateRiskSet,
  readVerifiedCandidateRiskSet,
} from './morpho-v2-route-riskset-freeze.mjs'

const vault = (n) => `0x${n.toString(16).padStart(40, '0')}`
const route = vault(100)
const otherRoute = vault(101)
const makeSlot = (n, role, adapter = route) => ({
  planSha256: 'plan',
  anchorIndex: 0,
  eventKey: 'event',
  role,
  vault: vault(n),
  asset: vault(200),
  creationBlock: 1,
  anchorBlock: 100,
  anchorBlockHash: 'hash',
  preBlock: 99,
  expectedPreRoute: role === 'treated' ? route : null,
  sourceExpectedPreRoute: adapter,
})
const makeRow = (slot, index, status = 'funded-screen') => ({
  index,
  slot: Object.fromEntries(
    [
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
    ].map((key) => [key, slot[key]]),
  ),
  status,
  ...(status === 'funded-screen'
    ? {
        totalsScreen: 'positive-both',
        totalSupplyRaw: '10',
        totalAssetsRaw: '20',
        observedAsset: slot.asset,
        observedAdapter: slot.sourceExpectedPreRoute,
      }
    : {}),
})
const slots = [
  makeSlot(1, 'treated'),
  makeSlot(3, 'candidate-control'),
  makeSlot(2, 'candidate-control'),
  makeSlot(4, 'candidate-control', otherRoute),
  makeSlot(5, 'candidate-control', null),
  makeSlot(6, 'candidate-control', vault(0)),
  makeSlot(7, 'candidate-control'),
  makeSlot(8, 'candidate-control'),
]
const statuses = [
  'funded-screen',
  'funded-screen',
  'funded-screen',
  'funded-screen',
  'adapter-unattested',
  'inactive-zero-adapter',
  'unfunded-screen',
  'missing-code',
]
const rows = slots.map((slot, i) => makeRow(slot, i, statuses[i]))
const coverage = {
  attemptedSlots: slots.length,
  resolvedSlots: slots.length,
  attemptCoverageComplete: true,
  resolvedScreenCoverageComplete: true,
  gaps: [],
}

test('complete B-1 screen freezes only deterministic same-route candidate roster, never matched controls', () => {
  const frozen = freezeCandidateRiskSet({ slots, rows: [...rows].reverse(), coverage })
  assert.equal(frozen.status, 'unverified-input-candidates-only')
  assert.match(frozen.assurance, /Caller-supplied/)
  assert.equal(frozen.anchors[0].controlDenominator, 7)
  assert.deepEqual(
    frozen.anchors[0].sameRouteFundedScreenCandidates.map(({ vault }) => vault),
    [vault(2), vault(3)],
  )
  assert.equal(frozen.anchors[0].fundedDifferentRouteControls, 1)
  assert.equal(frozen.anchors[0].controlStatusCounts['adapter-unattested'], 1)
  assert.equal(frozen.anchors[0].controlStatusCounts['inactive-zero-adapter'], 1)
  assert.equal(frozen.anchors[0].controlStatusCounts['unfunded-screen'], 1)
  assert.equal(frozen.anchors[0].controlStatusCounts['missing-code'], 1)
  assert.deepEqual(frozen.matchedControls, [])
  assert.equal(frozen.fixedRawWithdrawalQ, null)
  assert.match(frozen.abstention, /holder ledger/)
  assert.equal(JSON.stringify(frozen).includes('outcome'), false)
})

test('incomplete coverage has no roster and preserves attempted/resolved denominators', () => {
  const frozen = freezeCandidateRiskSet({
    slots,
    rows: [...rows.slice(0, 2), makeRow(slots[7], 7, 'read-failure')],
    coverage: {
      attemptedSlots: 3,
      resolvedSlots: 2,
      attemptCoverageComplete: false,
      resolvedScreenCoverageComplete: false,
      gaps: [{ fromIndex: 2, toIndex: 7 }],
    },
  })
  assert.equal(frozen.status, 'coverage-incomplete')
  assert.deepEqual(frozen.anchors, [])
  assert.deepEqual(frozen.denominators, {
    planned: 8,
    attempted: 3,
    resolved: 2,
    byStatus: {
      'funded-screen': 2,
      'unfunded-screen': 0,
      'discordant-screen': 0,
      'inactive-zero-adapter': 0,
      'adapter-unattested': 0,
      'missing-code': 0,
      'identity-mismatch': 0,
      'read-failure': 1,
    },
  })
})

test('a claimed complete screen with read-failure or forged gaps cannot become a roster', () => {
  const failure = rows.map((row) => ({ ...row }))
  failure[7] = makeRow(slots[7], 7, 'read-failure')
  assert.throws(
    () => freezeCandidateRiskSet({ slots, rows: failure, coverage }),
    /coverage and final statuses disagree/,
  )
  assert.throws(
    () =>
      freezeCandidateRiskSet({
        slots,
        rows,
        coverage: { ...coverage, gaps: [{ fromIndex: 7, toIndex: 7 }] },
      }),
    /coverage and final statuses disagree/,
  )
})

test('zero-route, missing and unfunded treated cannot create same-route candidates', () => {
  for (const status of ['inactive-zero-adapter', 'missing-code', 'unfunded-screen']) {
    const variant = rows.map((row) => ({ ...row }))
    variant[0] = makeRow(slots[0], 0, status)
    const frozen = freezeCandidateRiskSet({ slots, rows: variant, coverage })
    assert.deepEqual(frozen.anchors[0].sameRouteFundedScreenCandidates, [])
    assert.deepEqual(frozen.matchedControls, [])
  }
})

test('outcomes, holder claims and post-B fields cannot enter the freezer', () => {
  assert.throws(
    () => freezeCandidateRiskSet({ slots, rows, coverage, outcomes: [{ success: false }] }),
    /Only pre-B/,
  )
  assert.throws(
    () => freezeCandidateRiskSet({ slots, rows, coverage, holderEvidence: {} }),
    /Only pre-B/,
  )
  const leaked = rows.map((row) => ({ ...row }))
  leaked[1] = { ...leaked[1], postBExitResult: 'revert' }
  assert.throws(() => freezeCandidateRiskSet({ slots, rows: leaked, coverage }), /outcome-bearing/)
  const nested = rows.map((row) => ({ ...row }))
  nested[1] = { ...nested[1], slot: { ...nested[1].slot, postBExitResult: 'revert' } }
  assert.throws(() => freezeCandidateRiskSet({ slots, rows: nested, coverage }), /Outcome-bearing/)
})

test('duplicate, reordered identity and positive totals without route are rejected', () => {
  const duplicate = [...rows]
  duplicate[1] = { ...rows[0] }
  assert.throws(() => freezeCandidateRiskSet({ slots, rows: duplicate, coverage }), /duplicate/)
  const forged = rows.map((row) => ({ ...row }))
  forged[1] = { ...forged[1], slot: { ...forged[1].slot, vault: vault(42) } }
  assert.throws(() => freezeCandidateRiskSet({ slots, rows: forged, coverage }), /Slot identity/)
  const noRouteSlots = slots.map((slot) => ({ ...slot }))
  noRouteSlots[1] = { ...noRouteSlots[1], sourceExpectedPreRoute: null }
  const noRouteRows = rows.map((row) => ({ ...row }))
  noRouteRows[1] = makeRow(noRouteSlots[1], 1)
  assert.throws(
    () => freezeCandidateRiskSet({ slots: noRouteSlots, rows: noRouteRows, coverage }),
    /Unqualified funded/,
  )
})

test('default entry point is read-only and abstains with no saved receipts', () => {
  const frozen = readVerifiedCandidateRiskSet({
    out: '/private/tmp/morpho-v2-no-such-screen-receipts',
  })
  assert.equal(frozen.status, 'coverage-incomplete')
  assert.deepEqual(frozen.matchedControls, [])
})

test('verified partial collector receipt retains observed status denominator without a roster', async () => {
  const pinned = loadPinnedSlots()
  const slot = pinned.slots[0]
  const out = mkdtempSync(join(tmpdir(), 'morpho-riskset-partial-'))
  const H = (n) => `0x${n.toString(16).padStart(64, '0')}`
  const preHash = H(1234)
  const abi = parseAbi([
    'function asset() view returns (address)',
    'function liquidityAdapter() view returns (address)',
    'function totalSupply() view returns (uint256)',
    'function totalAssets() view returns (uint256)',
  ])
  const rpc = async (method, params) => {
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_getBlockByNumber') {
      const n = params[0] === 'finalized' ? slot.anchorBlock + 10 : Number(BigInt(params[0]))
      return {
        number: `0x${n.toString(16)}`,
        hash: n === slot.anchorBlock ? slot.anchorBlockHash : n === slot.preBlock ? preHash : H(n),
        parentHash: n === slot.anchorBlock ? preHash : H(n - 1),
      }
    }
    if (method === 'eth_getCode') return '0x6000'
    if (method === 'eth_call') {
      const name = ['asset', 'liquidityAdapter', 'totalSupply', 'totalAssets'].find(
        (candidate) => params[0].data === encodeFunctionData({ abi, functionName: candidate }),
      )
      const values = {
        asset: slot.asset,
        liquidityAdapter: slot.sourceExpectedPreRoute,
        totalSupply: 10n,
        totalAssets: 20n,
      }
      return encodeFunctionResult({ abi, functionName: name, result: values[name] })
    }
    throw new Error('unexpected mock RPC')
  }
  await collectPrestate({
    out,
    pinned,
    rpc,
    fromIndex: 0,
    maxSlots: 1,
    stat: () => ({ bavail: 4_000_000_000, bsize: 1 }),
  })
  const frozen = readVerifiedCandidateRiskSet({ out })
  assert.equal(frozen.status, 'coverage-incomplete')
  assert.equal(frozen.denominators.attempted, 1)
  assert.equal(frozen.denominators.resolved, 1)
  assert.equal(frozen.denominators.byStatus['funded-screen'], 1)
  assert.deepEqual(frozen.anchors, [])
  assert.match(frozen.assurance, /physically checked local sources/)
})
