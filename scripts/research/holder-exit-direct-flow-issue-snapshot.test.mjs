import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { freezeDirectQLadder } from '../lib/carry-exit-v2-direct-issuer-prep.mjs'
import {
  appendPublicDirectIssue as appendPublic,
  buildPublicDirectIssue as buildPublic,
  DIRECT_MARKETS as PUBLIC_MARKETS,
  issuePublicDirectExit as issuePublic,
  verifyPublicDirectIssues as verifyPublic,
} from './carry-public-direct-exit-issue.mjs'
import {
  appendPublicDirectIssue as appendCompound,
  buildPublicDirectIssue as buildCompound,
  DIRECT_MARKETS as COMPOUND_MARKETS,
  issuePublicDirectExit as issueCompound,
  verifyPublicDirectIssues as verifyCompound,
} from './carry-local-compound-holder-issue.mjs'
import {
  buildIssueDirectFlowSnapshot,
  captureIssueDirectFlowCandidates,
  flowFeaturesFromIssueSnapshot,
  requireFreshIssueDirectFlowSnapshot,
  verifyIssueDirectFlowSnapshot,
} from './holder-exit-direct-flow-issue-snapshot.mjs'
import { directFlowFeatureReceiptSha256 } from './holder-exit-direct-flow-features.mjs'

const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const blockHash = (value) => `0x${value.toString(16).padStart(64, '0')}`
const startMs = Date.parse('2026-10-01T00:00:00.000Z')
const endMs = startMs + 26 * 3_600_000
const BASELINE_AT = new Date(endMs).toISOString()
const OBSERVED_AT = new Date(endMs + 2 * 60_000).toISOString()
const ISSUED_AT = new Date(endMs + 5 * 60_000).toISOString()

function context(marketKey = 'aaveV3Usdc', route = PUBLIC_MARKETS[marketKey]) {
  return {
    marketKey,
    routeKey: route.routeKey,
    destination: route.destination,
    originalAsset: route.asset,
    issuedAtUtc: ISSUED_AT,
    baseline: {
      targetBlock: '102',
      targetHash: blockHash(102),
      targetBlockAt: BASELINE_AT,
    },
  }
}

function feature(issue, flowKind = 'withdraw', changes = {}) {
  const constituentRefs = [
    {
      fromBlock: 100,
      toBlock: 100,
      segmentSha256: sha('segment-one'),
      publicationWitnessSha256: sha('receipt-one'),
      captureCompletedAt: new Date(endMs + 2_000).toISOString(),
      firstLocalReceiptAt: new Date(endMs + 3_000).toISOString(),
    },
    {
      fromBlock: 101,
      toBlock: 101,
      segmentSha256: sha('segment-two'),
      publicationWitnessSha256: sha('receipt-two'),
      captureCompletedAt: new Date(endMs + 2_000).toISOString(),
      firstLocalReceiptAt: new Date(endMs + 3_000).toISOString(),
    },
  ]
  const data = {
    kind: flowKind === 'supply' ? 'gross_supplier_supply_24h' : 'gross_supplier_withdraw_24h',
    routeKey: issue.routeKey,
    destination: issue.destination,
    asset: issue.originalAsset,
    collectionMode: 'historical_preissue',
    coverageComplete: true,
    sourceBlock: '102',
    sourceBlockHash: blockHash(102),
    sourceAt: BASELINE_AT,
    firstLocalReceiptAt: new Date(endMs + 3_000).toISOString(),
    completedAtUtc: new Date(endMs + 2_000).toISOString(),
    valueRaw: '1000',
    clockBasis: 'local_operator_clock_unwitnessed',
    windowStartAt: new Date(endMs - 86_400_000).toISOString(),
    windowEndAt: BASELINE_AT,
    constituentRefs,
    ...changes,
  }
  data.receiptSha256 = directFlowFeatureReceiptSha256(data, issue.marketKey, flowKind)
  return data
}

