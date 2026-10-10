import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, parseAbi } from 'viem'

import { freezeSyncVaultQLadder } from '../lib/carry-exit-v2-sync-vault-issuer-prep.mjs'
import {
  ROUTE,
  appendNumbered,
  measureInitiation,
  readNumbered,
  rotatingSusdeOriginPairs,
  seal,
  sha,
  verifyMeasurement,
} from './susde-public-initiation-common.mjs'
import {
  appendSusdeIssue,
  buildSusdeIssue,
  discoverCandidate,
  issuePublicSusdeInitiation,
  validateSusdeIssue,
} from './susde-public-initiation-issue.mjs'
import {
  appendSusdeScore,
  buildSusdeScore,
  scorePublicSusdeInitiation,
  validateSusdeScore,
} from './susde-public-initiation-score.mjs'

const abi = parseAbi([
  'function asset() view returns (address)',
  'function silo() view returns (address)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
  'function cooldownDuration() view returns (uint24)',
  'function cooldowns(address) view returns (uint104,uint256)',
  'function cooldownAssets(uint256) returns (uint256)',
])
const legacyCooldownAbi = parseAbi(['function cooldownAssets(uint256,address) returns (uint256)'])
const holder = '0x1111111111111111111111111111111111111111'
const block = {
  number: '100',
  hash: `0x${'a'.repeat(64)}`,
  parentHash: `0x${'b'.repeat(64)}`,
  at: '2026-09-30T06:00:00.000Z',
}
const observed = '2026-09-30T06:00:20.000Z'

function clients({
  pending = 5n,
  max = 100n,
  shares = 100n,
  revert = false,
  holderCode = '0x',
} = {}) {
  const make = (provider) => ({
    provider,
    async request(method, params) {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber')
        return {
          number: '0x64',
          hash: block.hash,
          parentHash: block.parentHash,
          timestamp: `0x${Math.floor(Date.parse(block.at) / 1000).toString(16)}`,
        }
      if (method === 'eth_getCode') return params[0] === holder ? holderCode : '0x6000'
      throw Error('unexpected_request')
    },
    async send(envelope) {
      assert.equal(envelope.method, 'eth_call')
      assert.deepEqual(envelope.params[1], { blockHash: block.hash, requireCanonical: true })
      const { functionName, args } = decodeFunctionData({ abi, data: envelope.params[0].data })
      const value = {
        asset: ROUTE.asset,
        silo: ROUTE.silo,
        decimals: 18,
        balanceOf: shares,
        totalAssets: 1_000_000n,
        totalSupply: 1_000_000n,
        maxWithdraw: max,
        previewWithdraw: BigInt(args?.[0] ?? 0),
        cooldownDuration: 86_400,
        cooldowns: [1_800_000_000n, pending],
        cooldownAssets: BigInt(args?.[0] ?? 0),
      }[functionName]
      if (functionName === 'cooldownAssets') {
        assert.equal(envelope.params[0].from, holder)
        assert.deepEqual(args, [BigInt(args[0])])
        if (revert)
          return {
            jsonrpc: '2.0',
            id: 1,
            error: {
              code: -32000,
              message: typeof revert === 'string' ? revert : 'execution reverted',
            },
          }
      }
      return {
        jsonrpc: '2.0',
        id: 1,
        result: encodeFunctionResult({ abi, functionName, result: value }),
      }
    },
  })
  return [make('https://one.example'), make('https://two.example')]
}

