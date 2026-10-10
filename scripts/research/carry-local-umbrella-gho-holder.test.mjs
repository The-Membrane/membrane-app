import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  HORIZONS_HOURS,
  SHARES_RAW,
  STUDY,
  classifyTransition,
  findCandidate,
  findFrozenSeedCandidate,
  holderOriginCodeProof,
  pinnedHolderOriginCodeProof,
  previouslySampledHolder,
  readFrozenSeedCandidates,
  selectIssueCandidate,
  selectDueScoreTarget,
  shouldSealMissedDeadline,
  tickMode,
  twoOriginMeasurement,
  validateAttempt,
  validateIssue,
  validateScore,
} from './carry-local-umbrella-gho-holder.mjs'
import { appendChain, hash, readChain } from './carry-local-umbrella-gho-holder-store.mjs'

const block = {
  number: 100,
  hash: `0x${'a'.repeat(64)}`,
  parentHash: `0x${'b'.repeat(64)}`,
  timestamp: 1_700_000_000,
}
const issued = '2023-11-14T22:14:00.000Z'
const target = (hours) => new Date(block.timestamp * 1000 + hours * 3_600_000).toISOString()
const deadline = (hours) => new Date(block.timestamp * 1000 + (hours + 2) * 3_600_000).toISOString()
const measurement = {
  outcome: 'evm_revert',
  implementation: '0x75e8ac0c063b6966e2a9954adedf39bde9370197',
  codeHash: `0x${'c'.repeat(64)}`,
  holderEoa: true,
  holderCodeStatus: 'no_code',
  holderCodeHex: '0x',
  holderCodeHash: null,
  holderSharesRaw: SHARES_RAW,
  gate: 'waiting',
  sources: ['source-a', 'source-b'],
}
const issue = () => ({
  study: STUDY,
  kind: 'issue',
  routeKey: 'GHO → UmbrellaStakeToken [GHO]',
  destination: '0x4f827a63755855cdf3e8f3bcd20265c833f15033',
  holder: `0x${'d'.repeat(40)}`,
  sharesRaw: SHARES_RAW,
  issuedAtUtc: issued,
  baseline: block,
  selection: {
    samplingRule: 'first_window_open_else_first_eligible_eoa',
    fromBlock: 1,
    toBlock: block.number,
    transferLogs: 3,
    candidatesChecked: 3,
    eligibleTested: 1,
    discoverySource: 'source-a',
  },
  measurement,
  targets: HORIZONS_HOURS.map((horizonHours) => ({
    horizonHours,
    targetAtUtc: target(horizonHours),
    deadlineUtc: deadline(horizonHours),
  })),
})

test('fixed issue freezes baseline block, exact share amount, and future target clocks', () => {
  assert.doesNotThrow(() => validateIssue(issue()))
  assert.doesNotThrow(() =>
    validateIssue({ ...issue(), sequence: 1, targets: issue().targets.slice(0, 4) }),
  )
  assert.throws(
    () => validateIssue({ ...issue(), sequence: 2, targets: issue().targets.slice(0, 4) }),
    /umbrella_issue_invalid/,
  )
  assert.throws(
    () => validateIssue({ ...issue(), issuedAtUtc: target(1) }),
    /umbrella_issue_invalid/,
  )
  assert.throws(() => validateIssue({ ...issue(), sharesRaw: '1' }), /umbrella_issue_invalid/)
  assert.throws(
    () => validateIssue({ ...issue(), issuedAtUtc: '2023-11-14T22:12:00.000Z' }),
    /umbrella_issue_invalid/,
  )
})

test('measured target requires exact crossing block and on-time observation', () => {
  const parentBlock = {
    ...block,
    number: 101,
    hash: `0x${'e'.repeat(64)}`,
    timestamp: block.timestamp + 3590,
  }
  const targetBlock = {
    ...block,
    number: 102,
    hash: `0x${'f'.repeat(64)}`,
    parentHash: parentBlock.hash,
    timestamp: block.timestamp + 3602,
  }
  const row = {
    study: STUDY,
    kind: 'score',
    issueSequence: 1,
    issueSha256: 'seal',
    horizonHours: 1,
    scoredAtUtc: new Date(targetBlock.timestamp * 1000 + 30_000).toISOString(),
    status: 'measured',
    targetBlock,
    parentBlock,
    measurement: { ...measurement, outcome: 'success' },
    transition: 'simulated_call_recovery',
  }
  const issues = [{ ...issue(), sequence: 1, sha256: 'seal' }]
  assert.doesNotThrow(() => validateScore(row, issues))
  assert.throws(
    () => validateScore({ ...row, scoredAtUtc: issued }, issues),
    /umbrella_score_invalid/,
  )
  assert.throws(
    () => validateScore({ ...row, transition: 'still_callable' }, issues),
    /umbrella_score_invalid/,
  )
  assert.throws(
    () =>
      validateScore(
        { ...row, parentBlock: { ...parentBlock, timestamp: block.timestamp + 3600 } },
        issues,
      ),
    /umbrella_score_invalid/,
  )
})