function issueValues(marketKey, route) {
  const baseline = {
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    kind: route.kind,
    targetBlock: '102',
    targetHash: blockHash(102),
    targetParentBlock: '101',
    targetParentHash: blockHash(101),
    targetBlockAt: BASELINE_AT,
    targetObservedAt: OBSERVED_AT,
    marketSupplyRaw: '1000000',
    assetDecimals: 6,
    canonicalityEvidenceDoc: {
      schema: 'carry_exit_v2_headers_v1',
      provider: 'https://origin-one.example',
      observedAt: OBSERVED_AT,
      targetHeader: {
        number: '102',
        hash: blockHash(102),
        parentHash: blockHash(101),
        timestamp: BASELINE_AT,
      },
      parentHeader: {
        number: '101',
        hash: blockHash(101),
        parentHash: blockHash(100),
        timestamp: '2026-10-04T00:09:48.000Z',
      },
    },
  }
  const candidate = {
    holder: null,
    evidenceDoc: {
      schema: 'carry_public_direct_candidate_unavailable_v1',
      chainId: '1',
      routeKey: route.routeKey,
      destination: route.destination,
      asset: route.asset,
      baselineBlock: '102',
      baselineHash: blockHash(102),
      selectedHolderCommitment: null,
      selectedAssetBalanceRaw: null,
      unavailableReason: 'candidate_scan_unavailable',
      ladder: freezeDirectQLadder({ marketSupplyRaw: baseline.marketSupplyRaw }),
    },
  }
  return {
    marketKey,
    baseline,
    baselineWitness: {
      provider: 'https://origin-two.example',
      block: '102',
      hash: blockHash(102),
      marketSupplyRaw: baseline.marketSupplyRaw,
      assetDecimals: 6,
      underlying: route.asset,
      observedAtUtc: new Date(endMs + 3 * 60_000).toISOString(),
    },
    candidate,
    measurements: {},
    issuedAtUtc: ISSUED_AT,
    sequence: 1,
    previousSha256: null,
  }
}

test('available gross flow freezes exact segment ranges and witness digests for both kinds', () => {
  const issue = context()
  const flowCapture = captureIssueDirectFlowCandidates({
    marketKey: issue.marketKey,
    readFlow: ({ marketKeys }) => {
      assert.deepEqual(marketKeys, [issue.marketKey])
      return { features: [feature(issue), feature(issue, 'supply')] }
    },
  })
  const snapshot = buildIssueDirectFlowSnapshot(issue, flowCapture)
  assert.equal(snapshot.withdrawals.status, 'available')
  assert.equal(snapshot.supplies.status, 'available')
  assert.deepEqual(snapshot.withdrawals.feature.constituentRefs[0], {
    fromBlock: 100,
    toBlock: 100,
    segmentSha256: sha('segment-one'),
    publicationWitnessSha256: sha('receipt-one'),
    captureCompletedAt: new Date(endMs + 2_000).toISOString(),
    firstLocalReceiptAt: new Date(endMs + 3_000).toISOString(),
  })
  assert.equal(snapshot.clockBasis, 'local_operator_clock_unwitnessed')
  assert.equal(snapshot.sourceBaselineAncestry, 'unproven')
  assert.equal(flowFeaturesFromIssueSnapshot({ ...issue, flowSnapshot: snapshot }).length, 2)
  assert.deepEqual(flowFeaturesFromIssueSnapshot(issue), [])
})

