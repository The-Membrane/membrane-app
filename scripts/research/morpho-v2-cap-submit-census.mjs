// Stage 1 only: immutable factory cohort -> cap Submit logs -> pre-submit eligibility.
// node scripts/research/morpho-v2-cap-submit-census.mjs --max-chunks 1
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseAbiItem,
  toEventSelector,
  toHex,
} from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'morpho-v2-cap-submit-stage1-v1'
export const FACTORY_SHA = '745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa'
export const FROM_BLOCK = 23_375_073
export const TO_BLOCK = 26_052_740
export const CHUNK_BLOCKS = 8_000
export const TOPIC0 = '0x8b18afeb361b83b025999ed5b42f1d90c68aaa5a0fd49c015f04c3b8b81e80eb'
export const SUBMIT = parseAbiItem(
  'event Submit(bytes4 indexed selector, bytes data, uint256 executableAt)',
)
export const CAP_ABI = parseAbi([
  'function increaseAbsoluteCap(bytes idData, uint256 newAbsoluteCap)',
  'function increaseRelativeCap(bytes idData, uint256 newRelativeCap)',
])
export const ABS_SELECTOR = toEventSelector(CAP_ABI[0]).slice(0, 10).toLowerCase()
export const REL_SELECTOR = toEventSelector(CAP_ABI[1]).slice(0, 10).toLowerCase()
export const SELECTOR_TOPICS = [ABS_SELECTOR, REL_SELECTOR].map(
  (x) => `0x${x.slice(2).padEnd(64, '0')}`,
)
const STATE_ABI = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function absoluteCap(bytes32 id) view returns (uint256)',
  'function relativeCap(bytes32 id) view returns (uint256)',
  'function abdicated(bytes4 selector) view returns (bool)',
])
const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)
const CAP_CHANGE_TOPICS = [
  parseAbiItem(
    'event IncreaseAbsoluteCap(bytes32 indexed id, bytes idData, uint256 newAbsoluteCap)',
  ),
  parseAbiItem(
    'event DecreaseAbsoluteCap(address indexed sender, bytes32 indexed id, bytes idData, uint256 newAbsoluteCap)',
  ),
  parseAbiItem(
    'event IncreaseRelativeCap(bytes32 indexed id, bytes idData, uint256 newRelativeCap)',
  ),
  parseAbiItem(
    'event DecreaseRelativeCap(address indexed sender, bytes32 indexed id, bytes idData, uint256 newRelativeCap)',
  ),
  parseAbiItem('event Abdicate(bytes4 indexed selector)'),
].map(toEventSelector)
const ZERO = `0x${'0'.repeat(40)}`
const ADDRESS = /^0x[\da-fA-F]{40}$/
const HASH = /^0x[\da-fA-F]{64}$/
const HEX = /^0x(?:[\da-fA-F]{2})*$/

export function ranges(from = FROM_BLOCK, to = TO_BLOCK, size = CHUNK_BLOCKS) {
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from > to ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > CHUNK_BLOCKS
  )
    throw new Error('Invalid bounded scan range')
  const out = []
  for (let first = from; first <= to; first += size)
    out.push({ fromBlock: first, toBlock: Math.min(to, first + size - 1) })
  return out
}

export function readFactory(path) {
  const bytes = readFileSync(path)
  const sha = createHash('sha256').update(bytes).digest('hex')
  if (sha !== FACTORY_SHA) throw new Error('Factory artifact SHA mismatch')
  const saved = JSON.parse(bytes)
  if (
    saved.study !== 'morpho-v2-factory-create-v1' ||
    saved.status !== 'complete' ||
    saved.from !== FROM_BLOCK ||
    saved.to !== TO_BLOCK ||
    saved.coverage?.throughBlock !== TO_BLOCK ||
    saved.summary?.uniqueVaultCount !== 757 ||
    saved.events?.length !== 757
  )
    throw new Error('Factory artifact metadata mismatch')
  const vaults = new Set(saved.events.map((x) => x.vault.toLowerCase()))
  if (vaults.size !== 757 || [...vaults].some((x) => !ADDRESS.test(x)))
    throw new Error('Factory artifact vault set mismatch')
  return vaults
}

