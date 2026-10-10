// Retrospective, local-only VaultV2 gross-flow archive. Never issue forecasts
// or write to the prospective flow ledger from this module.
import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, decodeEventLog, http, parseAbiItem, toEventHash } from 'viem'
import { mainnet } from 'viem/chains'

import { readEnv } from '../lib/venue-reads.mjs'
import {
  collectFlowInterval,
  compareCombinedLogs,
  loadMorphoFlowSubjects,
  normalizeFlowLogs,
} from '../record-carry-morpho-v2-flows.mjs'
import { captureRawWitness } from '../record-carry-morpho-v2-flows-local.mjs'

export const ARCHIVE_ROOT = resolve(
  'data/research/venue-signals/local-morpho-v2-retrospective-flow-v1',
)
export const PILOT_VAULT = '0x6dc58a0fdfc8d694e571dc59b9a52eeea780e6bf'
const STUDY = 'carry-morpho-v2-retrospective-gross-flow-v1'
const SHA = /^[0-9a-f]{64}$/
const HASH = /^0x[0-9a-f]{64}$/
const MAX_BYTES = 16 * 1024 * 1024
const RESERVE = 1024n * 1024n * 1024n
const STAGED_RANGE =
  /^(?:\d{12}|header-attestation)\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/
const ABI = {
  deposit: parseAbiItem(
    'event Deposit(address indexed sender,address indexed onBehalf,uint256 assets,uint256 shares)',
  ),
  withdraw: parseAbiItem(
    'event Withdraw(address indexed sender,address indexed receiver,address indexed onBehalf,uint256 assets,uint256 shares)',
  ),
  force: parseAbiItem(
    'event ForceDeallocate(address indexed sender,address adapter,uint256 assets,address indexed onBehalf,bytes32[] ids,uint256 penaltyAssets)',
  ),
}
const KINDS = new Map(
  Object.entries(ABI).map(([kind, item]) => [toEventHash(item).toLowerCase(), kind]),
)
const sha = (value) => createHash('sha256').update(value).digest('hex')
const assert = (ok, reason) => {
  if (!ok) throw Error(`morpho_archive_${reason}`)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const rangeName = (sequence) => `${String(sequence).padStart(12, '0')}.json`

export function rpcOrigin(url) {
  const parsed = new URL(url)
  assert(
    ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password,
    'origin_invalid',
  )
  const host = parsed.hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '')
  return /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/.test(host) ? 'loopback' : host
}

function reserve(root, bytes) {
  let ancestor = root
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  const disk = statfsSync(ancestor, { bigint: true })
  assert(disk.bavail * disk.bsize - BigInt(bytes) >= RESERVE, 'disk_reserve_reached')
}

function publish(path, body) {
  const record = { ...body, sha256: sha(JSON.stringify(body)) }
  const bytes = `${JSON.stringify(record)}\n`
  assert(Buffer.byteLength(bytes) <= MAX_BYTES, 'record_oversize')
  reserve(dirname(path), Buffer.byteLength(bytes))
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, bytes)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    linkSync(temporary, path)
    const directory = openSync(dirname(path), 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
  return record
}