test('late receipt, future source, wrong fork and absent V1 window abstain without a zero', () => {
  const issue = context()
  const future = feature(issue, 'withdraw', {
    sourceBlock: '103',
    sourceBlockHash: blockHash(103),
  })
  const late = feature(issue, 'supply', {
    firstLocalReceiptAt: new Date(Date.parse(ISSUED_AT) + 1_000).toISOString(),
  })
  const fork = feature(issue, 'withdraw', { sourceBlockHash: blockHash(999) })
  const snapshot = buildIssueDirectFlowSnapshot(issue, {
    features: [future, late, fork],
    failed: false,
  })
  assert.equal(snapshot.withdrawals.reason, 'no_preissue_complete_v2_window')
  assert.equal(snapshot.supplies.reason, 'no_preissue_complete_v2_window')
  assert.deepEqual(flowFeaturesFromIssueSnapshot({ ...issue, flowSnapshot: snapshot }), [])
  const legacy = buildIssueDirectFlowSnapshot(issue, { features: [], failed: false })
  assert.equal(legacy.withdrawals.reason, 'no_preissue_complete_v2_window')
  const failed = buildIssueDirectFlowSnapshot(issue, {
    features: [],
    failed: true,
  })
  assert.equal(failed.withdrawals.reason, 'flow_read_unavailable')
  assert.equal(
    captureIssueDirectFlowCandidates({
      marketKey: issue.marketKey,
      readFlow: () => {
        throw Error('bad archive')
      },
    }).failed,
    true,
  )
})

test('re-sealing an issue cannot smuggle changed flow amounts, refs, clocks or route', () => {
  const issue = context()
  const flowSnapshot = buildIssueDirectFlowSnapshot(issue, {
    features: [feature(issue)],
    failed: false,
  })
  const original = { ...issue, flowSnapshot }
  for (const mutate of [
    (row) => {
      row.flowSnapshot.withdrawals.feature.valueRaw = '999'
    },
    (row) => {
      row.flowSnapshot.withdrawals.feature.constituentRefs[0].fromBlock = 99
    },
    (row) => {
      row.flowSnapshot.withdrawals.feature.constituentRefs[0].firstLocalReceiptAt = new Date(
        Date.parse(ISSUED_AT) + 1,
      ).toISOString()
    },
    (row) => {
      row.flowSnapshot.withdrawals.feature.firstLocalReceiptAt = new Date(
        Date.parse(ISSUED_AT) + 1,
      ).toISOString()
    },
    (row) => {
      row.flowSnapshot.routeKey = 'wrong route'
    },
  ]) {
    const changed = structuredClone(original)
    mutate(changed)
    assert.throws(() => verifyIssueDirectFlowSnapshot(changed), /holder_issue_flow_/)
  }
})

