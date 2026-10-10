// Conditional positive-scaled-debt holders as of a frozen block B from a partial historical
// candidate prefix. Equality at B is necessary; deployed additive-accounting
// implementation equivalence remains unverified by this certificate.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { decodeFunctionResult, encodeFunctionData, parseAbiItem } from 'viem'

import { ROOT } from '../lib/venue-reads.mjs'
import {
  DEFAULT_OUT as SOURCE_DIR,
  MIN_FREE_BYTES,
  START_BLOCK,
  TOKEN,
  USDE,
  verify as verifyMintIndex,
} from './usde-debt-mint-baseline.mjs'
import {
  OUT as ALCHEMY_DIR,
  sourceIdentity as alchemySourceIdentity,
  verify as verifyAlchemyDiscovery,
} from './alchemy-mint-discovery.mjs'

export const PAGE_SIZE = 32
export const MAX_CANDIDATES = 100_000
export const MAX_SOURCE_SEGMENTS = 10_000
export const MAX_RPC_CALLS = 512
export const MAX_AS_OF_AGE_SECONDS = 7_200
export const DEFAULT_OUT = join(ROOT, 'scripts/route-cohort/.cache/usde-current-holder-certificate')
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
export const POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const RAW = /^(0|[1-9]\d*)$/
const SEGMENT = /^(\d{12})-(\d{12})-([a-f0-9]{64})\.json$/
const PAGE = /^page-(\d{6})-([a-f0-9]{64})\.json$/
const MANIFEST = /^manifest-([a-f0-9]{64})\.json$/
const CERTIFICATE = /^certificate-([a-f0-9]{64})\.json$/
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fail = (reason) => {
  throw new Error(`usde_current_holder_${reason}`)
}
const hex = (number) => `0x${BigInt(number).toString(16)}`
const abi = {
  aggregate3: parseAbiItem(
    'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
  ),
  scaledBalanceOf: parseAbiItem('function scaledBalanceOf(address) view returns (uint256)'),
  scaledTotalSupply: parseAbiItem('function scaledTotalSupply() view returns (uint256)'),
  POOL: parseAbiItem('function POOL() view returns (address)'),
  UNDERLYING_ASSET_ADDRESS: parseAbiItem(
    'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
  ),
}

function integer(value) {
  try {
    const result = Number(BigInt(value))
    if (Number.isSafeInteger(result) && result >= 0) return result
  } catch {
    /* Invalid integer. */
  }
  fail('integer_invalid')
}

function disk(out, stat, bytes = 0) {
  let path = out
  while (!existsSync(path) && dirname(path) !== path) path = dirname(path)
  const fs = stat(path)
  if (Number(fs.bavail) * Number(fs.bsize) - bytes < MIN_FREE_BYTES) fail('disk_reserve_reached')
}

