import assert from 'node:assert/strict'
import test from 'node:test'
import {
  crossoverAt,
  eligibleControlCandidates,
  matchDistance,
  probeExit,
  selectTreated,
  validateCompleteCheckpoint,
} from './morpho-v2-exit-outcome-pilot.mjs'

const h = (digit) => `0x${digit.repeat(64)}`
const a = (digit) => `0x${digit.repeat(40)}`

test('first-two selection anchors to earliest eligible leg, not earliest ineligible leg', () => {
  const stage1 = {
    study: 'morpho-v2-cap-submit-stage1-v1',
    status: 'complete',
    summary: { independentEligibleCount: 304, independentEligibleProposalIndexes: [0, 1] },
    coverage: { complete: true },
    proposals: [
      {
        vault: a('1'),
        block: 100,
        classes: ['short-lead', 'eligible', 'eligible'],
        executableAts: ['1010', '2000', '3000'],
      },
      { vault: a('2'), block: 200, classes: ['eligible'], executableAts: ['4000'] },
    ],
  }
  const baseline = {
    study: 'morpho-v2-exit-baseline-pilot-v1',
    maxVaults: 20,
    status: 'complete',
    results: [
      {
        proposalIndex: 0,
        vault: a('1'),
        block: 100,
        timestamp: 900,
        preBlock: 99,
        preBlockHash: h('a'),
        holder: a('a'),
        qAssets: '10',
        runtimeCodeHash: h('b'),
        status: 'baseline-success',
      },
      {
        proposalIndex: 1,
        vault: a('2'),
        block: 200,
        timestamp: 3900,
        preBlock: 199,
        preBlockHash: h('c'),
        holder: a('b'),
        qAssets: '20',
        runtimeCodeHash: h('d'),
        status: 'baseline-success',
      },
    ],
  }
  const selected = selectTreated(stage1, baseline)
  assert.equal(selected[0].executableAt, 2000)
  assert.deepEqual(selected[0].coInterventionTimes, [3000])
  assert.equal(selected[1].executableAt, 4000)
  stage1.proposals[0].classes = ['short-lead', 'short-lead', 'short-lead']
  assert.throws(() => selectTreated(stage1, baseline), /Invalid treated baseline/)
})

test('control risk set excludes only as-known prior cap submissions', () => {
  const now = 10 * 86_400
  const treated = { vault: a('1'), anchorBlock: 200, anchorTimestamp: now }
  const factory = {
    events: [
      { vault: a('1'), block: 100, timestamp: 0, asset: a('f') },
      { vault: a('2'), block: 101, timestamp: 1, asset: a('f') },
      { vault: a('3'), block: 102, timestamp: 2, asset: a('f') },
      { vault: a('4'), block: 103, timestamp: 3, asset: a('f') },
      { vault: a('5'), block: 104, timestamp: 4, asset: a('e') },
    ],
  }
  const stage1 = {
    rawEvents: [
      { vault: a('2'), block: 190, timestamp: now - 86_400, executableAt: String(now + 1) },
      { vault: a('3'), block: 110, timestamp: now - 8 * 86_400, executableAt: String(now + 1) },
      { vault: a('4'), block: 201, timestamp: now + 1, executableAt: String(now + 86_400) },
    ],
  }
  const { candidates, excluded } = eligibleControlCandidates({
    factory,
    stage1,
    treated,
    asset: a('f'),
  })
  assert.deepEqual(
    candidates.map((x) => x.vault),
    [a('4')],
  )
  assert.deepEqual(
    excluded.map((x) => x.reason),
    ['prior-seven-day-cap-submit', 'prior-scheduled-state-unresolved'],
  )
})

test('matching ranks pre-anchor assets, age, idle and adapter only', () => {
  const treated = { totalAssets: '1000000', idleFraction: 0.1, adapterPresent: true }
  const exact = {
    totalAssets: '1000000',
    ageSeconds: 100_000,
    idleFraction: 0.1,
    adapterPresent: true,
  }
  const worse = { ...exact, idleFraction: 0.4, adapterPresent: false }
  assert.equal(matchDistance(exact, treated, 100_000), 0)
  assert.ok(matchDistance(worse, treated, 100_000) > 1)
})

