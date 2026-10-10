// Bounded Alchemy share-Transfer recipient discovery. API rows are candidate
// evidence only: neither these pages nor the two-host source prove log completeness.
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
  realpathSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEnv } from '../lib/venue-reads.mjs'
import { main as capabilityMain } from './alchemy-share-capability.mjs'
import {
  CHUNK_BLOCKS,
  MAX_CHUNKS,
  MIN_FREE_BYTES,
  TOKENS,
  verify as verifySource,
} from './share-transfer-source.mjs'

export const MAX_PAGES = 4
export const MAX_RESPONSE_BYTES = 1_000_000
export const MAX_SEAL_BYTES = 2_000_000
export const MAX_CALLS = 40
export const MAX_RUN_MS = 120_000
export const WINDOW_BLOCKS = Object.freeze([CHUNK_BLOCKS, 5_000, 10_000, 50_000])
const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const FILE = /^(\d{12})-(\d{12})-([a-f0-9]{64})\.json$/
const ZERO = `0x${'0'.repeat(40)}`
const LOCK = '.alchemy-share-discovery.lock'
const sha = (v) => createHash('sha256').update(v).digest('hex')
const hex = (n) => `0x${n.toString(16)}`
const fail = (code) => {
  throw new Error(`alchemy_share_discovery_${code}`)
}
const safe = (n) => Number.isSafeInteger(n) && n >= 0

function canonicalTarget(path) {
  let current = resolve(path)
  const suffix = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) fail('path_invalid')
    suffix.unshift(basename(current))
    current = parent
  }
  try {
    return resolve(realpathSync(current), ...suffix)
  } catch {
    fail('path_invalid')
  }
}

export function assertOutputSeparated(out, roots) {
  const target = canonicalTarget(out)
  for (const root of roots) {
    const base = canonicalTarget(root)
    const inside = relative(base, target)
    if (inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)))
      fail('out_inside_source_or_receipt')
  }
}

export function sourceAnchor({
  source,
  config,
  frontierBlock,
  frontierHash,
  requireCurrentTip = false,
}) {
  if (!safe(frontierBlock) || !HASH.test(frontierHash ?? '')) fail('frontier_invalid')
  const replay = verifySource({ out: source, config })
  const index = replay.segments.findIndex(
    (item) => Number(item.name.slice(13, 25)) === frontierBlock,
  )
  if (index < 0) fail('frontier_not_sealed')
  if (
    requireCurrentTip &&
    (replay.throughBlock !== frontierBlock || replay.frontierHash !== frontierHash)
  )
    fail('source_tip_advanced')
  const bytes = readFileSync(join(source, replay.segments[index].name))
  const segment = JSON.parse(bytes)
  if (segment.toHeader.hash !== frontierHash) fail('frontier_hash_mismatch')
  return {
    config,
    sourcePath: resolve(source),
    frontierBlock,
    frontierHash,
    sourcePrefixSha256: sha(JSON.stringify(replay.segments.slice(0, index + 1))),
    sourceLogCompleteness: 'not_independently_proven',
  }
}

export async function capabilityBinding({
  token,
  deploymentBlock,
  capabilitySource,
  capabilitySegment,
  capabilityStartBlock,
  capabilityReceipt,
}) {
  const result = await capabilityMain([
    '--verify',
    '--source',
    capabilitySource,
    '--segment',
    capabilitySegment,
    '--token',
    token,
    '--deployment-block',
    String(deploymentBlock),
    '--start-block',
    String(capabilityStartBlock),
    '--out',
    capabilityReceipt,
  ])
  if (
    result.result?.status !== 'matched' ||
    result.result.exactLogIdentity !== true ||
    result.result.apiLogIndexAvailable !== true
  )
    fail('capability_not_exact')
  const receipt = JSON.parse(readFileSync(join(capabilityReceipt, result.name), 'utf8'))
  return {
    token,
    deploymentBlock,
    sourcePath: resolve(capabilitySource),
    sourceSegment: capabilitySegment,
    sourceStartBlock: capabilityStartBlock,
    sourcePhysicalSha256: receipt.source.physicalSha256,
    sourceFromBlock: receipt.source.fromBlock,
    sourceToBlock: receipt.source.toBlock,
    receiptPath: resolve(capabilityReceipt),
    receiptSha256: result.sha256,
    receiptName: result.name,
    comparison: 'one_nonzero_sealed_segment_exact_log_identity',
  }
}

