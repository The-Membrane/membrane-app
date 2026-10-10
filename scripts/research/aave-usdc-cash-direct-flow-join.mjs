// Read-only, finite join of sealed Aave USDC cash and direct supplier flows.
// The output is observed gross movement, not a holder exit forecast.
import { createHash } from 'node:crypto'
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  OUT as CASH_OUT,
  FROM_BLOCK as CASH_FROM,
  TO_BLOCK as CASH_TARGET,
  ORIGINS as CASH_ORIGINS,
  ALCHEMY_ORIGIN,
  DRPC_ORIGIN,
  QUICKNODE_ORIGIN,
  economicProjection,
  verifyArchive,
} from './aave-usdc-market-cash-archive.mjs'
import {
  ROOT as CASH_V2_ROOT,
  STUDY as CASH_V2_STUDY,
  verifyArchive as verifyArchiveV2,
} from './aave-usdc-market-cash-archive-v2.mjs'
import { DIRECT_FLOW_DIR } from '../record-carry-direct-supplier-flow.mjs'
import {
  verifyDirectSupplierFlowSegment,
  verifyDirectSupplierFlowSegments,
} from './collect-carry-direct-supplier-flow.mjs'

export const STUDY = 'aave-usdc-cash-direct-flow-join-v1'
export const CONTINUATION_STUDY = 'aave-usdc-cash-direct-flow-join-v2'
export const FROM_BLOCK = 26_079_860
// 127 x 256 blocks keeps both 64-block direct archives below their 512-file cap,
// including a segment straddling the window's opening endpoint.
const MAX_JOINED_SLICES = 127
const HASH = /^0x[0-9a-f]{64}$/
const RAW = /^(0|[1-9][0-9]*)$/
const ORIGIN_DIRECTORY = /^(?:infura|alchemy|drpc|quicknode|ankr)$/
const V1_SLICE = /^slice-[0-9]+-[0-9]+\.json$/
const ORIGIN_WITNESS = /^origin-(?:infura|alchemy|drpc|quicknode|ankr)-[0-9]+-[0-9]+\.json$/
const ARCHIVE_TEMP =
  /^(?:genesis|slice-[0-9]+-[0-9]+|origin-(?:infura|alchemy|drpc|quicknode|ankr)-[0-9]+-[0-9]+)\.json\.[0-9a-f-]{36}\.tmp$/
const DIRECT_SEGMENT = /^(?:supply-)?aaveV3Usdc-[0-9]+-[0-9]+\.json$/
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
  return names.filter((name) => {
    if (/^\._[^/]+$/.test(name)) return !present.has(name.slice(2))
    return !BENIGN_LOCAL_METADATA.has(name)
  })
}
const sha = (value) => createHash('sha256').update(value).digest('hex')
const fail = (okay, code) => {
  if (!okay) throw new Error(code)
}
const amount = (value) => {
  fail(typeof value === 'string' && RAW.test(value), 'join_invalid_raw_amount')
  return BigInt(value)
}

/** Canonical file-set projection shared by replay and pinned join sessions. */
export function canonicalJoinNames(names, kind) {
  fail(Array.isArray(names), 'join_invalid_directory_names')
  const accept =
    kind === 'cash_v1'
      ? (name) =>
          ORIGIN_DIRECTORY.test(name) ||
          V1_SLICE.test(name) ||
          ORIGIN_WITNESS.test(name) ||
          ARCHIVE_TEMP.test(name)
      : kind === 'cash_v2_root'
        ? (name) => /^epoch-[0-9]{3}$/.test(name)
        : kind === 'cash_v2_epoch'
          ? (name) =>
              name === 'genesis.json' ||
              ORIGIN_DIRECTORY.test(name) ||
              V1_SLICE.test(name) ||
              ORIGIN_WITNESS.test(name) ||
              ARCHIVE_TEMP.test(name)
          : kind === 'direct'
            ? (name) => DIRECT_SEGMENT.test(name)
            : null
  fail(accept, 'join_invalid_directory_kind')
  const candidates = withoutBenignLocalMetadata(names)
  if (kind !== 'direct') fail(candidates.every(accept), 'join_unexpected_archive_entry')
  return candidates.filter(accept).sort()
}

function readBounded(path, maxBytes) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    fail(stat.isFile() && stat.size > 0 && stat.size <= maxBytes, 'join_source_file_bound')
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null)
      fail(count > 0, 'join_source_short_read')
      offset += count
    }
    fail(fstatSync(fd).size === stat.size, 'join_source_changed')
    return bytes
  } finally {
    closeSync(fd)
  }
}
function readJson(path, maxBytes) {
  return JSON.parse(readBounded(path, maxBytes).toString('utf8'))
}
function readStampedJson(path, maxBytes) {
  const bytes = readBounded(path, maxBytes)
  return { document: JSON.parse(bytes.toString('utf8')), fileSha256: sha(bytes) }
}

const sortedSegments = (out, kind, from, to) => {
  const prefix = kind === 'supply' ? 'supply-aaveV3Usdc-' : 'aaveV3Usdc-'
  const pattern = new RegExp(`^${prefix}([0-9]+)-([0-9]+)\\.json$`)
  const names = readdirSync(out)
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter(({ match }) => match && Number(match[1]) <= to && Number(match[2]) >= from + 1)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
  fail(names.length > 0 && names.length <= 512, 'join_direct_segment_bound')
  return names
}

