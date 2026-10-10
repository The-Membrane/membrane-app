// Prospective, local-only USDC first-leg callability for the frozen USDT
// FluidBridge route. An eth_call does not establish USDC delivery, conversion,
// or final USDT receipt.
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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseAbi, toEventSelector } from 'viem'
import * as directExitModule from '../../lib/carry/trackedDirectVaultExit.ts'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

const readTrackedDirectVaultExit =
  directExitModule.readTrackedDirectVaultExit ??
  directExitModule.default?.readTrackedDirectVaultExit
if (typeof readTrackedDirectVaultExit !== 'function')
  throw Error('fluid_bridge_holder_direct_exit_module_invalid')
export const STUDY = 'carry_fluid_bridge_usdt_holder_v1'
export const ROOT = resolve('data/research/venue-signals/carry-fluid-bridge-usdt-holder-v1')
export const ROUTE = 'USDT → FluidBridgeAggregatorProxy [USDC]'
export const VAULT = '0x273da948aca9261043fbdb2a857bc255ecc29012'
export const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
export const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
export const ROUTE_LEG = Object.freeze({
  checked: 'same_holder_usdc_vault_withdrawal_simulation',
  usdcToUsdtConversion: 'unassessed',
  usdtReceipt: 'unassessed',
})
export const HORIZONS = Object.freeze([1, 4, 24, 48, 168])
export const ORIGINS = Object.freeze(['https://rpc.ankr.com', 'https://eth-mainnet.g.alchemy.com'])
const DEADLINE_HOURS = 2
const SCAN_BLOCKS = 64
const SCAN_WINDOWS = 16
const SECONDARY_CHUNK_BLOCKS = 8
const MAX_DISCOVERY_RPC_CALLS = 256
const MAX_CANDIDATES = 12
const MAX_SEED_CANDIDATES = 15
const MAX_SEED_RPC_CALLS = 90
const SEED_TIMEOUT_MS = 120_000
const SEED_PATH = fileURLToPath(
  new URL('../route-cohort/aug-2026-ab-vault-seed.json', import.meta.url),
)
const SEED_SHA256 = 'c3e85a98ff3b634c8e6c4bdd4cc64e94f3bdcc417c071125cd40cdff09a21243'
const SEED_RELATIVE_PATH = 'scripts/route-cohort/aug-2026-ab-vault-seed.json'
const MAX_BYTES = 512 * 1024
const RESERVE = 1024 ** 3
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const SHA = /^[0-9a-f]{64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const ZERO = '0x0000000000000000000000000000000000000000'
const ISSUE_FAILURE_STAGES = Object.freeze([
  'common_finalized',
  'holder_discovery',
  'holder_primary_logs',
  'holder_secondary_logs',
  'holder_secondary_receipt',
  'holder_log_disagreement',
  'holder_pinned_state',
  'frozen_seed_read',
  'frozen_seed_pinned_state',
  'withdraw_assay',
  'completion_finality',
  'completion_slot',
])
const TRANSFER_TOPIC = toEventSelector(
  parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)'])[0],
).toLowerCase()
const SHARE_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
])
const sha = (value) => createHash('sha256').update(value).digest('hex')
const fail = (ok, code) => {
  if (!ok) throw Error(`fluid_bridge_holder_${code}`)
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

function disk(path, bytes) {
  const stats = statfsSync(path)
  fail(Number(stats.bavail) * Number(stats.bsize) - bytes >= RESERVE, 'disk_reserve')
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
  disk(path, Buffer.byteLength(serialized))
  const stage = join(path, `.fluid-bridge-${randomUUID()}.tmp`)
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

function pinnedClient(client, block) {
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
    getCode: (args) => client.getCode(args),
    request: (args) => client.request(args),
    readContract: (args) => client.readContract(args),
    call: (args) => client.call(args),
  }
}

export function projection(row) {
  const blockHash = row?.source?.blockHash ?? row?.blockHash
  const blockNumber = row?.source?.blockNumber ?? row?.blockNumber
  fail(
    row?.routeKey === ROUTE &&
      row.vault?.address === VAULT &&
      row.vault?.assetAddress === USDC &&
      row.vault?.assetDecimals === 6 &&
      row.vault?.implementationSourceAttested === false &&
      row.vault?.kind === 'fluid_bridge_usdc_first_leg' &&
      HASH.test(blockHash ?? '') &&
      Number.isSafeInteger(blockNumber) &&
      row.request?.assetUnit === 'USDC' &&
      same(row.routeLeg, ROUTE_LEG),
    'assay_identity',
  )
  return {
    blockNumber,
    blockHash,
    assayOwner: row.assayOwner,
    routeKey: row.routeKey,
    vault: row.vault,
    position: row.position,
    request: row.request,
    routeLeg: row.routeLeg,
    simulation: row.simulation,
  }
}

export async function assayPair(clients, block, holder, qRaw) {
  fail(ADDRESS.test(holder) && DECIMAL.test(qRaw) && BigInt(qRaw) > 0n, 'assay_request')
  const input = {
    routeKey: ROUTE,
    destinationAddress: VAULT,
    owner: holder,
    assetsRaw: qRaw,
    assetUnit: 'USDC',
  }
  const measured = await Promise.all(
    clients.map((client) => readTrackedDirectVaultExit(pinnedClient(client, block), input)),
  )
  const left = projection(measured[0])
  const right = projection(measured[1])
  fail(
    same(left, right) && left.blockHash === block.hash && left.blockNumber === block.number,
    'assay_origin_disagreement',
  )
  return { ...left, assayOwner: holder }
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
      row.topics[1].slice(2, 26) === '0'.repeat(24) &&
      row.topics[2].slice(2, 26) === '0'.repeat(24) &&
      HASH.test(row.data),
    'candidate_log_invalid',
  )
  return row
}

