// Read-only, as-known-at-Submit census of Morpho V2 exit-critical gate proposals.
// Raw logs are frozen before any historical pre-submit state is classified.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  parseAbi,
  parseAbiItem,
  toEventSelector,
  toHex,
} from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import {
  CHUNK_BLOCKS,
  FACTORY_SHA,
  FROM_BLOCK,
  readFactory,
  ranges,
  SUBMIT,
  TO_BLOCK,
  TOPIC0,
} from './morpho-v2-cap-submit-census.mjs'

export const STUDY = 'morpho-v2-gate-submit-census-v1'
export const RAW_STUDY = 'morpho-v2-gate-submit-raw-v1'
export const GATE_ABI = parseAbi([
  'function setSendSharesGate(address newSendSharesGate)',
  'function setReceiveAssetsGate(address newReceiveAssetsGate)',
])
export const SEND_SHARES_SELECTOR = toEventSelector(GATE_ABI[0]).slice(0, 10).toLowerCase()
export const RECEIVE_ASSETS_SELECTOR = toEventSelector(GATE_ABI[1]).slice(0, 10).toLowerCase()
export const SELECTORS = [SEND_SHARES_SELECTOR, RECEIVE_ASSETS_SELECTOR]
export const SELECTOR_TOPICS = SELECTORS.map((selector) => `0x${selector.slice(2).padEnd(64, '0')}`)
const STATE_ABI = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function abdicated(bytes4 selector) view returns (bool)',
  'function sendSharesGate() view returns (address)',
  'function receiveAssetsGate() view returns (address)',
])
const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)
const ABDICATE = parseAbiItem('event Abdicate(bytes4 indexed selector)')
const SET_SEND_SHARES = parseAbiItem('event SetSendSharesGate(address indexed newSendSharesGate)')
const SET_RECEIVE_ASSETS = parseAbiItem(
  'event SetReceiveAssetsGate(address indexed newReceiveAssetsGate)',
)
const TRANSFER_TOPIC = toEventSelector(TRANSFER).toLowerCase()
const ABDICATE_TOPIC = toEventSelector(ABDICATE).toLowerCase()
const SET_SEND_SHARES_TOPIC = toEventSelector(SET_SEND_SHARES).toLowerCase()
const SET_RECEIVE_ASSETS_TOPIC = toEventSelector(SET_RECEIVE_ASSETS).toLowerCase()
const ZERO = `0x${'0'.repeat(40)}`
const ADDRESS = /^0x[\da-f]{40}$/i
const HASH = /^0x[\da-f]{64}$/i
const HEX = /^0x(?:[\da-f]{2})*$/i
const SOURCE = 'https://github.com/morpho-org/vault-v2/blob/main/src/VaultV2.sol'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  renameSync(temp, path)
}
function safeNumber(hex) {
  const number = Number(BigInt(hex))
  if (!Number.isSafeInteger(number)) throw new Error('Unsafe RPC integer')
  return number
}
async function retry(
  operation,
  retries = 2,
  pause = (ms) => new Promise((done) => setTimeout(done, ms)),
) {
  for (let i = 0; ; i++) {
    try {
      return await operation()
    } catch (error) {
      if (i >= retries) throw new Error('RPC read failed', { cause: error })
      await pause(500 * 2 ** i)
    }
  }
}

export function decodeGateCall(event) {
  try {
    if (event.data.slice(0, 10).toLowerCase() !== event.selector) return null
    const decoded = decodeFunctionData({ abi: GATE_ABI, data: event.data })
    const canonical = encodeFunctionData({
      abi: GATE_ABI,
      functionName: decoded.functionName,
      args: decoded.args,
    })
    if (canonical.toLowerCase() !== event.data.toLowerCase()) return null
    const gate = decoded.args[0].toLowerCase()
    if (!ADDRESS.test(gate)) return null
    return {
      kind: decoded.functionName === 'setSendSharesGate' ? 'send-shares' : 'receive-assets',
      proposedGate: gate,
    }
  } catch {
    return null
  }
}