function directPrefixThrough(names, prefix, from) {
  const expression = new RegExp(`^${prefix}([0-9]+)-([0-9]+)\\.json$`)
  const ranges = names
    .map((name) => expression.exec(name))
    .filter(Boolean)
    .map((match) => ({ start: Number(match[1]), end: Number(match[2]) }))
    .filter((range) => range.end > from)
    .sort((a, b) => a.start - b.start)
  let through = from
  for (const range of ranges) {
    fail(
      Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end),
      'join_invalid_direct_filename',
    )
    if (range.end <= through) continue
    if (range.start > through + 1) break
    fail(range.start === through + 1 || range.start <= from + 1, 'join_direct_overlap')
    through = range.end
  }
  return through
}

/** Select only a sealed cash boundary covered by both direct prefix chains. */
export function selectCommonThrough({
  cashNames,
  directNames,
  archiveThrough,
  explicitThrough = null,
}) {
  fail(
    Number.isSafeInteger(archiveThrough) &&
      archiveThrough > FROM_BLOCK &&
      archiveThrough <= CASH_TARGET &&
      (explicitThrough === null ||
        (Number.isSafeInteger(explicitThrough) &&
          explicitThrough > FROM_BLOCK &&
          explicitThrough <= archiveThrough)),
    'join_invalid_through',
  )
  const withdrawalThrough = directPrefixThrough(directNames, 'aaveV3Usdc-', FROM_BLOCK)
  const supplyThrough = directPrefixThrough(directNames, 'supply-aaveV3Usdc-', FROM_BLOCK)
  const common = Math.min(archiveThrough, withdrawalThrough, supplyThrough)
  const slices = cashNames
    .map((name) => /^slice-([0-9]+)-([0-9]+)\.json$/.exec(name))
    .filter(Boolean)
    .map((match) => ({ start: Number(match[1]), end: Number(match[2]) }))
    .filter((range) => range.start >= FROM_BLOCK && range.end <= common)
    .sort((a, b) => a.start - b.start)
  let through = FROM_BLOCK
  for (const slice of slices) {
    fail(slice.start === through && slice.end > through, 'join_cash_slice_gap')
    through = slice.end
    if (explicitThrough !== null && through >= explicitThrough) break
  }
  fail(
    through > FROM_BLOCK && (explicitThrough === null || through === explicitThrough),
    'join_common_range_unavailable',
  )
  return { throughBlock: through, archiveThrough, withdrawalThrough, supplyThrough }
}

/** The V2 verifier has already replayed V1 and every preceding epoch. */
export function selectContinuationThrough({
  cashNames,
  directNames,
  archive,
  continuation,
  explicitThrough = null,
}) {
  fail(
    archive?.complete === true &&
      archive.throughBlock === CASH_TARGET &&
      continuation?.completeV1 === true &&
      continuation.study === CASH_V2_STUDY &&
      Array.isArray(continuation.slices) &&
      Number.isSafeInteger(continuation.throughBlock) &&
      continuation.throughBlock >= CASH_TARGET &&
      (explicitThrough === null ||
        (Number.isSafeInteger(explicitThrough) &&
          explicitThrough > FROM_BLOCK &&
          explicitThrough <= continuation.throughBlock)),
    'join_invalid_continuation',
  )
  const withdrawalThrough = directPrefixThrough(directNames, 'aaveV3Usdc-', FROM_BLOCK)
  const supplyThrough = directPrefixThrough(directNames, 'supply-aaveV3Usdc-', FROM_BLOCK)
  const common = Math.min(continuation.throughBlock, withdrawalThrough, supplyThrough)
  if (common <= CASH_TARGET || (explicitThrough !== null && explicitThrough <= CASH_TARGET))
    return selectCommonThrough({
      cashNames,
      directNames,
      archiveThrough: archive.throughBlock,
      explicitThrough,
    })
  let through = CASH_TARGET
  for (const part of continuation.slices) {
    fail(part.fromBlock === through && part.toBlock > through, 'join_continuation_gap')
    if (part.toBlock > common) break
    through = part.toBlock
    if (explicitThrough !== null && through >= explicitThrough) break
  }
  fail(
    through > CASH_TARGET && (explicitThrough === null || through === explicitThrough),
    'join_common_range_unavailable',
  )
  return {
    throughBlock: through,
    archiveThrough: continuation.throughBlock,
    withdrawalThrough,
    supplyThrough,
  }
}

