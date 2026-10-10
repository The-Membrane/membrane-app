import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FIRST_CODE_BLOCK,
  ROUTE,
  STUDY as SEGMENT_STUDY,
  logSetDigest,
  verifySusdeCooldownOwnerArtifact,
} from './susde-cooldown-owner-census.mjs'
import {
  STUDY,
  buildSusdeCooldownOwnerManifest,
  buildSusdeCooldownOwnerManifestFromDirectory,
  cliOptions,
  readSusdeCooldownOwnerManifest,
  verifySusdeCooldownOwnerManifest,
} from './susde-cooldown-owner-manifest.mjs'

const C = FIRST_CODE_BLOCK
const CONTRACT_OWNER = '0x4444444444444444444444444444444444444444'
const OTHER_OWNER = '0x2222222222222222222222222222222222222222'
const SENDER = '0x1111111111111111111111111111111111111111'
const hash = (number) =>
  number === C ? ROUTE.firstCodeHash : `0x${BigInt(number).toString(16).padStart(64, '0')}`
const sha = (value) => createHash('sha256').update(value).digest('hex')
const seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const header = (number, parentHash = hash(number - 1)) => ({
  number,
  hash: hash(number),
  parentHash,
  timestamp: 1_700_000_000 + number - C,
})

function segment({
  fromBlock,
  toBlock,
  owner,
  parentHash,
  firstHash,
  logBlock = fromBlock,
  logIndex = 0,
} = {}) {
  const start = header(fromBlock, parentHash)
  if (firstHash) start.hash = firstHash
  const end = header(toBlock)
  const logs = [
    {
      blockNumber: logBlock,
      blockHash: hash(logBlock),
      transactionHash: `0x${BigInt(logBlock * 100 + logIndex)
        .toString(16)
        .padStart(64, '0')}`,
      transactionIndex: 0,
      logIndex,
      sender: SENDER,
      receiver: ROUTE.silo,
      owner,
      assetsRaw: '700',
      sharesRaw: '500',
    },
  ]
  const body = {
    study: SEGMENT_STUDY,
    version: 1,
    chainId: 1,
    route: ROUTE,
    fromBlock,
    toBlock,
    windowBlocks: 10_000,
    originHosts: ['mainnet.infura.io', 'rpc.ankr.com'],
    originAgreement: 'exact_normalized_log_rows_and_boundary_headers',
    windows: [
      {
        fromBlock,
        toBlock,
        start,
        end,
        logCount: logs.length,
        logSetSha256: logSetDigest(logs),
      },
    ],
    logs,
    logSetSha256: logSetDigest(logs),
    capturedAtUtc: '2026-10-03T00:00:00.000Z',
    interpretation: 'candidate_owners_only_not_outstanding_cooldowns_or_provider_independence',
  }
  return seal(body)
}

const first = () =>
  segment({ fromBlock: C, toBlock: C + 1, owner: CONTRACT_OWNER, logBlock: C + 1 })
const second = () =>
  segment({ fromBlock: C + 2, toBlock: C + 3, owner: OTHER_OWNER, parentHash: hash(C + 1) })
const args = (artifacts) => ({ artifacts, cutoffBlock: C + 3, cutoffHash: hash(C + 3) })

test('manifest sorts segments and preserves every indexed owner, including a contract owner', () => {
  const left = first()
  const right = second()
  verifySusdeCooldownOwnerArtifact(left)
  verifySusdeCooldownOwnerArtifact(right)
  const manifest = buildSusdeCooldownOwnerManifest(args([right, left]))
  assert.equal(manifest.study, STUDY)
  assert.equal(manifest.fromBlock, C)
  assert.equal(manifest.toBlock, C + 3)
  assert.equal(manifest.segmentCount, 2)
  assert.equal(manifest.logCount, 2)
  assert.deepEqual(manifest.owners, [OTHER_OWNER, CONTRACT_OWNER])
  assert.equal(manifest.ownerCount, 2)
  assert.equal(
    manifest.ownerSetSha256,
    sha(JSON.stringify({ schema: 'susde_cooldown_owner_set_v1', owners: manifest.owners })),
  )
  assert.deepEqual(
    manifest.segments.map(({ fromBlock, toBlock }) => [fromBlock, toBlock]),
    [
      [C, C + 1],
      [C + 2, C + 3],
    ],
  )
  assert.equal(manifest.interpretation.includes('no_independent_rpc_replay'), true)
  assert.deepEqual(buildSusdeCooldownOwnerManifest(args([left, right])), manifest)
  assert.deepEqual(verifySusdeCooldownOwnerManifest(manifest, args([left, right])), manifest)
})