export function decodeSubmit(log, timestamp) {
  if (
    !ADDRESS.test(log.address) ||
    log.topics?.[0]?.toLowerCase() !== TOPIC0 ||
    !SELECTOR_TOPICS.includes(log.topics?.[1]?.toLowerCase())
  )
    throw new Error('Unexpected gate Submit log')
  const { args } = decodeEventLog({
    abi: [SUBMIT],
    topics: log.topics,
    data: log.data,
    strict: true,
  })
  const event = {
    vault: log.address.toLowerCase(),
    block: safeNumber(log.blockNumber),
    blockHash: log.blockHash,
    transactionIndex: safeNumber(log.transactionIndex),
    txHash: log.transactionHash,
    logIndex: safeNumber(log.logIndex),
    timestamp,
    selector: args.selector.toLowerCase(),
    data: args.data,
    executableAt: args.executableAt.toString(),
  }
  if (
    !HASH.test(event.blockHash) ||
    !HASH.test(event.txHash) ||
    !Number.isSafeInteger(timestamp) ||
    event.selector !== log.topics[1].slice(0, 10).toLowerCase() ||
    !HEX.test(event.data)
  )
    throw new Error('Malformed gate Submit log')
  return event
}

function assertEvents(events, from, through) {
  let block = -1,
    index = -1
  for (const event of events) {
    if (
      !ADDRESS.test(event.vault) ||
      !HASH.test(event.blockHash) ||
      !HASH.test(event.txHash) ||
      !Number.isSafeInteger(event.block) ||
      event.block < from ||
      event.block > through ||
      !Number.isSafeInteger(event.transactionIndex) ||
      !Number.isSafeInteger(event.logIndex) ||
      !Number.isSafeInteger(event.timestamp) ||
      !SELECTORS.includes(event.selector) ||
      !HEX.test(event.data) ||
      !/^\d+$/.test(event.executableAt) ||
      event.block < block ||
      (event.block === block && event.logIndex <= index)
    )
      throw new Error('Invalid or unordered gate Submit event')
    block = event.block
    index = event.logIndex
  }
}

export function validateCheckpoint(saved, expected) {
  const through = saved?.nextChunk
    ? expected.ranges[saved.nextChunk - 1]?.toBlock
    : expected.from - 1
  if (
    saved?.study !== STUDY ||
    saved.chainId !== 1 ||
    saved.factoryArtifactSha256 !== FACTORY_SHA ||
    saved.pinnedHeadHash !== expected.headHash ||
    saved.from !== expected.from ||
    saved.to !== expected.to ||
    saved.chunkBlocks !== expected.chunkBlocks ||
    saved.topic0 !== TOPIC0 ||
    JSON.stringify(saved.selectorTopics) !== JSON.stringify(SELECTOR_TOPICS) ||
    !['partial', 'complete'].includes(saved.status) ||
    !Number.isSafeInteger(saved.nextChunk) ||
    saved.nextChunk < 0 ||
    saved.nextChunk > expected.ranges.length ||
    !Array.isArray(saved.rawEvents) ||
    !Array.isArray(saved.classifications) ||
    !Number.isSafeInteger(saved.nextEvent) ||
    saved.nextEvent !== saved.classifications.length ||
    saved.nextEvent > saved.rawEvents.length ||
    saved.coverage?.throughBlock !== through ||
    saved.coverage?.chunksComplete !== saved.nextChunk ||
    saved.coverage?.chunksExpected !== expected.ranges.length ||
    saved.coverage?.complete !== (saved.nextChunk === expected.ranges.length) ||
    (saved.status === 'complete' &&
      (saved.nextChunk !== expected.ranges.length || saved.nextEvent !== saved.rawEvents.length))
  )
    throw new Error('Gate checkpoint metadata mismatch')
  assertEvents(saved.rawEvents, expected.from, through)
  return saved
}