function loadDirect(out, kind, from, to, expectedFiles = null) {
  const entries = sortedSegments(out, kind, from, to)
  const documents = entries.map(({ name }) => {
    const path = join(out, name)
    const stamped = readStampedJson(path, 2 * 1024 * 1024)
    if (expectedFiles)
      fail(expectedFiles.get(name) === stamped.fileSha256, 'join_direct_source_changed')
    return stamped.document
  })
  const whole = verifyDirectSupplierFlowSegments(documents)
  const segments = documents.map((document, index) => {
    const verified = verifyDirectSupplierFlowSegment(document)
    const match = entries[index].match
    fail(
      verified.flowKind === kind &&
        verified.marketKey === 'aaveV3Usdc' &&
        verified.fromBlock === Number(match[1]) &&
        verified.toBlock === Number(match[2]),
      'join_direct_filename_mismatch',
    )
    return {
      sourceFile: entries[index].name,
      sourceSha256: document.sha256,
      fromBlock: verified.fromBlock,
      toBlock: verified.toBlock,
      firstBlockHash: verified.firstBlockHash,
      nextBlockHash: verified.nextBlockHash,
      headers: document.blocks.map((row) => ({
        number: row.number,
        hash: row.hash,
        timestampSec: row.timestampSec,
      })),
      events: (kind === 'supply' ? verified.supplies : verified.withdrawals).map((event) => {
        const header = document.blocks.find((point) => point.hash === event.blockHash)
        fail(header, 'join_direct_event_header_missing')
        return { ...event, blockNumber: header.number }
      }),
    }
  })
  fail(segments[0].fromBlock <= from + 1 && segments.at(-1).toBlock >= to, 'join_direct_incomplete')
  fail(whole.coverage.intervals.length === segments.length, 'join_direct_coverage_mismatch')
  return {
    segments,
    sourceFiles: segments.map((part) => ({ file: part.sourceFile, sha256: part.sourceSha256 })),
  }
}

function checkSharedHeaders(cash, withdrawals, supplies) {
  const known = new Map()
  for (const [number, hash] of [
    [cash.from.blockNumber, cash.from.blockHash],
    [cash.to.blockNumber, cash.to.blockHash],
    ...cash.transfers.map((row) => [row.blockNumber, row.blockHash]),
    ...withdrawals.flatMap((part) => part.headers.map((row) => [row.number, row.hash])),
    ...supplies.flatMap((part) => part.headers.map((row) => [row.number, row.hash])),
  ]) {
    fail(Number.isSafeInteger(number) && HASH.test(hash), 'join_invalid_header')
    fail(!known.has(number) || known.get(number) === hash, 'join_chain_hash_mismatch')
    known.set(number, hash)
  }
}

function position(event) {
  return `${event.blockHash}/${event.transactionHash}/${event.logIndex}`
}

function cashBlockTrough(cash) {
  let balance = amount(cash.from.cashRaw)
  let lowest = balance
  let lowestBlock = cash.from.blockNumber
  const blockNets = new Map()
  let previousBlock = cash.from.blockNumber
  for (const transfer of cash.transfers) {
    const block = transfer.blockNumber
    fail(
      Number.isSafeInteger(block) && block > cash.from.blockNumber && block <= cash.to.blockNumber,
      'join_transfer_block_out_of_range',
    )
    fail(block >= previousBlock, 'join_transfer_block_order')
    const value = amount(transfer.amountRaw)
    let change = 0n
    if (transfer.from !== cash.aToken || transfer.to !== cash.aToken) {
      if (transfer.to === cash.aToken) change = value
      else if (transfer.from === cash.aToken) change = -value
      else throw new Error('join_nonreserve_transfer')
    }
    blockNets.set(block, (blockNets.get(block) ?? 0n) + change)
    previousBlock = block
  }
  for (const [block, change] of blockNets) {
    balance += change
    fail(balance >= 0n, 'join_negative_block_cash')
    if (balance < lowest) {
      lowest = balance
      lowestBlock = block
    }
  }
  fail(balance === amount(cash.to.cashRaw), 'join_block_cash_endpoint_mismatch')
  return { minEndOfBlockCashRaw: lowest.toString(), minEndOfBlockCashAtBlock: lowestBlock }
}