test('coverage gap and overlap both fail instead of producing a partial manifest', () => {
  assert.throws(
    () =>
      buildSusdeCooldownOwnerManifest(
        args([
          first(),
          segment({
            fromBlock: C + 3,
            toBlock: C + 3,
            owner: OTHER_OWNER,
            parentHash: hash(C + 2),
          }),
        ]),
      ),
    /segment_gap/,
  )
  assert.throws(
    () =>
      buildSusdeCooldownOwnerManifest(
        args([
          first(),
          segment({ fromBlock: C + 1, toBlock: C + 3, owner: OTHER_OWNER, parentHash: hash(C) }),
        ]),
      ),
    /segment_overlap/,
  )
})

test('cross-segment parent hash, deployment hash, and supplied cutoff hash are binding', () => {
  assert.throws(
    () =>
      buildSusdeCooldownOwnerManifest(
        args([
          first(),
          segment({
            fromBlock: C + 2,
            toBlock: C + 3,
            owner: OTHER_OWNER,
            parentHash: hash(C - 100),
          }),
        ]),
      ),
    /segment_boundary_mismatch/,
  )
  const wrongCreation = first()
  wrongCreation.windows[0].start.hash = hash(C - 100)
  wrongCreation.sha256 = sha(JSON.stringify((({ sha256: _seal, ...body }) => body)(wrongCreation)))
  assert.throws(
    () => buildSusdeCooldownOwnerManifest(args([wrongCreation, second()])),
    /deployment_boundary_mismatch/,
  )
  assert.throws(
    () =>
      buildSusdeCooldownOwnerManifest({
        artifacts: [first(), second()],
        cutoffBlock: C + 3,
        cutoffHash: hash(C + 100),
      }),
    /cutoff_hash_mismatch/,
  )
})

test('saved segment tampering and a manifest generated from different inputs fail', () => {
  const left = first()
  const manifest = buildSusdeCooldownOwnerManifest(args([left, second()]))
  left.logs[0].owner = OTHER_OWNER
  assert.throws(
    () => buildSusdeCooldownOwnerManifest(args([left, second()])),
    /artifact_seal_invalid/,
  )
  const changed = structuredClone(manifest)
  changed.owners.pop()
  assert.throws(
    () => verifySusdeCooldownOwnerManifest(changed, args([first(), second()])),
    /manifest_mismatch/,
  )
})

test('directory reader is offline, deterministic, and independently verifies each file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'susde-owner-manifest-'))
  try {
    await writeFile(join(directory, 'z-first.json'), JSON.stringify(first()))
    await writeFile(join(directory, 'a-second.json'), JSON.stringify(second()))
    const expected = buildSusdeCooldownOwnerManifest(args([first(), second()]))
    const actual = await buildSusdeCooldownOwnerManifestFromDirectory({
      directory,
      cutoffBlock: C + 3,
      cutoffHash: hash(C + 3),
    })
    assert.deepEqual(actual, expected)
    const path = join(directory, 'manifest.json')
    await writeFile(path, JSON.stringify(expected))
    assert.equal((await readSusdeCooldownOwnerManifest(path)).sha256, expected.sha256)
    // A manifest file in the segment directory is intentionally rejected as a
    // non-segment; callers must use a dedicated segment directory.
    await assert.rejects(
      buildSusdeCooldownOwnerManifestFromDirectory({
        directory,
        cutoffBlock: C + 3,
        cutoffHash: hash(C + 3),
      }),
      /artifact_shape_invalid/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('CLI requires an explicit block and hash and a separate output path', () => {
  assert.deepEqual(
    cliOptions([
      '--build',
      '--dir=x',
      `--cutoff-block=${C + 3}`,
      `--cutoff-hash=${hash(C + 3)}`,
      '--out=manifest.json',
    ]),
    {
      mode: '--build',
      directory: 'x',
      cutoffBlock: C + 3,
      cutoffHash: hash(C + 3),
      outPath: 'manifest.json',
    },
  )
  assert.throws(
    () => cliOptions(['--build', '--dir=x', `--cutoff-block=${C + 3}`, '--out=manifest.json']),
    /usage_invalid/,
  )
})