export function freezeRaw(saved, rawOut) {
  if (!saved.coverage.complete) throw new Error('Cannot freeze incomplete raw gate scan')
  const raw = {
    study: RAW_STUDY,
    chainId: 1,
    factoryArtifactSha256: FACTORY_SHA,
    pinnedHeadHash: saved.pinnedHeadHash,
    source: SOURCE,
    from: saved.from,
    to: saved.to,
    chunkBlocks: saved.chunkBlocks,
    topic0: TOPIC0,
    selectorTopics: SELECTOR_TOPICS,
    coverage: saved.coverage,
    rawEvents: saved.rawEvents,
    summary: {
      count: saved.rawEvents.length,
      sendShares: saved.rawEvents.filter((e) => e.selector === SEND_SHARES_SELECTOR).length,
      receiveAssets: saved.rawEvents.filter((e) => e.selector === RECEIVE_ASSETS_SELECTOR).length,
    },
  }
  const bytes = JSON.stringify(raw)
  const expectedSha = sha(bytes)
  if (existsSync(rawOut)) {
    if (sha(readFileSync(rawOut)) !== expectedSha) throw new Error('Frozen gate raw SHA mismatch')
  } else atomic(rawOut, raw)
  return expectedSha
}

export async function classify(
  event,
  client,
  rpcRead = (method, params) => client.request({ method, params }),
) {
  const call = decodeGateCall(event)
  if (!call) return { class: 'malformed', reason: 'noncanonical-or-undecodable-gate-call' }
  const leadSeconds = Number(BigInt(event.executableAt) - BigInt(event.timestamp))
  const base = { ...call, leadSeconds, nonzero: call.proposedGate !== ZERO }
  if (!Number.isSafeInteger(leadSeconds) || leadSeconds < 0)
    return { ...base, class: 'malformed', reason: 'invalid-executable-time' }
  if (leadSeconds < 21_600)
    return {
      ...base,
      class: 'short-lead',
      reason: leadSeconds === 0 ? 'zero-lead-setup' : 'under-six-hours',
    }
  if (call.proposedGate === ZERO)
    return { ...base, class: 'disabling-gate', reason: 'zero-address-cannot-introduce-gate' }
  const at = BigInt(event.block - 1)
  const [supplyBeforeBlock, abdicatedBeforeBlock, gateBeforeBlock] = await Promise.all([
    retry(() =>
      client.readContract({
        address: event.vault,
        abi: STATE_ABI,
        functionName: 'totalSupply',
        blockNumber: at,
      }),
    ),
    retry(() =>
      client.readContract({
        address: event.vault,
        abi: STATE_ABI,
        functionName: 'abdicated',
        args: [event.selector],
        blockNumber: at,
      }),
    ),
    retry(() =>
      client.readContract({
        address: event.vault,
        abi: STATE_ABI,
        functionName: call.kind === 'send-shares' ? 'sendSharesGate' : 'receiveAssetsGate',
        blockNumber: at,
      }),
    ),
  ])
  let supply = supplyBeforeBlock,
    abdicated = abdicatedBeforeBlock,
    currentGate = gateBeforeBlock.toLowerCase(),
    ambiguous = false
  const blockLogs = await retry(() =>
    rpcRead('eth_getLogs', [
      {
        address: event.vault,
        fromBlock: toHex(event.block),
        toBlock: toHex(event.block),
        topics: [[TRANSFER_TOPIC, ABDICATE_TOPIC, SET_SEND_SHARES_TOPIC, SET_RECEIVE_ASSETS_TOPIC]],
      },
    ]),
  )
  for (const log of blockLogs) {
    const logIndex = safeNumber(log.logIndex)
    if (logIndex >= event.logIndex) continue
    if (log.blockHash?.toLowerCase() !== event.blockHash.toLowerCase()) {
      ambiguous = true
      continue
    }
    try {
      if (log.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC) {
        const { args } = decodeEventLog({
          abi: [TRANSFER],
          topics: log.topics,
          data: log.data,
          strict: true,
        })
        if (args.from.toLowerCase() === ZERO && args.to.toLowerCase() !== ZERO) supply += args.value
        else if (args.to.toLowerCase() === ZERO && args.from.toLowerCase() !== ZERO)
          supply -= args.value
      } else if (log.topics?.[0]?.toLowerCase() === ABDICATE_TOPIC) {
        const { args } = decodeEventLog({
          abi: [ABDICATE],
          topics: log.topics,
          data: log.data,
          strict: true,
        })
        if (args.selector.toLowerCase() === event.selector) abdicated = true
      } else if (log.topics?.[0]?.toLowerCase() === SET_SEND_SHARES_TOPIC) {
        const { args } = decodeEventLog({
          abi: [SET_SEND_SHARES],
          topics: log.topics,
          data: log.data,
          strict: true,
        })
        if (call.kind === 'send-shares') currentGate = args.newSendSharesGate.toLowerCase()
      } else if (log.topics?.[0]?.toLowerCase() === SET_RECEIVE_ASSETS_TOPIC) {
        const { args } = decodeEventLog({
          abi: [SET_RECEIVE_ASSETS],
          topics: log.topics,
          data: log.data,
          strict: true,
        })
        if (call.kind === 'receive-assets') currentGate = args.newReceiveAssetsGate.toLowerCase()
      } else ambiguous = true
    } catch {
      ambiguous = true
    }
  }
  const preState = {
    supplyBeforeBlock: supplyBeforeBlock.toString(),
    supplyAtSubmit: supply.toString(),
    abdicatedBeforeBlock,
    abdicatedAtSubmit: abdicated,
    gateBeforeBlock: gateBeforeBlock.toLowerCase(),
    gateAtSubmit: currentGate,
  }
  if (ambiguous || supply < 0n)
    return { ...base, preState, class: 'ambiguous', reason: 'same-block-pre-log-state-ambiguous' }
  if (abdicated)
    return { ...base, preState, class: 'abdicated', reason: 'selector-abdicated-at-submit' }
  if (supply === 0n)
    return { ...base, preState, class: 'unfunded', reason: 'zero-pre-submit-share-supply' }
  if (currentGate === call.proposedGate)
    return { ...base, preState, class: 'no-op-gate', reason: 'proposed-gate-already-installed' }
  return {
    ...base,
    preState,
    class: 'candidate',
    reason: 'nonzero-gate-with-six-hour-lead-and-positive-supply',
  }
}