test('same-holder cooldownAssets success is initiation only, with conditional reset', async () => {
  const pair = clients()
  const measurement = await measureInitiation({
    pair,
    block,
    holder,
    assetsRaw: '10',
    now: () => new Date(observed),
  })
  assert.equal(measurement.status, 'simulated_initiation_success')
  assert.equal(measurement.evidence.schema, 'susde_public_cooldown_initiation_measurement_v2')
  assert.equal(measurement.evidence.origins[0].callData.slice(0, 10), '0xcdac52ed')
  assert.equal(measurement.sharesBurnedRaw, '10')
  assert.equal(measurement.wouldResetPending, true)
  assert.equal(measurement.hypotheticalEarliestEligibilityUtc, '2026-10-01T06:00:00.000Z')
  verifyMeasurement(measurement, {
    block,
    holder,
    assetsRaw: '10',
    earliestUtc: block.at,
    latestUtc: observed,
  })
  assert.throws(
    () =>
      verifyMeasurement(measurement, {
        block,
        holder,
        assetsRaw: '11',
        earliestUtc: block.at,
        latestUtc: observed,
      }),
    /binding/,
  )
})

test('V2 accepts exact delegated EOA code and rejects ordinary or malformed holder code', async () => {
  const delegatedCode = `0xef0100${'a'.repeat(40)}`
  const measurement = await measureInitiation({
    pair: clients({ holderCode: delegatedCode.toUpperCase().replace('0X', '0x') }),
    block,
    holder,
    assetsRaw: '10',
    now: () => new Date(observed),
  })
  assert.equal(measurement.evidence.origins[0].ownerCode, delegatedCode)
  assert.equal(
    verifyMeasurement(measurement, {
      block,
      holder,
      assetsRaw: '10',
      earliestUtc: block.at,
      latestUtc: observed,
    }).selectorCompatibility,
    'deployed_selector',
  )
  const context = { block, holder, assetsRaw: '10', earliestUtc: block.at, latestUtc: observed }
  for (const ownerCode of ['0x6000', `0xef0100${'a'.repeat(39)}`]) {
    const forged = structuredClone(measurement)
    forged.evidence.origins.forEach((origin) => {
      origin.ownerCode = ownerCode
    })
    forged.evidenceSha256 = sha(JSON.stringify(forged.evidence))
    assert.throws(() => verifyMeasurement(forged, context), /state_invalid/)
  }
  for (const holderCode of ['0x6000', `0xef0100${'a'.repeat(39)}`, null]) {
    await assert.rejects(
      measureInitiation({
        pair: clients({ holderCode }),
        block,
        holder,
        assetsRaw: '10',
        now: () => new Date(observed),
      }),
      /identity_or_eoa_invalid/,
    )
  }
  const legacy = asLegacyMeasurement(measurement)
  assert.throws(
    () =>
      verifyMeasurement(legacy, {
        block,
        holder,
        assetsRaw: '10',
        earliestUtc: block.at,
        latestUtc: observed,
        allowLegacy: true,
      }),
    /state_invalid/,
  )
})

function asLegacyMeasurement(measurement, assetsRaw = '10') {
  const legacy = structuredClone(measurement)
  legacy.evidence.schema = 'susde_public_cooldown_initiation_measurement_v1'
  for (const origin of legacy.evidence.origins)
    origin.callData = encodeFunctionData({
      abi: legacyCooldownAbi,
      functionName: 'cooldownAssets',
      args: [BigInt(assetsRaw), holder],
    })
  legacy.evidenceSha256 = sha(JSON.stringify(legacy.evidence))
  return legacy
}

test('legacy two-argument measurement verifies only as archival, never deployed forceability', async () => {
  const current = await measureInitiation({
    pair: clients(),
    block,
    holder,
    assetsRaw: '10',
    now: () => new Date(observed),
  })
  const legacy = asLegacyMeasurement(current)
  assert.equal(legacy.evidence.origins[0].callData.slice(0, 10), '0xd50655b0')
  const context = { block, holder, assetsRaw: '10', earliestUtc: block.at, latestUtc: observed }
  assert.throws(() => verifyMeasurement(legacy, context), /binding_invalid/)
  assert.equal(
    verifyMeasurement(legacy, { ...context, allowLegacy: true }).selectorCompatibility,
    'legacy_absent_selector',
  )
  const wrongCall = structuredClone(legacy)
  wrongCall.evidence.origins.forEach((origin) => {
    origin.callData = current.evidence.origins[0].callData
  })
  wrongCall.evidenceSha256 = sha(JSON.stringify(wrongCall.evidence))
  assert.throws(
    () => verifyMeasurement(wrongCall, { ...context, allowLegacy: true }),
    /raw_binding/,
  )
})

