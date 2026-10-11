// Incremental owner/Silo Withdraw-log evidence for one verified sUSDe pending
// issue and mined delivery. Complete coverage does NOT establish same episode.
import { statfs } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import { OUT as ISSUE_OUT, verifyIssues } from './susde-public-pending-exit-issue.mjs'
import { OUT as DELIVERY_OUT, verifyDeliveries } from './susde-public-mined-delivery.mjs'
import {
  ADDRESS,
  DECIMAL,
  HASH,
  SILO,
  VAULT,
  WITHDRAW_TOPIC,
  appendLedger,
  numberHex,
  readLedger,
  seal,
  utc,
} from './susde-public-pending-exit-common.mjs'

export const STUDY = 'susde_public_pending_continuity_archive_v1'
export const OUT = resolve('data/research/venue-signals/susde-public-pending-continuity-issue-3')
export const ISSUE_SEQUENCE = 3
const outputForIssue = (issueSequence) =>
  issueSequence === ISSUE_SEQUENCE
    ? OUT
    : resolve(`data/research/venue-signals/susde-public-pending-continuity-issue-${issueSequence}`)
// Issues 3 and 6 have immutable ten-block archives. Later issues use the
// larger holder-filtered range accepted by independent Ankr and Infura reads.
const LEGACY_WINDOW_BLOCKS = 10n
const WINDOW_BLOCKS = 1000n
export const continuityWindowBlocks = (issueSequence) =>
  issueSequence === 3 || issueSequence === 6 ? LEGACY_WINDOW_BLOCKS : WINDOW_BLOCKS