export async function discoverHolder(clients, block, scanOffset = 0, reportStage = () => {}) {
  fail(Number.isSafeInteger(scanOffset) && scanOffset >= 0 && scanOffset <= 8, 'scan_offset')
  let quietUnverified = false
  let rpcCalls = 0
  const counted = (read) => {
    fail(++rpcCalls <= MAX_DISCOVERY_RPC_CALLS, 'discovery_call_budget')
    return read()
  }
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
    reportStage('holder_primary_logs')
    const primary = await counted(() =>
      clients[0].request({ method: 'eth_getLogs', params: [filter] }),
    )
    fail(Array.isArray(primary) && primary.length < 1000, 'candidate_logs_unavailable')
    const normalized = primary.map((log) => rawLog(log, from, to))
    let secondary = null
    let secondaryNormalized = null
    reportStage('holder_secondary_logs')
    try {
      secondary = await counted(() =>
        clients[1].request({ method: 'eth_getLogs', params: [filter] }),
      )
      fail(Array.isArray(secondary) && secondary.length < 1000, 'candidate_logs_unavailable')
    } catch {
      // Some origins reject a 64-block historical range. Retry exactly that
      // range in eight contiguous chunks; a partial union is never proof.
      try {
        secondary = []
        for (let start = from; start <= to; start += SECONDARY_CHUNK_BLOCKS) {
          const end = Math.min(to, start + SECONDARY_CHUNK_BLOCKS - 1)
          const chunkFilter = {
            ...filter,
            fromBlock: `0x${start.toString(16)}`,
            toBlock: `0x${end.toString(16)}`,
          }
          const chunk = await counted(() =>
            clients[1].request({ method: 'eth_getLogs', params: [chunkFilter] }),
          )
          fail(Array.isArray(chunk) && chunk.length < 1000, 'candidate_logs_unavailable')
          secondary.push(...chunk.map((log) => rawLog(log, start, end)))
          fail(secondary.length < 1000, 'candidate_logs_unavailable')
        }
      } catch {
        secondary = null
        quietUnverified = true
      }
    }
    if (secondary !== null) {
      secondaryNormalized = secondary.map((log) => rawLog(log, from, to))
      reportStage('holder_log_disagreement')
      fail(same(normalized, secondaryNormalized), 'candidate_origin_disagreement')
    }
    const unique = new Set()
    for (const log of normalized.reverse()) {
      const holder = `0x${log.topics[2].slice(-40)}`
      if (holder === ZERO || unique.has(holder)) continue
      unique.add(holder)
      if (unique.size > MAX_CANDIDATES) break
      let secondaryEvidence
      if (secondary === null) {
        reportStage('holder_secondary_receipt')
        const receipt = await counted(() =>
          clients[1].request({
            method: 'eth_getTransactionReceipt',
            params: [log.transactionHash],
          }),
        )
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
        const matchedLog = matching.find((row) => same(row, log))
        reportStage('holder_log_disagreement')
        fail(Boolean(matchedLog), 'candidate_receipt_disagreement')
        secondaryEvidence = {
          kind: 'receipt_log',
          transactionHash: receipt.transactionHash.toLowerCase(),
          blockHash: receipt.blockHash.toLowerCase(),
          log: matchedLog,
        }
      } else {
        reportStage('holder_log_disagreement')
        const matchedLog = secondaryNormalized.find((row) => same(row, log))
        fail(Boolean(matchedLog), 'candidate_origin_disagreement')
        secondaryEvidence = { kind: 'range_log', log: matchedLog }
      }
      const pin = { blockHash: block.hash, requireCanonical: true }
      reportStage('holder_pinned_state')
      const [codes, shares, maxima] = await Promise.all([
        Promise.all(
          clients.map((client) => counted(() => client.getCode({ address: holder, ...pin }))),
        ),
        Promise.all(
          clients.map((client) =>
            counted(() =>
              client.readContract({
                address: VAULT,
                abi: SHARE_ABI,
                functionName: 'balanceOf',
                args: [holder],
                ...pin,
              }),
            ),
          ),
        ),
        Promise.all(
          clients.map((client) =>
            counted(() =>
              client.readContract({
                address: VAULT,
                abi: SHARE_ABI,
                functionName: 'maxWithdraw',
                args: [holder],
                ...pin,
              }),
            ),
          ),
        ),
      ])
      fail(
        same(codes[0], codes[1]) && shares[0] === shares[1] && maxima[0] === maxima[1],
        'candidate_state_disagreement',
      )
      if ((codes[0] !== undefined && codes[0] !== '0x') || shares[0] <= 0n || maxima[0] <= 0n)
        continue
      return {
        holder,
        sharesRaw: shares[0].toString(),
        maxWithdrawRaw: maxima[0].toString(),
        sourceTx: log.transactionHash,
        sourceBlock: log.blockNumber,
        sourceAttestation:
          secondary === null ? 'primary_log_secondary_receipt' : 'two_origin_log_query',
        sourceProof: {
          scanRange: { fromBlock: from, toBlock: to },
          primaryLog: log,
          secondaryEvidence,
        },
      }
    }
  }
  if (quietUnverified) reportStage('holder_secondary_logs')
  fail(!quietUnverified, 'candidate_quiet_unverified')
  return null
}