test('complete checkpoint verifier rejects truncated or forged frontiers', () => {
  const anchors = [
    {
      vault: a('1'),
      executableAt: 2000,
      asset: null,
      preBlock: 0,
      preBlockHash: h('1'),
      holder: a('a'),
      qAssets: '10',
    },
    {
      vault: a('2'),
      executableAt: 4000,
      asset: null,
      preBlock: 10,
      preBlockHash: h('2'),
      holder: a('b'),
      qAssets: '20',
    },
  ]
  const headerCache = {}
  const rows = anchors.map((anchor, i) => {
    const controls = [
      { vault: a(i ? '4' : '3'), holder: a('c'), totalAssets: '100', distance: 0.1 },
    ]
    const screened = [
      { ...controls[0], reason: 'baseline-success', baselineCall: { status: 'success' } },
    ]
    const probes = {}
    for (const [label, target] of Object.entries({
      preExecutable: anchor.executableAt,
      plus24h: anchor.executableAt + 86_400,
      plus7d: anchor.executableAt + 7 * 86_400,
    })) {
      const block = i * 10 + Object.keys(probes).length + 1
      const header = {
        block,
        hash: h(i ? 'b' : 'a'),
        timestamp: label === 'preExecutable' ? target - 1 : target,
      }
      headerCache[String(block)] = header
      const result = {
        ...header,
        holderCodeHash: null,
        status: 'success',
        output: h('0'),
        shares: '1',
      }
      probes[label] = {
        targetTimestamp: target,
        header,
        treated: result,
        controls: { [controls[0].vault]: result },
      }
    }
    return {
      anchor: { ...anchor, asset: a('f') },
      phase: 'complete',
      screened,
      controls,
      candidateOrder: [],
      probes,
      normalizedBaseline: {
        block: anchor.preBlock,
        hash: anchor.preBlockHash,
        timestamp: 1000,
        holder: anchor.holder,
        qAssets: anchor.qAssets,
        gasLimit: 20_000_000,
        status: 'success',
        output: h('0'),
        shares: '1',
      },
      evaluability: 'evaluable',
    }
  })
  const saved = { status: 'complete', treated: rows, headerCache, pinnedHeadBlock: 99 }
  assert.doesNotThrow(() => validateCompleteCheckpoint(saved, anchors))
  const missingNormalized = structuredClone(saved)
  delete missingNormalized.treated[0].normalizedBaseline
  assert.throws(
    () => validateCompleteCheckpoint(missingNormalized, anchors),
    /Missing normalized treated baseline/,
  )
  assert.throws(
    () => validateCompleteCheckpoint({ ...saved, treated: rows.slice(0, 1) }, anchors),
    /exactly two/,
  )
  const missing = structuredClone(saved)
  delete missing.treated[0].probes.plus24h
  assert.throws(() => validateCompleteCheckpoint(missing, anchors), /frontier mismatch/)
  const badHeader = structuredClone(saved)
  badHeader.headerCache['1'].hash = h('f')
  assert.throws(() => validateCompleteCheckpoint(badHeader, anchors), /header mismatch/)
  const badControl = structuredClone(saved)
  badControl.treated[1].controls[0].holder = a('d')
  assert.throws(() => validateCompleteCheckpoint(badControl, anchors), /Selected control/)

  const noPre = structuredClone(saved)
  noPre.treated[0].probes.preExecutable = {
    targetTimestamp: 2000,
    header: null,
    treated: null,
    controls: {},
    status: 'no-pre-executable-block',
  }
  assert.doesNotThrow(() => validateCompleteCheckpoint(noPre, anchors))
  const truncated = structuredClone(saved)
  truncated.headerCache['99'] = { block: 99, hash: h('f'), timestamp: 1000 }
  truncated.treated[1].probes.plus7d = {
    targetTimestamp: 4000 + 7 * 86_400,
    header: null,
    treated: null,
    controls: {},
    status: 'head-truncated',
  }
  assert.doesNotThrow(() => validateCompleteCheckpoint(truncated, anchors))
  const silentMissing = structuredClone(truncated)
  delete silentMissing.treated[1].probes.plus7d.status
  assert.throws(
    () => validateCompleteCheckpoint(silentMissing, anchors),
    /Invalid censored horizon probe/,
  )
  const falseTruncation = structuredClone(truncated)
  falseTruncation.headerCache['99'].timestamp = 4000 + 7 * 86_400
  assert.throws(
    () => validateCompleteCheckpoint(falseTruncation, anchors),
    /Head-truncated horizon/,
  )
})

test('same-anchor-block Submit is a control crossover', () => {
  const stage1 = {
    rawEvents: [
      { vault: a('3'), block: 99, txHash: h('1') },
      { vault: a('3'), block: 100, txHash: h('2') },
      { vault: a('3'), block: 101, txHash: h('3') },
    ],
  }
  assert.deepEqual(crossoverAt(stage1, a('3'), 100, 101), {
    count: 2,
    firstBlock: 100,
    firstTxHash: h('2'),
  })
})

test('preflight reads cannot become a withdrawal EVM-revert outcome', async () => {
  const header = { block: 100, hash: h('a'), timestamp: 2000 }
  const setup = {
    vault: a('1'),
    holder: a('2'),
    q: '10',
    header,
    executableAt: 1900,
    stage1: { rawEvents: [] },
    anchorBlock: 90,
    control: false,
  }
  for (const failedRead of ['vault-code', 'holder-code', 'balanceOf', 'previewRedeem']) {
    let requestCount = 0
    const client = {
      getCode: async ({ address }) => {
        if (failedRead === 'vault-code' || (failedRead === 'holder-code' && address === a('2')))
          throw new Error('execution reverted')
        return address === a('1') ? '0x6000' : '0x'
      },
      readContract: async ({ functionName }) => {
        if (failedRead === functionName) throw new Error('execution reverted')
        return functionName === 'balanceOf' ? 100n : 1000n
      },
      request: async () => {
        requestCount++
        return h('1')
      },
    }
    const result = await probeExit({ ...setup, client })
    assert.equal(result.status, 'preflight-error')
    assert.equal(result.failedRead, failedRead)
    assert.equal(result.errorCategory, 'evm-revert')
    assert.equal(requestCount, 0)
  }
  const client = {
    getCode: async ({ address }) => (address === a('1') ? '0x6000' : '0x'),
    readContract: async ({ functionName }) => (functionName === 'balanceOf' ? 100n : 1000n),
    request: async () => {
      throw new Error('execution reverted')
    },
  }
  const withdrawal = await probeExit({ ...setup, client })
  assert.equal(withdrawal.status, 'evm-revert')
  assert.equal(withdrawal.failedRead, undefined)
})
