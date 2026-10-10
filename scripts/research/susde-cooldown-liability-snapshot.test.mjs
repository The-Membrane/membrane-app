import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeFunctionData, encodeFunctionResult, parseAbi } from 'viem'

import {
  FIRST_CODE_BLOCK,
  ROUTE as CENSUS_ROUTE,
  STUDY as CENSUS_STUDY,
  logSetDigest,
} from './susde-cooldown-owner-census.mjs'
import { buildSusdeCooldownOwnerManifest } from './susde-cooldown-owner-manifest.mjs'
import { ROUTE } from './susde-public-initiation-common.mjs'
import {
  loadSusdeLiabilitySources,
  readSusdeCooldownLiabilitySegment,
  runSusdeLiabilityCli,
  susdeLiabilityCliOptions,
  susdeLiabilityFixtureRuntime,
  verifySusdeCooldownLiabilitySegment as verifyProductionSegment,
  writeNewSusdeCooldownLiabilitySegment,
} from './susde-cooldown-liability-snapshot.mjs'

const {
  capture: captureSusdeCooldownLiabilitySegment,
  stitch: stitchSusdeCooldownLiabilitySegments,
  verify: verifySusdeCooldownLiabilitySegment,
} = susdeLiabilityFixtureRuntime('0x6000')

const C = FIRST_CODE_BLOCK
const CONTRACT = '0x4444444444444444444444444444444444444444'
const EOA = '0x2222222222222222222222222222222222222222'
const sha = (value) => createHash('sha256').update(value).digest('hex')
const hash = (n) =>
  n === C ? CENSUS_ROUTE.firstCodeHash : `0x${BigInt(n).toString(16).padStart(64, '0')}`
const seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const abi = parseAbi([
  'function cooldowns(address) view returns (uint104 cooldownEnd,uint256 underlyingAmount)',
  'function balanceOf(address) view returns (uint256)',
  'function asset() view returns (address)',
  'function silo() view returns (address)',
  'function cooldownDuration() view returns (uint24)',
])
function fixture() {
  const logs = [CONTRACT, EOA].map((owner, index) => ({
    blockNumber: C + index,
    blockHash: hash(C + index),
    transactionHash: hash(999 + index),
    transactionIndex: 0,
    logIndex: index,
    sender: '0x1111111111111111111111111111111111111111',
    receiver: CENSUS_ROUTE.silo,
    owner,
    assetsRaw: '700',
    sharesRaw: '500',
  }))
  const start = { number: C, hash: hash(C), parentHash: hash(C - 1), timestamp: 1_700_000_000 }
  const end = { number: C + 1, hash: hash(C + 1), parentHash: hash(C), timestamp: 1_700_000_001 }
  const body = {
    study: CENSUS_STUDY,
    version: 1,
    chainId: 1,
    route: CENSUS_ROUTE,
    fromBlock: C,
    toBlock: C + 1,
    windowBlocks: 10_000,
    originHosts: ['mainnet.infura.io', 'rpc.ankr.com'],
    originAgreement: 'exact_normalized_log_rows_and_boundary_headers',
    windows: [
      { fromBlock: C, toBlock: C + 1, start, end, logCount: 2, logSetSha256: logSetDigest(logs) },
    ],
    logs,
    logSetSha256: logSetDigest(logs),
    capturedAtUtc: '2026-10-03T00:00:00.000Z',
    interpretation: 'candidate_owners_only_not_outstanding_cooldowns_or_provider_independence',
  }
  const artifacts = [seal(body)]
  const manifest = buildSusdeCooldownOwnerManifest({
    artifacts,
    cutoffBlock: C + 1,
    cutoffHash: hash(C + 1),
  })
  return { artifacts, manifest }
}
function client(
  provider,
  amountByOwner = { [EOA]: 7n, [CONTRACT]: 11n },
  cash = 15n,
  endByOwner = { [EOA]: 1_600_000_000n, [CONTRACT]: 1_800_000_000n },
  duration = 7 * 24 * 60 * 60,
) {
  return {
    provider,
    async send({ id, method, params }) {
      let result
      if (method === 'eth_chainId') result = '0x1'
      else if (method === 'eth_getCode') {
        assert.deepEqual(params, [ROUTE.vault, { blockHash: hash(C + 1), requireCanonical: true }])
        result = '0x6000'
      } else if (method === 'eth_getBlockByNumber')
        result = { number: `0x${(C + 1).toString(16)}`, hash: hash(C + 1), timestamp: '0x6553f100' }
      else if (method === 'eth_call') {
        assert.deepEqual(params[1], { blockHash: hash(C + 1), requireCanonical: true })
        const { to, data } = params[0]
        if (to === ROUTE.asset) {
          assert.equal(
            data,
            encodeFunctionData({ abi, functionName: 'balanceOf', args: [ROUTE.silo] }),
          )
          result = encodeFunctionResult({ abi, functionName: 'balanceOf', result: cash })
        } else {
          assert.equal(to, ROUTE.vault)
          if (data === encodeFunctionData({ abi, functionName: 'asset' })) {
            result = encodeFunctionResult({ abi, functionName: 'asset', result: ROUTE.asset })
          } else if (data === encodeFunctionData({ abi, functionName: 'silo' })) {
            result = encodeFunctionResult({ abi, functionName: 'silo', result: ROUTE.silo })
          } else if (data === encodeFunctionData({ abi, functionName: 'cooldownDuration' })) {
            result = encodeFunctionResult({
              abi,
              functionName: 'cooldownDuration',
              result: duration,
            })
          } else {
            const owner = Object.keys(amountByOwner).find(
              (candidate) =>
                data === encodeFunctionData({ abi, functionName: 'cooldowns', args: [candidate] }),
            )
            assert.ok(owner)
            result = encodeFunctionResult({
              abi,
              functionName: 'cooldowns',
              result: [endByOwner[owner], amountByOwner[owner]],
            })
          }
        }
      } else throw Error('unexpected RPC')
      return { jsonrpc: '2.0', id, result }
    },
  }
}
const inputs = (fixtureValue, clients, fromIndex, count) => ({
  ...fixtureValue,
  clients,
  fromIndex,
  count,
  anchorNumber: fixtureValue.manifest.toBlock,
  anchorHash: fixtureValue.manifest.cutoffHash,
})