export function checkDisk(out, stat = statfsSync, bytes = 0) {
  let at = out
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at)
  const space = stat(at)
  if (Number(space.bavail) * Number(space.bsize) - bytes < MIN_FREE_BYTES)
    fail('disk_reserve_reached')
}

function normalize(row, fromBlock, toBlock, tokenAddress) {
  if (
    row?.category !== 'erc20' ||
    String(row.rawContract?.address).toLowerCase() !== tokenAddress ||
    !HASH.test(String(row.hash).toLowerCase()) ||
    !ADDRESS.test(String(row.to).toLowerCase()) ||
    !ADDRESS.test(String(row.from).toLowerCase()) ||
    !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(row.blockNum ?? '') ||
    !/^0x[0-9a-f]+$/i.test(row.rawContract?.value ?? '')
  )
    fail('transfer_invalid')
  const blockNumber = Number(BigInt(row.blockNum))
  const valueRaw = BigInt(row.rawContract.value).toString()
  const match =
    typeof row.uniqueId === 'string'
      ? /^(0x[0-9a-f]{64}):log:(0|[1-9]\d*)$/i.exec(row.uniqueId)
      : null
  if (
    !safe(blockNumber) ||
    blockNumber < fromBlock ||
    blockNumber > toBlock ||
    !match ||
    match[1].toLowerCase() !== row.hash.toLowerCase()
  )
    fail('transfer_identity_invalid')
  const logIndex = Number(match[2])
  if (!safe(logIndex)) fail('transfer_identity_invalid')
  return {
    blockNumber,
    transactionHash: row.hash.toLowerCase(),
    logIndex,
    sender: row.from.toLowerCase(),
    recipient: row.to.toLowerCase(),
    valueRaw,
  }
}

const identity = (row) => `${row.blockNumber}:${row.transactionHash}:${row.logIndex}`
export function candidates(rows) {
  return [
    ...new Set(
      rows.filter((r) => r.recipient !== ZERO && BigInt(r.valueRaw) > 0n).map((r) => r.recipient),
    ),
  ].sort()
}

export async function fetchWindow({ fromBlock, toBlock, tokenAddress, read }) {
  const rows = []
  const seenKeys = new Set()
  const seenIdentities = new Set()
  const seenTransactionLogs = new Set()
  let pageKey
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = {
      fromBlock: hex(fromBlock),
      toBlock: hex(toBlock),
      contractAddresses: [tokenAddress],
      category: ['erc20'],
      excludeZeroValue: false,
      maxCount: '0x3e8',
      order: 'asc',
      withMetadata: false,
      ...(pageKey ? { pageKey } : {}),
    }
    const response = await read('alchemy_getAssetTransfers', [params])
    if (
      response?.jsonrpc !== '2.0' ||
      response.error ||
      !Array.isArray(response.result?.transfers) ||
      response.result.transfers.length > 1000
    )
      fail('response_invalid')
    for (const item of response.result.transfers) {
      const row = normalize(item, fromBlock, toBlock, tokenAddress)
      const id = identity(row)
      if (seenIdentities.has(id)) fail('duplicate_log_identity')
      const transactionLog = `${row.transactionHash}:${row.logIndex}`
      if (seenTransactionLogs.has(transactionLog)) fail('duplicate_transaction_log')
      seenIdentities.add(id)
      seenTransactionLogs.add(transactionLog)
      rows.push(row)
    }
    const next = response.result.pageKey
    if (next === undefined || next === null || next === '')
      return { rows: rows.sort((a, b) => identity(a).localeCompare(identity(b))), pages: page }
    if (typeof next !== 'string' || next.length > 1024 || seenKeys.has(next))
      fail('page_key_invalid')
    seenKeys.add(next)
    pageKey = next
  }
  fail('pagination_incomplete')
}

