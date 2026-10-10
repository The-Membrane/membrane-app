// Prospective, local-only first-leg USDC withdrawal callability for the frozen
// FluidBridge route. An eth_call is never a mined USDC payout or bridge receipt.
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
import { parseAbi, toEventSelector } from 'viem'
import * as directExitModule from '../../lib/carry/trackedDirectVaultExit.ts'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

const readTrackedDirectVaultExit =
  directExitModule.readTrackedDirectVaultExit ??
  directExitModule.default?.readTrackedDirectVaultExit
if (typeof readTrackedDirectVaultExit !== 'function')
  throw Error('fluid_bridge_holder_direct_exit_module_invalid')
export const STUDY = 'carry_fluid_bridge_usdc_holder_v1'
export const ROOT = resolve('data/research/venue-signals/carry-fluid-bridge-usdc-holder-v1')
export const ROUTE = 'USDC → FluidBridgeAggregatorProxy [USDC]'
export const VAULT = '0x273da948aca9261043fbdb2a857bc255ecc29012'
export const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
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
      HASH.test(blockHash ?? '') &&
      Number.isSafeInteger(blockNumber) &&
      row.request?.assetUnit === 'USDC',
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
    simulation: row.simulation,
  }
}

export async function assayPair(clients, block, holder, qRaw) {
  fail(ADDRESS.test(holder) && DECIMAL.test(qRaw) && BigInt(qRaw) > 0n, 'assay_request')
  const input = { routeKey: ROUTE, destinationAddress: VAULT, owner: holder, assetsRaw: qRaw }
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
      row.topics[1].startsWith(`0x${'0'.repeat(24)}`) &&
      row.topics[2].startsWith(`0x${'0'.repeat(24)}`) &&
      HASH.test(row.data) &&
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
    let secondaryNormalized = null
    if (secondary !== null) {
      fail(Array.isArray(secondary) && secondary.length < 1000, 'candidate_logs_unavailable')
      secondaryNormalized = secondary.map((log) => rawLog(log, from, to))
      fail(same(normalized, secondaryNormalized), 'candidate_origin_disagreement')
    }
    const unique = new Set()
    for (const log of normalized.reverse()) {
      const holder = `0x${log.topics[2].slice(-40)}`
      if (holder === ZERO || unique.has(holder)) continue
      unique.add(holder)
      if (unique.size > MAX_CANDIDATES) break
      let receiptWitness = null
      let receiptMatchedLog = null
      if (secondary === null) {
        const receipt = await clients[1].request({
          method: 'eth_getTransactionReceipt',
          params: [log.transactionHash],
        })
        fail(
          receipt?.transactionHash?.toLowerCase() === log.transactionHash &&
            receipt?.blockHash?.toLowerCase() === log.blockHash &&
            Array.isArray(receipt.logs) &&
            receipt.logs.length < 1000,
          'candidate_receipt_unavailable',
        )
        const matching = receipt.logs
          .filter(
            (row) =>
              String(row.address).toLowerCase() === VAULT &&
              String(row.topics?.[0]).toLowerCase() === TRANSFER_TOPIC,
          )
          .map((row) => rawLog(row, log.blockNumber, log.blockNumber))
        receiptMatchedLog = matching.find((row) => same(row, log))
        fail(receiptMatchedLog, 'candidate_receipt_disagreement')
        receiptWitness = {
          transactionHash: String(receipt.transactionHash).toLowerCase(),
          blockHash: String(receipt.blockHash).toLowerCase(),
        }
      }
      const pin = { blockHash: block.hash, requireCanonical: true }
      const [codes, shares, maxima] = await Promise.all([
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
        Promise.all(
          clients.map((client) =>
            client.readContract({
              address: VAULT,
              abi: SHARE_ABI,
              functionName: 'maxWithdraw',
              args: [holder],
              ...pin,
            }),
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
          range: { fromBlock: from, toBlock: to },
          primary: { origin: ORIGINS[0], method: 'eth_getLogs', log },
          secondary: {
            origin: ORIGINS[1],
            method: secondary === null ? 'eth_getTransactionReceipt' : 'eth_getLogs',
            log:
              secondary === null
                ? receiptMatchedLog
                : secondaryNormalized.find((row) => same(row, log)),
            receipt: receiptWitness,
          },
        },
      }
    }
  }
  fail(!quietUnverified, 'candidate_quiet_unverified')
  return null
}

export function qLadder(maxWithdrawRaw) {
  fail(DECIMAL.test(maxWithdrawRaw) && BigInt(maxWithdrawRaw) > 0n, 'ladder_base')
  const max = BigInt(maxWithdrawRaw)
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

function verifyCandidateProof(candidate, baselineBlockNumber) {
  const proof = candidate?.sourceProof
  const range = proof?.range
  fail(
    Number.isSafeInteger(range?.fromBlock) &&
      Number.isSafeInteger(range?.toBlock) &&
      range.fromBlock >= 0 &&
      range.toBlock - range.fromBlock === SCAN_BLOCKS - 1 &&
      range.toBlock <= baselineBlockNumber &&
      (baselineBlockNumber - range.toBlock) % SCAN_BLOCKS === 0 &&
      baselineBlockNumber - range.toBlock <= (SCAN_WINDOWS + 8 - 1) * SCAN_BLOCKS,
    'candidate_source_range',
  )
  const selected = proof.primary?.log
  const secondary = proof.secondary?.log
  fail(
    proof.primary?.origin === ORIGINS[0] &&
      proof.primary?.method === 'eth_getLogs' &&
      proof.secondary?.origin === ORIGINS[1] &&
      proof.secondary?.method ===
        (candidate.sourceAttestation === 'two_origin_log_query'
          ? 'eth_getLogs'
          : 'eth_getTransactionReceipt') &&
      same(selected, rawLog(selected, range.fromBlock, range.toBlock)) &&
      same(secondary, selected) &&
      selected.transactionHash === candidate.sourceTx &&
      selected.blockNumber === candidate.sourceBlock &&
      `0x${selected.topics[2].slice(-40)}` === candidate.holder &&
      (candidate.sourceAttestation === 'two_origin_log_query'
        ? proof.secondary.receipt === null
        : same(proof.secondary.receipt, {
            transactionHash: selected.transactionHash,
            blockHash: selected.blockHash,
          })),
    'candidate_source_proof',
  )
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
        HASH.test(issue.candidate.sourceTx ?? '') &&
        Number.isSafeInteger(issue.candidate.sourceBlock) &&
        issue.candidate.sourceBlock > 0 &&
        issue.candidate.sourceBlock <= issue.baseline.blockNumber &&
        DECIMAL.test(issue.candidate.sharesRaw ?? '') &&
        BigInt(issue.candidate.sharesRaw) > 0n &&
        ['two_origin_log_query', 'primary_log_secondary_receipt'].includes(
          issue.candidate.sourceAttestation,
        ) &&
        DECIMAL.test(issue.candidate.maxWithdrawRaw ?? '') &&
        BigInt(issue.candidate.maxWithdrawRaw) > 0n &&
        same(issue.qRaw, qLadder(issue.candidate.maxWithdrawRaw)) &&
        issue.baseline.cases.length === issue.qRaw.length &&
        issue.qRaw.every((q, i) => DECIMAL.test(q) && q === issue.baseline.cases[i].qRaw) &&
        issue.payoutAssessment === 'first_leg_simulation_only',
      'issue_invalid',
    )
    verifyCandidateProof(issue.candidate, issue.baseline.blockNumber)
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
        score.payoutAssessment === 'first_leg_simulation_only',
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
        time(attempt.atUtc) > 0,
      'attempt_invalid',
    )
  return { issues, scores, attempts }
}