/** Inputs must already have passed their source verifiers. No source is inferred. */
export function joinVerifiedCashSlice(
  cash,
  withdrawalEvents,
  supplyEvents,
  directHeaders = [],
  { retainVerifiedTimes = false } = {},
) {
  fail(
    cash?.market === 'USDC' &&
      cash?.chainId === 1 &&
      Number.isSafeInteger(cash.from?.blockNumber) &&
      Number.isSafeInteger(cash.to?.blockNumber) &&
      cash.to.blockNumber > cash.from.blockNumber &&
      cash.reconciliation?.endpointReconciled === true &&
      Array.isArray(cash.operations) &&
      Array.isArray(cash.transfers),
    'join_invalid_cash_slice',
  )
  checkSharedHeaders(
    cash,
    directHeaders.filter((x) => x.kind === 'withdraw'),
    directHeaders.filter((x) => x.kind === 'supply'),
  )
  // These headers were two-origin replayed by loadDirect. Keep their times and
  // require agreement at shared heights; cash hashes were independently joined
  // above. Sparse neighboring headers bound missing exact block times.
  const timedHeaders = new Map()
  for (const part of directHeaders) {
    for (const header of part.headers) {
      if (header.timestampSec === undefined) continue
      fail(
        Number.isSafeInteger(header.timestampSec) && header.timestampSec >= 0,
        'join_invalid_header_time',
      )
      const prior = timedHeaders.get(header.number)
      fail(!prior || prior.timestampSec === header.timestampSec, 'join_header_time_mismatch')
      timedHeaders.set(header.number, {
        blockNumber: header.number,
        blockHash: header.hash,
        timestampSec: header.timestampSec,
      })
    }
  }
  const verifiedTimeHeaders = [...timedHeaders.values()].sort(
    (left, right) => left.blockNumber - right.blockNumber,
  )
  fail(
    verifiedTimeHeaders.every(
      (header, index) =>
        !index || header.timestampSec > verifiedTimeHeaders[index - 1].timestampSec,
    ),
    'join_header_time_order',
  )
  const operations = new Map(cash.operations.map((row) => [position(row), row]))
  const transfers = new Map(cash.transfers.map((row) => [position(row), row]))
  fail(
    operations.size === cash.operations.length && transfers.size === cash.transfers.length,
    'join_duplicate_cash_log',
  )
  const claimedTransfers = new Set()
  const claimedOperations = new Set()
  let withdrawalRaw = 0n
  let supplyRaw = 0n
  let withdrawalCount = 0
  let supplyCount = 0
  for (const [kind, events] of [
    ['withdraw', withdrawalEvents],
    ['supply', supplyEvents],
  ]) {
    fail(Array.isArray(events), 'join_invalid_direct_events')
    for (const event of events) {
      const proof = event.reconciliation
      const data = proof?.evidence
      const opIndex = kind === 'withdraw' ? data?.withdrawLogIndex : data?.supplyLogIndex
      const transferIndex = kind === 'withdraw' ? data?.payoutLogIndex : data?.transferLogIndex
      const expectedStatus =
        kind === 'withdraw' ? 'reconciled_supplier_withdrawal' : 'reconciled_supplier_supply'
      fail(
        proof?.status === expectedStatus &&
          opIndex === event.logIndex &&
          Number.isSafeInteger(transferIndex),
        'join_invalid_direct_proof',
      )
      const base = `${event.blockHash}/${event.transactionHash}/`
      const operation = operations.get(`${base}${opIndex}`)
      const transfer = transfers.get(`${base}${transferIndex}`)
      const raw = amount(data.amountRaw)
      fail(
        operation?.kind === (kind === 'withdraw' ? 'Withdraw' : 'Supply') &&
          operation.blockNumber === event.blockNumber &&
          operation.blockNumber > cash.from.blockNumber &&
          operation.blockNumber <= cash.to.blockNumber &&
          amount(operation.amountRaw) === raw &&
          transfer?.blockNumber === operation.blockNumber &&
          amount(transfer.amountRaw) === raw &&
          transfer.from === (kind === 'withdraw' ? cash.aToken : data.supplier) &&
          transfer.to === (kind === 'withdraw' ? data.receiver : cash.aToken) &&
          !claimedOperations.has(`${base}${opIndex}`) &&
          !claimedTransfers.has(`${base}${transferIndex}`),
        'join_direct_cash_mismatch',
      )
      claimedOperations.add(`${base}${opIndex}`)
      claimedTransfers.add(`${base}${transferIndex}`)
      if (kind === 'withdraw') {
        withdrawalRaw += raw
        withdrawalCount++
      } else {
        supplyRaw += raw
        supplyCount++
      }
    }
  }
  for (const operation of cash.operations) {
    if (operation.kind === 'Supply' || operation.kind === 'Withdraw')
      fail(claimedOperations.has(position(operation)), 'join_unmatched_supplier_operation')
  }
  let grossIn = 0n
  let grossOut = 0n
  for (const transfer of cash.transfers) {
    const value = amount(transfer.amountRaw)
    if (transfer.from === cash.aToken && transfer.to === cash.aToken) continue
    if (transfer.to === cash.aToken) grossIn += value
    else if (transfer.from === cash.aToken) grossOut += value
    else throw new Error('join_nonreserve_transfer')
  }
  fail(
    amount(cash.reconciliation.totals?.transferInRaw) === grossIn &&
      amount(cash.reconciliation.totals?.transferOutRaw) === grossOut &&
      amount(cash.from.cashRaw) + grossIn - grossOut === amount(cash.to.cashRaw) &&
      supplyRaw <= grossIn &&
      withdrawalRaw <= grossOut,
    'join_cash_accounting_mismatch',
  )
  const trough = cashBlockTrough(cash)
  // Eventful blocks only. Quiet interior blocks have no attested hash here;
  // their end-of-block cash is the preceding eventful balance.
  const byBlock = new Map()
  const block = (number, hash) => {
    let row = byBlock.get(number)
    if (!row) {
      row = { number, hash, reserveIn: 0n, reserveOut: 0n, supplierIn: 0n, supplierOut: 0n }
      byBlock.set(number, row)
    }
    fail(row.hash === hash, 'join_block_flow_hash_mismatch')
    return row
  }
  for (const transfer of cash.transfers) {
    const row = block(transfer.blockNumber, transfer.blockHash)
    if (transfer.from === cash.aToken && transfer.to === cash.aToken) continue
    if (transfer.to === cash.aToken) row.reserveIn += amount(transfer.amountRaw)
    else if (transfer.from === cash.aToken) row.reserveOut += amount(transfer.amountRaw)
  }
  for (const event of supplyEvents)
    block(event.blockNumber, event.blockHash).supplierIn += amount(
      event.reconciliation.evidence.amountRaw,
    )
  for (const event of withdrawalEvents)
    block(event.blockNumber, event.blockHash).supplierOut += amount(
      event.reconciliation.evidence.amountRaw,
    )
  let blockCash = amount(cash.from.cashRaw)
  const blockFlows = [...byBlock.values()]
    .sort((a, b) => a.number - b.number)
    .map((row) => {
      blockCash += row.reserveIn - row.reserveOut
      fail(blockCash >= 0n, 'join_negative_block_cash')
      return {
        blockNumber: row.number,
        blockHash: row.hash,
        reserveInRaw: row.reserveIn.toString(),
        reserveOutRaw: row.reserveOut.toString(),
        supplierInRaw: row.supplierIn.toString(),
        supplierOutRaw: row.supplierOut.toString(),
        cashAfterRaw: blockCash.toString(),
      }
    })
  fail(blockCash === amount(cash.to.cashRaw), 'join_block_flow_endpoint_mismatch')
  return {
    fromExclusive: cash.from.blockNumber,
    fromHash: cash.from.blockHash,
    toInclusive: cash.to.blockNumber,
    toHash: cash.to.blockHash,
    cashBeforeRaw: cash.from.cashRaw,
    cashAfterRaw: cash.to.cashRaw,
    ...trough,
    grossSupplierWithdrawalRaw: withdrawalRaw.toString(),
    supplierWithdrawalEvents: withdrawalCount,
    grossSupplierSupplyRaw: supplyRaw.toString(),
    supplierSupplyEvents: supplyCount,
    otherReserveInRaw: (grossIn - supplyRaw).toString(),
    otherReserveOutRaw: (grossOut - withdrawalRaw).toString(),
    grossReserveInRaw: grossIn.toString(),
    grossReserveOutRaw: grossOut.toString(),
    netCashChangeRaw: (grossIn - grossOut).toString(),
    blockFlows,
    ...(retainVerifiedTimes ? { verifiedTimeHeaders } : {}),
    source: 'two-origin sealed cash and direct receipt replay',
  }
}

