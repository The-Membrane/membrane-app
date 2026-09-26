// Global, bounded VaultV2 Accept/Revoke census. It does not score exit outcomes.
// Dry: node scripts/research/morpho-v2-cap-lifecycle-census.mjs
// Live: node scripts/research/morpho-v2-cap-lifecycle-census.mjs --run true --max-chunks 1
// Offline: node scripts/research/morpho-v2-cap-lifecycle-census.mjs --verify true
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeEventLog, parseAbiItem, toEventSelector, toHex } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'morpho-v2-cap-lifecycle-census-v1'
export const FACTORY_SHA = '745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa'
export const SUBMIT_SHA = '00ecf6280cf2b6cca5adf595fb823d3178d82b127d6a2535702dbb9032adcdb4'
export const PINNED_HEAD_HASH = '0xf43d7e3b07870c3eef167f2681d6132a337c1c5eefc4a5223e4fdfd4843ad756'
export const FROM_BLOCK = 23_375_073
export const TO_BLOCK = 26_052_740
export const CHUNK_BLOCKS = 8_000
export const RESERVE_BYTES = 2_500_000_000
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
export const ACCEPT = parseAbiItem('event Accept(bytes4 indexed selector,bytes data)')
export const REVOKE = parseAbiItem(
  'event Revoke(address indexed sender,bytes4 indexed selector,bytes data)',
)
export const TOPICS = {
  accept: toEventSelector(ACCEPT).toLowerCase(),
  revoke: toEventSelector(REVOKE).toLowerCase(),
}
const HASH = /^0x[\da-fA-F]{64}$/
const ADDRESS = /^0x[\da-fA-F]{40}$/
const HEX = /^0x(?:[\da-fA-F]{2})*$/
const SELECTOR_TOPIC = /^0x[\da-fA-F]{8}0{56}$/
const SENDER_TOPIC = /^0x0{24}[\da-fA-F]{40}$/
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unsigned = (saved) => {
  const { checkpointSha256, ...rest } = saved
  return rest
}
export const seal = (saved) => ({
  ...unsigned(saved),
  checkpointSha256: sha(JSON.stringify(unsigned(saved))),
})

export function ranges() {
  const result = []
  for (let fromBlock = FROM_BLOCK; fromBlock <= TO_BLOCK; fromBlock += CHUNK_BLOCKS)
    result.push({ fromBlock, toBlock: Math.min(TO_BLOCK, fromBlock + CHUNK_BLOCKS - 1) })
  return result
}

export function readSources(factoryPath, submitPath) {
  const factoryBytes = readFileSync(factoryPath),
    submitBytes = readFileSync(submitPath)
  if (sha(factoryBytes) !== FACTORY_SHA || sha(submitBytes) !== SUBMIT_SHA)
    throw new Error('Frozen source SHA mismatch')
  const factory = JSON.parse(factoryBytes),
    submit = JSON.parse(submitBytes)
  if (
    factory.study !== 'morpho-v2-factory-create-v1' ||
    factory.status !== 'complete' ||
    factory.from !== FROM_BLOCK ||
    factory.to !== TO_BLOCK ||
    factory.coverage?.throughBlock !== TO_BLOCK ||
    factory.events?.length !== 757 ||
    factory.summary?.uniqueVaultCount !== 757 ||
    submit.study !== 'morpho-v2-cap-submit-raw-v1' ||
    submit.chainId !== 1 ||
    submit.factoryArtifactSha256 !== FACTORY_SHA ||
    submit.pinnedHeadHash?.toLowerCase() !== PINNED_HEAD_HASH ||
    submit.from !== FROM_BLOCK ||
    submit.to !== TO_BLOCK ||
    submit.coverage?.complete !== true ||
    submit.rawEvents?.length !== 7_914 ||
    submit.summary?.rawSubmitCount !== 7_914
  )
    throw new Error('Frozen source metadata mismatch')
  const vaults = new Map()
  for (const event of factory.events) {
    const address = event.vault?.toLowerCase()
    if (!ADDRESS.test(address) || vaults.has(address) || !Number.isSafeInteger(event.block))
      throw new Error('Invalid factory vault event')
    vaults.set(address, event.block)
  }
  const keys = new Set()
  for (const event of submit.rawEvents) {
    if (
      !ADDRESS.test(event.vault) ||
      !HASH.test(event.blockHash) ||
      !HASH.test(event.txHash) ||
      !HEX.test(event.data) ||
      event.data.slice(0, 10).toLowerCase() !== event.selector?.toLowerCase() ||
      !Number.isSafeInteger(event.block) ||
      event.block < FROM_BLOCK ||
      event.block > TO_BLOCK ||
      !Number.isSafeInteger(event.logIndex) ||
      !vaults.has(event.vault.toLowerCase())
    )
      throw new Error('Invalid frozen Submit event')
    const coord = `${event.txHash.toLowerCase()}:${event.logIndex}`
    if (keys.has(coord)) throw new Error('Duplicate frozen Submit coordinate')
    keys.add(coord)
  }
  return { vaults, submits: submit.rawEvents }
}

