import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseAbi, toEventSelector } from 'viem'
import {
  HORIZONS,
  ORIGINS,
  ROUTE,
  PT,
  ATOKEN,
  POOL,
  VAULT,
  DEPLOYMENT_CODE_HASHES,
  append,
  classifyPtCallOutcome,
  commonFinalized,
  discoverCohortHolder,
  discoverHolder,
  issue,
  publicCounts,
  qLadder,
  readChain,
  score,
  verifyLedgers,
} from './carry-pt-wrapper-holder.mjs'

const holder = `0x${'1'.repeat(40)}`
const hash = `0x${'a'.repeat(64)}`
const cohort = JSON.parse(readFileSync('scripts/route-cohort/aug-2026-ab-vault-seed.json', 'utf8'))
  .positions.filter((row) => row.vault === VAULT && row.routeIds?.includes(ROUTE))
  .map((row) => row.owner)
  .sort()
const cohortHolder = cohort[0]
const seedSha = createHash('sha256')
  .update(readFileSync('scripts/route-cohort/aug-2026-ab-vault-seed.json', 'utf8'))
  .digest('hex')
const transferTopic = toEventSelector(
  parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)'])[0],
).toLowerCase()
const temp = () => mkdtempSync(join(tmpdir(), 'pt-wrapper-holder-'))

function measurement(qRaw, blockNumber = 100, blockTimestamp = 1_000, assayOwner = holder) {
  return {
    status: 'observed',
    blockNumber,
    blockHash: hash,
    assayOwner,
    routeKey: ROUTE,
    destination: VAULT,
    codeHashes: Object.fromEntries(Object.entries(DEPLOYMENT_CODE_HASHES).sort()),
    holderExecutable: false,
    evidence: {
      chainId: 1,
      blockNumber,
      blockHash: hash,
      blockTimestamp,
      wrapperImplementation: '0x41695d3304e38bc806f077a3541c5cd34f8f034b',
      aTokenImplementation: '0xadc45df3cf1584624c97338bef33363bf5b97ada',
      poolImplementation: '0x728a138a4823392c2efa55e028d434f526fe03cf',
      ptAsset: PT,
      aToken: ATOKEN,
      pool: POOL,
      ptDecimals: 18,
      wrapperDecimals: 18,
      yt: '0xfe6040719cca36aeb85e352f48fe956057728814',
      sy: '0xc9bfebc79a722c05dc34bd2a227ef2db19fd1b8e',
      ptExpiry: 1_792_627_200,
      ptMaturity: 'before_expiry',
    },
    amountCheck: {
      requestedPtRaw: qRaw,
      holderSharesRaw: '1000',
      previewSharesToBurnRaw: qRaw,
      aavePtCashRaw: '1000000',
      simulation: { status: 'success', sharesBurnedRaw: qRaw },
      redeemSimulation: { status: 'success', ptAssetsRaw: qRaw },
      ptDelivery: 'not_observed',
      ptToUsde: 'not_assessed',
    },
  }
}

function issueBody(atMs) {
  const issuedAtUtc = new Date(atMs).toISOString()
  const qRaw = qLadder('1000')
  const blockTimestamp = Math.floor(atMs / 1000) - 60
  return {
    slot: Math.floor(atMs / (30 * 60_000)),
    issuedAtUtc,
    routeKey: ROUTE,
    destination: VAULT,
    asset: PT,
    holder: cohortHolder,
    holderKind: 'no_code',
    candidate: {
      holder: cohortHolder,
      holderKind: 'no_code',
      codeByOrigin: ['0x', '0x'],
      sharesRaw: '1000',
      previewPtRaw: '1000',
      sourceTx: null,
      sourceBlock: 100,
      sourceBlockHash: hash,
      sourceSeedSha256: seedSha,
      sourceAttestation: 'frozen_cohort_two_origin_no_code',
      selectionOffset: 0,
      selectionWitness: cohort.map((address, i) => ({
        holder: address,
        codeByOrigin: i === 0 ? ['0x', '0x'] : [hash, hash],
        sharesRaw: i === 0 ? '1000' : '0',
        previewPtRaw: i === 0 ? '1000' : null,
      })),
    },
    qRaw,
    origins: ORIGINS,
    baseline: {
      blockNumber: 100,
      blockHash: hash,
      blockTimestamp,
      cases: qRaw.map((q) => ({
        qRaw: q,
        measurement: measurement(q, 100, blockTimestamp, cohortHolder),
      })),
    },
    targets: HORIZONS.map((horizonHours) => ({
      horizonHours,
      targetAtUtc: new Date(atMs + horizonHours * 3_600_000).toISOString(),
      deadlineAtUtc: new Date(atMs + (horizonHours + 2) * 3_600_000).toISOString(),
    })),
    payoutAssessment: 'pt_first_leg_simulation_only',
  }
}