test('covered revert remains unknown cause, never maxWithdraw-derived success', async () => {
  const measurement = await measureInitiation({
    pair: clients({ revert: true }),
    block,
    holder,
    assetsRaw: '10',
    now: () => new Date(observed),
  })
  assert.equal(measurement.status, 'initiation_revert_cause_unknown')
  assert.equal(measurement.coveredRevert, true)
  assert.equal(measurement.hypotheticalEarliestEligibilityUtc, null)
  verifyMeasurement(measurement, {
    block,
    holder,
    assetsRaw: '10',
    earliestUtc: block.at,
    latestUtc: observed,
  })
})

test('reason-bearing EVM revert is measured; gas failure is not an exit outcome', async () => {
  const measurement = await measureInitiation({
    pair: clients({ revert: 'execution reverted: cooldown active' }),
    block,
    holder,
    assetsRaw: '10',
    now: () => new Date(observed),
  })
  assert.equal(measurement.status, 'initiation_revert_cause_unknown')
  await assert.rejects(
    measureInitiation({
      pair: clients({ revert: 'execution reverted: gas required exceeds allowance' }),
      block,
      holder,
      assetsRaw: '10',
      now: () => new Date(observed),
    }),
    /rpc_unavailable/,
  )
})

test('resealing a changed Q call or pinned read cannot forge a measurement', async () => {
  const measurement = await measureInitiation({
    pair: clients(),
    block,
    holder,
    assetsRaw: '10',
    now: () => new Date(observed),
  })
  const forged = structuredClone(measurement)
  forged.evidence.origins[0].callData = forged.evidence.origins[0].callData.replace(/.$/, 'b')
  forged.evidence.origins[1].callData = forged.evidence.origins[0].callData
  forged.evidenceSha256 = sha(JSON.stringify(forged.evidence))
  assert.throws(
    () =>
      verifyMeasurement(forged, {
        block,
        holder,
        assetsRaw: '10',
        earliestUtc: block.at,
        latestUtc: observed,
      }),
    /raw_binding/,
  )
  const forgedRead = structuredClone(measurement)
  forgedRead.evidence.origins[0].reads.preview = '11'
  forgedRead.evidence.origins[1].reads.preview = '11'
  forgedRead.evidenceSha256 = sha(JSON.stringify(forgedRead.evidence))
  assert.throws(
    () =>
      verifyMeasurement(forgedRead, {
        block,
        holder,
        assetsRaw: '10',
        earliestUtc: block.at,
        latestUtc: observed,
      }),
    /raw_read/,
  )
})

test('two-origin state disagreement fails closed', async () => {
  const pair = clients()
  const original = pair[1].send
  pair[1].send = async (envelope) => {
    const answer = await original(envelope)
    const { functionName } = decodeFunctionData({ abi, data: envelope.params[0].data })
    if (functionName === 'maxWithdraw')
      answer.result = encodeFunctionResult({ abi, functionName, result: 9n })
    return answer
  }
  await assert.rejects(
    measureInitiation({ pair, block, holder, assetsRaw: '10', now: () => new Date(observed) }),
    /state_disagreement/,
  )
})

test('origin rotation is bounded and skips same-origin pairs', () => {
  const pairs = rotatingSusdeOriginPairs(
    ['https://a.example', 'https://b.example', 'https://c.example'],
    (urls) => urls.map((url) => ({ provider: url, request() {}, send() {} })),
    () => 0,
  )
  assert.equal(pairs.length, 6)
  assert.ok(pairs.every(([left, right]) => left.provider !== right.provider))
})

