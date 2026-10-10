// Finite, two-origin continuation of the attested 25-hour Aave USDC cash pilot.
// Each accepted (A,B] slice has two full collector receipts; their raw logs,
// endpoint identities and cash reconciliation must agree before publication.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { collect, verify as verifyCollector } from './aave-core-operation-collector.mjs'

export const STUDY = 'aave-usdc-market-cash-archive-v1'
export const OUT = resolve('data/research/venue-signals/aave-usdc-market-cash-archive-v1')
export const FROM_BLOCK = 26_079_860
export const FROM_HASH = '0x25bac1e47e596b773f4f0913f97a23b54cb7e8e54d43925f9d7a46a053281d16'
export const TO_BLOCK = 26_095_417
export const SLICE_BLOCKS = 256
export const ALCHEMY_SLICE_BLOCKS = 256
export const ALCHEMY_LOG_CHUNK_BLOCKS = 10
export const QUICKNODE_LOG_CHUNK_BLOCKS = 5
export const QUICKNODE_SLICE_BLOCKS = 64
const MIN_ACCEPTED_SLICE_BLOCKS = 10
const LEGACY_BOOTSTRAP_SLICE_BLOCKS = 128
const isLegacyBootstrapSlice = (from, to) =>
  (from === FROM_BLOCK && to === FROM_BLOCK + LEGACY_BOOTSTRAP_SLICE_BLOCKS) ||
  (from === FROM_BLOCK + LEGACY_BOOTSTRAP_SLICE_BLOCKS &&
    to === FROM_BLOCK + 2 * LEGACY_BOOTSTRAP_SLICE_BLOCKS)
export const ORIGINS = Object.freeze(['https://mainnet.infura.io', 'https://rpc.ankr.com'])
export const ALCHEMY_ORIGIN = 'https://eth-mainnet.g.alchemy.com'
export const DRPC_ORIGIN = 'https://lb.drpc.live'
export const QUICKNODE_ORIGIN = 'https://divine-spring-wind.ethereum-mainnet.quiknode.pro'
const LEFT_ORIGINS = Object.freeze([ORIGINS[0], ALCHEMY_ORIGIN, DRPC_ORIGIN, QUICKNODE_ORIGIN])
// Pair replay includes raw query windows and reconciliation coverage, so the
// independent Ankr capture must use the selected left origin's chunk size.
export const archiveLogChunkBlocks = (leftOrigin) =>
  leftOrigin === QUICKNODE_ORIGIN
    ? QUICKNODE_LOG_CHUNK_BLOCKS
    : leftOrigin === ALCHEMY_ORIGIN
      ? ALCHEMY_LOG_CHUNK_BLOCKS
      : undefined
const HASH = /^0x[0-9a-f]{64}$/
const SOURCE_RECEIPT = /^USDC-[0-9]+-[0-9]+-[0-9a-f]{64}\.json$/
const BENIGN_LOCAL_METADATA = new Set([
  '.AppleDouble',
  '.DocumentRevisions-V100',
  '.DS_Store',
  '.fseventsd',
  '.LSOverride',
  '.Spotlight-V100',
  '.TemporaryItems',
  '.Trashes',
  'Icon\r',
])
const withoutBenignLocalMetadata = (names) => {
  const present = new Set(names)
  return names.filter((file) => {
    if (/^\._[^/]+$/.test(file)) return !present.has(file.slice(2))
    return !BENIGN_LOCAL_METADATA.has(file)
  })
}
const name = (a, b) => `slice-${a}-${b}.json`
const witnessName = (origin, a, b) => `origin-${origin}-${a}-${b}.json`
const sha = (body) => createHash('sha256').update(body).digest('hex')
const fail = (ok, code) => {
  if (!ok) throw new Error(code)
}
const originsHash = ORIGINS.map((origin) => sha(origin))
const originName = (origin) => {
  if (origin === ORIGINS[0]) return 'infura'
  if (origin === ALCHEMY_ORIGIN) return 'alchemy'
  if (origin === DRPC_ORIGIN) return 'drpc'
  if (origin === QUICKNODE_ORIGIN) return 'quicknode'
  if (origin === ORIGINS[1]) return 'ankr'
  throw new Error('archive_origin_config')
}