export async function issue({
  clients,
  nowMs = Date.now(),
  clock = Date.now,
  scanOffset = 0,
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
    candidate = await discoverHolder(clients, block, scanOffset)
    if (!candidate) {
      append(
        'attempts',
        { phase: 'issue', reason: 'no_holder', atUtc: asUtc(clock()), block },
        root,
      )
      return { status: 'no_holder' }
    }
    qRaw = qLadder(candidate.maxWithdrawRaw)
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
      asset: USDC,
      holder: candidate.holder,
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
      payoutAssessment: 'first_leg_simulation_only',
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
    payoutAssessment: 'first_leg_simulation_only',
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
  return {
    routeKey: ROUTE,
    destination: VAULT,
    assay: 'same_holder_usdc_withdraw_callability',
    issuedEpisodes: issues.length,
    uniqueHolders: new Set(issues.map((row) => row.holder)).size,
    episodesCorrelatedByHolder: true,
    measuredScores: scores.filter((row) => row.status === 'measured').length,
    missedScores: scores.filter((row) => row.status === 'missed_window').length,
    pendingTargets: issues.length * HORIZONS.length - scores.length,
    attemptCount: attempts.length,
    finalPayoutAssessment: 'unmeasured',
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
    process.stderr.write('fluid_bridge_holder_failed\n')
    process.exitCode = 1
  }
}
