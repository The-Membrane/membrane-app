// Prospective, local-only PT withdrawal callability for the frozen Twyne wrapper.
// An eth_call is neither mined PT delivery nor a completed USDe exit.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
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
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { keccak256, parseAbi, toEventSelector } from 'viem'
import ptExitModule from '../../lib/carry/twynePtExit.ts'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

const { readTwynePtExit } = ptExitModule
export const STUDY = 'carry_pt_wrapper_holder_v3'
export const ROOT = resolve('data/research/venue-signals/carry-pt-wrapper-holder-v3')
export const ROUTE = 'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]'
export const VAULT = '0x0af56afbddcb140323445bd7211ba90e54e5fd1c'
export const PT = '0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34'
export const ATOKEN = '0x01e69a58ca3ddc695820ce6f66fbdf3fa55d0545'
export const POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'
const WRAPPER_IMPLEMENTATION = '0x41695d3304e38bc806f077a3541c5cd34f8f034b'
const ATOKEN_IMPLEMENTATION = '0xadc45df3cf1584624c97338bef33363bf5b97ada'
const POOL_IMPLEMENTATION = '0x728a138a4823392c2efa55e028d434f526fe03cf'
const YT = '0xfe6040719cca36aeb85e352f48fe956057728814'
const SY = '0xc9bfebc79a722c05dc34bd2a227ef2db19fd1b8e'
const EXPIRY = 1_792_627_200
export const DEPLOYMENT_CODE_HASHES = Object.freeze({
  [VAULT]: '0x815c4d3d433b86ca34f214b94aafd3660ed5cd228f0205cc77600da6679f0a11',
  [WRAPPER_IMPLEMENTATION]: '0xe3dca07a6a6730d4a8d90ed26b440937c3cbe51ca0f1e8a3f90c73e4cf2f8c62',
  [PT]: '0x65e3bb254bd1e1ba2fb04f71ae9f8b30ec8e90ed5252b9d1719ced24620df5a3',
  [ATOKEN]: '0x3935a620a6917734e2ab10f7d244650670b6d1af1e269359de8cc2aa62f583c8',
  [ATOKEN_IMPLEMENTATION]: '0x3bd38f9cd664b4169375c69f362dc585ed97adf6da6f8b6d5569ecb8690d9eb5',
  [POOL]: '0x96107dc4006b4c7fecd1827cfb275ffeef31e6194cd50466f85f8eb24ccf2679',
  [POOL_IMPLEMENTATION]: '0x530cdbba5eb9487cd5d041bb74b7a1936ad3230bf9e361893ecd025373c7fbe5',
})
export const HORIZONS = Object.freeze([1, 4, 24, 48, 168])
export const ORIGINS = Object.freeze(['https://rpc.ankr.com', 'https://lb.drpc.live'])
const DEADLINE_HOURS = 2
const SCAN_BLOCKS = 64
const SCAN_WINDOWS = 16
const MAX_CANDIDATES = 12
const MAX_BYTES = 512 * 1024
const RESERVE = 1024 ** 3
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const SHA = /^[0-9a-f]{64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const ZERO = '0x0000000000000000000000000000000000000000'
const TRANSFER_TOPIC = toEventSelector(
  parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)'])[0],
).toLowerCase()
const SHARE_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
])
const sha = (value) => createHash('sha256').update(value).digest('hex')
const SEED_PATH = resolve('scripts/route-cohort/aug-2026-ab-vault-seed.json')
const SEED_TEXT = readFileSync(SEED_PATH, 'utf8')
const SEED_SHA = sha(SEED_TEXT)
const COHORT = JSON.parse(SEED_TEXT)
  .positions.filter((row) => row.vault === VAULT && row.routeIds?.includes(ROUTE))
  .map((row) => row.owner)
  .sort()