const MIN_TICK_FREE_BYTES = 1024n * 1024n * 1024n
const diskFreeBytes = async (directory) => {
  let disk
  try {
    disk = await statfs(directory, { bigint: true })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    disk = await statfs(dirname(directory), { bigint: true })
  }
  return disk.bavail * disk.bsize
}
export const MAX_WINDOWS_PER_TICK = 8 // 6 calls/window + <=8 preflight <60
const MAX_CALLS = 60
const MAX_MS = 180_000
const MAX_RECORD_BYTES = 32 * 1024
const MAX_LOGS = 128
const MAX_LOG_BYTES = 64 * 1024
const topic = (address) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const hex = (value) => {
  if (!/^0x[0-9a-f]+$/i.test(value ?? '')) throw Error('susde_continuity_hex_invalid')
  return BigInt(value)
}
const host = (provider) => {
  try {
    const value = new URL(provider).hostname
      .toLowerCase()
      .replace(/\.$/, '')
      .replace(/^www\./, '')
    if (!value) throw Error('invalid')
    return value
  } catch {
    throw Error('susde_continuity_provider_invalid')
  }
}
const header = (value) => {
  if (
    !HASH.test(value?.hash ?? '') ||
    !HASH.test(value?.parentHash ?? '') ||
    !/^0x[0-9a-f]+$/i.test(value?.number ?? '') ||
    !/^0x[0-9a-f]+$/i.test(value?.timestamp ?? '')
  )
    throw Error('susde_continuity_header_invalid')
  return {
    number: value.number,
    hash: value.hash,
    parentHash: value.parentHash,
    timestamp: value.timestamp,
  }
}
const compactLog = (value) => {
  if (
    !ADDRESS.test(value?.address ?? '') ||
    !Array.isArray(value?.topics) ||
    value.topics.length !== 4 ||
    !value.topics.every((x) => HASH.test(x)) ||
    !/^0x[0-9a-f]{128}$/i.test(value?.data ?? '') ||
    !HASH.test(value?.blockHash ?? '') ||
    !HASH.test(value?.transactionHash ?? '')
  )
    throw Error('susde_continuity_log_invalid')
  return {
    address: value.address.toLowerCase(),
    topics: value.topics.map((x) => x.toLowerCase()),
    data: value.data.toLowerCase(),
    blockNumber: value.blockNumber,
    blockHash: value.blockHash,
    transactionHash: value.transactionHash,
    transactionIndex: value.transactionIndex,
    logIndex: value.logIndex,
    removed: value.removed ?? false,
  }
}
const filter = (fromBlock, toBlock, holder) => ({
  address: VAULT,
  topics: [WITHDRAW_TOPIC, null, topic(SILO), topic(holder)],
  fromBlock: numberHex(fromBlock),
  toBlock: numberHex(toBlock),
})
const queriesFor = (range, holder) => ({
  startHeader: { method: 'eth_getBlockByNumber', params: [numberHex(range.from), false] },
  endHeader: { method: 'eth_getBlockByNumber', params: [numberHex(range.to), false] },
  logs: { method: 'eth_getLogs', params: [filter(range.from, range.to, holder)] },
})
const target = async (issueOut, deliveryOut, issueSequence = ISSUE_SEQUENCE) => {
  const [issues, deliveries] = await Promise.all([
    verifyIssues(issueOut),
    verifyDeliveries(deliveryOut, issueOut),
  ])
  const issue = issues[issueSequence - 1]
  const delivery = deliveries.find((row) => row.issueSequence === issueSequence)
  if (
    !issue ||
    !delivery ||
    delivery.issueSha256 !== issue.sha256 ||
    delivery.episodeAttribution !== 'unresolved' ||
    !delivery.minedDeliveryProven
  )
    throw Error('susde_continuity_target_unavailable')
  return {
    issue,
    delivery,
    start: BigInt(issue.anchor.blockNumber) + 1n,
    end: hex(delivery.origins[0].block.number),
    anchorHash: issue.anchor.blockHash,
    deliveryHash: delivery.origins[0].block.hash,
    payoutTxIndex: hex(delivery.origins[0].receipt.transactionIndex),
  }
}
const expectedRange = (target, sequence) => {
  const span = continuityWindowBlocks(target.issue.sequence)
  const from = target.start + BigInt(sequence - 1) * span
  if (from > target.end) return null
  const to = from + span - 1n < target.end ? from + span - 1n : target.end
  return { from, to }
}
const verifyLogs = (logs, range, owner, startHeader, endHeader) => {
  if (
    !Array.isArray(logs) ||
    logs.length > MAX_LOGS ||
    Buffer.byteLength(JSON.stringify(logs)) > MAX_LOG_BYTES
  )
    throw Error('susde_continuity_logs_large')
  let previousBlock = range.from
  let previousLogIndex = -1n
  let previousTxIndex = -1n
  for (const log of logs) {
    if (
      !equal(compactLog(log), log) ||
      log.address !== VAULT ||
      !equal(log.topics, [WITHDRAW_TOPIC, log.topics[1], topic(SILO), topic(owner)]) ||
      log.removed !== false
    )
      throw Error('susde_continuity_log_invalid')
    const block = hex(log.blockNumber)
    const txIndex = hex(log.transactionIndex)
    const logIndex = hex(log.logIndex)
    if (
      block < range.from ||
      block > range.to ||
      (block === range.from && log.blockHash !== startHeader.hash) ||
      (block === range.to && log.blockHash !== endHeader.hash) ||
      block < previousBlock ||
      (block === previousBlock && logIndex <= previousLogIndex) ||
      (block === previousBlock && txIndex < previousTxIndex)
    )
      throw Error('susde_continuity_log_order_invalid')
    previousBlock = block
    previousLogIndex = logIndex
    previousTxIndex = txIndex
  }
}