function replayVerifiedJoin({
  cashOut = CASH_OUT,
  cashV2Root = CASH_V2_ROOT,
  directOut = DIRECT_FLOW_DIR,
  throughBlock = null,
  archive,
  continuation,
  cashNames,
  directNames,
  expectedFiles = null,
  loadVerifiedDirect = loadDirect,
  retainVerifiedTimes = false,
}) {
  fail(FROM_BLOCK === CASH_FROM, 'join_cash_anchor_mismatch')
  const selected = continuation
    ? selectContinuationThrough({
        cashNames,
        directNames,
        archive,
        continuation,
        explicitThrough: throughBlock,
      })
    : selectCommonThrough({
        cashNames,
        directNames,
        archiveThrough: archive.throughBlock,
        explicitThrough: throughBlock,
      })
  const toBlock = selected.throughBlock
  const useV2 = toBlock > CASH_TARGET
  const v1Entries = cashNames
    .map((name) => ({ name, match: /^slice-([0-9]+)-([0-9]+)\.json$/.exec(name) }))
    .filter(({ match }) => match && Number(match[1]) >= FROM_BLOCK && Number(match[2]) <= toBlock)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
  const v2Entries = useV2
    ? continuation.slices
        .filter((part) => part.toBlock <= toBlock)
        .map((descriptor) => ({ descriptor }))
    : []
  const archivePrefixSha256 = useV2
    ? sha(
        JSON.stringify({
          v1: v1Entries.map((part) => [
            part.name,
            sha(readBounded(join(cashOut, part.name), 4096)),
          ]),
          v2: v2Entries.map(({ descriptor: part }) => [
            part.epoch,
            part.fromBlock,
            part.toBlock,
            part.fromHash,
            part.toHash,
            part.sidecarSha256,
            part.leftSha256,
            part.rightSha256,
            part.projectionSha256,
          ]),
        }),
      )
    : null
  const allEntries = [...v1Entries, ...v2Entries]
  fail(allEntries.length > 0, 'join_cash_slice_bound')
  const entries = useV2 ? allEntries.slice(-MAX_JOINED_SLICES) : allEntries
  fail(entries.length <= MAX_JOINED_SLICES, 'join_cash_slice_bound')
  const windowFromBlock = entries[0].descriptor?.fromBlock ?? Number(entries[0].match[1])
  const withdrawal = loadVerifiedDirect(
    directOut,
    'withdraw',
    windowFromBlock,
    toBlock,
    expectedFiles?.direct,
  )
  const supply = loadVerifiedDirect(
    directOut,
    'supply',
    windowFromBlock,
    toBlock,
    expectedFiles?.direct,
  )
  const slices = []
  let next = windowFromBlock
  let previousHash = entries[0].descriptor?.fromHash ?? null
  for (const entry of entries) {
    const descriptor = entry.descriptor
    const sidecarPath = descriptor?.file ?? join(cashOut, entry.name)
    const stampedSidecar = readStampedJson(sidecarPath, 4096)
    if (expectedFiles)
      fail(
        expectedFiles.cash.get(sidecarPath) === stampedSidecar.fileSha256,
        'join_cash_source_changed',
      )
    const sidecar = stampedSidecar.document
    const { sha256: sidecarSha, ...sidecarBody } = sidecar
    fail(sidecarSha === sha(JSON.stringify(sidecarBody)), 'join_cash_sidecar_digest')
    fail(
      descriptor
        ? descriptor.fromBlock === next &&
            sidecar.study === CASH_V2_STUDY &&
            sidecar.epoch === descriptor.epoch &&
            sidecar.fromBlock === descriptor.fromBlock &&
            sidecar.toBlock === descriptor.toBlock &&
            sidecar.toHash === descriptor.toHash &&
            sidecar.leftSha256 === descriptor.leftSha256 &&
            sidecar.rightSha256 === descriptor.rightSha256 &&
            stampedSidecar.fileSha256 === descriptor.sidecarSha256
        : Number(entry.match[1]) === next,
      'join_cash_slice_gap',
    )
    const leftOrigin =
      sidecar.originSha256?.[0] === sha(CASH_ORIGINS[0])
        ? 'infura'
        : sidecar.originSha256?.[0] === sha(ALCHEMY_ORIGIN)
          ? 'alchemy'
          : sidecar.originSha256?.[0] === sha(DRPC_ORIGIN)
            ? 'drpc'
            : sidecar.originSha256?.[0] === sha(QUICKNODE_ORIGIN)
              ? 'quicknode'
              : null
    fail(
      leftOrigin &&
        sidecar.originSha256?.[1] === sha(CASH_ORIGINS[1]) &&
        (!descriptor ||
          (leftOrigin === descriptor.leftOrigin && descriptor.rightOrigin === 'ankr')),
      'join_cash_source_missing',
    )
    fail(
      /^USDC-[0-9]+-[0-9]+-[0-9a-f]{64}\.json$/.test(sidecar.leftFile) &&
        (!descriptor || sidecar.leftFile === basename(descriptor.leftFile)),
      'join_cash_source_filename',
    )
    const sourcePath = descriptor?.leftFile ?? join(cashOut, leftOrigin, sidecar.leftFile)
    const stampedSource = readStampedJson(sourcePath, 4 * 1024 * 1024)
    if (expectedFiles)
      fail(
        expectedFiles.cash.get(sourcePath) === stampedSource.fileSha256,
        'join_cash_source_changed',
      )
    const source = stampedSource.document
    const { sha256: sourceSha, ...sourceBody } = source
    fail(
      sourceSha === sidecar.leftSha256 &&
        sourceSha === sha(JSON.stringify(sourceBody)) &&
        (!descriptor || sourceSha === descriptor.leftSha256),
      'join_cash_source_digest',
    )
    const cash = economicProjection(source)
    fail(sidecar.projectionSha256 === sha(JSON.stringify(cash)), 'join_cash_projection_digest')
    fail(
      cash.from.blockNumber === next &&
        cash.to.blockNumber === (descriptor?.toBlock ?? Number(entry.match[2])) &&
        (previousHash === null || cash.from.blockHash === previousHash) &&
        (!descriptor ||
          (cash.from.blockHash === descriptor.fromHash &&
            cash.to.blockHash === descriptor.toHash &&
            descriptor.projectionSha256 === sidecar.projectionSha256)),
      'join_cash_source_range',
    )
    const overlapping = (segments) =>
      segments.filter(
        (part) => part.fromBlock <= cash.to.blockNumber && part.toBlock > cash.from.blockNumber,
      )
    const withdrawParts = overlapping(withdrawal.segments)
    const supplyParts = overlapping(supply.segments)
    const within = (part) =>
      part.events.filter(
        (event) =>
          event.blockNumber > cash.from.blockNumber && event.blockNumber <= cash.to.blockNumber,
      )
    const joined = joinVerifiedCashSlice(
      cash,
      withdrawParts.flatMap(within),
      supplyParts.flatMap(within),
      [
        ...withdrawParts.map((part) => ({ ...part, kind: 'withdraw' })),
        ...supplyParts.map((part) => ({ ...part, kind: 'supply' })),
      ],
      { retainVerifiedTimes },
    )
    slices.push({
      ...joined,
      sources: {
        cashSidecarFile: descriptor ? relative(cashV2Root, sidecarPath) : entry.name,
        cashSidecarSha256: sidecarSha,
        cashLeftOrigin: leftOrigin,
        cashLeftFile: descriptor ? relative(cashV2Root, sourcePath) : sidecar.leftFile,
        cashLeftSha256: sourceSha,
        cashProjectionSha256: sidecar.projectionSha256,
        ...(descriptor
          ? {
              cashRightFile: relative(cashV2Root, descriptor.rightFile),
              cashRightSha256: descriptor.rightSha256,
              cashLeftWitnessSha256: sidecar.leftWitnessSha256,
              cashRightWitnessSha256: sidecar.rightWitnessSha256,
            }
          : {}),
        directWithdrawalFiles: withdrawParts.map((part) => ({
          file: part.sourceFile,
          sha256: part.sourceSha256,
        })),
        directSupplyFiles: supplyParts.map((part) => ({
          file: part.sourceFile,
          sha256: part.sourceSha256,
        })),
      },
      ...(descriptor ? { cashArchiveStudy: CASH_V2_STUDY, cashEpoch: descriptor.epoch } : {}),
    })
    next = cash.to.blockNumber
    previousHash = cash.to.blockHash
  }
  fail(next === toBlock, 'join_cash_slice_gap')
  return {
    study: useV2 ? CONTINUATION_STUDY : STUDY,
    fromBlock: windowFromBlock,
    toBlock,
    coverageFrontiers: selected,
    cashArchive: {
      study: useV2 ? continuation.study : archive.study,
      acceptedSlices: useV2
        ? archive.acceptedSlices + continuation.acceptedSlices
        : archive.acceptedSlices,
      throughBlock: useV2 ? continuation.throughBlock : archive.throughBlock,
    },
    ...(useV2
      ? {
          continuity: {
            v1ThroughBlock: CASH_TARGET,
            v1LastHash: archive.lastHash,
            verifiedV2ThroughBlock: toBlock,
            verifiedV2LastHash: previousHash,
            archivePrefixSha256,
            archivedSlices: allEntries.length,
            windowed: allEntries.length > entries.length,
          },
        }
      : {}),
    directWithdrawalSourceFiles: withdrawal.sourceFiles,
    directSupplySourceFiles: supply.sourceFiles,
    slices,
    forecast: false,
  }
}