function readRecord(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes
  try {
    const stat = fstatSync(fd)
    assert(stat.isFile() && stat.size <= MAX_BYTES, 'unsafe_or_oversize_file')
    bytes = readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
  const record = JSON.parse(bytes)
  assert(bytes === `${JSON.stringify(record)}\n`, 'noncanonical_bytes')
  const { sha256, ...body } = record
  assert(SHA.test(sha256 ?? '') && sha(JSON.stringify(body)) === sha256, 'hash_mismatch')
  return record
}

export function verifyEnrollment(subjects, root = ARCHIVE_ROOT) {
  const path = join(root, 'enrollment.json')
  if (!existsSync(path)) return null
  const record = readRecord(path)
  assert(
    record.study === STUDY && record.kind === 'enrollment' && record.chainId === 1,
    'enrollment_identity',
  )
  assert(subjects.length === 49 && same(record.subjects, subjects), 'cohort_changed')
  assert(
    record.vault === PILOT_VAULT &&
      record.asset === subjects.find((subject) => subject.vault === PILOT_VAULT)?.asset &&
      /^\d+$/.test(record.anchorTargetTimestamp ?? '') &&
      /^\d+$/.test(record.startBlock ?? '') &&
      HASH.test(record.priorHash ?? '') &&
      HASH.test(record.firstBlockHash ?? '') &&
      BigInt(record.firstBlockTimestamp) >= BigInt(record.anchorTargetTimestamp) &&
      Array.isArray(record.providerOrigins) &&
      record.providerOrigins.length === 2 &&
      record.providerOrigins[0] !== record.providerOrigins[1],
    'enrollment_anchor_invalid',
  )
  assert(
    record.providerCompleteness === 'two_origins_agreed_not_independently_proven',
    'completeness_label',
  )
  return record
}

export function replayWitness(record, witness) {
  assert(Array.isArray(witness.rawLogs) && witness.rawLogs.length <= 10_000, 'raw_count')
  assert(Array.isArray(witness.eventBlocks), 'event_blocks')
  const sets = { deposit: [], withdraw: [], force: [] }
  const seen = new Set()
  const blockHashes = new Map()
  for (const row of witness.rawLogs) {
    const kind = KINDS.get(row.topics?.[0])
    assert(kind && kind === row.kind && row.address === record.vault, 'raw_identity')
    assert(
      HASH.test(row.blockHash) &&
        HASH.test(row.transactionHash) &&
        BigInt(row.blockNumber) >= BigInt(record.fromBlock) &&
        BigInt(row.blockNumber) <= BigInt(record.toBlock),
      'raw_range',
    )
    assert(
      Number.isSafeInteger(row.logIndex) &&
        row.logIndex >= 0 &&
        Number.isSafeInteger(row.transactionIndex) &&
        row.transactionIndex >= 0,
      'raw_index',
    )
    const key = `${row.transactionHash}:${row.logIndex}`
    assert(!seen.has(key), 'raw_duplicate')
    seen.add(key)
    const priorHash = blockHashes.get(row.blockNumber)
    assert(!priorHash || priorHash === row.blockHash, 'event_block_hash_disagreement')
    blockHashes.set(row.blockNumber, row.blockHash)
    const decoded = decodeEventLog({
      abi: [ABI[kind]],
      topics: row.topics,
      data: row.data,
      strict: true,
    })
    sets[kind].push({ ...row, blockNumber: BigInt(row.blockNumber), args: decoded.args })
  }
  assert(
    same(
      witness.eventBlocks,
      [...blockHashes]
        .sort((a, b) => Number(BigInt(a[0]) - BigInt(b[0])))
        .map(([block, hash]) => ({ block, hash })),
    ),
    'event_headers',
  )
  const lastHash = blockHashes.get(record.toBlock)
  assert(!lastHash || lastHash === record.toHash, 'last_event_header')
  assert(
    compareCombinedLogs(sets.deposit, sets.withdraw, sets.force, Object.values(sets).flat()) ===
      record.combinedSetSha256,
    'raw_set_hash',
  )
  const events = normalizeFlowLogs(
    record.vault,
    sets.deposit,
    sets.withdraw,
    sets.force,
    BigInt(record.fromBlock),
    BigInt(record.toBlock),
  )
  assert(same(events, record.events), 'normalized_events')
}

export function verifyVault(subject, enrollment, root = ARCHIVE_ROOT, requireSidecar = true) {
  const dir = join(root, subject.vault)
  if (!existsSync(dir)) return []
  const entries = readdirSync(dir)
  assert(
    entries.every(
      (name) =>
        name === 'header-attestation.json' ||
        /^\d{12}\.json$/.test(name) ||
        STAGED_RANGE.test(name),
    ),
    'unexpected_archive_file',
  )
  const files = entries.filter((name) => /^\d{12}\.json$/.test(name)).sort()
  assert(files.length <= 100_000, 'range_limit')
  let previous = enrollment
  const records = []
  for (const [index, file] of files.entries()) {
    assert(file === rangeName(index + 1), 'sequence_gap')
    const record = readRecord(join(dir, file))
    assert(
      record.study === STUDY &&
        record.kind === 'range' &&
        record.chainId === 1 &&
        record.sequence === index + 1,
      'range_identity',
    )
    assert(
      record.vault === subject.vault &&
        record.asset === subject.asset &&
        record.enrollmentSha256 === enrollment.sha256 &&
        record.previousSha256 === previous.sha256,
      'subject_or_chain_mismatch',
    )
    assert(
      record.fromBlock === String(BigInt(previous.toBlock ?? enrollment.startBlock) + 1n) &&
        record.priorHash === (previous.toHash ?? enrollment.priorHash),
      'cursor_gap',
    )
    assert(
      record.sequence > 1 || record.fromBlock === String(BigInt(enrollment.startBlock) + 1n),
      'first_range_invalid',
    )
    assert(BigInt(record.toBlock) <= BigInt(enrollment.startBlock) + 64n, 'pilot_boundary_exceeded')
    assert(
      BigInt(record.toBlock) >= BigInt(record.fromBlock) &&
        BigInt(record.toBlock) - BigInt(record.fromBlock) < 512n &&
        HASH.test(record.toHash),
      'range_invalid',
    )
    assert(
      record.anchorTargetTimestamp === enrollment.anchorTargetTimestamp &&
        record.researchOnly === true &&
        record.prospectiveValidated === false &&
        record.holderExecutableExit === false,
      'claim_invalid',
    )
    assert(
      record.manifestSha256 === subject.manifestSha256 &&
        record.seedSha256 === subject.seedSha256 &&
        record.boardSha256 === subject.boardSha256 &&
        record.displayedRoutesSha256 === subject.displayedRoutesSha256 &&
        record.cohortId === subject.cohortId,
      'subject_provenance_changed',
    )
    assert(
      record.providerCompleteness === 'two_origins_agreed_not_independently_proven',
      'completeness_label',
    )
    assert(
      Array.isArray(record.witnesses) &&
        record.witnesses.length === 2 &&
        record.witnesses[0].origin !== record.witnesses[1].origin,
      'two_origins_required',
    )
    for (const witness of record.witnesses) replayWitness(record, witness)
    assert(
      same(record.witnesses[0].rawLogs, record.witnesses[1].rawLogs) &&
        same(record.witnesses[0].eventBlocks, record.witnesses[1].eventBlocks),
      'independent_raw_disagreement',
    )
    previous = record
    records.push(record)
  }
  if (
    records.length &&
    BigInt(records.at(-1).toBlock) === BigInt(enrollment.startBlock) + 64n &&
    requireSidecar
  ) {
    const path = join(dir, 'header-attestation.json')
    assert(existsSync(path), 'header_attestation_missing')
    const attestation = readRecord(path)
    const first = records[0]
    const last = records.at(-1)
    assert(
      attestation.study === STUDY &&
        attestation.kind === 'header-attestation' &&
        attestation.chainId === 1 &&
        attestation.enrollmentSha256 === enrollment.sha256 &&
        attestation.rangeSha256 === last.sha256 &&
        attestation.vault === subject.vault,
      'header_attestation_identity',
    )
    assert(
      Array.isArray(attestation.views) &&
        attestation.views.length === 2 &&
        attestation.views[0].origin !== attestation.views[1].origin &&
        same(attestation.views[0].headers, attestation.views[1].headers),
      'header_attestation_disagreement',
    )
    const { prior, start, end } = attestation.views[0].headers
    assert(
      prior.block === String(BigInt(first.fromBlock) - 1n) &&
        prior.hash === enrollment.priorHash &&
        start.block === first.fromBlock &&
        start.hash === enrollment.firstBlockHash &&
        end.block === last.toBlock &&
        end.hash === last.toHash,
      'header_attestation_boundary',
    )
    assert(
      BigInt(prior.timestamp) < BigInt(enrollment.anchorTargetTimestamp) &&
        BigInt(start.timestamp) >= BigInt(enrollment.anchorTargetTimestamp),
      'header_attestation_timestamp',
    )
  }
  return records
}

async function attestHeaders(clients, subject, enrollment, range, root) {
  const path = join(root, subject.vault, 'header-attestation.json')
  if (existsSync(path)) return
  const from = BigInt(range.fromBlock)
  const to = BigInt(range.toBlock)
  const views = await Promise.all(
    clients.map(async ({ origin, client }) => {
      const [prior, start, end] = await Promise.all([
        client.getBlock({ blockNumber: from - 1n }),
        client.getBlock({ blockNumber: from }),
        client.getBlock({ blockNumber: to }),
      ])
      const header = (block) => ({
        block: String(block.number),
        hash: block.hash?.toLowerCase(),
        timestamp: String(block.timestamp),
      })
      return { origin, headers: { prior: header(prior), start: header(start), end: header(end) } }
    }),
  )
  assert(
    views[0].origin !== views[1].origin && same(views[0].headers, views[1].headers),
    'header_attestation_disagreement',
  )
  const { prior, start, end } = views[0].headers
  assert(
    prior.block === String(from - 1n) &&
      prior.hash === enrollment.priorHash &&
      start.block === range.fromBlock &&
      start.hash === enrollment.firstBlockHash &&
      end.block === range.toBlock &&
      end.hash === range.toHash,
    'header_attestation_boundary',
  )
  assert(
    BigInt(prior.timestamp) < BigInt(enrollment.anchorTargetTimestamp) &&
      BigInt(start.timestamp) >= BigInt(enrollment.anchorTargetTimestamp),
    'header_attestation_timestamp',
  )
  publish(path, {
    study: STUDY,
    kind: 'header-attestation',
    chainId: 1,
    enrollmentSha256: enrollment.sha256,
    rangeSha256: range.sha256,
    vault: subject.vault,
    views,
    firstLocalReceiptAt: new Date().toISOString(),
  })
}

export function appendRange(subject, enrollment, payload, witnesses, root = ARCHIVE_ROOT) {
  const records = verifyVault(subject, enrollment, root, false)
  const previous = records.at(-1) ?? enrollment
  const body = {
    study: STUDY,
    kind: 'range',
    chainId: 1,
    sequence: records.length + 1,
    previousSha256: previous.sha256,
    enrollmentSha256: enrollment.sha256,
    anchorTargetTimestamp: enrollment.anchorTargetTimestamp,
    ...payload,
    witnesses,
    providerCompleteness: 'two_origins_agreed_not_independently_proven',
    researchOnly: true,
    prospectiveValidated: false,
    holderExecutableExit: false,
    firstLocalReceiptAt: new Date().toISOString(),
  }
  const record = { ...body, sha256: sha(JSON.stringify(body)) }
  const expected = BigInt(previous.toBlock ?? enrollment.startBlock) + 1n
  assert(
    BigInt(record.fromBlock) === expected &&
      record.priorHash === (previous.toHash ?? enrollment.priorHash),
    'cursor_gap',
  )
  assert(
    witnesses.length === 2 &&
      witnesses[0].origin !== witnesses[1].origin &&
      same(witnesses[0].rawLogs, witnesses[1].rawLogs) &&
      same(witnesses[0].eventBlocks, witnesses[1].eventBlocks),
    'independent_raw_disagreement',
  )
  for (const witness of witnesses) replayWitness(record, witness)
  return publish(join(root, subject.vault, rangeName(record.sequence)), body)
}

async function blockAtTimestamp(client, target, finalized) {
  let low = 1n
  let high = finalized.number
  while (low < high) {
    const middle = (low + high) / 2n
    const block = await client.getBlock({ blockNumber: middle })
    if (block.timestamp < target) low = middle + 1n
    else high = middle
  }
  const block = await client.getBlock({ blockNumber: low })
  const prior = await client.getBlock({ blockNumber: low - 1n })
  assert(prior.timestamp < target && block.timestamp >= target, 'timestamp_anchor_invalid')
  return { block, prior }
}

export async function runArchive(argv = process.argv.slice(2), options = {}) {
  assert(
    (argv.length === 1 ||
      (argv.length === 3 && argv[0] === '--pilot' && argv[1] === '--origins')) &&
      ['--pilot', '--verify', '--verify-partial'].includes(argv[0]),
    'usage',
  )
  const root = options.root ?? ARCHIVE_ROOT
  const subjects = await loadMorphoFlowSubjects()
  const subject = subjects.find((row) => row.vault === PILOT_VAULT)
  assert(subject && subjects.length === 49, 'pilot_subject_missing')
  const enrollment = verifyEnrollment(subjects, root)
  if (argv[0] === '--verify' || argv[0] === '--verify-partial') {
    assert(enrollment, 'not_enrolled')
    const partial = argv[0] === '--verify-partial'
    const ranges = verifyVault(subject, enrollment, root, !partial)
    const rangeComplete =
      ranges.length > 0 && BigInt(ranges.at(-1).toBlock) === BigInt(enrollment.startBlock) + 64n
    const sidecarPath = join(root, subject.vault, 'header-attestation.json')
    if (partial && rangeComplete && existsSync(sidecarPath))
      verifyVault(subject, enrollment, root, true)
    const complete = rangeComplete && (!partial || existsSync(sidecarPath))
    if (!partial) assert(complete, 'pilot_incomplete')
    return {
      mode: argv[0].slice(2),
      rangeComplete,
      complete,
      vault: subject.vault,
      anchorBlock: enrollment.startBlock,
      ranges: ranges.length,
      coveredBlocks: ranges.reduce(
        (n, row) => n + Number(BigInt(row.toBlock) - BigInt(row.fromBlock) + 1n),
        0,
      ),
      events: ranges.reduce((n, row) => n + row.events.length, 0),
      tipSha256: ranges.at(-1)?.sha256 ?? enrollment.sha256,
    }
  }
  const { get } = readEnv()
  const urls = String(
    options.rpcUrls ??
      process.env.RECORDER_RPC_URLS ??
      process.env.RECORDER_RPC_URL ??
      get('RECORDER_RPC_URLS') ??
      get('RECORDER_RPC_URL') ??
      '',
  )
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
  const available = new Map(urls.map((url) => [rpcOrigin(url), url]))
  const wanted = argv[2]?.split(',')
  assert(
    !wanted ||
      (wanted.length === 2 &&
        wanted[0] !== wanted[1] &&
        wanted.every((origin) => available.has(origin))),
    'origin_selection_invalid',
  )
  const origins = wanted
    ? wanted.map((origin) => [origin, available.get(origin)])
    : [...available.entries()].slice(0, 2)
  assert(origins.length === 2, 'two_origins_required')
  const clients = origins.map(([origin, url]) => ({
    origin,
    client:
      options.clientFactory?.(url) ??
      createPublicClient({
        chain: mainnet,
        transport: http(url, { timeout: 12_000, retryCount: 0 }),
      }),
  }))
  for (const source of clients) assert((await source.client.getChainId()) === 1, 'wrong_chain')
  const heads = await Promise.all(
    clients.map(({ client }) => client.getBlock({ blockTag: 'finalized' })),
  )
  const finalNumber = heads.reduce(
    (number, head) => (head.number < number ? head.number : number),
    heads[0].number,
  )
  const finalBlocks = await Promise.all(
    clients.map(({ client }) => client.getBlock({ blockNumber: finalNumber })),
  )
  assert(
    finalBlocks[0].hash?.toLowerCase() === finalBlocks[1].hash?.toLowerCase(),
    'finalized_header_disagreement',
  )
  const target = BigInt(Math.floor(Number(finalBlocks[0].timestamp) - 30 * 86400))
  let anchor = enrollment
  if (!anchor) {
    const anchors = await Promise.all(
      clients.map(({ client }) => blockAtTimestamp(client, target, finalBlocks[0])),
    )
    assert(
      anchors[0].block.hash?.toLowerCase() === anchors[1].block.hash?.toLowerCase() &&
        anchors[0].prior.hash?.toLowerCase() === anchors[1].prior.hash?.toLowerCase(),
      'anchor_header_disagreement',
    )
    const startBlock = anchors[0].block.number
    assert(startBlock + 63n <= finalNumber, 'pilot_not_finalized')
    const body = {
      study: STUDY,
      kind: 'enrollment',
      chainId: 1,
      subjects,
      vault: subject.vault,
      asset: subject.asset,
      anchorTargetTimestamp: String(target),
      startBlock: String(startBlock - 1n),
      priorHash: anchors[0].prior.hash.toLowerCase(),
      firstBlockHash: anchors[0].block.hash.toLowerCase(),
      firstBlockTimestamp: String(anchors[0].block.timestamp),
      finalizedHeadBlock: String(finalNumber),
      finalizedHeadHash: finalBlocks[0].hash.toLowerCase(),
      providerOrigins: origins.map(([origin]) => origin),
      providerCompleteness: 'two_origins_agreed_not_independently_proven',
      firstLocalReceiptAt: new Date().toISOString(),
    }
    anchor = publish(join(root, 'enrollment.json'), body)
  }
  const records = verifyVault(subject, anchor, root, false)
  const previous = records.at(-1) ?? anchor
  const fromBlock = BigInt(previous.toBlock ?? anchor.startBlock) + 1n
  const pilotEnd = BigInt(anchor.startBlock) + 64n
  if (fromBlock > pilotEnd) {
    await attestHeaders(clients, subject, anchor, records.at(-1), root)
    return runArchive(['--verify'], { root })
  }
  const endBlock = fromBlock + 63n < pilotEnd ? fromBlock + 63n : pilotEnd
  if (!records.length) {
    const firstHeaders = await Promise.all(
      clients.map(({ client }) => client.getBlock({ blockNumber: fromBlock })),
    )
    assert(
      firstHeaders.every(
        (header) =>
          header.hash?.toLowerCase() === anchor.firstBlockHash &&
          header.timestamp >= BigInt(anchor.anchorTargetTimestamp),
      ),
      'anchor_header_disagreement',
    )
  }
  const endHeaders = await Promise.all(
    clients.map(({ client }) => client.getBlock({ blockNumber: endBlock })),
  )
  assert(
    endHeaders[0].hash?.toLowerCase() === endHeaders[1].hash?.toLowerCase(),
    'range_header_disagreement',
  )
  const finalized = finalBlocks[0]
  const observations = []
  for (const source of clients) {
    const payload = await collectFlowInterval(
      source.client,
      subject,
      {
        last_block: previous.toBlock ?? anchor.startBlock,
        last_hash: previous.toHash ?? anchor.priorHash,
      },
      { ...finalized, number: endBlock, hash: endHeaders[0].hash },
    )
    assert(
      payload && BigInt(payload.fromBlock) === fromBlock && BigInt(payload.toBlock) === endBlock,
      'range_plan_invalid',
    )
    const witness = await captureRawWitness(source.client, subject, payload)
    observations.push({ origin: source.origin, payload, ...witness })
  }
  const [left, right] = observations
  assert(same(left.payload, right.payload), 'independent_payload_disagreement')
  assert(same(left.rawLogs, right.rawLogs), 'independent_raw_disagreement')
  assert(same(left.eventBlocks, right.eventBlocks), 'independent_event_header_disagreement')
  const { payloadSha256, ...payload } = left.payload
  const sealed = appendRange(
    subject,
    anchor,
    payload,
    observations.map(({ origin, rawLogs, eventBlocks }) => ({ origin, rawLogs, eventBlocks })),
    root,
  )
  await attestHeaders(clients, subject, anchor, sealed, root)
  return {
    mode: 'pilot',
    vault: subject.vault,
    fromBlock: sealed.fromBlock,
    toBlock: sealed.toBlock,
    events: sealed.events.length,
    sha256: sealed.sha256,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runArchive()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(
        `${/^morpho_archive_/.test(error.message) ? error.message : 'morpho_archive_failed'}\n`,
      )
      process.exitCode = 1
    })
}