export function summarize(saved) {
  const counts = {}
  for (const c of saved.classifications) counts[c.class] = (counts[c.class] || 0) + 1
  return {
    rawSubmitCount: saved.rawEvents.length,
    classifiedCount: saved.classifications.length,
    bySelector: {
      sendShares: saved.rawEvents.filter((e) => e.selector === SEND_SHARES_SELECTOR).length,
      receiveAssets: saved.rawEvents.filter((e) => e.selector === RECEIVE_ASSETS_SELECTOR).length,
    },
    nonzeroProposals: saved.classifications.filter((c) => c.nonzero).length,
    sixHourNonzeroProposals: saved.classifications.filter(
      (c) => c.nonzero && c.leadSeconds >= 21_600,
    ).length,
    classes: counts,
  }
}

export function verifyOffline(out, rawOut, factoryPath) {
  readFactory(factoryPath)
  const saved = JSON.parse(readFileSync(out, 'utf8'))
  const expected = {
    from: FROM_BLOCK,
    to: TO_BLOCK,
    chunkBlocks: CHUNK_BLOCKS,
    ranges: ranges(),
    headHash: saved.pinnedHeadHash,
  }
  if (!HASH.test(expected.headHash)) throw new Error('Missing pinned head hash')
  validateCheckpoint(saved, expected)
  if (saved.status !== 'complete') throw new Error('Gate census incomplete')
  if (freezeRaw(saved, rawOut) !== saved.rawArtifactSha256)
    throw new Error('Raw artifact/checkpoint SHA mismatch')
  saved.rawEvents.forEach((event, index) => {
    const call = decodeGateCall(event)
    const classification = saved.classifications[index]
    if (!classification || (call === null) !== (classification.class === 'malformed'))
      throw new Error('Offline gate classification mismatch')
  })
  if (JSON.stringify(saved.summary) !== JSON.stringify(summarize(saved)))
    throw new Error('Gate summary mismatch')
  return {
    checkpointSha256: sha(readFileSync(out)),
    rawSha256: saved.rawArtifactSha256,
    summary: saved.summary,
  }
}

