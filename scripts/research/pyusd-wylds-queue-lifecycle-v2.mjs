// Bounded, independently replayable wYLDS request -> admin queue outcome evidence.
// Completion plus same-transaction USDC is an intermediate payout, never original PYUSD recovery.
import { createHash, randomUUID } from 'node:crypto'
import { constants, statfsSync } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rm, rename } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { decodeEventLog, encodeFunctionData, parseAbi, parseAbiItem, toEventSelector } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls } from './carry-public-direct-exit-issue.mjs'
import { header, selectOrigins, verifyHeaderChain } from './carry-direct-vault-flow-preflight.mjs'
import { PRIME, ROUTE, USDC, WYLDS } from './pyusd-staking-economic-exit.mjs'

export const STUDY = 'pyusd_wylds_queue_lifecycle_v2'
export const ROOT = resolve('data/research/venue-signals/pyusd-wylds-queue-lifecycle-v2')
export const WINDOW_BLOCKS = 5
export const MAX_WINDOWS_PER_RUN = 24
export const MAX_RUN_MS = 90_000
export const MAX_EVENTS_PER_WINDOW = 12
const MAX_DISCOVERY_EVENTS = WINDOW_BLOCKS * MAX_EVENTS_PER_WINDOW
const MAX_ROW_BYTES = 400_000
const MAX_PENDING_HOLDERS = 4_096
const MAX_CHECKPOINT_BYTES = 2_000_000
const CHECKPOINT = 'checkpoint.json'
const MAX_RPC_CALLS = 350
const MAX_RPC_CALLS_PER_RUN = 2_200
const MAX_RESPONSE_BYTES = 400_000
const MAX_TOTAL_BYTES = 6_000_000
const DISK_RESERVE = 1_073_741_824
const ZERO = '0x0000000000000000000000000000000000000000'
const EVENTS = {
  request: parseAbiItem(
    'event RedemptionRequested(address indexed user,uint256 shares,uint256 assets,uint256 timestamp)',
  ),
  completion: parseAbiItem(
    'event RedemptionCompleted(address indexed user,uint256 shares,uint256 assets,uint256 timestamp)',
  ),
  cancel: parseAbiItem('event RedemptionCancelled(address indexed user,uint256 shares)'),
}
const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from,address indexed to,uint256 value)',
)
const TOPICS = Object.fromEntries(
  Object.entries(EVENTS).map(([name, abi]) => [name, toEventSelector(abi)]),
)
const TRANSFER_TOPIC = toEventSelector(TRANSFER)
const REDEEM_VAULT_DATA = encodeFunctionData({
  abi: parseAbi(['function redeemVault() view returns (address)']),
  functionName: 'redeemVault',
})
const HASH = /^0x[0-9a-fA-F]{64}$/
const ADDR = /^0x[0-9a-fA-F]{40}$/
const WORD_ADDR = /^0x0{24}[0-9a-fA-F]{40}$/
const QUANTITY = /^0x[0-9a-fA-F]+$/
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/
const SHA = /^[0-9a-f]{64}$/
const hex = (n) => `0x${n.toString(16)}`
const sha = (s) => createHash('sha256').update(s).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const key = (event) => `${event.transactionHash}:${event.logIndex}`
const lower = (s) => s.toLowerCase()
function integer(q) {
  if (!QUANTITY.test(q ?? '')) throw Error('queue_v2_quantity_invalid')
  const n = Number(BigInt(q))
  if (!Number.isSafeInteger(n)) throw Error('queue_v2_quantity_invalid')
  return n
}
function checkedHeader(raw) {
  return header({ response: { result: raw } })
}
function compactHeader(raw) {
  const checked = checkedHeader(raw)
  return {
    number: hex(checked.number),
    hash: checked.hash,
    parentHash: checked.parentHash,
    timestamp: hex(checked.timestamp),
  }
}
function abortCheck(signal) {
  if (signal?.aborted) throw Error('queue_v2_deadline')
}
async function withinDeadline(promise, signal) {
  abortCheck(signal)
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Error('queue_v2_deadline'))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) reject(Error('queue_v2_deadline'))
        else resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}
