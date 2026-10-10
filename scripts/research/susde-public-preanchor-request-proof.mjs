// Bounded pre-anchor request evidence for a pending sUSDe issue. It never
// proves a later payout, episode attribution, or cryptographic absence.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  toEventSelector,
} from 'viem'
import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import { OUT as ISSUE_OUT, verifyIssues } from './susde-public-pending-exit-issue.mjs'
import {
  ADDRESS,
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

export const STUDY = 'susde_public_preanchor_request_proof_v1'
export const OUT = resolve('data/research/venue-signals/susde-public-preanchor-request-issue-3')
export const FROM = 26093684n
export const TO = 26093723n
export const MAX_LOG_SPAN = 5n
export const MAX_RPC_CALLS = 50
const ISSUE_SEQUENCE = 3
// The verified issue-8 discovery precedes its anchor by 282 blocks. Keep the
// proof window bounded while allowing that exact selected-request episode.
const MAX_ISSUE_LOOKBACK = 512n
const MAX_RECORD_BYTES = 128 * 1024
const MAX_LOGS = 32
const ABI = parseAbi([
  'function cooldownAssets(uint256 assets,address owner) returns (uint256)',
  'function cooldownShares(uint256 shares,address owner) returns (uint256)',
  'function cooldownAssets(uint256 assets) returns (uint256)',
  'function cooldownShares(uint256 shares) returns (uint256)',
  'function cooldownDuration() view returns (uint24)',
  'function silo() view returns (address)',
])
const DURATION_UPDATE_TOPIC = toEventSelector(
  'CooldownDurationUpdated(uint24,uint24)',
).toLowerCase()
const number = (x) => {
  if (!/^0x[0-9a-f]+$/i.test(x ?? '')) throw Error('preanchor_hex_invalid')
  return BigInt(x)
}
const topic = (address) => `0x${address.slice(2).padStart(64, '0')}`
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const host = (url) => {
  const name = new URL(url).hostname
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '')
  if (!name) throw Error('preanchor_provider_invalid')
  return name
}
const header = (raw, expected) => {
  if (
    number(raw?.number) !== expected ||
    !HASH.test(raw?.hash ?? '') ||
    !HASH.test(raw?.parentHash ?? '') ||
    !/^0x[0-9a-f]+$/i.test(raw?.timestamp ?? '')
  )
    throw Error('preanchor_header_invalid')
  return {
    number: raw.number.toLowerCase(),
    hash: raw.hash.toLowerCase(),
    parentHash: raw.parentHash.toLowerCase(),
    timestamp: raw.timestamp.toLowerCase(),
  }
}
const log = (raw, holder, from, to) => {
  if (
    raw?.address?.toLowerCase() !== VAULT ||
    raw?.removed === true ||
    !Array.isArray(raw?.topics) ||
    raw.topics.length !== 4 ||
    !raw.topics.every((x) => HASH.test(x ?? '')) ||
    raw.topics[0].toLowerCase() !== WITHDRAW_TOPIC ||
    raw.topics[2].toLowerCase() !== topic(SILO) ||
    raw.topics[3].toLowerCase() !== topic(holder) ||
    !/^0x[0-9a-f]{128}$/i.test(raw?.data ?? '') ||
    !HASH.test(raw?.blockHash ?? '') ||
    !HASH.test(raw?.transactionHash ?? '') ||
    number(raw?.blockNumber) < from ||
    number(raw?.blockNumber) > to ||
    number(raw?.transactionIndex) < 0n ||
    number(raw?.logIndex) < 0n
  )
    throw Error('preanchor_log_invalid')
  return {
    address: VAULT,
    topics: raw.topics.map((x) => x.toLowerCase()),
    data: raw.data.toLowerCase(),
    blockNumber: raw.blockNumber.toLowerCase(),
    blockHash: raw.blockHash.toLowerCase(),
    transactionHash: raw.transactionHash.toLowerCase(),
    transactionIndex: raw.transactionIndex.toLowerCase(),
    logIndex: raw.logIndex.toLowerCase(),
    removed: false,
  }
}
const compactTransaction = (raw) => ({
  hash: raw?.hash?.toLowerCase(),
  blockHash: raw?.blockHash?.toLowerCase(),
  blockNumber: raw?.blockNumber?.toLowerCase(),
  transactionIndex: raw?.transactionIndex?.toLowerCase(),
  from: raw?.from?.toLowerCase(),
  to: raw?.to?.toLowerCase(),
  input: raw?.input?.toLowerCase(),
})
const compactReceipt = (raw, selected, holder, block) => {
  if (!Array.isArray(raw?.logs) || raw.logs.length > 128) throw Error('preanchor_receipt_invalid')
  const matching = raw.logs.filter(
    (item) =>
      item.logIndex &&
      number(item.logIndex) === number(selected.logIndex) &&
      item.transactionHash?.toLowerCase() === selected.transactionHash,
  )
  if (matching.length !== 1) throw Error('preanchor_receipt_log_missing')
  return {
    transactionHash: raw.transactionHash?.toLowerCase(),
    blockHash: raw.blockHash?.toLowerCase(),
    blockNumber: raw.blockNumber?.toLowerCase(),
    status: raw.status?.toLowerCase(),
    logs: [log(matching[0], holder, block, block)],
  }
}
const durationUpdate = (raw, block, blockHash) => {
  if (
    raw?.address?.toLowerCase() !== VAULT ||
    raw?.removed === true ||
    raw?.topics?.length !== 1 ||
    raw.topics[0]?.toLowerCase() !== DURATION_UPDATE_TOPIC ||
    !/^0x[0-9a-f]{128}$/i.test(raw?.data ?? '') ||
    number(raw?.blockNumber) !== block ||
    raw?.blockHash?.toLowerCase() !== blockHash ||
    !HASH.test(raw?.transactionHash ?? '') ||
    number(raw?.transactionIndex) < 0n ||
    number(raw?.logIndex) < 0n
  )
    throw Error('preanchor_duration_update_invalid')
  return {
    address: VAULT,
    topics: [DURATION_UPDATE_TOPIC],
    data: raw.data.toLowerCase(),
    blockNumber: raw.blockNumber.toLowerCase(),
    blockHash,
    transactionHash: raw.transactionHash.toLowerCase(),
    transactionIndex: raw.transactionIndex.toLowerCase(),
    logIndex: raw.logIndex.toLowerCase(),
    removed: false,
  }
}
const issueRange = (issue) => {
  const selected = issue?.screened?.filter((entry) => entry.status === 'selected')
  if (!Array.isArray(selected) || selected.length !== 1)
    throw Error('preanchor_issue_discovery_ambiguous')
  const from = BigInt(selected[0].discoveryBlock)
  const to = BigInt(issue.anchor.blockNumber)
  if (from <= 0n || to < from || to - from >= MAX_ISSUE_LOOKBACK)
    throw Error('preanchor_issue_range_invalid')
  return { from, to }
}
const outputForIssue = (issueSequence) =>
  issueSequence === ISSUE_SEQUENCE
    ? OUT
    : resolve(`data/research/venue-signals/susde-public-preanchor-request-issue-${issueSequence}`)