test('bounded Q ladder and two agreeing finalized headers', async () => {
  assert.deepEqual(qLadder('1000'), ['10', '100', '250', '500', '1000'])
  const client = {
    getBlock: async ({ blockTag }) =>
      blockTag === 'finalized'
        ? { number: 101n, hash, timestamp: 1000n }
        : { number: 101n, hash, timestamp: 1000n },
  }
  assert.deepEqual(await commonFinalized([client, client], 1_001_000), {
    number: 101,
    hash,
    timestamp: 1000,
  })
  await assert.rejects(
    commonFinalized(
      [
        client,
        { getBlock: async () => ({ number: 101n, hash: `0x${'b'.repeat(64)}`, timestamp: 1000n }) },
      ],
      1_001_000,
    ),
    /finalized_disagreement/,
  )
})

test('no-code call success remains a simulation, with control unassessed', () => {
  assert.equal(classifyPtCallOutcome('no_code', 'success'), 'simulated_no_code_pt_call_success')
  assert.throws(() => classifyPtCallOutcome('eoa', 'success'), /holder_kind/)
})

test('two-origin share Transfer scan yields one no-code entitlement', async () => {
  const log = {
    address: VAULT,
    blockNumber: '0x65',
    blockHash: hash,
    transactionHash: hash,
    logIndex: '0x0',
    topics: [transferTopic, `0x${'0'.repeat(64)}`, `0x${'0'.repeat(24)}${holder.slice(2)}`],
    data: `0x${'0'.repeat(63)}1`,
  }
  const client = {
    request: async () => [log],
    getCode: async () => '0x',
    readContract: async ({ functionName }) => (functionName === 'balanceOf' ? 1000n : 500n),
  }
  const found = await discoverHolder([client, client], { number: 101, hash }, 0)
  assert.equal(found.holder, holder)
  assert.equal(found.previewPtRaw, '500')
  assert.equal(found.sourceAttestation, 'two_origin_log_query')
})

test('Transfer candidate requires canonical 32-byte value and padded address topics', async () => {
  const valid = {
    address: VAULT,
    blockNumber: '0x65',
    blockHash: hash,
    transactionHash: hash,
    logIndex: '0x0',
    topics: [transferTopic, `0x${'0'.repeat(64)}`, `0x${'0'.repeat(24)}${holder.slice(2)}`],
    data: `0x${'0'.repeat(63)}1`,
  }
  for (const mutation of [
    (row) => (row.data = '0x'),
    (row) => (row.data = '0x01'),
    (row) => (row.data = `0x${'0'.repeat(64)}`),
    (row) => (row.topics[2] = `0x${'1'.repeat(24)}${holder.slice(2)}`),
  ]) {
    const log = structuredClone(valid)
    mutation(log)
    const clients = [{ request: async () => [log] }, { request: async () => [log] }]
    await assert.rejects(discoverHolder(clients, { number: 101, hash }), /candidate_log_invalid/)
  }
})

test('frozen cohort scans all 16 pinned accounts and selects first qualifying no-code holder', async () => {
  const inspected = []
  const client = {
    getCode: async ({ address, blockHash, requireCanonical }) => {
      assert.equal(blockHash, hash)
      assert.equal(requireCanonical, true)
      inspected.push(address)
      return address === cohort[0] ? '0x60016000' : '0x'
    },
    readContract: async ({ functionName, args }) => {
      if (functionName === 'balanceOf') return cohort.slice(0, 2).includes(args[0]) ? 1_000n : 0n
      return 50n
    },
  }
  const candidate = await discoverCohortHolder([client, client], { number: 100, hash }, 0)
  assert.equal(inspected.length, 32)
  assert.equal(candidate.holder, cohort[1])
  assert.equal(candidate.holderKind, 'no_code')
  assert.deepEqual(candidate.codeByOrigin, ['0x', '0x'])
  assert.equal(candidate.selectionWitness.length, 16)
  assert.notDeepEqual(candidate.selectionWitness[0].codeByOrigin, ['0x', '0x'])
  assert.equal(candidate.previewPtRaw, '50')
  assert.equal(candidate.sourceAttestation, 'frozen_cohort_two_origin_no_code')
  assert.equal(candidate.sourceBlock, 100)
})