export function decodeSubmit(log, timestamp) {
  if (
    !ADDRESS.test(log.address) ||
    log.topics?.[0]?.toLowerCase() !== TOPIC0 ||
    !SELECTOR_TOPICS.includes(log.topics?.[1]?.toLowerCase())
  )
    throw new Error('Unexpected Submit log')
  const { args } = decodeEventLog({
    abi: [SUBMIT],
    topics: log.topics,
    data: log.data,
    strict: true,
  })
  const block = Number(log.blockNumber),
    transactionIndex = Number(log.transactionIndex)
  const logIndex = Number(log.logIndex)
  if (
    ![block, transactionIndex, logIndex, timestamp].every(Number.isSafeInteger) ||
    !HASH.test(log.blockHash) ||
    !HASH.test(log.transactionHash) ||
    args.selector.toLowerCase() !== log.topics[1].slice(0, 10).toLowerCase() ||
    !HEX.test(args.data) ||
    args.executableAt < 0n
  )
    throw new Error('Malformed Submit log')
  return {
    vault: log.address,
    block,
    blockHash: log.blockHash,
    transactionIndex,
    txHash: log.transactionHash,
    logIndex,
    timestamp,
    selector: args.selector.toLowerCase(),
    data: args.data,
    executableAt: args.executableAt.toString(),
  }
}

export function decodeCapCall(event) {
  try {
    if (event.data.slice(0, 10).toLowerCase() !== event.selector)
      throw new Error('Selector mismatch')
    const decoded = decodeFunctionData({ abi: CAP_ABI, data: event.data })
    const canonical = encodeFunctionData({
      abi: CAP_ABI,
      functionName: decoded.functionName,
      args: decoded.args,
    })
    if (canonical.toLowerCase() !== event.data.toLowerCase())
      throw new Error('Noncanonical calldata')
    const [idData, cap] = decoded.args
    if (!HEX.test(idData)) throw new Error('Invalid ID data')
    return {
      kind: decoded.functionName === 'increaseAbsoluteCap' ? 'absolute' : 'relative',
      allocationId: keccak256(idData),
      idData,
      proposedCap: cap.toString(),
    }
  } catch {
    return null
  }
}

function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  renameSync(temp, path)
}

async function retry(operation, retries, pause) {
  for (let i = 0; ; i++) {
    try {
      return await operation()
    } catch (error) {
      if (i >= retries) throw new Error('RPC read failed', { cause: error })
      await pause(Math.min(10_000, 500 * 2 ** i))
    }
  }
}

export function validateCheckpoint(saved, expected) {
  if (
    saved?.study !== STUDY ||
    saved.chainId !== 1 ||
    saved.factoryArtifactSha256 !== FACTORY_SHA ||
    saved.pinnedHeadHash !== expected.headHash ||
    (saved.status === 'complete' && !HASH.test(`0x${saved.rawArtifactSha256 || ''}`)) ||
    saved.from !== expected.from ||
    saved.to !== expected.to ||
    saved.chunkBlocks !== expected.chunkBlocks ||
    saved.topic0 !== TOPIC0 ||
    !['partial', 'complete'].includes(saved.status) ||
    !Number.isSafeInteger(saved.nextChunk) ||
    saved.nextChunk < 0 ||
    saved.nextChunk > expected.ranges.length ||
    !Number.isSafeInteger(saved.nextEvent) ||
    saved.nextEvent < 0 ||
    !Array.isArray(saved.rawEvents) ||
    saved.nextEvent > saved.rawEvents.length ||
    !Array.isArray(saved.classifications) ||
    saved.classifications.length !== saved.nextEvent ||
    (saved.status === 'complete' &&
      (saved.nextChunk !== expected.ranges.length || saved.nextEvent !== saved.rawEvents.length))
  )
    throw new Error('Checkpoint metadata mismatch')
  const through = saved.nextChunk ? expected.ranges[saved.nextChunk - 1].toBlock : expected.from - 1
  if (
    saved.coverage?.fromBlock !== expected.from ||
    saved.coverage?.throughBlock !== through ||
    saved.coverage?.chunksComplete !== saved.nextChunk ||
    saved.coverage?.chunksExpected !== expected.ranges.length ||
    saved.coverage?.complete !== (saved.nextChunk === expected.ranges.length)
  )
    throw new Error('Checkpoint coverage mismatch')
  let block = -1,
    index = -1
  for (const event of saved.rawEvents) {
    if (
      !ADDRESS.test(event.vault) ||
      !HASH.test(event.blockHash) ||
      !HASH.test(event.txHash) ||
      !Number.isSafeInteger(event.block) ||
      event.block < expected.from ||
      event.block > through ||
      !Number.isSafeInteger(event.logIndex) ||
      !Number.isSafeInteger(event.transactionIndex) ||
      !Number.isSafeInteger(event.timestamp) ||
      !HEX.test(event.data) ||
      ![ABS_SELECTOR, REL_SELECTOR].includes(event.selector) ||
      !/^\d+$/.test(event.executableAt) ||
      event.block < block ||
      (event.block === block && event.logIndex <= index)
    )
      throw new Error('Checkpoint event mismatch')
    block = event.block
    index = event.logIndex
  }
  return saved
}

