import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  HORIZONS_HOURS,
  SHARES_RAW,
  STUDY,
  classifyTransition,
  deployedRegime,
  finalizedPair,
  firstFinalizedAt,
  reconcileLinks,
  retryTransient,
  selectDueScore,
  validateIssue,
  validateScore,
} from './carry-local-staked-usdat-holder.mjs'
import { appendChain, readChain } from './carry-local-staked-usdat-holder-store.mjs'

const HASH = `0x${'a'.repeat(64)}`
const PARENT_HASH = `0x${'b'.repeat(64)}`
const HOLDER = '0x1111111111111111111111111111111111111111'
const BASE_SECONDS = 1_790_815_703

function syntheticIssue() {
  return {
    study: STUDY,
    kind: 'issue',
    sequence: 1,
    sha256: 'a'.repeat(64),
    routeKey: 'AUSD → Staked USDat [USDat]',
    destination: '0xd166337499e176bbc38a1fbd113ab144e5bd2df7',
    holder: HOLDER,
    sharesRaw: SHARES_RAW,
    issuedAtUtc: new Date(BASE_SECONDS * 1000 + 60_000).toISOString(),
    baseline: { number: 26_093_978, hash: HASH, parentHash: PARENT_HASH, timestamp: BASE_SECONDS },
    selection: {
      samplingRule: 'first_reverting_eoa_else_first_callable',
      candidatesChecked: 4,
      eligibleTested: 2,
      discoverySource: 'rpc.ankr.com',
    },
    measurement: {
      sources: ['rpc.ankr.com', 'lb.drpc.live'],
      outcome: 'evm_revert',
      holderEoa: true,
      holderSharesRaw: SHARES_RAW,
      maxRedeemSharesRaw: SHARES_RAW,
      regime: {
        vaultImpl: '0x2b7074cf6681382b70e239063931ebe83c0f4e0a',
        vaultCodeHash: '0xec3b77f722a89eec23e7dfb2ddfe63e4d82f37adbc5f75a269ed2c82c3ad0300',
        queueImpl: '0xdaf6f8523d7a707d173a12041e1523fdf1373f23',
        queueCodeHash: '0x537d27c7b1574e4ab94867b9f5719414169c5941387346bca88b84643612256d',
      },
    },
    targets: HORIZONS_HOURS.map((horizonHours) => ({
      horizonHours,
      targetAtUtc: new Date((BASE_SECONDS + horizonHours * 3600) * 1000).toISOString(),
      deadlineUtc: new Date((BASE_SECONDS + horizonHours * 3600 + 7200) * 1000).toISOString(),
    })),
  }
}

test('score selection preserves an open target before an older missed deadline', () => {
  const at = (minutes) => new Date(BASE_SECONDS * 1000 + minutes * 60_000).toISOString()
  const issues = [
    { sequence: 1, targets: [{ horizonHours: 1, targetAtUtc: at(0), deadlineUtc: at(30) }] },
    { sequence: 2, targets: [{ horizonHours: 1, targetAtUtc: at(60), deadlineUtc: at(120) }] },
  ]
  const nowMs = Date.parse(at(90))
  assert.equal(selectDueScore(issues, [], nowMs)?.issue.sequence, 2)
  assert.equal(
    selectDueScore(issues, [{ issueSequence: 2, horizonHours: 1 }], nowMs)?.issue.sequence,
    1,
  )
  assert.equal(selectDueScore(issues, [], Date.parse(at(-1))), null)
})