function readJson(path, maxBytes = 4 * 1024 * 1024) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = fstatSync(fd)
    fail(before.isFile() && before.size > 0 && before.size <= maxBytes, 'archive_file_size')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, null)
      fail(n > 0, 'archive_short_read')
      offset += n
    }
    fail(fstatSync(fd).size === before.size, 'archive_changed_file')
    return JSON.parse(bytes.toString('utf8'))
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function canonicalDir(path) {
  fail(
    lstatSync(path).isDirectory() && realpathSync(path) === path,
    'archive_noncanonical_directory',
  )
}

function pathPresent(path) {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function atomic(outDir, path, body) {
  const fs = statfsSync(outDir)
  fail(
    Number(fs.bavail) * Number(fs.bsize) - Buffer.byteLength(body) >= 1024 ** 3,
    'archive_disk_reserve',
  )
  const stage = `${path}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(
      stage,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    writeFileSync(fd, body)
    fchmodSync(fd, 0o444)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    linkSync(stage, path)
    const dir = openSync(outDir, constants.O_RDONLY)
    try {
      fsyncSync(dir)
    } finally {
      closeSync(dir)
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    try {
      unlinkSync(stage)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

// Compare exactly the data that can change reserve cash, not local timestamps
// or the providers' different finalized heads at collection time.
export function economicProjection(receipt) {
  const chunks = receipt.chunks ?? {}
  return {
    market: receipt.market,
    chainId: receipt.chainId,
    pool: receipt.pool,
    underlying: receipt.underlying,
    aToken: receipt.aToken,
    from: receipt.from,
    to: receipt.to,
    identities: receipt.identities,
    poolChunks: (chunks.poolOperations ?? []).map((row) => ({
      fromBlock: row.fromBlock,
      toBlock: row.toBlock,
      firstHash: row.firstHash,
      lastHash: row.lastHash,
      queries: row.queries,
    })),
    cashChunks: (chunks.underlyingTransfers ?? []).map((row) => ({
      fromBlock: row.fromBlock,
      toBlock: row.toBlock,
      firstHash: row.firstHash,
      lastHash: row.lastHash,
      queries: row.queries,
    })),
    operations: receipt.operations,
    transfers: receipt.transfers,
    reconciliation: receipt.reconciliation,
  }
}

export function validateRawQueryWindows(receipt) {
  for (const kind of ['poolOperations', 'underlyingTransfers']) {
    for (const chunk of receipt.chunks?.[kind] ?? []) {
      fail(
        Number.isSafeInteger(chunk.fromBlock) &&
          Number.isSafeInteger(chunk.toBlock) &&
          chunk.fromBlock <= chunk.toBlock &&
          Array.isArray(chunk.queries),
        'archive_invalid_chunk',
      )
      for (const query of chunk.queries) {
        fail(Array.isArray(query.logs), 'archive_invalid_query')
        const seen = new Set()
        for (const log of query.logs) {
          fail(
            Number.isSafeInteger(log.blockNumber) &&
              log.blockNumber >= chunk.fromBlock &&
              log.blockNumber <= chunk.toBlock &&
              HASH.test(log.blockHash) &&
              Number.isSafeInteger(log.logIndex) &&
              log.logIndex >= 0,
            'archive_out_of_range_or_invalid_log',
          )
          const key = `${log.blockHash}:${log.logIndex}`
          fail(!seen.has(key), 'archive_duplicate_log')
          seen.add(key)
        }
      }
    }
  }
}

export function verifyPair(a, b, fromBlock, toBlock, expectedHash) {
  fail(a?.sha256 && b?.sha256, 'archive_missing_source_receipt')
  fail(a.sha256 !== b.sha256, 'archive_duplicate_source_bytes')
  fail(
    a.from?.blockNumber === fromBlock && b.from?.blockNumber === fromBlock,
    'archive_source_range',
  )
  fail(a.to?.blockNumber === toBlock && b.to?.blockNumber === toBlock, 'archive_source_range')
  fail(
    a.from.blockHash === expectedHash && b.from.blockHash === expectedHash,
    'archive_boundary_hash',
  )
  validateRawQueryWindows(a)
  validateRawQueryWindows(b)
  const left = economicProjection(a)
  const right = economicProjection(b)
  fail(JSON.stringify(left) === JSON.stringify(right), 'archive_two_origin_disagreement')
  fail(left.reconciliation?.endpointReconciled === true, 'archive_cash_not_reconciled')
  return { toHash: a.to.blockHash, projectionSha256: sha(JSON.stringify(left)) }
}

function pairDirectories(out, leftOrigin = ORIGINS[0]) {
  return [join(out, originName(leftOrigin)), join(out, 'ankr')]
}

function sourceReceipt(out, file) {
  fail(/^USDC-[0-9]+-[0-9]+-[0-9a-f]{64}\.json$/.test(file), 'archive_receipt_filename')
  return readJson(join(out, file))
}

function sourceWitnessBody(origin, receipt, sourceFile, mode) {
  return {
    study: `${STUDY}-local-origin-witness`,
    originSha256: sha(origin),
    sourceFile,
    sourceSha256: receipt.sha256,
    captureStartedAt: receipt.captureStartedAt,
    captureEndedAt: receipt.captureEndedAt,
    observedAt: new Date().toISOString(),
    mode,
  }
}

function witnessPath(out, origin, fromBlock, toBlock) {
  return join(out, witnessName(originName(origin), fromBlock, toBlock))
}

function readWitness(out, origin, receipt, sourceFile, fromBlock, toBlock, expectedMode = null) {
  const saved = readJson(witnessPath(out, origin, fromBlock, toBlock), 4096)
  const { sha256, ...body } = saved
  fail(sha(JSON.stringify(body)) === sha256, 'archive_origin_witness_sha')
  fail(
    body.study === `${STUDY}-local-origin-witness` &&
      body.originSha256 === sha(origin) &&
      body.sourceFile === sourceFile &&
      body.sourceSha256 === receipt.sha256 &&
      body.captureStartedAt === receipt.captureStartedAt &&
      body.captureEndedAt === receipt.captureEndedAt &&
      ['live_capture', 'existing_live_receipt_bound_later'].includes(body.mode) &&
      (expectedMode === null || body.mode === expectedMode) &&
      Number.isFinite(Date.parse(body.observedAt)) &&
      Date.parse(body.observedAt) >= Date.parse(body.captureEndedAt),
    'archive_origin_witness_mismatch',
  )
  return sha256
}

function sealWitness(out, origin, receipt, sourceFile, fromBlock, toBlock, mode) {
  const body = sourceWitnessBody(origin, receipt, sourceFile, mode)
  atomic(
    out,
    witnessPath(out, origin, fromBlock, toBlock),
    `${JSON.stringify({ ...body, sha256: sha(JSON.stringify(body)) })}\n`,
  )
  return readWitness(out, origin, receipt, sourceFile, fromBlock, toBlock)
}

// A collector can seal its own receipt before this archive seals the local
// origin witness. Such a receipt cannot be promoted to an attested live source
// after a restart. Preserve it outside the trusted source directories, then
// collect the range anew. The deterministic names make every crash point
// resumable without replacing a prior quarantine record.
function quarantineUnwitnessedSource(
  out,
  directory,
  origin,
  sourceFile,
  receipt,
  fromBlock,
  toBlock,
) {
  const quarantine = `${out}-unwitnessed-sources`
  mkdirSync(quarantine, { recursive: true, mode: 0o700 })
  canonicalDir(quarantine)
  let attempt = 0
  let basename
  let destination
  while (attempt < 32) {
    basename = `${originName(origin)}-${sourceFile}${attempt ? `.attempt-${attempt}` : ''}`
    destination = join(quarantine, basename)
    if (!pathPresent(destination)) break
    const a = lstatSync(join(directory, sourceFile))
    const b = lstatSync(destination)
    fail(a.isFile() && b.isFile(), 'archive_orphan_collision')
    if (a.dev === b.dev && a.ino === b.ino) break
    attempt += 1
  }
  fail(attempt < 32, 'archive_orphan_attempt_limit')
  const manifestPath = join(quarantine, `${basename}.orphan.json`)
  const expected = {
    study: `${STUDY}-unwitnessed-source`,
    reason: 'capture_sealed_before_origin_witness',
    originSha256: sha(origin),
    sourceFile,
    sourceSha256: receipt.sha256,
    fromBlock,
    toBlock,
    captureStartedAt: receipt.captureStartedAt,
    captureEndedAt: receipt.captureEndedAt,
  }
  if (pathPresent(manifestPath)) {
    const saved = readJson(manifestPath, 4096)
    const { sha256, observedAt, ...body } = saved
    fail(
      sha(JSON.stringify({ ...body, observedAt })) === sha256 &&
        JSON.stringify(body) === JSON.stringify(expected) &&
        Number.isFinite(Date.parse(observedAt)),
      'archive_orphan_manifest_mismatch',
    )
  } else {
    const body = { ...expected, observedAt: new Date().toISOString() }
    atomic(
      quarantine,
      manifestPath,
      `${JSON.stringify({ ...body, sha256: sha(JSON.stringify(body)) })}\n`,
    )
  }
  const original = join(directory, sourceFile)
  if (!pathPresent(destination)) linkSync(original, destination)
  else {
    const a = lstatSync(original)
    const b = lstatSync(destination)
    fail(a.dev === b.dev && a.ino === b.ino && a.isFile() && b.isFile(), 'archive_orphan_collision')
  }
  for (const path of [quarantine, directory]) {
    const fd = openSync(path, constants.O_RDONLY)
    try {
      if (path === directory) unlinkSync(original)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
}

function preflightSources(leftDir, rightDir) {
  for (const directory of [leftDir, rightDir]) {
    for (const file of readdirSync(directory).filter((name) => SOURCE_RECEIPT.test(name)))
      readJson(join(directory, file))
  }
}

// One-time binding for the pilot continuation slice collected before local
// origin witnesses existed. This records our local capture history; the RPCs
// did not sign their responses. All later slices bind at capture time.
export function bindExistingPreWitnessSlices({ out = OUT } = {}) {
  const [leftDir, rightDir] = pairDirectories(out)
  preflightSources(leftDir, rightDir)
  verifyCollector({ out: leftDir })
  verifyCollector({ out: rightDir })
  const sidecars = readdirSync(out)
    .filter((file) => /^slice-[0-9]+-[0-9]+\.json$/.test(file))
    .sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]))
  let priorHash = FROM_HASH
  let next = FROM_BLOCK
  for (const file of sidecars) {
    const sidecar = readJson(join(out, file), 4096)
    const { fromBlock, toBlock } = sidecar
    fail(fromBlock === next && isLegacyBootstrapSlice(fromBlock, toBlock), 'archive_existing_scope')
    const files = [leftDir, rightDir].map((directory) =>
      readdirSync(directory).filter((candidate) =>
        new RegExp(`^USDC-0*${fromBlock}-0*${toBlock}-[0-9a-f]{64}\\.json$`).test(candidate),
      ),
    )
    fail(
      files.every((items) => items.length === 1),
      'archive_existing_source_missing',
    )
    const a = sourceReceipt(leftDir, files[0][0])
    const b = sourceReceipt(rightDir, files[1][0])
    fail(
      sidecar.leftSha256 === a.sha256 && sidecar.rightSha256 === b.sha256,
      'archive_existing_digest',
    )
    priorHash = verifyPair(a, b, fromBlock, toBlock, priorHash).toHash
    for (const [index, source, sourceFile] of [
      [0, a, files[0][0]],
      [1, b, files[1][0]],
    ]) {
      const origin = ORIGINS[index]
      const path = witnessPath(out, origin, fromBlock, toBlock)
      if (!existsSync(path))
        sealWitness(
          out,
          origin,
          source,
          sourceFile,
          fromBlock,
          toBlock,
          'existing_live_receipt_bound_later',
        )
      else readWitness(out, origin, source, sourceFile, fromBlock, toBlock)
    }
    next = toBlock
  }
  return verifyArchive({ out })
}

export function verifyArchive({ out = OUT } = {}) {
  const [infuraDir, rightDir] = pairDirectories(out)
  const alchemyDir = join(out, 'alchemy')
  const drpcDir = join(out, 'drpc')
  const quicknodeDir = join(out, 'quicknode')
  canonicalDir(out)
  canonicalDir(infuraDir)
  canonicalDir(rightDir)
  if (existsSync(alchemyDir)) canonicalDir(alchemyDir)
  if (existsSync(drpcDir)) canonicalDir(drpcDir)
  if (existsSync(quicknodeDir)) canonicalDir(quicknodeDir)
  for (const [directory, allow] of [
    [
      out,
      (file) =>
        file === 'infura' ||
        file === 'alchemy' ||
        file === 'drpc' ||
        file === 'quicknode' ||
        file === 'ankr' ||
        /^slice-[0-9]+-[0-9]+\.json$/.test(file) ||
        /^origin-(infura|alchemy|drpc|quicknode|ankr)-[0-9]+-[0-9]+\.json$/.test(file) ||
        /^slice-[0-9]+-[0-9]+\.json\.[0-9a-f-]{36}\.tmp$/.test(file),
    ],
    [infuraDir, (file) => /^USDC-[0-9]+-[0-9]+-[0-9a-f]{64}\.json$/.test(file)],
    ...(existsSync(alchemyDir)
      ? [[alchemyDir, (file) => /^USDC-[0-9]+-[0-9]+-[0-9a-f]{64}\.json$/.test(file)]]
      : []),
    ...(existsSync(drpcDir)
      ? [[drpcDir, (file) => /^USDC-[0-9]+-[0-9]+-[0-9a-f]{64}\.json$/.test(file)]]
      : []),
    ...(existsSync(quicknodeDir)
      ? [[quicknodeDir, (file) => /^USDC-[0-9]+-[0-9]+-[0-9a-f]{64}\.json$/.test(file)]]
      : []),
    [rightDir, (file) => /^USDC-[0-9]+-[0-9]+-[0-9a-f]{64}\.json$/.test(file)],
  ]) {
    // Finder and other local tooling may add unrelated directory entries.
    // Only canonical archive names enter bounds and verification; a malformed
    // canonical JSON file is still opened below and fails closed.
    const names = withoutBenignLocalMetadata(readdirSync(directory))
    const maxSlices = Math.ceil((TO_BLOCK - FROM_BLOCK) / MIN_ACCEPTED_SLICE_BLOCKS)
    fail(
      names.length <= (directory === out ? 3 * maxSlices + 6 : maxSlices + 4),
      'archive_directory_bound',
    )
    for (const file of names) {
      fail(allow(file), 'archive_unexpected_entry')
      const path = join(directory, file)
      fail(
        file === 'infura' ||
          file === 'alchemy' ||
          file === 'drpc' ||
          file === 'quicknode' ||
          file === 'ankr'
          ? lstatSync(path).isDirectory()
          : lstatSync(path).isFile(),
        'archive_nonregular_entry',
      )
    }
  }
  preflightSources(infuraDir, rightDir)
  if (existsSync(alchemyDir)) preflightSources(alchemyDir, rightDir)
  if (existsSync(drpcDir)) preflightSources(drpcDir, rightDir)
  if (existsSync(quicknodeDir)) preflightSources(quicknodeDir, rightDir)
  verifyCollector({ out: infuraDir })
  if (existsSync(alchemyDir)) verifyCollector({ out: alchemyDir })
  if (existsSync(drpcDir)) verifyCollector({ out: drpcDir })
  if (existsSync(quicknodeDir)) verifyCollector({ out: quicknodeDir })
  verifyCollector({ out: rightDir })
  const names = readdirSync(out)
    .filter((entry) => entry.startsWith('slice-') && entry.endsWith('.json'))
    .sort((a, b) => {
      const x = Number(/^slice-([0-9]+)/.exec(a)?.[1])
      const y = Number(/^slice-([0-9]+)/.exec(b)?.[1])
      return x - y
    })
  fail(
    names.length <= Math.ceil((TO_BLOCK - FROM_BLOCK) / MIN_ACCEPTED_SLICE_BLOCKS),
    'archive_too_many_slices',
  )
  let next = FROM_BLOCK
  let hash = FROM_HASH
  for (const file of names) {
    fail(/^slice-[0-9]+-[0-9]+\.json$/.test(file), 'archive_slice_filename')
    const saved = readJson(join(out, file), 4096)
    const { sha256, ...body } = saved
    fail(sha(JSON.stringify(body)) === sha256 && body.study === STUDY, 'archive_slice_sha')
    fail(
      body.fromBlock === next &&
        body.toBlock > next &&
        body.toBlock <= Math.min(next + SLICE_BLOCKS, TO_BLOCK),
      'archive_gap_or_overlap',
    )
    fail(file === name(next, body.toBlock), 'archive_slice_filename')
    const leftOrigin = LEFT_ORIGINS.find(
      (origin) =>
        JSON.stringify(body.originSha256) === JSON.stringify([sha(origin), originsHash[1]]),
    )
    fail(Boolean(leftOrigin), 'archive_origin_pair')
    if (leftOrigin === QUICKNODE_ORIGIN)
      fail(
        body.toBlock === Math.min(next + QUICKNODE_SLICE_BLOCKS, TO_BLOCK),
        'archive_quicknode_slice_size',
      )
    const leftDir = pairDirectories(out, leftOrigin)[0]
    const a = sourceReceipt(leftDir, body.leftFile)
    const b = sourceReceipt(rightDir, body.rightFile)
    fail(a.sha256 === body.leftSha256 && b.sha256 === body.rightSha256, 'archive_source_digest')
    const legacy = isLegacyBootstrapSlice(next, body.toBlock)
    const hasWitnessDigests = body.leftWitnessSha256 != null || body.rightWitnessSha256 != null
    const expectedMode =
      legacy && !hasWitnessDigests ? 'existing_live_receipt_bound_later' : 'live_capture'
    const leftWitnessSha256 = readWitness(
      out,
      leftOrigin,
      a,
      body.leftFile,
      next,
      body.toBlock,
      expectedMode,
    )
    const rightWitnessSha256 = readWitness(
      out,
      ORIGINS[1],
      b,
      body.rightFile,
      next,
      body.toBlock,
      expectedMode,
    )
    if (body.leftWitnessSha256 != null || body.rightWitnessSha256 != null)
      fail(
        body.leftWitnessSha256 === leftWitnessSha256 &&
          body.rightWitnessSha256 === rightWitnessSha256,
        'archive_joint_witness_digest',
      )
    else fail(legacy, 'archive_joint_witness_missing')
    const pair = verifyPair(a, b, next, body.toBlock, hash)
    fail(
      pair.toHash === body.toHash && pair.projectionSha256 === body.projectionSha256,
      'archive_pair_digest',
    )
    next = body.toBlock
    hash = pair.toHash
  }
  return {
    study: STUDY,
    acceptedSlices: names.length,
    fromBlock: FROM_BLOCK,
    throughBlock: next,
    targetBlock: TO_BLOCK,
    complete: next === TO_BLOCK,
    lastHash: hash,
  }
}

export async function tick({
  rpcUrls,
  clientFactory = makeClient,
  capture = collect,
  out = OUT,
} = {}) {
  const urls = String(rpcUrls ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const leftOrigin = urls.length === 2 ? new URL(urls[0]).origin : null
  fail(
    urls.length === 2 &&
      LEFT_ORIGINS.includes(leftOrigin) &&
      new URL(urls[1]).origin === ORIGINS[1],
    'archive_origin_config',
  )
  mkdirSync(out, { recursive: true })
  for (const directory of [...pairDirectories(out), ...pairDirectories(out, leftOrigin)])
    mkdirSync(directory, { recursive: true })
  const state = verifyArchive({ out })
  if (state.complete) return state
  const fromBlock = state.throughBlock
  const toBlock = Math.min(
    fromBlock + (leftOrigin === QUICKNODE_ORIGIN ? QUICKNODE_SLICE_BLOCKS : SLICE_BLOCKS),
    TO_BLOCK,
  )
  const [leftDir, rightDir] = pairDirectories(out, leftOrigin)
  const getOrCapture = async (directory, url, originIndex) => {
    const origin = originIndex === 0 ? leftOrigin : ORIGINS[1]
    const found = readdirSync(directory).filter((file) => {
      if (!/^USDC-[0-9]+-[0-9]+-[0-9a-f]{64}\.json$/.test(file)) return false
      const row = sourceReceipt(directory, file)
      return row.from.blockNumber === fromBlock && row.to.blockNumber === toBlock
    })
    fail(found.length <= 1, 'archive_duplicate_source_range')
    if (found.length) {
      const source = sourceReceipt(directory, found[0])
      try {
        readWitness(out, origin, source, found[0], fromBlock, toBlock)
        return { path: join(directory, found[0]) }
      } catch (error) {
        if (error?.code !== 'ENOENT' || pathPresent(witnessPath(out, origin, fromBlock, toBlock)))
          throw error
        quarantineUnwitnessedSource(out, directory, origin, found[0], source, fromBlock, toBlock)
      }
    }
    let saved
    try {
      saved = await capture({
        client: clientFactory(url),
        marketName: 'USDC',
        fromBlock,
        toBlock,
        chunkBlocks: archiveLogChunkBlocks(leftOrigin),
        out: directory,
      })
    } catch (error) {
      throw new Error(`archive_capture_${originName(origin)}`, { cause: error })
    }
    preflightSources(leftDir, rightDir)
    verifyCollector({ out: directory })
    const sourceFile = saved.path.split('/').at(-1)
    const source = sourceReceipt(directory, sourceFile)
    sealWitness(out, origin, source, sourceFile, fromBlock, toBlock, 'live_capture')
    return saved
  }
  const left = await getOrCapture(leftDir, urls[0], 0)
  const right = await getOrCapture(rightDir, urls[1], 1)
  // The independent collector's complete raw-log/endpoint verifier must run
  // before any joint success sidecar is sealed, including when capture is
  // resumed from one already-written source receipt.
  preflightSources(leftDir, rightDir)
  verifyCollector({ out: leftDir })
  verifyCollector({ out: rightDir })
  const a = readJson(left.path)
  const b = readJson(right.path)
  const pair = verifyPair(a, b, fromBlock, toBlock, state.lastHash)
  const body = {
    study: STUDY,
    fromBlock,
    toBlock,
    originSha256: [sha(leftOrigin), originsHash[1]],
    leftFile: left.path.split('/').at(-1),
    rightFile: right.path.split('/').at(-1),
    toHash: pair.toHash,
    projectionSha256: pair.projectionSha256,
    leftSha256: a.sha256,
    rightSha256: b.sha256,
    leftWitnessSha256: readWitness(
      out,
      leftOrigin,
      a,
      left.path.split('/').at(-1),
      fromBlock,
      toBlock,
    ),
    rightWitnessSha256: readWitness(
      out,
      ORIGINS[1],
      b,
      right.path.split('/').at(-1),
      fromBlock,
      toBlock,
    ),
  }
  atomic(
    out,
    join(out, name(fromBlock, toBlock)),
    `${JSON.stringify({ ...body, sha256: sha(JSON.stringify(body)) })}\n`,
  )
  return verifyArchive({ out })
}

// The native job must explain a failed tick without writing RPC URLs or
// provider response bodies (which can contain credentials) to its log.
export function archiveFailureCode(error) {
  let current = error
  let stage = null
  for (let depth = 0; current && depth < 8; depth += 1, current = current.cause) {
    const message = String(current.message ?? '')
    if (message === 'archive_two_origin_capture_failed') {
      const left = String(current.infuraCode ?? '')
      const right = String(current.alchemyCode ?? '')
      if (
        /^archive_capture_infura(?::[a-z0-9_]+)?$/.test(left) &&
        /^archive_capture_alchemy(?::[a-z0-9_]+)?$/.test(right)
      )
        return `${message}:${left}:${right}`
    }
    if (message === 'archive_three_origin_capture_failed') {
      const codes = [current.infuraCode, current.alchemyCode, current.drpcCode].map((code) =>
        String(code ?? ''),
      )
      if (
        ['infura', 'alchemy', 'drpc'].every((origin, i) =>
          new RegExp(`^archive_capture_${origin}(?::[a-z0-9_]+)?$`).test(codes[i]),
        )
      )
        return `${message}:${codes.join(':')}`
    }
    if (message === 'archive_four_origin_capture_failed') {
      const codes = [
        current.infuraCode,
        current.alchemyCode,
        current.drpcCode,
        current.quicknodeCode,
      ].map((code) => String(code ?? ''))
      if (
        ['infura', 'alchemy', 'drpc', 'quicknode'].every((origin, i) =>
          new RegExp('^archive_capture_' + origin + '(?::[a-z0-9_]+)?$').test(codes[i]),
        )
      )
        return message + ':' + codes.join(':')
    }
    if (/^archive_capture_(infura|alchemy|drpc|quicknode|ankr)$/.test(message)) {
      stage = message
      continue
    }
    if (/^(?:archive|aave_core|collector|missing_archive_rpc)[a-z0-9_]*$/.test(message))
      return stage ? `${stage}:${message}` : message
    const detail = String(current.details ?? '').toLowerCase()
    if (current.code === -32600 && detail.includes('plan') && detail.includes('range'))
      return stage ? `${stage}:rpc_plan_range` : 'rpc_plan_range'
    const status = Number(current.status)
    if (Number.isInteger(status) && status >= 400 && status <= 599)
      return stage ? `${stage}:http_${status}` : `http_${status}`
    const networkCode = String(current.code ?? '').toUpperCase()
    if (
      [
        'ECONNRESET',
        'ETIMEDOUT',
        'ENOTFOUND',
        'EAI_AGAIN',
        'ECONNREFUSED',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_SOCKET',
      ].includes(networkCode)
    )
      return stage
        ? `${stage}:rpc_${networkCode.toLowerCase()}`
        : `rpc_${networkCode.toLowerCase()}`
  }
  return stage ?? 'unknown'
}

/** Prefer Infura while retaining independent left-origin witnesses on fallback. */
export async function tickWithConfiguredFallback({ rpcUrls, run = tick }) {
  const ring = String(rpcUrls ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
  const find = (origin) => ring.find((url) => new URL(url).origin === origin)
  const alchemy = find(ALCHEMY_ORIGIN)
  const drpc = find(DRPC_ORIGIN)
  const quicknode = find(QUICKNODE_ORIGIN)
  const infura = find(ORIGINS[0])
  const ankr = find(ORIGINS[1])
  fail(infura && ankr, 'missing_archive_rpc')
  const candidates = [
    [ORIGINS[0], infura],
    // A verified QuickNode 64-block path can advance past a preserved,
    // incompatible Alchemy/Ankr 256-block staged pair without accepting it.
    [QUICKNODE_ORIGIN, quicknode],
    [ALCHEMY_ORIGIN, alchemy],
    [DRPC_ORIGIN, drpc],
  ].filter(([, url]) => Boolean(url))
  const failures = []
  for (let i = 0; i < candidates.length; i += 1) {
    const [origin, url] = candidates[i]
    try {
      return await run({ rpcUrls: [url, ankr].join(',') })
    } catch (error) {
      if (error?.message !== `archive_capture_${originName(origin)}`) throw error
      failures.push({ origin: originName(origin), code: archiveFailureCode(error), error })
      if (i < candidates.length - 1) continue
      const codeFor = (label) => failures.find((failure) => failure.origin === label)?.code
      if (failures.length === 4)
        throw Object.assign(new Error('archive_four_origin_capture_failed'), {
          infuraCode: codeFor('infura'),
          alchemyCode: codeFor('alchemy'),
          drpcCode: codeFor('drpc'),
          quicknodeCode: codeFor('quicknode'),
        })
      if (failures.length === 3 && codeFor('infura') && codeFor('alchemy') && codeFor('drpc'))
        throw Object.assign(new Error('archive_three_origin_capture_failed'), {
          infuraCode: codeFor('infura'),
          alchemyCode: codeFor('alchemy'),
          drpcCode: codeFor('drpc'),
        })
      if (failures.length === 2 && codeFor('infura') && codeFor('alchemy'))
        throw Object.assign(new Error('archive_two_origin_capture_failed'), {
          infuraCode: codeFor('infura'),
          alchemyCode: codeFor('alchemy'),
        })
      throw error
    }
  }
  throw new Error('missing_archive_rpc')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    fail(
      process.argv.length === 3 &&
        ['--tick', '--verify', '--bind-existing-prewitness'].includes(process.argv[2]),
      'archive_usage',
    )
    if (process.argv[2] === '--verify') process.stdout.write(`${JSON.stringify(verifyArchive())}\n`)
    else if (process.argv[2] === '--bind-existing-prewitness')
      process.stdout.write(`${JSON.stringify(bindExistingPreWitnessSlices())}\n`)
    else {
      process.stdout.write(
        `${JSON.stringify(await tickWithConfiguredFallback({ rpcUrls: readEnv().get('RECORDER_RPC_URL') }))}\n`,
      )
    }
  } catch (error) {
    process.stderr.write(`aave_usdc_market_cash_archive_failed:${archiveFailureCode(error)}\n`)
    process.exitCode = 1
  }
}