const safeNumber = (value) => {
  const n = typeof value === 'number' ? value : Number(BigInt(value))
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid event coordinate')
  return n
}

export function decodeLifecycle(log) {
  if (
    !ADDRESS.test(log.address) ||
    !HASH.test(log.blockHash) ||
    !HASH.test(log.transactionHash) ||
    !Array.isArray(log.topics) ||
    !HEX.test(log.data)
  )
    throw new Error('Malformed lifecycle log')
  const topic = log.topics[0]?.toLowerCase()
  const kind = topic === TOPICS.accept ? 'accept' : topic === TOPICS.revoke ? 'revoke' : null
  if (
    !kind ||
    log.topics.length !== (kind === 'accept' ? 2 : 3) ||
    !SELECTOR_TOPIC.test(log.topics[kind === 'accept' ? 1 : 2]) ||
    (kind === 'revoke' && !SENDER_TOPIC.test(log.topics[1]))
  )
    throw new Error('Unexpected lifecycle topic layout')
  let args
  try {
    ;({ args } = decodeEventLog({
      abi: [kind === 'accept' ? ACCEPT : REVOKE],
      topics: log.topics,
      data: log.data,
      strict: true,
    }))
  } catch {
    throw new Error('Malformed lifecycle ABI data')
  }
  if (!HEX.test(args.data) || args.data.slice(0, 10).toLowerCase() !== args.selector.toLowerCase())
    throw new Error('Lifecycle selector/calldata mismatch')
  return {
    kind,
    vault: log.address.toLowerCase(),
    selector: args.selector.toLowerCase(),
    data: args.data.toLowerCase(),
    sender: kind === 'revoke' ? args.sender.toLowerCase() : null,
    block: safeNumber(log.blockNumber),
    blockHash: log.blockHash.toLowerCase(),
    transactionIndex: safeNumber(log.transactionIndex),
    txHash: log.transactionHash.toLowerCase(),
    logIndex: safeNumber(log.logIndex),
  }
}

const coordinate = (event) => `${event.txHash}:${event.logIndex}`
export const eventKey = (event) =>
  `${event.vault.toLowerCase()}:${event.selector.toLowerCase()}:${event.data.toLowerCase()}`
const order = (a, b) => a.block - b.block || a.logIndex - b.logIndex