const number = (hex) => Number(BigInt(hex))
function rpcLog(log) {
  return {
    ...log,
    blockNumber: number(log.blockNumber),
    transactionIndex: number(log.transactionIndex),
    logIndex: number(log.logIndex),
  }
}

export async function classify(event, client, rpcRead, retries, pause) {
  const call = decodeCapCall(event)
  if (!call) return { class: 'malformed', reason: 'noncanonical-or-undecodable-cap-call' }
  const leadSeconds = Number(BigInt(event.executableAt) - BigInt(event.timestamp))
  const base = { ...call, leadSeconds, proposedCap: call.proposedCap }
  if (!Number.isSafeInteger(leadSeconds) || leadSeconds < 0)
    return { ...base, class: 'malformed', reason: 'invalid-executable-time' }
  if (leadSeconds < 21_600)
    return {
      ...base,
      class: 'short-lead',
      reason: leadSeconds === 0 ? 'zero-lead-setup' : 'under-six-hours',
    }
  const blockNumber = BigInt(event.block - 1)
  const read = (functionName, args = []) =>
    retry(
      () =>
        client.readContract({
          address: event.vault,
          abi: STATE_ABI,
          functionName,
          args,
          blockNumber,
        }),
      retries,
      pause,
    )
  const [abdicated, oldCap, supplyBeforeBlock] = await Promise.all([
    read('abdicated', [event.selector]),
    read(call.kind === 'absolute' ? 'absoluteCap' : 'relativeCap', [call.allocationId]),
    read('totalSupply'),
  ])
  const preState = {
    abdicated,
    oldCap: oldCap.toString(),
    supplyBeforeBlock: supplyBeforeBlock.toString(),
  }
  const blockLogs = await retry(
    () =>
      rpcRead('eth_getLogs', [
        {
          address: event.vault,
          fromBlock: toHex(event.block),
          toBlock: toHex(event.block),
          topics: [[toEventSelector(TRANSFER), ...CAP_CHANGE_TOPICS]],
        },
      ]),
    retries,
    pause,
  )
  let supply = supplyBeforeBlock,
    ambiguous = false
  for (const raw of blockLogs) {
    const log = rpcLog(raw)
    if (log.logIndex >= event.logIndex) continue
    if (log.blockHash?.toLowerCase() !== event.blockHash.toLowerCase()) {
      ambiguous = true
      continue
    }
    if (log.topics[0].toLowerCase() !== toEventSelector(TRANSFER).toLowerCase()) {
      ambiguous = true
      continue
    }
    let args
    try {
      ;({ args } = decodeEventLog({
        abi: [TRANSFER],
        data: log.data,
        topics: log.topics,
        strict: true,
      }))
    } catch {
      ambiguous = true
      continue
    }
    if (args.from.toLowerCase() === ZERO && args.to.toLowerCase() !== ZERO) supply += args.value
    else if (args.to.toLowerCase() === ZERO && args.from.toLowerCase() !== ZERO)
      supply -= args.value
  }
  preState.supplyAtSubmit = supply.toString()
  if (ambiguous || supply < 0n)
    return { ...base, preState, class: 'ambiguous', reason: 'same-block-pre-log-state-mutation' }
  if (abdicated)
    return { ...base, preState, class: 'abdicated', reason: 'selector-abdicated-before-block' }
  if (call.kind === 'absolute' && BigInt(call.proposedCap) > (1n << 128n) - 1n)
    return { ...base, preState, class: 'malformed', reason: 'absolute-cap-over-uint128' }
  if (call.kind === 'relative' && BigInt(call.proposedCap) > 10n ** 18n)
    return { ...base, preState, class: 'malformed', reason: 'relative-cap-above-one' }
  if (BigInt(call.proposedCap) <= oldCap)
    return { ...base, preState, class: 'non-increasing', reason: 'cap-already-satisfied-or-lower' }
  if (supply === 0n)
    return { ...base, preState, class: 'unfunded', reason: 'zero-pre-submit-share-supply' }
  return {
    ...base,
    preState,
    class: 'eligible',
    reason: 'positive-lead-positive-pre-submit-supply',
  }
}