test('attrition and changed implementation are censored separately from failed redeem', () => {
  assert.equal(classifyTransition(issue(), { outcome: 'regime_changed' }), 'regime_change_censored')
  assert.equal(
    classifyTransition(issue(), { ...measurement, holderSharesRaw: '0' }),
    'holder_attrition',
  )
  assert.equal(
    classifyTransition(issue(), { ...measurement, outcome: 'success' }),
    'simulated_call_recovery',
  )
  assert.equal(classifyTransition(issue(), measurement), 'still_reverting')
})

test('missed deadline requires finalized chain time, not just a jumped Mac clock', () => {
  const end = Date.parse(deadline(1))
  assert.equal(shouldSealMissedDeadline(end - 1, end + 10_000_000, end), false)
  assert.equal(shouldSealMissedDeadline(end, end + 10_000_000, end), false)
  assert.equal(shouldSealMissedDeadline(end + 1, end - 1, end), false)
  assert.equal(shouldSealMissedDeadline(end + 1, end + 1, end), true)
  const missed = {
    study: STUDY,
    kind: 'score',
    issueSequence: 1,
    issueSha256: 'seal',
    horizonHours: 1,
    scoredAtUtc: new Date(end + 10_000).toISOString(),
    status: 'missed_deadline',
    deadlineFinalizedBlock: { ...block, timestamp: (end + 1000) / 1000 },
    targetBlock: null,
    parentBlock: null,
    measurement: null,
    transition: 'missing',
  }
  const issues = [{ ...issue(), sequence: 1, sha256: 'seal' }]
  assert.doesNotThrow(() => validateScore(missed, issues))
  assert.throws(
    () => validateScore({ ...missed, deadlineFinalizedBlock: block }, issues),
    /umbrella_score_invalid/,
  )
  assert.throws(
    () => validateScore({ ...missed, deadlineFinalizedBlock: null }, issues),
    /umbrella_score_invalid/,
  )
  assert.throws(
    () =>
      validateScore(
        {
          ...missed,
          deadlineFinalizedBlock: {
            ...missed.deadlineFinalizedBlock,
            timestamp: (Date.parse(missed.scoredAtUtc) + 1_000) / 1_000,
          },
        },
        issues,
      ),
    /umbrella_score_invalid/,
  )
})

test('previously sampled EOAs are excluded case insensitively', () => {
  assert.equal(previouslySampledHolder(issue().holder.toUpperCase(), [issue()]), true)
  assert.equal(previouslySampledHolder(`0x${'e'.repeat(40)}`, [issue()]), false)
})

test('raw holder code requires an exact pinned EOA or EIP-7702 delegation response', async () => {
  const holder = issue().holder
  const delegation = `0xef0100${'a'.repeat(40)}`
  assert.deepEqual(holderOriginCodeProof('0x'), {
    holderEoa: true,
    holderCodeStatus: 'no_code',
    holderCodeHex: '0x',
    holderCodeHash: null,
  })
  assert.equal(holderOriginCodeProof(delegation).holderCodeStatus, 'eip7702_delegated')
  assert.equal(holderOriginCodeProof('0x6000').holderEoa, false)
  assert.equal(holderOriginCodeProof(`0xef0100${'a'.repeat(38)}`).holderEoa, false)
  for (const bad of [undefined, null, '', '0x0', '0xzz'])
    assert.throws(() => holderOriginCodeProof(bad), /umbrella_holder_code_invalid/)
  const proof = await pinnedHolderOriginCodeProof(
    {
      request: async ({ method, params }) => {
        assert.equal(method, 'eth_getCode')
        assert.deepEqual(params, [holder, { blockHash: block.hash, requireCanonical: true }])
        return delegation
      },
    },
    holder,
    block.hash,
  )
  assert.equal(proof.holderEoa, true)
  assert.equal(proof.holderCodeStatus, 'eip7702_delegated')
  await assert.rejects(
    pinnedHolderOriginCodeProof({ request: async () => undefined }, holder, block.hash),
    /umbrella_holder_code_invalid/,
  )
})

