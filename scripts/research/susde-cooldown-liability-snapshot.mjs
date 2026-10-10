// Bounded, foreground sUSDe cooldown liability reads. Saved evidence is an
// eth_call snapshot, not a mined payout, earmark, or proof of future liquidity.
import { createHash, randomUUID } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { link, lstat, mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import {
  ROUTE as CENSUS_ROUTE,
  readSusdeCooldownOwnerArtifact,
  selectCensusOrigins,
} from './susde-cooldown-owner-census.mjs'
import { ROUTE } from './susde-public-initiation-common.mjs'
import {
  buildSusdeCooldownOwnerManifest,
  readSusdeCooldownOwnerManifest,
} from './susde-cooldown-owner-manifest.mjs'

export const STUDY = 'susde_cooldown_liability_snapshot_v1'
export const MAX_OWNERS_PER_SEGMENT = 32
const ABI = parseAbi([
  'function cooldowns(address) view returns (uint104 cooldownEnd,uint256 underlyingAmount)',
  'function balanceOf(address) view returns (uint256)',
  'function asset() view returns (address)',
  'function silo() view returns (address)',
  'function cooldownDuration() view returns (uint24)',
])
const HASH = /^0x[0-9a-f]{64}$/
const WORD = /^0x[0-9a-f]{64}$/
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const CODE = /^0x(?:[0-9a-f]{2})+$/
const MAX_CODE_BYTES = 128 * 1024
const MAX_SEGMENT_BYTES = 1024 * 1024
const MIN_DISK_FREE_BYTES = 1024 * 1024 * 1024
const sha = (value) => createHash('sha256').update(value).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const fail = (reason) => {
  throw Error(`susde_liability_${reason}`)
}
const insist = (condition, reason) => {
  if (!condition) fail(reason)
}
const keys = (value, expected) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  same(Object.keys(value).sort(), [...expected].sort())
const numeric = (value) => typeof value === 'string' && DECIMAL.test(value)
const hex = (value) => `0x${BigInt(value).toString(16)}`

function source(manifest, artifacts) {
  insist(manifest && Array.isArray(artifacts) && artifacts.length > 0, 'source_required')
  const rebuilt = buildSusdeCooldownOwnerManifest({
    artifacts,
    cutoffBlock: manifest.toBlock,
    cutoffHash: manifest.cutoffHash,
  })
  insist(same(rebuilt, manifest), 'manifest_mismatch')
  return rebuilt
}

function range(manifest, fromIndex, count, anchorNumber, anchorHash) {
  insist(
    Number.isSafeInteger(fromIndex) &&
      fromIndex >= 0 &&
      Number.isSafeInteger(count) &&
      count >= 1 &&
      count <= MAX_OWNERS_PER_SEGMENT &&
      fromIndex + count <= manifest.ownerCount,
    'range_invalid',
  )
  insist(
    anchorNumber === manifest.toBlock &&
      anchorHash === manifest.cutoffHash &&
      HASH.test(anchorHash),
    'anchor_mismatch',
  )
}

function decode(raw, functionName, args) {
  insist(WORD.test(raw), 'call_result_invalid')
  try {
    return decodeFunctionResult({ abi: ABI, functionName, args, data: raw })
  } catch {
    fail('call_result_invalid')
  }
}

function callSpec(functionName, args) {
  return encodeFunctionData({ abi: ABI, functionName, args })
}

function verifyHost(host, expected, expectedCodeSha256) {
  insist(
    keys(host, [
      'provider',
      'chainId',
      'header',
      'vaultCodeRaw',
      'assetRaw',
      'siloRaw',
      'cooldownDurationRaw',
      'siloBalanceRaw',
      'rows',
    ]) &&
      typeof host.provider === 'string' &&
      host.provider.length > 0 &&
      host.chainId === '0x1' &&
      keys(host.header, ['number', 'hash', 'timestamp']) &&
      host.header.number === hex(expected.anchorNumber) &&
      host.header.hash === expected.anchorHash &&
      QUANTITY.test(host.header.timestamp) &&
      BigInt(host.header.timestamp) > 0n &&
      CODE.test(host.vaultCodeRaw) &&
      Buffer.byteLength(host.vaultCodeRaw) <= MAX_CODE_BYTES * 2 + 2 &&
      WORD.test(host.assetRaw) &&
      WORD.test(host.siloRaw) &&
      WORD.test(host.cooldownDurationRaw) &&
      WORD.test(host.siloBalanceRaw) &&
      Array.isArray(host.rows) &&
      host.rows.length === expected.count,
    'host_invalid',
  )
  const codeSha256 = sha(Buffer.from(host.vaultCodeRaw.slice(2), 'hex'))
  insist(
    codeSha256 === expectedCodeSha256 &&
      decode(host.assetRaw, 'asset', []).toLowerCase() === ROUTE.asset &&
      decode(host.siloRaw, 'silo', []).toLowerCase() === ROUTE.silo,
    'vault_identity_invalid',
  )
  const cooldownDuration = decode(host.cooldownDurationRaw, 'cooldownDuration', [])
  insist(
    Number.isSafeInteger(cooldownDuration) &&
      cooldownDuration >= 0 &&
      cooldownDuration <= 90 * 24 * 60 * 60,
    'cooldown_duration_invalid',
  )
  const cash = decode(host.siloBalanceRaw, 'balanceOf', [ROUTE.silo]).toString()
  const rows = host.rows.map((row, offset) => {
    const index = expected.fromIndex + offset
    insist(
      keys(row, ['index', 'owner', 'cooldownRaw']) &&
        row.index === index &&
        row.owner === expected.owners[index] &&
        /^0x[0-9a-f]{128}$/.test(row.cooldownRaw),
      'owner_read_invalid',
    )
    const [cooldownEnd, amount] = decodeFunctionResult({
      abi: ABI,
      functionName: 'cooldowns',
      args: [row.owner],
      data: row.cooldownRaw,
    })
    insist(amount === 0n || cooldownEnd > 0n, 'queue_state_invalid')
    return {
      index,
      owner: row.owner,
      cooldownEnd: cooldownEnd.toString(),
      pendingUsdeRaw: amount.toString(),
    }
  })
  return {
    cash,
    rows,
    codeSha256,
    vaultCodeRaw: host.vaultCodeRaw,
    cooldownDurationSeconds: cooldownDuration.toString(),
    anchorTimestamp: BigInt(host.header.timestamp).toString(),
  }
}

function verifySegment(segment, { manifest, artifacts }, expectedCodeSha256) {
  const rebuilt = source(manifest, artifacts)
  insist(
    keys(segment, [
      'study',
      'version',
      'manifestSha256',
      'ownerSetSha256',
      'ownerCount',
      'fromIndex',
      'count',
      'anchorNumber',
      'anchorHash',
      'anchorTimestamp',
      'cooldownDurationSeconds',
      'hosts',
      'rows',
      'siloUsdeRaw',
      'pendingUsdeRaw',
      'interpretation',
      'sha256',
    ]),
    'segment_shape_invalid',
  )
  const { sha256, ...body } = segment
  insist(
    sha(JSON.stringify(body)) === sha256 &&
      segment.study === STUDY &&
      segment.version === 1 &&
      segment.manifestSha256 === rebuilt.sha256 &&
      segment.ownerSetSha256 === rebuilt.ownerSetSha256 &&
      segment.ownerCount === rebuilt.ownerCount &&
      segment.interpretation ===
        'historical_anchor_pending_queue_snapshot_not_earmarked_cash_or_mined_payout',
    'segment_identity_invalid',
  )
  range(rebuilt, segment.fromIndex, segment.count, segment.anchorNumber, segment.anchorHash)
  insist(
    Array.isArray(segment.hosts) &&
      segment.hosts.length === 2 &&
      segment.hosts[0]?.provider !== segment.hosts[1]?.provider,
    'origins_invalid',
  )
  const expected = { ...segment, owners: rebuilt.owners }
  const left = verifyHost(segment.hosts[0], expected, expectedCodeSha256)
  const right = verifyHost(segment.hosts[1], expected, expectedCodeSha256)
  insist(same(left, right), 'origin_disagreement')
  insist(
    same(segment.rows, left.rows) &&
      segment.anchorTimestamp === left.anchorTimestamp &&
      segment.cooldownDurationSeconds === left.cooldownDurationSeconds &&
      segment.siloUsdeRaw === left.cash &&
      numeric(segment.pendingUsdeRaw) &&
      segment.pendingUsdeRaw ===
        left.rows.reduce((sum, row) => sum + BigInt(row.pendingUsdeRaw), 0n).toString(),
    'summary_mismatch',
  )
  return segment
}

export function verifySusdeCooldownLiabilitySegment(segment, inputs) {
  return verifySegment(segment, inputs, CENSUS_ROUTE.vaultCodeSha256)
}

async function rpc(client, method, params) {
  const response = await client.send({ jsonrpc: '2.0', id: 1, method, params })
  insist(
    response?.jsonrpc === '2.0' &&
      response.id === 1 &&
      Object.hasOwn(response, 'result') &&
      !Object.hasOwn(response, 'error'),
    'rpc_unavailable',
  )
  return response.result
}

async function readHost(client, manifest, fromIndex, count) {
  const chainId = await rpc(client, 'eth_chainId', [])
  const header = await rpc(client, 'eth_getBlockByNumber', [hex(manifest.toBlock), false])
  insist(
    chainId === '0x1' &&
      header?.number === hex(manifest.toBlock) &&
      header.hash === manifest.cutoffHash &&
      QUANTITY.test(header.timestamp ?? '') &&
      BigInt(header.timestamp) > 0n,
    'anchor_disagreement',
  )
  const block = { blockHash: manifest.cutoffHash, requireCanonical: true }
  const read = (to, data) => rpc(client, 'eth_call', [{ to, data }, block])
  const vaultCodeRaw = await rpc(client, 'eth_getCode', [ROUTE.vault, block])
  const assetRaw = await read(ROUTE.vault, callSpec('asset', []))
  const siloRaw = await read(ROUTE.vault, callSpec('silo', []))
  const cooldownDurationRaw = await read(ROUTE.vault, callSpec('cooldownDuration', []))
  const siloBalanceRaw = await read(ROUTE.asset, callSpec('balanceOf', [ROUTE.silo]))
  const rows = []
  for (let index = fromIndex; index < fromIndex + count; index++) {
    const owner = manifest.owners[index]
    rows.push({
      index,
      owner,
      cooldownRaw: await read(ROUTE.vault, callSpec('cooldowns', [owner])),
    })
  }
  return {
    provider: client.provider,
    chainId,
    header: { number: header.number, hash: header.hash, timestamp: header.timestamp },
    vaultCodeRaw,
    assetRaw,
    siloRaw,
    cooldownDurationRaw,
    siloBalanceRaw,
    rows,
  }
}

async function captureSegment(
  { manifest, artifacts, fromIndex, count, anchorNumber, anchorHash, clients },
  expectedCodeSha256,
) {
  const rebuilt = source(manifest, artifacts)
  range(rebuilt, fromIndex, count, anchorNumber, anchorHash)
  insist(
    Array.isArray(clients) &&
      clients.length === 2 &&
      clients.every(
        (client) => typeof client?.provider === 'string' && typeof client?.send === 'function',
      ) &&
      clients[0].provider !== clients[1].provider,
    'origins_invalid',
  )
  const hosts = []
  for (const client of clients) hosts.push(await readHost(client, rebuilt, fromIndex, count))
  const expected = { owners: rebuilt.owners, fromIndex, count, anchorNumber, anchorHash }
  const left = verifyHost(hosts[0], expected, expectedCodeSha256)
  const right = verifyHost(hosts[1], expected, expectedCodeSha256)
  insist(same(left, right), 'origin_disagreement')
  const body = {
    study: STUDY,
    version: 1,
    manifestSha256: rebuilt.sha256,
    ownerSetSha256: rebuilt.ownerSetSha256,
    ownerCount: rebuilt.ownerCount,
    fromIndex,
    count,
    anchorNumber,
    anchorHash,
    anchorTimestamp: left.anchorTimestamp,
    cooldownDurationSeconds: left.cooldownDurationSeconds,
    hosts,
    rows: left.rows,
    siloUsdeRaw: left.cash,
    pendingUsdeRaw: left.rows.reduce((sum, row) => sum + BigInt(row.pendingUsdeRaw), 0n).toString(),
    interpretation: 'historical_anchor_pending_queue_snapshot_not_earmarked_cash_or_mined_payout',
  }
  const segment = { ...body, sha256: sha(JSON.stringify(body)) }
  return verifySegment(segment, { manifest: rebuilt, artifacts }, expectedCodeSha256)
}

export async function captureSusdeCooldownLiabilitySegment(inputs) {
  return captureSegment(inputs, CENSUS_ROUTE.vaultCodeSha256)
}

// Production entry point: selects the configured independent Infura and Ankr
// hosts. The injected-client collector above supports offline fixture tests.
export async function captureConfiguredSusdeCooldownLiabilitySegment(
  options,
  { env = readEnv(), overrides = process.env, fetchImpl = fetch } = {},
) {
  const urls = selectCensusOrigins(configuredPublicRpcUrls(env, overrides))
  const clients = publicRpcClients(urls, fetchImpl)
  return captureSusdeCooldownLiabilitySegment({ ...options, clients })
}

function stitchSegments(segments, { manifest, artifacts }, expectedCodeSha256) {
  const rebuilt = source(manifest, artifacts)
  insist(Array.isArray(segments) && segments.length > 0, 'segments_required')
  const sorted = [...segments].sort((a, b) => a.fromIndex - b.fromIndex)
  let next = 0
  let cash = null
  let pending = 0n
  let timestamp = null
  let duration = null
  const buckets = new Map()
  for (const segment of sorted) {
    verifySegment(segment, { manifest: rebuilt, artifacts }, expectedCodeSha256)
    insist(segment.fromIndex === next, segment.fromIndex < next ? 'segment_overlap' : 'segment_gap')
    insist(cash === null || cash === segment.siloUsdeRaw, 'cash_disagreement')
    insist(timestamp === null || timestamp === segment.anchorTimestamp, 'timestamp_disagreement')
    insist(
      duration === null || duration === segment.cooldownDurationSeconds,
      'cooldown_duration_disagreement',
    )
    cash = segment.siloUsdeRaw
    timestamp = segment.anchorTimestamp
    duration = segment.cooldownDurationSeconds
    pending += BigInt(segment.pendingUsdeRaw)
    for (const row of segment.rows) {
      if (row.pendingUsdeRaw === '0') continue
      const bucket = buckets.get(row.cooldownEnd) ?? { ownerCount: 0, pendingUsdeRaw: 0n }
      bucket.ownerCount++
      bucket.pendingUsdeRaw += BigInt(row.pendingUsdeRaw)
      buckets.set(row.cooldownEnd, bucket)
    }
    next += segment.count
  }
  const complete = next === rebuilt.ownerCount
  const coveredCooldownEndBuckets = [...buckets.entries()]
    .sort(([left], [right]) => (BigInt(left) < BigInt(right) ? -1 : 1))
    .map(([cooldownEnd, bucket]) => ({
      cooldownEnd,
      ownerCount: bucket.ownerCount,
      pendingUsdeRaw: bucket.pendingUsdeRaw.toString(),
      eligibility:
        duration === '0' || BigInt(cooldownEnd) <= BigInt(timestamp)
          ? 'eligible_at_anchor'
          : 'future_at_anchor',
    }))
  const eligible = coveredCooldownEndBuckets
    .filter((bucket) => bucket.eligibility === 'eligible_at_anchor')
    .reduce((sum, bucket) => sum + BigInt(bucket.pendingUsdeRaw), 0n)
  const future = pending - eligible
  return {
    study: 'susde_cooldown_liability_stitch_v1',
    manifestSha256: rebuilt.sha256,
    ownerSetSha256: rebuilt.ownerSetSha256,
    ownerCount: rebuilt.ownerCount,
    coveredOwnerCount: next,
    anchorNumber: rebuilt.toBlock,
    anchorHash: rebuilt.cutoffHash,
    anchorTimestamp: timestamp,
    cooldownDurationSeconds: duration,
    coverage: complete ? 'complete' : 'partial',
    coveredPendingUsdeRaw: pending.toString(),
    coveredCooldownEndBuckets,
    siloUsdeRaw: cash,
    anchorLiabilityUsdeRaw: complete ? pending.toString() : null,
    cooldownEndBuckets: complete ? coveredCooldownEndBuckets : null,
    eligiblePendingUsdeRaw: complete ? eligible.toString() : null,
    futurePendingUsdeRaw: complete ? future.toString() : null,
    cashShortfallUsdeRaw: complete
      ? (pending > BigInt(cash) ? pending - BigInt(cash) : 0n).toString()
      : null,
    interpretation: complete
      ? 'full_owner_set_historical_anchor_pending_queue_shared_silo_cash_not_earmarked_or_mined_payout'
      : 'partial_owner_range_no_full_liability_claim',
  }
}

export function stitchSusdeCooldownLiabilitySegments(segments, inputs) {
  return stitchSegments(segments, inputs, CENSUS_ROUTE.vaultCodeSha256)
}

// Fixture-only runtime cannot produce records accepted by the public verifier.
// It tests the same code path against synthetic bytecode whose digest is known.
export function susdeLiabilityFixtureRuntime(codeRaw) {
  const expectedCodeSha256 = sha(Buffer.from(codeRaw.slice(2), 'hex'))
  return {
    capture: (inputs) => captureSegment(inputs, expectedCodeSha256),
    verify: (segment, inputs) => verifySegment(segment, inputs, expectedCodeSha256),
    stitch: (segments, inputs) => stitchSegments(segments, inputs, expectedCodeSha256),
  }
}

const MAX_SOURCE_FILES = 256
const MAX_SOURCE_BYTES = 128 * 1024 * 1024
const MAX_SAVED_SEGMENTS = 4096
const MAX_SAVED_BYTES = 128 * 1024 * 1024

async function jsonFiles(directory, maxFiles, maxBytes, eachLimit) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name))
  insist(entries.length >= 1 && entries.length <= maxFiles, 'files_invalid')
  let total = 0
  const paths = []
  for (const entry of entries) {
    insist(entry.isFile() && basename(entry.name) === entry.name, 'file_invalid')
    const path = join(directory, entry.name)
    const details = await stat(path)
    total += details.size
    insist(details.size <= eachLimit && total <= maxBytes, 'files_oversize')
    paths.push(path)
  }
  return paths
}

