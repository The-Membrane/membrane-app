// Offline chain manifest for complete sUSDe Withdraw(receiver=silo) census
// segments. It validates saved evidence; it never makes or replays RPC reads.
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  FIRST_CODE_BLOCK,
  ROUTE,
  STUDY as SEGMENT_STUDY,
  readSusdeCooldownOwnerArtifact,
  verifySusdeCooldownOwnerArtifact,
} from './susde-cooldown-owner-census.mjs'

export const STUDY = 'susde_cooldown_owner_manifest_v1'
const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const SHA = /^[0-9a-f]{64}$/
const MAX_FILES = 20_000
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024
const INTERPRETATION =
  'offline_artifact_integrity_and_contiguous_coverage_only_no_independent_rpc_replay_or_liability'
const sha = (value) => createHash('sha256').update(value).digest('hex')
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const fail = (reason) => {
  throw Error(`susde_owner_manifest_${reason}`)
}
const insist = (condition, reason) => {
  if (!condition) fail(reason)
}

function validateCutoff(cutoffBlock, cutoffHash) {
  insist(Number.isSafeInteger(cutoffBlock) && cutoffBlock >= FIRST_CODE_BLOCK, 'cutoff_invalid')
  insist(typeof cutoffHash === 'string' && HASH.test(cutoffHash), 'cutoff_invalid')
}

function compactSegment(artifact) {
  verifySusdeCooldownOwnerArtifact(artifact)
  insist(
    artifact.study === SEGMENT_STUDY &&
      artifact.chainId === 1 &&
      same(artifact.route, ROUTE) &&
      artifact.route.firstCodeBlock === FIRST_CODE_BLOCK,
    'segment_identity_invalid',
  )
  const first = artifact.windows[0].start
  const last = artifact.windows.at(-1).end
  const owners = [...new Set(artifact.logs.map((row) => row.owner))].sort()
  return {
    fromBlock: artifact.fromBlock,
    toBlock: artifact.toBlock,
    firstHash: first.hash,
    firstParentHash: first.parentHash,
    firstTimestamp: first.timestamp,
    lastHash: last.hash,
    lastTimestamp: last.timestamp,
    logCount: artifact.logs.length,
    ownerCount: owners.length,
    owners,
    logSetSha256: artifact.logSetSha256,
    artifactSha256: artifact.sha256,
  }
}

function finalize(segmentsWithOwners, cutoffBlock, cutoffHash) {
  validateCutoff(cutoffBlock, cutoffHash)
  insist(
    Array.isArray(segmentsWithOwners) &&
      segmentsWithOwners.length >= 1 &&
      segmentsWithOwners.length <= MAX_FILES,
    'segments_invalid',
  )
  const sorted = [...segmentsWithOwners].sort(
    (a, b) => a.fromBlock - b.fromBlock || a.toBlock - b.toBlock,
  )
  const owners = new Set()
  let cursor = FIRST_CODE_BLOCK
  let previous
  let logCount = 0
  const segments = []
  for (const segment of sorted) {
    if (segment.fromBlock !== cursor)
      fail(segment.fromBlock < cursor ? 'segment_overlap' : 'segment_gap')
    if (previous) {
      insist(
        segment.firstParentHash === previous.lastHash &&
          segment.firstTimestamp >= previous.lastTimestamp,
        'segment_boundary_mismatch',
      )
    } else {
      insist(segment.firstHash === ROUTE.firstCodeHash, 'deployment_boundary_mismatch')
    }
    insist(segment.toBlock <= cutoffBlock, 'segment_past_cutoff')
    segment.owners.forEach((owner) => owners.add(owner))
    logCount += segment.logCount
    insist(Number.isSafeInteger(logCount), 'log_count_invalid')
    const { owners: _owners, ...summary } = segment
    segments.push(summary)
    previous = segment
    cursor = segment.toBlock + 1
  }
  insist(cursor === cutoffBlock + 1, 'cutoff_not_covered')
  insist(previous.lastHash === cutoffHash, 'cutoff_hash_mismatch')
  const sortedOwners = [...owners].sort()
  const ownerSetSha256 = sha(
    JSON.stringify({
      schema: 'susde_cooldown_owner_set_v1',
      owners: sortedOwners,
    }),
  )
  const segmentLogSetChainSha256 = sha(
    JSON.stringify({
      schema: 'susde_cooldown_owner_segment_log_set_chain_v1',
      segments: segments.map(({ fromBlock, toBlock, logSetSha256 }) => ({
        fromBlock,
        toBlock,
        logSetSha256,
      })),
    }),
  )
  const body = {
    study: STUDY,
    version: 1,
    sourceStudy: SEGMENT_STUDY,
    chainId: 1,
    route: ROUTE,
    fromBlock: FIRST_CODE_BLOCK,
    toBlock: cutoffBlock,
    cutoffHash,
    segmentCount: segments.length,
    logCount,
    ownerCount: sortedOwners.length,
    owners: sortedOwners,
    ownerSetSha256,
    segments,
    segmentLogSetChainSha256,
    interpretation: INTERPRETATION,
  }
  const manifest = { ...body, sha256: sha(JSON.stringify(body)) }
  insist(Buffer.byteLength(JSON.stringify(manifest)) <= MAX_MANIFEST_BYTES, 'manifest_oversize')
  return manifest
}