test('public and Compound issue validators accept optional snapshots and preserve old bodies', async () => {
  for (const lane of [
    {
      marketKey: 'aaveV3Usdc',
      route: PUBLIC_MARKETS.aaveV3Usdc,
      build: buildPublic,
      append: appendPublic,
      verify: verifyPublic,
    },
    {
      marketKey: 'compoundV3Usdc',
      route: COMPOUND_MARKETS.compoundV3Usdc,
      build: buildCompound,
      append: appendCompound,
      verify: verifyCompound,
    },
  ]) {
    const values = issueValues(lane.marketKey, lane.route)
    const original = lane.build(values)
    assert.equal(Object.hasOwn(original, 'flowSnapshot'), false)
    const pinned = lane.build({
      ...values,
      flowCapture: { features: [feature(context(lane.marketKey, lane.route))], failed: false },
    })
    assert.equal(pinned.flowSnapshot.withdrawals.status, 'available')
    assert.equal(pinned.flowSnapshot.supplies.status, 'unavailable')
    const out = await mkdtemp(join(tmpdir(), 'holder-flow-issue-'))
    try {
      await lane.append(pinned, out, () => ({ bavail: 2e9, bsize: 1 }))
      assert.equal((await lane.verify(out))[0].sha256, pinned.sha256)
      const altered = structuredClone(pinned)
      altered.flowSnapshot.withdrawals.feature.valueRaw = '999'
      const { sha256: _oldSeal, ...body } = altered
      altered.sha256 = sha(body)
      await writeFile(join(out, '00000001.json'), `${JSON.stringify(altered)}\n`)
      await assert.rejects(() => lane.verify(out), /holder_issue_flow_/)
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  }
})

test('strict campaign flow gate requires both recent issue-bound windows', () => {
  const issue = context()
  const available = {
    ...issue,
    flowSnapshot: buildIssueDirectFlowSnapshot(issue, {
      failed: false,
      features: [feature(issue, 'withdraw'), feature(issue, 'supply')],
    }),
  }
  assert.equal(requireFreshIssueDirectFlowSnapshot(available), available.flowSnapshot)

  const missing = {
    ...issue,
    flowSnapshot: buildIssueDirectFlowSnapshot(issue, {
      failed: false,
      features: [feature(issue, 'withdraw')],
    }),
  }
  assert.throws(
    () => requireFreshIssueDirectFlowSnapshot(missing),
    /holder_issue_flow_fresh_window_missing/,
  )

  const earlier = new Date(endMs - 3 * 3_600_000).toISOString()
  const staleSupply = feature(issue, 'supply', {
    sourceAt: earlier,
    windowStartAt: new Date(Date.parse(earlier) - 86_400_000).toISOString(),
    windowEndAt: earlier,
  })
  const stale = {
    ...issue,
    flowSnapshot: buildIssueDirectFlowSnapshot(issue, {
      failed: false,
      features: [feature(issue, 'withdraw'), staleSupply],
    }),
  }
  assert.throws(
    () => requireFreshIssueDirectFlowSnapshot(stale),
    /holder_issue_flow_fresh_window_stale/,
  )
})

test('strict public and Compound issuers never append incomplete flow snapshots', async () => {
  for (const lane of [
    { marketKey: 'aaveV3Usdc', route: PUBLIC_MARKETS.aaveV3Usdc, issue: issuePublic },
    { marketKey: 'compoundV3Usdc', route: COMPOUND_MARKETS.compoundV3Usdc, issue: issueCompound },
  ]) {
    const values = issueValues(lane.marketKey, lane.route)
    const out = await mkdtemp(join(tmpdir(), 'holder-fresh-flow-issuer-'))
    let appended = false
    try {
      const options = {
        marketKey: lane.marketKey,
        clients: ['one', 'two'].map((name) => ({
          provider: `https://${name}.example`,
          request: async () => {
            throw Error('unexpected RPC')
          },
        })),
        out,
        capture: async () => values.baseline,
        discover: async () => values.candidate,
        witness: async () => values.baselineWitness,
        measure: async () => {
          throw Error('measurement unavailable')
        },
        now: () => new Date(ISSUED_AT),
        requireFreshFlow: true,
        append: () => {
          appended = true
          return { status: 'issued' }
        },
      }
      await assert.rejects(
        () =>
          lane.issue({
            ...options,
            readFlow: () => ({ features: [feature(context(lane.marketKey, lane.route))] }),
          }),
        /holder_issue_flow_fresh_window_missing/,
      )
      assert.equal(appended, false)
      await lane.issue({
        ...options,
        readFlow: () => ({
          features: [
            feature(context(lane.marketKey, lane.route), 'withdraw'),
            feature(context(lane.marketKey, lane.route), 'supply'),
          ],
        }),
      })
      assert.equal(appended, true)
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  }
})

test('public and Compound issues reject a detached baseline parent header', () => {
  for (const lane of [
    { marketKey: 'aaveV3Usdc', route: PUBLIC_MARKETS.aaveV3Usdc, build: buildPublic },
    { marketKey: 'compoundV3Usdc', route: COMPOUND_MARKETS.compoundV3Usdc, build: buildCompound },
  ]) {
    const values = issueValues(lane.marketKey, lane.route)
    for (const mutate of [
      (baseline) => {
        baseline.canonicalityEvidenceDoc.targetHeader.parentHash = blockHash(99)
      },
      (baseline) => {
        baseline.canonicalityEvidenceDoc.parentHeader.hash = blockHash(99)
      },
      (baseline) => {
        baseline.targetParentBlock = '100'
      },
    ]) {
      const malformed = structuredClone(values)
      mutate(malformed.baseline)
      assert.throws(() => lane.build(malformed), /public_issue_identity_invalid/)
    }
  }
})

test('both issuer paths freeze flow before final issue clock and preserve baseline on read failure', async () => {
  for (const lane of [
    {
      marketKey: 'aaveV3Usdc',
      route: PUBLIC_MARKETS.aaveV3Usdc,
      issue: issuePublic,
      append: appendPublic,
      verify: verifyPublic,
      failRead: false,
    },
    {
      marketKey: 'compoundV3Usdc',
      route: COMPOUND_MARKETS.compoundV3Usdc,
      issue: issueCompound,
      append: appendCompound,
      verify: verifyCompound,
      failRead: true,
    },
  ]) {
    const values = issueValues(lane.marketKey, lane.route)
    const out = await mkdtemp(join(tmpdir(), 'holder-flow-issuer-'))
    let clockReads = 0
    try {
      await lane.issue({
        marketKey: lane.marketKey,
        clients: [
          {
            provider: 'https://origin-one.example',
            request: async () => {
              throw Error('unexpected RPC')
            },
          },
          {
            provider: 'https://origin-two.example',
            request: async () => {
              throw Error('unexpected RPC')
            },
          },
        ],
        out,
        capture: async () => values.baseline,
        discover: async () => values.candidate,
        witness: async () => values.baselineWitness,
        measure: async () => {
          throw Error('measurement unavailable')
        },
        readFlow: ({ marketKeys }) => {
          assert.deepEqual(marketKeys, [lane.marketKey])
          assert.equal(clockReads, 0)
          if (lane.failRead) throw Error('bounded archive unavailable')
          return { features: [feature(context(lane.marketKey, lane.route))] }
        },
        now: () => {
          clockReads++
          return new Date(ISSUED_AT)
        },
        append: (row, path) => lane.append(row, path, () => ({ bavail: 2e9, bsize: 1 })),
      })
      assert.equal(clockReads, 2)
      const saved = (await lane.verify(out))[0]
      assert.equal(
        saved.flowSnapshot.withdrawals.status,
        lane.failRead ? 'unavailable' : 'available',
      )
      assert.equal(
        saved.flowSnapshot.withdrawals.reason,
        lane.failRead ? 'flow_read_unavailable' : undefined,
      )
      assert.equal(
        saved.flowAncestry.withdrawals.status,
        lane.failRead ? 'unavailable' : 'available',
      )
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  }
})

test('native issuers read the frozen source path from their selected independent origins', async () => {
  for (const lane of [
    {
      marketKey: 'aaveV3Usdc',
      route: PUBLIC_MARKETS.aaveV3Usdc,
      issue: issuePublic,
      append: appendPublic,
      verify: verifyPublic,
    },
    {
      marketKey: 'compoundV3Usdc',
      route: COMPOUND_MARKETS.compoundV3Usdc,
      issue: issueCompound,
      append: appendCompound,
      verify: verifyCompound,
    },
  ]) {
    const values = issueValues(lane.marketKey, lane.route)
    const earlierAt = new Date(endMs - 24_000).toISOString()
    const gross = feature(context(lane.marketKey, lane.route), 'withdraw', {
      sourceBlock: '100',
      sourceBlockHash: blockHash(100),
      sourceAt: earlierAt,
      windowStartAt: new Date(endMs - 24_000 - 86_400_000).toISOString(),
      windowEndAt: earlierAt,
      constituentRefs: [
        {
          fromBlock: 99,
          toBlock: 99,
          segmentSha256: sha('earlier-segment'),
          publicationWitnessSha256: sha('earlier-publication'),
          captureCompletedAt: new Date(endMs + 2_000).toISOString(),
          firstLocalReceiptAt: new Date(endMs + 3_000).toISOString(),
        },
      ],
    })
    const out = await mkdtemp(join(tmpdir(), 'holder-flow-native-ancestry-'))
    const reads = []
    try {
      const clients = ['bad', 'one', 'two'].map((name) => ({
        provider: `https://${name}.example`,
        request: async (method, params) => {
          reads.push({ name, method, params })
          assert.notEqual(name, 'bad')
          assert.equal(method, 'eth_getBlockByNumber')
          assert.deepEqual(params, ['0x65', false])
          return {
            number: '0x65',
            hash: blockHash(101),
            parentHash: blockHash(100),
          }
        },
      }))
      await lane.issue({
        marketKey: lane.marketKey,
        clients,
        out,
        capture: async ({ provider }) => {
          if (provider === 'https://bad.example') throw Error('origin unavailable')
          return values.baseline
        },
        discover: async () => values.candidate,
        witness: async (_route, _baseline, secondary) => {
          if (secondary.provider === 'https://bad.example') throw Error('origin unavailable')
          return values.baselineWitness
        },
        measure: async () => {
          throw Error('measurement unavailable')
        },
        readFlow: () => ({ features: [gross] }),
        now: () => new Date(ISSUED_AT),
        append: (row, path) => lane.append(row, path, () => ({ bavail: 2e9, bsize: 1 })),
        ...(lane.marketKey === 'compoundV3Usdc'
          ? { expectedSlot: Math.floor(Date.parse(ISSUED_AT) / (15 * 60_000)) }
          : {}),
      })
      assert.deepEqual(
        reads.map((read) => read.name),
        ['one', 'two'],
      )
      const saved = (await lane.verify(out))[0]
      assert.equal(saved.flowSnapshot.withdrawals.feature.sourceBlock, '100')
      assert.equal(saved.flowAncestry.withdrawals.status, 'available')
      assert.equal(saved.flowAncestry.withdrawals.witness.headers[0].parentHash, blockHash(100))
      assert.equal(saved.flowAncestry.supplies.reason, 'no_frozen_flow_feature')
      assert.equal(saved.flowSnapshot.clockBasis, 'local_operator_clock_unwitnessed')
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  }
})

test('Compound refuses to seal an issue after its attempt slot expires', async () => {
  const values = issueValues('compoundV3Usdc', COMPOUND_MARKETS.compoundV3Usdc)
  const out = await mkdtemp(join(tmpdir(), 'holder-flow-compound-slot-'))
  let clockReads = 0
  try {
    await assert.rejects(
      issueCompound({
        marketKey: 'compoundV3Usdc',
        clients: ['one', 'two'].map((name) => ({
          provider: `https://${name}.example`,
          request: async () => {
            throw Error('unexpected RPC')
          },
        })),
        out,
        capture: async () => values.baseline,
        discover: async () => values.candidate,
        witness: async () => values.baselineWitness,
        measure: async () => {
          throw Error('measurement unavailable')
        },
        readFlow: () => ({ features: [] }),
        now: () => new Date(Date.parse(ISSUED_AT) + clockReads++ * 16 * 60_000),
        expectedSlot: Math.floor(Date.parse(ISSUED_AT) / (15 * 60_000)),
        append: (row, path) => appendCompound(row, path, () => ({ bavail: 2e9, bsize: 1 })),
      }),
      /compound_issue_slot_expired/,
    )
    assert.equal(clockReads, 2)
    assert.deepEqual(await verifyCompound(out), [])
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('native issuers refuse a regressed final issue clock after ancestry collection', async () => {
  for (const lane of [
    { marketKey: 'aaveV3Usdc', route: PUBLIC_MARKETS.aaveV3Usdc, issue: issuePublic },
    { marketKey: 'compoundV3Usdc', route: COMPOUND_MARKETS.compoundV3Usdc, issue: issueCompound },
  ]) {
    const values = issueValues(lane.marketKey, lane.route)
    const out = await mkdtemp(join(tmpdir(), 'holder-flow-regressed-clock-'))
    let clockReads = 0
    try {
      await assert.rejects(
        lane.issue({
          marketKey: lane.marketKey,
          clients: ['one', 'two'].map((name) => ({
            provider: `https://${name}.example`,
            request: async () => {
              throw Error('unexpected RPC')
            },
          })),
          out,
          capture: async () => values.baseline,
          discover: async () => values.candidate,
          witness: async () => values.baselineWitness,
          measure: async () => {
            throw Error('measurement unavailable')
          },
          readFlow: () => ({ features: [] }),
          now: () => new Date(Date.parse(ISSUED_AT) - clockReads++ * 1_000),
        }),
        /public_issue_clock_regressed/,
      )
      assert.equal(clockReads, 2)
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  }
})