test('baseline simulation refuses missing raw holder code on either origin', async () => {
  const impl = measurement.implementation
  const holder = issue().holder
  const build = (code) => ({
    getStorageAt: async () => `0x${'0'.repeat(24)}${impl.slice(2)}`,
    getCode: async ({ address }) => {
      assert.equal(address, impl)
      return '0x6000'
    },
    request: async ({ method, params }) => {
      assert.equal(method, 'eth_getCode')
      assert.deepEqual(params, [holder, { blockHash: block.hash, requireCanonical: true }])
      return code
    },
    readContract: async ({ functionName }) => {
      if (functionName === 'asset') return '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f'
      if (functionName === 'paused') return false
      if (functionName === 'balanceOf' || functionName === 'maxRedeem') return BigInt(SHARES_RAW)
      if (functionName === 'getStakerCooldown') return [0n, 0n, 0n]
      return 0n
    },
    call: async () => ({ data: `0x${'1'.padStart(64, '0')}` }),
    getBlock: async () => ({ hash: block.hash }),
  })
  const pair = (a, b) => [
    { source: 'source-a', client: build(a) },
    { source: 'source-b', client: build(b) },
  ]
  await assert.rejects(
    twoOriginMeasurement(pair(undefined, '0x'), block, holder),
    /umbrella_holder_code_invalid/,
  )
  const delegated = `0xef0100${'a'.repeat(40)}`
  const positive = await twoOriginMeasurement(pair(delegated, delegated), block, holder)
  assert.equal(positive.outcome, 'success')
  assert.equal(positive.holderCodeStatus, 'eip7702_delegated')
  assert.equal(positive.holderCodeHex, delegated)
  const contract = await twoOriginMeasurement(pair('0x6000', '0x6000'), block, holder)
  assert.equal(contract.outcome, 'not_attempted')
  assert.equal(contract.holderEoa, false)
})

test('new issue proof is required while older sealed rows keep their historical shape', () => {
  const {
    holderCodeStatus: _status,
    holderCodeHex: _hex,
    holderCodeHash: _hash,
    ...olderMeasurement
  } = measurement
  assert.doesNotThrow(() =>
    validateIssue({ ...issue(), sequence: 3, measurement: olderMeasurement }),
  )
  assert.throws(
    () => validateIssue({ ...issue(), sequence: 4, measurement: olderMeasurement }),
    /umbrella_issue_invalid/,
  )
  assert.throws(
    () =>
      validateIssue({
        ...issue(),
        sequence: 4,
        measurement: { ...measurement, holderCodeStatus: 'contract_code' },
      }),
    /umbrella_issue_invalid/,
  )
  const scored = {
    study: STUDY,
    kind: 'score',
    sequence: 5,
    issueSequence: 1,
    issueSha256: 'seal',
    horizonHours: 1,
    scoredAtUtc: new Date(Date.parse(target(1)) + 30_000).toISOString(),
    status: 'measured',
    targetBlock: {
      ...block,
      number: 102,
      hash: `0x${'f'.repeat(64)}`,
      parentHash: `0x${'e'.repeat(64)}`,
      timestamp: block.timestamp + 3602,
    },
    parentBlock: {
      ...block,
      number: 101,
      hash: `0x${'e'.repeat(64)}`,
      timestamp: block.timestamp + 3590,
    },
    measurement: olderMeasurement,
    transition: 'still_reverting',
  }
  const issues = [{ ...issue(), sequence: 1, sha256: 'seal' }]
  assert.doesNotThrow(() => validateScore(scored, issues))
  assert.throws(() => validateScore({ ...scored, sequence: 6 }, issues), /umbrella_score_invalid/)
})

test('live capture windows precede missed censors, then older misses advance', () => {
  const at = Date.parse(issued) + 5 * 3_600_000
  const old = {
    sequence: 1,
    targets: [
      {
        horizonHours: 1,
        targetAtUtc: new Date(at - 4 * 3_600_000).toISOString(),
        deadlineUtc: new Date(at - 2 * 3_600_000).toISOString(),
      },
    ],
  }
  const open = {
    sequence: 2,
    targets: [
      {
        horizonHours: 2,
        targetAtUtc: new Date(at - 15 * 60_000).toISOString(),
        deadlineUtc: new Date(at + 15 * 60_000).toISOString(),
      },
    ],
  }
  assert.equal(selectDueScoreTarget([old, open], [], at, at).issue.sequence, 2)
  assert.equal(
    selectDueScoreTarget([old, open], [{ issueSequence: 2, horizonHours: 2 }], at, at).issue
      .sequence,
    1,
  )
  assert.equal(selectDueScoreTarget([old], [], at, at - 3 * 3_600_000), null)
  assert.equal(selectDueScoreTarget([open], [], at, at - 20 * 60_000), null)
})