export function replayJoin({
  cashOut = CASH_OUT,
  cashV2Root = CASH_V2_ROOT,
  directOut = DIRECT_FLOW_DIR,
  throughBlock = null,
  verifyCashArchive = verifyArchive,
  verifyContinuationArchive = verifyArchiveV2,
  loadVerifiedDirect = loadDirect,
  retainVerifiedTimes = false,
} = {}) {
  const archive = verifyCashArchive({ out: cashOut })
  const continuation = archive.complete
    ? verifyContinuationArchive({ root: cashV2Root, v1Out: cashOut })
    : null
  return replayVerifiedJoin({
    cashOut,
    cashV2Root,
    directOut,
    throughBlock,
    archive,
    continuation,
    cashNames: canonicalJoinNames(readdirSync(cashOut), 'cash_v1'),
    directNames: canonicalJoinNames(readdirSync(directOut), 'direct'),
    loadVerifiedDirect,
    retainVerifiedTimes,
  })
}

function sourceOrigin(sidecar) {
  if (sidecar.originSha256?.[0] === sha(CASH_ORIGINS[0])) return 'infura'
  if (sidecar.originSha256?.[0] === sha(ALCHEMY_ORIGIN)) return 'alchemy'
  if (sidecar.originSha256?.[0] === sha(DRPC_ORIGIN)) return 'drpc'
  if (sidecar.originSha256?.[0] === sha(QUICKNODE_ORIGIN)) return 'quicknode'
  throw new Error('join_cash_source_missing')
}

