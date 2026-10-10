// Bounded rolling epochs after the immutable Aave USDC cash archive V1.
// Local origin witnesses bind collector receipts to the RPC origin used at capture.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
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
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import {
  STUDY as COLLECTOR_STUDY,
  collect,
  verify as verifyCollector,
} from './aave-core-operation-collector.mjs'
import {
  ALCHEMY_ORIGIN,
  DRPC_ORIGIN,
  FROM_BLOCK as V1_FROM,
  ORIGINS,
  OUT as V1_OUT,
  QUICKNODE_ORIGIN,
  QUICKNODE_SLICE_BLOCKS,
  archiveLogChunkBlocks,
  TO_BLOCK as V1_TO,
  archiveFailureCode,
  tickWithConfiguredFallback,
  verifyArchive as verifyV1,
  verifyPair,
} from './aave-usdc-market-cash-archive.mjs'

export const STUDY = 'aave-usdc-market-cash-archive-v2'
export const ROOT = resolve('data/research/venue-signals/aave-usdc-market-cash-archive-v2')
export const EPOCH_BLOCKS = 16_384
export const SLICE_BLOCKS = 256
// Finite replay and disk bound. A later study version can extend this cap.
export const MAX_EPOCHS = 64
const HASH = /^0x[0-9a-f]{64}$/
const DIGEST = /^[0-9a-f]{64}$/
const RECEIPT = /^USDC-[0-9]+-[0-9]+-[0-9a-f]{64}\.json$/
const SOURCE_TEMP = /^(USDC-([0-9]+)-([0-9]+)-([0-9a-f]{64})\.json)\.([0-9a-f-]{36})\.tmp$/
const SLICE = /^slice-([0-9]+)-([0-9]+)\.json$/
const WITNESS = /^origin-(infura|alchemy|drpc|quicknode|ankr)-([0-9]+)-([0-9]+)\.json$/
const ATOMIC_TEMP =
  /^(?:genesis|slice-[0-9]+-[0-9]+|origin-(?:infura|alchemy|drpc|quicknode|ankr)-[0-9]+-[0-9]+)\.json\.[0-9a-f-]{36}\.tmp$/
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fail = (ok, code) => {
  if (!ok) throw new Error(code)
}
const leftOrigins = [ORIGINS[0], ALCHEMY_ORIGIN, DRPC_ORIGIN, QUICKNODE_ORIGIN]
const originLabel = (origin) =>
  origin === ORIGINS[0]
    ? 'infura'
    : origin === ALCHEMY_ORIGIN
      ? 'alchemy'
      : origin === DRPC_ORIGIN
        ? 'drpc'
        : origin === QUICKNODE_ORIGIN
          ? 'quicknode'
          : origin === ORIGINS[1]
            ? 'ankr'
            : null
const epochStart = (index) => V1_TO + index * EPOCH_BLOCKS
const epochEnd = (index) => epochStart(index) + EPOCH_BLOCKS
const epochDir = (root, index) => join(root, `epoch-${String(index).padStart(3, '0')}`)
const sliceName = (a, b) => `slice-${a}-${b}.json`
const witnessName = (origin, a, b) => `origin-${originLabel(origin)}-${a}-${b}.json`

