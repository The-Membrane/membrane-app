import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { padHex, parseAbiItem, toEventSelector } from 'viem'

import { CARRY_EXIT_V2_FROZEN_ROUTES } from '../lib/carry-exit-v2-rpc-proof.mjs'
import {
  directSupplierFlowPublicationWitnessPath,
  writeDirectSupplierFlowPublicationWitness,
} from './carry-direct-supplier-flow-publication-witness.mjs'
import {
  directFlowFeatureReceiptSha256,
  readVerifiedDirectFlowFeatures,
} from './holder-exit-direct-flow-features.mjs'
import {
  buildIssueDirectFlowSnapshot,
  verifyIssueDirectFlowSnapshot,
} from './holder-exit-direct-flow-issue-snapshot.mjs'
import { readVerifiedIssueDirectFlowFeatures } from './holder-exit-direct-flow-snapshot-replay.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const blockHash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const MARKET_KEY = 'aaveV3Usdc'
const ROUTE = CARRY_EXIT_V2_FROZEN_ROUTES.find(
  (item) => item.kind === 'aave' && item.routeKey === 'USDC → supply on Aave V3',
)
const START = Date.parse('2026-10-01T00:00:00.000Z')
const MIDDLE = START + 13 * 3_600_000
const END = START + 26 * 3_600_000

