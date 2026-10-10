// Conditional share-holder reconciliation from a Transfer-recipient candidate source.
// This does not attribute borrowed funds to shares and cannot emit a promoted
// certificate without an independently reviewed deployed-accounting trust root.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbiItem } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import {
  assertOutputSeparated,
  capabilityBinding,
  sourceAnchor,
  verify as verifyJournal,
} from './alchemy-share-discovery.mjs'
import {
  TOKENS,
  checkDisk,
  selectRpcUrls,
  verify as verifySource,
} from './share-transfer-source.mjs'

export const PAGE_SIZE = 32
// At most 64 pages (roughly 2,560 direct pinned RPC reads) in the two-hour
// capture window. Larger censuses need a separately measured collection plan.
export const MAX_PAGES = 64
export const MAX_CANDIDATES = PAGE_SIZE * MAX_PAGES
export const MAX_AGE_SECONDS = 7_200
export const IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
// Official Ethereum mainnet asset contracts: Aave GHO and Ethena USDe.
export const UNDERLYING = Object.freeze({
  sGHO: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
  sUSDe: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
})
const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const RAW = /^(0|[1-9]\d*)$/
const FILE = /^(manifest|reconciliation)-([a-f0-9]{64})\.json$/
const PAGE = /^page-(\d{6})-([a-f0-9]{64})\.json$/
const OUTPUT_LOCK = '.share-current-holder-certificate.lock'
const SOURCE_LOCK = '.share-transfer-source.lock'
const JOURNAL_LOCK = '.alchemy-share-discovery.lock'
const JOURNAL_FILE = /^(\d{12})-(\d{12})-([a-f0-9]{64})\.json$/
const abi = {
  asset: parseAbiItem('function asset() view returns (address)'),
  totalSupply: parseAbiItem('function totalSupply() view returns (uint256)'),
  balanceOf: parseAbiItem('function balanceOf(address) view returns (uint256)'),
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const hex = (n) => `0x${BigInt(n).toString(16)}`
const fail = (code) => {
  throw new Error(`share_certificate_${code}`)
}
const lower = (value) => String(value).toLowerCase()

function number(value) {
  try {
    const n = Number(BigInt(value))
    if (Number.isSafeInteger(n) && n >= 0) return n
  } catch {
    /* invalid */
  }
  fail('integer_invalid')
}

function pageCapturedInWindow(capturedAt, manifest) {
  const at = Date.parse(capturedAt)
  const manifestAt = Date.parse(manifest.capturedAt)
  return (
    Number.isFinite(at) &&
    Number.isFinite(manifestAt) &&
    at >= manifestAt &&
    at / 1000 >= manifest.blockTimestamp &&
    at / 1000 - manifest.blockTimestamp <= MAX_AGE_SECONDS
  )
}

function writeSeal(out, stem, body, stat) {
  const bytes = Buffer.from(JSON.stringify(body))
  if (bytes.length > 2_000_000) fail('artifact_size_cap')
  checkDisk(out, stat, bytes.length)
  mkdirSync(out, { recursive: true })
  const name = `${stem}-${sha(bytes)}.json`
  const target = join(out, name)
  const temp = `${target}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temp, 'wx', 0o600)
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    linkSync(temp, target)
  } finally {
    if (fd !== null && fd !== undefined) closeSync(fd)
    if (existsSync(temp)) unlinkSync(temp)
  }
  return { name, sha256: sha(bytes) }
}

function readSeal(out, name, digest) {
  const bytes = readFileSync(join(out, name))
  if (sha(bytes) !== digest) fail('artifact_hash_mismatch')
  try {
    return JSON.parse(bytes)
  } catch {
    fail('artifact_json_invalid')
  }
}

function names(out) {
  return existsSync(out) ? readdirSync(out).sort() : []
}
function acquireOutputLock(out) {
  mkdirSync(out, { recursive: true })
  const path = join(out, OUTPUT_LOCK)
  let fd
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch {
    fail('output_lock_held')
  }
  const token = randomUUID()
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, token }))
    fsyncSync(fd)
  } catch {
    closeSync(fd)
    unlinkSync(path)
    fail('output_lock_write_failed')
  }
  closeSync(fd)
  return () => {
    let owner
    try {
      owner = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      fail('output_lock_release_unproven')
    }
    if (owner.token !== token) fail('output_lock_release_unproven')
    unlinkSync(path)
  }
}

function assertSourceIdle(sourceDir) {
  if (existsSync(join(sourceDir, SOURCE_LOCK))) fail('source_writer_active')
}
function assertCertificateOutputSeparated(out, sourceDir, apiJournal) {
  assertOutputSeparated(out, [
    sourceDir,
    ...(apiJournal
      ? [apiJournal.out, apiJournal.capability?.sourcePath, apiJournal.capability?.receiptPath]
      : []),
  ])
}
function one(out, pattern) {
  const matches = names(out).filter((n) => pattern.test(n))
  if (matches.length !== 1) fail('artifact_missing_or_duplicate')
  return matches[0]
}

export function assertFeasibleCandidateCount(count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_CANDIDATES)
    fail('candidate_count_infeasible')
}

function frozenSource(sourceDir, config, enforceFeasibility = true) {
  assertSourceIdle(sourceDir)
  const source = verifySource({ out: sourceDir, config })
  if (
    !source.segments.length ||
    source.throughBlock < config.startBlock ||
    !source.deploymentProofSha256
  )
    fail('source_incomplete')
  if (enforceFeasibility) assertFeasibleCandidateCount(source.candidateRecipients.length)
  return source
}

function assertSourceUnchanged(sourceDir, config, frozen) {
  const current = frozenSource(sourceDir, config, false)
  if (JSON.stringify(current) !== JSON.stringify(frozen)) fail('source_changed_during_prepare')
}

function frozenPrefix(sourceDir, source, manifest) {
  const prefix = manifest.sourceSegments
  if (
    !Array.isArray(prefix) ||
    !prefix.length ||
    prefix.length > source.segments.length ||
    JSON.stringify(prefix) !== JSON.stringify(source.segments.slice(0, prefix.length))
  )
    fail('source_prefix_changed')
  const candidates = new Set()
  let last = null
  for (const item of prefix) {
    if (typeof item?.name !== 'string' || !/^[a-f0-9]{64}$/.test(item?.sha256))
      fail('source_prefix_invalid')
    const bytes = readFileSync(join(sourceDir, item.name))
    if (sha(bytes) !== item.sha256) fail('source_prefix_hash_mismatch')
    try {
      last = JSON.parse(bytes)
    } catch {
      fail('source_prefix_json_invalid')
    }
    for (const log of last.logs ?? []) candidates.add(log.recipient)
  }
  // The source verifier checked each segment's log/recipient consistency;
  // these exact physical bytes and digests are now bound to the manifest.
  return {
    throughBlock: last?.toBlock,
    frontierHash: last?.toHeader?.hash,
    candidateRecipients: [...candidates].filter((owner) => owner !== `0x${'0'.repeat(40)}`).sort(),
  }
}

function verifiedCandidateUnion(sourceDir, config, source, apiJournal, frozen = null) {
  if (
    !apiJournal ||
    typeof apiJournal.out !== 'string' ||
    !apiJournal.anchor ||
    !apiJournal.capability
  )
    fail('api_binding_invalid')
  const { out, anchor, capability } = apiJournal
  if (existsSync(join(out, JOURNAL_LOCK))) fail('api_writer_active')
  const sourceTip = frozen
    ? { throughBlock: frozen.anchor?.frontierBlock, frontierHash: frozen.anchor?.frontierHash }
    : { throughBlock: source.throughBlock, frontierHash: source.frontierHash }
  if (
    anchor.sourcePath !== resolve(sourceDir) ||
    JSON.stringify(anchor.config) !== JSON.stringify(config) ||
    anchor.frontierBlock !== sourceTip.throughBlock ||
    anchor.frontierHash !== sourceTip.frontierHash ||
    anchor.sourceLogCompleteness !== 'not_independently_proven' ||
    capability.token !== config.token ||
    capability.deploymentBlock !== config.deploymentBlock ||
    capability.comparison !== 'one_nonzero_sealed_segment_exact_log_identity'
  )
    fail('api_binding_invalid')
  const checkedAnchor = sourceAnchor({
    source: sourceDir,
    config,
    frontierBlock: anchor.frontierBlock,
    frontierHash: anchor.frontierHash,
  })
  if (JSON.stringify(checkedAnchor) !== JSON.stringify(anchor)) fail('api_anchor_changed')

  // A capability receipt is a local, exact-window comparison, not provider
  // completeness. Recheck its physical dependencies without making a live call.
  const capConfig = {
    chainId: 1,
    token: config.token,
    address: config.address,
    deploymentBlock: config.deploymentBlock,
    startBlock: capability.sourceStartBlock,
  }
  const capSource = verifySource({ out: capability.sourcePath, config: capConfig })
  const capItem = capSource.segments.find((item) => item.name === capability.sourceSegment)
  if (!capItem || capItem.sha256 !== capability.sourcePhysicalSha256)
    fail('api_capability_source_changed')
  const capSegment = readSeal(capability.sourcePath, capItem.name, capItem.sha256)
  if (
    capSegment.fromBlock !== capability.sourceFromBlock ||
    capSegment.toBlock !== capability.sourceToBlock ||
    !Array.isArray(capSegment.logs) ||
    capSegment.logs.length === 0 ||
    capability.receiptName !== `${capability.receiptSha256}.json` ||
    !/^[a-f0-9]{64}$/.test(capability.receiptSha256) ||
    names(capability.receiptPath).length !== 1
  )
    fail('api_capability_invalid')
  if (statSync(join(capability.receiptPath, capability.receiptName)).size > 2_000_000)
    fail('api_capability_invalid')
  const receipt = readSeal(capability.receiptPath, capability.receiptName, capability.receiptSha256)
  if (
    receipt.schemaVersion !== 1 ||
    JSON.stringify(receipt.source) !==
      JSON.stringify({
        path: capability.sourcePath,
        segment: capability.sourceSegment,
        physicalSha256: capability.sourcePhysicalSha256,
        config: capConfig,
        fromBlock: capability.sourceFromBlock,
        toBlock: capability.sourceToBlock,
      }) ||
    receipt.result?.status !== 'matched' ||
    receipt.result?.exactLogIdentity !== true ||
    receipt.result?.apiLogIndexAvailable !== true ||
    !Array.isArray(receipt.normalizedRows) ||
    receipt.normalizedRows.length !== capSegment.logs.length ||
    receipt.pages !== receipt.result?.pages ||
    !Number.isInteger(receipt.pages) ||
    receipt.pages < 1 ||
    receipt.pages > 4
  )
    fail('api_capability_invalid')
  const logKey = (row) =>
    `${row.blockNumber}:${row.transactionHash}:${row.logIndex}:${row.recipient}:${row.valueRaw}`
  if (
    JSON.stringify(receipt.normalizedRows.map(logKey).sort()) !==
    JSON.stringify(capSegment.logs.map(logKey).sort())
  )
    fail('api_capability_invalid')
  const tuple = (row) =>
    `${row.blockNumber}:${row.transactionHash}:${row.recipient}:${row.valueRaw}`
  const duplicateTuples = new Set(capSegment.logs.map(tuple)).size !== capSegment.logs.length
  if (
    JSON.stringify(receipt.result) !==
    JSON.stringify({
      status: 'matched',
      canonicalCount: capSegment.logs.length,
      apiCount: capSegment.logs.length,
      duplicateTuples,
      apiLogIndexAvailable: true,
      knownLogIndexes: capSegment.logs.length,
      exactLogIdentity: true,
      claim: 'one_sealed_segment_comparison_only',
      pages: receipt.pages,
    })
  )
    fail('api_capability_invalid')

  const replay = verifyJournal({ out, anchor, capability })
  const listed = names(out).filter((name) => name !== JOURNAL_LOCK)
  const selected =
    frozen?.segments ??
    listed.map((name) => {
      const match = JOURNAL_FILE.exec(name)
      if (!match) fail('api_segment_invalid')
      return { name, sha256: match[3] }
    })
  if (
    !selected.length ||
    selected.length > listed.length ||
    JSON.stringify(selected.map((item) => item.name)) !==
      JSON.stringify(listed.slice(0, selected.length))
  )
    fail('api_prefix_changed')
  let throughBlock = anchor.frontierBlock
  let boundaryHash = anchor.frontierHash
  const owners = new Set()
  const transactionLogs = new Set()
  for (const item of source.segments) {
    if (Number(item.name.slice(13, 25)) > anchor.frontierBlock) break
    const segment = readSeal(sourceDir, item.name, item.sha256)
    for (const owner of segment.candidateRecipients) owners.add(owner)
    for (const row of segment.logs) {
      const key = `${row.transactionHash}:${row.logIndex}`
      if (transactionLogs.has(key)) fail('mixed_fork_duplicate_log')
      transactionLogs.add(key)
    }
  }
  const segments = []
  for (const item of selected) {
    const match = JOURNAL_FILE.exec(item.name)
    if (!match || match[3] !== item.sha256) fail('api_prefix_changed')
    const segment = readSeal(out, item.name, item.sha256)
    if (
      (segment.schemaVersion !== 1 && segment.schemaVersion !== 2) ||
      segment.fromBlock !== throughBlock + 1 ||
      segment.fromParentHash !== boundaryHash ||
      segment.toBlock !== Number(match[2]) ||
      segment.fromBlock !== Number(match[1]) ||
      JSON.stringify(segment.anchor) !== JSON.stringify(anchor) ||
      JSON.stringify(segment.capability) !== JSON.stringify(capability) ||
      segment.logCompleteness !== 'not_independently_proven' ||
      (segment.interiorAncestry !== undefined &&
        segment.interiorAncestry !== 'not_independently_proven') ||
      segment.currentHolderCertificate !== false ||
      segment.routeTvlClaim !== false
    )
      fail('api_segment_invalid')
    for (const row of segment.rows) {
      const key = `${row.transactionHash}:${row.logIndex}`
      if (transactionLogs.has(key)) fail('mixed_fork_duplicate_log')
      transactionLogs.add(key)
    }
    for (const owner of segment.candidateRecipients) owners.add(owner)
    throughBlock = segment.toBlock
    boundaryHash = segment.toHash
    segments.push({ name: item.name, sha256: item.sha256, schemaVersion: segment.schemaVersion })
  }
  if (
    frozen &&
    (throughBlock !== frozen.throughBlock ||
      boundaryHash !== frozen.frontierHash ||
      JSON.stringify(segments) !== JSON.stringify(frozen.segments))
  )
    fail('api_prefix_changed')
  if (!frozen && (throughBlock !== replay.throughBlock || boundaryHash !== replay.boundaryHash))
    fail('api_tip_changed')
  const candidateRecipients = [...owners].sort()
  assertFeasibleCandidateCount(candidateRecipients.length)
  return {
    journalPath: resolve(out),
    anchor,
    capability,
    segments,
    throughBlock,
    frontierHash: boundaryHash,
    candidateRecipients,
    logCompleteness: 'not_independently_proven',
    interiorAncestry: 'not_independently_proven',
    candidateDiscoveryOnly: true,
  }
}

function manifestBody(sourceDir, config, source, header, capturedAt, candidateUnion = null) {
  return {
    schemaVersion: candidateUnion ? 2 : 1,
    status: 'conditional_share_holder_coverage_only',
    config,
    block: header.number,
    blockHash: header.hash,
    blockTimestamp: header.timestamp,
    capturedAt,
    deploymentProofSha256: source.deploymentProofSha256,
    contiguousSourceFromDeployment: source.contiguousFromDeployment,
    sourceSegments: source.segments,
    ...(candidateUnion ? { apiCandidateUnion: candidateUnion } : {}),
    candidateRecipients: candidateUnion?.candidateRecipients ?? source.candidateRecipients,
    pageCount: Math.ceil(
      (candidateUnion?.candidateRecipients ?? source.candidateRecipients).length / PAGE_SIZE,
    ),
    // No source path or credential is sealed; physical segment digests bind replay.
  }
}

export async function prepare({
  sourceDir,
  apiJournal = null,
  out,
  config,
  rpcRead,
  peerRpcRead,
  stat = statfsSync,
  now = () => new Date(),
}) {
  assertCertificateOutputSeparated(out, sourceDir, apiJournal)
  checkDisk(out, stat)
  const release = acquireOutputLock(out)
  try {
    if (typeof rpcRead !== 'function' || typeof peerRpcRead !== 'function') fail('reader_invalid')
    if (names(out).filter((name) => name !== OUTPUT_LOCK).length) fail('output_not_empty')
    checkDisk(out, stat)
    const source = frozenSource(sourceDir, config, !apiJournal)
    const candidateUnion = apiJournal
      ? verifiedCandidateUnion(sourceDir, config, source, apiJournal)
      : null
    const targetBlock = candidateUnion?.throughBlock ?? source.throughBlock
    const targetHash = candidateUnion?.frontierHash ?? source.frontierHash
    const at = async (read) => read('eth_getBlockByNumber', [hex(targetBlock), false])
    const finalized = await rpcRead('eth_getBlockByNumber', ['finalized', false])
    const peerFinalized = await peerRpcRead('eth_getBlockByNumber', ['finalized', false])
    if (
      number(await rpcRead('eth_chainId', [])) !== 1 ||
      number(await peerRpcRead('eth_chainId', [])) !== 1 ||
      number(finalized?.number) < targetBlock ||
      number(peerFinalized?.number) < targetBlock
    )
      fail('not_finalized')
    const raw = await at(rpcRead)
    const peer = await at(peerRpcRead)
    const block = {
      number: number(raw?.number),
      hash: lower(raw?.hash),
      timestamp: number(raw?.timestamp),
    }
    if (
      block.number !== targetBlock ||
      block.hash !== targetHash ||
      !HASH.test(block.hash) ||
      lower(peer?.hash) !== block.hash ||
      number(peer?.number) !== block.number ||
      number(peer?.timestamp) !== block.timestamp
    )
      fail('source_block_reorg')
    const capturedAt = now().toISOString()
    const age = Date.parse(capturedAt) / 1000 - block.timestamp
    if (!Number.isFinite(age) || age < 0 || age > MAX_AGE_SECONDS) fail('source_stale')
    assertSourceUnchanged(sourceDir, config, source)
    if (candidateUnion) {
      const checked = verifiedCandidateUnion(sourceDir, config, source, apiJournal)
      if (JSON.stringify(checked) !== JSON.stringify(candidateUnion))
        fail('api_changed_during_prepare')
    }
    const body = manifestBody(sourceDir, config, source, block, capturedAt, candidateUnion)
    return writeSeal(out, 'manifest', body, stat)
  } finally {
    release()
  }
}

export function loadManifest({ sourceDir, apiJournal = null, out, config }) {
  const name = one(out, /^manifest-[a-f0-9]{64}\.json$/)
  const manifest = readSeal(out, name, FILE.exec(name)[2])
  const source = frozenSource(sourceDir, config, false)
  const prefix = frozenPrefix(sourceDir, source, manifest)
  const candidateUnion =
    manifest.schemaVersion === 2
      ? verifiedCandidateUnion(sourceDir, config, source, apiJournal, manifest.apiCandidateUnion)
      : null
  if (
    (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) ||
    (manifest.schemaVersion === 1 &&
      (apiJournal !== null || manifest.apiCandidateUnion !== undefined)) ||
    (manifest.schemaVersion === 2 &&
      JSON.stringify(manifest.apiCandidateUnion) !== JSON.stringify(candidateUnion)) ||
    manifest.status !== 'conditional_share_holder_coverage_only' ||
    JSON.stringify(manifest.config) !== JSON.stringify(config) ||
    (candidateUnion &&
      (prefix.throughBlock !== candidateUnion.anchor.frontierBlock ||
        prefix.frontierHash !== candidateUnion.anchor.frontierHash)) ||
    manifest.block !== (candidateUnion?.throughBlock ?? prefix.throughBlock) ||
    manifest.blockHash !== (candidateUnion?.frontierHash ?? prefix.frontierHash) ||
    !HASH.test(manifest.blockHash) ||
    manifest.deploymentProofSha256 !== source.deploymentProofSha256 ||
    manifest.contiguousSourceFromDeployment !== source.contiguousFromDeployment ||
    !Array.isArray(manifest.candidateRecipients) ||
    manifest.candidateRecipients.length < 1 ||
    manifest.candidateRecipients.length > MAX_CANDIDATES ||
    JSON.stringify(manifest.candidateRecipients) !==
      JSON.stringify(candidateUnion?.candidateRecipients ?? prefix.candidateRecipients) ||
    manifest.pageCount !==
      Math.ceil(
        (candidateUnion?.candidateRecipients ?? prefix.candidateRecipients).length / PAGE_SIZE,
      ) ||
    !Number.isSafeInteger(manifest.blockTimestamp) ||
    manifest.blockTimestamp <= 0 ||
    !Number.isFinite(Date.parse(manifest.capturedAt)) ||
    Date.parse(manifest.capturedAt) / 1000 - manifest.blockTimestamp > MAX_AGE_SECONDS ||
    Date.parse(manifest.capturedAt) / 1000 < manifest.blockTimestamp
  )
    fail('manifest_replay_invalid')
  return { manifest, manifestSha256: FILE.exec(name)[2] }
}

function codeIdentity(code, storage) {
  const rawCode = lower(code)
  const word = lower(storage)
  if (!/^0x(?:[0-9a-f]{2})+$/.test(rawCode) || rawCode === '0x' || !/^0x[0-9a-f]{64}$/.test(word))
    fail('code_identity_invalid')
  const implementation = `0x${word.slice(-40)}`
  return { codeHash: keccak256(rawCode), implementation, implementationSlotRaw: word }
}

async function pinnedReading({ rpcRead, manifest, config, owners }) {
  const blockArg = { blockHash: manifest.blockHash, requireCanonical: true }
  const read = async (method, params) => rpcRead(method, params)
  const head = await read('eth_getBlockByNumber', [hex(manifest.block), false])
  if (
    number(head?.number) !== manifest.block ||
    lower(head?.hash) !== manifest.blockHash ||
    number(head?.timestamp) !== manifest.blockTimestamp
  )
    fail('block_reorg')
  const code = await read('eth_getCode', [config.address, blockArg])
  const storage = await read('eth_getStorageAt', [config.address, IMPLEMENTATION_SLOT, blockArg])
  const identity = codeIdentity(code, storage)
  if (identity.implementation !== `0x${'0'.repeat(40)}`) {
    const implementationCode = lower(await read('eth_getCode', [identity.implementation, blockArg]))
    if (!/^0x(?:[0-9a-f]{2})+$/.test(implementationCode) || implementationCode === '0x')
      fail('implementation_code_invalid')
    identity.implementationCodeHash = keccak256(implementationCode)
  } else {
    identity.implementationCodeHash = null
  }
  const call = async (key, args = []) => {
    const data = encodeFunctionData({ abi: [abi[key]], functionName: key, args })
    const result = await read('eth_call', [{ to: config.address, data }, blockArg])
    try {
      return decodeFunctionResult({ abi: [abi[key]], functionName: key, data: result })
    } catch {
      fail('subcall_failed')
    }
  }
  const asset = lower(await call('asset'))
  if (!ADDRESS.test(asset) || asset !== UNDERLYING[config.token]) fail('asset_identity_invalid')
  const supply = await call('totalSupply')
  if (typeof supply !== 'bigint' || supply <= 0n) fail('supply_invalid')
  // Direct pinned reads avoid trusting a separate, unattested Multicall3 runtime.
  const balances = []
  for (const owner of owners) {
    const balance = await call('balanceOf', [owner])
    if (typeof balance !== 'bigint' || balance < 0n) fail('balance_invalid')
    balances.push(balance.toString())
  }
  const after = await read('eth_getBlockByNumber', [hex(manifest.block), false])
  if (
    lower(after?.hash) !== manifest.blockHash ||
    number(after?.timestamp) !== manifest.blockTimestamp
  )
    fail('block_reorg')
  return { identity, asset, supplyRaw: supply.toString(), balances }
}

export async function collectPage({
  sourceDir,
  apiJournal = null,
  out,
  config,
  page,
  rpcRead,
  stat = statfsSync,
  now = () => new Date(),
}) {
  assertCertificateOutputSeparated(out, sourceDir, apiJournal)
  checkDisk(out, stat)
  const release = acquireOutputLock(out)
  try {
    const { manifest, manifestSha256 } = loadManifest({ sourceDir, apiJournal, out, config })
    if (
      !Number.isInteger(page) ||
      page < 0 ||
      page >= manifest.pageCount ||
      typeof rpcRead !== 'function'
    )
      fail('page_invalid')
    if (names(out).some((n) => n.startsWith(`page-${String(page).padStart(6, '0')}-`)))
      fail('page_duplicate')
    checkDisk(out, stat)
    const finalized = await rpcRead('eth_getBlockByNumber', ['finalized', false])
    if (
      number(finalized?.number) < manifest.block ||
      number(await rpcRead('eth_chainId', [])) !== 1
    )
      fail('not_finalized')
    const owners = manifest.candidateRecipients.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
    const reading = await pinnedReading({ rpcRead, manifest, config, owners })
    const capturedAt = now().toISOString()
    if (!pageCapturedInWindow(capturedAt, manifest)) fail('page_window_expired')
    const body = {
      schemaVersion: manifest.schemaVersion,
      manifestSha256,
      page,
      pageCount: manifest.pageCount,
      block: manifest.block,
      blockHash: manifest.blockHash,
      capturedAt,
      ...reading,
      rows: owners.map((owner, i) => ({ owner, balanceRaw: reading.balances[i] })),
    }
    delete body.balances
    return writeSeal(out, `page-${String(page).padStart(6, '0')}`, body, stat)
  } finally {
    release()
  }
}

export function reconcile({ sourceDir, apiJournal = null, out, config }) {
  const { manifest, manifestSha256 } = loadManifest({ sourceDir, apiJournal, out, config })
  const all = names(out)
  if (
    all.some(
      (n) =>
        !/^manifest-[a-f0-9]{64}\.json$/.test(n) &&
        !PAGE.test(n) &&
        n !== OUTPUT_LOCK &&
        !/^reconciliation-[a-f0-9]{64}\.json$/.test(n),
    )
  )
    fail('unknown_artifact')
  const pageNames = all.filter((n) => PAGE.test(n))
  if (pageNames.length !== manifest.pageCount) fail('page_count_incomplete')
  let identity = null
  let asset = null
  let supply = null
  let sum = 0n
  const positive = []
  let completedAtMs = Date.parse(manifest.capturedAt)
  for (let page = 0; page < manifest.pageCount; page++) {
    const group = pageNames.filter((name) => Number(PAGE.exec(name)[1]) === page)
    if (group.length !== 1) fail('page_missing_or_duplicate')
    const record = readSeal(out, group[0], PAGE.exec(group[0])[2])
    const owners = manifest.candidateRecipients.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
    if (
      record.schemaVersion !== manifest.schemaVersion ||
      record.manifestSha256 !== manifestSha256 ||
      record.page !== page ||
      record.pageCount !== manifest.pageCount ||
      record.block !== manifest.block ||
      record.blockHash !== manifest.blockHash ||
      !pageCapturedInWindow(record.capturedAt, manifest) ||
      !HASH.test(record.identity?.codeHash) ||
      !ADDRESS.test(record.identity?.implementation) ||
      !HASH.test(record.identity?.implementationSlotRaw) ||
      (record.identity.implementation === `0x${'0'.repeat(40)}`
        ? record.identity.implementationCodeHash !== null
        : !HASH.test(record.identity.implementationCodeHash)) ||
      record.asset !== UNDERLYING[config.token] ||
      !RAW.test(record.supplyRaw) ||
      BigInt(record.supplyRaw) <= 0n ||
      !Array.isArray(record.rows) ||
      record.rows.length !== owners.length ||
      record.rows.some((r, i) => r.owner !== owners[i] || !RAW.test(r.balanceRaw))
    )
      fail('page_replay_invalid')
    if (identity && JSON.stringify(identity) !== JSON.stringify(record.identity))
      fail('code_identity_changed')
    if (asset && asset !== record.asset) fail('asset_changed')
    if (supply && supply !== record.supplyRaw) fail('supply_changed')
    identity = record.identity
    asset = record.asset
    supply = record.supplyRaw
    completedAtMs = Math.max(completedAtMs, Date.parse(record.capturedAt))
    for (const row of record.rows) {
      const n = BigInt(row.balanceRaw)
      sum += n
      if (n > 0n) positive.push(row)
    }
  }
  if (!supply || sum !== BigInt(supply)) fail('supply_mismatch')
  return {
    schemaVersion: manifest.schemaVersion,
    status: 'conditional_share_holder_coverage_only',
    claim: 'exact_block_share_balance_reconciliation_not_route_tvl',
    contiguousSourceFromDeployment: manifest.contiguousSourceFromDeployment,
    ...(manifest.schemaVersion === 2
      ? {
          candidateEvidence: 'two_host_source_prefix_plus_alchemy_candidate_suffix',
          apiLogCompleteness: 'not_independently_proven',
          apiInteriorAncestry: 'not_independently_proven',
        }
      : {}),
    manifestSha256,
    block: manifest.block,
    blockHash: manifest.blockHash,
    blockTimestamp: manifest.blockTimestamp,
    captureStartedAt: manifest.capturedAt,
    captureCompletedAt: new Date(completedAtMs).toISOString(),
    ageAtCaptureSeconds: Math.floor(completedAtMs / 1000) - manifest.blockTimestamp,
    maxCaptureAgeSeconds: MAX_AGE_SECONDS,
    freshness: 'historical_as_of_only',
    asset,
    codeIdentity: identity,
    totalSupplyRaw: supply,
    candidateCount: manifest.candidateRecipients.length,
    positiveHolderCount: positive.length,
    positiveHoldersSha256: sha(JSON.stringify(positive)),
    pageNames,
  }
}

export function finalize({ sourceDir, apiJournal = null, out, config, stat = statfsSync }) {
  assertCertificateOutputSeparated(out, sourceDir, apiJournal)
  checkDisk(out, stat)
  const release = acquireOutputLock(out)
  try {
    if (names(out).some((n) => n.startsWith('reconciliation-'))) fail('reconciliation_duplicate')
    return writeSeal(out, 'reconciliation', reconcile({ sourceDir, apiJournal, out, config }), stat)
  } finally {
    release()
  }
}

export function verify({ sourceDir, apiJournal = null, out, config }) {
  const name = one(out, /^reconciliation-[a-f0-9]{64}\.json$/)
  const body = readSeal(out, name, FILE.exec(name)[2])
  const expected = reconcile({ sourceDir, apiJournal, out, config })
  if (JSON.stringify(body) !== JSON.stringify(expected)) fail('reconciliation_replay_invalid')
  return { ...body, reconciliationSha256: FILE.exec(name)[2] }
}

export function promote() {
  // There is no reviewed trust root for the deployed sGHO/sUSDe additive
  // share-accounting implementation in this repo. A caller-provided string or
  // digest is not independent review. Wire a pinned, reviewed attestation in
  // a separate change before any public certificate can be emitted.
  fail('deployed_accounting_attestation_missing')
}

function parseArgs(argv) {
  let mode = null
  let run = false
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (['--prepare', '--page', '--finalize', '--verify'].includes(token)) {
      if (mode) fail('cli_invalid')
      mode = token
      if (token === '--page') options.page = argv[++i]
    } else if (token === '--run') {
      if (run) fail('cli_invalid')
      run = true
    } else if (
      [
        '--token',
        '--deployment-block',
        '--start-block',
        '--source',
        '--out',
        '--api-journal',
        '--capability-source',
        '--capability-segment',
        '--capability-start-block',
        '--capability-receipt',
        '--rpc-hosts',
      ].includes(token)
    ) {
      if (options[token] !== undefined || !argv[i + 1]) fail('cli_invalid')
      options[token] = argv[++i]
    } else fail('cli_invalid')
  }
  if (
    !mode ||
    !options['--token'] ||
    !options['--deployment-block'] ||
    !options['--source'] ||
    !options['--out'] ||
    (mode === '--verify' && run) ||
    (mode !== '--verify' && !run)
  )
    fail('cli_invalid')
  const config = {
    chainId: 1,
    token: options['--token'],
    address: TOKENS[options['--token']],
    deploymentBlock: Number(options['--deployment-block']),
    startBlock: Number(options['--start-block'] ?? options['--deployment-block']),
  }
  const page = options.page === undefined ? undefined : Number(options.page)
  if (mode === '--page' && (!Number.isSafeInteger(page) || page < 0)) fail('cli_invalid')
  const apiKeys = [
    '--api-journal',
    '--capability-source',
    '--capability-segment',
    '--capability-start-block',
    '--capability-receipt',
  ]
  if (apiKeys.some((key) => Boolean(options[key])) && apiKeys.some((key) => !options[key]))
    fail('cli_invalid')
  return {
    mode,
    sourceDir: resolve(options['--source']),
    out: resolve(options['--out']),
    config,
    page,
    apiOptions: options['--api-journal']
      ? {
          out: resolve(options['--api-journal']),
          capabilitySource: resolve(options['--capability-source']),
          capabilitySegment: options['--capability-segment'],
          capabilityStartBlock: Number(options['--capability-start-block']),
          capabilityReceipt: resolve(options['--capability-receipt']),
        }
      : null,
    rpcHosts: options['--rpc-hosts'],
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv)
  if (args.apiOptions) {
    const manifestName =
      args.mode === '--prepare' ? null : one(args.out, /^manifest-[a-f0-9]{64}\.json$/)
    const prior = manifestName ? readSeal(args.out, manifestName, FILE.exec(manifestName)[2]) : null
    if (prior && prior.schemaVersion !== 2) fail('api_binding_invalid')
    const source = frozenSource(args.sourceDir, args.config, false)
    const frontierBlock = prior?.apiCandidateUnion?.anchor?.frontierBlock ?? source.throughBlock
    const frontierHash = prior?.apiCandidateUnion?.anchor?.frontierHash ?? source.frontierHash
    args.apiJournal = {
      out: args.apiOptions.out,
      anchor: sourceAnchor({
        source: args.sourceDir,
        config: args.config,
        frontierBlock,
        frontierHash,
        requireCurrentTip: !prior,
      }),
      capability: await capabilityBinding({
        token: args.config.token,
        deploymentBlock: args.config.deploymentBlock,
        ...args.apiOptions,
      }),
    }
  }
  delete args.apiOptions
  if (args.mode === '--verify') return verify(args)
  if (args.mode === '--finalize') return finalize(args)
  if (args.mode === '--page' && dependencies.rpcRead)
    return collectPage({
      ...args,
      rpcRead: dependencies.rpcRead,
      stat: dependencies.stat ?? statfsSync,
      now: dependencies.now ?? (() => new Date()),
    })
  if (args.mode === '--prepare' && dependencies.rpcRead && dependencies.peerRpcRead)
    return prepare({
      ...args,
      rpcRead: dependencies.rpcRead,
      peerRpcRead: dependencies.peerRpcRead,
      stat: dependencies.stat ?? statfsSync,
      now: dependencies.now ?? (() => new Date()),
    })
  const env = dependencies.env ?? readEnv()
  const raw =
    dependencies.rpcUrls ??
    (dependencies.env ? undefined : process.env.RECORDER_RPC_URLS) ??
    env.get('RECORDER_RPC_URLS') ??
    (dependencies.env ? undefined : process.env.RECORDER_RPC_URL) ??
    env.get('RECORDER_RPC_URL')
  const urls = selectRpcUrls(raw, args.rpcHosts)
  const factory = dependencies.makeClient ?? makeClient
  const reader = (url) => {
    let client
    try {
      client = factory(url)
    } catch {
      fail('rpc_config_invalid')
    }
    return async (method, params) => {
      try {
        return await client.request({ method, params })
      } catch {
        fail('rpc_failure')
      }
    }
  }
  const rpcRead = dependencies.rpcRead ?? reader(urls[0])
  if (args.mode === '--page')
    return collectPage({
      ...args,
      rpcRead,
      stat: dependencies.stat ?? statfsSync,
      now: dependencies.now ?? (() => new Date()),
    })
  let peerRpcRead = dependencies.peerRpcRead
  if (!peerRpcRead) peerRpcRead = reader(urls[1])
  return prepare({
    ...args,
    rpcRead,
    peerRpcRead,
    stat: dependencies.stat ?? statfsSync,
    now: dependencies.now ?? (() => new Date()),
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(
        `${String(error.message).startsWith('share_certificate_') || String(error.message).startsWith('share_source_') ? error.message : 'share_certificate_failure'}\n`,
      )
      process.exitCode = 1
    },
  )
}