function present(path) {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}
function directory(path) {
  fail(lstatSync(path).isDirectory() && realpathSync(path) === path, 'archive_v2_directory')
}
function read(path, limit = 4 * 1024 * 1024) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const meta = fstatSync(fd)
    fail(meta.isFile() && meta.size > 0 && meta.size <= limit, 'archive_v2_file_size')
    const data = Buffer.alloc(meta.size)
    let at = 0
    while (at < data.length) {
      const n = readSync(fd, data, at, data.length - at, null)
      fail(n > 0, 'archive_v2_short_read')
      at += n
    }
    fail(fstatSync(fd).size === meta.size, 'archive_v2_changed_file')
    return data
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
function readSourceTemp(path) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = fstatSync(fd)
    fail(before.isFile() && before.size <= 4 * 1024 * 1024, 'archive_v2_source_temp_size')
    const bytes = Buffer.alloc(before.size)
    let at = 0
    while (at < bytes.length) {
      const n = readSync(fd, bytes, at, bytes.length - at, null)
      fail(n > 0, 'archive_v2_source_temp_read')
      at += n
    }
    fail(fstatSync(fd).size === before.size, 'archive_v2_source_temp_changed')
    return bytes
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
function json(path, limit) {
  return JSON.parse(read(path, limit).toString('utf8'))
}
function sealed(path, limit = 4096) {
  const saved = json(path, limit)
  const { sha256, ...body } = saved
  fail(DIGEST.test(sha256) && sha(JSON.stringify(body)) === sha256, 'archive_v2_seal_sha')
  return { body, sha256 }
}
function atomic(out, path, body) {
  const stat = statfsSync(out)
  fail(
    Number(stat.bavail) * Number(stat.bsize) - Buffer.byteLength(body) >= 2 * 1024 ** 3,
    'archive_v2_disk_reserve',
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
    const dirFd = openSync(out, constants.O_RDONLY)
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
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
function seal(out, path, body) {
  atomic(out, path, `${JSON.stringify({ ...body, sha256: sha(JSON.stringify(body)) })}\n`)
}
function requiredFiles(out, allow, max) {
  directory(out)
  const files = readdirSync(out)
  fail(files.length <= max, 'archive_v2_directory_bound')
  for (const file of files)
    fail(allow(file) && lstatSync(join(out, file)).isFile(), 'archive_v2_unexpected_entry')
  return files
}
function exactFile(out, file, re) {
  fail(re.test(file), 'archive_v2_filename')
  return join(out, file)
}
function v1Tip({ v1Out = V1_OUT, verifyV1Archive = verifyV1 } = {}) {
  const prior = verifyV1Archive({ out: v1Out })
  if (!prior.complete) return null
  fail(prior.throughBlock === V1_TO && HASH.test(prior.lastHash), 'archive_v2_v1_boundary')
  const files = readdirSync(v1Out).filter(
    (file) => SLICE.test(file) && Number(SLICE.exec(file)[2]) === V1_TO,
  )
  fail(files.length === 1, 'archive_v2_v1_tip_sidecar')
  const path = join(v1Out, files[0])
  const body = sealed(path)
  fail(
    body.body.toBlock === V1_TO && body.body.toHash === prior.lastHash,
    'archive_v2_v1_tip_mismatch',
  )
  return {
    fromBlock: V1_FROM,
    throughBlock: V1_TO,
    lastHash: prior.lastHash,
    sidecarFile: files[0],
    sidecarSha256: sha(read(path, 4096)),
  }
}
function genesisBody(index, prior) {
  return {
    study: `${STUDY}-genesis`,
    epoch: index,
    fromBlock: epochStart(index),
    toBlock: epochEnd(index),
    priorStudy: index === 0 ? 'aave-usdc-market-cash-archive-v1' : STUDY,
    priorEpoch: index === 0 ? null : index - 1,
    priorThroughBlock: prior.throughBlock,
    priorHash: prior.lastHash,
    priorSidecarFile: prior.sidecarFile,
    priorSidecarSha256: prior.sidecarSha256,
  }
}
function witnessBody(origin, source, file, a, b) {
  return {
    study: `${STUDY}-local-origin-witness`,
    originSha256: sha(origin),
    sourceFile: file,
    sourceSha256: source.sha256,
    captureStartedAt: source.captureStartedAt,
    captureEndedAt: source.captureEndedAt,
    fromBlock: a,
    toBlock: b,
    observedAt: new Date().toISOString(),
    mode: 'live_capture',
  }
}
function checkWitness(dir, origin, source, file, a, b) {
  const { body, sha256 } = sealed(join(dir, witnessName(origin, a, b)))
  fail(
    body.study === `${STUDY}-local-origin-witness` &&
      body.originSha256 === sha(origin) &&
      body.sourceFile === file &&
      body.sourceSha256 === source.sha256 &&
      body.captureStartedAt === source.captureStartedAt &&
      body.captureEndedAt === source.captureEndedAt &&
      body.fromBlock === a &&
      body.toBlock === b &&
      body.mode === 'live_capture' &&
      Number.isFinite(Date.parse(body.observedAt)) &&
      Date.parse(body.observedAt) >= Date.parse(body.captureEndedAt),
    'archive_v2_origin_witness',
  )
  return sha256
}
function sealWitness(dir, origin, source, file, a, b) {
  seal(dir, join(dir, witnessName(origin, a, b)), witnessBody(origin, source, file, a, b))
  return checkWitness(dir, origin, source, file, a, b)
}
function source(dir, file) {
  return json(exactFile(dir, file, RECEIPT))
}

// An orphan cannot become a live origin witness after a crash. A same-range,
// verifier-valid source is quarantined with a content seal, then recaptured.
function quarantine(root, dir, origin, file, row, a, b) {
  const outside = `${root}-unwitnessed-sources`
  mkdirSync(outside, { recursive: true, mode: 0o700 })
  directory(outside)
  const original = join(dir, file)
  let slot = -1
  for (let i = 0; i < 32; i += 1) {
    const dest = join(outside, `${originLabel(origin)}-${file}${i ? `.attempt-${i}` : ''}`)
    if (!present(dest)) {
      slot = i
      break
    }
    const old = lstatSync(original),
      saved = lstatSync(dest)
    fail(old.isFile() && saved.isFile(), 'archive_v2_orphan_collision')
    if (old.dev === saved.dev && old.ino === saved.ino) {
      slot = i
      break
    }
  }
  fail(slot >= 0, 'archive_v2_orphan_attempt_limit')
  const label = `${originLabel(origin)}-${file}${slot ? `.attempt-${slot}` : ''}`
  const dest = join(outside, label),
    manifest = join(outside, `${label}.orphan.json`)
  const expected = {
    study: `${STUDY}-unwitnessed-source`,
    originSha256: sha(origin),
    sourceFile: file,
    sourceSha256: row.sha256,
    fromBlock: a,
    toBlock: b,
    captureStartedAt: row.captureStartedAt,
    captureEndedAt: row.captureEndedAt,
  }
  if (present(manifest)) {
    const saved = sealed(manifest).body
    const { observedAt, ...body } = saved
    fail(
      JSON.stringify(body) === JSON.stringify(expected) && Number.isFinite(Date.parse(observedAt)),
      'archive_v2_orphan_manifest',
    )
  } else seal(outside, manifest, { ...expected, observedAt: new Date().toISOString() })
  if (!present(dest)) linkSync(original, dest)
  else {
    const x = lstatSync(original),
      y = lstatSync(dest)
    fail(x.dev === y.dev && x.ino === y.ino, 'archive_v2_orphan_collision')
  }
  for (const path of [outside, dir]) {
    const fd = openSync(path, constants.O_RDONLY)
    try {
      if (path === dir) unlinkSync(original)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
}

function quarantineSourceTemp(root, dir, origin, file, epoch) {
  const match = SOURCE_TEMP.exec(file)
  fail(Boolean(match), 'archive_v2_unexpected_source_temp')
  const fromBlock = Number(match[2]),
    toBlock = Number(match[3])
  fail(
    Number.isSafeInteger(fromBlock) &&
      Number.isSafeInteger(toBlock) &&
      fromBlock >= epochStart(epoch) &&
      [QUICKNODE_SLICE_BLOCKS, SLICE_BLOCKS].includes(toBlock - fromBlock) &&
      toBlock <= epochEnd(epoch),
    'archive_v2_source_temp_range',
  )
  const path = join(dir, file),
    bytes = readSourceTemp(path)
  let classification = 'partial_unsealed_receipt'
  try {
    const row = JSON.parse(bytes.toString('utf8'))
    const { sha256, ...body } = row
    fail(
      row.study === COLLECTOR_STUDY &&
        DIGEST.test(sha256) &&
        sha(JSON.stringify(body)) === sha256 &&
        row.market === 'USDC' &&
        row.from?.blockNumber === fromBlock &&
        row.to?.blockNumber === toBlock &&
        row.to?.blockHash === `0x${match[4]}`,
      'archive_v2_source_temp_schema',
    )
    classification = 'complete_unwitnessed_receipt_temp'
  } catch (error) {
    if (error?.message !== 'archive_v2_source_temp_schema' && !(error instanceof SyntaxError))
      throw error
    if (error?.message === 'archive_v2_source_temp_schema') throw error
  }
  const target = join(dir, match[1])
  if (present(target)) {
    const a = lstatSync(path),
      b = lstatSync(target)
    fail(
      a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino,
      'archive_v2_source_temp_target_collision',
    )
  }
  const outside = `${root}-unwitnessed-sources`
  mkdirSync(outside, { recursive: true, mode: 0o700 })
  directory(outside)
  const label = `temp-${originLabel(origin)}-${file}`
  const destination = join(outside, label),
    manifest = `${destination}.orphan.json`
  const expected = {
    study: `${STUDY}-source-temp-orphan`,
    originSha256: sha(origin),
    sourceTempFile: file,
    sourceTempSha256: sha(bytes),
    sourceTempBytes: bytes.length,
    fromBlock,
    toBlock,
    classification,
  }
  if (present(manifest)) {
    const saved = sealed(manifest).body
    const { observedAt, ...body } = saved
    fail(
      JSON.stringify(body) === JSON.stringify(expected) && Number.isFinite(Date.parse(observedAt)),
      'archive_v2_source_temp_manifest',
    )
  } else seal(outside, manifest, { ...expected, observedAt: new Date().toISOString() })
  if (!present(destination)) linkSync(path, destination)
  else {
    const a = lstatSync(path),
      b = lstatSync(destination)
    fail(
      a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino,
      'archive_v2_source_temp_collision',
    )
  }
  for (const location of [outside, dir]) {
    const fd = openSync(location, constants.O_RDONLY)
    try {
      if (location === dir) unlinkSync(path)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
}

function recoverSourceTemps(root) {
  if (!present(root)) return
  directory(root)
  const epochs = readdirSync(root)
  fail(epochs.length <= MAX_EPOCHS, 'archive_v2_epoch_bound')
  for (const epochName of epochs) {
    fail(/^epoch-[0-9]{3}$/.test(epochName), 'archive_v2_unexpected_epoch')
    const epoch = Number(epochName.slice(6))
    fail(epoch < MAX_EPOCHS, 'archive_v2_epoch_bound')
    directory(join(root, epochName))
    for (const origin of [ORIGINS[0], ALCHEMY_ORIGIN, DRPC_ORIGIN, QUICKNODE_ORIGIN, ORIGINS[1]]) {
      const dir = join(root, epochName, originLabel(origin))
      if (!present(dir)) continue
      directory(dir)
      const temps = readdirSync(dir).filter((file) => file.endsWith('.tmp'))
      fail(temps.length <= 8, 'archive_v2_source_temp_bound')
      for (const file of temps) quarantineSourceTemp(root, dir, origin, file, epoch)
    }
  }
}

function priorEpochTip(dir, index) {
  const end = epochEnd(index)
  const files = readdirSync(dir).filter(
    (file) => SLICE.test(file) && Number(SLICE.exec(file)[2]) === end,
  )
  fail(files.length === 1, 'archive_v2_epoch_tip_sidecar')
  return { sidecarFile: files[0], sidecarSha256: sha(read(join(dir, files[0]), 4096)) }
}
function inspectEpoch({ root, index, prior, verifySourceArchive }) {
  const dir = epochDir(root, index)
  if (!present(dir)) return null
  directory(dir)
  const entries = readdirSync(dir)
  fail(
    entries.length <= 3 * (EPOCH_BLOCKS / QUICKNODE_SLICE_BLOCKS) + 8,
    'archive_v2_directory_bound',
  )
  for (const entry of entries) {
    const path = join(dir, entry)
    if (['infura', 'alchemy', 'drpc', 'quicknode', 'ankr'].includes(entry))
      fail(lstatSync(path).isDirectory() && realpathSync(path) === path, 'archive_v2_directory')
    else
      fail(
        (entry === 'genesis.json' ||
          SLICE.test(entry) ||
          WITNESS.test(entry) ||
          ATOMIC_TEMP.test(entry)) &&
          lstatSync(path).isFile(),
        'archive_v2_unexpected_entry',
      )
  }
  fail(present(join(dir, 'genesis.json')), 'archive_v2_missing_genesis')
  const genesis = sealed(join(dir, 'genesis.json')).body
  fail(
    JSON.stringify(genesis) === JSON.stringify(genesisBody(index, prior)),
    'archive_v2_genesis_mismatch',
  )
  for (const label of ['infura', 'ankr'])
    fail(present(join(dir, label)), 'archive_v2_origin_directory')
  for (const label of ['infura', 'alchemy', 'drpc', 'quicknode', 'ankr']) {
    const sourceDir = join(dir, label)
    if (!present(sourceDir)) continue
    const files = requiredFiles(
      sourceDir,
      (file) => RECEIPT.test(file),
      EPOCH_BLOCKS / QUICKNODE_SLICE_BLOCKS + 4,
    )
    for (const file of files) read(join(sourceDir, file))
    verifySourceArchive({ out: sourceDir })
  }
  const files = entries
    .filter((file) => SLICE.test(file))
    .sort((a, b) => Number(SLICE.exec(a)[1]) - Number(SLICE.exec(b)[1]))
  fail(files.length <= EPOCH_BLOCKS / QUICKNODE_SLICE_BLOCKS, 'archive_v2_slice_bound')
  let next = epochStart(index),
    hash = prior.lastHash,
    quicknodeMode = false
  const slices = []
  for (const file of files) {
    const { body, sha256 } = sealed(join(dir, file))
    fail(
      body.study === STUDY &&
        body.epoch === index &&
        body.fromBlock === next &&
        body.toBlock <= epochEnd(index) &&
        file === sliceName(next, body.toBlock),
      'archive_v2_gap_or_overlap',
    )
    const left = leftOrigins.find((candidate) => body.originSha256?.[0] === sha(candidate))
    fail(left && body.originSha256?.[1] === sha(ORIGINS[1]), 'archive_v2_origin_pair')
    if (left === QUICKNODE_ORIGIN) quicknodeMode = true
    fail(
      body.toBlock === next + (quicknodeMode ? QUICKNODE_SLICE_BLOCKS : SLICE_BLOCKS),
      'archive_v2_slice_size',
    )
    const leftDir = join(dir, originLabel(left)),
      rightDir = join(dir, 'ankr')
    const a = source(leftDir, body.leftFile),
      b = source(rightDir, body.rightFile)
    fail(a.sha256 === body.leftSha256 && b.sha256 === body.rightSha256, 'archive_v2_source_digest')
    fail(
      checkWitness(dir, left, a, body.leftFile, next, body.toBlock) === body.leftWitnessSha256 &&
        checkWitness(dir, ORIGINS[1], b, body.rightFile, next, body.toBlock) ===
          body.rightWitnessSha256,
      'archive_v2_joint_witness',
    )
    const pair = verifyPair(a, b, next, body.toBlock, hash)
    fail(
      pair.toHash === body.toHash && pair.projectionSha256 === body.projectionSha256,
      'archive_v2_pair_digest',
    )
    slices.push({
      study: STUDY,
      epoch: index,
      file: join(dir, file),
      sidecarSha256: sha(read(join(dir, file), 4096)),
      fromBlock: next,
      toBlock: body.toBlock,
      fromHash: hash,
      toHash: pair.toHash,
      leftOrigin: originLabel(left),
      leftFile: join(leftDir, body.leftFile),
      leftSha256: a.sha256,
      rightOrigin: 'ankr',
      rightFile: join(rightDir, body.rightFile),
      rightSha256: b.sha256,
      projectionSha256: pair.projectionSha256,
    })
    next = body.toBlock
    hash = pair.toHash
  }
  return {
    study: STUDY,
    epoch: index,
    fromBlock: epochStart(index),
    throughBlock: next,
    targetBlock: epochEnd(index),
    complete: next === epochEnd(index),
    lastHash: hash,
    acceptedSlices: files.length,
    genesisSha256: sha(read(join(dir, 'genesis.json'), 4096)),
    slices,
  }
}

// Full replay returns bounded, source-bound slice descriptors for an exact V1+V2 join.
export function verifyArchive({
  root = ROOT,
  v1Out = V1_OUT,
  verifyV1Archive = verifyV1,
  verifySourceArchive = verifyCollector,
} = {}) {
  const priorV1 = v1Tip({ v1Out, verifyV1Archive })
  if (!priorV1)
    return { study: STUDY, status: 'waiting_v1', completeV1: false, acceptedSlices: 0, slices: [] }
  if (!present(root))
    return {
      study: STUDY,
      status: 'ready',
      completeV1: true,
      throughBlock: V1_TO,
      targetBlock: epochEnd(0),
      lastHash: priorV1.lastHash,
      acceptedSlices: 0,
      epochs: [],
      slices: [],
    }
  directory(root)
  const names = readdirSync(root)
  fail(names.length <= MAX_EPOCHS, 'archive_v2_epoch_bound')
  for (const file of names)
    fail(
      /^epoch-[0-9]{3}$/.test(file) && lstatSync(join(root, file)).isDirectory(),
      'archive_v2_unexpected_epoch',
    )
  const epochs = [],
    slices = []
  let prior = priorV1
  for (let index = 0; index < MAX_EPOCHS; index += 1) {
    const state = inspectEpoch({ root, index, prior, verifySourceArchive })
    if (!state) {
      fail(names.length === index, 'archive_v2_epoch_gap')
      return {
        study: STUDY,
        status: 'ready',
        completeV1: true,
        throughBlock: prior.throughBlock,
        targetBlock: epochEnd(index),
        lastHash: prior.lastHash,
        acceptedSlices: slices.length,
        epochs,
        slices,
      }
    }
    epochs.push({
      epoch: index,
      fromBlock: state.fromBlock,
      throughBlock: state.throughBlock,
      targetBlock: state.targetBlock,
      acceptedSlices: state.acceptedSlices,
      complete: state.complete,
      lastHash: state.lastHash,
      genesisSha256: state.genesisSha256,
    })
    slices.push(...state.slices)
    fail(names.length >= index + 1, 'archive_v2_epoch_gap')
    if (!state.complete) {
      fail(names.length === index + 1, 'archive_v2_premature_epoch')
      return {
        study: STUDY,
        status: 'collecting',
        completeV1: true,
        throughBlock: state.throughBlock,
        targetBlock: state.targetBlock,
        lastHash: state.lastHash,
        acceptedSlices: slices.length,
        epochs,
        slices,
      }
    }
    prior = {
      throughBlock: state.throughBlock,
      lastHash: state.lastHash,
      ...priorEpochTip(epochDir(root, index), index),
    }
  }
  return {
    study: STUDY,
    status: 'complete',
    completeV1: true,
    throughBlock: prior.throughBlock,
    targetBlock: prior.throughBlock,
    lastHash: prior.lastHash,
    acceptedSlices: slices.length,
    epochs,
    slices,
  }
}

function createEpoch(root, index, prior) {
  fail(index < MAX_EPOCHS, 'archive_v2_epoch_limit')
  mkdirSync(root, { recursive: true })
  directory(root)
  const dir = epochDir(root, index)
  mkdirSync(dir, { recursive: true })
  directory(dir)
  for (const label of ['infura', 'ankr']) mkdirSync(join(dir, label), { recursive: true })
  const path = join(dir, 'genesis.json'),
    expected = genesisBody(index, prior)
  if (!present(path)) seal(dir, path, expected)
  else
    fail(
      JSON.stringify(sealed(path).body) === JSON.stringify(expected),
      'archive_v2_genesis_mismatch',
    )
  return dir
}
// Only an empty bootstrap may be repaired. A missing genesis or origin
// directory after any receipt/witness/sidecar exists is treated as tampering.
function repairEmptyBootstrap({ root, priorV1, verifySourceArchive }) {
  if (!present(root)) return
  directory(root)
  const names = readdirSync(root).sort()
  if (!names.length) return
  const last = names.at(-1)
  fail(/^epoch-[0-9]{3}$/.test(last), 'archive_v2_unexpected_epoch')
  const index = Number(last.slice(6))
  fail(index < MAX_EPOCHS, 'archive_v2_epoch_bound')
  const dir = epochDir(root, index)
  directory(dir)
  const entries = readdirSync(dir)
  if (
    present(join(dir, 'genesis.json')) &&
    ['infura', 'ankr'].every((label) => present(join(dir, label)))
  )
    return
  fail(
    entries.every((name) => ['genesis.json', 'infura', 'ankr'].includes(name)),
    'archive_v2_nonempty_bootstrap',
  )
  for (const label of entries) {
    if (label === 'genesis.json') continue
    const sourceDir = join(dir, label)
    directory(sourceDir)
    fail(readdirSync(sourceDir).length === 0, 'archive_v2_nonempty_bootstrap')
  }
  let prior = priorV1
  for (let i = 0; i < index; i += 1) {
    const state = inspectEpoch({ root, index: i, prior, verifySourceArchive })
    fail(state?.complete, 'archive_v2_epoch_gap')
    prior = {
      throughBlock: state.throughBlock,
      lastHash: state.lastHash,
      ...priorEpochTip(epochDir(root, i), i),
    }
  }
  if (present(join(dir, 'genesis.json')))
    fail(
      JSON.stringify(sealed(join(dir, 'genesis.json')).body) ===
        JSON.stringify(genesisBody(index, prior)),
      'archive_v2_genesis_mismatch',
    )
  createEpoch(root, index, prior)
}
function parseRpcUrls(raw) {
  const urls = String(raw ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
  const byOrigin = (origin) => urls.find((url) => new URL(url).origin === origin)
  fail(byOrigin(ORIGINS[0]) && byOrigin(ORIGINS[1]), 'archive_v2_missing_rpc')
  return {
    infura: byOrigin(ORIGINS[0]),
    alchemy: byOrigin(ALCHEMY_ORIGIN),
    drpc: byOrigin(DRPC_ORIGIN),
    quicknode: byOrigin(QUICKNODE_ORIGIN),
    ankr: byOrigin(ORIGINS[1]),
  }
}
async function finalized(clientFactory, url) {
  const raw = await clientFactory(url).request({
    method: 'eth_getBlockByNumber',
    params: ['finalized', false],
  })
  const number =
    typeof raw?.number === 'string' && /^0x[0-9a-fA-F]+$/.test(raw.number)
      ? Number(BigInt(raw.number))
      : NaN
  fail(
    Number.isSafeInteger(number) && HASH.test(raw?.hash?.toLowerCase()),
    'archive_v2_finalized_head',
  )
  return number
}
async function getOrCapture({
  dir,
  root,
  origin,
  pairLeftOrigin,
  url,
  a,
  b,
  clientFactory,
  capture,
  verifySourceArchive,
}) {
  const sourceDir = join(dir, originLabel(origin))
  mkdirSync(sourceDir, { recursive: true })
  directory(sourceDir)
  const found = readdirSync(sourceDir).filter((file) => {
    if (!RECEIPT.test(file)) return false
    const row = source(sourceDir, file)
    return row.from.blockNumber === a && row.to.blockNumber === b
  })
  fail(found.length <= 1, 'archive_v2_duplicate_source')
  if (found.length) {
    const row = source(sourceDir, found[0])
    try {
      checkWitness(dir, origin, row, found[0], a, b)
      return { path: join(sourceDir, found[0]) }
    } catch (error) {
      const witnessPath = join(dir, witnessName(origin, a, b))
      if (error?.code !== 'ENOENT' || present(witnessPath)) throw error
      verifySourceArchive({ out: sourceDir })
      quarantine(root, sourceDir, origin, found[0], row, a, b)
    }
  }
  let saved
  try {
    saved = await capture({
      client: clientFactory(url),
      marketName: 'USDC',
      fromBlock: a,
      toBlock: b,
      chunkBlocks: archiveLogChunkBlocks(pairLeftOrigin),
      out: sourceDir,
    })
  } catch (error) {
    throw new Error(`archive_v2_capture_${originLabel(origin)}`, { cause: error })
  }
  fail(
    RECEIPT.test(basename(saved.path)) &&
      resolve(saved.path) === resolve(sourceDir, basename(saved.path)),
    'archive_v2_capture_path',
  )
  const row = source(sourceDir, basename(saved.path))
  verifySourceArchive({ out: sourceDir })
  sealWitness(dir, origin, row, basename(saved.path), a, b)
  return { path: join(sourceDir, basename(saved.path)) }
}

export async function tick({
  root = ROOT,
  v1Out = V1_OUT,
  verifyV1Archive = verifyV1,
  rpcUrls,
  clientFactory = makeClient,
  capture = collect,
  verifySourceArchive = verifyCollector,
} = {}) {
  const v1 = v1Tip({ v1Out, verifyV1Archive })
  if (!v1) return { study: STUDY, status: 'waiting_v1', completeV1: false }
  const urls = parseRpcUrls(rpcUrls)
  repairEmptyBootstrap({ root, priorV1: v1, verifySourceArchive })
  recoverSourceTemps(root)
  let state = verifyArchive({ root, v1Out, verifyV1Archive, verifySourceArchive })
  if (state.status === 'complete') return state
  const index = state.epochs?.length ? state.epochs.at(-1).epoch : 0
  const nextIndex = state.epochs?.at(-1)?.complete ? index + 1 : index
  const prior =
    nextIndex === 0
      ? v1
      : {
          throughBlock: state.epochs[nextIndex - 1].throughBlock,
          lastHash: state.epochs[nextIndex - 1].lastHash,
          ...priorEpochTip(epochDir(root, nextIndex - 1), nextIndex - 1),
        }
  const fromBlock =
    nextIndex === index && state.epochs?.length ? state.throughBlock : epochStart(nextIndex)
  // Avoid opening an epoch or scanning any logs until both independent origins
  // attest that the entire next bounded slice is finalized.
  const quicknodeMode = state.slices.some(
    (slice) => slice.epoch === nextIndex && slice.leftOrigin === 'quicknode',
  )
  const attempt = async (leftOrigin, leftUrl) => {
    const toBlock =
      fromBlock +
      (quicknodeMode || leftOrigin === QUICKNODE_ORIGIN ? QUICKNODE_SLICE_BLOCKS : SLICE_BLOCKS)
    fail(toBlock <= epochEnd(nextIndex), 'archive_v2_slice_boundary')
    let heads
    try {
      heads = await Promise.all([
        finalized(clientFactory, leftUrl),
        finalized(clientFactory, urls.ankr),
      ])
    } catch (error) {
      throw new Error(`archive_v2_capture_${originLabel(leftOrigin)}`, { cause: error })
    }
    if (Math.min(...heads) < toBlock)
      return {
        study: STUDY,
        status: 'waiting_finality',
        fromBlock,
        toBlock,
        finalizedHeads: heads,
        acceptedSlices: state.acceptedSlices,
      }
    const dir = createEpoch(root, nextIndex, prior)
    const left = await getOrCapture({
      dir,
      root,
      origin: leftOrigin,
      pairLeftOrigin: leftOrigin,
      url: leftUrl,
      a: fromBlock,
      b: toBlock,
      clientFactory,
      capture,
      verifySourceArchive,
    })
    const right = await getOrCapture({
      dir,
      root,
      origin: ORIGINS[1],
      pairLeftOrigin: leftOrigin,
      url: urls.ankr,
      a: fromBlock,
      b: toBlock,
      clientFactory,
      capture,
      verifySourceArchive,
    })
    const leftDir = join(dir, originLabel(leftOrigin)),
      rightDir = join(dir, 'ankr')
    verifySourceArchive({ out: leftDir })
    verifySourceArchive({ out: rightDir })
    const a = source(leftDir, basename(left.path)),
      b = source(rightDir, basename(right.path))
    const pair = verifyPair(a, b, fromBlock, toBlock, state.lastHash)
    const body = {
      study: STUDY,
      epoch: nextIndex,
      fromBlock,
      toBlock,
      originSha256: [sha(leftOrigin), sha(ORIGINS[1])],
      leftFile: basename(left.path),
      rightFile: basename(right.path),
      leftSha256: a.sha256,
      rightSha256: b.sha256,
      leftWitnessSha256: checkWitness(dir, leftOrigin, a, basename(left.path), fromBlock, toBlock),
      rightWitnessSha256: checkWitness(
        dir,
        ORIGINS[1],
        b,
        basename(right.path),
        fromBlock,
        toBlock,
      ),
      toHash: pair.toHash,
      projectionSha256: pair.projectionSha256,
    }
    seal(dir, join(dir, sliceName(fromBlock, toBlock)), body)
    state = verifyArchive({ root, v1Out, verifyV1Archive, verifySourceArchive })
    return state
  }
  const candidates = [
    [ORIGINS[0], urls.infura],
    [ALCHEMY_ORIGIN, urls.alchemy],
    [DRPC_ORIGIN, urls.drpc],
    [QUICKNODE_ORIGIN, urls.quicknode],
  ].filter(([, url]) => Boolean(url))
  for (let i = 0; i < candidates.length; i += 1) {
    const [origin, url] = candidates[i]
    try {
      return await attempt(origin, url)
    } catch (error) {
      if (
        error?.message !== `archive_v2_capture_${originLabel(origin)}` ||
        i === candidates.length - 1
      )
        throw error
    }
  }
  throw new Error('archive_v2_missing_left_origin')
}

export async function tickAfterV1({
  rpcUrls = readEnv().get('RECORDER_RPC_URL'),
  runV1 = tickWithConfiguredFallback,
  ...options
} = {}) {
  const v1 = v1Tip({ v1Out: options.v1Out, verifyV1Archive: options.verifyV1Archive })
  if (!v1) return runV1({ rpcUrls })
  return tick({ rpcUrls, ...options })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    fail(
      process.argv.length === 3 && ['--tick', '--verify'].includes(process.argv[2]),
      'archive_v2_usage',
    )
    const result = process.argv[2] === '--verify' ? verifyArchive() : await tickAfterV1()
    const { slices, ...summary } = result
    process.stdout.write(`${JSON.stringify(summary)}\n`)
  } catch (error) {
    const code = /^archive_v2_[a-z0-9_]+$/.test(error?.message)
      ? error.message
      : archiveFailureCode(error)
    process.stderr.write(`aave_usdc_market_cash_archive_v2_failed:${code}\n`)
    process.exitCode = 1
  }
}