test('pinned dual-host segment includes a contract owner and exact decoded agreement', async () => {
  const value = fixture()
  const clients = [client('https://infura.io'), client('https://ankr.com')]
  const segment = await captureSusdeCooldownLiabilitySegment(inputs(value, clients, 0, 2))
  assert.deepEqual(
    segment.rows.map((row) => row.owner),
    [EOA, CONTRACT],
  )
  assert.equal(segment.pendingUsdeRaw, '18')
  assert.equal(segment.siloUsdeRaw, '15')
  assert.equal(verifySusdeCooldownLiabilitySegment(segment, value), segment)
  const stitched = stitchSusdeCooldownLiabilitySegments([segment], value)
  assert.equal(stitched.coverage, 'complete')
  assert.equal(stitched.anchorLiabilityUsdeRaw, '18')
  assert.equal(stitched.cashShortfallUsdeRaw, '3')
  assert.equal(stitched.anchorTimestamp, '1700000000')
  assert.deepEqual(stitched.cooldownEndBuckets, [
    {
      cooldownEnd: '1600000000',
      ownerCount: 1,
      pendingUsdeRaw: '7',
      eligibility: 'eligible_at_anchor',
    },
    {
      cooldownEnd: '1800000000',
      ownerCount: 1,
      pendingUsdeRaw: '11',
      eligibility: 'future_at_anchor',
    },
  ])
  assert.equal(stitched.eligiblePendingUsdeRaw, '7')
  assert.equal(stitched.futurePendingUsdeRaw, '11')
})

test('partial remains partial; contiguous exact coverage can be stitched offline', async () => {
  const value = fixture()
  const clients = [client('https://infura.io'), client('https://ankr.com')]
  const first = await captureSusdeCooldownLiabilitySegment(inputs(value, clients, 0, 1))
  const second = await captureSusdeCooldownLiabilitySegment(inputs(value, clients, 1, 1))
  assert.equal(stitchSusdeCooldownLiabilitySegments([first], value).anchorLiabilityUsdeRaw, null)
  assert.equal(stitchSusdeCooldownLiabilitySegments([first], value).cooldownEndBuckets, null)
  assert.equal(stitchSusdeCooldownLiabilitySegments([second, first], value).coverage, 'complete')
  assert.throws(
    () => stitchSusdeCooldownLiabilitySegments([first, first], value),
    /segment_overlap/,
  )
  assert.throws(() => stitchSusdeCooldownLiabilitySegments([second], value), /segment_gap/)
})