test('target search starts at the verified issue block, not genesis', async () => {
  const reads = []
  const block = (n) => ({
    number: BigInt(n),
    hash: `0x${n.toString(16).padStart(64, '0')}`,
    parentHash: `0x${(n - 1).toString(16).padStart(64, '0')}`,
    timestamp: BigInt(1000 + (n - 100) * 12),
  })
  const pair = [0, 1].map(() => ({
    head: block(110),
    client: {
      getBlock: async ({ blockNumber }) => {
        reads.push(Number(blockNumber))
        return block(Number(blockNumber))
      },
    },
  }))
  const selected = await firstFinalizedAt(pair, 1060 * 1000, { number: 100, hash: block(100).hash })
  assert.equal(selected.target.number, 105)
  assert.equal(selected.parent.number, 104)
  assert.ok(reads.every((n) => n >= 100))
  await assert.rejects(
    firstFinalizedAt(pair, 1060 * 1000, { number: 100, hash: HASH }),
    /saturn_target_baseline_changed/,
  )
})

test('frozen issue has five fixed horizons and rejects a changed implementation', () => {
  const issue = syntheticIssue()
  assert.doesNotThrow(() => validateIssue(issue))
  assert.equal(deployedRegime(issue.measurement.regime), 'current_pinned')
  assert.throws(
    () =>
      validateIssue({
        ...issue,
        measurement: {
          ...issue.measurement,
          regime: { ...issue.measurement.regime, vaultImpl: HOLDER },
        },
      }),
    /saturn_issue_invalid/,
  )
})

test('rejects issue after first horizon and a non-attempted baseline', () => {
  const issue = syntheticIssue()
  assert.throws(
    () => validateIssue({ ...issue, issuedAtUtc: issue.targets[0].targetAtUtc }),
    /saturn_issue_invalid/,
  )
  assert.throws(
    () =>
      validateIssue({ ...issue, measurement: { ...issue.measurement, outcome: 'not_attempted' } }),
    /saturn_issue_invalid/,
  )
  assert.throws(
    () =>
      validateIssue({
        ...issue,
        issuedAtUtc: new Date(issue.baseline.timestamp * 1000 - 1000).toISOString(),
      }),
    /saturn_issue_invalid/,
  )
})

test('unlinked records fail closed until an explicit reconciliation attempt binds their hash', () => {
  const issue = syntheticIssue()
  assert.throws(() => reconcileLinks([issue], [], []), /saturn_orphan_record_unreconciled/)
  const at = new Date(Date.parse(issue.issuedAtUtc) + 60_000).toISOString()
  const attempts = [
    {
      study: STUDY,
      kind: 'attempt',
      mode: 'issue',
      status: 'reconciled_issue',
      recordSequence: issue.sequence,
      recordSha256: issue.sha256,
      startedAtUtc: at,
      finishedAtUtc: at,
      slot: Math.floor(Date.parse(at) / (15 * 60_000)),
    },
  ]
  assert.deepEqual(reconcileLinks([issue], [], attempts), { orphanIssues: [], orphanScores: [] })
  assert.throws(
    () => reconcileLinks([issue], [], [...attempts, ...attempts]),
    /saturn_attempt_link_invalid/,
  )
})

test('future call recovery, holder attrition, and upgrade censor are distinct', () => {
  const issue = syntheticIssue()
  assert.equal(
    classifyTransition(issue, {
      outcome: 'success',
      holderEoa: true,
      holderSharesRaw: SHARES_RAW,
      maxRedeemSharesRaw: SHARES_RAW,
    }),
    'simulated_call_recovery',
  )
  assert.equal(
    classifyTransition(issue, {
      outcome: 'evm_revert',
      holderEoa: true,
      holderSharesRaw: SHARES_RAW,
      maxRedeemSharesRaw: SHARES_RAW,
    }),
    'still_reverting',
  )
  assert.equal(
    classifyTransition(issue, {
      outcome: 'success',
      holderEoa: true,
      holderSharesRaw: '0',
      maxRedeemSharesRaw: '0',
    }),
    'holder_attrition',
  )
  assert.equal(classifyTransition(issue, { outcome: 'regime_changed' }), 'regime_change_censored')
})