// A sealed, contiguous prefix through the requested as-of block is mandatory. Incomplete
// coverage is unknown, never a clean/no-pending answer. An ambiguous key stays ambiguous.
export function replay(sources, checkpoint, throughBlock) {
  validateCheckpoint(checkpoint, sources)
  if (
    !Number.isSafeInteger(throughBlock) ||
    throughBlock < FROM_BLOCK - 1 ||
    throughBlock > checkpoint.coverage.throughBlock
  )
    throw new Error('Lifecycle replay requires complete scanned prefix through as-of block')
  const ledger = [
    ...sources.submits
      .filter((x) => x.block <= throughBlock)
      .map((x) => ({ ...x, kind: 'submit' })),
    ...checkpoint.events.filter((x) => x.block <= throughBlock),
  ].sort(order)
  const state = new Map(),
    issues = []
  for (const event of ledger) {
    const key = eventKey(event),
      prior = state.get(key) || { pending: false, ambiguous: false, cycles: 0 }
    if (event.kind === 'submit') {
      if (prior.pending) {
        prior.ambiguous = true
        issues.push({ kind: 'duplicate-open', key, block: event.block, logIndex: event.logIndex })
      } else {
        prior.pending = true
        prior.cycles++
      }
    } else if (!prior.pending) {
      prior.ambiguous = true
      issues.push({
        kind: 'settle-without-open',
        key,
        block: event.block,
        logIndex: event.logIndex,
      })
    } else prior.pending = false
    state.set(key, prior)
  }
  return { state, issues, throughBlock, coverageThroughBlock: checkpoint.coverage.throughBlock }
}

export function validateCheckpoint(saved, sources, expected = {}) {
  const all = ranges()
  if (
    saved?.study !== STUDY ||
    saved.chainId !== 1 ||
    saved.factoryArtifactSha256 !== FACTORY_SHA ||
    saved.submitArtifactSha256 !== SUBMIT_SHA ||
    saved.pinnedHeadHash !== PINNED_HEAD_HASH ||
    saved.from !== FROM_BLOCK ||
    saved.to !== TO_BLOCK ||
    saved.chunkBlocks !== CHUNK_BLOCKS ||
    JSON.stringify(saved.topics) !== JSON.stringify(TOPICS) ||
    !Number.isSafeInteger(saved.nextChunk) ||
    saved.nextChunk < 0 ||
    saved.nextChunk > all.length ||
    saved.status !== (saved.nextChunk === all.length ? 'complete' : 'partial') ||
    !Array.isArray(saved.chunks) ||
    saved.chunks.length !== saved.nextChunk ||
    !Array.isArray(saved.events) ||
    !/^[\da-f]{64}$/.test(saved.checkpointSha256 || '') ||
    sha(JSON.stringify(unsigned(saved))) !== saved.checkpointSha256
  )
    throw new Error('Lifecycle checkpoint integrity mismatch')
  let offset = 0,
    nonCohort = 0,
    unmatched = 0
  const submitKeys = new Set(sources.submits.map(eventKey))
  const coordinates = new Set()
  let previous = null
  for (let i = 0; i < saved.chunks.length; i++) {
    const chunk = saved.chunks[i],
      range = all[i]
    if (
      chunk.fromBlock !== range.fromBlock ||
      chunk.toBlock !== range.toBlock ||
      !HASH.test(chunk.fromHash) ||
      !HASH.test(chunk.toHash) ||
      !Number.isSafeInteger(chunk.matchedLogs) ||
      chunk.matchedLogs < 0 ||
      !Number.isSafeInteger(chunk.eventCount) ||
      chunk.eventCount < 0 ||
      !Number.isSafeInteger(chunk.nonCohortLogs) ||
      chunk.nonCohortLogs < 0 ||
      !Number.isSafeInteger(chunk.unmatchedLogs) ||
      chunk.unmatchedLogs < 0 ||
      chunk.matchedLogs !== chunk.eventCount ||
      !/^[\da-f]{64}$/.test(chunk.eventsSha256 || '')
    )
      throw new Error('Lifecycle chunk metadata mismatch')
    const events = saved.events.slice(offset, offset + chunk.eventCount)
    if (events.length !== chunk.eventCount || sha(JSON.stringify(events)) !== chunk.eventsSha256)
      throw new Error('Lifecycle chunk event hash mismatch')
    let localNonCohort = 0,
      localUnmatched = 0
    for (const event of events) {
      if (
        event.block < range.fromBlock ||
        event.block > range.toBlock ||
        !['accept', 'revoke'].includes(event.kind) ||
        !ADDRESS.test(event.vault) ||
        !HASH.test(event.blockHash) ||
        !HASH.test(event.txHash) ||
        !HEX.test(event.data) ||
        event.data.slice(0, 10) !== event.selector ||
        !Number.isSafeInteger(event.transactionIndex) ||
        !Number.isSafeInteger(event.logIndex) ||
        event.transactionIndex < 0 ||
        event.logIndex < 0 ||
        (event.kind === 'revoke' ? !ADDRESS.test(event.sender) : event.sender !== null) ||
        (previous && order(previous, event) >= 0) ||
        coordinates.has(coordinate(event))
      )
        throw new Error('Malformed, duplicate, or unordered lifecycle event')
      if (event.block === range.fromBlock && event.blockHash !== chunk.fromHash)
        throw new Error('Boundary block hash mismatch')
      if (event.block === range.toBlock && event.blockHash !== chunk.toHash)
        throw new Error('Boundary block hash mismatch')
      const created = sources.vaults.get(event.vault)
      if (created === undefined) localNonCohort++
      else if (event.block < created) throw new Error('Lifecycle event predates factory creation')
      if (!submitKeys.has(eventKey(event))) localUnmatched++
      coordinates.add(coordinate(event))
      previous = event
    }
    if (localNonCohort !== chunk.nonCohortLogs || localUnmatched !== chunk.unmatchedLogs)
      throw new Error('Lifecycle chunk count mismatch')
    offset += events.length
    nonCohort += localNonCohort
    unmatched += localUnmatched
  }
  if (
    offset !== saved.events.length ||
    nonCohort !== saved.nonCohortLogs ||
    unmatched !== saved.unmatchedLogs ||
    saved.coverage?.fromBlock !== FROM_BLOCK ||
    saved.coverage?.throughBlock !==
      (saved.nextChunk ? all[saved.nextChunk - 1].toBlock : FROM_BLOCK - 1) ||
    saved.coverage?.chunksComplete !== saved.nextChunk ||
    saved.coverage?.chunksExpected !== all.length ||
    saved.coverage?.complete !== (saved.status === 'complete')
  )
    throw new Error('Lifecycle coverage/accounting mismatch')
  if (expected.complete && saved.status !== 'complete')
    throw new Error('Incomplete lifecycle census')
  return saved
}

