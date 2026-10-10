import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CARRY_EXIT_V2_FROZEN_ROUTES } from '../lib/carry-exit-v2-rpc-proof.mjs'
import { buildSubjectManifest } from '../record-carry-cash-issues.mjs'
import { collectDirectSupplierFlowSegment } from './collect-carry-direct-supplier-flow.mjs'
import {
  readDirectSupplierPayoutCoverage,
  summarizeVerifiedDirectSupplierPayoutCoverage,
} from './holder-exit-direct-supplier-payout-coverage.mjs'

const MARKET = 'compoundV3Usdc'
const ROUTE = CARRY_EXIT_V2_FROZEN_ROUTES.find(
  (row) => row.kind === 'comet' && row.routeKey === 'USDC → supply on Compound v3',
)
const address = (n) => `0x${n.toString(16).padStart(40, '0')}`
const sha = (n) => n.toString(16).padStart(64, '0')
const manifest = async () => structuredClone(await buildSubjectManifest())
const documents = () => [
  { marketKey: MARKET, range: { fromBlock: 10, toBlock: 10 }, sha256: sha(1) },
  { marketKey: MARKET, range: { fromBlock: 11, toBlock: 11 }, sha256: sha(2) },
]
const payout = (holder, receiver, amountRaw, timestampMs = 1500) => ({
  marketKey: MARKET,
  timestampMs,
  reconciliation: {
    status: 'reconciled_supplier_withdrawal',
    reason: 'exact_receipt_payout',
    routeKey: ROUTE.routeKey,
    destination: ROUTE.destination,
    underlying: ROUTE.asset,
    evidence: { holder, receiver, amountRaw },
  },
})
const verified = () => ({
  coverage: {
    marketKey: MARKET,
    startMs: 1000,
    endMs: 3000,
    intervals: [
      {
        startMs: 1000,
        endMs: 2000,
        finalized: true,
        receiptsComplete: false,
        ambiguousReceipts: 1,
      },
      { startMs: 2000, endMs: 3000, finalized: true, receiptsComplete: true, ambiguousReceipts: 0 },
    ],
  },
  withdrawals: [payout(address(1), address(1), '100'), payout(address(2), address(3), '50', 2500)],
  unclassifiedWithdrawals: [
    {
      marketKey: MARKET,
      timestampMs: 1500,
      eventAmountRaw: '999',
      reason: 'comet_borrow_or_share_burn_mismatch',
    },
  ],
})

test('counts only receipt-reconciled original-asset same-holder transfers', async () => {
  const result = await summarizeVerifiedDirectSupplierPayoutCoverage(
    MARKET,
    await manifest(),
    documents(),
    verified(),
  )
  assert.equal(result.cohort, 'frozen_25_67')
  assert.equal(result.evidenceClass, 'historical_other_holder_mined_payout')
  assert.equal(result.classifiedReceiptPayoutCount, 2)
  assert.equal(result.sameHolderPayoutCount, 1)
  assert.equal(result.sameHolderPayoutRaw, '100')
  assert.equal(result.otherReceiverPayoutCount, 1)
  assert.equal(result.unclassifiedWithdrawalCount, 1)
  assert.deepEqual(result.coverage.segmentSha256, [sha(1), sha(2)])
  assert.equal(result.sameEpisodeProspective, false)
  assert.equal(result.calibratedDuration, false)
  assert.equal(result.forecastValidated, false)
})

test('rejects a wrong frozen asset, destination, or missing exact manifest subject', async () => {
  for (const field of ['asset', 'destination', 'route_key']) {
    const altered = await manifest()
    const subject = altered.subjects.find((row) => row.route_key === ROUTE.routeKey)
    subject[field] = field === 'route_key' ? 'wrong route' : address(999)
    await assert.rejects(
      summarizeVerifiedDirectSupplierPayoutCoverage(MARKET, altered, documents(), verified()),
      /direct_payout_manifest_not_canonical/,
    )
  }
  const altered = verified()
  altered.withdrawals[0].reconciliation.underlying = address(999)
  await assert.rejects(
    summarizeVerifiedDirectSupplierPayoutCoverage(MARKET, await manifest(), documents(), altered),
    /direct_payout_reconciliation_mismatch/,
  )
})

test('rejects block and time gaps, malformed source SHA, and hidden ambiguous Comet events', async () => {
  const canonical = await manifest()
  const gap = documents()
  gap[1].range.fromBlock = 12
  await assert.rejects(
    summarizeVerifiedDirectSupplierPayoutCoverage(MARKET, canonical, gap, verified()),
    /direct_payout_segment_gap_or_identity_mismatch/,
  )
  const badSha = documents()
  badSha[1].sha256 = 'bad'
  await assert.rejects(
    summarizeVerifiedDirectSupplierPayoutCoverage(MARKET, canonical, badSha, verified()),
    /direct_payout_segment_gap_or_identity_mismatch/,
  )
  const timeGap = verified()
  timeGap.coverage.intervals[1].startMs++
  await assert.rejects(
    summarizeVerifiedDirectSupplierPayoutCoverage(MARKET, canonical, documents(), timeGap),
    /direct_payout_coverage_gap/,
  )
  const hidden = verified()
  hidden.unclassifiedWithdrawals = []
  await assert.rejects(
    summarizeVerifiedDirectSupplierPayoutCoverage(MARKET, canonical, documents(), hidden),
    /direct_payout_unclassified_mismatch/,
  )
})