test('contract-only positive balances yield a full negative no-code scan', async () => {
  const client = {
    getCode: async () => '0x60016000',
    readContract: async ({ functionName }) => (functionName === 'balanceOf' ? 1_000n : 50n),
  }
  const selection = await discoverCohortHolder([client, client], { number: 100, hash })
  assert.equal(selection.status, 'no_code_candidate_unavailable')
  assert.equal(selection.selectionWitness.length, 16)
})

test('contract-only cohort records replayed negative scan without an issue', async () => {
  const root = temp()
  try {
    const nowMs = Date.parse('2026-10-01T00:00:00.000Z')
    const client = {
      getBlock: async () => ({ number: 100n, hash, timestamp: BigInt(nowMs / 1000 - 60) }),
      getCode: async () => '0x60016000',
      readContract: async ({ functionName }) => (functionName === 'balanceOf' ? 1_000n : 50n),
    }
    const result = await issue({ clients: [client, client], nowMs, clock: () => nowMs, root })
    assert.equal(result.status, 'no_code_candidate_unavailable')
    const verified = verifyLedgers(root)
    assert.equal(verified.issues.length, 0)
    assert.equal(verified.attempts[0].reason, 'no_code_candidate_unavailable')
    assert.equal(verified.attempts[0].selectionWitness.length, 16)
    const path = join(root, 'attempts', '00000001.json')
    const row = JSON.parse(readFileSync(path, 'utf8'))
    row.selectionWitness[0].codeByOrigin = ['0x', '0x']
    row.selectionWitness[0].previewPtRaw = '50'
    const { sha256: _prior, ...body } = row
    row.sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    writeFileSync(path, `${JSON.stringify(row)}\n`)
    assert.throws(() => verifyLedgers(root), /attempt_selection_invalid/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('secondary receipt attests candidate when its older log range is unavailable', async () => {
  const log = {
    address: VAULT,
    blockNumber: '0x65',
    blockHash: hash,
    transactionHash: hash,
    logIndex: '0x0',
    topics: [transferTopic, `0x${'0'.repeat(64)}`, `0x${'0'.repeat(24)}${holder.slice(2)}`],
    data: `0x${'0'.repeat(63)}1`,
  }
  const state = {
    getCode: async () => '0x',
    readContract: async ({ functionName }) => (functionName === 'balanceOf' ? 1000n : 500n),
  }
  const primary = { ...state, request: async () => [log] }
  const secondary = {
    ...state,
    request: async ({ method }) => {
      if (method === 'eth_getLogs') throw Error('range unavailable')
      return { transactionHash: hash, blockHash: hash, logs: [log] }
    },
  }
  const found = await discoverHolder([primary, secondary], { number: 101, hash })
  assert.equal(found.sourceAttestation, 'primary_log_secondary_receipt')
  const falseSecondary = {
    ...secondary,
    request: async ({ method }) => {
      if (method === 'eth_getLogs') throw Error('range unavailable')
      return { transactionHash: hash, blockHash: hash, logs: [] }
    },
  }
  await assert.rejects(
    discoverHolder([primary, falseSecondary], { number: 101, hash }),
    /candidate_receipt_disagreement/,
  )
})

test('unavailable secondary range cannot establish an empty candidate window', async () => {
  const primary = { request: async () => [] }
  const secondary = {
    request: async () => {
      throw Error('range unavailable')
    },
  }
  await assert.rejects(
    discoverHolder([primary, secondary], { number: 2000, hash }),
    /candidate_quiet_unverified/,
  )
})

test('late score needs a finalized two-origin post-deadline witness', async () => {
  const root = temp()
  try {
    const atMs = Date.parse('2026-10-01T00:00:00.000Z')
    const saved = append('issues', issueBody(atMs), root)
    assert.equal(saved.sequence, 1)
    assert.equal(verifyLedgers(root).issues.length, 1)
    const lateMs = atMs + 4 * 3_600_000
    const unavailable = await score({ clients: [], nowMs: lateMs, clock: () => lateMs, root })
    assert.equal(unavailable.status, 'source_unavailable')
    assert.equal(verifyLedgers(root).scores.length, 0)
    const client = {
      getBlock: async () => ({ number: 101n, hash, timestamp: BigInt(lateMs / 1000) }),
    }
    const result = await score({
      clients: [client, client],
      nowMs: lateMs,
      clock: () => lateMs,
      root,
    })
    assert.equal(result.status, 'missed_window')
    const view = publicCounts(root)
    assert.equal(view.issuedEpisodes, 1)
    assert.equal(view.missedScores, 1)
    assert.equal(view.pendingTargets, 4)
    assert.equal(JSON.stringify(view).includes(holder), false)
    assert.equal(JSON.stringify(view).includes('1000'), false)
    assert.equal(view.calibratedForecast, false)
    const scorePath = join(root, 'scores', '00000001.json')
    const forgedScore = JSON.parse(readFileSync(scorePath, 'utf8'))
    forgedScore.block.timestamp = Math.floor((atMs + 3 * 3_600_000) / 1000)
    writeFileSync(scorePath, `${JSON.stringify(forgedScore)}\n`)
    assert.throws(() => readChain('scores', root), /ledger_chain/)
    const path = join(root, 'issues', '00000001.json')
    const forged = JSON.parse(readFileSync(path, 'utf8'))
    forged.qRaw[0] = '999999'
    writeFileSync(path, `${JSON.stringify(forged)}\n`)
    assert.throws(() => readChain('issues', root), /ledger_chain/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SHA-resealed omissions and identity drift fail offline issue replay', () => {
  const atMs = Date.parse('2026-10-01T00:00:00.000Z')
  const mutations = [
    ['status', (row) => delete row.baseline.cases[0].measurement.status],
    ['wrapper code hash', (row) => delete row.baseline.cases[0].measurement.codeHashes[VAULT]],
    [
      'wrapper implementation',
      (row) => delete row.baseline.cases[0].measurement.evidence.wrapperImplementation,
    ],
    [
      'aToken implementation',
      (row) => delete row.baseline.cases[0].measurement.evidence.aTokenImplementation,
    ],
    [
      'pool implementation',
      (row) => delete row.baseline.cases[0].measurement.evidence.poolImplementation,
    ],
    ['YT', (row) => delete row.baseline.cases[0].measurement.evidence.yt],
    ['SY', (row) => delete row.baseline.cases[0].measurement.evidence.sy],
    ['expiry', (row) => delete row.baseline.cases[0].measurement.evidence.ptExpiry],
    ['maturity', (row) => delete row.baseline.cases[0].measurement.evidence.ptMaturity],
    ['decimals', (row) => delete row.baseline.cases[0].measurement.evidence.wrapperDecimals],
    [
      'redeem simulation',
      (row) => delete row.baseline.cases[0].measurement.amountCheck.redeemSimulation,
    ],
    ['holder executable', (row) => delete row.baseline.cases[0].measurement.holderExecutable],
  ]
  for (const [name, mutate] of mutations) {
    const root = temp()
    try {
      append('issues', issueBody(atMs), root)
      const path = join(root, 'issues', '00000001.json')
      const row = JSON.parse(readFileSync(path, 'utf8'))
      mutate(row)
      const { sha256: _prior, ...body } = row
      row.sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex')
      writeFileSync(path, `${JSON.stringify(row)}\n`)
      assert.throws(() => verifyLedgers(root), /assay_identity|issue_case_invalid/, name)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('SHA-resealed holder kind, no-code witness, and scan-order forgeries fail', () => {
  const atMs = Date.parse('2026-10-01T00:00:00.000Z')
  const mutations = [
    [
      'unsupported EOA kind',
      (row) => {
        row.holderKind = row.candidate.holderKind = 'eoa'
      },
    ],
    [
      'missing second origin',
      (row) => {
        row.candidate.codeByOrigin = ['0x']
      },
    ],
    [
      'contract code for selected holder',
      (row) => {
        row.candidate.selectionWitness[0].codeByOrigin = [hash, hash]
      },
    ],
    [
      'altered scan order',
      (row) => {
        row.candidate.selectionWitness[1].codeByOrigin = ['0x', '0x']
        row.candidate.selectionWitness[1].sharesRaw = '1000'
        row.candidate.selectionWitness[1].previewPtRaw = '1000'
        row.candidate.selectionOffset = 1
      },
    ],
  ]
  for (const [name, mutate] of mutations) {
    const root = temp()
    try {
      append('issues', issueBody(atMs), root)
      const path = join(root, 'issues', '00000001.json')
      const row = JSON.parse(readFileSync(path, 'utf8'))
      mutate(row)
      const { sha256: _prior, ...body } = row
      row.sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex')
      writeFileSync(path, `${JSON.stringify(row)}\n`)
      assert.throws(() => verifyLedgers(root), /issue_invalid/, name)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})