const validateWindowRecord = (row, pinned) => {
  const range = expectedRange(pinned, row.sequence)
  if (
    !range ||
    row.study !== STUDY ||
    row.issueSequence !== pinned.issue.sequence ||
    row.issueSha256 !== pinned.issue.sha256 ||
    row.deliverySha256 !== pinned.delivery.sha256 ||
    row.deliveryTransactionHash !== pinned.delivery.transactionHash ||
    row.holder !== pinned.issue.holder ||
    row.vault !== VAULT ||
    row.silo !== SILO ||
    row.anchorBlock !== pinned.issue.anchor.blockNumber ||
    row.anchorBlockHash !== pinned.anchorHash ||
    row.deliveryBlock !== pinned.end.toString() ||
    row.deliveryBlockHash !== pinned.deliveryHash ||
    row.fromBlock !== range.from.toString() ||
    row.toBlock !== range.to.toString() ||
    !equal(row.queries, queriesFor(range, pinned.issue.holder)) ||
    row.episodeAttribution !== 'unresolved' ||
    row.cryptographicAbsenceProven !== false ||
    row.completeWindow !== true ||
    !Array.isArray(row.origins) ||
    row.origins.length !== 2 ||
    Buffer.byteLength(JSON.stringify(row)) > MAX_RECORD_BYTES
  )
    throw Error('susde_continuity_row_invalid')
  utc(row.capturedAtUtc)
  const [a, b] = row.origins
  if (
    a.chainId !== '0x1' ||
    b.chainId !== '0x1' ||
    a.providerHost !== host(a.provider) ||
    b.providerHost !== host(b.provider) ||
    a.providerHost === b.providerHost
  )
    throw Error('susde_continuity_origins_invalid')
  if (
    !equal(
      { ...a, provider: null, providerHost: null },
      { ...b, provider: null, providerHost: null },
    )
  )
    throw Error('susde_continuity_origin_disagreement')
  for (const origin of row.origins) {
    if (
      !equal(header(origin.startHeader), origin.startHeader) ||
      !equal(header(origin.endHeader), origin.endHeader) ||
      hex(origin.startHeader.number) !== range.from ||
      hex(origin.endHeader.number) !== range.to ||
      !Array.isArray(origin.logs)
    )
      throw Error('susde_continuity_boundary_invalid')
    if (
      (row.sequence === 1 && origin.startHeader.parentHash !== pinned.anchorHash) ||
      (range.to === pinned.end && origin.endHeader.hash !== pinned.deliveryHash)
    )
      throw Error('susde_continuity_endpoint_disagreement')
    verifyLogs(origin.logs, range, pinned.issue.holder, origin.startHeader, origin.endHeader)
  }
  return { logs: a.logs, pair: [a.providerHost, b.providerHost].sort().join('|') }
}

/** Replays every complete window against the current verified issue/delivery. */
export async function verifyContinuityArchive(
  out = OUT,
  issueOut = ISSUE_OUT,
  deliveryOut = DELIVERY_OUT,
  loadTarget = target,
  issueSequence = ISSUE_SEQUENCE,
) {
  const pinned = await loadTarget(issueOut, deliveryOut, issueSequence)
  const rows = await readLedger(out)
  let preDeliveryWithdrawLogs = 0
  let observedWithdrawLogs = 0
  const pairs = new Set()
  for (const row of rows) {
    const checked = validateWindowRecord(row, pinned)
    if (
      row.sequence > 1 &&
      row.origins[0].startHeader.parentHash !== rows[row.sequence - 2].origins[0].endHeader.hash
    )
      throw Error('susde_continuity_cursor_parent_disagreement')
    for (const log of checked.logs) {
      observedWithdrawLogs++
      if (hex(log.blockNumber) < pinned.end || hex(log.transactionIndex) <= pinned.payoutTxIndex)
        preDeliveryWithdrawLogs++
    }
    pairs.add(checked.pair)
  }
  const coveredThroughBlock = rows.length ? rows.at(-1).toBlock : null
  return {
    rows,
    summary: {
      issueSequence: pinned.issue.sequence,
      issueSha256: pinned.issue.sha256,
      deliverySha256: pinned.delivery.sha256,
      startBlock: pinned.start.toString(),
      endBlock: pinned.end.toString(),
      coveredThroughBlock,
      complete: coveredThroughBlock === pinned.end.toString(),
      windows: rows.length,
      providerHostPairs: [...pairs].sort(),
      observedWithdrawLogs,
      preDeliveryWithdrawLogs,
    },
  }
}