export async function collect({
  client,
  out,
  rawOut,
  factoryPath,
  maxChunks = Infinity,
  maxEvents = Infinity,
  reclassify = false,
  rpcRead = (method, params) => client.request({ method, params }),
  onProgress = () => {},
}) {
  const vaults = readFactory(factoryPath)
  if (toEventSelector(SUBMIT).toLowerCase() !== TOPIC0) throw new Error('Submit ABI/topic mismatch')
  const chainId = await retry(() => client.getChainId())
  if (chainId !== 1) throw new Error('Wrong chain ID')
  const head = await retry(() => client.getBlock({ blockNumber: BigInt(TO_BLOCK) }))
  if (!HASH.test(head.hash)) throw new Error('Bad pinned head hash')
  const chunkRanges = ranges()
  const expected = {
    from: FROM_BLOCK,
    to: TO_BLOCK,
    chunkBlocks: CHUNK_BLOCKS,
    ranges: chunkRanges,
    headHash: head.hash,
  }
  let saved = existsSync(out)
    ? JSON.parse(readFileSync(out, 'utf8'))
    : {
        study: STUDY,
        chainId: 1,
        factoryArtifactSha256: FACTORY_SHA,
        pinnedHeadHash: head.hash,
        source: SOURCE,
        from: FROM_BLOCK,
        to: TO_BLOCK,
        chunkBlocks: CHUNK_BLOCKS,
        topic0: TOPIC0,
        selectorTopics: SELECTOR_TOPICS,
        status: 'partial',
        nextChunk: 0,
        nextEvent: 0,
        rawEvents: [],
        classifications: [],
        coverage: {
          throughBlock: FROM_BLOCK - 1,
          chunksComplete: 0,
          chunksExpected: chunkRanges.length,
          complete: false,
        },
      }
  validateCheckpoint(saved, expected)
  if (reclassify) {
    if (!saved.coverage.complete || !saved.rawArtifactSha256)
      throw new Error('Cannot reclassify before raw snapshot is frozen')
    saved = { ...saved, status: 'partial', nextEvent: 0, classifications: [] }
    delete saved.summary
    atomic(out, saved)
  }
  if (!existsSync(out)) atomic(out, saved)
  const stopAt = Math.min(chunkRanges.length, saved.nextChunk + maxChunks)
  for (let i = saved.nextChunk; i < stopAt; i++) {
    const range = chunkRanges[i]
    const logs = await retry(() =>
      rpcRead('eth_getLogs', [
        {
          fromBlock: toHex(range.fromBlock),
          toBlock: toHex(range.toBlock),
          topics: [TOPIC0, SELECTOR_TOPICS],
        },
      ]),
    )
    const headers = new Map(),
      additions = []
    for (const raw of logs) {
      if (!vaults.has(raw.address?.toLowerCase())) continue
      const block = safeNumber(raw.blockNumber)
      if (block < range.fromBlock || block > range.toBlock)
        throw new Error('Gate Submit outside requested range')
      if (!headers.has(block)) {
        const header = await retry(() => client.getBlock({ blockNumber: BigInt(block) }))
        if (header.hash?.toLowerCase() !== raw.blockHash?.toLowerCase())
          throw new Error('Gate Submit block-hash mismatch')
        headers.set(block, safeNumber(header.timestamp))
      }
      additions.push(decodeSubmit(raw, headers.get(block)))
    }
    additions.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
    saved = {
      ...saved,
      nextChunk: i + 1,
      rawEvents: [...saved.rawEvents, ...additions],
      coverage: {
        throughBlock: range.toBlock,
        chunksComplete: i + 1,
        chunksExpected: chunkRanges.length,
        complete: i + 1 === chunkRanges.length,
      },
    }
    validateCheckpoint(saved, expected)
    atomic(out, saved)
    onProgress({ phase: 'raw', chunksComplete: saved.nextChunk, events: saved.rawEvents.length })
  }
  if (saved.coverage.complete) {
    const rawSha = freezeRaw(saved, rawOut)
    if (saved.rawArtifactSha256 && saved.rawArtifactSha256 !== rawSha)
      throw new Error('Frozen raw artifact SHA changed')
    saved.rawArtifactSha256 = rawSha
    atomic(out, saved)
  }
  if (!saved.coverage.complete) return saved
  const classifyTo = Math.min(saved.rawEvents.length, saved.nextEvent + maxEvents)
  for (let i = saved.nextEvent; i < classifyTo; i++) {
    const classification = await classify(saved.rawEvents[i], client, rpcRead)
    saved.classifications.push(classification)
    saved.nextEvent = i + 1
    atomic(out, saved)
    onProgress({
      phase: 'classify',
      completed: saved.nextEvent,
      total: saved.rawEvents.length,
      class: classification.class,
    })
  }
  if (saved.nextEvent === saved.rawEvents.length) {
    saved.status = 'complete'
    saved.summary = summarize(saved)
    validateCheckpoint(saved, expected)
    atomic(out, saved)
  }
  return saved
}

