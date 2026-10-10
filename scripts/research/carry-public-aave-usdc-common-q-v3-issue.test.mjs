import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { toEventSelector } from 'viem'

import {
  Q,
  classifyAaveCommonBaseline,
  eligibleAaveCommonParent,
  issueAaveCommonQ,
  packAaveCommonReceipt,
  planAaveCommonCases,
  recordAaveCommonDiagnostic,
  aaveCommonCandidateCensus,
  recoverAaveCommonSelectedCandidate,
  recoverAaveCommonCandidates,
  recoverAaveCommonOwner,
  selectAaveCommonCandidate,
  unpackAaveCommonReceipt,
  validateAaveCommonIssue,
} from './carry-public-aave-usdc-common-q-v3-issue.mjs'
import { sha } from './carry-public-sgho-exit-common.mjs'

const destination = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c'
const asset = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const primaryProvider = 'https://one.example'
const secondaryProvider = 'https://two.example'
const hash = (char) => `0x${char.repeat(64)}`
const owner = (char) => `0x${char.repeat(40)}`
const topic = (address) => `0x${address.slice(2).padStart(64, '0')}`
const transfer = toEventSelector('Transfer(address,address,uint256)').toLowerCase()
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`

function fixture(balanceRaw = '999999') {
  const receipts = []
  const screenedCandidates = []
  for (const [index, who] of [owner('1'), owner('2')].entries()) {
    const tx = hash(index ? 'd' : 'e')
    const log = {
      address: destination,
      blockHash: hash('c'),
      blockNumber: '0x63',
      transactionHash: tx,
      logIndex: `0x${index.toString(16)}`,
      topics: [transfer, topic(owner('3')), topic(who)],
      data: word(1_000_000),
      removed: false,
    }
    const receipt = {
      status: '0x1',
      transactionHash: tx,
      blockHash: hash('c'),
      blockNumber: '0x63',
      logs: [log],
    }
    receipts.push(receipt)
    screenedCandidates.push({
      holderCommitment: sha(`${destination}:${who}`),
      discoveryTransactionHash: tx,
      discoveryLogIndex: String(index),
      discoveryBlock: '99',
      observedIncomingAssetsRaw: '1000000',
      status: 'eligible_holder',
      assetBalanceRaw: balanceRaw,
      receiptDigest: sha(
        JSON.stringify({
          transactionHash: receipt.transactionHash,
          blockHash: receipt.blockHash,
          status: receipt.status,
          logs: receipt.logs,
        }),
      ),
    })
  }
  const parent = {
    sequence: 1,
    sha256: 'a'.repeat(64),
    marketKey: 'aaveV3Usdc',
    slot: 0,
    routeKey: 'USDC → supply on Aave V3',
    destination,
    originalAsset: asset,
    issuedAtUtc: '2026-10-01T00:10:00.000Z',
    baseline: {
      targetBlock: '100',
      targetHash: hash('a'),
      targetParentHash: hash('b'),
      targetBlockAt: '2026-10-01T00:00:00.000Z',
      canonicalityEvidenceDoc: { provider: primaryProvider },
    },
    baselineWitness: { provider: secondaryProvider },
    candidate: { evidenceDoc: { schema: 'carry_exit_v2_direct_candidate_v1', screenedCandidates } },
    targets: [
      {
        horizonHours: 1,
        targetAtUtc: '2026-10-01T01:10:00.000Z',
        captureDeadlineUtc: '2026-10-01T03:10:00.000Z',
      },
    ],
  }
  return { parent, receipts, screenedCandidates }
}

function clients(receipts, balanceRaw = '999999') {
  return [primaryProvider, secondaryProvider].map((provider) => ({
    provider,
    url: provider,
    send: async () => {
      throw Error('unused')
    },
    async request(method, params) {
      if (method === 'eth_getTransactionReceipt')
        return receipts.find((x) => x.transactionHash === params[0])
      if (method === 'eth_getBlockByNumber') {
        if (params[0] === 'finalized') return { number: '0x65', hash: hash('f') }
        if (params[0] === '0x64') return { number: '0x64', hash: hash('a'), parentHash: hash('b') }
        if (params[0] === '0x63') return { number: '0x63', hash: hash('c') }
      }
      if (method === 'eth_getCode') return '0x'
      if (method === 'eth_call') return word(balanceRaw)
      throw Error('unexpected_rpc')
    },
  }))
}

test('nonselected raw EOA is recovered from exact sealed receipt, not commitment inversion', () => {
  const { parent, receipts, screenedCandidates } = fixture()
  assert.equal(recoverAaveCommonOwner(screenedCandidates[1], receipts[1], parent).owner, owner('2'))
  assert.throws(() => recoverAaveCommonOwner(screenedCandidates[1], receipts[0], parent), /digest/)
  const forged = structuredClone(receipts[1])
  forged.logs[0].topics[2] = topic(owner('4'))
  assert.throws(() => recoverAaveCommonOwner(screenedCandidates[1], forged, parent), /digest/)
  const oversized = structuredClone(receipts[1])
  oversized.logs = Array.from({ length: 129 }, () => oversized.logs[0])
  const resealedScreen = {
    ...screenedCandidates[1],
    receiptDigest: sha(
      JSON.stringify({
        transactionHash: oversized.transactionHash,
        blockHash: oversized.blockHash,
        status: oversized.status,
        logs: oversized.logs,
      }),
    ),
  }
  assert.throws(() => recoverAaveCommonOwner(resealedScreen, oversized, parent), /too_large/)
})

test('near-limit legal receipt roundtrips exactly; oversized witness is explicit', async () => {
  const { parent, receipts } = fixture()
  const entropy = Array.from({ length: 900 }, (_, index) =>
    createHash('sha256').update(`witness-${index}`).digest('hex'),
  ).join('')
  const large = structuredClone(receipts[0])
  large.logs[0].extraRpcField = entropy
  const packed = packAaveCommonReceipt(large)
  assert.ok(packed.rawBytes > 55_000 && packed.rawBytes < 64 * 1024)
  assert.deepEqual(unpackAaveCommonReceipt(packed), large)
  const tooLarge = structuredClone(large)
  tooLarge.logs[0].extraRpcField += entropy.slice(0, 12_000)
  assert.throws(() => packAaveCommonReceipt(tooLarge), /too_large/)
  const result = await recordAaveCommonDiagnostic({
    parent,
    parents: [parent],
    observedCondition: 'issue_record_guard_triggered',
    proposedBytes: 300_000,
    atUtc: '2026-10-01T00:20:00.000Z',
    recordedAtUtc: '2026-10-01T00:20:01.000Z',
    load: async () => [],
    append: async (row) => {
      assert.equal(row.eligibleCommitments.length, 2)
      assert.equal(row.proposedBytes, 300_000)
      assert.equal(row.observationStatus, 'operator_observed_unverified')
      assert.equal(row.verifiedCensor, false)
      assert.equal(row.observedCondition, 'issue_record_guard_triggered')
      return { sequence: 1 }
    },
  })
  assert.equal(result.status, 'operator_diagnostic_recorded')
})

test('dual-origin candidate recovery binds all screened eligible owners at pinned baseline', async () => {
  const { parent, receipts } = fixture()
  assert.equal(eligibleAaveCommonParent(parent, '2026-10-01T00:20:00.000Z'), true)
  const recovered = await recoverAaveCommonCandidates(
    parent,
    clients(receipts),
    '2026-10-01T00:20:00.000Z',
  )
  assert.deepEqual(
    recovered.map((x) => x.holder),
    [owner('1'), owner('2')],
  )
  assert.equal(
    recovered[0].source.primary.receiptDigest,
    parent.candidate.evidenceDoc.screenedCandidates[0].receiptDigest,
  )
  const changed = clients(receipts)
  changed[1].provider = 'https://third.example'
  await assert.rejects(
    () => recoverAaveCommonCandidates(parent, changed, '2026-10-01T00:20:00.000Z'),
    /origin/,
  )
  const mismatched = clients(receipts)
  const originalSecondary = mismatched[1].request
  mismatched[1].request = async (method, params) => {
    if (method !== 'eth_getTransactionReceipt') return originalSecondary(method, params)
    const receipt = structuredClone(await originalSecondary(method, params))
    receipt.logs[0].topics[2] = topic(owner('4'))
    return receipt
  }
  await assert.rejects(
    () => recoverAaveCommonCandidates(parent, mismatched, '2026-10-01T00:20:00.000Z'),
    /commitment_invalid/,
  )
})

test('selection uses least prior holder count and stable slot rank', () => {
  const candidates = [
    { screenedIndex: 0, holderCommitment: sha(`${destination}:${owner('1')}`) },
    { screenedIndex: 1, holderCommitment: sha(`${destination}:${owner('2')}`) },
  ]
  assert.equal(
    selectAaveCommonCandidate(candidates, [], 0).holderCommitment,
    candidates[0].holderCommitment,
  )
  assert.equal(
    selectAaveCommonCandidate(candidates, [], 1).holderCommitment,
    candidates[1].holderCommitment,
  )
  assert.equal(
    selectAaveCommonCandidate(
      candidates,
      [{ selectedHolderCommitment: candidates[0].holderCommitment }],
      0,
    ).holderCommitment,
    candidates[1].holderCommitment,
  )
})

test('immutable issue rejects altered candidate receipt, header and selected holder', async () => {
  const { parent, receipts } = fixture()
  const candidates = aaveCommonCandidateCensus(parent)
  const selectedCandidate = await recoverAaveCommonSelectedCandidate(
    parent,
    clients(receipts),
    candidates[0],
    '2026-10-01T00:20:00.000Z',
  )
  const row = {
    study: 'carry_public_aave_usdc_common_q_issue_v3',
    sequence: 1,
    previousSha256: null,
    v1IssueSequence: 1,
    v1IssueSha256: parent.sha256,
    marketKey: 'aaveV3Usdc',
    routeKey: parent.routeKey,
    destination: parent.destination,
    originalAsset: parent.originalAsset,
    issuedAtUtc: '2026-10-01T00:20:00.000Z',
    targets: parent.targets,
    originPrimary: primaryProvider,
    originSecondary: secondaryProvider,
    candidates,
    holder: selectedCandidate.holder,
    selectedHolderCommitment: candidates[0].holderCommitment,
    selectedCandidate,
    selectedScreenedIndex: 0,
    cases: Q.map((q) => ({
      ...q,
      status: 'unavailable',
      reason: 'holder_insufficient_coverage',
      measurement: null,
    })),
  }
  assert.throws(() => validateAaveCommonIssue(row, [parent], []), /measurement_invalid/)
  assert.throws(
    () => validateAaveCommonIssue({ ...row, holder: owner('2') }, [parent], []),
    /binding/,
  )
  assert.throws(
    () => validateAaveCommonIssue({ ...row, candidates: candidates.slice(1) }, [parent], []),
    /invalid/,
  )
  const alteredReceipt = structuredClone(row)
  const rawReceipt = unpackAaveCommonReceipt(
    alteredReceipt.selectedCandidate.source.primary.packedReceipt,
  )
  rawReceipt.logs[0].topics[2] = topic(owner('4'))
  alteredReceipt.selectedCandidate.source.primary.packedReceipt = packAaveCommonReceipt(rawReceipt)
  assert.throws(() => validateAaveCommonIssue(alteredReceipt, [parent], []), /receipt/)
  const alteredHeader = structuredClone(row)
  alteredHeader.selectedCandidate.source.secondary.headers.baseline.hash = hash('f')
  assert.throws(() => validateAaveCommonIssue(alteredHeader, [parent], []), /candidate/)
})

test('failed Q assay records an unverified diagnostic and leaves parent retryable', async () => {
  const { parent, receipts } = fixture('2000000')
  const observed = []
  const pair = clients(receipts, '2000000')
  const receiptCalls = []
  for (const client of pair) {
    const request = client.request.bind(client)
    client.request = async (method, params) => {
      if (method === 'eth_getTransactionReceipt') receiptCalls.push([client.provider, params[0]])
      return request(method, params)
    }
  }
  const options = {
    now: () => new Date('2026-10-01T00:20:00.000Z'),
    clients: pair,
    loadParents: async () => [parent],
    load: async () => [],
    measure: async () => {
      throw Error('aave_common_baseline_unavailable')
    },
    recordDiagnostic: async (row) => {
      observed.push(row)
      return { status: 'operator_diagnostic_recorded' }
    },
    append: async () => {
      throw Error('should_not_append')
    },
  }
  assert.equal((await issueAaveCommonQ(options)).status, 'operator_diagnostic_recorded')
  assert.equal((await issueAaveCommonQ(options)).status, 'operator_diagnostic_recorded')
  assert.equal(observed.length, 2)
  assert.equal(receiptCalls.length, 4) // One selected receipt per origin on each retry.
  assert.ok(receiptCalls.every(([, tx]) => tx === receipts[0].transactionHash))
  assert.deepEqual(
    observed.map((x) => [x.observedCondition, x.caseLabel, x.assetsRaw]),
    [
      ['baseline_assay_failed', 'fixed_1_usdc', '1000000'],
      ['baseline_assay_failed', 'fixed_1_usdc', '1000000'],
    ],
  )
  await assert.rejects(
    () =>
      issueAaveCommonQ({
        ...options,
        measure: async () => {
          throw Error('two_origin_disagreement')
        },
      }),
    /two_origin_disagreement/,
  )
})

test('verified generic 100k revert stays inconclusive while 1 and 1k are measured', async () => {
  const cases = await planAaveCommonCases(
    { assetBalanceRaw: '200000000000' },
    {},
    [],
    async (_parent, _candidate, assetsRaw) => ({
      baselineStatus: assetsRaw === '100000000000' ? 'inconclusive_covered_revert' : 'success',
    }),
  )
  assert.deepEqual(
    cases.map((x) => x.status),
    ['measured', 'measured', 'inconclusive'],
  )
  assert.equal(cases[2].reason, 'covered_revert_cause_unknown')
  assert.deepEqual(
    cases.map((x) => x.assetsRaw),
    Q.map((x) => x.assetsRaw),
  )
})

test('pinned success wins over sub-Q raw comparator; only sub-Q revert is holder unavailable', async () => {
  assert.equal(
    classifyAaveCommonBaseline(
      { routeKind: 'aave', simulationStatus: 'success', holderCoverageRaw: '999999' },
      '1000000',
    ),
    'success',
  )
  assert.equal(
    classifyAaveCommonBaseline(
      {
        routeKind: 'aave',
        simulationStatus: 'evm_revert',
        holderCoverageRaw: '999999',
        coveredRevert: false,
      },
      '1000000',
    ),
    'holder_insufficient_coverage',
  )
  const calls = []
  const cases = await planAaveCommonCases(
    { assetBalanceRaw: '999999' },
    {},
    [],
    async (_parent, _candidate, assetsRaw) => {
      calls.push(assetsRaw)
      return {
        baselineStatus: assetsRaw === '1000000' ? 'success' : 'holder_insufficient_coverage',
      }
    },
  )
  assert.deepEqual(
    calls,
    Q.map((x) => x.assetsRaw),
  )
  assert.deepEqual(
    cases.map((x) => x.status),
    ['measured', 'unavailable', 'unavailable'],
  )
  assert.equal(cases[1].reason, 'holder_insufficient_coverage')
})