function segment({ from, startMs, endMs, flowKind }) {
  const supply = flowKind === 'supply'
  const abi = parseAbiItem(
    supply
      ? 'event Supply(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint16 indexed referralCode)'
      : 'event Withdraw(address indexed reserve,address indexed user,address indexed to,uint256 amount)',
  )
  const body = {
    study: supply
      ? 'carry-direct-supplier-supply-flow-receipts-v2'
      : 'carry-direct-supplier-flow-receipts-v2',
    captureStartedAt: new Date(endMs + 1_000).toISOString(),
    captureCompletedAt: new Date(endMs + 2_000).toISOString(),
    sourceAgreement: 'two_public_rpc_origins_agree_not_absolute_completeness',
    originFingerprints: [hash('rpc-a'), hash('rpc-b')],
    marketKey: MARKET_KEY,
    chainId: 1,
    range: { fromBlock: from, toBlock: from },
    headerCoverage: 'sparse_boundary_candidate_blocks',
    filter: {
      address: ROUTE.withdrawTarget.toLowerCase(),
      topics: [toEventSelector(abi).toLowerCase(), padHex(ROUTE.asset, { size: 32 }).toLowerCase()],
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
  return { ...body, sha256: hash(JSON.stringify(body)) }
}

function issue() {
  return {
    marketKey: MARKET_KEY,
    routeKey: ROUTE.routeKey,
    destination: ROUTE.destination,
    originalAsset: ROUTE.asset,
    issuedAtUtc: new Date(END + 5_000).toISOString(),
    baseline: {
      targetBlock: '102',
      targetHash: blockHash(102),
      targetBlockAt: new Date(END).toISOString(),
    },
  }
}

function fixture(directory, { supplies = true } = {}) {
  const paths = new Map()
  for (const flowKind of supplies ? ['withdraw', 'supply'] : ['withdraw']) {
    for (const [from, startMs, endMs] of [
      [100, START, MIDDLE],
      [101, MIDDLE, END],
    ]) {
      const document = segment({ from, startMs, endMs, flowKind })
      const path = join(
        directory,
        `${flowKind === 'supply' ? 'supply-' : ''}${MARKET_KEY}-${from}-${from}.json`,
      )
      writeFileSync(path, `${JSON.stringify(document)}\n`)
      writeDirectSupplierFlowPublicationWitness(path, document, {
        now: () => Date.parse(document.captureCompletedAt) + 1_000,
      })
      paths.set(`${flowKind}-${from}`, path)
    }
  }
  const capture = readVerifiedDirectFlowFeatures({ directory, marketKeys: [MARKET_KEY] })
  const frozen = issue()
  frozen.flowSnapshot = buildIssueDirectFlowSnapshot(frozen, {
    features: capture.features,
    failed: false,
  })
  verifyIssueDirectFlowSnapshot(frozen)
  return { issue: frozen, paths }
}

function withDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), 'holder-direct-snapshot-replay-'))
  try {
    return run(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('replays exact frozen withdrawal and supply features from real V2 segment and receipt verifiers', () =>
  withDirectory((directory) => {
    const frozen = fixture(directory)
    const result = readVerifiedIssueDirectFlowFeatures(frozen.issue, { directory })
    assert.equal(result.status, 'verified')
    assert.equal(result.reason, null)
    assert.equal(result.features.length, 2)
    assert.deepEqual(result.features, [
      frozen.issue.flowSnapshot.withdrawals.feature,
      frozen.issue.flowSnapshot.supplies.feature,
    ])
    assert.equal(result.features[0].valueRaw, '0')
  }))

test('a single available withdrawal slot replays while supply is explicitly unavailable', () =>
  withDirectory((directory) => {
    const frozen = fixture(directory, { supplies: false })
    assert.equal(frozen.issue.flowSnapshot.supplies.status, 'unavailable')
    const result = readVerifiedIssueDirectFlowFeatures(frozen.issue, { directory })
    assert.equal(result.status, 'verified')
    assert.deepEqual(result.features, [frozen.issue.flowSnapshot.withdrawals.feature])
  }))

test('old issue and explicit unavailable slots return no fabricated feature', () =>
  withDirectory((directory) => {
    const old = issue()
    assert.deepEqual(readVerifiedIssueDirectFlowFeatures(old, { directory }), {
      features: [],
      status: 'unavailable',
      reason: 'issue_has_no_flow_snapshot',
    })
    old.flowSnapshot = buildIssueDirectFlowSnapshot(old, { features: [], failed: false })
    assert.deepEqual(readVerifiedIssueDirectFlowFeatures(old, { directory }), {
      features: [],
      status: 'unavailable',
      reason: 'no_available_flow_slot',
    })
  }))

test('missing pinned file or publication receipt abstains the whole issue', () => {
  withDirectory((directory) => {
    const frozen = fixture(directory)
    unlinkSync(frozen.paths.get('withdraw-100'))
    assert.deepEqual(readVerifiedIssueDirectFlowFeatures(frozen.issue, { directory }), {
      features: [],
      status: 'unavailable',
      reason: 'pinned_direct_flow_evidence_missing',
    })
  })
  withDirectory((directory) => {
    const frozen = fixture(directory)
    unlinkSync(directSupplierFlowPublicationWitnessPath(frozen.paths.get('supply-101')))
    assert.deepEqual(readVerifiedIssueDirectFlowFeatures(frozen.issue, { directory }), {
      features: [],
      status: 'unavailable',
      reason: 'pinned_direct_flow_evidence_missing',
    })
  })
})

test('re-sealed frozen amount cannot disagree with complete source replay', () =>
  withDirectory((directory) => {
    const frozen = fixture(directory, { supplies: false })
    const feature = frozen.issue.flowSnapshot.withdrawals.feature
    feature.valueRaw = '1'
    feature.receiptSha256 = directFlowFeatureReceiptSha256(feature, MARKET_KEY, 'withdraw')
    verifyIssueDirectFlowSnapshot(frozen.issue)
    assert.throws(
      () => readVerifiedIssueDirectFlowFeatures(frozen.issue, { directory }),
      /holder_direct_flow_replay_feature_mismatch/,
    )
  }))

test('tampered or symlinked pinned segment fails closed', () => {
  withDirectory((directory) => {
    const frozen = fixture(directory, { supplies: false })
    const path = frozen.paths.get('withdraw-100')
    const document = JSON.parse(readFileSync(path, 'utf8'))
    delete document.sha256
    document.originFingerprints[0] = hash('different-rpc-origin')
    writeFileSync(
      path,
      `${JSON.stringify({ ...document, sha256: hash(JSON.stringify(document)) })}\n`,
    )
    assert.throws(
      () => readVerifiedIssueDirectFlowFeatures(frozen.issue, { directory }),
      /holder_direct_flow_replay_segment_identity_mismatch/,
    )
  })
  withDirectory((directory) => {
    const frozen = fixture(directory, { supplies: false })
    const path = frozen.paths.get('withdraw-100')
    writeFileSync(path, `${readFileSync(path, 'utf8')} `)
    assert.throws(
      () => readVerifiedIssueDirectFlowFeatures(frozen.issue, { directory }),
      /holder_direct_flow_replay_segment_canonical_invalid/,
    )
  })
  withDirectory((directory) => {
    const frozen = fixture(directory, { supplies: false })
    const path = frozen.paths.get('withdraw-100')
    const target = `${path}.saved`
    writeFileSync(target, readFileSync(path))
    unlinkSync(path)
    symlinkSync(target, path)
    assert.throws(
      () => readVerifiedIssueDirectFlowFeatures(frozen.issue, { directory }),
      /holder_direct_flow_replay_segment_open_invalid/,
    )
  })
})

test('present receipt contradiction throws even when another pinned file is missing', () =>
  withDirectory((directory) => {
    const frozen = fixture(directory, { supplies: false })
    unlinkSync(frozen.paths.get('withdraw-100'))
    const witnessPath = directSupplierFlowPublicationWitnessPath(frozen.paths.get('withdraw-101'))
    const witness = JSON.parse(readFileSync(witnessPath, 'utf8'))
    delete witness.sha256
    witness.firstLocalReceiptAt = new Date(
      Date.parse(witness.firstLocalReceiptAt) + 1_000,
    ).toISOString()
    const resealed = { ...witness, sha256: hash(JSON.stringify(witness)) }
    chmodSync(witnessPath, 0o644)
    writeFileSync(witnessPath, `${JSON.stringify(resealed)}\n`)
    assert.throws(
      () => readVerifiedIssueDirectFlowFeatures(frozen.issue, { directory }),
      /holder_direct_flow_replay_publication_witness_mismatch/,
    )
  }))