function validateRows(rows, fromBlock, toBlock) {
  if (!Array.isArray(rows) || rows.length > MAX_PAGES * 1000) fail('rows_invalid')
  const seen = new Set()
  const seenTransactionLogs = new Set()
  for (const row of rows) {
    if (
      !safe(row?.blockNumber) ||
      row.blockNumber < fromBlock ||
      row.blockNumber > toBlock ||
      !HASH.test(row.transactionHash) ||
      !safe(row.logIndex) ||
      !ADDRESS.test(row.sender) ||
      !ADDRESS.test(row.recipient) ||
      !/^(0|[1-9]\d*)$/.test(row.valueRaw)
    )
      fail('rows_invalid')
    const id = identity(row)
    if (seen.has(id)) fail('duplicate_log_identity')
    const transactionLog = `${row.transactionHash}:${row.logIndex}`
    if (seenTransactionLogs.has(transactionLog)) fail('duplicate_transaction_log')
    seen.add(id)
    seenTransactionLogs.add(transactionLog)
  }
  if (
    JSON.stringify(rows) !==
    JSON.stringify([...rows].sort((a, b) => identity(a).localeCompare(identity(b))))
  )
    fail('rows_unsorted')
}

export function append(out, segment, stat = statfsSync) {
  const bytes = Buffer.from(JSON.stringify(segment))
  if (bytes.length > MAX_SEAL_BYTES) fail('seal_size_cap')
  checkDisk(out, stat, bytes.length)
  const name = `${String(segment.fromBlock).padStart(12, '0')}-${String(segment.toBlock).padStart(12, '0')}-${sha(bytes)}.json`
  const target = join(out, name)
  const temporary = `${target}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temporary, 'wx', 0o600)
    let position = 0
    while (position < bytes.length) {
      const written = writeSync(fd, bytes, position, bytes.length - position)
      if (written <= 0) fail('write_failed')
      position += written
    }
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    linkSync(temporary, target)
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
  return name
}

export function verify({ out, anchor, capability }) {
  const names = existsSync(out)
    ? readdirSync(out)
        .filter((n) => n !== LOCK)
        .sort()
    : []
  let throughBlock = anchor.frontierBlock
  let boundaryHash = anchor.frontierHash
  let transferCount = 0
  const owners = new Set()
  for (const name of names) {
    const parsed = FILE.exec(name)
    if (!parsed) fail('artifact_invalid')
    const bytes = readFileSync(join(out, name))
    if (bytes.length > MAX_SEAL_BYTES || sha(bytes) !== parsed[3]) fail('seal_hash_invalid')
    let segment
    try {
      segment = JSON.parse(bytes)
    } catch {
      fail('seal_invalid')
    }
    const segmentWindowBlocks =
      segment.schemaVersion === 1
        ? CHUNK_BLOCKS
        : segment.schemaVersion === 2 && WINDOW_BLOCKS.includes(segment.windowBlocks)
          ? segment.windowBlocks
          : null
    if (
      segmentWindowBlocks === null ||
      (segment.schemaVersion === 1 && segment.windowBlocks !== undefined) ||
      (segment.schemaVersion === 2 &&
        segment.windowQualification !== 'experimental_page_key_exhausted_only') ||
      JSON.stringify(segment.anchor) !== JSON.stringify(anchor) ||
      JSON.stringify(segment.capability) !== JSON.stringify(capability) ||
      segment.fromBlock !== throughBlock + 1 ||
      segment.toBlock !== Number(parsed[2]) ||
      segment.fromBlock !== Number(parsed[1]) ||
      segment.toBlock - segment.fromBlock + 1 !== segmentWindowBlocks ||
      segment.fromParentHash !== boundaryHash ||
      !HASH.test(segment.fromHash) ||
      !HASH.test(segment.toHash) ||
      !safe(segment.finalizedHead) ||
      segment.finalizedHead < segment.toBlock ||
      !HASH.test(segment.finalizedHeadHash) ||
      !safe(segment.pages) ||
      segment.pages < 1 ||
      segment.pages > MAX_PAGES ||
      !Number.isFinite(Date.parse(segment.capturedAt)) ||
      segment.logCompleteness !== 'not_independently_proven' ||
      (segment.schemaVersion === 1 &&
        segment.interiorAncestry !== undefined &&
        segment.interiorAncestry !== 'not_independently_proven') ||
      (segment.schemaVersion === 2 && segment.interiorAncestry !== 'not_independently_proven') ||
      segment.currentHolderCertificate !== false ||
      segment.routeTvlClaim !== false
    )
      fail('seal_invalid')
    validateRows(segment.rows, segment.fromBlock, segment.toBlock)
    if (JSON.stringify(segment.candidateRecipients) !== JSON.stringify(candidates(segment.rows)))
      fail('candidate_mismatch')
    for (const candidate of segment.candidateRecipients) owners.add(candidate)
    transferCount += segment.rows.length
    throughBlock = segment.toBlock
    boundaryHash = segment.toHash
  }
  return {
    throughBlock,
    boundaryHash,
    segmentCount: names.length,
    transferCount,
    candidateRecipients: [...owners].sort(),
    candidateDiscoveryOnly: true,
    logCompleteness: 'not_independently_proven',
    interiorAncestry: 'not_independently_proven',
    windowQualification: names.length > 0 ? 'experimental_page_key_exhausted_only' : null,
  }
}

async function assertProofBindings(anchor, capability) {
  const checkedAnchor = sourceAnchor({
    source: anchor.sourcePath,
    config: anchor.config,
    frontierBlock: anchor.frontierBlock,
    frontierHash: anchor.frontierHash,
    requireCurrentTip: true,
  })
  const checkedCapability = await capabilityBinding({
    token: capability.token,
    deploymentBlock: capability.deploymentBlock,
    capabilitySource: capability.sourcePath,
    capabilitySegment: capability.sourceSegment,
    capabilityStartBlock: capability.sourceStartBlock,
    capabilityReceipt: capability.receiptPath,
  })
  if (
    JSON.stringify(checkedAnchor) !== JSON.stringify(anchor) ||
    JSON.stringify(checkedCapability) !== JSON.stringify(capability)
  )
    fail('proof_binding_changed')
}

export async function collect({
  out,
  anchor,
  capability,
  maxChunks = 1,
  windowBlocks = CHUNK_BLOCKS,
  rpcRead,
  stat = statfsSync,
  now = Date.now,
  capturedAt = () => new Date().toISOString(),
}) {
  if (
    !TOKENS[anchor?.config?.token] ||
    anchor.config.address !== TOKENS[anchor.config.token] ||
    capability?.token !== anchor.config.token ||
    !safe(maxChunks) ||
    maxChunks < 1 ||
    maxChunks > MAX_CHUNKS ||
    !WINDOW_BLOCKS.includes(windowBlocks) ||
    typeof rpcRead !== 'function'
  )
    fail('input_invalid')
  assertOutputSeparated(out, [anchor.sourcePath, capability.sourcePath, capability.receiptPath])
  await assertProofBindings(anchor, capability)
  checkDisk(out, stat)
  mkdirSync(out, { recursive: true })
  const lockPath = join(out, LOCK)
  let lock
  try {
    lock = openSync(lockPath, 'wx', 0o600)
  } catch {
    fail('lock_held')
  }
  try {
    const initial = verify({ out, anchor, capability })
    let throughBlock = initial.throughBlock
    let parentHash = initial.boundaryHash
    let calls = 0
    const started = now()
    const read = async (method, params) => {
      checkDisk(out, stat)
      if (++calls > MAX_CALLS) fail('request_cap')
      const remaining = MAX_RUN_MS - (now() - started)
      if (remaining <= 0) fail('deadline')
      try {
        const value = await rpcRead(method, params, remaining)
        if (now() - started >= MAX_RUN_MS) fail('deadline')
        return value
      } catch (error) {
        if (error?.message === 'alchemy_share_discovery_deadline') throw error
        fail('provider_failure')
      }
    }
    const number = (raw) => {
      if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(raw ?? '')) fail('header_invalid')
      const n = Number(BigInt(raw))
      if (!safe(n)) fail('header_invalid')
      return n
    }
    const header = async (tag, expected) => {
      const value = await read('eth_getBlockByNumber', [tag, false])
      const h = {
        number: number(value?.number),
        hash: String(value?.hash).toLowerCase(),
        parentHash: String(value?.parentHash).toLowerCase(),
      }
      if (
        (expected !== undefined && h.number !== expected) ||
        !HASH.test(h.hash) ||
        !HASH.test(h.parentHash)
      )
        fail('header_invalid')
      return h
    }
    const finalized = await header('finalized')
    for (let i = 0; i < maxChunks; i++) {
      const fromBlock = throughBlock + 1
      const toBlock = fromBlock + windowBlocks - 1
      if (toBlock > finalized.number) break
      const from = await header(hex(fromBlock), fromBlock)
      const to = await header(hex(toBlock), toBlock)
      if (from.parentHash !== parentHash) fail('frontier_mismatch')
      const result = await fetchWindow({
        fromBlock,
        toBlock,
        tokenAddress: anchor.config.address,
        read,
      })
      const fromRecheck = await header(hex(fromBlock), fromBlock)
      const toRecheck = await header(hex(toBlock), toBlock)
      const finalizedRecheck = await header(hex(finalized.number), finalized.number)
      if (
        fromRecheck.hash !== from.hash ||
        fromRecheck.parentHash !== from.parentHash ||
        toRecheck.hash !== to.hash ||
        toRecheck.parentHash !== to.parentHash ||
        finalizedRecheck.hash !== finalized.hash
      )
        fail('boundary_changed')
      const segment = {
        schemaVersion: 2,
        windowBlocks,
        windowQualification: 'experimental_page_key_exhausted_only',
        anchor,
        capability,
        fromBlock,
        toBlock,
        fromHash: from.hash,
        fromParentHash: from.parentHash,
        toHash: to.hash,
        finalizedHead: finalized.number,
        finalizedHeadHash: finalized.hash,
        capturedAt: capturedAt(),
        pages: result.pages,
        rows: result.rows,
        candidateRecipients: candidates(result.rows),
        logCompleteness: 'not_independently_proven',
        interiorAncestry: 'not_independently_proven',
        currentHolderCertificate: false,
        routeTvlClaim: false,
      }
      append(out, segment, stat)
      throughBlock = toBlock
      parentHash = to.hash
    }
    // One bounded replay after the run catches proof changes during collection;
    // re-reading the entire source prefix for every chunk scales poorly.
    await assertProofBindings(anchor, capability)
    return verify({ out, anchor, capability })
  } finally {
    closeSync(lock)
    unlinkSync(lockPath)
  }
}

function parseArgs(argv) {
  const args = {}
  let mode = 'dry'
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === '--run' || key === '--verify') {
      if (mode !== 'dry') fail('cli_invalid')
      mode = key
    } else if (
      [
        '--source',
        '--token',
        '--deployment-block',
        '--start-block',
        '--frontier-block',
        '--frontier-hash',
        '--capability-source',
        '--capability-segment',
        '--capability-start-block',
        '--capability-receipt',
        '--out',
        '--max-chunks',
        '--window-blocks',
      ].includes(key)
    ) {
      if (args[key] || !argv[i + 1]) fail('cli_invalid')
      args[key] = argv[++i]
    } else fail('cli_invalid')
  }
  if (
    !args['--source'] ||
    !args['--token'] ||
    !args['--deployment-block'] ||
    !args['--start-block'] ||
    !args['--frontier-block'] ||
    !args['--frontier-hash'] ||
    !args['--capability-source'] ||
    !args['--capability-segment'] ||
    !args['--capability-start-block'] ||
    !args['--capability-receipt'] ||
    !args['--out'] ||
    (mode === '--run' && !args['--max-chunks']) ||
    (mode === '--verify' && args['--window-blocks'] !== undefined)
  )
    fail('cli_invalid')
  const token = args['--token']
  if (!TOKENS[token]) fail('token_invalid')
  for (const key of [
    '--deployment-block',
    '--start-block',
    '--frontier-block',
    '--capability-start-block',
    '--max-chunks',
    '--window-blocks',
  ]) {
    if (args[key] !== undefined && !/^(0|[1-9]\d*)$/.test(args[key])) fail('cli_invalid')
  }
  const windowBlocks = Number(args['--window-blocks'] ?? CHUNK_BLOCKS)
  if (!WINDOW_BLOCKS.includes(windowBlocks)) fail('window_blocks_invalid')
  return {
    mode,
    source: resolve(args['--source']),
    token,
    deploymentBlock: Number(args['--deployment-block']),
    startBlock: Number(args['--start-block']),
    frontierBlock: Number(args['--frontier-block']),
    frontierHash: args['--frontier-hash'],
    capabilitySource: resolve(args['--capability-source']),
    capabilitySegment: args['--capability-segment'],
    capabilityStartBlock: Number(args['--capability-start-block']),
    capabilityReceipt: resolve(args['--capability-receipt']),
    out: resolve(args['--out']),
    maxChunks: Number(args['--max-chunks'] ?? 1),
    windowBlocks,
  }
}

function alchemyUrl(raw) {
  const matches = String(raw ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((value) => {
      try {
        const url = new URL(value)
        return (
          url.protocol === 'https:' &&
          url.hostname === 'eth-mainnet.g.alchemy.com' &&
          /^\/v2\/[^/]+$/.test(url.pathname)
        )
      } catch {
        return false
      }
    })
  if (matches.length !== 1) fail('alchemy_endpoint_required')
  return matches[0]
}

async function liveReader(url, method, params, remaining) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.min(20_000, remaining))
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    })
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > MAX_RESPONSE_BYTES)
      fail('provider_failure')
    const reader = response.body?.getReader()
    if (!reader) fail('response_invalid')
    const chunks = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        fail('response_size_cap')
      }
      chunks.push(value)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (body?.jsonrpc !== '2.0' || body?.id !== 1 || body.error) fail('response_invalid')
    return method === 'alchemy_getAssetTransfers' ? body : body.result
  } catch (error) {
    if (String(error?.message).startsWith('alchemy_share_discovery_')) throw error
    fail('provider_failure')
  } finally {
    clearTimeout(timer)
  }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv)
  assertOutputSeparated(args.out, [args.source, args.capabilitySource, args.capabilityReceipt])
  const config = {
    chainId: 1,
    token: args.token,
    address: TOKENS[args.token],
    deploymentBlock: args.deploymentBlock,
    startBlock: args.startBlock,
  }
  const anchor = sourceAnchor({
    source: args.source,
    config,
    frontierBlock: args.frontierBlock,
    frontierHash: args.frontierHash,
  })
  const capability = await capabilityBinding(args)
  if (args.mode === '--verify') return verify({ out: args.out, anchor, capability })
  if (args.mode !== '--run')
    return {
      status: 'dry_run',
      anchor,
      capability,
      out: args.out,
      maxChunks: args.maxChunks,
      windowBlocks: args.windowBlocks,
      windowQualification: 'experimental_page_key_exhausted_only',
      requestMade: false,
    }
  checkDisk(args.out, deps.stat ?? statfsSync)
  const env = deps.rpcRead ? null : (deps.env ?? readEnv())
  const url = deps.rpcRead
    ? null
    : alchemyUrl(deps.rpcUrls ?? env.get('RECORDER_RPC_URLS') ?? env.get('RECORDER_RPC_URL'))
  return collect({
    out: args.out,
    anchor,
    capability,
    maxChunks: args.maxChunks,
    windowBlocks: args.windowBlocks,
    rpcRead:
      deps.rpcRead ?? ((method, params, remaining) => liveReader(url, method, params, remaining)),
    stat: deps.stat,
    now: deps.now,
    capturedAt: deps.capturedAt,
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (value) => {
      const printed = { ...value }
      if (Array.isArray(printed.candidateRecipients)) {
        printed.candidateRecipientCount = printed.candidateRecipients.length
        delete printed.candidateRecipients
      }
      process.stdout.write(`${JSON.stringify(printed)}\n`)
    },
    (error) => {
      process.stderr.write(
        `${
          String(error?.message).startsWith('alchemy_share_discovery_')
            ? error.message
            : 'alchemy_share_discovery_failure'
        }\n`,
      )
      process.exitCode = 1
    },
  )
}