const captureWindow = async (issue, range, a, b, request, witnessed) => {
  const query = filter(range.from, range.to, issue.holder)
  const capture = async (client) => {
    const [startRaw, endRaw, logsRaw] = await Promise.all([
      request(client, 'eth_getBlockByNumber', [numberHex(range.from), false]),
      request(client, 'eth_getBlockByNumber', [numberHex(range.to), false]),
      request(client, 'eth_getLogs', [query]),
    ])
    if (
      !Array.isArray(logsRaw) ||
      logsRaw.length > MAX_LOGS ||
      Buffer.byteLength(JSON.stringify(logsRaw)) > MAX_LOG_BYTES
    )
      throw Error('susde_continuity_logs_large')
    return {
      provider: client.provider,
      providerHost: host(client.provider),
      chainId: '0x1',
      startHeader: header(startRaw),
      endHeader: header(endRaw),
      logs: logsRaw.map(compactLog),
    }
  }
  const results = await Promise.allSettled([capture(a), capture(b)])
  const origins = []
  for (const result of results) {
    if (result.status === 'rejected') {
      if (/^susde_continuity_[a-z0-9_]+$/.test(result.reason?.message ?? '')) throw result.reason
      continue // transport only; retain any successful peer witness
    }
    const origin = result.value
    const projection = { ...origin, provider: null, providerHost: null }
    const previous = witnessed.values().next().value
    if (previous && !equal(previous, projection))
      throw Error('susde_continuity_origin_disagreement')
    witnessed.set(origin.providerHost, projection)
    origins.push(origin)
  }
  return origins.length === 2 ? origins : null
}

const pairsOf = (peers) => {
  const pairs = []
  const seen = new Set()
  const add = (i, j) => {
    const id = [Math.min(i, j), Math.max(i, j)].join(':')
    if (seen.has(id)) return
    seen.add(id)
    if (host(peers[i].provider) !== host(peers[j].provider)) pairs.push([peers[i], peers[j]])
  }
  // These exact host families were observed to serve the ten-block historical
  // window. Keep them first even when configuration inserts other providers.
  const alchemy = peers.findIndex((peer) => /(^|\.)alchemy\.com$/.test(host(peer.provider)))
  const ankr = peers.findIndex((peer) => /(^|\.)ankr\.com$/.test(host(peer.provider)))
  if (alchemy >= 0 && ankr >= 0) add(alchemy, ankr)
  for (let offset = 1; offset < peers.length && pairs.length < 6; offset++) {
    for (let i = 0; i < peers.length && pairs.length < 6; i++) {
      const j = (i + offset) % peers.length
      add(i, j)
    }
  }
  return pairs
}