/** One full archive verification per read-only scoring run; pins never accept outside descriptors. */
export function createVerifiedJoinSession({
  cashOut = CASH_OUT,
  cashV2Root = CASH_V2_ROOT,
  directOut = DIRECT_FLOW_DIR,
  retainVerifiedTimes = false,
} = {}) {
  fail(FROM_BLOCK === CASH_FROM, 'join_cash_anchor_mismatch')
  const archive = verifyArchive({ out: cashOut })
  // The V2 verifier replays V1 through this sealed local result, not a second filesystem pass.
  const continuation = archive.complete
    ? verifyArchiveV2({
        root: cashV2Root,
        v1Out: cashOut,
        verifyV1Archive: () => archive,
      })
    : null
  const cashNames = canonicalJoinNames(readdirSync(cashOut), 'cash_v1')
  const directNames = canonicalJoinNames(readdirSync(directOut), 'direct')
  const selected = continuation
    ? selectContinuationThrough({ cashNames, directNames, archive, continuation })
    : selectCommonThrough({
        cashNames,
        directNames,
        archiveThrough: archive.throughBlock,
      })
  const throughBlock = selected.throughBlock
  const v1Entries = cashNames
    .map((name) => ({ name, match: /^slice-([0-9]+)-([0-9]+)\.json$/.exec(name) }))
    .filter(
      ({ match }) => match && Number(match[1]) >= FROM_BLOCK && Number(match[2]) <= throughBlock,
    )
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
  const v2Entries = continuation?.slices.filter((part) => part.toBlock <= throughBlock) ?? []
  const pinEndpoints = Object.freeze([
    ...v1Entries.map(({ match }) => Number(match[2])),
    ...v2Entries.map((part) => part.toBlock),
  ])
  fail(pinEndpoints.length > 0 && pinEndpoints.at(-1) === throughBlock, 'join_session_endpoint')

  // Archive descriptors stay in the closure. Raw stamps bind V1 files (which lack descriptors)
  // and all selected direct receipts even if a file is later rewritten with a valid self-hash.
  const cashFiles = new Map()
  const rightByEndpoint = new Map()
  const rightFiles = new Map()
  const proofFiles = new Map()
  const fileIdentity = (path) => {
    const stat = statSync(path, { bigint: true })
    fail(stat.isFile(), 'join_session_right_source_changed')
    return [stat.dev, stat.ino, stat.size, stat.ctimeNs, stat.mtimeNs].join(':')
  }
  const captureRight = (path, endpoint, expectedDocumentSha) => {
    const stamped = readStampedJson(path, 4 * 1024 * 1024)
    const { sha256: documentSha, ...body } = stamped.document
    fail(
      documentSha === expectedDocumentSha && documentSha === sha(JSON.stringify(body)),
      'join_session_right_source_changed',
    )
    rightByEndpoint.set(endpoint, path)
    rightFiles.set(path, {
      fileSha256: stamped.fileSha256,
      identity: fileIdentity(path),
      checked: false,
    })
  }
  const captureProof = (path) => proofFiles.set(path, fileIdentity(path))
  for (const { name, match } of v1Entries) {
    const sidecarPath = join(cashOut, name)
    const stamped = readStampedJson(sidecarPath, 4096)
    const origin = sourceOrigin(stamped.document)
    const sourcePath = join(cashOut, origin, stamped.document.leftFile)
    const fromBlock = Number(match[1])
    const toBlock = Number(match[2])
    cashFiles.set(sidecarPath, stamped.fileSha256)
    cashFiles.set(sourcePath, sha(readBounded(sourcePath, 4 * 1024 * 1024)))
    captureProof(join(cashOut, `origin-${origin}-${fromBlock}-${toBlock}.json`))
    captureProof(join(cashOut, `origin-ankr-${fromBlock}-${toBlock}.json`))
    captureRight(
      join(cashOut, 'ankr', stamped.document.rightFile),
      toBlock,
      stamped.document.rightSha256,
    )
  }
  for (const descriptor of v2Entries) {
    const epoch = dirname(descriptor.file)
    cashFiles.set(descriptor.file, descriptor.sidecarSha256)
    cashFiles.set(descriptor.leftFile, sha(readBounded(descriptor.leftFile, 4 * 1024 * 1024)))
    captureProof(join(epoch, 'genesis.json'))
    captureProof(
      join(
        epoch,
        `origin-${descriptor.leftOrigin}-${descriptor.fromBlock}-${descriptor.toBlock}.json`,
      ),
    )
    captureProof(
      join(
        epoch,
        `origin-${descriptor.rightOrigin}-${descriptor.fromBlock}-${descriptor.toBlock}.json`,
      ),
    )
    captureRight(descriptor.rightFile, descriptor.toBlock, descriptor.rightSha256)
  }
  const directFiles = new Map()
  for (const name of directNames) {
    const match = /^(?:supply-)?aaveV3Usdc-([0-9]+)-([0-9]+)\.json$/.exec(name)
    if (match && Number(match[1]) <= throughBlock && Number(match[2]) > FROM_BLOCK)
      directFiles.set(name, sha(readBounded(join(directOut, name), 2 * 1024 * 1024)))
  }
  // Detect an archive append/replace during the session before using stale descriptors.
  const directorySets = []
  if (continuation && existsSync(cashV2Root)) {
    const epochs = canonicalJoinNames(readdirSync(cashV2Root), 'cash_v2_root')
    directorySets.push([cashV2Root, epochs, 'cash_v2_root'])
    for (const epoch of epochs) {
      const path = join(cashV2Root, epoch)
      directorySets.push([
        path,
        canonicalJoinNames(readdirSync(path), 'cash_v2_epoch'),
        'cash_v2_epoch',
      ])
    }
  }
  const sameNames = (path, original, kind) =>
    JSON.stringify(canonicalJoinNames(readdirSync(path), kind)) === JSON.stringify(original)
  const checkFileSets = () => {
    fail(sameNames(cashOut, cashNames, 'cash_v1'), 'join_session_cash_file_set_changed')
    fail(sameNames(directOut, directNames, 'direct'), 'join_session_direct_file_set_changed')
    for (const [path, names, kind] of directorySets)
      fail(sameNames(path, names, kind), 'join_session_v2_file_set_changed')
    for (const [path, identity] of proofFiles)
      fail(fileIdentity(path) === identity, 'join_session_proof_source_changed')
  }
  const at = (endpoint, options = {}) => {
    const index = pinEndpoints.indexOf(endpoint)
    fail(index >= 0, 'join_session_unverified_endpoint')
    checkFileSets()
    // Hash each selected right receipt on first use. Subsequent pins check inode and ctime
    // so a rewrite aborts without rereading every right receipt on every historical pin.
    for (const selectedEndpoint of pinEndpoints.slice(
      Math.max(0, index - MAX_JOINED_SLICES + 1),
      index + 1,
    )) {
      const path = rightByEndpoint.get(selectedEndpoint)
      const expected = rightFiles.get(path)
      fail(
        expected && fileIdentity(path) === expected.identity,
        'join_session_right_source_changed',
      )
      if (!expected.checked) {
        fail(
          sha(readBounded(path, 4 * 1024 * 1024)) === expected.fileSha256 &&
            fileIdentity(path) === expected.identity,
          'join_session_right_source_changed',
        )
        expected.checked = true
      }
    }
    return replayVerifiedJoin({
      retainVerifiedTimes: options.retainVerifiedTimes ?? retainVerifiedTimes,
      cashOut,
      cashV2Root,
      directOut,
      throughBlock: endpoint,
      archive,
      continuation,
      cashNames,
      directNames,
      expectedFiles: { cash: cashFiles, direct: directFiles },
    })
  }
  return Object.freeze({
    pinEndpoints: () => [...pinEndpoints],
    latest: () => at(throughBlock),
    at,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const explicit =
    process.argv.length === 5 && process.argv[2] === '--verify' && process.argv[3] === '--through'
  if (!explicit && !(process.argv.length === 3 && process.argv[2] === '--verify'))
    throw new Error('join_read_only_verify_required')
  const throughBlock = explicit ? Number(process.argv[4]) : null
  process.stdout.write(`${JSON.stringify(replayJoin({ throughBlock }))}\n`)
}