const fail = (ok, code) => {
  if (!ok) throw Error(`pt_wrapper_holder_${code}`)
}
const asUtc = (ms) => new Date(ms).toISOString()
const time = (value) => {
  const ms = Date.parse(value)
  fail(Number.isFinite(ms) && asUtc(ms) === value, 'clock')
  return ms
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const stripped = ({ sha256: _seal, ...body }) => body
const dir = (kind) => join(ROOT, kind)
const name = (sequence) => `${String(sequence).padStart(8, '0')}.json`

export function configuredUrls(raw = readEnv().get('RECORDER_RPC_URL')) {
  const ring = String(raw ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
  const selected = ORIGINS.map((origin) => ring.find((url) => new URL(url).origin === origin))
  fail(selected.every(Boolean), 'two_origins_required')
  return selected
}

function disk(path, bytes, reserve) {
  const stats = statfsSync(path)
  fail(Number(stats.bavail) * Number(stats.bsize) - bytes >= reserve, 'disk_reserve')
}

export function readChain(kind, root = ROOT) {
  fail(['issues', 'scores', 'attempts'].includes(kind), 'kind')
  const path = join(root, kind)
  if (!existsSync(path)) return []
  const names = readdirSync(path).sort()
  fail(names.length <= 100_000, 'ledger_bound')
  const rows = []
  for (const file of names) {
    fail(file === name(rows.length + 1), 'ledger_filename')
    const fd = openSync(join(path, file), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = fstatSync(fd)
      fail(before.isFile() && before.size > 0 && before.size <= MAX_BYTES, 'ledger_file')
      const text = readFileSync(fd, 'utf8')
      fail(
        Buffer.byteLength(text) === before.size && fstatSync(fd).size === before.size,
        'ledger_changed',
      )
      const row = JSON.parse(text)
      fail(
        text === `${JSON.stringify(row)}\n` &&
          row.study === STUDY &&
          row.kind === kind &&
          row.sequence === rows.length + 1 &&
          row.previousSha256 === (rows.at(-1)?.sha256 ?? null) &&
          SHA.test(row.sha256 ?? '') &&
          sha(JSON.stringify(stripped(row))) === row.sha256,
        'ledger_chain',
      )
      rows.push(row)
    } finally {
      closeSync(fd)
    }
  }
  return rows
}

export function append(kind, body, root = ROOT) {
  const path = join(root, kind)
  mkdirSync(path, { recursive: true })
  const rows = readChain(kind, root)
  const row = {
    ...body,
    study: STUDY,
    kind,
    sequence: rows.length + 1,
    previousSha256: rows.at(-1)?.sha256 ?? null,
  }
  row.sha256 = sha(JSON.stringify(row))
  const serialized = `${JSON.stringify(row)}\n`
  fail(Buffer.byteLength(serialized) <= MAX_BYTES, 'record_size')
  // The production ledger always preserves one GiB. Temporary test roots
  // need only space for their bounded fixture writes.
  disk(path, Buffer.byteLength(serialized), resolve(root) === ROOT ? RESERVE : 0)
  const stage = join(path, `.pt-wrapper-${randomUUID()}.tmp`)
  let fd
  try {
    fd = openSync(
      stage,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    writeFileSync(fd, serialized)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    linkSync(stage, join(path, name(row.sequence)))
    const dfd = openSync(path, constants.O_RDONLY)
    try {
      fsyncSync(dfd)
    } finally {
      closeSync(dfd)
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    try {
      unlinkSync(stage)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return row
}

const header = (block) => ({
  number: Number(block.number),
  hash: String(block.hash ?? '').toLowerCase(),
  timestamp: Number(block.timestamp),
})

export async function commonFinalized(clients, nowMs = Date.now()) {
  fail(clients.length === 2, 'origin_count')
  const heads = await Promise.all(
    clients.map((client) => client.getBlock({ blockTag: 'finalized' })),
  )
  const n = heads.map((row) => Number(row.number))
  fail(
    n.every((value) => Number.isSafeInteger(value) && value > 0),
    'finality',
  )
  const target = Math.min(...n)
  const blocks = await Promise.all(
    clients.map((client) => client.getBlock({ blockNumber: BigInt(target) })),
  )
  const left = header(blocks[0])
  const right = header(blocks[1])
  fail(same(left, right) && HASH.test(left.hash), 'finalized_disagreement')
  fail(
    nowMs - left.timestamp * 1000 >= -120_000 && nowMs - left.timestamp * 1000 <= 7_200_000,
    'finalized_stale',
  )
  return left
}

function pinnedClient(client, block, codeHashes) {
  return {
    getChainId: () => client.getChainId(),
    getBlock: (args) =>
      args.blockTag === 'finalized'
        ? Promise.resolve({
            number: BigInt(block.number),
            hash: block.hash,
            timestamp: BigInt(block.timestamp),
          })
        : client.getBlock(args),
    getCode: async (args) => {
      const code = await client.getCode(args)
      if (code && DEPLOYMENT_CODE_HASHES[args.address.toLowerCase()])
        codeHashes[args.address.toLowerCase()] = keccak256(code).toLowerCase()
      return code
    },
    getStorageAt: (args) => client.getStorageAt(args),
    readContract: (args) => client.readContract(args),
    call: (args) => client.call(args),
  }
}

export function projection(row) {
  const e = row?.evidence
  const a = row?.amountCheck
  const raw = (value) =>
    typeof value === 'string' && DECIMAL.test(value) && BigInt(value) < 1n << 256n
  const codeHashes = Object.fromEntries(Object.entries(row?.codeHashes ?? {}).sort())
  const expectedHashes = Object.fromEntries(Object.entries(DEPLOYMENT_CODE_HASHES).sort())
  fail(
    row?.status === 'observed' &&
      row.reason === undefined &&
      row?.routeKey === ROUTE &&
      row.destination === VAULT &&
      e?.chainId === 1 &&
      Number.isSafeInteger(e?.blockNumber) &&
      e.blockNumber > 0 &&
      HASH.test(e?.blockHash ?? '') &&
      Number.isSafeInteger(e?.blockTimestamp) &&
      e.blockTimestamp > 0 &&
      e.wrapperImplementation?.toLowerCase() === WRAPPER_IMPLEMENTATION &&
      e.aTokenImplementation?.toLowerCase() === ATOKEN_IMPLEMENTATION &&
      e.poolImplementation?.toLowerCase() === POOL_IMPLEMENTATION &&
      e.ptAsset?.toLowerCase() === PT &&
      e.aToken?.toLowerCase() === ATOKEN &&
      e.pool?.toLowerCase() === POOL &&
      e.ptDecimals === 18 &&
      e.wrapperDecimals === 18 &&
      e.yt?.toLowerCase() === YT &&
      e.sy?.toLowerCase() === SY &&
      e.ptExpiry === EXPIRY &&
      e.ptMaturity === (e.blockTimestamp < EXPIRY ? 'before_expiry' : 'at_or_after_expiry') &&
      same(codeHashes, expectedHashes) &&
      raw(a?.requestedPtRaw) &&
      BigInt(a.requestedPtRaw) > 0n &&
      raw(a?.holderSharesRaw) &&
      raw(a?.previewSharesToBurnRaw) &&
      BigInt(a.previewSharesToBurnRaw) > 0n &&
      raw(a?.aavePtCashRaw) &&
      a.ptDelivery === 'not_observed' &&
      a.ptToUsde === 'not_assessed' &&
      (a.simulation?.status === 'position_insufficient'
        ? BigInt(a.holderSharesRaw) < BigInt(a.previewSharesToBurnRaw)
        : a.simulation?.status === 'success'
          ? raw(a.simulation.sharesBurnedRaw) &&
            BigInt(a.simulation.sharesBurnedRaw) > 0n &&
            BigInt(a.simulation.sharesBurnedRaw) <= BigInt(a.holderSharesRaw)
          : a.simulation?.status === 'evm_revert' &&
            a.simulation.reason === 'unknown_execution_constraint') &&
      (a.redeemSimulation?.status === 'not_attempted'
        ? BigInt(a.holderSharesRaw) < BigInt(a.previewSharesToBurnRaw)
        : a.redeemSimulation?.status === 'evm_revert'
          ? a.redeemSimulation.reason === 'unknown_execution_constraint'
          : ['success', 'below_requested'].includes(a.redeemSimulation?.status) &&
            raw(a.redeemSimulation.ptAssetsRaw) &&
            BigInt(a.redeemSimulation.ptAssetsRaw) > 0n &&
            (a.redeemSimulation.status === 'success'
              ? BigInt(a.redeemSimulation.ptAssetsRaw) >= BigInt(a.requestedPtRaw)
              : BigInt(a.redeemSimulation.ptAssetsRaw) < BigInt(a.requestedPtRaw))),
    'assay_identity',
  )
  return {
    status: row.status,
    blockNumber: e.blockNumber,
    blockHash: e.blockHash,
    assayOwner: row.assayOwner,
    routeKey: row.routeKey,
    destination: row.destination,
    evidence: e,
    codeHashes,
    amountCheck: a,
  }
}

export async function assayPair(clients, block, holder, qRaw) {
  fail(ADDRESS.test(holder) && DECIMAL.test(qRaw) && BigInt(qRaw) > 0n, 'assay_request')
  const input = { routeKey: ROUTE, destinationAddress: VAULT, holder, assetsRaw: qRaw }
  const captures = clients.map(() => ({}))
  const measured = await Promise.all(
    clients.map((client, i) => readTwynePtExit(pinnedClient(client, block, captures[i]), input)),
  )
  const left = projection({ ...measured[0], codeHashes: captures[0] })
  const right = projection({ ...measured[1], codeHashes: captures[1] })
  fail(
    same(left, right) &&
      left.blockHash === block.hash &&
      left.blockNumber === block.number &&
      left.evidence.blockTimestamp === block.timestamp,
    'assay_origin_disagreement',
  )
  return { ...left, assayOwner: holder, holderExecutable: false }
}

const rawLog = (log, from, to) => {
  const row = {
    address: String(log.address ?? '').toLowerCase(),
    blockNumber: Number(BigInt(log.blockNumber ?? -1)),
    blockHash: String(log.blockHash ?? '').toLowerCase(),
    transactionHash: String(log.transactionHash ?? '').toLowerCase(),
    logIndex: Number(BigInt(log.logIndex ?? -1)),
    topics: (log.topics ?? []).map((topic) => String(topic).toLowerCase()),
    data: String(log.data ?? '').toLowerCase(),
  }
  fail(
    row.address === VAULT &&
      row.blockNumber >= from &&
      row.blockNumber <= to &&
      HASH.test(row.blockHash) &&
      HASH.test(row.transactionHash) &&
      Number.isSafeInteger(row.logIndex) &&
      row.logIndex >= 0 &&
      row.topics[0] === TRANSFER_TOPIC &&
      row.topics.length === 3 &&
      row.topics.every((topic) => HASH.test(topic)) &&
      /^0x0{24}[0-9a-f]{40}$/.test(row.topics[1]) &&
      /^0x0{24}[0-9a-f]{40}$/.test(row.topics[2]) &&
      /^0x[0-9a-f]{64}$/.test(row.data) &&
      BigInt(row.data) > 0n,
    'candidate_log_invalid',
  )
  return row
}

export async function discoverHolder(clients, block, scanOffset = 0) {
  fail(Number.isSafeInteger(scanOffset) && scanOffset >= 0 && scanOffset <= 8, 'scan_offset')
  let quietUnverified = false
  for (let window = 0; window < SCAN_WINDOWS; window++) {
    const to = block.number - (scanOffset + window) * SCAN_BLOCKS
    const from = to - SCAN_BLOCKS + 1
    if (from < 0) break
    const filter = {
      address: VAULT,
      fromBlock: `0x${from.toString(16)}`,
      toBlock: `0x${to.toString(16)}`,
      topics: [TRANSFER_TOPIC],
    }
    const primary = await clients[0].request({ method: 'eth_getLogs', params: [filter] })
    fail(Array.isArray(primary) && primary.length < 1000, 'candidate_logs_unavailable')
    const normalized = primary.map((log) => rawLog(log, from, to))
    let secondary = null
    try {
      secondary = await clients[1].request({ method: 'eth_getLogs', params: [filter] })
    } catch {
      quietUnverified = true
    }
    if (secondary !== null) {
      fail(Array.isArray(secondary) && secondary.length < 1000, 'candidate_logs_unavailable')
      fail(
        same(
          normalized,
          secondary.map((log) => rawLog(log, from, to)),
        ),
        'candidate_origin_disagreement',
      )
    }
    const unique = new Set()
    for (const log of normalized.reverse()) {
      const holder = `0x${log.topics[2].slice(-40)}`
      if (holder === ZERO || unique.has(holder)) continue
      unique.add(holder)
      if (unique.size > MAX_CANDIDATES) break
      if (secondary === null) {
        const receipt = await clients[1].request({
          method: 'eth_getTransactionReceipt',
          params: [log.transactionHash],
        })
        fail(
          receipt?.transactionHash?.toLowerCase() === log.transactionHash &&
            receipt?.blockHash?.toLowerCase() === log.blockHash &&
            Array.isArray(receipt.logs),
          'candidate_receipt_unavailable',
        )
        const matching = receipt.logs
          .filter(
            (row) =>
              String(row.address).toLowerCase() === VAULT &&
              String(row.topics?.[0]).toLowerCase() === TRANSFER_TOPIC,
          )
          .map((row) => rawLog(row, log.blockNumber, log.blockNumber))
        fail(
          matching.some((row) => same(row, log)),
          'candidate_receipt_disagreement',
        )
      }
      const pin = { blockHash: block.hash, requireCanonical: true }
      const [codes, shares] = await Promise.all([
        Promise.all(clients.map((client) => client.getCode({ address: holder, ...pin }))),
        Promise.all(
          clients.map((client) =>
            client.readContract({
              address: VAULT,
              abi: SHARE_ABI,
              functionName: 'balanceOf',
              args: [holder],
              ...pin,
            }),
          ),
        ),
      ])
      fail(same(codes[0], codes[1]) && shares[0] === shares[1], 'candidate_state_disagreement')
      if (shares[0] < 10n) continue
      // Price only one tenth of the observed shares; maxWithdraw in this
      // wrapper does not enforce executable Aave PT liquidity.
      const previews = await Promise.all(
        clients.map((client) =>
          client.readContract({
            address: VAULT,
            abi: SHARE_ABI,
            functionName: 'previewRedeem',
            args: [shares[0] / 10n],
            ...pin,
          }),
        ),
      )
      fail(previews[0] === previews[1], 'candidate_state_disagreement')
      if (previews[0] <= 0n) continue
      return {
        holder,
        holderKind: codes[0] === '0x' ? 'no_code' : 'contract',
        sharesRaw: shares[0].toString(),
        previewPtRaw: previews[0].toString(),
        sourceTx: log.transactionHash,
        sourceBlock: log.blockNumber,
        sourceAttestation:
          secondary === null ? 'primary_log_secondary_receipt' : 'two_origin_log_query',
      }
    }
  }
  fail(!quietUnverified, 'candidate_quiet_unverified')
  return null
}

export async function discoverCohortHolder(clients, block, offset = 0) {
  fail(COHORT.length === 16 && Number.isSafeInteger(offset) && offset >= 0, 'cohort_invalid')
  const pin = { blockHash: block.hash, requireCanonical: true }
  const entries = []
  for (let i = 0; i < COHORT.length; i++) {
    const holder = COHORT[(offset + i) % COHORT.length]
    const [codes, shares] = await Promise.all([
      Promise.all(clients.map((client) => client.getCode({ address: holder, ...pin }))),
      Promise.all(
        clients.map((client) =>
          client.readContract({
            address: VAULT,
            abi: SHARE_ABI,
            functionName: 'balanceOf',
            args: [holder],
            ...pin,
          }),
        ),
      ),
    ])
    fail(
      codes.every((code) => typeof code === 'string' && /^0x(?:[0-9a-f]{2})*$/.test(code)) &&
        same(codes[0], codes[1]) &&
        shares[0] === shares[1],
      'candidate_state_disagreement',
    )
    let previewPtRaw = null
    if (codes[0] === '0x' && shares[0] >= 10n) {
      const previews = await Promise.all(
        clients.map((client) =>
          client.readContract({
            address: VAULT,
            abi: SHARE_ABI,
            functionName: 'previewRedeem',
            args: [shares[0] / 10n],
            ...pin,
          }),
        ),
      )
      fail(previews[0] === previews[1], 'candidate_state_disagreement')
      previewPtRaw = previews[0].toString()
    }
    entries.push({
      holder,
      codeByOrigin: codes.map((code) => (code === '0x' ? '0x' : keccak256(code).toLowerCase())),
      sharesRaw: shares[0].toString(),
      previewPtRaw,
    })
  }
  const selectedIndex = entries.findIndex(
    (row) =>
      row.codeByOrigin[0] === '0x' &&
      BigInt(row.sharesRaw) >= 10n &&
      BigInt(row.previewPtRaw ?? '0') > 0n,
  )
  const scan = {
    sourceSeedSha256: SEED_SHA,
    sourceBlock: block.number,
    sourceBlockHash: block.hash,
    selectionOffset: offset % COHORT.length,
    selectionWitness: entries,
  }
  if (selectedIndex < 0) return { status: 'no_code_candidate_unavailable', ...scan }
  const selected = entries[selectedIndex]
  return {
    holder: selected.holder,
    holderKind: 'no_code',
    codeByOrigin: selected.codeByOrigin,
    sharesRaw: selected.sharesRaw,
    previewPtRaw: selected.previewPtRaw,
    sourceAttestation: 'frozen_cohort_two_origin_no_code',
    sourceTx: null,
    ...scan,
  }
}

function selectedCohortEntry(scan, blockNumber, blockHash) {
  if (
    scan.sourceSeedSha256 !== SEED_SHA ||
    scan.sourceBlock !== blockNumber ||
    scan.sourceBlockHash !== blockHash ||
    !Number.isSafeInteger(scan.selectionOffset) ||
    scan.selectionOffset < 0 ||
    scan.selectionOffset >= COHORT.length ||
    !Array.isArray(scan.selectionWitness) ||
    scan.selectionWitness.length !== COHORT.length
  )
    return { valid: false }
  const entries = scan.selectionWitness
  for (let i = 0; i < entries.length; i++) {
    const row = entries[i]
    if (
      row.holder !== COHORT[(scan.selectionOffset + i) % COHORT.length] ||
      !Array.isArray(row.codeByOrigin) ||
      row.codeByOrigin.length !== 2 ||
      !same(row.codeByOrigin[0], row.codeByOrigin[1]) ||
      !(row.codeByOrigin[0] === '0x' || HASH.test(row.codeByOrigin[0])) ||
      !DECIMAL.test(row.sharesRaw ?? '') ||
      !(row.previewPtRaw === null || DECIMAL.test(row.previewPtRaw ?? '')) ||
      (row.codeByOrigin[0] === '0x' && BigInt(row.sharesRaw) >= 10n && row.previewPtRaw === null) ||
      (row.previewPtRaw !== null && (row.codeByOrigin[0] !== '0x' || BigInt(row.sharesRaw) < 10n))
    )
      return { valid: false }
  }
  const selected = entries.find(
    (row) =>
      row.codeByOrigin[0] === '0x' &&
      BigInt(row.sharesRaw) >= 10n &&
      BigInt(row.previewPtRaw ?? '0') > 0n,
  )
  return { valid: true, selected }
}

function validCohortSelection(candidate, blockNumber, blockHash) {
  if (
    candidate.sourceAttestation !== 'frozen_cohort_two_origin_no_code' ||
    candidate.sourceTx !== null ||
    candidate.holderKind !== 'no_code' ||
    !same(candidate.codeByOrigin, ['0x', '0x'])
  )
    return false
  const { valid, selected } = selectedCohortEntry(candidate, blockNumber, blockHash)
  return (
    valid &&
    selected !== undefined &&
    selected?.holder === candidate.holder &&
    selected.sharesRaw === candidate.sharesRaw &&
    selected.previewPtRaw === candidate.previewPtRaw &&
    same(selected.codeByOrigin, candidate.codeByOrigin)
  )
}

export function qLadder(previewPtRaw) {
  fail(DECIMAL.test(previewPtRaw) && BigInt(previewPtRaw) > 0n, 'ladder_base')
  const max = BigInt(previewPtRaw)
  const values = [1n, 10n, 25n, 50n, 100n].map((pct) => (max * pct) / 100n).filter((q) => q > 0n)
  return [...new Set(values.map(String))]
}

function targets(issuedAtUtc) {
  return HORIZONS.map((horizonHours) => ({
    horizonHours,
    targetAtUtc: asUtc(time(issuedAtUtc) + horizonHours * 3_600_000),
    deadlineAtUtc: asUtc(time(issuedAtUtc) + (horizonHours + DEADLINE_HOURS) * 3_600_000),
  }))
}

export function classifyPtCallOutcome(holderKind, simulationStatus) {
  fail(holderKind === 'no_code', 'holder_kind')
  fail(
    ['success', 'evm_revert', 'position_insufficient'].includes(simulationStatus),
    'simulation_status',
  )
  if (simulationStatus !== 'success') return 'simulated_revert'
  return 'simulated_no_code_pt_call_success'
}

export function verifyLedgers(root = ROOT) {
  const issues = readChain('issues', root)
  const scores = readChain('scores', root)
  const attempts = readChain('attempts', root)
  const scored = new Set()
  const slots = new Set()
  for (const issue of issues) {
    fail(
      issue.routeKey === ROUTE &&
        issue.destination === VAULT &&
        issue.asset === PT &&
        ADDRESS.test(issue.holder ?? '') &&
        HASH.test(issue.baseline?.blockHash ?? '') &&
        Number.isSafeInteger(issue.baseline.blockNumber) &&
        same(issue.origins, ORIGINS) &&
        same(issue.targets, targets(issue.issuedAtUtc)) &&
        Number.isSafeInteger(issue.slot) &&
        issue.slot === Math.floor(time(issue.issuedAtUtc) / (30 * 60_000)) &&
        !slots.has(issue.slot) &&
        time(issue.issuedAtUtc) >= issue.baseline.blockTimestamp * 1000 &&
        time(issue.issuedAtUtc) - issue.baseline.blockTimestamp * 1000 <= 7_200_000 &&
        issue.candidate?.holder === issue.holder &&
        issue.candidate?.holderKind === 'no_code' &&
        issue.holderKind === issue.candidate.holderKind &&
        validCohortSelection(
          issue.candidate,
          issue.baseline.blockNumber,
          issue.baseline.blockHash,
        ) &&
        Number.isSafeInteger(issue.candidate.sourceBlock) &&
        issue.candidate.sourceBlock > 0 &&
        issue.candidate.sourceBlock <= issue.baseline.blockNumber &&
        DECIMAL.test(issue.candidate.sharesRaw ?? '') &&
        BigInt(issue.candidate.sharesRaw) > 0n &&
        issue.candidate.sourceAttestation === 'frozen_cohort_two_origin_no_code' &&
        DECIMAL.test(issue.candidate.previewPtRaw ?? '') &&
        BigInt(issue.candidate.previewPtRaw) > 0n &&
        same(issue.qRaw, qLadder(issue.candidate.previewPtRaw)) &&
        issue.baseline.cases.length === issue.qRaw.length &&
        issue.qRaw.every((q, i) => DECIMAL.test(q) && q === issue.baseline.cases[i].qRaw) &&
        issue.payoutAssessment === 'pt_first_leg_simulation_only',
      'issue_invalid',
    )
    slots.add(issue.slot)
    for (const entry of issue.baseline.cases) {
      const measured = projection(entry.measurement)
      fail(
        measured.blockHash === issue.baseline.blockHash &&
          measured.blockNumber === issue.baseline.blockNumber &&
          measured.assayOwner === issue.holder &&
          entry.measurement.holderExecutable === false &&
          measured.evidence.blockTimestamp === issue.baseline.blockTimestamp &&
          measured.amountCheck.requestedPtRaw === entry.qRaw &&
          DECIMAL.test(measured.amountCheck.holderSharesRaw) &&
          DECIMAL.test(measured.amountCheck.previewSharesToBurnRaw) &&
          ['success', 'evm_revert', 'position_insufficient'].includes(
            measured.amountCheck.simulation.status,
          ),
        'issue_case_invalid',
      )
    }
  }
  for (const score of scores) {
    const issue = issues[score.issueSequence - 1]
    const target = issue?.targets.find((row) => row.horizonHours === score.horizonHours)
    const key = `${score.issueSequence}:${score.horizonHours}`
    fail(
      issue &&
        target &&
        !scored.has(key) &&
        score.issueSha256 === issue.sha256 &&
        score.targetAtUtc === target.targetAtUtc &&
        score.deadlineAtUtc === target.deadlineAtUtc &&
        score.holder === issue.holder &&
        score.holderKind === issue.holderKind &&
        same(score.qRaw, issue.qRaw) &&
        time(score.scoredAtUtc) >= time(target.targetAtUtc) &&
        score.payoutAssessment === 'pt_first_leg_simulation_only',
      'score_binding',
    )
    scored.add(key)
    if (score.status === 'missed_window')
      fail(
        time(score.scoredAtUtc) > time(target.deadlineAtUtc) &&
          score.cases === null &&
          score.block?.timestamp * 1000 > time(target.deadlineAtUtc) &&
          score.block?.number > issue.baseline.blockNumber &&
          HASH.test(score.block?.hash ?? '') &&
          same(score.origins, ORIGINS),
        'score_censor',
      )
    else
      fail(
        score.status === 'measured' &&
          time(score.scoredAtUtc) <= time(target.deadlineAtUtc) &&
          HASH.test(score.block?.hash ?? '') &&
          score.block?.timestamp * 1000 >= time(target.targetAtUtc) &&
          score.block?.timestamp * 1000 <= time(target.deadlineAtUtc) &&
          score.block?.number > issue.baseline.blockNumber &&
          same(score.origins, ORIGINS) &&
          score.cases.length === issue.qRaw.length &&
          score.cases.every(
            (row, i) =>
              row.qRaw === issue.qRaw[i] &&
              ['simulated_no_code_pt_call_success', 'simulated_revert', 'unavailable'].includes(
                row.outcome,
              ),
          ),
        'score_measurement',
      )
    if (score.status === 'measured') {
      fail(
        score.cases.some((row) => row.measurement !== null),
        'score_all_unavailable',
      )
      for (const row of score.cases) {
        if (row.measurement === null) {
          fail(row.outcome === 'unavailable', 'score_case_invalid')
          continue
        }
        const measured = projection(row.measurement)
        fail(
          measured.blockHash === score.block.hash &&
            measured.blockNumber === score.block.number &&
            measured.assayOwner === issue.holder &&
            row.measurement.holderExecutable === false &&
            measured.evidence.blockTimestamp === score.block.timestamp &&
            measured.amountCheck.requestedPtRaw === row.qRaw &&
            row.outcome ===
              classifyPtCallOutcome(issue.holderKind, measured.amountCheck.simulation.status),
          'score_case_invalid',
        )
      }
    }
  }
  for (const attempt of attempts) {
    fail(
      ['no_code_candidate_unavailable', 'source_unavailable', 'assay_unavailable'].includes(
        attempt.reason,
      ) &&
        ['issue', 'score'].includes(attempt.phase) &&
        time(attempt.atUtc) > 0,
      'attempt_invalid',
    )
    if (attempt.reason === 'no_code_candidate_unavailable') {
      const scan = selectedCohortEntry(attempt, attempt.block?.number, attempt.block?.hash)
      fail(
        attempt.phase === 'issue' &&
          scan.valid &&
          scan.selected === undefined &&
          HASH.test(attempt.block?.hash ?? '') &&
          Number.isSafeInteger(attempt.block?.number) &&
          Number.isSafeInteger(attempt.block?.timestamp) &&
          time(attempt.atUtc) >= attempt.block.timestamp * 1000 &&
          time(attempt.atUtc) - attempt.block.timestamp * 1000 <= 7_200_000,
        'attempt_selection_invalid',
      )
    }
  }
  return { issues, scores, attempts }
}

export async function issue({
  clients,
  nowMs = Date.now(),
  clock = Date.now,
  scanOffset = null,
  root = ROOT,
} = {}) {
  const { issues } = verifyLedgers(root)
  const slot = Math.floor(nowMs / (30 * 60_000))
  if (issues.some((row) => row.slot === slot)) return { status: 'already_issued' }
  let block
  let candidate
  let qRaw
  let cases
  try {
    block = await commonFinalized(clients, nowMs)
    candidate = await discoverCohortHolder(clients, block, scanOffset ?? slot)
    if (candidate.status === 'no_code_candidate_unavailable') {
      append(
        'attempts',
        {
          phase: 'issue',
          reason: 'no_code_candidate_unavailable',
          atUtc: asUtc(clock()),
          block,
          sourceSeedSha256: candidate.sourceSeedSha256,
          sourceBlock: candidate.sourceBlock,
          sourceBlockHash: candidate.sourceBlockHash,
          selectionOffset: candidate.selectionOffset,
          selectionWitness: candidate.selectionWitness,
        },
        root,
      )
      return { status: 'no_code_candidate_unavailable' }
    }
    qRaw = qLadder(candidate.previewPtRaw)
    cases = []
    for (const q of qRaw)
      cases.push({ qRaw: q, measurement: await assayPair(clients, block, candidate.holder, q) })
  } catch {
    append(
      'attempts',
      { phase: 'issue', reason: 'source_unavailable', atUtc: asUtc(clock()) },
      root,
    )
    return { status: 'source_unavailable' }
  }
  const completedAtMs = clock()
  fail(Number.isFinite(completedAtMs) && completedAtMs >= nowMs, 'completion_clock')
  if (completedAtMs - block.timestamp * 1000 > 7_200_000) {
    append(
      'attempts',
      { phase: 'issue', reason: 'source_unavailable', atUtc: asUtc(completedAtMs) },
      root,
    )
    return { status: 'source_unavailable' }
  }
  const issuedAtUtc = asUtc(completedAtMs)
  const completedSlot = Math.floor(completedAtMs / (30 * 60_000))
  if (issues.some((row) => row.slot === completedSlot)) return { status: 'already_issued' }
  const saved = append(
    'issues',
    {
      slot: completedSlot,
      issuedAtUtc,
      routeKey: ROUTE,
      destination: VAULT,
      asset: PT,
      holder: candidate.holder,
      holderKind: candidate.holderKind,
      candidate,
      qRaw,
      origins: ORIGINS,
      baseline: {
        blockNumber: block.number,
        blockHash: block.hash,
        blockTimestamp: block.timestamp,
        cases,
      },
      targets: targets(issuedAtUtc),
      payoutAssessment: 'pt_first_leg_simulation_only',
    },
    root,
  )
  verifyLedgers(root)
  return { status: 'issued', sequence: saved.sequence, caseCount: qRaw.length }
}

export async function score({ clients, nowMs = Date.now(), clock = Date.now, root = ROOT } = {}) {
  const { issues, scores } = verifyLedgers(root)
  const done = new Set(scores.map((row) => `${row.issueSequence}:${row.horizonHours}`))
  const due = issues.flatMap((issue) =>
    issue.targets
      .filter(
        (target) =>
          nowMs >= time(target.targetAtUtc) &&
          !done.has(`${issue.sequence}:${target.horizonHours}`),
      )
      .map((target) => ({ issue, target })),
  )
  if (!due.length) return { status: 'nothing_due' }
  const { issue: original, target } = due[0]
  const base = {
    issueSequence: original.sequence,
    issueSha256: original.sha256,
    horizonHours: target.horizonHours,
    targetAtUtc: target.targetAtUtc,
    deadlineAtUtc: target.deadlineAtUtc,
    holder: original.holder,
    holderKind: original.holderKind,
    qRaw: original.qRaw,
    payoutAssessment: 'pt_first_leg_simulation_only',
  }
  let block
  let cases
  try {
    block = await commonFinalized(clients, nowMs)
    fail(block.number > original.baseline.blockNumber, 'target_not_finalized')
    if (nowMs <= time(target.deadlineAtUtc)) {
      fail(block.timestamp * 1000 >= time(target.targetAtUtc), 'target_not_finalized')
      fail(block.timestamp * 1000 <= time(target.deadlineAtUtc), 'target_after_deadline')
      cases = []
      for (const q of original.qRaw) {
        try {
          const measurement = await assayPair(clients, block, original.holder, q)
          cases.push({
            qRaw: q,
            outcome: classifyPtCallOutcome(
              original.holderKind,
              measurement.amountCheck.simulation.status,
            ),
            measurement,
          })
        } catch {
          cases.push({ qRaw: q, outcome: 'unavailable', measurement: null })
        }
      }
      fail(
        cases.some((row) => row.measurement !== null),
        'all_cases_unavailable',
      )
    }
  } catch {
    append(
      'attempts',
      {
        phase: 'score',
        reason: 'source_unavailable',
        atUtc: asUtc(clock()),
        issueSequence: original.sequence,
        horizonHours: target.horizonHours,
      },
      root,
    )
    return { status: 'source_unavailable' }
  }
  const completedAtMs = clock()
  fail(Number.isFinite(completedAtMs) && completedAtMs >= nowMs, 'completion_clock')
  const scoredAtUtc = asUtc(completedAtMs)
  if (completedAtMs > time(target.deadlineAtUtc)) {
    // A local deadline overrun is only censored after both origins agree on a
    // finalized block whose chain timestamp is strictly past that deadline.
    if (block.timestamp * 1000 <= time(target.deadlineAtUtc)) {
      try {
        block = await commonFinalized(clients, clock())
      } catch {
        append(
          'attempts',
          {
            phase: 'score',
            reason: 'source_unavailable',
            atUtc: asUtc(clock()),
            issueSequence: original.sequence,
            horizonHours: target.horizonHours,
          },
          root,
        )
        return { status: 'source_unavailable' }
      }
    }
    if (block.timestamp * 1000 <= time(target.deadlineAtUtc)) {
      append(
        'attempts',
        {
          phase: 'score',
          reason: 'source_unavailable',
          atUtc: asUtc(clock()),
          issueSequence: original.sequence,
          horizonHours: target.horizonHours,
        },
        root,
      )
      return { status: 'source_unavailable' }
    }
    const saved = append(
      'scores',
      {
        ...base,
        scoredAtUtc: asUtc(clock()),
        status: 'missed_window',
        block,
        origins: ORIGINS,
        cases: null,
      },
      root,
    )
    verifyLedgers(root)
    return { status: 'missed_window', sequence: saved.sequence }
  }
  const saved = append(
    'scores',
    { ...base, scoredAtUtc, status: 'measured', block, origins: ORIGINS, cases },
    root,
  )
  verifyLedgers(root)
  return { status: 'measured', sequence: saved.sequence, caseCount: cases.length }
}

export function publicCounts(root = ROOT) {
  const { issues, scores, attempts } = verifyLedgers(root)
  return {
    routeKey: ROUTE,
    destination: VAULT,
    assay: 'same_holder_pt_withdraw_callability',
    issuedEpisodes: issues.length,
    noCodeHolderEpisodes: issues.length,
    uniqueHolders: new Set(issues.map((row) => row.holder)).size,
    episodesCorrelatedByHolder: true,
    measuredScores: scores.filter((row) => row.status === 'measured').length,
    noCodeHolderMeasuredScores: scores.filter((row) => row.status === 'measured').length,
    holderExecutableSuccessCases: 0,
    missedScores: scores.filter((row) => row.status === 'missed_window').length,
    pendingTargets: issues.length * HORIZONS.length - scores.length,
    attemptCount: attempts.length,
    finalPayoutAssessment: 'unmeasured',
    holderControlAssessment: 'unmeasured',
    calibratedForecast: false,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2]
  try {
    fail(process.argv.length === 3 && ['--issue', '--score', '--verify'].includes(mode), 'usage')
    if (mode === '--verify') process.stdout.write(`${JSON.stringify(publicCounts())}\n`)
    else {
      const clients = configuredUrls().map((url) => makeClient(url))
      const result = mode === '--issue' ? await issue({ clients }) : await score({ clients })
      process.stdout.write(`${JSON.stringify(result)}\n`)
    }
  } catch {
    process.stderr.write('pt_wrapper_holder_failed\n')
    process.exitCode = 1
  }
}