function diskGuard(out, expectedBytes = 0, stat = statfsSync) {
  const disk = stat(dirname(out))
  if (Number(disk.bavail) * Number(disk.bsize) - expectedBytes < RESERVE_BYTES)
    throw new Error('Lifecycle disk reserve reached')
}

function atomic(out, saved, stat) {
  const bytes = JSON.stringify(saved)
  if (Buffer.byteLength(bytes) > MAX_OUTPUT_BYTES)
    throw new Error('Lifecycle output size cap reached')
  mkdirSync(dirname(out), { recursive: true })
  diskGuard(out, Buffer.byteLength(bytes), stat)
  const temp = `${out}.${process.pid}.tmp`
  writeFileSync(temp, bytes, { mode: 0o600 })
  renameSync(temp, out)
}

async function retry(operation, retries, pause, before) {
  for (let i = 0; ; i++) {
    before()
    try {
      return await operation()
    } catch (error) {
      if (i >= retries) throw new Error('RPC read failed', { cause: error })
      await pause(Math.min(10_000, 500 * 2 ** i))
    }
  }
}

export async function collect({
  client,
  rpcRead = (method, params) => client.request({ method, params }),
  sources,
  out,
  maxChunks = Infinity,
  retries = 3,
  stat = statfsSync,
  pause = (ms) => new Promise((done) => setTimeout(done, ms)),
  onProgress = () => {},
}) {
  if (
    !sources?.vaults ||
    !sources?.submits ||
    sources.vaults.size !== 757 ||
    (!Number.isSafeInteger(maxChunks) && maxChunks !== Infinity) ||
    maxChunks < 0
  )
    throw new Error('Invalid lifecycle census inputs')
  const beforeRpc = () => diskGuard(out, 0, stat)
  if ((await retry(() => client.getChainId(), retries, pause, beforeRpc)) !== 1)
    throw new Error('Wrong chain ID')
  const head = await retry(
    () => client.getBlock({ blockNumber: BigInt(TO_BLOCK) }),
    retries,
    pause,
    beforeRpc,
  )
  if (head.hash?.toLowerCase() !== PINNED_HEAD_HASH) throw new Error('Pinned head mismatch')
  const all = ranges()
  let saved = existsSync(out)
    ? JSON.parse(readFileSync(out, 'utf8'))
    : seal({
        study: STUDY,
        chainId: 1,
        factoryArtifactSha256: FACTORY_SHA,
        submitArtifactSha256: SUBMIT_SHA,
        pinnedHeadHash: PINNED_HEAD_HASH,
        from: FROM_BLOCK,
        to: TO_BLOCK,
        chunkBlocks: CHUNK_BLOCKS,
        topics: TOPICS,
        nextChunk: 0,
        status: 'partial',
        chunks: [],
        events: [],
        nonCohortLogs: 0,
        unmatchedLogs: 0,
        coverage: {
          fromBlock: FROM_BLOCK,
          throughBlock: FROM_BLOCK - 1,
          chunksComplete: 0,
          chunksExpected: all.length,
          complete: false,
        },
      })
  validateCheckpoint(saved, sources)
  if (!existsSync(out)) atomic(out, saved, stat)
  const stopAt = Math.min(all.length, saved.nextChunk + maxChunks)
  for (let i = saved.nextChunk; i < stopAt; i++) {
    const range = all[i],
      logs = []
    const fromHeader = await retry(
      () => client.getBlock({ blockNumber: BigInt(range.fromBlock) }),
      retries,
      pause,
      beforeRpc,
    )
    const toHeader = await retry(
      () => client.getBlock({ blockNumber: BigInt(range.toBlock) }),
      retries,
      pause,
      beforeRpc,
    )
    if (
      !HASH.test(fromHeader.hash) ||
      !HASH.test(toHeader.hash) ||
      (range.toBlock === TO_BLOCK && toHeader.hash.toLowerCase() !== PINNED_HEAD_HASH)
    )
      throw new Error('Chunk boundary hash mismatch')
    for (const topic of [TOPICS.accept, TOPICS.revoke]) {
      const response = await retry(
        () =>
          rpcRead('eth_getLogs', [
            {
              fromBlock: toHex(range.fromBlock),
              toBlock: toHex(range.toBlock),
              topics: [topic],
            },
          ]),
        retries,
        pause,
        beforeRpc,
      )
      if (
        !Array.isArray(response) ||
        Buffer.byteLength(JSON.stringify(response)) > MAX_RESPONSE_BYTES
      )
        throw new Error('Malformed or oversized lifecycle log response')
      logs.push(...response)
    }
    const events = logs.map(decodeLifecycle).sort(order),
      coordinates = new Set()
    let nonCohortLogs = 0,
      unmatchedLogs = 0
    const submitKeys = new Set(sources.submits.map(eventKey))
    for (const event of events) {
      if (
        event.block < range.fromBlock ||
        event.block > range.toBlock ||
        coordinates.has(coordinate(event)) ||
        (event.block === range.fromBlock && event.blockHash !== fromHeader.hash.toLowerCase()) ||
        (event.block === range.toBlock && event.blockHash !== toHeader.hash.toLowerCase())
      )
        throw new Error('Out-of-range, duplicate, or noncanonical lifecycle log')
      const creation = sources.vaults.get(event.vault)
      if (creation === undefined) nonCohortLogs++
      else if (event.block < creation) throw new Error('Pre-creation lifecycle log')
      if (!submitKeys.has(eventKey(event))) unmatchedLogs++
      coordinates.add(coordinate(event))
    }
    const next = seal({
      ...unsigned(saved),
      nextChunk: i + 1,
      status: i + 1 === all.length ? 'complete' : 'partial',
      chunks: [
        ...saved.chunks,
        {
          ...range,
          fromHash: fromHeader.hash.toLowerCase(),
          toHash: toHeader.hash.toLowerCase(),
          matchedLogs: events.length,
          eventCount: events.length,
          nonCohortLogs,
          unmatchedLogs,
          eventsSha256: sha(JSON.stringify(events)),
        },
      ],
      events: [...saved.events, ...events],
      nonCohortLogs: saved.nonCohortLogs + nonCohortLogs,
      unmatchedLogs: saved.unmatchedLogs + unmatchedLogs,
      coverage: {
        fromBlock: FROM_BLOCK,
        throughBlock: range.toBlock,
        chunksComplete: i + 1,
        chunksExpected: all.length,
        complete: i + 1 === all.length,
      },
    })
    validateCheckpoint(next, sources)
    atomic(out, next, stat)
    saved = next
    onProgress(saved)
  }
  return saved
}

