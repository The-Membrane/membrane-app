import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { padHex, parseAbiItem, toEventSelector } from 'viem'

import { CARRY_EXIT_V2_FROZEN_ROUTES } from '../lib/carry-exit-v2-rpc-proof.mjs'
import { verifyDirectSupplierFlowSegments } from './collect-carry-direct-supplier-flow.mjs'
import { writeDirectSupplierFlowPublicationWitness } from './carry-direct-supplier-flow-publication-witness.mjs'
import {
  directFlowFeaturesFromVerifiedSuffix,
  readBoundedDirectFlowV2Suffix,
  readVerifiedDirectFlowFeatures,
} from './holder-exit-direct-flow-features.mjs'
import { selectAsOfFeatures } from './holder-exit-episode-panel.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const blockHash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const marketKey = 'aaveV3Usdc'
const route = CARRY_EXIT_V2_FROZEN_ROUTES.find(
  (item) => item.kind === 'aave' && item.routeKey === 'USDC → supply on Aave V3',
)
const subject = { route_key: route.routeKey, destination: route.destination, asset: route.asset }
const day = 86_400_000
const start = Date.parse('2026-10-01T00:00:00.000Z')

function segment({ from, startMs, endMs, flowKind = 'withdraw', study } = {}) {
  const supply = flowKind === 'supply'
  const abi = parseAbiItem(
    supply
      ? 'event Supply(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint16 indexed referralCode)'
      : 'event Withdraw(address indexed reserve,address indexed user,address indexed to,uint256 amount)',
  )
  const body = {
    study:
      study ??
      (supply
        ? 'carry-direct-supplier-supply-flow-receipts-v2'
        : 'carry-direct-supplier-flow-receipts-v2'),
    captureStartedAt: new Date(endMs + 1_000).toISOString(),
    captureCompletedAt: new Date(endMs + 2_000).toISOString(),
    sourceAgreement: 'two_public_rpc_origins_agree_not_absolute_completeness',
    originFingerprints: [hash('rpc-a'), hash('rpc-b')],
    marketKey,
    chainId: 1,
    range: { fromBlock: from, toBlock: from },
    headerCoverage: 'sparse_boundary_candidate_blocks',
    filter: {
      address: route.withdrawTarget.toLowerCase(),
      topics: [toEventSelector(abi).toLowerCase(), padHex(route.asset, { size: 32 }).toLowerCase()],
    },
    finalized: [
      { number: from + 1, hash: blockHash(from + 1) },
      { number: from + 1, hash: blockHash(from + 1) },
    ],
    blocks: [
      {
        number: from,
        hash: blockHash(from),
        parentHash: blockHash(from - 1),
        timestampSec: startMs / 1_000,
      },
      {
        number: from + 1,
        hash: blockHash(from + 1),
        parentHash: blockHash(from),
        timestampSec: endMs / 1_000,
      },
    ],
    logQueries: [
      { origin: 'primary', slices: [{ fromBlock: from, toBlock: from, logs: [] }] },
      { origin: 'secondary', slices: [{ fromBlock: from, toBlock: from, logs: [] }] },
    ],
    logSets: [
      { origin: 'primary', logs: [] },
      { origin: 'secondary', logs: [] },
    ],
    receipts: [],
  }
  if (body.study.endsWith('-v1')) {
    delete body.captureStartedAt
    delete body.captureCompletedAt
  }
  return { ...body, sha256: hash(JSON.stringify(body)) }
}

function place(directory, document, { witness = true, receiptMs } = {}) {
  const prefix = document.study.includes('supply-flow') ? 'supply-' : ''
  const { fromBlock, toBlock } = document.range
  const path = join(directory, `${prefix}${document.marketKey}-${fromBlock}-${toBlock}.json`)
  writeFileSync(path, `${JSON.stringify(document)}\n`)
  if (witness && document.study.endsWith('-v2'))
    writeDirectSupplierFlowPublicationWitness(path, document, {
      now: () => receiptMs ?? Date.parse(document.captureCompletedAt) + 1_000,
    })
  return path
}

function withDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), 'holder-direct-feature-'))
  try {
    return run(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function issueAt(ms, block) {
  return {
    issue: { issuedAtUtc: new Date(ms + 5_000).toISOString() },
    parent: {
      baseline: {
        targetBlock: String(block),
        targetHash: blockHash(block),
        targetBlockAt: new Date(ms + 3_000).toISOString(),
      },
    },
  }
}

test('complete witnessed V2 windows yield bounded historical candidates, selected per issue', () =>
  withDirectory((directory) => {
    const points = [start, start + 13 * 3_600_000, start + 26 * 3_600_000, start + 39 * 3_600_000]
    for (let index = 0; index < 3; index++)
      place(
        directory,
        segment({ from: 100 + index, startMs: points[index], endMs: points[index + 1] }),
      )
    const result = readVerifiedDirectFlowFeatures({ directory, marketKeys: [marketKey] })
    const withdrawals = result.features.filter(
      (item) => item.kind === 'gross_supplier_withdraw_24h',
    )
    assert.equal(withdrawals.length, 2)
    assert.equal(withdrawals[0].valueRaw, '0')
    assert.equal(withdrawals[1].sourceBlock, '103')
    assert.equal(result.clockBasis, 'local_operator_clock_unwitnessed')
    assert.equal(result.forecastValidated, false)
    const earlier = issueAt(points[2], 102)
    const selected = selectAsOfFeatures(withdrawals, subject, earlier.issue, earlier.parent)
    assert.equal(selected.featureRefs.length, 1)
    assert.equal(selected.featureRefs[0].sourceBlock, '102')
    assert.equal(selected.featureAbstentions.future_source, 1)
    const later = issueAt(points[3], 103)
    assert.equal(
      selectAsOfFeatures(withdrawals, subject, later.issue, later.parent).featureRefs[0]
        .sourceBlock,
      '103',
    )
  }))

test('partial, missing-witness, V1, and gap windows abstain without inventing zero flow', () => {
  withDirectory((directory) => {
    place(directory, segment({ from: 100, startMs: start, endMs: start + 13 * 3_600_000 }))
    assert.equal(
      readVerifiedDirectFlowFeatures({ directory, marketKeys: [marketKey] }).features.length,
      0,
    )
  })
  withDirectory((directory) => {
    place(directory, segment({ from: 100, startMs: start, endMs: start + 13 * 3_600_000 }))
    place(
      directory,
      segment({ from: 101, startMs: start + 13 * 3_600_000, endMs: start + 26 * 3_600_000 }),
      { witness: false },
    )
    const result = readVerifiedDirectFlowFeatures({ directory, marketKeys: [marketKey] })
    assert.equal(result.features.length, 0)
    assert.equal(result.sources[0].reason, 'post_publication_witness_missing')
  })
  withDirectory((directory) => {
    place(
      directory,
      segment({
        from: 100,
        startMs: start,
        endMs: start + 13 * 3_600_000,
        study: 'carry-direct-supplier-flow-receipts-v1',
      }),
    )
    const result = readVerifiedDirectFlowFeatures({ directory, marketKeys: [marketKey] })
    assert.equal(result.features.length, 0)
    assert.equal(result.sources[0].reason, 'legacy_v1')
  })
  withDirectory((directory) => {
    place(directory, segment({ from: 100, startMs: start, endMs: start + 13 * 3_600_000 }))
    place(
      directory,
      segment({ from: 102, startMs: start + 13 * 3_600_000, endMs: start + 26 * 3_600_000 }),
    )
    const suffix = readBoundedDirectFlowV2Suffix({ marketKey, flowKind: 'withdraw', directory })
    assert.equal(suffix.boundary, 'source_gap')
    assert.equal(
      readVerifiedDirectFlowFeatures({ directory, marketKeys: [marketKey] }).features.length,
      0,
    )
  })
})

test('late local publication stays out of an earlier issue even when source range predates it', () =>
  withDirectory((directory) => {
    const end = start + 26 * 3_600_000
    place(directory, segment({ from: 100, startMs: start, endMs: start + 13 * 3_600_000 }))
    place(directory, segment({ from: 101, startMs: start + 13 * 3_600_000, endMs: end }), {
      receiptMs: end + 10_000,
    })
    const result = readVerifiedDirectFlowFeatures({ directory, marketKeys: [marketKey] })
    assert.equal(result.features.length, 1)
    const timing = issueAt(end, 102)
    const selected = selectAsOfFeatures(result.features, subject, timing.issue, timing.parent)
    assert.equal(selected.featureRefs.length, 0)
    assert.equal(selected.featureAbstentions.late_first_local_receipt, 1)
  }))

test('wrong market content is rejected before it can become a feature', () =>
  withDirectory((directory) => {
    const document = segment({ from: 100, startMs: start, endMs: start + 13 * 3_600_000 })
    const wrong = { ...document, marketKey: 'aaveV3Usde' }
    const { sha256: _old, ...body } = wrong
    wrong.sha256 = hash(JSON.stringify(body))
    writeFileSync(join(directory, 'aaveV3Usdc-100-100.json'), `${JSON.stringify(wrong)}\n`)
    assert.throws(
      () => readVerifiedDirectFlowFeatures({ directory, marketKeys: [marketKey] }),
      /holder_direct_flow_market_or_range_mismatch/,
    )
  }))

test('a supply filename cannot hide a withdrawal study as a legacy boundary', () =>
  withDirectory((directory) => {
    const document = segment({
      from: 100,
      startMs: start,
      endMs: start + 13 * 3_600_000,
      study: 'carry-direct-supplier-flow-receipts-v1',
    })
    writeFileSync(
      join(directory, 'supply-aaveV3Usdc-100-100.json'),
      `${JSON.stringify(document)}\n`,
    )
    assert.throws(
      () => readVerifiedDirectFlowFeatures({ directory, marketKeys: [marketKey] }),
      /holder_direct_flow_study_invalid/,
    )
  }))

test('verified event arithmetic uses half-open 24 hour windows and raw units', () =>
  withDirectory((directory) => {
    const end = start + 26 * 3_600_000
    place(directory, segment({ from: 100, startMs: start, endMs: start + 13 * 3_600_000 }))
    place(directory, segment({ from: 101, startMs: start + 13 * 3_600_000, endMs: end }))
    const suffix = readBoundedDirectFlowV2Suffix({ marketKey, flowKind: 'withdraw', directory })
    const verified = verifyDirectSupplierFlowSegments(suffix.selected.map((item) => item.document))
    const witnesses = suffix.selected.map((item) => ({
      status: 'local_publication_witness',
      clockBasis: 'local_operator_clock_unwitnessed',
      prospectiveValidation: false,
      firstLocalReceiptAt: new Date(
        Date.parse(item.document.captureCompletedAt) + 1_000,
      ).toISOString(),
      witnessSha256: hash(item.document.sha256),
    }))
    verified.withdrawals = [
      { marketKey, timestampMs: end - day - 1, reconciliation: { evidence: { amountRaw: '500' } } },
      { marketKey, timestampMs: end - day, reconciliation: { evidence: { amountRaw: '700' } } },
      { marketKey, timestampMs: end - 1, reconciliation: { evidence: { amountRaw: '300' } } },
      { marketKey, timestampMs: end, reconciliation: { evidence: { amountRaw: '900' } } },
    ]
    const feature = directFlowFeaturesFromVerifiedSuffix({
      marketKey,
      flowKind: 'withdraw',
      selected: suffix.selected,
      verified,
      witnesses,
    })[0]
    assert.equal(feature.valueRaw, '1000')
  }))