test('owners at the same exact cooldown end share one bucket', async () => {
  const value = fixture()
  const ends = { [EOA]: 1_600_000_000n, [CONTRACT]: 1_600_000_000n }
  const clients = [
    client('https://infura.io', undefined, 15n, ends),
    client('https://ankr.com', undefined, 15n, ends),
  ]
  const segment = await captureSusdeCooldownLiabilitySegment(inputs(value, clients, 0, 2))
  const stitched = stitchSusdeCooldownLiabilitySegments([segment], value)
  assert.deepEqual(stitched.cooldownEndBuckets, [
    {
      cooldownEnd: '1600000000',
      ownerCount: 2,
      pendingUsdeRaw: '18',
      eligibility: 'eligible_at_anchor',
    },
  ])
  assert.equal(stitched.futurePendingUsdeRaw, '0')
})

test('zero cooldown duration makes future-end queues eligible at the anchor', async () => {
  const value = fixture()
  const clients = [
    client('https://infura.io', undefined, 15n, undefined, 0),
    client('https://ankr.com', undefined, 15n, undefined, 0),
  ]
  const segment = await captureSusdeCooldownLiabilitySegment(inputs(value, clients, 0, 2))
  const stitched = stitchSusdeCooldownLiabilitySegments([segment], value)
  assert.equal(stitched.cooldownDurationSeconds, '0')
  assert.equal(stitched.eligiblePendingUsdeRaw, '18')
  assert.equal(stitched.futurePendingUsdeRaw, '0')
  assert.deepEqual(
    stitched.cooldownEndBuckets.map((bucket) => bucket.eligibility),
    ['eligible_at_anchor', 'eligible_at_anchor'],
  )
})

test('positive pending queue with zero cooldown end fails closed', async () => {
  const value = fixture()
  const clients = [
    client('https://infura.io', undefined, 15n, { [EOA]: 0n, [CONTRACT]: 1_800_000_000n }),
    client('https://ankr.com', undefined, 15n, { [EOA]: 0n, [CONTRACT]: 1_800_000_000n }),
  ]
  await assert.rejects(
    captureSusdeCooldownLiabilitySegment(inputs(value, clients, 0, 1)),
    /queue_state_invalid/,
  )
})

test('source mutation, wrong anchor, host disagreement, and resealed evidence tampering fail', async () => {
  const value = fixture()
  const clients = [client('https://infura.io'), client('https://ankr.com')]
  await assert.rejects(
    captureSusdeCooldownLiabilitySegment({ ...inputs(value, clients, 0, 1), anchorHash: hash(C) }),
    /anchor_mismatch/,
  )
  await assert.rejects(
    captureSusdeCooldownLiabilitySegment(
      inputs(
        value,
        [client('https://infura.io'), client('https://ankr.com', { [EOA]: 8n, [CONTRACT]: 11n })],
        0,
        1,
      ),
    ),
    /origin_disagreement/,
  )
  const segment = await captureSusdeCooldownLiabilitySegment(inputs(value, clients, 0, 1))
  const changed = structuredClone(segment)
  changed.hosts[1].rows[0].cooldownRaw = encodeFunctionResult({
    abi,
    functionName: 'cooldowns',
    result: [123n, 8n],
  })
  const { sha256: _old, ...body } = changed
  changed.sha256 = sha(JSON.stringify(body))
  assert.throws(() => verifySusdeCooldownLiabilitySegment(changed, value), /origin_disagreement/)
  const missingSource = { ...value, artifacts: [] }
  assert.throws(
    () => verifySusdeCooldownLiabilitySegment(segment, missingSource),
    /source_required/,
  )
  const mutated = structuredClone(value.artifacts)
  mutated[0].logs[0].owner = EOA
  assert.throws(
    () =>
      verifySusdeCooldownLiabilitySegment(segment, {
        manifest: value.manifest,
        artifacts: mutated,
      }),
    /artifact_seal_invalid/,
  )
})

