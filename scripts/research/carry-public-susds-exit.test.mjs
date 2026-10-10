import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  discoverSyncVaultIssuerCandidate,
  freezeSyncVaultQLadder,
} from '../lib/carry-exit-v2-sync-vault-issuer-prep.mjs'
import { slicedCandidateRequest } from './carry-public-direct-exit-issue.mjs'
import {
  ROUTE,
  rotatingSusdsOriginPairs,
  sha,
  verifySusdsMeasurement,
} from './carry-public-susds-exit-common.mjs'
import {
  appendSusdsIssue,
  buildSusdsIssue,
  issuePublicSusdsExit,
  validateSusdsIssue,
  verifySusdsIssues,
} from './carry-public-susds-exit-issue.mjs'
import {
  appendSusdsScore,
  buildSusdsScore,
  classifySusdsFutureOutcome,
  scorePublicSusdsExit,
  selectMatchingSusdsTarget,
  validateSusdsScore,
  verifySusdsScores,
} from './carry-public-susds-exit-score.mjs'

const HASH = `0x${'a'.repeat(64)}`
const PARENT = `0x${'b'.repeat(64)}`
const HOLDER = `0x${'c'.repeat(40)}`
const ISSUED = '2026-09-30T06:15:00.000Z'
const word = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`

function values(selected = true) {
  const baseline = {
    routeKey: ROUTE.routeKey,
    destination: ROUTE.destination,
    asset: ROUTE.asset,
    targetBlock: '26080000',
    targetHash: HASH,
    targetParentBlock: '26079999',
    targetParentHash: PARENT,
    targetBlockAt: '2026-09-30T06:05:00.000Z',
    targetObservedAt: '2026-09-30T06:10:00.000Z',
    totalAssetsRaw: '1000000000000000000000000',
    totalSupplyRaw: '999000000000000000000000',
    assetDecimals: 18,
    shareDecimals: 18,
    canonicalityEvidenceDoc: {
      schema: 'carry_exit_v2_headers_v1',
      provider: 'https://origin-one.example',
      source: 'carry_public_susds_exit_issue_v1',
      observedAt: '2026-09-30T06:10:00.000Z',
      targetHeader: { number: '26080000', hash: HASH },
    },
  }
  const ladder = freezeSyncVaultQLadder({
    totalAssetsRaw: baseline.totalAssetsRaw,
    selectedClaimRaw: selected ? '5000000000000000000000' : null,
  })
  const evidenceDoc = {
    schema: selected
      ? 'carry_exit_v2_sync_vault_candidate_v1'
      : 'carry_public_susds_candidate_unavailable_v1',
    chainId: '1',
    routeKey: ROUTE.routeKey,
    destination: ROUTE.destination,
    asset: ROUTE.asset,
    baselineBlock: baseline.targetBlock,
    baselineHash: HASH,
    selectedHolderCommitment: selected ? sha(`${ROUTE.destination}:${HOLDER}`) : null,
    selectedSharesRaw: selected ? '5000000000000000000000' : null,
    selectedClaimRaw: selected ? '5000000000000000000000' : null,
    unavailableReason: selected ? null : 'candidate_scan_unavailable',
    ladder,
    ...(selected
      ? {
          baselineState: {
            totalAssetsRaw: baseline.totalAssetsRaw,
            totalSupplyRaw: baseline.totalSupplyRaw,
            assetDecimals: 18,
            shareDecimals: 18,
          },
          screenedCandidates: [
            {
              holderCommitment: sha(`${ROUTE.destination}:${HOLDER}`),
              status: 'eligible_holder',
              sharesRaw: '5000000000000000000000',
              claimRaw: '5000000000000000000000',
              receiptDigest: 'd'.repeat(64),
            },
          ],
        }
      : {}),
  }
  const candidate = {
    holder: selected ? HOLDER : null,
    evidenceDoc,
    digest: sha(JSON.stringify(evidenceDoc)),
  }
  const baselineWitness = {
    provider: 'https://origin-two.example',
    block: baseline.targetBlock,
    hash: HASH,
    totalAssetsRaw: baseline.totalAssetsRaw,
    totalSupplyRaw: baseline.totalSupplyRaw,
    assetDecimals: 18,
    shareDecimals: 18,
    asset: ROUTE.asset,
    observedAtUtc: '2026-09-30T06:12:00.000Z',
  }
  return {
    baseline,
    baselineWitness,
    candidate,
    measurements: {},
    issuedAtUtc: ISSUED,
    sequence: 1,
    previousSha256: null,
  }
}

const issue = (selected = true) => buildSusdsIssue(values(selected))
const clients = [
  { provider: 'https://origin-one.example', request: async () => {}, send: async () => {} },
  { provider: 'https://origin-two.example', request: async () => {}, send: async () => {} },
]
const enoughDisk = () => ({ bavail: 1_000_000, bsize: 4096 })

test('freezes USDS→sUSDS original asset, share-based Q ladder and future horizons', () => {
  const row = issue()
  assert.equal(row.originalAsset, ROUTE.asset)
  assert.equal(row.destination, ROUTE.destination)
  assert.equal(row.qLabels.length, 6)
  assert.equal(row.cases.length, 6)
  assert.equal(row.targets[0].targetAtUtc, '2026-09-30T07:15:00.000Z')
  assert.equal(row.targets[0].captureDeadlineUtc, '2026-09-30T09:15:00.000Z')
  assert.ok(row.cases.some((entry) => entry.assetsRaw !== null))
  assert.ok(row.cases.every((entry) => entry.status !== 'measured'))
  const wrongQ = structuredClone(row)
  wrongQ.cases[0].assetsRaw = '1'
  assert.throws(() => validateSusdsIssue(wrongQ), /q_invalid/)
  const wrongAsset = structuredClone(row)
  wrongAsset.originalAsset = ROUTE.destination
  assert.throws(() => validateSusdsIssue(wrongAsset), /identity_invalid/)
  const noReceipt = structuredClone(row)
  noReceipt.candidate.evidenceDoc.screenedCandidates[0].receiptDigest = null
  noReceipt.candidate.evidenceSha256 = sha(JSON.stringify(noReceipt.candidate.evidenceDoc))
  assert.throws(() => validateSusdsIssue(noReceipt), /candidate_invalid/)
})

test('issuer uses only fresh baseline, receipt candidate and baseline proof; ten-block slices are bounded', async () => {
  const inputs = values()
  const seen = []
  const testClients = clients.map((entry) => ({
    ...entry,
    request: async (method) => (method === 'eth_getLogs' ? [] : undefined),
  }))
  const issued = await issuePublicSusdsExit({
    clients: testClients,
    now: () => new Date(ISSUED),
    load: async () => [],
    capture: async () => {
      seen.push('baseline')
      return inputs.baseline
    },
    witness: async () => {
      seen.push('witness')
      return inputs.baselineWitness
    },
    discover: async ({ request }) => {
      seen.push('candidate')
      await request('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x16' }])
      return inputs.candidate
    },
    measure: async () => {
      seen.push('baseline_measurement')
      throw Error('offline_probe_unavailable')
    },
    append: async (row) => {
      seen.push('sealed_issue')
      return row
    },
  })
  assert.equal(
    issued.cases.some((entry) => entry.status === 'measured'),
    false,
  )
  assert.equal(issued.candidate.holder, HOLDER)
  assert.ok(seen.includes('baseline_measurement'))
  assert.deepEqual(seen.at(-1), 'sealed_issue')
  assert.ok(seen.indexOf('baseline') < seen.indexOf('candidate'))
  const ranges = []
  const request = slicedCandidateRequest({
    request: async (method, params) => {
      assert.equal(method, 'eth_getLogs')
      ranges.push([BigInt(params[0].fromBlock), BigInt(params[0].toBlock)])
      return []
    },
  })
  await request('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x16' }])
  assert.deepEqual(ranges, [
    [1n, 10n],
    [11n, 20n],
    [21n, 22n],
  ])
})

test('the real sync-vault preparation evidence is accepted by the sUSDS issue validator', async () => {
  const baseline = values().baseline
  const transactionHash = `0x${'d'.repeat(64)}`
  const transfer = {
    address: ROUTE.destination,
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      word(0),
      word(HOLDER),
    ],
    data: word(100),
    blockNumber: `0x${BigInt(baseline.targetParentBlock).toString(16)}`,
    blockHash: PARENT,
    transactionHash,
    transactionIndex: '0x1',
    logIndex: '0x1',
    removed: false,
  }
  let logCalls = 0
  const request = async (method, params) => {
    if (method === 'eth_getLogs') {
      logCalls++
      const { fromBlock, toBlock } = params[0]
      assert.ok(BigInt(toBlock) - BigInt(fromBlock) < 10n)
      return BigInt(fromBlock) <= BigInt(transfer.blockNumber) &&
        BigInt(toBlock) >= BigInt(transfer.blockNumber)
        ? [transfer]
        : []
    }
    if (method === 'eth_getTransactionReceipt')
      return {
        transactionHash,
        blockHash: PARENT,
        blockNumber: transfer.blockNumber,
        status: '0x1',
        logs: [transfer],
      }
    if (method === 'eth_getBlockByNumber') {
      const block = BigInt(params[0])
      return {
        number: params[0],
        hash: block === BigInt(baseline.targetBlock) ? HASH : PARENT,
        parentHash: block === BigInt(baseline.targetBlock) ? PARENT : `0x${'e'.repeat(64)}`,
        timestamp: block === BigInt(baseline.targetBlock) ? '0x6a1b438c' : '0x6a1b4380',
      }
    }
    if (method === 'eth_getCode') return '0x'
    if (method === 'eth_call') {
      const selector = params[0].data.slice(0, 10)
      if (selector === '0x18160ddd') return word(baseline.totalSupplyRaw)
      if (selector === '0x01e1d114') return word(baseline.totalAssetsRaw)
      if (selector === '0x70a08231') return word(100)
      if (selector === '0x4cdad506') return word('5000000000000000000000')
    }
    throw Error('unexpected_offline_rpc')
  }
  const candidate = await discoverSyncVaultIssuerCandidate({
    baseline,
    request: slicedCandidateRequest({ request }),
  })
  assert.equal(candidate.holder, HOLDER)
  assert.equal(candidate.evidenceDoc.baselineBlock, baseline.targetBlock)
  assert.equal(candidate.evidenceDoc.screenedCandidates[0].status, 'eligible_holder')
  assert.ok(logCalls >= 400)
  const row = buildSusdsIssue({ ...values(), candidate })
  assert.equal(validateSusdsIssue(row).sha256, row.sha256)
})

test('origin rotation reaches a later primary and bounds all calls', async () => {
  let ms = 0
  const urls = ['https://bad0.example', 'https://bad1.example', 'https://good2.example']
  const pairs = rotatingSusdsOriginPairs(
    urls,
    (chosen) =>
      chosen.map((url) => ({
        url,
        provider: url,
        request: async () => 'ok',
        send: async () => 'ok',
      })),
    () => ms,
  )
  assert.deepEqual(
    pairs.slice(0, 3).map((pair) => pair[0].provider),
    urls,
  )
  assert.equal(pairs.length, 6)
  assert.equal(await pairs[2][0].request('eth_chainId', []), 'ok')
  ms = 8 * 60_000
  await assert.rejects(pairs[2][0].request('eth_chainId', []), /budget_exhausted/)
})

test('issuer rotates around a failing primary and secondary before sealing one issue', async () => {
  const inputs = values()
  const providers = ['https://bad0.example', 'https://bad1.example', 'https://good2.example']
  const pairs = rotatingSusdsOriginPairs(providers, (chosen) =>
    chosen.map((url) => ({
      url,
      provider: url,
      request: async () => {},
      send: async () => {},
    })),
  )
  const attempts = []
  const row = await issuePublicSusdsExit({
    originPairs: pairs,
    now: () => new Date(ISSUED),
    load: async () => [],
    capture: async ({ provider }) => {
      attempts.push(provider)
      if (provider !== providers[2]) throw Error('rate_limited')
      return {
        ...inputs.baseline,
        canonicalityEvidenceDoc: { ...inputs.baseline.canonicalityEvidenceDoc, provider },
      }
    },
    witness: async (_baseline, secondary) => {
      if (secondary.provider === providers[0]) throw Error('origin_unavailable')
      return { ...inputs.baselineWitness, provider: secondary.provider }
    },
    discover: async () => inputs.candidate,
    measure: async () => {
      throw Error('offline_probe_unavailable')
    },
    append: async (sealed) => sealed,
  })
  assert.deepEqual(attempts.slice(0, 3), providers)
  assert.equal(row.baseline.canonicalityEvidenceDoc.provider, providers[2])
  assert.equal(row.baselineWitness.provider, providers[1])
  assert.equal(validateSusdsIssue(row).sha256, row.sha256)
})

test('issuer and score ledgers are crash-safe and hash-chain verified', async () => {
  const root = await mkdtemp(join(tmpdir(), 'public-susds-ledger-'))
  const issueOut = join(root, 'issues')
  const scoreOut = join(root, 'scores')
  try {
    const row = issue()
    await assert.rejects(
      appendSusdsIssue(row, issueOut, enoughDisk, {
        linkFile: async () => {
          throw Error('crash_before_link')
        },
      }),
      /crash_before_link/,
    )
    assert.deepEqual(await verifySusdsIssues(issueOut), [])
    await writeFile(join(issueOut, '.susds-stale.tmp'), 'partial')
    await appendSusdsIssue(row, issueOut, enoughDisk)
    assert.equal((await verifySusdsIssues(issueOut)).length, 1)
    const score = buildSusdsScore({
      issue: row,
      issues: [row],
      horizonHours: 1,
      target: null,
      measurements: {},
      scoredAtUtc: '2026-09-30T09:16:00.000Z',
      sequence: 1,
      previousSha256: null,
    })
    assert.throws(() => validateSusdsScore({ ...score, onTime: true }, [row]), /clock_invalid/)
    await assert.rejects(
      appendSusdsScore(score, scoreOut, issueOut, enoughDisk, {
        linkFile: async () => {
          throw Error('crash_before_score_link')
        },
      }),
      /crash_before_score_link/,
    )
    assert.deepEqual(await verifySusdsScores(scoreOut, issueOut), [])
    await appendSusdsScore(score, scoreOut, issueOut, enoughDisk)
    assert.equal((await verifySusdsScores(scoreOut, issueOut)).length, 1)
    const path = join(scoreOut, '00000001.json')
    const tampered = JSON.parse(await readFile(path, 'utf8'))
    tampered.originalAsset = ROUTE.destination
    await writeFile(path, `${JSON.stringify(tampered)}\n`)
    await assert.rejects(verifySusdsScores(scoreOut, issueOut), /chain_invalid/)
    assert.ok((await readdir(issueOut)).includes('.susds-stale.tmp'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('future selector requires two origins to agree on the same first finalized block', async () => {
  const row = issue()
  let calls = 0
  await assert.rejects(
    selectMatchingSusdsTarget({
      issue: row,
      plan: row.targets[0],
      clients,
      select: async () => ({
        targetBlock: '26080300',
        targetHash: `0x${String(++calls).padStart(64, '0')}`,
        targetBlockAt: '2026-09-30T07:15:00.000Z',
        targetParentHash: HASH,
        targetParentBlockAt: '2026-09-30T07:14:48.000Z',
      }),
    }),
    /origin_disagreement/,
  )
})

test('scorer prefers the issued origin pair then retries another independent pair', async () => {
  const row = issue()
  row.cases[0] = {
    ...row.cases[0],
    status: 'measured',
    reason: null,
    measurement: { baselineStatus: 'success' },
  }
  const alternate = [
    { provider: 'https://alternate-one.example', request: async () => {}, send: async () => {} },
    { provider: 'https://alternate-two.example', request: async () => {}, send: async () => {} },
  ]
  const calls = []
  let appended = false
  const result = await scorePublicSusdsExit({
    issueSequence: 1,
    horizonHours: 1,
    originPairs: [alternate, clients],
    now: () => new Date('2026-09-30T07:30:00.000Z'),
    loadIssues: async () => [row],
    loadScores: async () => [],
    select: async ({ provider }) => {
      calls.push(provider)
      if (provider === clients[0].provider) throw Error('origin_rate_limited')
      return {
        targetBlock: '26080300',
        targetHash: HASH,
        targetBlockAt: '2026-09-30T07:15:00.000Z',
        targetParentHash: PARENT,
        targetParentBlockAt: '2026-09-30T07:14:48.000Z',
      }
    },
    measure: async () => {
      throw Error('replay_unavailable')
    },
    append: async () => {
      appended = true
    },
  })
  assert.deepEqual(calls, [clients[0].provider, alternate[0].provider, alternate[1].provider])
  assert.equal(result.status, 'retry_replay_unavailable')
  assert.equal(appended, false)
})

test('score does no future RPC before target and censors late/over-deadline captures', async () => {
  const row = issue()
  row.cases[0] = {
    ...row.cases[0],
    status: 'measured',
    reason: null,
    measurement: { baselineStatus: 'success' },
  }
  let rpc = 0
  const common = {
    issueSequence: 1,
    horizonHours: 1,
    clients,
    loadIssues: async () => [row],
    loadScores: async () => [],
    select: async () => {
      rpc++
      throw Error('future_rpc_forbidden')
    },
    measure: async () => {
      rpc++
      throw Error('future_rpc_forbidden')
    },
    append: async (score) => ({
      sequence: score.sequence,
      cases: score.cases,
      target: score.target,
    }),
  }
  assert.equal(
    (await scorePublicSusdsExit({ ...common, now: () => new Date('2026-09-30T07:14:59.000Z') }))
      .status,
    'not_due',
  )
  assert.equal(rpc, 0)
  const late = await scorePublicSusdsExit({
    ...common,
    now: () => new Date('2026-09-30T09:16:00.000Z'),
  })
  assert.equal(rpc, 0)
  assert.equal(late.status, 'scored')
  assert.equal(late.target, null)
  assert.equal(late.cases[0].status, 'unavailable')
  assert.equal(late.cases[0].reason, 'capture_window_missed')
  assert.throws(
    () =>
      buildSusdsScore({
        issue: row,
        issues: [row],
        horizonHours: 1,
        target: {},
        measurements: { [row.cases[0].label]: { simulationStatus: 'success' } },
        scoredAtUtc: '2026-09-30T09:16:00.000Z',
        sequence: 1,
        previousSha256: null,
      }),
    /late_measurement/,
  )
})

test('target selection crossing the deadline is discarded before case capture', async () => {
  const row = issue()
  row.cases[0] = {
    ...row.cases[0],
    status: 'measured',
    reason: null,
    measurement: { baselineStatus: 'success' },
  }
  let clock = 0
  const now = () => new Date(++clock < 4 ? '2026-09-30T07:30:00.000Z' : '2026-09-30T09:16:00.000Z')
  let selected = 0
  let measured = 0
  const result = await scorePublicSusdsExit({
    issueSequence: 1,
    horizonHours: 1,
    clients,
    now,
    loadIssues: async () => [row],
    loadScores: async () => [],
    select: async () => {
      selected++
      return {
        targetBlock: '26080300',
        targetHash: HASH,
        targetBlockAt: '2026-09-30T07:15:00.000Z',
        targetParentHash: PARENT,
        targetParentBlockAt: '2026-09-30T07:14:48.000Z',
      }
    },
    measure: async () => {
      measured++
      throw Error('should_not_measure')
    },
    append: async (score) => ({ target: score.target, cases: score.cases }),
  })
  assert.equal(selected, 2)
  assert.equal(measured, 0)
  assert.equal(result.target, null)
  assert.equal(result.cases[0].status, 'unavailable')
})

test('fabricated exact-Q evidence is rejected despite a matching local digest', () => {
  const fake = {
    verificationStatus: 'verified',
    identityEvidence: {
      holder: HOLDER,
      asset: ROUTE.asset,
      destination: ROUTE.destination,
      blockNumber: '26080300',
      blockHash: HASH,
      source: 'carry_public_susds_exit_score_v1',
    },
    replayEvidenceDoc: {
      blockNumber: '26080300',
      blockHash: HASH,
      observedAt: '2026-09-30T07:30:00.000Z',
      headers: {
        primary: { before: { target: { number: '0x18dd2cc', hash: HASH, timestamp: '0x0' } } },
      },
    },
  }
  assert.throws(
    () =>
      verifySusdsMeasurement({
        holder: HOLDER,
        assetsRaw: '100',
        blockNumber: '26080300',
        blockHash: HASH,
        blockAtUtc: '2026-09-30T07:15:00.000Z',
        source: 'carry_public_susds_exit_score_v1',
        measurement: {
          simulationStatus: 'success',
          evidence: fake,
          evidenceSha256: sha(JSON.stringify(fake)),
        },
        beforeAtUtc: '2026-09-30T07:15:00.000Z',
        afterAtUtc: '2026-09-30T07:30:00.000Z',
      }),
    /measurement_header_invalid/,
  )
})

test('sUSDS outcomes distinguish simulation, unknown revert cause and preview gap', () => {
  const base = { routeKind: 'susds', holderCoverageRaw: '10', requiredCoverageRaw: '5' }
  assert.equal(
    classifySusdsFutureOutcome({ ...base, simulationStatus: 'success', actualConsumedRaw: '5' }),
    'simulated_withdraw_success',
  )
  assert.equal(
    classifySusdsFutureOutcome({ ...base, simulationStatus: 'evm_revert', coveredRevert: true }),
    'withdraw_revert_cause_unknown',
  )
  assert.equal(
    classifySusdsFutureOutcome({
      ...base,
      simulationStatus: 'evm_revert',
      coveredRevert: false,
      requiredCoverageRaw: '11',
    }),
    'preview_share_gap',
  )
  assert.equal(
    classifySusdsFutureOutcome({
      ...base,
      simulationStatus: 'evm_revert',
      coveredRevert: false,
      holderCoverageRaw: '0',
    }),
    'holder_shares_zero',
  )
  assert.throws(
    () =>
      classifySusdsFutureOutcome({ ...base, simulationStatus: 'success', actualConsumedRaw: null }),
    /burn_missing/,
  )
})