/** One bounded incremental pass. Every accepted window is independently sealed. */
export async function tickContinuity({
  issueSequence = ISSUE_SEQUENCE,
  urls,
  out = outputForIssue(issueSequence),
  issueOut = ISSUE_OUT,
  deliveryOut = DELIVERY_OUT,
  clients = publicRpcClients,
  now = () => new Date(),
  nowMs = Date.now,
  loadTarget = target,
  freeBytes = diskFreeBytes,
} = {}) {
  if (!Number.isInteger(issueSequence) || issueSequence < 1)
    throw Error('susde_continuity_issue_unknown')
  const pinned = await loadTarget(issueOut, deliveryOut, issueSequence)
  let verified = await verifyContinuityArchive(
    out,
    issueOut,
    deliveryOut,
    loadTarget,
    issueSequence,
  )
  if (verified.summary.complete) return { status: 'complete', ...verified.summary }
  if ((await freeBytes(out)) < MIN_TICK_FREE_BYTES)
    return { status: 'susde_continuity_disk_reserve', appended: 0, ...verified.summary }
  const peers = clients(urls)
  if (!Array.isArray(peers) || peers.length < 2 || peers.length > 8)
    throw Error('susde_continuity_origins_invalid')
  const budget = { calls: 0, deadline: nowMs() + MAX_MS }
  const request = async (client, method, params) => {
    if (++budget.calls > MAX_CALLS || nowMs() > budget.deadline)
      throw Error('susde_continuity_budget_exhausted')
    return client.request(method, params)
  }
  const checked = await Promise.allSettled(peers.map((peer) => request(peer, 'eth_chainId', [])))
  if (checked.some((result) => result.status === 'fulfilled' && result.value !== '0x1'))
    return { status: 'susde_continuity_chain_invalid', appended: 0 }
  if (nowMs() > budget.deadline || budget.calls >= MAX_CALLS)
    return { status: 'susde_continuity_budget_exhausted', appended: 0 }
  const healthy = peers.filter((_, index) => checked[index].status === 'fulfilled')
  const pairs = pairsOf(healthy)
  if (!pairs.length) return { status: 'susde_continuity_origins_unavailable', appended: 0 }
  let appended = 0
  for (; appended < MAX_WINDOWS_PER_TICK; ) {
    if ((await freeBytes(out)) < MIN_TICK_FREE_BYTES)
      return { status: 'susde_continuity_disk_reserve', appended, ...verified.summary }
    const sequence = verified.rows.length + 1
    const range = expectedRange(pinned, sequence)
    if (!range) return { status: 'complete', appended, ...verified.summary }
    let origins = null
    let lastStatus = 'susde_continuity_rpc_unavailable'
    const witnessed = new Map()
    for (const [a, b] of pairs) {
      try {
        origins = await captureWindow(pinned.issue, range, a, b, request, witnessed)
        if (origins) break
      } catch (error) {
        if (error?.message === 'susde_continuity_budget_exhausted')
          return { status: error.message, appended, ...verified.summary }
        if (/^susde_continuity_[a-z0-9_]+$/.test(error?.message ?? ''))
          return { status: error.message, appended, ...verified.summary }
        lastStatus = 'susde_continuity_rpc_unavailable' // transport only
      }
    }
    if (!origins) return { status: lastStatus, appended, ...verified.summary }
    if (nowMs() > budget.deadline || budget.calls >= MAX_CALLS)
      return { status: 'susde_continuity_budget_exhausted', appended, ...verified.summary }
    const body = {
      study: STUDY,
      sequence,
      previousSha256: verified.rows.at(-1)?.sha256 ?? null,
      issueSequence,
      issueSha256: pinned.issue.sha256,
      deliverySha256: pinned.delivery.sha256,
      deliveryTransactionHash: pinned.delivery.transactionHash,
      holder: pinned.issue.holder,
      vault: VAULT,
      silo: SILO,
      anchorBlock: pinned.issue.anchor.blockNumber,
      anchorBlockHash: pinned.anchorHash,
      deliveryBlock: pinned.end.toString(),
      deliveryBlockHash: pinned.deliveryHash,
      fromBlock: range.from.toString(),
      toBlock: range.to.toString(),
      queries: queriesFor(range, pinned.issue.holder),
      capturedAtUtc: now().toISOString(),
      completeWindow: true,
      episodeAttribution: 'unresolved',
      cryptographicAbsenceProven: false,
      origins,
    }
    // Validate the full window before append; a failed response leaves no row.
    const candidate = seal(body)
    validateWindowRecord(candidate, pinned)
    if ((await freeBytes(out)) < MIN_TICK_FREE_BYTES)
      return { status: 'susde_continuity_disk_reserve', appended, ...verified.summary }
    if (
      sequence > 1 &&
      candidate.origins[0].startHeader.parentHash !== verified.rows.at(-1).origins[0].endHeader.hash
    )
      throw Error('susde_continuity_cursor_parent_disagreement')
    await appendLedger(
      out,
      candidate,
      async (directory) =>
        (await verifyContinuityArchive(directory, issueOut, deliveryOut, loadTarget, issueSequence))
          .rows,
    )
    appended++
    verified = await verifyContinuityArchive(out, issueOut, deliveryOut, loadTarget, issueSequence)
    if (verified.summary.complete) return { status: 'complete', appended, ...verified.summary }
  }
  return { status: 'advanced', appended, ...verified.summary }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const issueSequence = process.argv[3] === undefined ? ISSUE_SEQUENCE : Number(process.argv[3])
    if (!Number.isInteger(issueSequence) || issueSequence < 1)
      throw Error('susde_continuity_issue_unknown')
    if (process.argv[2] === '--verify') {
      const result = await verifyContinuityArchive(
        outputForIssue(issueSequence),
        ISSUE_OUT,
        DELIVERY_OUT,
        target,
        issueSequence,
      )
      console.log(JSON.stringify(result.summary))
    } else if (process.argv[2] === '--tick') {
      const result = await tickContinuity({
        issueSequence,
        urls: configuredPublicRpcUrls(readEnv()),
      })
      console.log(JSON.stringify(result))
      if (!['complete', 'advanced'].includes(result.status)) process.exitCode = 1
    } else throw Error('susde_continuity_usage')
  } catch (error) {
    console.error(
      /^susde_continuity_[a-z0-9_]+$/.test(error?.message ?? '')
        ? error.message
        : 'susde_continuity_failed',
    )
    process.exitCode = 1
  }
}