export function proposals(rawEvents, classifications) {
  const groups = new Map()
  rawEvents.forEach((event, i) => {
    const classification = classifications[i]
    const key = classification.allocationId
      ? `${event.vault.toLowerCase()}:${classification.allocationId}:${event.txHash.toLowerCase()}`
      : `${event.txHash.toLowerCase()}:${event.logIndex}`
    if (!groups.has(key))
      groups.set(key, {
        vault: event.vault,
        allocationId: classification.allocationId || null,
        txHash: event.txHash,
        block: event.block,
        timestamp: event.timestamp,
        rawEventIndexes: [],
        classes: [],
        executableAts: [],
        leadSeconds: [],
      })
    const group = groups.get(key)
    group.rawEventIndexes.push(i)
    group.classes.push(classification.class)
    group.executableAts.push(event.executableAt)
    group.leadSeconds.push(classification.leadSeconds ?? null)
  })
  return [...groups.values()].map((group) => ({
    ...group,
    qualifyingLegCount: group.classes.filter((x) => x === 'eligible').length,
    class: group.classes.every((x) => x === 'eligible')
      ? 'eligible'
      : group.classes.includes('eligible')
        ? 'mixed-eligible'
        : group.classes[0],
  }))
}

export function summary(rawEvents, classifications, grouped) {
  const classCounts = {},
    proposalClassCounts = {}
  for (const x of classifications) classCounts[x.class] = (classCounts[x.class] || 0) + 1
  for (const x of grouped) proposalClassCounts[x.class] = (proposalClassCounts[x.class] || 0) + 1
  const eligible = grouped
    .map((x, index) => ({ ...x, index }))
    .filter((x) => x.qualifyingLegCount > 0)
    .sort((a, b) => a.timestamp - b.timestamp || a.block - b.block)
  const anchors = new Map(),
    independent = []
  for (const proposal of eligible) {
    const vault = proposal.vault.toLowerCase()
    const anchor = anchors.get(vault)
    if (anchor === undefined || proposal.timestamp - anchor > 7 * 24 * 3600) {
      anchors.set(vault, proposal.timestamp)
      independent.push(proposal)
    }
  }
  return {
    rawSubmitCount: rawEvents.length,
    classifiedCount: classifications.length,
    classCounts,
    proposalCount: grouped.length,
    proposalClassCounts,
    eligibleProposalCount: eligible.length,
    eligibleDates: eligible.map((x) => new Date(x.timestamp * 1000).toISOString().slice(0, 10)),
    independentEligibleCount: independent.length,
    independentEligibleProposalIndexes: independent.map((x) => x.index),
    independentEligibleDates: independent.map((x) =>
      new Date(x.timestamp * 1000).toISOString().slice(0, 10),
    ),
    independenceWindowSeconds: 7 * 24 * 3600,
    preregisteredMinimum: 20,
    followThroughPermitted: independent.length >= 20,
  }
}

export function freezeRawSnapshot(saved, path) {
  if (!saved.coverage.complete || saved.nextChunk !== saved.coverage.chunksExpected)
    throw new Error('Cannot freeze incomplete raw scan')
  const selectorCounts = { absolute: 0, relative: 0 }
  for (const event of saved.rawEvents)
    selectorCounts[event.selector === ABS_SELECTOR ? 'absolute' : 'relative']++
  const snapshot = {
    study: 'morpho-v2-cap-submit-raw-v1',
    chainId: 1,
    factoryArtifactSha256: FACTORY_SHA,
    pinnedHeadHash: saved.pinnedHeadHash,
    from: saved.from,
    to: saved.to,
    chunkBlocks: saved.chunkBlocks,
    topic0: TOPIC0,
    selectorTopics: SELECTOR_TOPICS,
    coverage: saved.coverage,
    rawEvents: saved.rawEvents,
    summary: {
      rawSubmitCount: saved.rawEvents.length,
      selectorCounts,
      uniqueVaultCount: new Set(saved.rawEvents.map((x) => x.vault.toLowerCase())).size,
    },
  }
  const bytes = JSON.stringify(snapshot)
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') !== bytes) throw new Error('Frozen raw snapshot mismatch')
  } else atomic(path, snapshot)
  return createHash('sha256').update(bytes).digest('hex')
}