export async function loadSusdeLiabilitySources({ manifestPath, sourceDirectory }) {
  const manifest = await readSusdeCooldownOwnerManifest(manifestPath)
  const paths = await jsonFiles(
    sourceDirectory,
    MAX_SOURCE_FILES,
    MAX_SOURCE_BYTES,
    24 * 1024 * 1024,
  )
  const artifacts = []
  for (const path of paths) artifacts.push(await readSusdeCooldownOwnerArtifact(path))
  source(manifest, artifacts)
  return { manifest, artifacts }
}

export async function readSusdeCooldownLiabilitySegment(path) {
  const details = await stat(path)
  insist(details.isFile() && details.size <= MAX_SEGMENT_BYTES, 'segment_file_invalid')
  const bytes = await readFile(path)
  insist(bytes.length <= MAX_SEGMENT_BYTES, 'segment_file_invalid')
  let segment
  try {
    segment = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('segment_json_invalid')
  }
  return segment
}

export async function writeNewSusdeCooldownLiabilitySegment(
  path,
  segment,
  {
    freeBytes = (directory) => {
      const disk = statfsSync(directory)
      return Number(disk.bavail) * Number(disk.bsize)
    },
  } = {},
) {
  const output = resolve(path)
  const body = `${JSON.stringify(segment)}\n`
  insist(Buffer.byteLength(body) <= MAX_SEGMENT_BYTES, 'segment_oversize')
  await mkdir(dirname(output), { recursive: true })
  insist(freeBytes(dirname(output)) >= MIN_DISK_FREE_BYTES + Buffer.byteLength(body), 'disk_floor')
  const temporary = `${output}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(body)
    await handle.sync()
    await handle.close()
    handle = undefined
    await link(temporary, output)
    const directory = await open(dirname(output), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await handle?.close()
    await rm(temporary, { force: true })
  }
  return output
}

export function susdeLiabilityCliOptions(argv) {
  const mode = argv[0]
  insist(mode === '--capture' || mode === '--stitch', 'usage_invalid')
  const args = new Map()
  for (const value of argv.slice(1)) {
    const match = /^--([a-z-]+)=(.+)$/.exec(value)
    insist(match && !args.has(match[1]), 'usage_invalid')
    args.set(match[1], match[2])
  }
  const required =
    mode === '--capture'
      ? ['manifest', 'source-dir', 'from-index', 'count', 'anchor-number', 'anchor-hash', 'out']
      : ['manifest', 'source-dir', 'segments-dir']
  insist(args.size === required.length && required.every((key) => args.has(key)), 'usage_invalid')
  const common = {
    mode,
    manifestPath: args.get('manifest'),
    sourceDirectory: args.get('source-dir'),
  }
  if (mode === '--stitch') return { ...common, segmentsDirectory: args.get('segments-dir') }
  const fromIndex = Number(args.get('from-index'))
  const count = Number(args.get('count'))
  const anchorNumber = Number(args.get('anchor-number'))
  const anchorHash = args.get('anchor-hash')
  insist(
    Number.isSafeInteger(fromIndex) &&
      fromIndex >= 0 &&
      Number.isSafeInteger(count) &&
      count >= 1 &&
      count <= MAX_OWNERS_PER_SEGMENT &&
      Number.isSafeInteger(anchorNumber) &&
      HASH.test(anchorHash),
    'usage_invalid',
  )
  return { ...common, fromIndex, count, anchorNumber, anchorHash, outPath: args.get('out') }
}

export async function runSusdeLiabilityCli(options) {
  if (options.mode === '--capture') {
    try {
      await lstat(resolve(options.outPath))
      fail('output_exists')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  const { manifest, artifacts } = await loadSusdeLiabilitySources(options)
  if (options.mode === '--capture') {
    const outputDirectory = dirname(resolve(options.outPath))
    await mkdir(outputDirectory, { recursive: true })
    const disk = statfsSync(outputDirectory)
    insist(
      Number(disk.bavail) * Number(disk.bsize) >= MIN_DISK_FREE_BYTES + MAX_SEGMENT_BYTES,
      'disk_floor',
    )
    const segment = await captureConfiguredSusdeCooldownLiabilitySegment({
      manifest,
      artifacts,
      fromIndex: options.fromIndex,
      count: options.count,
      anchorNumber: options.anchorNumber,
      anchorHash: options.anchorHash,
    })
    const outPath = await writeNewSusdeCooldownLiabilitySegment(options.outPath, segment)
    return {
      status: 'captured_historical_anchor',
      outPath,
      fromIndex: segment.fromIndex,
      count: segment.count,
      ownerCount: segment.ownerCount,
      anchorNumber: segment.anchorNumber,
      anchorHash: segment.anchorHash,
      sha256: segment.sha256,
    }
  }
  const paths = await jsonFiles(
    options.segmentsDirectory,
    MAX_SAVED_SEGMENTS,
    MAX_SAVED_BYTES,
    MAX_SEGMENT_BYTES,
  )
  const segments = []
  for (const path of paths) segments.push(await readSusdeCooldownLiabilitySegment(path))
  const result = stitchSusdeCooldownLiabilitySegments(segments, { manifest, artifacts })
  return boundedSusdeLiabilityStitchSummary(result)
}

export function boundedSusdeLiabilityStitchSummary(result) {
  const buckets = result.cooldownEndBuckets ?? result.coveredCooldownEndBuckets
  return {
    status: 'stitched_offline_historical_anchor',
    manifestSha256: result.manifestSha256,
    ownerSetSha256: result.ownerSetSha256,
    ownerCount: result.ownerCount,
    coveredOwnerCount: result.coveredOwnerCount,
    anchorNumber: result.anchorNumber,
    anchorHash: result.anchorHash,
    anchorTimestamp: result.anchorTimestamp,
    cooldownDurationSeconds: result.cooldownDurationSeconds,
    coverage: result.coverage,
    coveredPendingUsdeRaw: result.coveredPendingUsdeRaw,
    siloUsdeRaw: result.siloUsdeRaw,
    anchorLiabilityUsdeRaw: result.anchorLiabilityUsdeRaw,
    eligiblePendingUsdeRaw: result.eligiblePendingUsdeRaw,
    futurePendingUsdeRaw: result.futurePendingUsdeRaw,
    cashShortfallUsdeRaw: result.cashShortfallUsdeRaw,
    cooldownEndBucketCount: buckets.length,
    cooldownEndBucketsSha256: sha(JSON.stringify(buckets)),
    cooldownEndBuckets: buckets.slice(0, 32),
    cooldownEndBucketsTruncated: buckets.length > 32,
    interpretation: result.interpretation,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(
      JSON.stringify(await runSusdeLiabilityCli(susdeLiabilityCliOptions(process.argv.slice(2)))),
    )
  } catch {
    // Vendor errors and URLs can carry credentials; the CLI never echoes them.
    console.error(JSON.stringify({ status: 'error', reason: 'susde_liability_failed_closed' }))
    process.exitCode = 1
  }
}