function seal(out, name, body, stat = statfsSync) {
  const bytes = Buffer.from(JSON.stringify(body))
  if (bytes.length > 512_000) fail('artifact_size_cap')
  disk(out, stat, bytes.length)
  mkdirSync(out, { recursive: true })
  const target = join(out, `${name}-${sha(bytes)}.json`)
  const temp = `${target}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temp, 'wx', 0o600)
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset)
      if (written <= 0) fail('write_failed')
      offset += written
    }
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    linkSync(temp, target)
  } finally {
    if (fd !== null && fd !== undefined) closeSync(fd)
    if (existsSync(temp)) unlinkSync(temp)
  }
  return target
}

function readSealed(path, expectedSha) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expectedSha) fail('artifact_hash_mismatch')
  try {
    return JSON.parse(bytes)
  } catch {
    fail('artifact_json_invalid')
  }
}

/** Verify a partial, contiguous source prefix without requiring it to reach B. */
export function sourceCandidates(sourceDir = SOURCE_DIR) {
  const state = verifyMintIndex({ out: sourceDir })
  const names = readdirSync(sourceDir).sort()
  if (!names.length || names.length > MAX_SOURCE_SEGMENTS || names.length !== state.segmentCount)
    fail('source_segment_cap')
  const owners = new Set()
  const segments = []
  for (const name of names) {
    const match = SEGMENT.exec(name)
    if (!match) fail('source_name_invalid')
    const segment = readSealed(join(sourceDir, name), match[3])
    for (const owner of segment.candidateOwners) owners.add(owner)
    segments.push({ name, sha256: match[3] })
  }
  if (readdirSync(sourceDir).sort().join('\n') !== names.join('\n')) fail('source_changed')
  if (owners.size > MAX_CANDIDATES) fail('candidate_cap')
  return {
    sourceFromBlock: START_BLOCK,
    sourceThroughBlock: state.throughBlock,
    sourceFrontierHash: state.frontierHash,
    sourceSegmentCount: names.length,
    sourceManifestSha256: sha(JSON.stringify(segments)),
    segments,
    candidateOwners: [...owners].sort(),
  }
}

function alchemyCandidates(alchemyDir, frontier) {
  const state = verifyAlchemyDiscovery({ out: alchemyDir, frontier })
  const names = readdirSync(alchemyDir)
    .filter((name) => !name.startsWith('.'))
    .sort()
  if (!names.length || names.length !== state.segmentCount || names.length > MAX_SOURCE_SEGMENTS)
    fail('alchemy_segments_invalid')
  const owners = new Set()
  const segments = []
  for (const name of names) {
    const match = SEGMENT.exec(name)
    if (!match) fail('alchemy_segments_invalid')
    const segment = readSealed(join(alchemyDir, name), match[3])
    for (const owner of segment.candidateOwners) owners.add(owner)
    segments.push({ name, sha256: match[3] })
  }
  if (
    readdirSync(alchemyDir)
      .filter((name) => !name.startsWith('.'))
      .sort()
      .join('\n') !== names.join('\n')
  )
    fail('alchemy_source_changed')
  return {
    alchemySourceIdentity: state.sourceIdentity,
    alchemySegments: segments,
    alchemyManifestSha256: sha(JSON.stringify(segments)),
    alchemyThroughBlock: state.throughBlock,
    candidateOwners: [...owners].sort(),
  }
}

/** Only a verified, adjacent API suffix may extend the verified RPC-log prefix. */
export function sourceCandidatesV2(sourceDir = SOURCE_DIR, alchemyDir = ALCHEMY_DIR) {
  const rpc = sourceCandidates(sourceDir)
  const frontier = { throughBlock: rpc.sourceThroughBlock, frontierHash: rpc.sourceFrontierHash }
  const suffix = alchemyCandidates(alchemyDir, frontier)
  if (
    suffix.alchemySourceIdentity.rpcFrontierBlock !== rpc.sourceThroughBlock ||
    suffix.alchemySourceIdentity.rpcFrontierHash !== rpc.sourceFrontierHash ||
    suffix.alchemyThroughBlock <= rpc.sourceThroughBlock
  )
    fail('alchemy_frontier_invalid')
  const candidateOwners = [...new Set([...rpc.candidateOwners, ...suffix.candidateOwners])].sort()
  if (candidateOwners.length > MAX_CANDIDATES) fail('candidate_cap')
  return {
    ...rpc,
    alchemySourceIdentity: suffix.alchemySourceIdentity,
    alchemySegments: suffix.alchemySegments,
    alchemyManifestSha256: suffix.alchemyManifestSha256,
    alchemyThroughBlock: suffix.alchemyThroughBlock,
    candidateOwners,
  }
}

function captureTime(now, blockTimestamp) {
  const capturedAt = now().toISOString()
  const seconds = Date.parse(capturedAt) / 1000
  if (
    !Number.isFinite(seconds) ||
    seconds < blockTimestamp ||
    seconds - blockTimestamp > MAX_AS_OF_AGE_SECONDS
  )
    fail('as_of_window_expired')
  return capturedAt
}

/** Observe the actual finalized head and freeze its fresh B/hash/time. */
export async function prepare({
  sourceDir = SOURCE_DIR,
  alchemyDir,
  out = DEFAULT_OUT,
  rpcRead,
  now = () => new Date(),
  stat = statfsSync,
}) {
  const source =
    alchemyDir === undefined
      ? sourceCandidates(sourceDir)
      : sourceCandidatesV2(sourceDir, alchemyDir)
  if (existsSync(out) && readdirSync(out).length) fail('output_not_empty')
  if (typeof rpcRead !== 'function') fail('rpc_unavailable')
  disk(out, stat)
  if (integer(await rpcRead('eth_chainId', [])) !== 1) fail('wrong_chain')
  disk(out, stat)
  const finalizedRaw = await rpcRead('eth_getBlockByNumber', ['finalized', false])
  const finalized = header(finalizedRaw, integer(finalizedRaw?.number))
  if (finalized.number <= (source.alchemyThroughBlock ?? source.sourceThroughBlock))
    fail('independent_block_invalid')
  const capturedAt = captureTime(now, finalized.timestamp)
  const body = {
    schemaVersion: alchemyDir === undefined ? 1 : 2,
    claim: 'conditional_positive_scaled_debt_holders_as_of_block_no_route_attributed_tvl',
    accountingAssumption: 'deployed_additive_scaled_balance_implementation_unverified',
    chainId: 1,
    block: finalized.number,
    blockHash: finalized.hash,
    blockTimestamp: finalized.timestamp,
    capturedAt,
    asOfMaxAgeSeconds: MAX_AS_OF_AGE_SECONDS,
    token: TOKEN,
    underlying: USDE,
    pool: POOL,
    ...source,
    candidateCount: source.candidateOwners.length,
    pageCount: Math.max(1, Math.ceil(source.candidateOwners.length / PAGE_SIZE)),
  }
  return seal(out, 'manifest', body, stat)
}

// Recheck only the frozen prefix. Later historical backfill may append to its
// directory, but cannot change the candidate set of an already sealed run.
function frozenSource(sourceDir, segments, stat = statfsSync) {
  if (!Array.isArray(segments) || !segments.length || segments.length > MAX_SOURCE_SEGMENTS)
    fail('manifest_segments_invalid')
  disk(sourceDir, stat)
  const prefixDir = mkdtempSync(join(tmpdir(), 'usde-holder-prefix-'))
  let verified
  try {
    for (const entry of segments) {
      const match = SEGMENT.exec(entry?.name)
      if (!match || entry.sha256 !== match[3]) fail('manifest_segments_invalid')
      linkSync(join(sourceDir, entry.name), join(prefixDir, entry.name))
    }
    verified = verifyMintIndex({ out: prefixDir })
  } finally {
    rmSync(prefixDir, { recursive: true, force: true })
  }
  const owners = new Set()
  let nextBlock = START_BLOCK
  let frontierHash = null
  for (const entry of segments) {
    const match = SEGMENT.exec(entry?.name)
    if (!match || entry.sha256 !== match[3] || Number(match[1]) !== nextBlock)
      fail('manifest_segments_invalid')
    const segment = readSealed(join(sourceDir, entry.name), entry.sha256)
    if (
      segment.fromBlock !== nextBlock ||
      segment.toBlock !== Number(match[2]) ||
      (frontierHash && segment.fromHeader?.parentHash !== frontierHash) ||
      !HASH.test(segment.toHeader?.hash) ||
      !Array.isArray(segment.candidateOwners)
    )
      fail('manifest_segments_invalid')
    for (const owner of segment.candidateOwners) {
      if (!ADDRESS.test(owner)) fail('manifest_segments_invalid')
      owners.add(owner)
    }
    nextBlock = segment.toBlock + 1
    frontierHash = segment.toHeader.hash
  }
  if (owners.size > MAX_CANDIDATES) fail('candidate_cap')
  if (
    verified.throughBlock !== nextBlock - 1 ||
    verified.frontierHash !== frontierHash ||
    verified.segmentCount !== segments.length
  )
    fail('manifest_segments_invalid')
  return {
    sourceThroughBlock: nextBlock - 1,
    sourceFrontierHash: frontierHash,
    candidateOwners: [...owners].sort(),
  }
}

function frozenAlchemySource(alchemyDir, segments, frontier, stat = statfsSync) {
  if (!Array.isArray(segments) || !segments.length || segments.length > MAX_SOURCE_SEGMENTS)
    fail('alchemy_segments_invalid')
  disk(alchemyDir, stat)
  const frozenDir = mkdtempSync(join(tmpdir(), 'usde-holder-alchemy-'))
  let state
  const owners = new Set()
  try {
    for (const entry of segments) {
      const match = SEGMENT.exec(entry?.name)
      if (!match || entry.sha256 !== match[3]) fail('alchemy_segments_invalid')
      const segment = readSealed(join(alchemyDir, entry.name), entry.sha256)
      for (const owner of segment.candidateOwners ?? []) owners.add(owner)
      linkSync(join(alchemyDir, entry.name), join(frozenDir, entry.name))
    }
    state = verifyAlchemyDiscovery({ out: frozenDir, frontier })
  } finally {
    rmSync(frozenDir, { recursive: true, force: true })
  }
  if (state.segmentCount !== segments.length || owners.size > MAX_CANDIDATES)
    fail('alchemy_segments_invalid')
  return { ...state, candidateOwners: [...owners].sort() }
}

export function loadManifest({
  sourceDir = SOURCE_DIR,
  alchemyDir = ALCHEMY_DIR,
  out = DEFAULT_OUT,
  stat = statfsSync,
}) {
  const names = existsSync(out)
    ? readdirSync(out).filter((name) => name.startsWith('manifest-'))
    : []
  if (names.length !== 1 || !MANIFEST.test(names[0])) fail('manifest_missing_or_duplicate')
  const body = readSealed(join(out, names[0]), MANIFEST.exec(names[0])[1])
  const source = frozenSource(sourceDir, body.segments, stat)
  if (body.schemaVersion !== 1 && body.schemaVersion !== 2) fail('manifest_version_invalid')
  let expectedOwners = source.candidateOwners
  let latestSourceBlock = source.sourceThroughBlock
  if (body.schemaVersion === 2) {
    const frontier = {
      throughBlock: source.sourceThroughBlock,
      frontierHash: source.sourceFrontierHash,
    }
    const suffix = frozenAlchemySource(alchemyDir, body.alchemySegments, frontier, stat)
    if (
      JSON.stringify(body.alchemySourceIdentity) !==
        JSON.stringify(alchemySourceIdentity(frontier)) ||
      JSON.stringify(suffix.sourceIdentity) !== JSON.stringify(body.alchemySourceIdentity) ||
      body.alchemyManifestSha256 !== sha(JSON.stringify(body.alchemySegments)) ||
      body.alchemyThroughBlock !== suffix.throughBlock ||
      suffix.throughBlock <= source.sourceThroughBlock
    )
      fail('manifest_alchemy_source_invalid')
    expectedOwners = [...new Set([...expectedOwners, ...suffix.candidateOwners])].sort()
    latestSourceBlock = suffix.throughBlock
  }
  if (expectedOwners.length > MAX_CANDIDATES) fail('candidate_cap')
  if (
    body.chainId !== 1 ||
    body.claim !== 'conditional_positive_scaled_debt_holders_as_of_block_no_route_attributed_tvl' ||
    body.accountingAssumption !== 'deployed_additive_scaled_balance_implementation_unverified' ||
    body.token !== TOKEN ||
    body.underlying !== USDE ||
    body.pool !== POOL ||
    !Number.isSafeInteger(body.block) ||
    body.block <= latestSourceBlock ||
    !HASH.test(body.blockHash) ||
    !Number.isSafeInteger(body.blockTimestamp) ||
    !Number.isFinite(Date.parse(body.capturedAt)) ||
    body.asOfMaxAgeSeconds !== MAX_AS_OF_AGE_SECONDS ||
    Date.parse(body.capturedAt) / 1000 < body.blockTimestamp ||
    Date.parse(body.capturedAt) / 1000 - body.blockTimestamp > MAX_AS_OF_AGE_SECONDS ||
    body.candidateCount !== expectedOwners.length ||
    body.pageCount !== Math.max(1, Math.ceil(body.candidateCount / PAGE_SIZE)) ||
    body.sourceManifestSha256 !== sha(JSON.stringify(body.segments)) ||
    body.sourceFromBlock !== START_BLOCK ||
    body.sourceThroughBlock !== source.sourceThroughBlock ||
    body.sourceFrontierHash !== source.sourceFrontierHash ||
    body.sourceSegmentCount !== body.segments.length ||
    JSON.stringify(body.candidateOwners) !== JSON.stringify(expectedOwners)
  )
    fail('manifest_invalid_or_source_changed')
  return { manifest: body, manifestSha256: MANIFEST.exec(names[0])[1] }
}

function header(raw, expected) {
  const number = integer(raw?.number)
  const hash = String(raw?.hash).toLowerCase()
  const timestamp = integer(raw?.timestamp)
  if (number !== expected || !HASH.test(hash)) fail('block_header_invalid')
  return { number, hash, timestamp }
}

/** Capture one all-success page at the manifest's independent finalized B. */
export async function collectPage({
  sourceDir = SOURCE_DIR,
  alchemyDir = ALCHEMY_DIR,
  out = DEFAULT_OUT,
  page,
  rpcRead,
  now = () => new Date(),
  stat = statfsSync,
}) {
  const { manifest, manifestSha256 } = loadManifest({ sourceDir, alchemyDir, out, stat })
  if (!Number.isInteger(page) || page < 0 || page >= manifest.pageCount) fail('page_invalid')
  if (typeof rpcRead !== 'function') fail('rpc_unavailable')
  if (readdirSync(out).some((name) => name.startsWith(`page-${String(page).padStart(6, '0')}-`)))
    fail('page_already_sealed')
  let rpcCalls = 0
  const rpc = async (method, params) => {
    disk(out, stat)
    if (++rpcCalls > MAX_RPC_CALLS) fail('rpc_call_cap')
    return rpcRead(method, params)
  }
  if (integer(await rpc('eth_chainId', [])) !== 1) fail('wrong_chain')
  const finalizedRaw = await rpc('eth_getBlockByNumber', ['finalized', false])
  const finalized = header(finalizedRaw, integer(finalizedRaw?.number))
  if (finalized.number < manifest.block) fail('block_not_finalized')
  const at = header(await rpc('eth_getBlockByNumber', [hex(manifest.block), false]), manifest.block)
  if (at.hash !== manifest.blockHash || at.timestamp !== manifest.blockTimestamp)
    fail('frozen_block_mismatch')
  captureTime(now, manifest.blockTimestamp)
  const blockArg = { blockHash: manifest.blockHash, requireCanonical: true }
  const reserveData = await rpc('eth_call', [
    { to: POOL, data: `0x35ea6a75${USDE.slice(2).padStart(64, '0')}` },
    blockArg,
  ])
  const words = /^0x(?:[0-9a-f]{64})+$/i.test(reserveData || '')
    ? reserveData.slice(2).match(/.{64}/g)
    : null
  if (!words || words.length < 11 || `0x${words[10].slice(24)}`.toLowerCase() !== TOKEN)
    fail('reserve_debt_token_mismatch')
  const code = String(await rpc('eth_getCode', [MULTICALL3, blockArg])).toLowerCase()
  if (!/^0x[0-9a-f]+$/.test(code) || /^0x0+$/.test(code)) fail('multicall_unavailable')
  const batch = async (calls) => {
    const data = encodeFunctionData({
      abi: [abi.aggregate3],
      functionName: 'aggregate3',
      args: [
        calls.map(({ functionName, args = [] }) => ({
          target: TOKEN,
          allowFailure: false,
          callData: encodeFunctionData({ abi: [abi[functionName]], functionName, args }),
        })),
      ],
    })
    const result = await rpc('eth_call', [{ to: MULTICALL3, data }, blockArg])
    if (typeof result !== 'string' || Buffer.byteLength(result) > 1_000_000)
      fail('batch_response_invalid')
    let decoded
    try {
      decoded = decodeFunctionResult({
        abi: [abi.aggregate3],
        functionName: 'aggregate3',
        data: result,
      })
    } catch {
      fail('batch_decode_failed')
    }
    if (
      !Array.isArray(decoded) ||
      decoded.length !== calls.length ||
      decoded.some((entry) => entry.success !== true)
    )
      fail('batch_incomplete')
    return decoded.map((entry, i) => {
      try {
        return decodeFunctionResult({
          abi: [abi[calls[i].functionName]],
          functionName: calls[i].functionName,
          data: entry.returnData,
        })
      } catch {
        fail('call_decode_failed')
      }
    })
  }
  const [underlying, pool, supply] = await batch([
    { functionName: 'UNDERLYING_ASSET_ADDRESS' },
    { functionName: 'POOL' },
    { functionName: 'scaledTotalSupply' },
  ])
  if (
    String(underlying).toLowerCase() !== USDE ||
    String(pool).toLowerCase() !== POOL ||
    typeof supply !== 'bigint' ||
    supply < 0n
  )
    fail('token_identity_mismatch')
  const owners = manifest.candidateOwners.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const balances = owners.length
    ? await batch(owners.map((owner) => ({ functionName: 'scaledBalanceOf', args: [owner] })))
    : []
  if (balances.some((value) => typeof value !== 'bigint' || value < 0n)) fail('balance_invalid')
  const after = header(
    await rpc('eth_getBlockByNumber', [hex(manifest.block), false]),
    manifest.block,
  )
  if (after.hash !== manifest.blockHash || after.timestamp !== manifest.blockTimestamp)
    fail('block_changed')
  const capturedAt = captureTime(now, manifest.blockTimestamp)
  const body = {
    schemaVersion: 1,
    manifestSha256,
    block: manifest.block,
    blockHash: manifest.blockHash,
    blockTimestamp: manifest.blockTimestamp,
    capturedAt,
    page,
    pageCount: manifest.pageCount,
    scaledTotalSupplyRaw: supply.toString(),
    rows: owners.map((owner, i) => ({ owner, scaledDebtRaw: balances[i].toString() })),
    allSubcallsSuccessful: true,
    rpcCalls,
  }
  seal(out, `page-${String(page).padStart(6, '0')}`, body, stat)
  return { block: manifest.block, page, pageCount: manifest.pageCount, sealed: true, rpcCalls }
}

/** No aggregate or holder set is returned unless every sealed page reconciles. */
export function reconcile({
  sourceDir = SOURCE_DIR,
  alchemyDir = ALCHEMY_DIR,
  out = DEFAULT_OUT,
  stat = statfsSync,
}) {
  const { manifest, manifestSha256 } = loadManifest({ sourceDir, alchemyDir, out, stat })
  const names = readdirSync(out)
    .filter((name) => name.startsWith('page-'))
    .sort()
  if (names.length !== manifest.pageCount) fail('pages_incomplete')
  let blockHash = null,
    blockTimestamp = null,
    supply = null,
    sum = 0n
  const positiveHolders = []
  for (const [page, name] of names.entries()) {
    const match = PAGE.exec(name)
    if (!match || Number(match[1]) !== page) fail('page_name_or_duplicate_invalid')
    const body = readSealed(join(out, name), match[2])
    const owners = manifest.candidateOwners.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
    if (
      body.schemaVersion !== 1 ||
      body.manifestSha256 !== manifestSha256 ||
      body.block !== manifest.block ||
      body.blockHash !== manifest.blockHash ||
      body.blockTimestamp !== manifest.blockTimestamp ||
      !Number.isFinite(Date.parse(body.capturedAt)) ||
      Date.parse(body.capturedAt) < body.blockTimestamp * 1000 ||
      Date.parse(body.capturedAt) / 1000 - body.blockTimestamp > MAX_AS_OF_AGE_SECONDS ||
      body.page !== page ||
      body.pageCount !== manifest.pageCount ||
      body.allSubcallsSuccessful !== true ||
      !RAW.test(body.scaledTotalSupplyRaw) ||
      !Array.isArray(body.rows) ||
      body.rows.length !== owners.length
    )
      fail('page_invalid')
    if (blockHash !== null && body.blockHash !== blockHash) fail('block_hash_inconsistent')
    if (blockTimestamp !== null && body.blockTimestamp !== blockTimestamp)
      fail('block_time_inconsistent')
    if (supply !== null && body.scaledTotalSupplyRaw !== supply) fail('supply_inconsistent')
    blockHash = body.blockHash
    blockTimestamp = body.blockTimestamp
    supply = body.scaledTotalSupplyRaw
    for (const [i, row] of body.rows.entries()) {
      if (row.owner !== owners[i] || !ADDRESS.test(row.owner) || !RAW.test(row.scaledDebtRaw))
        fail('row_invalid')
      const balance = BigInt(row.scaledDebtRaw)
      sum += balance
      if (balance > 0n) positiveHolders.push(row)
    }
  }
  if (sum !== BigInt(supply)) fail('scaled_supply_mismatch')
  return {
    status: 'candidate_scaled_supply_equality_as_of_block_accounting_implementation_unverified',
    claim: manifest.claim,
    accountingAssumption: manifest.accountingAssumption,
    block: manifest.block,
    blockHash,
    blockTimestamp,
    sourceThroughBlock: manifest.sourceThroughBlock,
    sourceManifestSha256: manifest.sourceManifestSha256,
    ...(manifest.schemaVersion === 2
      ? {
          alchemySourceIdentity: manifest.alchemySourceIdentity,
          alchemyManifestSha256: manifest.alchemyManifestSha256,
          alchemyThroughBlock: manifest.alchemyThroughBlock,
        }
      : {}),
    manifestSha256,
    candidateCount: manifest.candidateCount,
    positiveHolderCount: positiveHolders.length,
    scaledTotalSupplyRaw: supply,
    positiveHolders,
  }
}

/** Seal a compact local receipt only after all pages reconcile at B. */
export function finalize({
  sourceDir = SOURCE_DIR,
  alchemyDir = ALCHEMY_DIR,
  out = DEFAULT_OUT,
  stat = statfsSync,
}) {
  const result = reconcile({ sourceDir, alchemyDir, out, stat })
  if (readdirSync(out).some((name) => name.startsWith('certificate-')))
    fail('certificate_already_sealed')
  const pageNames = readdirSync(out)
    .filter((name) => name.startsWith('page-'))
    .sort()
  const body = {
    schemaVersion: result.alchemySourceIdentity ? 2 : 1,
    status: result.status,
    claim: result.claim,
    accountingAssumption: result.accountingAssumption,
    block: result.block,
    blockHash: result.blockHash,
    blockTimestamp: result.blockTimestamp,
    sourceThroughBlock: result.sourceThroughBlock,
    sourceManifestSha256: result.sourceManifestSha256,
    ...(result.alchemySourceIdentity
      ? {
          alchemySourceIdentity: result.alchemySourceIdentity,
          alchemyManifestSha256: result.alchemyManifestSha256,
          alchemyThroughBlock: result.alchemyThroughBlock,
        }
      : {}),
    manifestSha256: result.manifestSha256,
    candidateCount: result.candidateCount,
    positiveHolderCount: result.positiveHolderCount,
    scaledTotalSupplyRaw: result.scaledTotalSupplyRaw,
    positiveHoldersSha256: sha(JSON.stringify(result.positiveHolders)),
    pageNames,
  }
  return seal(out, 'certificate', body, stat)
}

/** Offline verification recomputes the aggregate from the original seals. */
export function verifyCertificate({
  sourceDir = SOURCE_DIR,
  alchemyDir = ALCHEMY_DIR,
  out = DEFAULT_OUT,
  stat = statfsSync,
}) {
  const names = existsSync(out)
    ? readdirSync(out).filter((name) => name.startsWith('certificate-'))
    : []
  if (names.length !== 1 || !CERTIFICATE.test(names[0])) fail('certificate_missing_or_duplicate')
  const body = readSealed(join(out, names[0]), CERTIFICATE.exec(names[0])[1])
  const result = reconcile({ sourceDir, alchemyDir, out, stat })
  const expected = {
    schemaVersion: result.alchemySourceIdentity ? 2 : 1,
    status: result.status,
    claim: result.claim,
    accountingAssumption: result.accountingAssumption,
    block: result.block,
    blockHash: result.blockHash,
    blockTimestamp: result.blockTimestamp,
    sourceThroughBlock: result.sourceThroughBlock,
    sourceManifestSha256: result.sourceManifestSha256,
    ...(result.alchemySourceIdentity
      ? {
          alchemySourceIdentity: result.alchemySourceIdentity,
          alchemyManifestSha256: result.alchemyManifestSha256,
          alchemyThroughBlock: result.alchemyThroughBlock,
        }
      : {}),
    manifestSha256: result.manifestSha256,
    candidateCount: result.candidateCount,
    positiveHolderCount: result.positiveHolderCount,
    scaledTotalSupplyRaw: result.scaledTotalSupplyRaw,
    positiveHoldersSha256: sha(JSON.stringify(result.positiveHolders)),
    pageNames: readdirSync(out)
      .filter((name) => name.startsWith('page-'))
      .sort(),
  }
  if (JSON.stringify(body) !== JSON.stringify(expected)) fail('certificate_reconcile_mismatch')
  return { ...body, certificateSha256: CERTIFICATE.exec(names[0])[1] }
}