test('supplemental USDe is out of frozen cohort and cannot be inserted into it', async () => {
  const usde = CARRY_EXIT_V2_FROZEN_ROUTES.find(
    (row) => row.kind === 'aave' && row.routeKey === 'USDe → supply on Aave V3',
  )
  const usdeDocuments = documents().map((row) => ({ ...row, marketKey: 'aaveV3Usde' }))
  const usdeVerified = verified()
  usdeVerified.coverage.marketKey = 'aaveV3Usde'
  usdeVerified.coverage.intervals[0].ambiguousReceipts = 0
  usdeVerified.coverage.intervals[0].receiptsComplete = true
  usdeVerified.withdrawals = []
  usdeVerified.unclassifiedWithdrawals = []
  const row = await summarizeVerifiedDirectSupplierPayoutCoverage(
    'aaveV3Usde',
    await manifest(),
    usdeDocuments,
    usdeVerified,
  )
  assert.equal(row.cohort, 'supplemental_outside_frozen_25_67')
  assert.equal(row.originalAsset, usde.asset.toLowerCase())
  const supplemental = await manifest()
  supplemental.subjects[0] = {
    route_key: usde.routeKey,
    destination: usde.destination,
    asset: usde.asset,
  }
  await assert.rejects(
    summarizeVerifiedDirectSupplierPayoutCoverage(
      'aaveV3Usde',
      supplemental,
      documents(),
      verified(),
    ),
    /direct_payout_manifest_not_canonical/,
  )
})

test('rejects a spoofed 25-group, 67-subject manifest even with a matching self-hash', async () => {
  const spoofed = await manifest()
  spoofed.subjects[0].asset = address(999)
  spoofed.payload = JSON.stringify(spoofed.subjects)
  spoofed.sha256 = createHash('sha256').update(spoofed.payload).digest('hex')
  assert.equal(spoofed.subjects.length, 67)
  assert.equal(new Set(spoofed.subjects.map((row) => row.route_key)).size, 25)
  await assert.rejects(
    summarizeVerifiedDirectSupplierPayoutCoverage(MARKET, spoofed, documents(), verified()),
    /direct_payout_manifest_not_canonical/,
  )
})

test('sealed tempdir segment traverses reader, verifier and summary; digest tamper fails', async () => {
  const hash = (n) => `0x${sha(n)}`
  const rpc = () => ({
    async request({ method, params }) {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getLogs') return []
      if (method === 'eth_getBlockByNumber') {
        const number = params[0] === 'finalized' ? 1000 : Number(BigInt(params[0]))
        return {
          number: `0x${number.toString(16)}`,
          hash: hash(number),
          parentHash: hash(number - 1),
          timestamp: `0x${(1000 + (number - 100) * 12).toString(16)}`,
        }
      }
      throw Error('unexpected_test_rpc_method')
    },
  })
  const directory = mkdtempSync(join(tmpdir(), 'direct-payout-inventory-'))
  try {
    const marketKey = 'aaveV3Usdc'
    const { document } = await collectDirectSupplierFlowSegment({
      primary: rpc(),
      secondary: rpc(),
      primaryOrigin: 'https://first.example',
      secondaryOrigin: 'https://second.example',
      marketKey,
      fromBlock: 100,
      toBlock: 100,
    })
    const path = join(directory, `${marketKey}-100-100.json`)
    writeFileSync(path, JSON.stringify(document))
    const result = await readDirectSupplierPayoutCoverage(await manifest(), directory, [marketKey])
    assert.equal(result.markets[0].status, 'observed')
    assert.equal(result.markets[0].coverage.segmentCount, 1)
    assert.deepEqual(result.markets[0].coverage.segmentSha256, [document.sha256])
    assert.equal(result.markets[0].sameHolderPayoutCount, 0)
    document.blocks[0].hash = hash(999)
    writeFileSync(path, JSON.stringify(document))
    await assert.rejects(
      readDirectSupplierPayoutCoverage(await manifest(), directory, [marketKey]),
      /direct_segment_digest_mismatch/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('absent archive directory marks all four markets unavailable without inventing coverage', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'direct-payout-missing-'))
  try {
    const result = await readDirectSupplierPayoutCoverage(await manifest(), join(parent, 'absent'))
    assert.equal(result.markets.length, 4)
    assert.deepEqual(
      result.markets.map((market) => [market.marketKey, market.status, market.reason]),
      [
        ['aaveV3Usdc', 'unavailable', 'no_sealed_segments'],
        ['sparkLendUsdt', 'unavailable', 'no_sealed_segments'],
        ['compoundV3Usdc', 'unavailable', 'no_sealed_segments'],
        ['aaveV3Usde', 'unavailable', 'no_sealed_segments'],
      ],
    )
    for (const market of result.markets) {
      assert.equal(market.coverage, undefined)
      assert.equal(market.sameEpisodeProspective, false)
      assert.equal(market.calibratedDuration, false)
      assert.equal(market.forecastValidated, false)
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('an existing non-directory or malformed archive fails closed', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'direct-payout-bad-dir-'))
  try {
    const file = join(parent, 'archive-file')
    writeFileSync(file, '')
    await assert.rejects(
      readDirectSupplierPayoutCoverage(await manifest(), file, ['aaveV3Usdc']),
      /invalid_direct_payout_archive_directory/,
    )
    const malformed = join(parent, 'aaveV3Usdc-invalid.json')
    writeFileSync(malformed, '{}')
    await assert.rejects(
      readDirectSupplierPayoutCoverage(await manifest(), parent, ['aaveV3Usdc']),
      /invalid_direct_segment_filename/,
    )
    rmSync(malformed)
    symlinkSync(join(parent, 'removed-segment.json'), join(parent, 'aaveV3Usdc-100-100.json'))
    await assert.rejects(
      readDirectSupplierPayoutCoverage(await manifest(), parent, ['aaveV3Usdc']),
      /invalid_direct_segment_file/,
    )
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