test('atomic ledger rejects duplicate sequence and leaves canonical first file', async () => {
  const out = await mkdtemp(join(tmpdir(), 'susde-ledger-'))
  try {
    const row = seal({ sequence: 1, previousSha256: null, value: 'a' })
    const verify = readNumbered
    await appendNumbered(row, out, verify, () => ({ bavail: 2_000_000, bsize: 4096 }))
    await assert.rejects(
      appendNumbered(row, out, verify, () => ({ bavail: 2_000_000, bsize: 4096 })),
      /ledger_changed/,
    )
    assert.deepEqual(
      (await readdir(out)).filter((name) => name.endsWith('.json')),
      ['00000001.json'],
    )
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

function candidatePair({
  owners,
  baselineAt = '2026-09-30T06:00:00.000Z',
  undefinedCode = [],
  secondOriginMissingLastLog = false,
}) {
  const discoveryHash = `0x${'c'.repeat(64)}`
  const baseline = { number: '1000', hash: block.hash, at: baselineAt }
  const logs = owners.map((owner, index) => ({
    address: ROUTE.vault,
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      `0x${'0'.repeat(24)}${holder.slice(2)}`,
      `0x${'0'.repeat(24)}${owner.slice(2)}`,
    ],
    data: `0x${BigInt(owners.length - index)
      .toString(16)
      .padStart(64, '0')}`,
    blockHash: discoveryHash,
    transactionHash: `0x${(index + 1).toString(16).padStart(64, '0')}`,
    blockNumber: '0x3e6',
    logIndex: `0x${index.toString(16)}`,
  }))
  const make = (provider) => ({
    provider,
    async request(method, params) {
      if (method === 'eth_getLogs') {
        const range = params[0]
        if (BigInt(range.fromBlock) > 998n || BigInt(range.toBlock) < 998n) return []
        return secondOriginMissingLastLog && provider === 'https://two.example'
          ? logs.slice(0, -1)
          : logs
      }
      if (method === 'eth_getBlockByNumber')
        return {
          number: '0x3e6',
          hash: discoveryHash,
          parentHash: `0x${'d'.repeat(64)}`,
          timestamp: `0x${Math.floor(Date.parse(baselineAt) / 1000).toString(16)}`,
        }
      if (method === 'eth_getTransactionReceipt') {
        const log = logs.find((entry) => entry.transactionHash === params[0])
        return {
          status: '0x1',
          transactionHash: log.transactionHash,
          blockHash: log.blockHash,
          blockNumber: log.blockNumber,
          logs: [log],
        }
      }
      if (method === 'eth_getCode') {
        const candidate = params[0]
        if (undefinedCode.includes(candidate)) return undefined
        return candidate.endsWith('f') ? '0x' : '0x6000'
      }
      if (method === 'eth_call') {
        assert.deepEqual(params[1], { blockHash: baseline.hash, requireCanonical: true })
        return `0x${'64'.padStart(64, '0')}`
      }
      throw Error(`unexpected ${method}`)
    },
  })
  return { baseline, pair: [make('https://one.example'), make('https://two.example')] }
}

test('candidate search passes top-eight contracts and records a missing code proof as rejected', async () => {
  const contracts = Array.from(
    { length: 10 },
    (_, i) => `0x${(i + 2).toString(16).padStart(40, '0')}`,
  )
  const missing = `0x${'e'.padStart(40, '0')}`
  const eoa = `0x${'f'.padStart(40, '0')}`
  const { pair, baseline } = candidatePair({
    owners: [...contracts, missing, eoa],
    undefinedCode: [missing],
  })
  const candidate = await discoverCandidate(pair, baseline)
  assert.equal(candidate.holder, eoa)
  assert.equal(candidate.evidence.schema, 'susde_public_receipt_screen_v2')
  assert.equal(candidate.evidence.windowStart, '488')
  assert.equal(candidate.evidence.rankedDistinctCount, 12)
  assert.equal(candidate.evidence.attemptedCount, 12)
  assert.equal(candidate.evidence.unscreenedDistinctCount, 0)
  assert.equal(candidate.evidence.rejectionCounts.not_proven_eoa, 11)
  assert.equal(candidate.evidence.screened.length, 12)
  assert.equal(candidate.evidence.screened[10].status, 'not_proven_eoa')
  assert.equal(candidate.evidence.screened[11].status, 'selected')
  assert.equal(candidate.evidence.screened[11].proof.origins.length, 2)
  assert.equal(candidate.evidence.rawLogs.length, 12)
  assert.deepEqual(candidate.evidence.selectionAudit, {
    rankingFromStoredTwoOriginLogResponses: true,
    rejectionRpcEvidenceRetained: false,
    chainCompletenessProved: false,
  })
})

test('candidate discovery fails closed when independent origin omits a Transfer log', async () => {
  const eoa = `0x${'f'.padStart(40, '0')}`
  const { pair, baseline } = candidatePair({
    owners: [eoa],
    secondOriginMissingLastLog: true,
  })
  await assert.rejects(discoverCandidate(pair, baseline), /log_origin_disagreement/)
})

test('baseline slot rotates among pre-screened eligible holders and selected receipt proof validates', async () => {
  const eoaA = `0x${'f'.padStart(40, '0')}`
  const eoaB = `0x${'ff'.padStart(40, '0')}`
  const early = candidatePair({ owners: [eoaA, eoaB] })
  const late = candidatePair({
    owners: [eoaA, eoaB],
    baselineAt: '2026-09-30T06:15:00.000Z',
  })
  const first = await discoverCandidate(early.pair, early.baseline)
  const second = await discoverCandidate(late.pair, late.baseline)
  assert.notEqual(first.holder, second.holder)
  assert.equal(first.evidence.selectionIndex, first.evidence.selectionSlot % 2)
  assert.equal(second.evidence.selectionIndex, second.evidence.selectionSlot % 2)
  const baseline = {
    block: { ...block, number: early.baseline.number, at: early.baseline.at },
    observedAtUtc: '2026-09-30T06:00:20.000Z',
    totalAssetsRaw: '1000000',
    totalSupplyRaw: '1000000',
    witnesses: early.pair.map((client) => ({
      provider: client.provider,
      observed: { ...block, number: early.baseline.number, at: early.baseline.at },
      finalized: { number: early.baseline.number, hash: early.baseline.hash },
      observedAtUtc: '2026-09-30T06:00:20.000Z',
    })),
  }
  const issue = buildSusdeIssue({
    baseline,
    candidate: first,
    cases: freezeSyncVaultQLadder({
      totalAssetsRaw: baseline.totalAssetsRaw,
      selectedClaimRaw: first.selectedClaimRaw,
    }).labels.map((row) => ({
      label: row.label,
      assetsRaw: row.assetsRaw,
      status: 'unavailable',
      reason: row.assetsRaw === null ? 'omitted_duplicate_or_zero' : 'rpc_unavailable',
      measurement: null,
    })),
    issuedAtUtc: '2026-09-30T06:00:20.000Z',
    sequence: 1,
    previousSha256: null,
  })
  assert.equal(validateSusdeIssue(issue).sha256, issue.sha256)
  const forged = structuredClone(issue)
  const selected = forged.candidate.evidence.screened.find((row) => row.status === 'selected')
  selected.proof.origins[1].code = undefined
  const { sha256: _seal, ...body } = forged
  forged.sha256 = sha(JSON.stringify(body))
  assert.throws(() => validateSusdeIssue(forged), /selection_proof_invalid/)

  const digestForgery = structuredClone(issue)
  const digestSelected = digestForgery.candidate.evidence.screened.find(
    (row) => row.status === 'selected',
  )
  digestSelected.proof.origins[0].receiptSha256 = 'f'.repeat(64)
  const { sha256: _digestSeal, ...digestBody } = digestForgery
  digestForgery.sha256 = sha(JSON.stringify(digestBody))
  assert.throws(() => validateSusdeIssue(digestForgery), /selection_proof_invalid/)

  const rankForgery = structuredClone(issue)
  rankForgery.candidate.evidence.screened.reverse()
  const { sha256: _rankSeal, ...rankBody } = rankForgery
  rankForgery.sha256 = sha(JSON.stringify(rankBody))
  assert.throws(() => validateSusdeIssue(rankForgery), /screen_invalid/)

  const countForgery = structuredClone(issue)
  countForgery.candidate.evidence.logCount += 1
  const { sha256: _countSeal, ...countBody } = countForgery
  countForgery.sha256 = sha(JSON.stringify(countBody))
  assert.throws(() => validateSusdeIssue(countForgery), /screen_invalid/)

  for (const tamper of ['sender', 'block_hash']) {
    // A persisted JSON record has no shared object identities between proof and raw log slices.
    const contradictsRawLog = JSON.parse(JSON.stringify(issue))
    const selectedRow = contradictsRawLog.candidate.evidence.screened.find(
      (row) => row.status === 'selected',
    )
    if (tamper === 'sender') {
      const forgedSender = `0x${'e'.repeat(64)}`
      selectedRow.proof.transfer.topics[1] = forgedSender
      for (const origin of selectedRow.proof.origins) {
        origin.receipt.selectedLog.topics[1] = forgedSender
        origin.receiptSha256 = sha(JSON.stringify(origin.receipt))
      }
    } else {
      const forgedHash = `0x${'e'.repeat(64)}`
      selectedRow.proof.discoveryHash = forgedHash
      selectedRow.proof.transfer.blockHash = forgedHash
      for (const origin of selectedRow.proof.origins) {
        origin.discoveryHash = forgedHash
        origin.receipt.blockHash = forgedHash
        origin.receipt.selectedLog.blockHash = forgedHash
        origin.receiptSha256 = sha(JSON.stringify(origin.receipt))
      }
    }
    const { sha256: _contradictorySeal, ...contradictoryBody } = contradictsRawLog
    contradictsRawLog.sha256 = sha(JSON.stringify(contradictoryBody))
    assert.throws(() => validateSusdeIssue(contradictsRawLog), /selection_proof_invalid/)
  }
})

test('issuer freezes six Q labels with exact baseline measurement before H1', async () => {
  const commitment = sha(`${ROUTE.vault}:${holder}`)
  let issued
  const result = await issuePublicSusdeInitiation({
    originPairs: [clients()],
    now: () => new Date(observed),
    load: async () => [],
    discover: async () => ({
      holder,
      selectedSharesRaw: '100',
      selectedClaimRaw: '100',
      evidence: {
        schema: 'susde_public_receipt_screen_v1',
        windowStart: '1',
        windowEnd: '99',
        logCount: 1,
        screened: [{ holderCommitment: commitment, sharesRaw: '100', claimRaw: '100' }],
        selectedHolderCommitment: commitment,
        selectionRule: 'largest_incoming_transfer_first_positive_share_receipt_verified_eoa',
      },
    }),
    append: async (row) => {
      issued = row
      validateSusdeIssue(row)
      return { sequence: row.sequence, sha256: row.sha256 }
    },
  })
  assert.equal(result.sequence, 1)
  assert.equal(issued.cases.length, 6)
  assert.equal(issued.cases[0].measurement.status, 'simulated_initiation_success')
  assert.equal(issued.study, 'susde_public_hypothetical_initiation_issue_v2')
  assert.equal(issued.targets[0].targetAtUtc, '2026-09-30T07:00:20.000Z')
  assert.equal(issued.targets[0].captureDeadlineUtc, '2026-09-30T09:00:20.000Z')
  const downgradedFuture = {
    ...issued,
    sequence: 2,
    previousSha256: issued.sha256,
  }
  const { sha256: _downgradeSeal, ...downgradedBody } = downgradedFuture
  downgradedFuture.sha256 = sha(JSON.stringify(downgradedBody))
  assert.throws(() => validateSusdeIssue(downgradedFuture), /schema_downgrade/)
  assert.throws(
    () =>
      validateSusdeIssue({
        ...issued,
        cases: issued.cases.map((row, i) => (i === 0 ? { ...row, assetsRaw: '11' } : row)),
      }),
    /q_invalid/,
  )
  const legacy = structuredClone(issued)
  legacy.study = 'susde_public_hypothetical_initiation_issue_v1'
  for (const row of legacy.cases) {
    if (row.status === 'measured')
      row.measurement = asLegacyMeasurement(row.measurement, row.assetsRaw)
  }
  const { sha256: _legacySeal, ...legacyBody } = legacy
  legacy.sha256 = sha(JSON.stringify(legacyBody))
  validateSusdeIssue(legacy)
  await assert.rejects(appendSusdeIssue(legacy), /study_downgrade/)
  const relabeled = { ...legacy, study: issued.study }
  const { sha256: _relabeledSeal, ...relabeledBody } = relabeled
  relabeled.sha256 = sha(JSON.stringify(relabeledBody))
  assert.throws(() => validateSusdeIssue(relabeled), /binding_invalid/)
  const quarantine = buildSusdeScore({
    issue: legacy,
    horizonHours: 1,
    target: null,
    targetWitnesses: null,
    measurements: {},
    scoredAtUtc: '2026-09-30T09:02:00.000Z',
    sequence: 1,
    previousSha256: null,
  })
  assert.equal(quarantine.study, 'susde_public_hypothetical_initiation_score_v2')
  assert.equal(quarantine.cases[0].status, 'unavailable')
  assert.equal(quarantine.cases[0].reason, 'legacy_selector_unassessed')
  assert.equal(quarantine.cases[0].outcome, null)
  validateSusdeScore(quarantine, [legacy])
  const archivedScore = structuredClone(quarantine)
  archivedScore.study = 'susde_public_hypothetical_initiation_score_v1'
  archivedScore.cases = archivedScore.cases.map((row, i) =>
    legacy.cases[i].measurement?.status === 'simulated_initiation_success'
      ? { ...row, status: 'unavailable', reason: 'capture_window_missed' }
      : row,
  )
  const { sha256: _archivedSeal, ...archivedBody } = archivedScore
  archivedScore.sha256 = sha(JSON.stringify(archivedBody))
  validateSusdeScore(archivedScore, [legacy])
  await assert.rejects(appendSusdeScore(archivedScore), /study_downgrade/)
  const liveQuarantine = await scorePublicSusdeInitiation({
    issueSequence: 1,
    horizonHours: 1,
    originPairs: [],
    now: () => new Date('2026-09-30T07:02:00.000Z'),
    loadIssues: async () => [legacy],
    loadScores: async () => [],
    append: async (row) => {
      validateSusdeScore(row, [legacy])
      return { sequence: row.sequence, sha256: row.sha256 }
    },
  })
  assert.equal(liveQuarantine.status, 'legacy_selector_unassessed')
})

test('future score keeps issue Q and censors after deadline', () => {
  const fakeMeasurement = {
    status: 'simulated_initiation_success',
    evidence: { schema: 'susde_public_cooldown_initiation_measurement_v2' },
  }
  const issue = buildSusdeIssue({
    baseline: { block },
    candidate: { holder },
    cases: [{ label: 'q', assetsRaw: '10', status: 'measured', measurement: fakeMeasurement }],
    issuedAtUtc: '2026-09-30T06:01:00.000Z',
    sequence: 1,
    previousSha256: null,
  })
  const score = buildSusdeScore({
    issue,
    horizonHours: 1,
    target: null,
    targetWitnesses: null,
    measurements: {},
    scoredAtUtc: '2026-09-30T09:02:00.000Z',
    sequence: 1,
    previousSha256: null,
  })
  assert.equal(score.cases[0].reason, 'capture_window_missed')
  assert.equal(score.cases[0].outcome, null)
  assert.throws(
    () =>
      validateSusdeScore({ ...score, cases: [{ ...score.cases[0], assetsRaw: '11' }] }, [issue]),
    /q_changed/,
  )
  assert.throws(
    () => validateSusdeIssue({ ...issue, route: { ...ROUTE, vault: holder } }),
    /identity/,
  )
})