const windows = (fromBlock = FROM, toBlock = TO) => {
  const rows = []
  for (let from = fromBlock; from <= toBlock; from += MAX_LOG_SPAN)
    rows.push({
      from,
      to: from + MAX_LOG_SPAN - 1n <= toBlock ? from + MAX_LOG_SPAN - 1n : toBlock,
    })
  return rows
}
const filter = (from, to, holder) => ({
  address: VAULT,
  topics: [WITHDRAW_TOPIC, null, topic(SILO), topic(holder)],
  fromBlock: numberHex(from),
  toBlock: numberHex(to),
})

export function validatePreanchor(row, issue) {
  const { from: fromBlock, to: toBlock } = issueRange(issue)
  if (
    row?.study !== STUDY ||
    row.sequence !== 1 ||
    row.previousSha256 !== null ||
    row.issueSequence !== issue.sequence ||
    row.issueSha256 !== issue?.sha256 ||
    row.holder !== issue.holder ||
    row.anchorBlock !== issue.anchor.blockNumber ||
    row.anchorHash !== issue.anchor.blockHash ||
    row.fromBlock !== fromBlock.toString() ||
    row.toBlock !== toBlock.toString() ||
    row.twoOriginObservedLogAgreement !== true ||
    row.headerChainContinuityProven !== false ||
    row.cooldownAtExecutionProven !== false ||
    row.cryptographicAbsenceProven !== false ||
    row.sameEpisodePayoutProven !== false ||
    !Array.isArray(row.origins) ||
    row.origins.length !== 2 ||
    Buffer.byteLength(JSON.stringify(row)) > MAX_RECORD_BYTES
  )
    throw Error('preanchor_row_invalid')
  utc(row.capturedAtUtc)
  const selectedScreen = issue.screened?.filter((entry) => entry.status === 'selected')
  if (!Array.isArray(selectedScreen) || selectedScreen.length !== 1)
    throw Error('preanchor_issue_discovery_ambiguous')
  const discovery = selectedScreen[0]
  const proof = discovery.receiptProof
  const expected = log(proof?.discoveryLog, issue.holder, fromBlock, toBlock)
  if (
    discovery.discoveryBlock !== number(row.selectedLog.blockNumber).toString() ||
    discovery.discoveryTransactionHash !== row.selectedLog.transactionHash ||
    discovery.discoveryLogIndex !== number(row.selectedLog.logIndex).toString() ||
    proof?.status !== '0x1' ||
    proof.transactionHash !== row.selectedLog.transactionHash ||
    proof.blockHash !== row.selectedLog.blockHash ||
    proof.blockNumber !== row.selectedLog.blockNumber ||
    proof.witnessBlockHash !== row.selectedLog.blockHash ||
    !equal(expected, row.selectedLog) ||
    !equal(log(proof.receiptLog, issue.holder, fromBlock, toBlock), row.selectedLog) ||
    number(`0x${row.selectedLog.data.slice(2, 66)}`).toString() !== issue.pendingAssetsRaw
  )
    throw Error('preanchor_issue_discovery_mismatch')
  const [a, b] = row.origins
  if (
    a.providerHost !== host(a.provider) ||
    b.providerHost !== host(b.provider) ||
    a.providerHost === b.providerHost ||
    a.chainId !== '0x1' ||
    b.chainId !== '0x1'
  )
    throw Error('preanchor_origins_invalid')
  if (
    !equal(
      { ...a, provider: null, providerHost: null },
      { ...b, provider: null, providerHost: null },
    )
  )
    throw Error('preanchor_origin_disagreement')
  for (const origin of row.origins) {
    const start = header(origin.startHeader, fromBlock)
    const end = header(origin.endHeader, toBlock)
    if (
      !equal(start, origin.startHeader) ||
      !equal(end, origin.endHeader) ||
      end.hash !== issue.anchor.blockHash
    )
      throw Error('preanchor_boundary_invalid')
    if (
      !Array.isArray(origin.windows) ||
      origin.windows.length !== windows(fromBlock, toBlock).length
    )
      throw Error('preanchor_windows_invalid')
    const all = []
    for (const [index, range] of windows(fromBlock, toBlock).entries()) {
      const window = origin.windows[index]
      if (
        window.fromBlock !== range.from.toString() ||
        window.toBlock !== range.to.toString() ||
        !Array.isArray(window.logs) ||
        window.logs.length > MAX_LOGS
      )
        throw Error('preanchor_windows_invalid')
      for (const item of window.logs) {
        if (!equal(log(item, issue.holder, range.from, range.to), item))
          throw Error('preanchor_log_invalid')
        all.push(item)
      }
    }
    if (all.length !== 1 || !equal(all[0], row.selectedLog))
      throw Error('preanchor_ambiguous_request')
    const selected = all[0]
    const block = number(selected.blockNumber)
    if (block > toBlock || block < fromBlock) throw Error('preanchor_selected_block_invalid')
    const selectedHeader = header(origin.selectedHeader, block)
    const parentHeader = header(origin.parentHeader, block - 1n)
    if (
      !equal(selectedHeader, origin.selectedHeader) ||
      !equal(parentHeader, origin.parentHeader) ||
      selectedHeader.hash !== selected.blockHash ||
      selectedHeader.parentHash !== parentHeader.hash ||
      (block === fromBlock && selectedHeader.hash !== start.hash) ||
      (block === toBlock && selectedHeader.hash !== end.hash)
    )
      throw Error('preanchor_selected_header_invalid')
    if (
      !Number.isSafeInteger(origin.cooldownDurationSeconds) ||
      origin.cooldownDurationSeconds <= 0 ||
      origin.cooldownDurationSeconds > 604800
    )
      throw Error('preanchor_cooldown_call_invalid')
    if (
      proof.discoveryLog.blockTimestamp?.toLowerCase() !== selectedHeader.timestamp ||
      proof.receiptLog.blockTimestamp?.toLowerCase() !== selectedHeader.timestamp ||
      utc(issue.cooldownEndUtc) !==
        Number(number(selectedHeader.timestamp)) * 1000 + origin.cooldownDurationSeconds * 1000
    )
      throw Error('preanchor_cooldown_timing_mismatch')
    if (!Array.isArray(origin.durationUpdates) || origin.durationUpdates.length > 16)
      throw Error('preanchor_duration_updates_invalid')
    for (const update of origin.durationUpdates) {
      if (!equal(durationUpdate(update, block, selected.blockHash), update))
        throw Error('preanchor_duration_update_invalid')
      if (
        number(update.transactionIndex) < number(selected.transactionIndex) ||
        (number(update.transactionIndex) === number(selected.transactionIndex) &&
          number(update.logIndex) < number(selected.logIndex))
      )
        throw Error('preanchor_same_block_duration_change')
    }
    const tx = origin.transaction
    const receipt = origin.receipt
    if (
      tx?.hash?.toLowerCase() !== selected.transactionHash ||
      tx?.blockHash?.toLowerCase() !== selected.blockHash ||
      tx?.from?.toLowerCase() !== issue.holder ||
      tx?.to?.toLowerCase() !== VAULT ||
      number(tx?.blockNumber) !== block ||
      number(tx?.transactionIndex) !== number(selected.transactionIndex) ||
      !/^0x[0-9a-f]{8,136}$/i.test(tx?.input ?? '') ||
      receipt?.transactionHash?.toLowerCase() !== selected.transactionHash ||
      receipt?.blockHash?.toLowerCase() !== selected.blockHash ||
      number(receipt?.blockNumber) !== block ||
      receipt?.status !== '0x1' ||
      !Array.isArray(receipt.logs) ||
      receipt.logs.length > 128 ||
      receipt.logs.filter(
        (item) =>
          number(item.logIndex) === number(selected.logIndex) &&
          item.transactionHash?.toLowerCase() === selected.transactionHash &&
          equal(log(item, issue.holder, block, block), selected),
      ).length !== 1
    )
      throw Error('preanchor_transaction_invalid')
    let decoded
    try {
      decoded = decodeFunctionData({ abi: ABI, data: tx.input })
    } catch {
      throw Error('preanchor_cooldown_call_invalid')
    }
    const assets = number(`0x${selected.data.slice(2, 66)}`)
    const shares = number(`0x${selected.data.slice(66, 130)}`)
    const exactAssetsWithOwner =
      decoded.functionName === 'cooldownAssets' &&
      decoded.args.length === 2 &&
      decoded.args[1]?.toLowerCase() === issue.holder &&
      decoded.args[0] === assets
    const exactAssetsSelf =
      decoded.functionName === 'cooldownAssets' &&
      decoded.args.length === 1 &&
      decoded.args[0] === assets &&
      selected.topics[1] === topic(issue.holder) &&
      tx.from === issue.holder
    const exactSharesWithOwner =
      decoded.functionName === 'cooldownShares' &&
      decoded.args.length === 2 &&
      decoded.args[1]?.toLowerCase() === issue.holder &&
      decoded.args[0] === shares
    const exactSharesSelf =
      decoded.functionName === 'cooldownShares' &&
      decoded.args.length === 1 &&
      decoded.args[0] === shares &&
      selected.topics[1] === topic(issue.holder) &&
      tx.from === issue.holder
    if (
      !(exactAssetsWithOwner || exactAssetsSelf || exactSharesWithOwner || exactSharesSelf) ||
      assets === 0n ||
      shares === 0n ||
      !Number.isSafeInteger(origin.cooldownDurationSeconds) ||
      origin.cooldownDurationSeconds <= 0 ||
      origin.cooldownDurationSeconds > 604800 ||
      origin.silo !== SILO
    )
      throw Error('preanchor_cooldown_call_invalid')
  }
  return {
    transactionHash: row.selectedLog.transactionHash,
    blockNumber: number(row.selectedLog.blockNumber).toString(),
    assetsRaw: number(`0x${row.selectedLog.data.slice(2, 66)}`).toString(),
    payoutAttribution: 'unresolved',
  }
}