function options(args) {
  const parsed = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || args[i + 1] === undefined)
      throw new Error('Expected --key value arguments')
    parsed[args[i].slice(2)] = args[i + 1]
  }
  return parsed
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = options(process.argv.slice(2))
  const out = resolve(opts.out || 'data/research/venue-signals/morpho-v2-gate-submit-census.json')
  const rawOut = resolve(
    opts['raw-out'] || 'data/research/venue-signals/morpho-v2-gate-submit-raw.json',
  )
  const factoryPath = resolve(opts.factory || `data/research/venue-signals/${FACTORY_SHA}.json`)
  try {
    if (opts.verify === 'offline') {
      process.stdout.write(JSON.stringify(verifyOffline(out, rawOut, factoryPath)) + '\n')
    } else {
      const rpc = process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
      if (!rpc) throw new Error('RECORDER_RPC_URL missing')
      const saved = await collect({
        client: makeClient(rpc),
        out,
        rawOut,
        factoryPath,
        maxChunks: opts['max-chunks'] === undefined ? Infinity : Number(opts['max-chunks']),
        maxEvents: opts['max-events'] === undefined ? Infinity : Number(opts['max-events']),
        reclassify: opts.reclassify === 'true',
        onProgress: (event) => process.stdout.write(JSON.stringify(event) + '\n'),
      })
      process.stdout.write(
        JSON.stringify({
          status: saved.status,
          nextChunk: saved.nextChunk,
          nextEvent: saved.nextEvent,
          summary: saved.summary || null,
        }) + '\n',
      )
    }
  } catch (error) {
    // Do not print RPC cause text: it may contain credential-bearing URLs.
    process.stderr.write(
      `Gate census stopped; checkpoint remains at ${out}. ${error.message === 'RPC read failed' ? 'RPC read failed.' : 'Validation failed.'}\n`,
    )
    process.exitCode = 1
  }
}