test('fallback reads only the SHA-pinned exact August route and vault shortlist', async () => {
  const owners = readFrozenSeedCandidates()
  assert.equal(owners.length, 21)
  assert.equal(new Set(owners).size, 21)
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-seed-'))
  try {
    const changed = join(dir, 'seed.json')
    await writeFile(changed, '{}')
    assert.throws(() => readFrozenSeedCandidates(changed), /umbrella_seed_sha_mismatch/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('empty recent Transfer scan falls back in frozen order and attests a fresh holder', async () => {
  const owners = readFrozenSeedCandidates()
  const scanBlock = { ...block, number: 100_001 }
  const calls = []
  const client = {
    getBlock: async () => ({ hash: block.hash }),
    getLogs: async ({ fromBlock, toBlock }) => {
      calls.push(['logs', fromBlock, toBlock])
      return []
    },
    request: async ({ method, params: [address, pin] }) => {
      calls.push(['code', address])
      assert.equal(method, 'eth_getCode')
      assert.equal(pin.blockHash, block.hash)
      assert.equal(pin.requireCanonical, true)
      return '0x'
    },
    readContract: async ({ args, blockHash, requireCanonical }) => {
      calls.push(['balance', args[0]])
      assert.equal(blockHash, block.hash)
      assert.equal(requireCanonical, true)
      return args[0] === owners[1] ? 0n : BigInt(SHARES_RAW)
    },
  }
  const pair = [
    { source: 'source-a', client },
    { source: 'source-b', client: {} },
  ]
  const measured = []
  const found = await findCandidate(
    pair,
    pair,
    scanBlock,
    [{ holder: owners[0] }],
    async (usedPair, pinnedBlock, holder) => {
      assert.equal(usedPair, pair)
      assert.equal(pinnedBlock, scanBlock)
      measured.push(holder)
      return { ...measurement, gate: 'window_open', outcome: 'success' }
    },
  )
  assert.equal(calls.filter(([kind]) => kind === 'logs').length, 50)
  assert.deepEqual(measured, [owners[2]])
  assert.equal(found.holder, owners[2])
  assert.equal(found.selection.candidateSource, 'frozen_august_route_seed')
  assert.equal(found.selection.seedIndex, 2)
  assert.equal(found.selection.candidatesChecked, 2)
  assert.equal(found.selection.eligibleTested, 1)
  assert.equal(found.selection.discoverySource, 'source-a')
  assert.doesNotThrow(() =>
    validateIssue({
      ...issue(),
      holder: found.holder,
      baseline: scanBlock,
      selection: found.selection,
      measurement: found.measurement,
    }),
  )
})

test('eligible recent Transfer retains its original selection rule', async () => {
  const holder = `0x${'f'.repeat(40)}`
  const client = {
    getBlock: async () => ({ hash: block.hash }),
    getLogs: async () => [{ args: { to: holder } }],
    request: async () => '0x',
    readContract: async () => BigInt(SHARES_RAW),
  }
  const pair = [
    { source: 'source-a', client },
    { source: 'source-b', client: {} },
  ]
  const found = await findCandidate(pair, pair, block, [], async () => ({
    ...measurement,
    gate: 'window_open',
    outcome: 'success',
  }))
  assert.equal(found.holder, holder)
  assert.equal(found.selection.samplingRule, 'first_window_open_else_first_eligible_eoa')
  assert.equal(found.selection.candidateSource, undefined)
  assert.doesNotThrow(() =>
    validateIssue({
      ...issue(),
      holder,
      selection: found.selection,
      measurement: found.measurement,
    }),
  )
})

test('candidate discovery never promotes a missing code response to EOA', async () => {
  const holder = `0x${'f'.repeat(40)}`
  const client = {
    getBlock: async () => ({ hash: block.hash }),
    getLogs: async () => [{ args: { to: holder } }],
    request: async () => undefined,
    readContract: async () => BigInt(SHARES_RAW),
  }
  const pair = [
    { source: 'source-a', client },
    { source: 'source-b', client },
  ]
  await assert.rejects(
    findCandidate(pair, pair, block, [], async () => measurement),
    /umbrella_holder_code_invalid/,
  )
  await assert.rejects(
    findFrozenSeedCandidate(pair, block, [], async () => measurement),
    /umbrella_holder_code_invalid/,
  )
})

test('explicit seed mode bypasses Transfer selection and retains issue attempt identity', async () => {
  const sources = [{ source: 'discovery' }]
  const pair = [{ source: 'source-a' }, { source: 'source-b' }]
  const issues = [issue()]
  const seen = []
  const candidate = { holder: readFrozenSeedCandidates()[0] }
  const selectors = {
    transfer: () => {
      throw Error('transfer_scan_called')
    },
    seed: (...args) => {
      seen.push(args)
      return candidate
    },
  }
  assert.equal(
    await selectIssueCandidate('frozen_seed', sources, pair, block, issues, selectors),
    candidate,
  )
  assert.deepEqual(seen, [[pair, block, issues]])
  assert.deepEqual(tickMode('issue-seed'), {
    attemptMode: 'issue',
    candidateSource: 'frozen_seed',
  })
  assert.deepEqual(tickMode('issue'), { attemptMode: 'issue', candidateSource: 'transfer' })
  assert.throws(() => tickMode('seed'), /umbrella_mode_invalid/)
  assert.doesNotThrow(() =>
    validateIssue({ ...issue(), sequence: 1, targets: issue().targets.slice(0, 4) }),
  )
  const startedAtUtc = issued
  const attempt = {
    study: STUDY,
    kind: 'attempt',
    mode: tickMode('issue-seed').attemptMode,
    slot: Math.floor(Date.parse(startedAtUtc) / (30 * 60_000)),
    startedAtUtc,
    finishedAtUtc: startedAtUtc,
    status: 'failed',
    recordSequence: null,
    recordSha256: null,
  }
  assert.doesNotThrow(() => validateAttempt(attempt))
})

test('wrapper seed argument dispatches issue-seed with a 240-second 384 MiB limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-wrapper-'))
  try {
    const timeout = join(dir, 'timeout')
    const capture = join(dir, 'args')
    await writeFile(timeout, '#!/bin/sh\nprintf "%s\\n" "$@" > "$UMBRELLA_TEST_CAPTURE"\n', {
      mode: 0o700,
    })
    const wrapper = join(import.meta.dirname, '..', 'carry-local-umbrella-gho-holder-tick.sh')
    const run = spawnSync('/bin/sh', [wrapper, 'seed', '--locked'], {
      env: {
        ...process.env,
        UMBRELLA_HOLDER_TIMEOUT_BIN: timeout,
        UMBRELLA_HOLDER_NODE_BIN: '/usr/bin/false',
        UMBRELLA_TEST_CAPTURE: capture,
      },
      encoding: 'utf8',
    })
    assert.equal(run.status, 0)
    assert.match(run.stdout, /umbrella-holder:seed:ok/)
    const args = (await readFile(capture, 'utf8')).trim().split('\n')
    assert.deepEqual(args.slice(0, 5), [
      '-k',
      '5s',
      '240s',
      '/usr/bin/false',
      '--max-old-space-size=384',
    ])
    assert.equal(args.at(-1), 'issue-seed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('campaign wrapper uses frozen seed, bounded score, and a nonzero busy result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-campaign-wrapper-'))
  try {
    const timeout = join(dir, 'timeout')
    const capture = join(dir, 'args')
    const wrapper = join(import.meta.dirname, '..', 'carry-local-umbrella-gho-holder-tick.sh')
    await writeFile(timeout, '#!/bin/sh\nprintf "%s\\n" "$@" > "$UMBRELLA_TEST_CAPTURE"\n', {
      mode: 0o700,
    })
    for (const [mode, limit, cliMode] of [
      ['issue-campaign', '500s', 'issue-seed'],
      ['score-campaign', '450s', 'score'],
    ]) {
      const run = spawnSync('/bin/sh', [wrapper, mode, '--locked'], {
        env: {
          ...process.env,
          UMBRELLA_HOLDER_TIMEOUT_BIN: timeout,
          UMBRELLA_HOLDER_NODE_BIN: '/usr/bin/false',
          UMBRELLA_TEST_CAPTURE: capture,
        },
        encoding: 'utf8',
      })
      assert.equal(run.status, 0)
      assert.match(run.stdout, new RegExp(`umbrella-holder:${mode}:ok`))
      const args = (await readFile(capture, 'utf8')).trim().split('\n')
      assert.equal(args[2], limit)
      assert.equal(args[4], '--max-old-space-size=384')
      assert.equal(args.at(-1), cliMode)
    }
    const holdAndRun = `
import fcntl, json, os, subprocess
path = os.path.join(os.environ['TMPDIR'], 'membrane-local-umbrella-gho-holder.lock')
fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
statuses = []
for mode in ('issue-campaign', 'score-campaign', 'seed'):
    result = subprocess.run(['/bin/sh', os.environ['UMBRELLA_TEST_WRAPPER'], mode], capture_output=True, text=True)
    statuses.append([mode, result.returncode, result.stderr])
print(json.dumps(statuses))
`
    const locked = spawnSync('/usr/bin/python3', ['-c', holdAndRun], {
      env: { ...process.env, TMPDIR: dir, UMBRELLA_TEST_WRAPPER: wrapper },
      encoding: 'utf8',
    })
    assert.equal(locked.status, 0)
    assert.deepEqual(
      JSON.parse(locked.stdout).map(([mode, status]) => [mode, status]),
      [
        ['issue-campaign', 75],
        ['score-campaign', 75],
        ['seed', 0],
      ],
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('frozen seed fallback rejects unmeasured, attrited and altered provenance claims', async () => {
  const owners = readFrozenSeedCandidates()
  const client = {
    request: async () => '0x',
    readContract: async () => BigInt(SHARES_RAW),
  }
  const pair = [
    { source: 'source-a', client },
    { source: 'source-b', client: {} },
  ]
  await assert.rejects(
    findFrozenSeedCandidate(pair, block, [], async () => ({ ...measurement, holderEoa: false })),
    /umbrella_no_eligible_eoa/,
  )
  const found = await findFrozenSeedCandidate(pair, block, [], async () => measurement)
  const row = { ...issue(), holder: owners[0], selection: found.selection }
  assert.doesNotThrow(() => validateIssue(row))
  for (const selection of [
    { ...found.selection, seedSha256: '0'.repeat(64) },
    { ...found.selection, seedIndex: 1 },
    { ...found.selection, candidateSource: 'transfer' },
    {
      ...found.selection,
      candidateSource: undefined,
      samplingRule: 'first_window_open_else_first_eligible_eoa',
    },
    {
      samplingRule: 'first_window_open_else_first_eligible_eoa',
      candidatesChecked: 1,
      eligibleTested: 1,
    },
  ]) {
    assert.throws(() => validateIssue({ ...row, selection }), /umbrella_issue_invalid/)
  }
  assert.throws(
    () => validateIssue({ ...row, measurement: { ...measurement, holderSharesRaw: '0' } }),
    /umbrella_issue_invalid/,
  )
  assert.throws(
    () =>
      validateIssue({
        ...issue(),
        selection: { ...issue().selection, seedIndex: 0 },
      }),
    /umbrella_issue_invalid/,
  )
})

test('SHA-resealed seed issue cannot masquerade as a legacy Transfer issue', async () => {
  const owners = readFrozenSeedCandidates()
  const client = {
    request: async () => '0x',
    readContract: async () => BigInt(SHARES_RAW),
  }
  const pair = [
    { source: 'source-a', client },
    { source: 'source-b', client: {} },
  ]
  const found = await findFrozenSeedCandidate(pair, block, [], async () => measurement)
  const body = {
    ...issue(),
    holder: owners[0],
    selection: {
      ...found.selection,
      candidateSource: undefined,
      samplingRule: 'first_window_open_else_first_eligible_eoa',
    },
    sequence: 1,
    previousSha256: null,
  }
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-relabel-'))
  try {
    await writeFile(
      join(dir, '00000001.json'),
      `${JSON.stringify({ ...body, sha256: hash(JSON.stringify(body)) })}\n`,
    )
    await assert.rejects(readChain(dir, validateIssue), /umbrella_issue_invalid/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('private hash chain rejects changed records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'umbrella-ledger-'))
  try {
    const row = await appendChain(
      dir,
      { study: STUDY, kind: 'issue', value: 1 },
      () => {},
      () => ({ bavail: 2_000_000, bsize: 1024 }),
    )
    const read = await readChain(dir, () => {})
    assert.equal(read.length, 1)
    assert.equal(read[0].sha256, row.sha256)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