export async function collect({
  client,
  rpcRead = (method, params) => client.request({ method, params }),
  out,
  rawOut = `${out}.raw.json`,
  vaults,
  from = FROM_BLOCK,
  to = TO_BLOCK,
  chunkBlocks = CHUNK_BLOCKS,
  maxChunks = Infinity,
  maxEvents = Infinity,
  retries = 3,
  pause = (ms) => new Promise((done) => setTimeout(done, ms)),
  onProgress = () => {},
}) {
  if (
    toEventSelector(SUBMIT).toLowerCase() !== TOPIC0 ||
    ABS_SELECTOR !== '0xf6f98fd5' ||
    REL_SELECTOR !== '0x2438525b'
  )
    throw new Error('Official Submit ABI or cap selector mismatch')
  const chainId = await retry(() => client.getChainId(), retries, pause)
  if (chainId !== 1) throw new Error('Wrong chain ID')
  const head = await retry(() => client.getBlock({ blockNumber: BigInt(to) }), retries, pause)
  if (!HASH.test(head.hash)) throw new Error('Invalid pinned head hash')
  const chunkRanges = ranges(from, to, chunkBlocks)
  const expected = { from, to, chunkBlocks, ranges: chunkRanges, headHash: head.hash }
  let saved = existsSync(out)
    ? JSON.parse(readFileSync(out, 'utf8'))
    : {
        study: STUDY,
        chainId: 1,
        factoryArtifactSha256: FACTORY_SHA,
        pinnedHeadHash: head.hash,
        source: 'https://github.com/morpho-org/vault-v2/blob/main/src/VaultV2.sol',
        from,
        to,
        chunkBlocks,
        topic0: TOPIC0,
        selectorTopics: SELECTOR_TOPICS,
        status: 'partial',
        nextChunk: 0,
        nextEvent: 0,
        rawEvents: [],
        classifications: [],
        coverage: {
          fromBlock: from,
          throughBlock: from - 1,
          chunksComplete: 0,
          chunksExpected: chunkRanges.length,
          complete: false,
        },
      }
  // Upgrade the checkpoint created by the pilot before the head pin was added.
  if (saved.pinnedHeadHash === undefined && saved.status === 'partial' && saved.nextEvent === 0) {
    saved.pinnedHeadHash = head.hash
    atomic(out, saved)
  }
  if (saved.coverage?.complete) {
    const rawSha = freezeRawSnapshot(saved, rawOut)
    if (saved.rawArtifactSha256 && saved.rawArtifactSha256 !== rawSha)
      throw new Error('Frozen raw artifact SHA mismatch')
    if (!saved.rawArtifactSha256) {
      saved.rawArtifactSha256 = rawSha
      atomic(out, saved)
    }
  }
  validateCheckpoint(saved, expected)
  if (!existsSync(out)) atomic(out, saved)
  const stopAt = Math.min(chunkRanges.length, saved.nextChunk + maxChunks)
  for (let i = saved.nextChunk; i < stopAt; i++) {
    const range = chunkRanges[i]
    const logs = await retry(
      () =>
        rpcRead('eth_getLogs', [
          {
            fromBlock: toHex(range.fromBlock),
            toBlock: toHex(range.toBlock),
            topics: [TOPIC0, SELECTOR_TOPICS],
          },
        ]),
      retries,
      pause,
    )
    const timestamps = new Map(),
      additions = []
    for (const raw of logs) {
      const log = rpcLog(raw)
      if (!vaults.has(log.address.toLowerCase())) continue
      if (log.blockNumber < range.fromBlock || log.blockNumber > range.toBlock)
        throw new Error('Out-of-range Submit log')
      if (!timestamps.has(log.blockNumber)) {
        const header = await retry(
          () => client.getBlock({ blockNumber: BigInt(log.blockNumber) }),
          retries,
          pause,
        )
        if (header.hash.toLowerCase() !== log.blockHash.toLowerCase())
          throw new Error('Log/header block hash mismatch')
        timestamps.set(log.blockNumber, Number(header.timestamp))
      }
      additions.push(decodeSubmit(log, timestamps.get(log.blockNumber)))
    }
    additions.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
    saved = {
      ...saved,
      nextChunk: i + 1,
      rawEvents: [...saved.rawEvents, ...additions],
      coverage: {
        fromBlock: from,
        throughBlock: range.toBlock,
        chunksComplete: i + 1,
        chunksExpected: chunkRanges.length,
        complete: i + 1 === chunkRanges.length,
      },
    }
    validateCheckpoint(saved, expected)
    atomic(out, saved)
    onProgress(saved)
  }
  if (saved.coverage.complete) {
    const rawSha = freezeRawSnapshot(saved, rawOut)
    if (saved.rawArtifactSha256 && saved.rawArtifactSha256 !== rawSha)
      throw new Error('Frozen raw artifact SHA mismatch')
    saved = { ...saved, rawArtifactSha256: rawSha }
    atomic(out, saved)
  }
  const classifyTo = Math.min(saved.rawEvents.length, saved.nextEvent + maxEvents)
  for (let i = saved.nextEvent; i < classifyTo; i++) {
    let classification
    try {
      classification = await classify(saved.rawEvents[i], client, rpcRead, retries, pause)
    } catch (error) {
      atomic(out, saved)
      throw error
    }
    saved = {
      ...saved,
      nextEvent: i + 1,
      classifications: [...saved.classifications, classification],
    }
    if (saved.nextEvent % 25 === 0 || saved.nextEvent === classifyTo) atomic(out, saved)
    onProgress(saved)
  }
  if (saved.coverage.complete && saved.nextEvent === saved.rawEvents.length) {
    const grouped = proposals(saved.rawEvents, saved.classifications)
    saved = {
      ...saved,
      status: 'complete',
      proposals: grouped,
      summary: summary(saved.rawEvents, saved.classifications, grouped),
    }
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
  const rpc = opts.rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
  if (!rpc) throw new Error('Set RECORDER_RPC_URL or --rpc')
  const out = resolve(opts.out || 'data/research/venue-signals/morpho-v2-cap-submit-stage1.json')
  try {
    const artifact = resolve(
      opts.factory ||
        'data/research/venue-signals/745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa.json',
    )
    const rawOut = resolve(
      opts['raw-out'] || 'data/research/venue-signals/morpho-v2-cap-submit-raw.json',
    )
    const saved = await collect({
      client: makeClient(rpc),
      out,
      rawOut,
      vaults: readFactory(artifact),
      maxChunks: opts['max-chunks'] === undefined ? Infinity : Number(opts['max-chunks']),
      maxEvents: opts['max-events'] === undefined ? Infinity : Number(opts['max-events']),
      onProgress: (x) => {
        if (x.nextEvent === 0 || x.nextEvent % 100 === 0 || x.nextEvent === x.rawEvents.length)
          process.stdout.write(
            `chunks ${x.nextChunk}/${x.coverage.chunksExpected}, classified ${x.nextEvent}/${x.rawEvents.length}\n`,
          )
      },
    })
    process.stdout.write(
      JSON.stringify({
        path: out,
        status: saved.status,
        coverage: saved.coverage,
        rawSubmitCount: saved.rawEvents.length,
        classifiedCount: saved.nextEvent,
        rawSnapshot: saved.coverage.complete
          ? {
              path: rawOut,
              sha256: createHash('sha256').update(readFileSync(rawOut)).digest('hex'),
            }
          : null,
        summary: saved.summary
          ? {
              classCounts: saved.summary.classCounts,
              proposalClassCounts: saved.summary.proposalClassCounts,
              eligibleProposalCount: saved.summary.eligibleProposalCount,
              independentEligibleCount: saved.summary.independentEligibleCount,
              preregisteredMinimum: saved.summary.preregisteredMinimum,
              followThroughPermitted: saved.summary.followThroughPermitted,
            }
          : null,
        sha256: createHash('sha256').update(readFileSync(out)).digest('hex'),
      }) + '\n',
    )
  } catch (error) {
    // Provider errors can contain credential-bearing RPC URLs. Never print causes or RPC messages.
    process.stderr.write(
      `Cap Submit census stopped; checkpoint remains at ${out}. ${error.message === 'RPC read failed' ? 'RPC read failed.' : 'Validation failed.'}\n`,
    )
    process.exitCode = 1
  }
}