function boundedFetch(fetchImpl, signal, nowMs, runBudget) {
  let calls = 0,
    bytes = 0
  const started = nowMs()
  return async (origin, method, params) => {
    abortCheck(signal)
    if (++calls > MAX_RPC_CALLS || nowMs() - started > MAX_RUN_MS)
      throw Error('queue_v2_rpc_budget')
    if (runBudget && ++runBudget.calls > MAX_RPC_CALLS_PER_RUN)
      throw Error('queue_v2_run_rpc_budget')
    const request = { jsonrpc: '2.0', id: calls, method, params }
    const response = await withinDeadline(
      fetchImpl(origin.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.any([AbortSignal.timeout(12_000), ...(signal ? [signal] : [])]),
      }),
      signal,
    )
    if (!response.ok || Number(response.headers?.get?.('content-length') ?? 0) > MAX_RESPONSE_BYTES)
      throw Error('queue_v2_rpc_response_invalid')
    // Bound streamed responses before parsing; response.text() alone has no size cap.
    let raw
    if (response.body?.getReader) {
      const reader = response.body.getReader(),
        chunks = []
      let length = 0
      try {
        while (true) {
          const { done, value } = await withinDeadline(reader.read(), signal)
          if (done) break
          length += value.byteLength
          if (length > MAX_RESPONSE_BYTES || bytes + length > MAX_TOTAL_BYTES)
            throw Error('queue_v2_rpc_bytes')
          chunks.push(value)
        }
      } finally {
        reader.releaseLock()
      }
      raw = Buffer.concat(chunks, length).toString('utf8')
    } else raw = await withinDeadline(response.text(), signal)
    bytes += Buffer.byteLength(raw)
    if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES || bytes > MAX_TOTAL_BYTES)
      throw Error('queue_v2_rpc_bytes')
    let envelope
    try {
      envelope = JSON.parse(raw)
    } catch {
      throw Error('queue_v2_rpc_json')
    }
    if (
      envelope?.jsonrpc !== '2.0' ||
      envelope.id !== request.id ||
      envelope.error ||
      envelope.result === undefined
    )
      throw Error('queue_v2_rpc_result')
    abortCheck(signal)
    return { request, response: envelope }
  }
}
function result(proof) {
  return proof.response.result
}
function normalizeEvent(log, headers, from) {
  if (
    !log ||
    lower(log.address ?? '') !== WYLDS ||
    !HASH.test(log.blockHash ?? '') ||
    !HASH.test(log.transactionHash ?? '') ||
    !Array.isArray(log.topics) ||
    log.topics.length !== 2 ||
    !WORD_ADDR.test(log.topics[1] ?? '') ||
    !HEX_BYTES.test(log.data ?? '') ||
    log.removed === true
  )
    throw Error('queue_v2_event_invalid')
  const kind = Object.keys(TOPICS).find((k) => TOPICS[k] === lower(log.topics[0] ?? ''))
  if (!kind) throw Error('queue_v2_event_topic')
  const blockNumber = integer(log.blockNumber),
    transactionIndex = integer(log.transactionIndex),
    logIndex = integer(log.logIndex)
  const block = headers[blockNumber - from]
  if (!block || block.hash !== lower(log.blockHash)) throw Error('queue_v2_event_header')
  let args
  try {
    args = decodeEventLog({
      abi: [EVENTS[kind]],
      topics: log.topics,
      data: log.data,
      strict: true,
    }).args
  } catch {
    throw Error('queue_v2_event_decode')
  }
  if (
    args.shares <= 0n ||
    (kind !== 'cancel' && (args.assets <= 0n || Number(args.timestamp) !== block.timestamp))
  )
    throw Error('queue_v2_event_amount_or_clock')
  return {
    kind,
    user: lower(args.user),
    sharesRaw: args.shares.toString(),
    assetsRaw: kind === 'cancel' ? null : args.assets.toString(),
    timestamp: kind === 'cancel' ? block.timestamp : Number(args.timestamp),
    blockNumber,
    blockHash: block.hash,
    transactionHash: lower(log.transactionHash),
    transactionIndex,
    logIndex,
    topics: log.topics.map(lower),
    data: lower(log.data),
  }
}
function normalizeLogs(raw, headers, from, limit = MAX_EVENTS_PER_WINDOW) {
  if (!Array.isArray(raw) || raw.length > limit) throw Error('queue_v2_window_overflow')
  const events = raw.map((log) => normalizeEvent(log, headers, from))
  events.sort(
    (a, b) =>
      a.blockNumber - b.blockNumber ||
      a.transactionIndex - b.transactionIndex ||
      a.logIndex - b.logIndex,
  )
  if (
    new Set(events.map(key)).size !== events.length ||
    new Set(events.map((event) => `${event.blockNumber}:${event.logIndex}`)).size !== events.length
  )
    throw Error('queue_v2_event_duplicate')
  return events
}
function materialReceipt(receipt, event) {
  if (
    lower(receipt?.transactionHash ?? '') !== event.transactionHash ||
    lower(receipt?.blockHash ?? '') !== event.blockHash ||
    integer(receipt.blockNumber) !== event.blockNumber ||
    integer(receipt.transactionIndex) !== event.transactionIndex ||
    receipt.status !== '0x1' ||
    !Array.isArray(receipt.logs) ||
    receipt.logs.length > 256
  )
    throw Error('queue_v2_receipt_invalid')
  const logs = receipt.logs.map((log) => {
    if (
      !ADDR.test(log?.address ?? '') ||
      !HASH.test(log?.transactionHash ?? '') ||
      !HASH.test(log?.blockHash ?? '') ||
      lower(log.transactionHash) !== event.transactionHash ||
      lower(log.blockHash) !== event.blockHash ||
      integer(log.blockNumber) !== event.blockNumber ||
      integer(log.transactionIndex) !== event.transactionIndex ||
      !Array.isArray(log.topics) ||
      log.topics.some((t) => !HASH.test(t)) ||
      !HEX_BYTES.test(log.data ?? '') ||
      log.removed === true
    )
      throw Error('queue_v2_receipt_log_invalid')
    return {
      address: lower(log.address),
      logIndex: integer(log.logIndex),
      topics: log.topics.map(lower),
      data: lower(log.data),
    }
  })
  if (
    new Set(logs.map((l) => l.logIndex)).size !== logs.length ||
    logs.filter(
      (l) =>
        l.address === WYLDS &&
        l.logIndex === event.logIndex &&
        same(l.topics, event.topics) &&
        l.data === event.data,
    ).length !== 1
  )
    throw Error('queue_v2_event_receipt_mismatch')
  return {
    transactionHash: event.transactionHash,
    blockHash: event.blockHash,
    blockNumber: event.blockNumber,
    transactionIndex: event.transactionIndex,
    status: '0x1',
    logs,
  }
}
function decodeVaultWord(word) {
  if (!HASH.test(word ?? '') || !/^0x0{24}/i.test(word))
    throw Error('queue_v2_redeem_vault_invalid')
  const address = `0x${word.slice(-40)}`.toLowerCase()
  if (address === ZERO) throw Error('queue_v2_redeem_vault_invalid')
  return address
}
function payout(receipt, event, redeemVault) {
  const exact = []
  for (const log of receipt.logs) {
    if (log.address !== USDC || log.topics[0] !== TRANSFER_TOPIC) continue
    if (
      log.topics.length !== 3 ||
      !WORD_ADDR.test(log.topics[1]) ||
      !WORD_ADDR.test(log.topics[2]) ||
      !HASH.test(log.data)
    )
      throw Error('queue_v2_transfer_shape')
    let args
    try {
      args = decodeEventLog({
        abi: [TRANSFER],
        topics: log.topics,
        data: log.data,
        strict: true,
      }).args
    } catch {
      throw Error('queue_v2_transfer_decode')
    }
    if (lower(args.from) === redeemVault && lower(args.to) === event.user)
      exact.push({ logIndex: log.logIndex, valueRaw: args.value.toString() })
  }
  if (exact.length > 1) throw Error('queue_v2_payout_ambiguous')
  if (exact.length === 1 && exact[0].valueRaw !== event.assetsRaw)
    throw Error('queue_v2_payout_amount_mismatch')
  return exact.length === 1
    ? { status: 'same_tx_usdc_transfer_from_block_end_redeem_vault_to_holder', ...exact[0] }
    : { status: 'not_attested', logIndex: null, valueRaw: null }
}
export function replayWindow(row, previous = null) {
  const { sha256, ...body } = row
  if (
    row.study !== STUDY ||
    row.routeKey !== ROUTE ||
    row.destination !== PRIME ||
    row.wylds !== WYLDS ||
    row.usdc !== USDC ||
    row.firstRecovery !== 'not_assessed' ||
    row.finalPyusdPayout !== 'not_attested' ||
    (row.postStateSha256 !== null && !SHA.test(row.postStateSha256 ?? '')) ||
    row.sequence !== (previous?.sequence ?? 0) + 1 ||
    row.previousSha256 !== (previous?.sha256 ?? null) ||
    !SHA.test(sha256 ?? '') ||
    sha(JSON.stringify(body)) !== sha256 ||
    !Number.isSafeInteger(row.scan?.from) ||
    !Number.isSafeInteger(row.scan?.to) ||
    row.scan.to < row.scan.from ||
    row.scan.to - row.scan.from >= WINDOW_BLOCKS ||
    (previous &&
      (row.scan.from !== previous.scan.to + 1 ||
        row.scan.fromParentHash !== previous.scan.toHash)) ||
    !Array.isArray(row.sources) ||
    row.sources.length !== 2 ||
    row.sources[0].origin === row.sources[1].origin ||
    !Array.isArray(row.events) ||
    row.events.length > MAX_EVENTS_PER_WINDOW
  )
    throw Error('queue_v2_row_invalid')
  const chains = row.sources.map((source) => {
    if (
      !/^[a-z0-9.-]+$/.test(source.origin ?? '') ||
      source.chainId !== '0x1' ||
      !Array.isArray(source.headers)
    )
      throw Error('queue_v2_source_invalid')
    const headers = source.headers.map(checkedHeader)
    verifyHeaderChain(headers, row.scan.from, row.scan.to)
    const head = checkedHeader(source.finalizedHead)
    if (head.number < row.scan.to) throw Error('queue_v2_unfinalized')
    if (head.number === row.scan.to) {
      if (head.hash !== row.scan.toHash || source.canonicalRead !== null)
        throw Error('queue_v2_canonicality')
    } else {
      const proof = source.canonicalRead
      if (
        proof?.request?.method !== 'eth_getBalance' ||
        !same(proof.request.params, [
          ZERO,
          { blockHash: row.scan.toHash, requireCanonical: true },
        ]) ||
        proof.response?.jsonrpc !== '2.0' ||
        proof.response.id !== proof.request.id ||
        proof.response.error ||
        !QUANTITY.test(result(proof) ?? '')
      )
        throw Error('queue_v2_canonicality')
    }
    const logRead = source.logRead
    if (
      logRead?.request?.jsonrpc !== '2.0' ||
      !Number.isSafeInteger(logRead.request.id) ||
      logRead.request.id < 1 ||
      logRead.request.method !== 'eth_getLogs' ||
      !same(logRead.request.params, [
        {
          address: WYLDS,
          fromBlock: hex(row.scan.from),
          toBlock: hex(row.scan.to),
          topics: [Object.values(TOPICS)],
        },
      ]) ||
      logRead.response?.jsonrpc !== '2.0' ||
      logRead.response.id !== logRead.request.id ||
      logRead.response.error !== undefined
    )
      throw Error('queue_v2_log_query_invalid')
    return headers
  })
  if (
    !same(chains[0], chains[1]) ||
    chains[0][0].parentHash !== row.scan.fromParentHash ||
    chains[0].at(-1).hash !== row.scan.toHash
  )
    throw Error('queue_v2_header_disagreement')
  const discovered = row.sources.map((s) =>
    normalizeLogs(result(s.logRead), chains[0], row.scan.from),
  )
  if (
    !same(discovered[0], discovered[1]) ||
    !same(
      discovered[0],
      row.events.map((e) => e.event),
    )
  )
    throw Error('queue_v2_discovery_disagreement')
  for (const witness of row.events) {
    if (!Array.isArray(witness.rawReceipts) || witness.rawReceipts.length !== 2)
      throw Error('queue_v2_receipts_missing')
    const receipts = witness.rawReceipts.map((r) => materialReceipt(r, witness.event))
    if (!same(receipts[0], receipts[1])) throw Error('queue_v2_receipt_disagreement')
    if (witness.event.kind === 'completion') {
      if (!Array.isArray(witness.redeemVaultReads) || witness.redeemVaultReads.length !== 2)
        throw Error('queue_v2_vault_read_missing')
      const vaults = witness.redeemVaultReads.map((proof, i) => {
        if (
          proof?.request?.method !== 'eth_call' ||
          !same(proof.request.params, [
            { to: WYLDS, data: REDEEM_VAULT_DATA },
            { blockHash: witness.event.blockHash, requireCanonical: true },
          ]) ||
          proof.response?.jsonrpc !== '2.0' ||
          proof.response.id !== proof.request.id ||
          proof.response.error
        )
          throw Error('queue_v2_vault_read_invalid')
        return decodeVaultWord(result(proof))
      })
      if (
        vaults[0] !== vaults[1] ||
        witness.redeemVault !== vaults[0] ||
        !same(witness.intermediateUsdc, payout(receipts[0], witness.event, vaults[0]))
      )
        throw Error('queue_v2_payout_disagreement')
    } else if (
      witness.redeemVaultReads !== null ||
      witness.redeemVault !== null ||
      witness.intermediateUsdc !== null
    )
      throw Error('queue_v2_noncompletion_payout')
  }
  return discovered[0]
}
export function replayEpisodes(rows) {
  const pending = new Map(),
    episodes = []
  let previous = null,
    lastTip = null
  for (const row of rows) {
    const events = replayWindow(row, previous)
    for (const event of events) {
      if (event.kind === 'request') {
        if (pending.has(event.user)) throw Error('queue_v2_pair_ambiguous_duplicate_request')
        pending.set(event.user, event)
      } else {
        const start = pending.get(event.user)
        if (!start) {
          episodes.push({
            status:
              event.kind === 'completion' ? 'left_censored_completion' : 'left_censored_cancel',
            user: event.user,
            request: null,
            end: event,
            durationSeconds: null,
            intermediateUsdc: null,
          })
          continue
        }
        if (
          start.sharesRaw !== event.sharesRaw ||
          (event.kind === 'completion' && start.assetsRaw !== event.assetsRaw)
        )
          throw Error('queue_v2_pair_amount_mismatch')
        const witness = row.events.find((w) => key(w.event) === key(event))
        episodes.push({
          status: event.kind === 'completion' ? 'completed' : 'cancelled',
          user: event.user,
          request: start,
          end: event,
          durationSeconds: event.timestamp - start.timestamp,
          intermediateUsdc: event.kind === 'completion' ? witness.intermediateUsdc : null,
        })
        pending.delete(event.user)
      }
    }
    previous = row
    lastTip = row.scan.to
  }
  for (const [user, start] of pending)
    episodes.push({
      status: 'right_censored_pending',
      user,
      request: start,
      end: null,
      durationSeconds: null,
      intermediateUsdc: null,
      censoredAtBlock: lastTip,
    })
  if (episodes.some((e) => e.durationSeconds !== null && e.durationSeconds < 0))
    throw Error('queue_v2_negative_duration')
  return episodes
}
export async function collectWindow({
  urls,
  fetchImpl = fetch,
  nowMs = Date.now,
  previous = null,
  startBlock,
  signal,
  runBudget,
  state,
  cadence,
} = {}) {
  const origins = selectOrigins(urls ?? configuredPublicRpcUrls(readEnv()))
  const rpc = boundedFetch(fetchImpl, signal, nowMs, runBudget)
  const sources = []
  for (const origin of origins) {
    const chain = await rpc(origin, 'eth_chainId', [])
    if (result(chain) !== '0x1') throw Error('queue_v2_chain_invalid')
    sources.push({
      origin: origin.host,
      chainId: '0x1',
      finalizedHead: compactHeader(
        result(await rpc(origin, 'eth_getBlockByNumber', ['finalized', false])),
      ),
    })
  }
  const finalized = Math.min(...sources.map((s) => checkedHeader(s.finalizedHead).number))
  if (cadence) {
    cadence.minimumFinalizedHeadObserved = Math.min(
      cadence.minimumFinalizedHeadObserved ?? finalized,
      finalized,
    )
    cadence.latestFinalizedHead = finalized
  }
  const from = previous ? previous.scan.to + 1 : (startBlock ?? finalized - WINDOW_BLOCKS + 1)
  if (!Number.isSafeInteger(from) || from < 0) throw Error('queue_v2_start_invalid')
  let to = Math.min(from + WINDOW_BLOCKS - 1, finalized)
  if (from > to) return null
  for (let i = 0; i < 2; i++) {
    sources[i].headers = []
    for (let b = from; b <= to; b++)
      sources[i].headers.push(
        compactHeader(result(await rpc(origins[i], 'eth_getBlockByNumber', [hex(b), false]))),
      )
  }
  const chains = sources.map((s) => verifyHeaderChain(s.headers.map(checkedHeader), from, to))
  if (!same(chains[0], chains[1])) throw Error('queue_v2_header_disagreement')
  if (previous && chains[0][0].parentHash !== previous.scan.toHash)
    throw Error('queue_v2_parent_mismatch')
  for (let i = 0; i < 2; i++) {
    sources[i].logRead = await rpc(origins[i], 'eth_getLogs', [
      { address: WYLDS, fromBlock: hex(from), toBlock: hex(to), topics: [Object.values(TOPICS)] },
    ])
  }
  const fullDiscoveries = sources.map((s) =>
    normalizeLogs(result(s.logRead), chains[0], from, MAX_DISCOVERY_EVENTS),
  )
  if (!same(fullDiscoveries[0], fullDiscoveries[1])) throw Error('queue_v2_discovery_disagreement')
  let count = 0
  for (let block = from; block <= to; block++) {
    count += fullDiscoveries[0].filter((event) => event.blockNumber === block).length
    if (count > MAX_EVENTS_PER_WINDOW) {
      if (block === from) throw Error('queue_v2_single_block_overflow_hard_blocker')
      to = block - 1
      break
    }
  }
  if (to < chains[0].at(-1).number) {
    for (let i = 0; i < 2; i++) {
      sources[i].headers = sources[i].headers.slice(0, to - from + 1)
      sources[i].logRead = await rpc(origins[i], 'eth_getLogs', [
        { address: WYLDS, fromBlock: hex(from), toBlock: hex(to), topics: [Object.values(TOPICS)] },
      ])
    }
  }
  const scan = {
    from,
    to,
    fromParentHash: chains[0][0].parentHash,
    toHash: chains[0][to - from].hash,
  }
  for (let i = 0; i < 2; i++) {
    sources[i].canonicalRead =
      checkedHeader(sources[i].finalizedHead).number === to
        ? null
        : await rpc(origins[i], 'eth_getBalance', [
            ZERO,
            { blockHash: scan.toHash, requireCanonical: true },
          ])
  }
  const discovered = sources.map((s) => normalizeLogs(result(s.logRead), chains[0], from))
  if (!same(discovered[0], discovered[1])) throw Error('queue_v2_discovery_disagreement')
  if (
    !same(
      discovered[0],
      fullDiscoveries[0].filter((event) => event.blockNumber <= to),
    )
  )
    throw Error('queue_v2_subwindow_disagreement')
  const events = []
  for (const event of discovered[0]) {
    const rawReceipts = []
    for (let i = 0; i < 2; i++)
      rawReceipts.push(
        result(await rpc(origins[i], 'eth_getTransactionReceipt', [event.transactionHash])),
      )
    const receipt = materialReceipt(rawReceipts[0], event)
    if (!same(receipt, materialReceipt(rawReceipts[1], event)))
      throw Error('queue_v2_receipt_disagreement')
    let redeemVaultReads = null,
      redeemVault = null,
      intermediateUsdc = null
    if (event.kind === 'completion') {
      redeemVaultReads = []
      for (let i = 0; i < 2; i++)
        redeemVaultReads.push(
          await rpc(origins[i], 'eth_call', [
            { to: WYLDS, data: REDEEM_VAULT_DATA },
            { blockHash: event.blockHash, requireCanonical: true },
          ]),
        )
      redeemVault = decodeVaultWord(result(redeemVaultReads[0]))
      if (redeemVault !== decodeVaultWord(result(redeemVaultReads[1])))
        throw Error('queue_v2_vault_disagreement')
      intermediateUsdc = payout(receipt, event, redeemVault)
    }
    events.push({ event, rawReceipts, redeemVaultReads, redeemVault, intermediateUsdc })
  }
  const body = {
    study: STUDY,
    routeKey: ROUTE,
    destination: PRIME,
    wylds: WYLDS,
    usdc: USDC,
    firstRecovery: 'not_assessed',
    finalPyusdPayout: 'not_attested',
    issuedAtUtc: new Date(nowMs()).toISOString(),
    scan,
    events,
    sources,
    sequence: (previous?.sequence ?? 0) + 1,
    previousSha256: previous?.sha256 ?? null,
    postStateSha256: null,
  }
  let row = { ...body, sha256: sha(JSON.stringify(body)) }
  replayWindow(row, previous)
  const priorState = state ?? (!previous ? emptyState() : null)
  if (priorState) {
    if (
      priorState.previous?.sequence !== previous?.sequence ||
      priorState.previous?.sha256 !== previous?.sha256 ||
      priorState.previous?.scan?.to !== previous?.scan?.to ||
      priorState.previous?.scan?.toHash !== previous?.scan?.toHash
    )
      throw Error('queue_v2_prior_state_mismatch')
    const preview = { ...priorState, pending: new Map(priorState.pending) }
    advanceState(preview, row, false)
    body.postStateSha256 = stateDigest(preview)
    row = { ...body, sha256: sha(JSON.stringify(body)) }
    replayWindow(row, previous)
  }
  return row
}
function diskGuard(root, minimumFreeBytes) {
  const st = statfsSync(root)
  if (Number(st.bavail) * Number(st.bsize) < minimumFreeBytes) throw Error('queue_v2_disk_reserve')
}
function emptyState() {
  return {
    previous: null,
    pending: new Map(),
    completed: 0,
    cancelled: 0,
    leftCensored: 0,
    intermediateUsdcAttested: 0,
    windows: 0,
  }
}
function advanceState(state, row, verifyCommitment = true) {
  const events = replayWindow(row, state.previous)
  for (const event of events) {
    if (event.kind === 'request') {
      if (state.pending.has(event.user)) throw Error('queue_v2_pair_ambiguous_duplicate_request')
      state.pending.set(event.user, event)
      if (state.pending.size > MAX_PENDING_HOLDERS) throw Error('queue_v2_pending_limit')
      continue
    }
    const start = state.pending.get(event.user)
    if (!start) {
      state.leftCensored++
      continue
    }
    if (
      start.sharesRaw !== event.sharesRaw ||
      (event.kind === 'completion' && start.assetsRaw !== event.assetsRaw) ||
      event.timestamp < start.timestamp
    )
      throw Error('queue_v2_pair_amount_or_clock')
    if (event.kind === 'completion') {
      state.completed++
      const witness = row.events.find((w) => key(w.event) === key(event))
      if (
        witness.intermediateUsdc.status ===
        'same_tx_usdc_transfer_from_block_end_redeem_vault_to_holder'
      )
        state.intermediateUsdcAttested++
    } else state.cancelled++
    state.pending.delete(event.user)
  }
  state.previous = {
    sequence: row.sequence,
    sha256: row.sha256,
    scan: { to: row.scan.to, toHash: row.scan.toHash },
  }
  state.windows++
  if (verifyCommitment && row.postStateSha256 !== stateDigest(state))
    throw Error('queue_v2_post_state_commitment_mismatch')
  return state
}
async function ledgerNames(root) {
  let names
  try {
    if (!(await lstat(root)).isDirectory()) throw Error('queue_v2_root_invalid')
    names = await readdir(root)
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  if (names.some((n) => n !== CHECKPOINT && !/^\d{8}\.json$/.test(n)))
    throw Error('queue_v2_stray_file')
  const rows = names.filter((n) => n !== CHECKPOINT).sort()
  for (let i = 0; i < rows.length; i++)
    if (rows[i] !== `${String(i + 1).padStart(8, '0')}.json`) throw Error('queue_v2_ledger_gap')
  return rows
}
async function readRow(root, name, signal) {
  abortCheck(signal)
  const fd = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW)
  let raw
  try {
    const st = await fd.stat()
    if (!st.isFile() || st.size < 1 || st.size > MAX_ROW_BYTES) throw Error('queue_v2_file_size')
    raw = await fd.readFile()
  } finally {
    await fd.close()
  }
  abortCheck(signal)
  const row = JSON.parse(raw.toString('utf8'))
  if (raw.toString('utf8') !== `${JSON.stringify(row)}\n`) throw Error('queue_v2_file_encoding')
  return row
}
// Full offline proof replay streams one row at a time. It does not trust the operational checkpoint.
export async function verifyLedger(root = ROOT, signal) {
  const names = await ledgerNames(root),
    state = emptyState()
  for (const name of names) advanceState(state, await readRow(root, name, signal))
  abortCheck(signal)
  return state
}
// Convenience for small synthetic fixtures. Production collection and --verify use streaming state.
export async function readRows(root = ROOT, signal) {
  await verifyLedger(root, signal)
  const names = await ledgerNames(root),
    rows = []
  for (const name of names) rows.push(await readRow(root, name, signal))
  replayEpisodes(rows)
  return rows
}
function checkpointBody(state) {
  return {
    study: STUDY,
    previous: state.previous,
    pending: [...state.pending.entries()].sort(([a], [b]) => a.localeCompare(b)),
    completed: state.completed,
    cancelled: state.cancelled,
    leftCensored: state.leftCensored,
    intermediateUsdcAttested: state.intermediateUsdcAttested,
    windows: state.windows,
  }
}
function stateDigest(state) {
  return sha(
    JSON.stringify({
      pending: [...state.pending.entries()].sort(([a], [b]) => a.localeCompare(b)),
      completed: state.completed,
      cancelled: state.cancelled,
      leftCensored: state.leftCensored,
      intermediateUsdcAttested: state.intermediateUsdcAttested,
      windows: state.windows,
    }),
  )
}
async function saveCheckpoint(state, root) {
  const body = checkpointBody(state),
    record = { ...body, sha256: sha(JSON.stringify(body)) }
  const data = `${JSON.stringify(record)}\n`
  if (Buffer.byteLength(data) > MAX_CHECKPOINT_BYTES) throw Error('queue_v2_checkpoint_size')
  const temp = join(dirname(root), `.wylds-lifecycle-checkpoint-${randomUUID()}.tmp`)
  try {
    const fd = await open(temp, 'wx', 0o600)
    try {
      await fd.writeFile(data)
      await fd.sync()
    } finally {
      await fd.close()
    }
    await rename(temp, join(root, CHECKPOINT))
    const dir = await open(root, 'r')
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  } finally {
    await rm(temp, { force: true })
  }
}
async function operationalState(root, signal) {
  const names = await ledgerNames(root)
  let record
  try {
    const fd = await open(join(root, CHECKPOINT), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const st = await fd.stat()
      if (!st.isFile() || st.size < 1 || st.size > MAX_CHECKPOINT_BYTES)
        throw Error('queue_v2_checkpoint_size')
      record = JSON.parse((await fd.readFile()).toString('utf8'))
    } finally {
      await fd.close()
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  if (!record) {
    const state = await verifyLedger(root, signal)
    if (state.windows) await saveCheckpoint(state, root)
    return state
  }
  const { sha256, ...body } = record
  if (
    record.study !== STUDY ||
    !SHA.test(sha256 ?? '') ||
    sha(JSON.stringify(body)) !== sha256 ||
    !Number.isSafeInteger(record.windows) ||
    record.windows < 1 ||
    record.windows > names.length ||
    !Array.isArray(record.pending) ||
    record.pending.length > MAX_PENDING_HOLDERS ||
    !Number.isSafeInteger(record.completed) ||
    !Number.isSafeInteger(record.cancelled) ||
    !Number.isSafeInteger(record.leftCensored) ||
    !Number.isSafeInteger(record.intermediateUsdcAttested)
  )
    throw Error('queue_v2_checkpoint_invalid')
  const tip = await readRow(root, names[record.windows - 1], signal)
  if (
    tip.sequence !== record.previous?.sequence ||
    tip.sha256 !== record.previous.sha256 ||
    tip.scan.to !== record.previous.scan?.to ||
    tip.scan.toHash !== record.previous.scan?.toHash
  )
    throw Error('queue_v2_checkpoint_tip_mismatch')
  replayWindow(
    tip,
    record.windows > 1
      ? {
          sequence: record.windows - 1,
          sha256: tip.previousSha256,
          scan: { to: tip.scan.from - 1, toHash: tip.scan.fromParentHash },
        }
      : null,
  )
  const state = { ...emptyState(), ...body, pending: new Map(record.pending) }
  if (state.pending.size !== record.pending.length) throw Error('queue_v2_checkpoint_invalid')
  if (stateDigest(state) !== tip.postStateSha256) throw Error('queue_v2_checkpoint_state_mismatch')
  // A crash can leave a sealed row after the last atomic checkpoint. Replay only that bounded tail.
  if (names.length - record.windows > MAX_WINDOWS_PER_RUN)
    throw Error('queue_v2_checkpoint_tail_limit')
  for (const name of names.slice(record.windows))
    advanceState(state, await readRow(root, name, signal))
  if (names.length > record.windows) await saveCheckpoint(state, root)
  return state
}
async function appendRow(row, root, minimumFreeBytes) {
  if (!SHA.test(row.postStateSha256 ?? '')) throw Error('queue_v2_uncommitted_row')
  const data = `${JSON.stringify(row)}\n`
  if (Buffer.byteLength(data) > MAX_ROW_BYTES) throw Error('queue_v2_file_size')
  diskGuard(root, minimumFreeBytes + Buffer.byteLength(data))
  const temp = join(dirname(root), `.wylds-lifecycle-${randomUUID()}.tmp`)
  try {
    const fd = await open(temp, 'wx', 0o600)
    try {
      await fd.writeFile(data)
      await fd.sync()
    } finally {
      await fd.close()
    }
    await link(temp, join(root, `${String(row.sequence).padStart(8, '0')}.json`))
    const dir = await open(root, 'r')
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  } finally {
    await rm(temp, { force: true })
  }
}
export async function collectLifecycle({
  root = ROOT,
  minimumFreeBytes = DISK_RESERVE,
  maxWindows = MAX_WINDOWS_PER_RUN,
  runTimeoutMs = MAX_RUN_MS,
  ...options
} = {}) {
  if (
    !Number.isSafeInteger(maxWindows) ||
    maxWindows < 1 ||
    maxWindows > MAX_WINDOWS_PER_RUN ||
    !Number.isSafeInteger(runTimeoutMs) ||
    runTimeoutMs < 1 ||
    runTimeoutMs > MAX_RUN_MS
  )
    throw Error('queue_v2_run_bounds_invalid')
  const startedAt = performance.now()
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), runTimeoutMs)
  try {
    await mkdir(root, { recursive: true })
    diskGuard(root, minimumFreeBytes)
    const state = await operationalState(root, controller.signal)
    const runBudget = { calls: 0 }
    const cadence = { minimumFinalizedHeadObserved: null, latestFinalizedHead: null }
    let windows = 0,
      events = 0,
      blocksAdvanced = 0
    for (let i = 0; i < maxWindows; i++) {
      abortCheck(controller.signal)
      const row = await collectWindow({
        ...options,
        previous: state.previous,
        signal: controller.signal,
        runBudget,
        state,
        cadence,
      })
      if (!row) break
      advanceState(state, row)
      abortCheck(controller.signal)
      await appendRow(row, root, minimumFreeBytes)
      await saveCheckpoint(state, root)
      windows++
      events += row.events.length
      blocksAdvanced += row.scan.to - row.scan.from + 1
    }
    abortCheck(controller.signal)
    const tipBlock = state.previous?.scan.to ?? null
    return {
      study: STUDY,
      windows,
      events,
      completed: state.completed,
      rightCensored: state.pending.size,
      intermediateUsdcAttested: state.intermediateUsdcAttested,
      elapsedMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
      rpcCalls: runBudget.calls,
      blocksAdvanced,
      tipBlock,
      minimumFinalizedHeadObserved: cadence.minimumFinalizedHeadObserved,
      latestFinalizedHead: cadence.latestFinalizedHead,
      remainingLagBlocks:
        tipBlock === null || cadence.latestFinalizedHead === null
          ? null
          : Math.max(0, cadence.latestFinalizedHead - tipBlock),
      firstRecovery: 'not_assessed',
      finalPyusdPayout: 'not_attested',
    }
  } finally {
    clearTimeout(timer)
  }
}
async function main() {
  if (
    !['--collect', '--verify'].includes(process.argv[2]) ||
    (process.argv[2] === '--verify' && process.argv.length !== 3) ||
    (process.argv[2] === '--collect' && ![3, 4].includes(process.argv.length))
  )
    throw Error('usage: node pyusd-wylds-queue-lifecycle-v2.mjs --collect [startBlock]|--verify')
  const answer =
    process.argv[2] === '--collect'
      ? await collectLifecycle(
          process.argv[3] === undefined ? {} : { startBlock: Number(process.argv[3]) },
        )
      : {
          study: STUDY,
          windows: (await verifyLedger()).windows,
          coverage: 'bounded_contiguous_from_bootstrap_only',
          firstRecovery: 'not_assessed',
          finalPyusdPayout: 'not_attested',
        }
  console.log(JSON.stringify(answer))
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e.message)
    process.exitCode = 1
  })