export function buildSusdeCooldownOwnerManifest({ artifacts, cutoffBlock, cutoffHash }) {
  insist(Array.isArray(artifacts) && artifacts.length <= MAX_FILES, 'segments_invalid')
  return finalize(artifacts.map(compactSegment), cutoffBlock, cutoffHash)
}

export function verifySusdeCooldownOwnerManifest(manifest, { artifacts, cutoffBlock, cutoffHash }) {
  const expected = buildSusdeCooldownOwnerManifest({ artifacts, cutoffBlock, cutoffHash })
  insist(same(manifest, expected), 'manifest_mismatch')
  return manifest
}

export async function buildSusdeCooldownOwnerManifestFromDirectory({
  directory,
  cutoffBlock,
  cutoffHash,
}) {
  validateCutoff(cutoffBlock, cutoffHash)
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name))
  insist(entries.length >= 1 && entries.length <= MAX_FILES, 'segments_invalid')
  const summaries = []
  for (const entry of entries) {
    insist(entry.isFile() && basename(entry.name) === entry.name, 'segment_file_invalid')
    const artifact = await readSusdeCooldownOwnerArtifact(join(directory, entry.name))
    summaries.push(compactSegment(artifact))
  }
  return finalize(summaries, cutoffBlock, cutoffHash)
}

export async function readSusdeCooldownOwnerManifest(path) {
  const details = await stat(path)
  insist(details.isFile() && details.size <= MAX_MANIFEST_BYTES, 'manifest_oversize')
  const bytes = await readFile(path)
  insist(bytes.length <= MAX_MANIFEST_BYTES, 'manifest_oversize')
  let manifest
  try {
    manifest = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('manifest_json_invalid')
  }
  insist(
    manifest && typeof manifest === 'object' && SHA.test(manifest.sha256 ?? ''),
    'manifest_invalid',
  )
  const { sha256, ...body } = manifest
  insist(sha(JSON.stringify(body)) === sha256, 'manifest_seal_invalid')
  return manifest
}

async function writeNewAtomic(path, manifest) {
  const output = resolve(path)
  const text = `${JSON.stringify(manifest, null, 2)}\n`
  insist(Buffer.byteLength(text) <= MAX_MANIFEST_BYTES, 'manifest_oversize')
  await mkdir(dirname(output), { recursive: true })
  const temporary = `${output}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(text)
    await handle.sync()
    await handle.close()
    handle = undefined
    await link(temporary, output) // fail if the requested output already exists
  } finally {
    await handle?.close()
    await rm(temporary, { force: true })
  }
  return output
}

export function cliOptions(argv) {
  const mode = argv[0]
  insist(mode === '--build' || mode === '--verify', 'usage_invalid')
  const args = new Map()
  for (const item of argv.slice(1)) {
    const match = /^--([a-z-]+)=(.+)$/.exec(item)
    insist(match && !args.has(match[1]), 'usage_invalid')
    args.set(match[1], match[2])
  }
  const required =
    mode === '--build'
      ? ['dir', 'cutoff-block', 'cutoff-hash', 'out']
      : ['dir', 'cutoff-block', 'cutoff-hash', 'source']
  insist(args.size === required.length && required.every((key) => args.has(key)), 'usage_invalid')
  const cutoffBlock = Number(args.get('cutoff-block'))
  const cutoffHash = args.get('cutoff-hash')
  validateCutoff(cutoffBlock, cutoffHash)
  return {
    mode,
    directory: args.get('dir'),
    cutoffBlock,
    cutoffHash,
    ...(mode === '--build' ? { outPath: args.get('out') } : { source: args.get('source') }),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = cliOptions(process.argv.slice(2))
    const manifest = await buildSusdeCooldownOwnerManifestFromDirectory(options)
    if (options.mode === '--verify') {
      const saved = await readSusdeCooldownOwnerManifest(options.source)
      insist(same(saved, manifest), 'manifest_mismatch')
    } else await writeNewAtomic(options.outPath, manifest)
    console.log(
      JSON.stringify({
        status: options.mode === '--verify' ? 'verified_offline' : 'built_offline',
        fromBlock: manifest.fromBlock,
        toBlock: manifest.toBlock,
        segmentCount: manifest.segmentCount,
        logCount: manifest.logCount,
        ownerCount: manifest.ownerCount,
        sha256: manifest.sha256,
      }),
    )
  } catch {
    console.error(JSON.stringify({ status: 'error', reason: 'susde_owner_manifest_failed_closed' }))
    process.exitCode = 1
  }
}