test('score verifier binds first target block after frozen horizon and parent before', () => {
  const issue = syntheticIssue()
  const target = issue.targets[0]
  const measurement = {
    ...issue.measurement,
    outcome: 'success',
  }
  const score = {
    study: STUDY,
    kind: 'score',
    issueSequence: 1,
    issueSha256: issue.sha256,
    horizonHours: 1,
    scoredAtUtc: new Date(Date.parse(target.targetAtUtc) + 60_000).toISOString(),
    status: 'measured',
    targetBlock: {
      number: 26_094_278,
      hash: HASH,
      parentHash: PARENT_HASH,
      timestamp: BASE_SECONDS + 3600,
    },
    parentBlock: {
      number: 26_094_277,
      hash: PARENT_HASH,
      parentHash: `0x${'c'.repeat(64)}`,
      timestamp: BASE_SECONDS + 3588,
    },
    measurement,
    transition: 'simulated_call_recovery',
  }
  assert.doesNotThrow(() => validateScore(score, [issue]))
  assert.throws(
    () =>
      validateScore(
        { ...score, parentBlock: { ...score.parentBlock, timestamp: BASE_SECONDS + 3600 } },
        [issue],
      ),
    /saturn_score_invalid/,
  )
  assert.throws(
    () => validateScore({ ...score, transition: 'still_callable' }, [issue]),
    /saturn_score_invalid/,
  )
  assert.throws(
    () =>
      validateScore(
        { ...score, scoredAtUtc: new Date(Date.parse(target.deadlineUtc) + 1).toISOString() },
        [issue],
      ),
    /saturn_score_invalid/,
  )
  assert.throws(
    () =>
      validateScore(
        {
          ...score,
          scoredAtUtc: new Date(score.targetBlock.timestamp * 1000 - 1).toISOString(),
        },
        [issue],
      ),
    /saturn_score_invalid/,
  )
})

test('append-only local chain detects a changed record body', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saturn-chain-'))
  const stat = () => ({ bavail: 10_000_000, bsize: 4096 })
  try {
    const validate = (row) => assert.equal(row.study, STUDY)
    await appendChain(dir, { study: STUDY, kind: 'test' }, validate, stat)
    await appendChain(dir, { study: STUDY, kind: 'test' }, validate, stat)
    assert.equal((await readChain(dir, validate)).length, 2)
    const path = join(dir, '00000001.json')
    const row = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, `${JSON.stringify({ ...row, kind: 'changed' })}\n`)
    await assert.rejects(() => readChain(dir, validate), /saturn_chain_invalid/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('finalized pair requires two independent agreeing chain-one origins', async () => {
  const block = {
    number: 100n,
    hash: HASH,
    parentHash: PARENT_HASH,
    timestamp: BigInt(BASE_SECONDS),
  }
  const source = (host, chainId = 1) => ({
    source: host,
    client: {
      getChainId: async () => chainId,
      getBlock: async () => block,
    },
  })
  const result = await finalizedPair([source('one'), source('two')])
  assert.deepEqual(
    result.pair.map((entry) => entry.source),
    ['one', 'two'],
  )
  await assert.rejects(
    () => finalizedPair([source('one'), source('one')]),
    /saturn_finalized_pair_unavailable/,
  )
  await assert.rejects(
    () => finalizedPair([source('one'), source('two', 10)]),
    /saturn_finalized_pair_unavailable/,
  )
})

test('bounded transport retries recover, but semantic failures do not retry', async () => {
  let calls = 0
  const waits = []
  const result = await retryTransient(
    async () => {
      calls++
      if (calls < 3)
        throw Object.assign(Error('contract call failed'), {
          name: 'ContractFunctionExecutionError',
          cause: Object.assign(Error('private URL must not be persisted'), {
            name: 'HttpRequestError',
          }),
        })
      return 'observed'
    },
    async (ms) => waits.push(ms),
  )
  assert.equal(result, 'observed')
  assert.deepEqual(waits, [1000, 2000])
  calls = 0
  await assert.rejects(
    () =>
      retryTransient(
        async () => {
          calls++
          throw Error('saturn_issue_regime_changed')
        },
        async () => {},
      ),
    /saturn_issue_regime_changed/,
  )
  assert.equal(calls, 1)
})