function options(args) {
  const opts = {}
  for (let i = 0; i < args.length; i += 2) {
    if (
      !args[i]?.startsWith('--') ||
      args[i + 1] === undefined ||
      opts[args[i].slice(2)] !== undefined
    )
      throw new Error('Expected unique --key value arguments')
    opts[args[i].slice(2)] = args[i + 1]
  }
  if (
    Object.keys(opts).some(
      (x) => !['factory', 'submit', 'out', 'run', 'verify', 'max-chunks', 'rpc'].includes(x),
    ) ||
    (opts.run && opts.run !== 'true') ||
    (opts.verify && opts.verify !== 'true') ||
    (opts.run && opts.verify)
  )
    throw new Error('Invalid lifecycle CLI options')
  return opts
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = options(process.argv.slice(2))
    const factory = resolve(opts.factory || `data/research/venue-signals/${FACTORY_SHA}.json`)
    const submit = resolve(opts.submit || `data/research/venue-signals/${SUBMIT_SHA}.json`)
    const out = resolve(
      opts.out || 'data/research/venue-signals/morpho-v2-cap-lifecycle-census.json',
    )
    const sources = readSources(factory, submit)
    if (opts.verify) {
      const saved = validateCheckpoint(JSON.parse(readFileSync(out, 'utf8')), sources)
      process.stdout.write(
        JSON.stringify({
          status: saved.status,
          coverage: saved.coverage,
          events: saved.events.length,
          nonCohortLogs: saved.nonCohortLogs,
          unmatchedLogs: saved.unmatchedLogs,
          sha256: sha(readFileSync(out)),
        }) + '\n',
      )
    } else if (!opts.run) {
      process.stdout.write(
        JSON.stringify({
          mode: 'dry',
          from: FROM_BLOCK,
          to: TO_BLOCK,
          chunks: ranges().length,
          sourceSubmits: sources.submits.length,
          reserveBytes: RESERVE_BYTES,
          runRequired: true,
        }) + '\n',
      )
    } else {
      const rpc = opts.rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
      if (!rpc) throw new Error('Missing RPC configuration')
      const saved = await collect({
        client: makeClient(rpc),
        sources,
        out,
        maxChunks: opts['max-chunks'] === undefined ? Infinity : Number(opts['max-chunks']),
        onProgress: (x) =>
          process.stdout.write(
            `chunks ${x.nextChunk}/${ranges().length}, events ${x.events.length}\n`,
          ),
      })
      process.stdout.write(
        JSON.stringify({
          status: saved.status,
          coverage: saved.coverage,
          events: saved.events.length,
          nonCohortLogs: saved.nonCohortLogs,
          unmatchedLogs: saved.unmatchedLogs,
          sha256: sha(readFileSync(out)),
        }) + '\n',
      )
    }
  } catch (error) {
    // RPC errors may contain credential-bearing URLs. Never print error details here.
    process.stderr.write('Lifecycle census stopped; source, RPC, or resource validation failed.\n')
    process.exitCode = 1
  }
}