export async function verifyPreanchor(
  out = OUT,
  issueOut = ISSUE_OUT,
  loadIssue = verifyIssues,
  issueSequence = ISSUE_SEQUENCE,
) {
  const issues = await loadIssue(issueOut)
  const issue = issues[issueSequence - 1]
  if (!issue || issue.sequence !== issueSequence) throw Error('preanchor_issue_unavailable')
  issueRange(issue)
  const rows = await readLedger(out)
  if (rows.length > 1) throw Error('preanchor_multiple_records')
  if (rows.length) validatePreanchor(rows[0], issue)
  return { issue, rows }
}

/** Paced, bounded RPC requests; the extra pair checks same-block updates. */
export async function capturePreanchor({
  urls,
  issueSequence = ISSUE_SEQUENCE,
  out = outputForIssue(issueSequence),
  issueOut = ISSUE_OUT,
  clients = publicRpcClients,
  loadIssue = verifyIssues,
  now = () => new Date(),
  nowMs = Date.now,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  statfs,
} = {}) {
  const { issue, rows } = await verifyPreanchor(out, issueOut, loadIssue, issueSequence)
  const { from: fromBlock, to: toBlock } = issueRange(issue)
  const logWindows = windows(fromBlock, toBlock)
  const maxCalls = Math.max(MAX_RPC_CALLS, logWindows.length * 2 + 20)
  if (rows.length) return { status: 'complete', ...validatePreanchor(rows[0], issue) }
  const available = clients(urls)
  if (!Array.isArray(available) || available.length < 2 || available.length > 8)
    throw Error('preanchor_origins_invalid')
  const alchemy = available.find((peer) => /(^|\.)alchemy\.com$/.test(host(peer.provider)))
  const ankr = available.find((peer) => /(^|\.)ankr\.com$/.test(host(peer.provider)))
  const first = alchemy && ankr ? alchemy : available[0]
  const peers = [
    first,
    alchemy && ankr ? ankr : available.find((peer) => host(peer.provider) !== host(first.provider)),
  ]
  if (!peers[1]) throw Error('preanchor_origins_invalid')
  let calls = 0
  let aborted = false
  const deadline = nowMs() + 220_000
  const lastStart = new Map()
  const queues = new Map()
  const request = (peer, method, params) => {
    const providerHost = host(peer.provider)
    const previous = queues.get(providerHost) ?? Promise.resolve()
    const next = previous.then(async () => {
      if (aborted) throw Error('preanchor_rpc_aborted')
      if (++calls > maxCalls) throw Error('preanchor_rpc_budget_exhausted')
      const pause = Math.max(0, (lastStart.get(providerHost) ?? -Infinity) + 200 - nowMs())
      if (pause) await sleep(pause)
      if (nowMs() > deadline) throw Error('preanchor_runtime_budget_exhausted')
      lastStart.set(providerHost, nowMs())
      try {
        return await peer.request(method, params)
      } catch {
        aborted = true
        throw Error(`preanchor_rpc_unavailable host=${providerHost} method=${method}`)
      }
    })
    queues.set(
      providerHost,
      next.catch(() => {}),
    )
    return next
  }
  const capture = async (peer) => {
    const [chainId, startRaw, endRaw] = await Promise.all([
      request(peer, 'eth_chainId', []),
      request(peer, 'eth_getBlockByNumber', [numberHex(fromBlock), false]),
      request(peer, 'eth_getBlockByNumber', [numberHex(toBlock), false]),
    ])
    if (chainId !== '0x1') throw Error('preanchor_chain_invalid')
    const startHeader = header(startRaw, fromBlock)
    const endHeader = header(endRaw, toBlock)
    if (endHeader.hash !== issue.anchor.blockHash) throw Error('preanchor_anchor_disagreement')
    const chunks = []
    for (const range of logWindows) {
      const raw = await request(peer, 'eth_getLogs', [filter(range.from, range.to, issue.holder)])
      if (!Array.isArray(raw) || raw.length > MAX_LOGS) throw Error('preanchor_logs_invalid')
      chunks.push({
        fromBlock: range.from.toString(),
        toBlock: range.to.toString(),
        logs: raw.map((item) => log(item, issue.holder, range.from, range.to)),
      })
    }
    return {
      provider: new URL(peer.provider).origin,
      providerHost: host(peer.provider),
      chainId,
      startHeader,
      endHeader,
      windows: chunks,
    }
  }
  const origins = await Promise.all(peers.map(capture))
  if (
    !equal(
      { ...origins[0], provider: null, providerHost: null },
      { ...origins[1], provider: null, providerHost: null },
    )
  )
    throw Error('preanchor_origin_disagreement')
  const logs = origins[0].windows.flatMap((window) => window.logs)
  if (logs.length !== 1) throw Error('preanchor_ambiguous_request')
  const selectedLog = logs[0]
  const selectedBlock = number(selectedLog.blockNumber)
  await Promise.all(
    origins.map(async (origin, index) => {
      const peer = peers[index]
      const [selectedRaw, parentRaw, transaction, receipt, updatesRaw] = await Promise.all([
        request(peer, 'eth_getBlockByNumber', [selectedLog.blockNumber, false]),
        request(peer, 'eth_getBlockByNumber', [numberHex(selectedBlock - 1n), false]),
        request(peer, 'eth_getTransactionByHash', [selectedLog.transactionHash]),
        request(peer, 'eth_getTransactionReceipt', [selectedLog.transactionHash]),
        request(peer, 'eth_getLogs', [
          {
            address: VAULT,
            topics: [DURATION_UPDATE_TOPIC],
            fromBlock: selectedLog.blockNumber,
            toBlock: selectedLog.blockNumber,
          },
        ]),
      ])
      origin.selectedHeader = header(selectedRaw, selectedBlock)
      origin.parentHeader = header(parentRaw, selectedBlock - 1n)
      origin.transaction = compactTransaction(transaction)
      origin.receipt = compactReceipt(receipt, selectedLog, issue.holder, selectedBlock)
      if (!Array.isArray(updatesRaw) || updatesRaw.length > 16)
        throw Error('preanchor_duration_updates_invalid')
      origin.durationUpdates = updatesRaw.map((item) =>
        durationUpdate(item, selectedBlock, selectedLog.blockHash),
      )
      const pin = { blockHash: origin.parentHeader.hash, requireCanonical: true }
      const [durationRaw, siloRaw] = await Promise.all([
        request(peer, 'eth_call', [
          { to: VAULT, data: encodeFunctionData({ abi: ABI, functionName: 'cooldownDuration' }) },
          pin,
        ]),
        request(peer, 'eth_call', [
          { to: VAULT, data: encodeFunctionData({ abi: ABI, functionName: 'silo' }) },
          pin,
        ]),
      ])
      origin.cooldownDurationSeconds = Number(
        decodeFunctionResult({ abi: ABI, functionName: 'cooldownDuration', data: durationRaw }),
      )
      origin.silo = decodeFunctionResult({
        abi: ABI,
        functionName: 'silo',
        data: siloRaw,
      }).toLowerCase()
    }),
  )
  const candidate = seal({
    study: STUDY,
    sequence: 1,
    previousSha256: null,
    issueSequence,
    issueSha256: issue.sha256,
    holder: issue.holder,
    anchorBlock: issue.anchor.blockNumber,
    anchorHash: issue.anchor.blockHash,
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    selectedLog,
    capturedAtUtc: now().toISOString(),
    twoOriginObservedLogAgreement: true,
    headerChainContinuityProven: false,
    cooldownAtExecutionProven: false,
    cryptographicAbsenceProven: false,
    sameEpisodePayoutProven: false,
    origins,
  })
  const summary = validatePreanchor(candidate, issue)
  await appendLedger(
    out,
    candidate,
    async (directory) =>
      (await verifyPreanchor(directory, issueOut, loadIssue, issueSequence)).rows,
    statfs,
  )
  return { status: 'complete', calls, ...summary }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const command = process.argv[2]
  const issueSequence = process.argv[3] === undefined ? ISSUE_SEQUENCE : Number(process.argv[3])
  if (!Number.isInteger(issueSequence) || issueSequence < 1)
    throw Error('preanchor_issue_sequence_invalid')
  if (command === '--verify')
    console.log(
      JSON.stringify(
        await verifyPreanchor(
          outputForIssue(issueSequence),
          ISSUE_OUT,
          verifyIssues,
          issueSequence,
        ),
      ),
    )
  else if (command === '--capture') {
    const urls = configuredPublicRpcUrls(readEnv())
    console.log(JSON.stringify(await capturePreanchor({ urls, issueSequence })))
  } else
    throw Error(
      'usage: node scripts/research/susde-public-preanchor-request-proof.mjs --verify|--capture [issueSequence]',
    )
}
