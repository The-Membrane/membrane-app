import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { freezeDirectQLadder } from '../lib/carry-exit-v2-direct-issuer-prep.mjs'
import {
  appendPublicDirectIssue,
  buildPublicDirectIssue,
  configuredPublicRpcUrls,
  DIRECT_MARKETS,
  HORIZONS_HOURS,
  issuePublicDirectExit,
  publicRpcClients,
  slicedCandidateRequest,
  verifyPublicDirectIssues,
} from './carry-public-direct-exit-issue.mjs'

const sha = (value) => createHash('sha256').update(value).digest('hex')
const HASH = `0x${'a'.repeat(64)}`
const HOLDER = `0x${'b'.repeat(40)}`
const ISSUED = '2026-09-30T06:15:00.000Z'
const word = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`
const addressWord = (address) => address.slice(2).padStart(64, '0')

function fixture(marketKey = 'aaveV3Usdc', issuedAtUtc = ISSUED) {
  const route = DIRECT_MARKETS[marketKey]
  const baseline = {
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    kind: route.kind,
    targetBlock: '26080000',
    targetHash: HASH,
    targetParentBlock: '26079999',
    targetParentHash: `0x${'c'.repeat(64)}`,
    targetBlockAt: '2026-09-30T06:05:00.000Z',
    targetObservedAt: '2026-09-30T06:10:00.000Z',
    marketSupplyRaw: '1000000',
    assetDecimals: 6,
    canonicalityEvidenceDoc: {
      schema: 'carry_exit_v2_headers_v1',
      provider: 'https://origin-one.example',
      observedAt: '2026-09-30T06:10:00.000Z',
      targetHeader: {
        number: '26080000',
        hash: HASH,
        parentHash: `0x${'c'.repeat(64)}`,
        timestamp: '2026-09-30T06:05:00.000Z',
      },
      parentHeader: {
        number: '26079999',
        hash: `0x${'c'.repeat(64)}`,
        parentHash: `0x${'d'.repeat(64)}`,
        timestamp: '2026-09-30T06:04:48.000Z',
      },
    },
  }
  const ladder = freezeDirectQLadder({
    marketSupplyRaw: baseline.marketSupplyRaw,
    selectedAssetBalanceRaw: '500',
  })
  const candidate = {
    holder: HOLDER,
    evidenceDoc: {
      schema: 'carry_exit_v2_direct_candidate_v1',
      routeKey: route.routeKey,
      destination: route.destination,
      asset: route.asset,
      baselineBlock: baseline.targetBlock,
      baselineHash: HASH,
      parentHash: baseline.targetParentHash,
      baselineState: {
        marketSupplyRaw: baseline.marketSupplyRaw,
        assetDecimals: baseline.assetDecimals,
      },
      selectedHolderCommitment: sha(`${route.destination}:${HOLDER}`),
      selectedAssetBalanceRaw: '500',
      ladder,
    },
  }
  const baselineWitness = {
    provider: 'https://origin-two.example',
    block: baseline.targetBlock,
    hash: HASH,
    marketSupplyRaw: baseline.marketSupplyRaw,
    assetDecimals: 6,
    underlying: route.asset,
    observedAtUtc: '2026-09-30T06:12:00.000Z',
  }
  return { marketKey, baseline, baselineWitness, candidate, measurements: {}, issuedAtUtc }
}

const issue = (values = {}) =>
  buildPublicDirectIssue({ ...fixture(), sequence: 1, previousSha256: null, ...values })

test('baseline witness must use a distinct RPC host, not another URL on the same host', () => {
  const values = fixture()
  assert.throws(
    () =>
      issue({
        baselineWitness: {
          ...values.baselineWitness,
          provider: 'https://www.origin-one.example/alternate-path',
        },
      }),
    /public_issue_witness_invalid/,
  )
})

function measuredFixture(values, assetsRaw) {
  const route = DIRECT_MARKETS[values.marketKey]
  const balance = '500'
  const rpc = (id, target, data, result, extra = {}) => ({
    provider: values.baseline.canonicalityEvidenceDoc.provider,
    source: 'carry_public_direct_exit_issue_v1',
    callTarget: target,
    request: {
      jsonrpc: '2.0',
      id,
      method: 'eth_call',
      params: [
        { from: HOLDER, to: target, data },
        { blockHash: HASH, requireCanonical: true },
      ],
    },
    response: { jsonrpc: '2.0', id, result },
    ...extra,
  })
  const evidence = {
    schema: 'carry_exit_v2_proof_v1',
    purpose: 'call',
    chainId: '1',
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    holder: HOLDER,
    caller: HOLDER,
    assetsRaw,
    blockNumber: values.baseline.targetBlock,
    blockHash: HASH,
    coverageKind: 'assets',
    holderCoverageRaw: balance,
    requiredCoverageRaw: assetsRaw,
    actualConsumedRaw: null,
    simulationStatus: 'success',
    holderCoverageRpc: rpc(
      1,
      route.destination,
      `0x70a08231${addressWord(HOLDER)}`,
      word(balance),
      { decodedRaw: balance },
    ),
    requiredCoverageRpc: null,
    withdrawRpc: rpc(
      2,
      route.withdrawTarget,
      `0x69328dec${addressWord(route.asset)}${word(assetsRaw).slice(2)}${addressWord(HOLDER)}`,
      word(assetsRaw),
      { decodedAssetsRaw: assetsRaw, decodedConsumedRaw: null },
    ),
    verificationStatus: 'verified',
    identityEvidence: {
      chainId: '1',
      kind: route.kind,
      routeKey: route.routeKey,
      destination: route.destination,
      asset: route.asset,
      holder: HOLDER,
      blockNumber: values.baseline.targetBlock,
      blockHash: HASH,
      provider: values.baseline.canonicalityEvidenceDoc.provider,
    },
    replayEvidenceDoc: {
      blockNumber: values.baseline.targetBlock,
      blockHash: HASH,
      observedAt: '2026-09-30T06:14:00.000Z',
      origins: {
        primary: values.baseline.canonicalityEvidenceDoc.provider,
        secondary: values.baselineWitness.provider,
      },
      decoded: {
        holderCoverageRaw: balance,
        requiredCoverageRaw: assetsRaw,
        actualConsumedRaw: null,
        simulationStatus: 'success',
        coveredRevert: false,
      },
    },
  }
  return {
    status: 'success',
    holderCoverageRaw: balance,
    actualConsumedRaw: null,
    coveredRevert: false,
    evidence,
    evidenceSha256: sha(JSON.stringify(evidence)),
  }
}

test('freezes original asset, exact route, six labels, five future target/deadline pairs, and local clock', () => {
  for (const marketKey of ['aaveV3Usdc', 'aaveV3Usde', 'sparkLendUsdt']) {
    const row = buildPublicDirectIssue({
      ...fixture(marketKey),
      sequence: 1,
      previousSha256: null,
    })
    assert.equal(row.originalAsset, DIRECT_MARKETS[marketKey].asset)
    assert.equal(row.routeKey, DIRECT_MARKETS[marketKey].routeKey)
    assert.equal(row.candidate.holder, HOLDER)
    assert.equal(row.qLabels.length, 6)
    assert.equal(row.cases.length, 6)
    assert.deepEqual(
      row.targets.map((target) => target.horizonHours),
      HORIZONS_HOURS,
    )
    assert.equal(row.targetClockBasis, 'baseline_block_timestamp')
    assert.equal(row.targets[0].targetAtUtc, '2026-09-30T07:05:00.000Z')
    assert.equal(row.targets[0].captureDeadlineUtc, '2026-09-30T09:05:00.000Z')
    assert.equal(row.clock.kind, 'local_operator_clock')
    assert.equal(row.clock.independentWitness, null)
    assert.equal(row.clock.externalTimestampProof, false)
    assert.equal(row.candidate.representativeCensus, false)
    assert.ok(row.cases.some((entry) => entry.status === 'unavailable'))
    assert.ok(row.cases.some((entry) => entry.status === 'omitted'))
  }
})

test('Aave USDe cannot inherit the USDC route or original asset', () => {
  const usdc = DIRECT_MARKETS.aaveV3Usdc
  const usde = DIRECT_MARKETS.aaveV3Usde
  assert.equal(usde.routeKey, 'USDe → supply on Aave V3')
  assert.notEqual(usde.destination, usdc.destination)
  assert.notEqual(usde.asset, usdc.asset)
  const values = fixture('aaveV3Usde')
  values.baseline.destination = usdc.destination
  assert.throws(
    () => buildPublicDirectIssue({ ...values, sequence: 1, previousSha256: null }),
    /identity/,
  )
})

test('rejects issue before baseline observation and stale baseline after measurement', () => {
  assert.throws(() => issue({ issuedAtUtc: '2026-09-30T06:09:59.000Z' }), /asof/)
  assert.throws(() => issue({ issuedAtUtc: '2026-09-30T07:00:01.000Z' }), /asof/)
  const values = fixture()
  values.baseline.targetBlockAt = '2026-09-30T07:00:00.000Z'
  values.baseline.canonicalityEvidenceDoc.targetHeader.timestamp = values.baseline.targetBlockAt
  assert.throws(() => issue(values), /asof/)
  const noFutureTarget = fixture()
  noFutureTarget.baseline.targetBlockAt = '2026-09-30T05:15:00.000Z'
  assert.throws(() => issue(noFutureTarget), /asof/)
  const noTimestamp = fixture()
  noTimestamp.baseline.targetBlockAt = undefined
  assert.throws(() => issue(noTimestamp), /invalid_issue_clock/)
  const detachedTimestamp = fixture()
  detachedTimestamp.baseline.targetBlockAt = '2026-09-30T06:04:59.000Z'
  assert.throws(() => issue(detachedTimestamp), /identity/)
})

test('legacy missing clock basis keeps issued-time target grid and linked verification', async () => {
  const out = await mkdtemp(join(tmpdir(), 'public-direct-legacy-clock-'))
  const enoughDisk = () => ({ bavail: 2e9, bsize: 1 })
  try {
    const old = issue()
    delete old.targetClockBasis
    old.targets = HORIZONS_HOURS.map((hours) => ({
      horizonHours: hours,
      targetAtUtc: new Date(Date.parse(ISSUED) + hours * 3_600_000).toISOString(),
      captureDeadlineUtc: new Date(Date.parse(ISSUED) + (hours + 2) * 3_600_000).toISOString(),
    }))
    const { sha256: _oldSeal, ...oldBody } = old
    old.sha256 = sha(JSON.stringify(oldBody))
    await appendPublicDirectIssue(old, out, enoughDisk)
    const next = buildPublicDirectIssue({
      ...fixture('sparkLendUsdt'),
      sequence: 2,
      previousSha256: old.sha256,
    })
    const invalid = { ...next, targetClockBasis: 'issued_at_time' }
    await assert.rejects(appendPublicDirectIssue(invalid, out, enoughDisk), /identity/)
    await appendPublicDirectIssue(next, out, enoughDisk)
    const replayed = await verifyPublicDirectIssues(out)
    assert.equal(replayed.length, 2)
    assert.equal(replayed[0].targets[0].targetAtUtc, '2026-09-30T07:15:00.000Z')
    assert.equal(replayed[1].targets[0].targetAtUtc, '2026-09-30T07:05:00.000Z')
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('rejects altered route, original asset, Q ladder, and local clock witness claim', () => {
  const row = issue()
  assert.notEqual(row.originalAsset, DIRECT_MARKETS.sparkLendUsdt.asset)
  const wrongAsset = structuredClone(fixture())
  wrongAsset.baseline.asset = DIRECT_MARKETS.sparkLendUsdt.asset
  assert.throws(() => issue(wrongAsset), /identity/)
  const wrongLadder = structuredClone(fixture())
  wrongLadder.candidate.evidenceDoc.ladder.labels[0].assetsRaw = '999'
  assert.throws(() => issue(wrongLadder), /candidate/)
  const externalClock = { ...row, clock: { ...row.clock, externalTimestampProof: true } }
  assert.rejects(async () => {
    const out = await mkdtemp(join(tmpdir(), 'public-direct-clock-'))
    try {
      await appendPublicDirectIssue(externalClock, out, () => ({ bavail: 2e9, bsize: 1 }))
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  }, /identity/)
})

test('measured proof binds exact Q, route, block and result; swapped Q is rejected', () => {
  const values = fixture()
  const labels = values.candidate.evidenceDoc.ladder.labels
  const first = labels.find((label) => label.assetsRaw === '10')
  const other = labels.find((label) => label.assetsRaw === '100')
  assert.ok(first && other)
  const measurement = measuredFixture(values, first.assetsRaw)
  values.measurements[first.label] = measurement
  const valid = issue(values)
  assert.equal(valid.cases.find((row) => row.label === first.label).status, 'measured')
  const swapped = structuredClone(values)
  swapped.measurements[other.label] = swapped.measurements[first.label]
  delete swapped.measurements[first.label]
  assert.throws(() => issue(swapped), /case_invalid/)
  const wrongStatus = structuredClone(values)
  wrongStatus.measurements[first.label].status = 'evm_revert'
  assert.throws(() => issue(wrongStatus), /case_invalid/)
  const wrongBlock = structuredClone(values)
  wrongBlock.measurements[first.label].evidence.identityEvidence.blockNumber = '26080001'
  wrongBlock.measurements[first.label].evidenceSha256 = sha(
    JSON.stringify(wrongBlock.measurements[first.label].evidence),
  )
  assert.throws(() => issue(wrongBlock), /case_invalid/)
})

test('append is exclusive, fsynced, hash-linked, and duplicate route-slot is refused', async () => {
  const out = await mkdtemp(join(tmpdir(), 'public-direct-append-'))
  const enoughDisk = () => ({ bavail: 2e9, bsize: 1 })
  try {
    const first = issue()
    await appendPublicDirectIssue(first, out, enoughDisk)
    assert.equal((await verifyPublicDirectIssues(out)).length, 1)
    const second = buildPublicDirectIssue({
      ...fixture('sparkLendUsdt'),
      sequence: 2,
      previousSha256: first.sha256,
    })
    await appendPublicDirectIssue(second, out, enoughDisk)
    assert.equal((await verifyPublicDirectIssues(out)).length, 2)
    const duplicate = buildPublicDirectIssue({
      ...fixture(),
      sequence: 3,
      previousSha256: second.sha256,
    })
    await assert.rejects(() => appendPublicDirectIssue(duplicate, out, enoughDisk), /duplicate/)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('offline verifier detects payload edits even when canonical JSON is preserved', async () => {
  const out = await mkdtemp(join(tmpdir(), 'public-direct-tamper-'))
  try {
    await appendPublicDirectIssue(issue(), out, () => ({ bavail: 2e9, bsize: 1 }))
    const path = join(out, '00000001.json')
    const saved = JSON.parse(await readFile(path, 'utf8'))
    saved.originalAsset = DIRECT_MARKETS.sparkLendUsdt.asset
    await writeFile(path, `${JSON.stringify(saved)}\n`)
    await assert.rejects(() => verifyPublicDirectIssues(out), /identity/)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('resealed selected candidate baseline block, parent, or state cannot detach from issue', async () => {
  const out = await mkdtemp(join(tmpdir(), 'public-direct-candidate-binding-'))
  try {
    await appendPublicDirectIssue(issue(), out, () => ({ bavail: 2e9, bsize: 1 }))
    const path = join(out, '00000001.json')
    const original = JSON.parse(await readFile(path, 'utf8'))
    for (const mutate of [
      (doc) => {
        doc.baselineBlock = '26079999'
      },
      (doc) => {
        doc.parentHash = `0x${'d'.repeat(64)}`
      },
      (doc) => {
        doc.baselineState.marketSupplyRaw = '999999'
      },
      (doc) => {
        doc.baselineState.assetDecimals = 18
      },
    ]) {
      const altered = structuredClone(original)
      mutate(altered.candidate.evidenceDoc)
      altered.candidate.evidenceSha256 = sha(JSON.stringify(altered.candidate.evidenceDoc))
      const { sha256: _old, ...body } = altered
      altered.sha256 = sha(JSON.stringify(body))
      await writeFile(path, `${JSON.stringify(altered)}\n`)
      await assert.rejects(() => verifyPublicDirectIssues(out), /public_issue_candidate_invalid/)
    }
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('interrupted temp publication leaves no authoritative issue or stale lock', async () => {
  const out = await mkdtemp(join(tmpdir(), 'public-direct-interrupted-'))
  const enoughDisk = () => ({ bavail: 2e9, bsize: 1 })
  try {
    await writeFile(join(out, '.issue-crash.tmp'), '{partial')
    assert.deepEqual(await verifyPublicDirectIssues(out), [])
    await assert.rejects(
      () =>
        appendPublicDirectIssue(issue(), out, enoughDisk, {
          linkFile: async () => {
            throw Error('simulated_crash_before_publication')
          },
        }),
      /simulated_crash/,
    )
    assert.deepEqual(await verifyPublicDirectIssues(out), [])
    assert.equal((await readdir(out)).includes('00000001.json'), false)
    assert.equal((await readdir(out)).includes('.issue.lock'), false)
    await appendPublicDirectIssue(issue(), out, enoughDisk)
    assert.equal((await verifyPublicDirectIssues(out)).length, 1)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('offline injected issue never reads future targets or any private DB', async () => {
  const out = await mkdtemp(join(tmpdir(), 'public-direct-no-db-'))
  const values = fixture()
  const calls = []
  const clients = [
    { provider: 'https://one.example', request: async (method) => calls.push(method) },
    { provider: 'https://two.example', request: async (method) => calls.push(method) },
  ]
  try {
    const result = await issuePublicDirectExit({
      marketKey: values.marketKey,
      clients,
      out,
      now: () => new Date(ISSUED),
      capture: async () => values.baseline,
      discover: async () => values.candidate,
      witness: async () => values.baselineWitness,
      measure: async () => {
        throw Error('offline unavailable')
      },
      append: (row, path) => appendPublicDirectIssue(row, path, () => ({ bavail: 2e9, bsize: 1 })),
    })
    assert.equal(result.sequence, 1)
    assert.deepEqual(calls, [])
    assert.equal((await verifyPublicDirectIssues(out)).length, 1)
    const source = await readFile(
      new URL('./carry-public-direct-exit-issue.mjs', import.meta.url),
      'utf8',
    )
    assert.doesNotMatch(source, /@neondatabase|DATABASE_URL|PRIVATE_DB|SELECT\s|INSERT\s/i)
    assert.doesNotMatch(
      source,
      /record-carry-direct-exit-v2-issues|check-carry-direct-exit-v2-issue-rollback/,
    )
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('failed bounded candidate scan becomes an explicit unavailable issue', async () => {
  const out = await mkdtemp(join(tmpdir(), 'public-direct-candidate-failure-'))
  const values = fixture()
  const clients = [
    { provider: 'https://one.example', request: async () => {} },
    { provider: 'https://two.example', request: async () => {} },
  ]
  try {
    await issuePublicDirectExit({
      marketKey: values.marketKey,
      clients,
      out,
      now: () => new Date(ISSUED),
      capture: async () => values.baseline,
      discover: async () => {
        throw Error('provider url with secret-key')
      },
      witness: async () => values.baselineWitness,
      append: (row, path) => appendPublicDirectIssue(row, path, () => ({ bavail: 2e9, bsize: 1 })),
    })
    const saved = (await verifyPublicDirectIssues(out))[0]
    assert.equal(saved.candidate.status, 'unavailable')
    assert.equal(saved.candidate.evidenceDoc.unavailableReason, 'candidate_scan_unavailable')
    assert.equal(saved.candidate.evidenceDoc.baselineBlock, values.baseline.targetBlock)
    assert.equal(saved.cases.filter((entry) => entry.status === 'unavailable').length, 5)
    assert.doesNotMatch(JSON.stringify(saved), /secret-key/)
    const changed = structuredClone(saved)
    changed.candidate.evidenceDoc.baselineBlock = '26079999'
    changed.candidate.evidenceSha256 = sha(JSON.stringify(changed.candidate.evidenceDoc))
    const { sha256: _old, ...body } = changed
    changed.sha256 = sha(JSON.stringify(body))
    await writeFile(join(out, '00000001.json'), `${JSON.stringify(changed)}\n`)
    await assert.rejects(() => verifyPublicDirectIssues(out), /public_issue_candidate_invalid/)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('rotates away from failed candidate origin before sealing an unavailable issue', async () => {
  const out = await mkdtemp(join(tmpdir(), 'public-direct-rotate-'))
  const values = fixture()
  const clients = ['one', 'two', 'three'].map((name) => ({
    provider: `https://${name}.example`,
    request: async () => name,
  }))
  const attempted = []
  try {
    await issuePublicDirectExit({
      marketKey: values.marketKey,
      clients,
      out,
      now: () => new Date(ISSUED),
      capture: async ({ provider }) => ({
        ...values.baseline,
        canonicalityEvidenceDoc: {
          ...values.baseline.canonicalityEvidenceDoc,
          provider,
        },
      }),
      witness: async (route, baseline, secondary) => ({
        ...values.baselineWitness,
        provider: secondary.provider,
      }),
      discover: async ({ request }) => {
        const name = await request('who', [])
        attempted.push(name)
        if (name === 'one') throw Error('provider unavailable')
        return values.candidate
      },
      measure: async () => {
        throw Error('offline unavailable')
      },
      append: (row, path) => appendPublicDirectIssue(row, path, () => ({ bavail: 2e9, bsize: 1 })),
    })
    const saved = (await verifyPublicDirectIssues(out))[0]
    assert.deepEqual(attempted, ['one', 'two'])
    assert.equal(saved.candidate.status, 'selected')
    assert.equal(saved.baseline.canonicalityEvidenceDoc.provider, 'https://two.example')
    assert.equal(saved.baselineWitness.provider, 'https://one.example')
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('public transport refuses one host and never returns vendor error details', async () => {
  assert.throws(
    () => publicRpcClients(['https://one.example/key-a', 'https://one.example/key-b']),
    /independent/,
  )
  const clients = publicRpcClients(
    ['https://one.example/secret-one', 'https://two.example/secret-two'],
    async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32000, message: 'vendor key secret-one at /secret-two' },
        }),
    }),
  )
  const response = await clients[0].send({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_chainId',
    params: [],
  })
  assert.equal(response.error.message, 'public rpc error')
  assert.doesNotMatch(JSON.stringify(response), /secret/)
})