export function readFrozenSeedCandidates(path = SEED_PATH) {
  const bytes = readFileSync(path)
  fail(bytes.length <= 256 * 1024 && sha(bytes) === SEED_SHA256, 'seed_integrity')
  const seed = JSON.parse(bytes.toString('utf8'))
  fail(
    seed.schemaVersion === 1 &&
      seed.cohortId === 'aug-2026-ab-vault-routes' &&
      Array.isArray(seed.positions),
    'seed_schema',
  )
  const owners = seed.positions
    .filter(
      (row) => row.vault === VAULT && Array.isArray(row.routeIds) && row.routeIds.includes(ROUTE),
    )
    .map((row) => row.owner)
  fail(
    owners.length === MAX_SEED_CANDIDATES &&
      new Set(owners).size === MAX_SEED_CANDIDATES &&
      owners.every((owner) => ADDRESS.test(owner)),
    'seed_membership',
  )
  return { sha256: SEED_SHA256, owners }
}

export async function discoverFrozenSeedHolder(
  clients,
  block,
  now = Date.now,
  reportStage = () => {},
  startIndex = 0,
) {
  fail(clients.length === 2 && new Set(ORIGINS).size === 2, 'seed_origins')
  fail(
    Number.isSafeInteger(startIndex) && startIndex >= 0 && startIndex < MAX_SEED_CANDIDATES,
    'seed_start',
  )
  reportStage('frozen_seed_read')
  const seed = readFrozenSeedCandidates()
  reportStage('frozen_seed_pinned_state')
  const startedAtMs = now()
  fail(Number.isFinite(startedAtMs), 'seed_clock')
  let calls = 0
  const counted = (read) => {
    fail(now() - startedAtMs <= SEED_TIMEOUT_MS, 'seed_timeout')
    fail(++calls <= MAX_SEED_RPC_CALLS, 'seed_call_budget')
    return read()
  }
  const timed = async (read) => {
    const remaining = SEED_TIMEOUT_MS - (now() - startedAtMs)
    fail(remaining > 0, 'seed_timeout')
    let timer
    try {
      return await Promise.race([
        read(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('fluid_bridge_holder_seed_timeout')), remaining)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  const pin = { blockHash: block.hash, requireCanonical: true }
  for (let screened = 0; screened < seed.owners.length; screened++) {
    const seedSelectionIndex = (startIndex + screened) % seed.owners.length
    const owner = seed.owners[seedSelectionIndex]
    const readings = await timed(() =>
      Promise.all(
        clients.map(async (client, index) => {
          const [code, shares, maximum] = await Promise.all([
            counted(() => client.request({ method: 'eth_getCode', params: [owner, pin] })),
            counted(() =>
              client.readContract({
                address: VAULT,
                abi: SHARE_ABI,
                functionName: 'balanceOf',
                args: [owner],
                ...pin,
              }),
            ),
            counted(() =>
              client.readContract({
                address: VAULT,
                abi: SHARE_ABI,
                functionName: 'maxWithdraw',
                args: [owner],
                ...pin,
              }),
            ),
          ])
          fail(
            typeof code === 'string' &&
              /^0x[0-9a-f]*$/i.test(code) &&
              typeof shares === 'bigint' &&
              shares >= 0n &&
              typeof maximum === 'bigint' &&
              maximum >= 0n,
            'seed_state_invalid',
          )
          return {
            origin: ORIGINS[index],
            code: code.toLowerCase(),
            sharesRaw: shares.toString(),
            maxWithdrawRaw: maximum.toString(),
          }
        }),
      ),
    )
    fail(now() - startedAtMs <= SEED_TIMEOUT_MS, 'seed_timeout')
    fail(
      readings[0].code === readings[1].code &&
        readings[0].sharesRaw === readings[1].sharesRaw &&
        readings[0].maxWithdrawRaw === readings[1].maxWithdrawRaw,
      'seed_origin_disagreement',
    )
    if (
      readings[0].code !== '0x' ||
      BigInt(readings[0].sharesRaw) === 0n ||
      BigInt(readings[0].maxWithdrawRaw) === 0n
    )
      continue
    return {
      holder: owner,
      sharesRaw: readings[0].sharesRaw,
      maxWithdrawRaw: readings[0].maxWithdrawRaw,
      sourceAttestation: 'frozen_route_borrower_seed',
      sourceProof: {
        seedPath: SEED_RELATIVE_PATH,
        seedSha256: seed.sha256,
        routeKey: ROUTE,
        vault: VAULT,
        owner,
        blockNumber: block.number,
        blockHash: block.hash,
        candidateScope: 'historical_route_borrower_not_signer',
        seedStartIndex: startIndex,
        seedSelectionIndex,
        screenedCandidates: screened + 1,
        readings,
      },
    }
  }
  return null
}

export function qLadder(maxWithdrawRaw) {
  fail(DECIMAL.test(maxWithdrawRaw) && BigInt(maxWithdrawRaw) > 0n, 'ladder_base')
  const max = BigInt(maxWithdrawRaw)
  const values = [1n, 10n, 25n, 50n, 100n].map((pct) => (max * pct) / 100n).filter((q) => q > 0n)
  return [...new Set(values.map(String))]
}

export function verifyCandidateProof(candidate, baseline, issueSlot) {
  const { sourceProof: proof } = candidate ?? {}
  if (candidate?.sourceAttestation === 'frozen_route_borrower_seed') {
    const seed = readFrozenSeedCandidates()
    fail(
      !('sourceTx' in candidate) &&
        !('sourceBlock' in candidate) &&
        !('scanRange' in (proof ?? {})) &&
        !('primaryLog' in (proof ?? {})) &&
        !('secondaryEvidence' in (proof ?? {})) &&
        proof?.seedPath === SEED_RELATIVE_PATH &&
        proof.seedSha256 === seed.sha256 &&
        proof.routeKey === ROUTE &&
        proof.vault === VAULT &&
        proof.owner === candidate.holder &&
        seed.owners.includes(candidate.holder) &&
        Number.isSafeInteger(issueSlot) &&
        proof.seedStartIndex === issueSlot % MAX_SEED_CANDIDATES &&
        Number.isSafeInteger(proof.screenedCandidates) &&
        proof.screenedCandidates >= 1 &&
        proof.screenedCandidates <= MAX_SEED_CANDIDATES &&
        proof.seedSelectionIndex ===
          (proof.seedStartIndex + proof.screenedCandidates - 1) % MAX_SEED_CANDIDATES &&
        seed.owners[proof.seedSelectionIndex] === candidate.holder &&
        proof.candidateScope === 'historical_route_borrower_not_signer' &&
        proof.blockNumber === baseline?.blockNumber &&
        proof.blockHash === baseline?.blockHash &&
        Array.isArray(proof.readings) &&
        proof.readings.length === 2 &&
        proof.readings.every(
          (row, index) =>
            row.origin === ORIGINS[index] &&
            row.code === '0x' &&
            row.sharesRaw === candidate.sharesRaw &&
            row.maxWithdrawRaw === candidate.maxWithdrawRaw,
        ) &&
        baseline?.cases?.length > 0 &&
        baseline.cases.every(
          ({ measurement }) =>
            measurement.assayOwner === candidate.holder &&
            measurement.position?.holderSharesRaw === candidate.sharesRaw &&
            measurement.position?.maxWithdrawAssetsRaw === candidate.maxWithdrawRaw,
        ),
      'candidate_seed_proof',
    )
    return true
  }
  const range = proof?.scanRange
  fail(
    Number.isSafeInteger(range?.fromBlock) &&
      Number.isSafeInteger(range?.toBlock) &&
      range.fromBlock >= 0 &&
      range.toBlock - range.fromBlock === SCAN_BLOCKS - 1 &&
      proof.primaryLog &&
      proof.secondaryEvidence?.log,
    'candidate_proof_range',
  )
  const primary = rawLog(proof.primaryLog, range.fromBlock, range.toBlock)
  const second = rawLog(proof.secondaryEvidence?.log, range.fromBlock, range.toBlock)
  fail(
    same(primary, second) &&
      primary.transactionHash === candidate.sourceTx &&
      primary.blockNumber === candidate.sourceBlock &&
      `0x${primary.topics[2].slice(-40)}` === candidate.holder &&
      primary.topics[2] !== `0x${'0'.repeat(64)}`,
    'candidate_proof_binding',
  )
  if (candidate.sourceAttestation === 'two_origin_log_query')
    fail(proof.secondaryEvidence.kind === 'range_log', 'candidate_proof_kind')
  else
    fail(
      candidate.sourceAttestation === 'primary_log_secondary_receipt' &&
        proof.secondaryEvidence.kind === 'receipt_log' &&
        proof.secondaryEvidence.transactionHash === primary.transactionHash &&
        proof.secondaryEvidence.blockHash === primary.blockHash,
      'candidate_proof_kind',
    )
  return true
}

function targets(issuedAtUtc) {
  return HORIZONS.map((horizonHours) => ({
    horizonHours,
    targetAtUtc: asUtc(time(issuedAtUtc) + horizonHours * 3_600_000),
    deadlineAtUtc: asUtc(time(issuedAtUtc) + (horizonHours + DEADLINE_HOURS) * 3_600_000),
  }))
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
        issue.asset === USDC &&
        issue.finalAsset === USDT &&
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
        (issue.candidateSource === 'frozen_seed') ===
          (issue.candidate.sourceAttestation === 'frozen_route_borrower_seed') &&
        DECIMAL.test(issue.candidate.sharesRaw ?? '') &&
        BigInt(issue.candidate.sharesRaw) > 0n &&
        [
          'two_origin_log_query',
          'primary_log_secondary_receipt',
          'frozen_route_borrower_seed',
        ].includes(issue.candidate.sourceAttestation) &&
        DECIMAL.test(issue.candidate.maxWithdrawRaw ?? '') &&
        BigInt(issue.candidate.maxWithdrawRaw) > 0n &&
        same(issue.qRaw, qLadder(issue.candidate.maxWithdrawRaw)) &&
        issue.baseline.cases.length === issue.qRaw.length &&
        issue.qRaw.every((q, i) => DECIMAL.test(q) && q === issue.baseline.cases[i].qRaw) &&
        issue.payoutAssessment === 'usdc_first_leg_only_usdt_unassessed',
      'issue_invalid',
    )
    verifyCandidateProof(issue.candidate, issue.baseline, issue.slot)
    if (issue.candidate.sourceAttestation !== 'frozen_route_borrower_seed') {
      fail(
        HASH.test(issue.candidate.sourceTx ?? '') &&
          Number.isSafeInteger(issue.candidate.sourceBlock) &&
          issue.candidate.sourceBlock > 0 &&
          issue.candidate.sourceBlock <= issue.baseline.blockNumber,
        'candidate_transfer_source',
      )
      const scanDistance =
        issue.baseline.blockNumber - issue.candidate.sourceProof.scanRange.toBlock
      fail(
        scanDistance >= 0 &&
          scanDistance % SCAN_BLOCKS === 0 &&
          scanDistance <= (8 + SCAN_WINDOWS - 1) * SCAN_BLOCKS,
        'candidate_proof_scan_window',
      )
    }
    slots.add(issue.slot)
    for (const entry of issue.baseline.cases) {
      const measured = projection(entry.measurement)
      fail(
        measured.blockHash === issue.baseline.blockHash &&
          measured.blockNumber === issue.baseline.blockNumber &&
          measured.assayOwner === issue.holder &&
          measured.request.assetsRaw === entry.qRaw &&
          DECIMAL.test(measured.position.holderSharesRaw) &&
          DECIMAL.test(measured.position.maxWithdrawAssetsRaw) &&
          ['success', 'evm_revert', 'position_insufficient'].includes(measured.simulation.status),
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
        same(score.qRaw, issue.qRaw) &&
        time(score.scoredAtUtc) >= time(target.targetAtUtc) &&
        score.payoutAssessment === 'usdc_first_leg_only_usdt_unassessed',
      'score_binding',
    )
    scored.add(key)
    if (score.status === 'missed_window')
      fail(
        time(score.scoredAtUtc) > time(target.deadlineAtUtc) &&
          score.cases === null &&
          score.block?.timestamp * 1000 > time(target.deadlineAtUtc) &&
          score.block.timestamp * 1000 <= time(score.scoredAtUtc) &&
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
          score.block.timestamp * 1000 <= time(score.scoredAtUtc) &&
          score.block?.number > issue.baseline.blockNumber &&
          same(score.origins, ORIGINS) &&
          score.cases.length === issue.qRaw.length &&
          score.cases.every(
            (row, i) =>
              row.qRaw === issue.qRaw[i] &&
              ['simulated_success', 'simulated_revert', 'holder_absent', 'unavailable'].includes(
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
            measured.request.assetsRaw === row.qRaw &&
            row.outcome ===
              (measured.simulation.status === 'success' ? 'simulated_success' : 'simulated_revert'),
          'score_case_invalid',
        )
      }
    }
  }
  for (const attempt of attempts)
    fail(
      ['no_holder', 'source_unavailable', 'assay_unavailable'].includes(attempt.reason) &&
        ['issue', 'score'].includes(attempt.phase) &&
        time(attempt.atUtc) > 0 &&
        (attempt.candidateSource === undefined ||
          (attempt.phase === 'issue' && attempt.candidateSource === 'frozen_seed')) &&
        (attempt.failureStage === undefined ||
          (attempt.phase === 'issue' &&
            attempt.reason === 'source_unavailable' &&
            ISSUE_FAILURE_STAGES.includes(attempt.failureStage))),
      'attempt_invalid',
    )
  return { issues, scores, attempts }
}

export async function issue({
  clients,
  nowMs = Date.now(),
  clock = Date.now,
  scanOffset = 0,
  candidateSource = 'transfer',
  root = ROOT,
} = {}) {
  fail(
    ['transfer', 'frozen_seed'].includes(candidateSource) &&
      (candidateSource === 'transfer' || scanOffset === 0),
    'candidate_source',
  )
  const { issues } = verifyLedgers(root)
  const slot = Math.floor(nowMs / (30 * 60_000))
  if (issues.some((row) => row.slot === slot)) return { status: 'already_issued' }
  let block
  let candidate
  let qRaw
  let cases
  let failureStage = 'common_finalized'
  try {
    block = await commonFinalized(clients, nowMs)
    failureStage = 'holder_discovery'
    candidate =
      candidateSource === 'frozen_seed'
        ? await discoverFrozenSeedHolder(
            clients,
            block,
            Date.now,
            (stage) => {
              failureStage = stage
            },
            slot % MAX_SEED_CANDIDATES,
          )
        : await discoverHolder(clients, block, scanOffset, (stage) => {
            failureStage = stage
          })
    if (!candidate) {
      append(
        'attempts',
        {
          phase: 'issue',
          reason: 'no_holder',
          atUtc: asUtc(clock()),
          block,
          ...(candidateSource === 'frozen_seed' ? { candidateSource } : {}),
        },
        root,
      )
      return {
        status: 'no_holder',
        ...(candidateSource === 'frozen_seed' ? { candidateSource } : {}),
      }
    }
    failureStage = 'withdraw_assay'
    qRaw = qLadder(candidate.maxWithdrawRaw)
    cases = []
    for (const q of qRaw)
      cases.push({ qRaw: q, measurement: await assayPair(clients, block, candidate.holder, q) })
  } catch {
    append(
      'attempts',
      {
        phase: 'issue',
        reason: 'source_unavailable',
        failureStage,
        atUtc: asUtc(clock()),
        ...(candidateSource === 'frozen_seed' ? { candidateSource } : {}),
      },
      root,
    )
    return {
      status: 'source_unavailable',
      failureStage,
      ...(candidateSource === 'frozen_seed' ? { candidateSource } : {}),
    }
  }
  const completedAtMs = clock()
  fail(Number.isFinite(completedAtMs) && completedAtMs >= nowMs, 'completion_clock')
  if (completedAtMs - block.timestamp * 1000 > 7_200_000) {
    append(
      'attempts',
      {
        phase: 'issue',
        reason: 'source_unavailable',
        failureStage: 'completion_finality',
        atUtc: asUtc(completedAtMs),
        ...(candidateSource === 'frozen_seed' ? { candidateSource } : {}),
      },
      root,
    )
    return {
      status: 'source_unavailable',
      failureStage: 'completion_finality',
      ...(candidateSource === 'frozen_seed' ? { candidateSource } : {}),
    }
  }
  const issuedAtUtc = asUtc(completedAtMs)
  const completedSlot = Math.floor(completedAtMs / (30 * 60_000))
  if (candidateSource === 'frozen_seed' && completedSlot !== slot) {
    append(
      'attempts',
      {
        phase: 'issue',
        reason: 'source_unavailable',
        failureStage: 'completion_slot',
        atUtc: issuedAtUtc,
        candidateSource,
      },
      root,
    )
    return { status: 'source_unavailable', failureStage: 'completion_slot', candidateSource }
  }
  if (issues.some((row) => row.slot === completedSlot)) return { status: 'already_issued' }
  const saved = append(
    'issues',
    {
      slot: completedSlot,
      issuedAtUtc,
      routeKey: ROUTE,
      destination: VAULT,
      asset: USDC,
      finalAsset: USDT,
      holder: candidate.holder,
      candidate,
      ...(candidateSource === 'frozen_seed' ? { candidateSource } : {}),
      qRaw,
      origins: ORIGINS,
      baseline: {
        blockNumber: block.number,
        blockHash: block.hash,
        blockTimestamp: block.timestamp,
        cases,
      },
      targets: targets(issuedAtUtc),
      payoutAssessment: 'usdc_first_leg_only_usdt_unassessed',
    },
    root,
  )
  verifyLedgers(root)
  return {
    status: 'issued',
    sequence: saved.sequence,
    caseCount: qRaw.length,
    ...(candidateSource === 'frozen_seed' ? { candidateSource } : {}),
  }
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
  due.sort((a, b) => {
    const aOpen = nowMs <= time(a.target.deadlineAtUtc)
    const bOpen = nowMs <= time(b.target.deadlineAtUtc)
    return (
      Number(bOpen) - Number(aOpen) ||
      time(a.target.deadlineAtUtc) - time(b.target.deadlineAtUtc) ||
      a.issue.sequence - b.issue.sequence ||
      a.target.horizonHours - b.target.horizonHours
    )
  })
  if (!due.length) return { status: 'nothing_due' }
  const { issue: original, target } = due[0]
  const base = {
    issueSequence: original.sequence,
    issueSha256: original.sha256,
    horizonHours: target.horizonHours,
    targetAtUtc: target.targetAtUtc,
    deadlineAtUtc: target.deadlineAtUtc,
    holder: original.holder,
    qRaw: original.qRaw,
    payoutAssessment: 'usdc_first_leg_only_usdt_unassessed',
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
            outcome:
              measurement.simulation.status === 'success'
                ? 'simulated_success'
                : 'simulated_revert',
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
  const seedIssues = issues.filter((row) => row.candidateSource === 'frozen_seed').length
  return {
    routeKey: ROUTE,
    destination: VAULT,
    assay: 'same_holder_usdc_first_leg_withdraw_callability',
    assayAsset: 'USDC',
    finalPayoutAsset: 'USDT',
    issuedEpisodes: issues.length,
    uniqueHolders: new Set(issues.map((row) => row.holder)).size,
    episodesCorrelatedByHolder: true,
    candidateEvidenceScope:
      seedIssues === 0
        ? 'selected_transfer_only'
        : seedIssues === issues.length
          ? 'frozen_route_borrower_seed_only'
          : 'mixed_transfer_and_frozen_route_borrower_seed',
    firstLegSharedWithRoute: 'USDC → FluidBridgeAggregatorProxy [USDC]',
    measuredScores: scores.filter((row) => row.status === 'measured').length,
    missedScores: scores.filter((row) => row.status === 'missed_window').length,
    pendingTargets: issues.length * HORIZONS.length - scores.length,
    attemptCount: attempts.length,
    conversionAssessment: 'unmeasured',
    finalPayoutAssessment: 'unmeasured',
    calibratedForecast: false,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2]
  try {
    const frozenSeedMode =
      mode === '--issue' &&
      process.argv.length === 5 &&
      process.argv[3] === '--candidate-source' &&
      process.argv[4] === 'frozen-seed'
    fail(
      (process.argv.length === 3 && ['--issue', '--score', '--verify'].includes(mode)) ||
        frozenSeedMode,
      'usage',
    )
    if (mode === '--verify') process.stdout.write(`${JSON.stringify(publicCounts())}\n`)
    else {
      const clients = configuredUrls().map((url) => makeClient(url))
      const result =
        mode === '--issue'
          ? await issue({ clients, candidateSource: frozenSeedMode ? 'frozen_seed' : 'transfer' })
          : await score({ clients })
      process.stdout.write(`${JSON.stringify(result)}\n`)
    }
  } catch {
    process.stderr.write('fluid_bridge_holder_failed\n')
    process.exitCode = 1
  }
}