test('production verifier rejects synthetic vault code and changed pinned identity', async () => {
  const value = fixture()
  const clients = [client('https://infura.io'), client('https://ankr.com')]
  const segment = await captureSusdeCooldownLiabilitySegment(inputs(value, clients, 0, 1))
  assert.throws(() => verifyProductionSegment(segment, value), /vault_identity_invalid/)
  const changed = structuredClone(segment)
  changed.hosts[0].assetRaw = encodeFunctionResult({ abi, functionName: 'asset', result: EOA })
  changed.hosts[1].assetRaw = changed.hosts[0].assetRaw
  const { sha256: _seal, ...body } = changed
  changed.sha256 = sha(JSON.stringify(body))
  assert.throws(() => verifySusdeCooldownLiabilitySegment(changed, value), /vault_identity_invalid/)
})

test('foreground file driver verifies source, writes once above floor, and rejects clobber', async () => {
  const value = fixture()
  const directory = await mkdtemp(join(tmpdir(), 'susde-liability-test-'))
  try {
    const sourceDirectory = join(directory, 'source')
    await mkdir(sourceDirectory)
    const manifestPath = join(directory, 'manifest.json')
    await writeFile(manifestPath, JSON.stringify(value.manifest))
    await writeFile(join(sourceDirectory, 'one.json'), JSON.stringify(value.artifacts[0]))
    assert.deepEqual(await loadSusdeLiabilitySources({ manifestPath, sourceDirectory }), value)
    const segment = await captureSusdeCooldownLiabilitySegment(
      inputs(value, [client('https://infura.io'), client('https://ankr.com')], 0, 1),
    )
    const out = join(directory, 'slices', 'one.json')
    await assert.rejects(
      writeNewSusdeCooldownLiabilitySegment(out, segment, { freeBytes: () => 0 }),
      /disk_floor/,
    )
    await writeNewSusdeCooldownLiabilitySegment(out, segment, {
      freeBytes: () => 2 * 1024 * 1024 * 1024,
    })
    assert.deepEqual(await readSusdeCooldownLiabilitySegment(out), segment)
    assert.equal((await readFile(out, 'utf8')).endsWith('\n'), true)
    await assert.rejects(
      writeNewSusdeCooldownLiabilitySegment(out, segment, {
        freeBytes: () => 2 * 1024 * 1024 * 1024,
      }),
      /EEXIST/,
    )
    const badManifest = { ...value.manifest, ownerSetSha256: '0'.repeat(64) }
    await writeFile(manifestPath, JSON.stringify(badManifest))
    await assert.rejects(
      loadSusdeLiabilitySources({ manifestPath, sourceDirectory }),
      /manifest_seal_invalid/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('capture CLI rejects an existing output before loading sources or calling RPC', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'susde-liability-existing-'))
  try {
    const outPath = join(directory, 'existing.json')
    await writeFile(outPath, 'sealed')
    await assert.rejects(
      runSusdeLiabilityCli({
        mode: '--capture',
        outPath,
        manifestPath: join(directory, 'missing-manifest.json'),
        sourceDirectory: join(directory, 'missing-sources'),
      }),
      /output_exists/,
    )
    assert.equal(await readFile(outPath, 'utf8'), 'sealed')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('CLI requires an exact bounded one-slice request or offline stitch inputs', () => {
  const hashValue = hash(C + 1)
  assert.deepEqual(
    susdeLiabilityCliOptions([
      '--capture',
      '--manifest=m.json',
      '--source-dir=source',
      '--from-index=0',
      '--count=32',
      `--anchor-number=${C + 1}`,
      `--anchor-hash=${hashValue}`,
      '--out=slice.json',
    ]),
    {
      mode: '--capture',
      manifestPath: 'm.json',
      sourceDirectory: 'source',
      fromIndex: 0,
      count: 32,
      anchorNumber: C + 1,
      anchorHash: hashValue,
      outPath: 'slice.json',
    },
  )
  assert.deepEqual(
    susdeLiabilityCliOptions([
      '--stitch',
      '--manifest=m.json',
      '--source-dir=source',
      '--segments-dir=slices',
    ]),
    {
      mode: '--stitch',
      manifestPath: 'm.json',
      sourceDirectory: 'source',
      segmentsDirectory: 'slices',
    },
  )
  assert.throws(
    () =>
      susdeLiabilityCliOptions([
        '--capture',
        '--manifest=m.json',
        '--source-dir=source',
        '--from-index=0',
        '--count=33',
        `--anchor-number=${C + 1}`,
        `--anchor-hash=${hashValue}`,
        '--out=slice.json',
      ]),
    /usage_invalid/,
  )
})