test('CLI RPC settings use readEnv().get with process override', () => {
  const env = {
    get: (key) =>
      key === 'RECORDER_RPC_URLS' ? 'https://one.example/key,https://two.example/key' : undefined,
  }
  assert.deepEqual(configuredPublicRpcUrls(env, {}), [
    'https://one.example/key',
    'https://two.example/key',
  ])
  assert.deepEqual(
    configuredPublicRpcUrls(env, {
      RECORDER_RPC_URLS: 'https://three.example/key,https://four.example/key',
    }),
    ['https://three.example/key', 'https://four.example/key'],
  )
  assert.deepEqual(
    configuredPublicRpcUrls(
      {
        get: () => 'https://one.example/a,https://one.example/b,https://two.example/c',
      },
      {},
    ).length,
    3,
  )
})

test('candidate log adapter covers the exact range in at most ten-block public calls', async () => {
  const ranges = []
  const request = slicedCandidateRequest({
    request: async (method, [filter]) => {
      assert.equal(method, 'eth_getLogs')
      ranges.push([BigInt(filter.fromBlock), BigInt(filter.toBlock)])
      return [{ marker: ranges.length }]
    },
  })
  const logs = await request('eth_getLogs', [{ fromBlock: '0x64', toBlock: '0x88' }])
  assert.deepEqual(ranges, [
    [100n, 109n],
    [110n, 119n],
    [120n, 129n],
    [130n, 136n],
  ])
  assert.equal(logs.length, 4)
  await assert.rejects(
    () => request('eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x200' }]),
    /range_invalid/,
  )
})
