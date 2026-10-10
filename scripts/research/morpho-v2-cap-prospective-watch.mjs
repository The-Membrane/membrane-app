// Append-only, finalized-block observations. This is NOT an exit-risk classifier.
// Dry: node scripts/research/morpho-v2-cap-prospective-watch.mjs
// Live: node scripts/research/morpho-v2-cap-prospective-watch.mjs --run --max-chunks 1
// Offline: node scripts/research/morpho-v2-cap-prospective-watch.mjs --verify
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeEventLog, encodeAbiParameters, toHex } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import {
  EVENT as CREATE,
  FACTORY,
  TOPIC0 as CREATE_TOPIC,
  decodeCreation,
} from './morpho-v2-factory-census.mjs'
import {
  ABS_SELECTOR,
  REL_SELECTOR,
  SUBMIT,
  TOPIC0 as SUBMIT_TOPIC,
  decodeCapCall,
} from './morpho-v2-cap-submit-census.mjs'
import {
  FACTORY_SHA,
  PINNED_HEAD_HASH,
  SUBMIT_SHA,
  TOPICS,
  decodeLifecycle,
  readSources,
} from './morpho-v2-cap-lifecycle-census.mjs'
import { TOPIC0 as ROUTE_TOPIC, decodeRoute } from './morpho-v2-route-census.mjs'

export const STUDY = 'morpho-v2-cap-prospective-watch-v1'
export const FRONTIER = 26_052_740
export const CHUNK_BLOCKS = 1_000
export const MAX_CHUNKS = 4
export const MAX_RPC_CALLS = 80
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const MAX_SEGMENT_BYTES = 4 * 1024 * 1024
export const RESERVE_BYTES = 1_000_000_000
export const SCHEMA_VERSION = 2
export const MAX_ALLOCATION_IDS = 256
export const ALLOCATE_TOPIC = '0x2bc7948a96a066968d2a58aaf46eb0b305aa166b1d1951d2f7ef0919746b8c2a'
export const DEALLOCATE_TOPIC = '0xd602b36fb24934aef1bc2a658de029b486fa4c664a6e45de1f48e3fd1be25dd9'
const allocationInputs = [
  { type: 'uint256', name: 'assets' },
  { type: 'bytes32[]', name: 'ids' },
  { type: 'int256', name: 'change' },
]
const allocationAbi = (name) => ({
  type: 'event',
  name,
  inputs: [
    { type: 'address', name: 'sender', indexed: true },
    { type: 'address', name: 'adapter', indexed: true },
    ...allocationInputs.map((input) => ({ ...input, indexed: false })),
  ],
})
const ALLOCATE = allocationAbi('Allocate')
const DEALLOCATE = allocationAbi('Deallocate')
export const TOPIC_BY_KIND = {
  create: CREATE_TOPIC,
  submit: SUBMIT_TOPIC,
  accept: TOPICS.accept,
  revoke: TOPICS.revoke,
  route: ROUTE_TOPIC,
  allocate: ALLOCATE_TOPIC,
  deallocate: DEALLOCATE_TOPIC,
}
const HASH = /^0x[0-9a-f]{64}$/i
const ADDRESS = /^0x[0-9a-f]{40}$/i
const HEX = /^0x(?:[0-9a-f]{2})*$/i
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sourcePaths = {
  factory: `data/research/venue-signals/${FACTORY_SHA}.json`,
  submit: `data/research/venue-signals/${SUBMIT_SHA}.json`,
}
const defaultOut = 'data/research/venue-signals/morpho-v2-cap-prospective-watch'
const orderedKinds = Object.keys(TOPIC_BY_KIND)
const legacyKinds = orderedKinds.slice(0, 5)

function integer(value) {
  const n = Number(typeof value === 'string' ? BigInt(value) : value)
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid RPC quantity')
  return n
}
function header(value, expectedNumber) {
  const number = integer(value?.number),
    timestamp = integer(value?.timestamp)
  if (
    !HASH.test(value?.hash) ||
    !HASH.test(value?.parentHash) ||
    (expectedNumber !== undefined && number !== expectedNumber)
  )
    throw new Error('Invalid or mismatched block header')
  return {
    number,
    hash: value.hash.toLowerCase(),
    parentHash: value.parentHash.toLowerCase(),
    timestamp,
  }
}
function rawLog(log) {
  if (
    !ADDRESS.test(log?.address) ||
    !HASH.test(log?.blockHash) ||
    !HASH.test(log?.transactionHash) ||
    !HEX.test(log?.data) ||
    !Array.isArray(log?.topics) ||
    log.topics.some((x) => !HASH.test(x))
  )
    throw new Error('Malformed log')
  return {
    address: log.address.toLowerCase(),
    blockNumber: integer(log.blockNumber),
    blockHash: log.blockHash.toLowerCase(),
    transactionIndex: integer(log.transactionIndex),
    transactionHash: log.transactionHash.toLowerCase(),
    logIndex: integer(log.logIndex),
    topics: log.topics.map((x) => x.toLowerCase()),
    data: log.data.toLowerCase(),
  }
}
function decode(kind, raw) {
  let detail
  if (kind === 'create') {
    const { timestamp: ignored, ...created } = decodeCreation(raw, 0)
    void ignored
    detail = { ...created, vault: created.vault.toLowerCase() }
  } else if (kind === 'submit') {
    if (
      raw.topics.length !== 2 ||
      raw.topics[0] !== SUBMIT_TOPIC ||
      ![ABS_SELECTOR, REL_SELECTOR].includes(raw.topics[1].slice(0, 10))
    )
      throw new Error('Unexpected cap Submit topic')
    const { args } = decodeEventLog({
      abi: [SUBMIT],
      topics: raw.topics,
      data: raw.data,
      strict: true,
    })
    if (
      args.selector.toLowerCase() !== raw.topics[1].slice(0, 10) ||
      !HEX.test(args.data) ||
      args.data.slice(0, 10).toLowerCase() !== args.selector.toLowerCase()
    )
      throw new Error('Malformed cap Submit data')
    const cap = decodeCapCall({
      selector: args.selector.toLowerCase(),
      data: args.data.toLowerCase(),
    })
    if (!cap) throw new Error('Noncanonical cap Submit data')
    detail = {
      vault: raw.address,
      selector: args.selector.toLowerCase(),
      data: args.data.toLowerCase(),
      executableAt: args.executableAt.toString(),
      cap,
    }
  } else if (kind === 'accept' || kind === 'revoke') {
    detail = decodeLifecycle(raw)
    if (detail.kind !== kind) throw new Error('Lifecycle event mismatch')
  } else if (kind === 'route') detail = decodeRoute(raw)
  else if (kind === 'allocate' || kind === 'deallocate') {
    if (
      raw.topics.length !== 3 ||
      raw.topics[0] !== TOPIC_BY_KIND[kind] ||
      raw.topics.slice(1).some((topic) => !/^0x0{24}[0-9a-f]{40}$/.test(topic))
    )
      throw new Error('Malformed allocation topics')
    const { args } = decodeEventLog({
      abi: [kind === 'allocate' ? ALLOCATE : DEALLOCATE],
      topics: raw.topics,
      data: raw.data,
      strict: true,
    })
    if (
      !Array.isArray(args.ids) ||
      args.ids.length > MAX_ALLOCATION_IDS ||
      args.ids.some((id) => !HASH.test(id)) ||
      encodeAbiParameters(allocationInputs, [args.assets, args.ids, args.change]).toLowerCase() !==
        raw.data
    )
      throw new Error('Malformed or oversized allocation data')
    detail = {
      vault: raw.address,
      sender: args.sender.toLowerCase(),
      adapter: args.adapter.toLowerCase(),
      assets: args.assets.toString(),
      ids: args.ids.map((id) => id.toLowerCase()),
      change: args.change.toString(),
    }
  } else throw new Error('Unknown watched event')
  return detail
}

function unsigned(segment) {
  const { segmentSha256, ...rest } = segment
  return rest
}
export function seal(segment) {
  const payload = unsigned(segment)
  return { ...payload, segmentSha256: sha(JSON.stringify(payload)) }
}
function segmentNames(out) {
  if (!existsSync(out)) return []
  const all = readdirSync(out)
  // An interrupted append can leave uncommitted temporary bytes. Rescan on restart.
  if (all.some((x) => !/^\d{12}-\d{12}\.json(?:\.[0-9a-f-]+\.tmp)?$/.test(x)))
    throw new Error('Unexpected file in append-only watch directory')
  return all.filter((x) => x.endsWith('.json')).sort()
}
export function verify({ out = defaultOut, sources, requireExisting = false }) {
  const names = segmentNames(out)
  if (requireExisting && !names.length) throw new Error('No watch segments')
  const vaults = new Map(sources.vaults)
  let last = FRONTIER,
    lastHash = PINNED_HEAD_HASH,
    previousSha = null,
    lastObserved = '',
    seenV2 = false
  for (const name of names) {
    const bytes = readFileSync(join(out, name))
    const saved = JSON.parse(bytes)
    const segmentKinds = saved.schemaVersion === undefined ? legacyKinds : orderedKinds
    if (
      bytes.length > MAX_SEGMENT_BYTES ||
      saved.study !== STUDY ||
      saved.chainId !== 1 ||
      saved.factoryArtifactSha256 !== FACTORY_SHA ||
      saved.submitArtifactSha256 !== SUBMIT_SHA ||
      saved.previousSegmentSha256 !== previousSha ||
      saved.from !== last + 1 ||
      saved.to < saved.from ||
      saved.to - saved.from + 1 > CHUNK_BLOCKS ||
      name !==
        `${String(saved.from).padStart(12, '0')}-${String(saved.to).padStart(12, '0')}.json` ||
      saved.previousFrontierHash !== lastHash ||
      !HASH.test(saved.fromHash) ||
      !HASH.test(saved.toHash) ||
      !Number.isSafeInteger(saved.finalizedAtPoll) ||
      saved.to > saved.finalizedAtPoll ||
      !Number.isSafeInteger(saved.toTimestamp) ||
      !Number.isFinite(Date.parse(saved.firstObservedAt)) ||
      saved.firstObservedAt <= lastObserved ||
      saved.segmentSha256 !== sha(JSON.stringify(unsigned(saved))) ||
      !Array.isArray(saved.scans) ||
      !Array.isArray(saved.events) ||
      (seenV2 && saved.schemaVersion === undefined) ||
      (saved.schemaVersion !== undefined && saved.schemaVersion !== SCHEMA_VERSION) ||
      JSON.stringify(saved.scans.map((x) => x.kind)) !== JSON.stringify(segmentKinds)
    )
      throw new Error('Watch segment seal or continuity mismatch')
    const coordinate = new Set()
    let previousOrder = [-1, -1]
    for (const event of saved.events) {
      if (
        !segmentKinds.includes(event.kind) ||
        event.firstObservedAt !== saved.firstObservedAt ||
        event.raw?.blockNumber < saved.from ||
        event.raw?.blockNumber > saved.to ||
        (event.raw?.blockNumber === saved.from && event.raw?.blockHash !== saved.fromHash) ||
        (event.raw?.blockNumber === saved.to && event.raw?.blockHash !== saved.toHash)
      )
        throw new Error('Invalid watched event range')
      const raw = rawLog(event.raw)
      if (
        raw.topics[0] !== TOPIC_BY_KIND[event.kind] ||
        JSON.stringify(decode(event.kind, raw)) !== JSON.stringify(event.detail)
      )
        throw new Error('Watched event decode mismatch')
      const key = `${raw.transactionHash}:${raw.logIndex}`
      const order = [raw.blockNumber, raw.logIndex]
      if (
        coordinate.has(key) ||
        order[0] < previousOrder[0] ||
        (order[0] === previousOrder[0] && order[1] <= previousOrder[1])
      )
        throw new Error('Duplicate or unordered watch event')
      coordinate.add(key)
      previousOrder = order
      if (event.kind === 'create') {
        if (raw.address !== FACTORY.toLowerCase() || vaults.has(event.detail.vault))
          throw new Error('Invalid new vault')
        vaults.set(event.detail.vault, raw.blockNumber)
      } else if (
        !vaults.has(event.detail.vault) ||
        vaults.get(event.detail.vault) > raw.blockNumber
      )
        throw new Error('Unrecognized or pre-creation vault')
    }
    for (const scan of saved.scans) {
      if (
        scan.from !== saved.from ||
        scan.to !== saved.to ||
        scan.topic !== TOPIC_BY_KIND[scan.kind] ||
        !Number.isSafeInteger(scan.rawCount) ||
        scan.rawCount < scan.eventCount ||
        scan.eventCount !== saved.events.filter((x) => x.kind === scan.kind).length
      )
        throw new Error('Scan coverage mismatch')
    }
    last = saved.to
    lastHash = saved.toHash
    previousSha = sha(bytes)
    lastObserved = saved.firstObservedAt
    if (saved.schemaVersion === SCHEMA_VERSION) seenV2 = true
  }
  return {
    throughBlock: last,
    frontierHash: lastHash,
    lastSegmentSha256: previousSha,
    firstObservedAt: lastObserved || null,
    segmentCount: names.length,
    vaults,
  }
}

function diskGuard(out, stat = statfsSync, expectedBytes = 0) {
  const fs = stat(dirname(out))
  if (Number(fs.bavail) * Number(fs.bsize) - expectedBytes < RESERVE_BYTES)
    throw new Error('Watch disk reserve reached')
}
function appendSegment(out, segment, stat) {
  const bytes = JSON.stringify(segment)
  if (Buffer.byteLength(bytes) > MAX_SEGMENT_BYTES)
    throw new Error('Watch segment size cap reached')
  mkdirSync(out, { recursive: true })
  diskGuard(out, stat, Buffer.byteLength(bytes))
  const name = `${String(segment.from).padStart(12, '0')}-${String(segment.to).padStart(12, '0')}.json`
  const target = join(out, name),
    temporary = `${target}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temporary, target) // Exclusive creation: never replace a completed interval.
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}
export async function collect({
  rpcRead,
  sources,
  out = defaultOut,
  maxChunks = 1,
  now = () => new Date(),
  stat = statfsSync,
  onProgress = () => {},
}) {
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > MAX_CHUNKS)
    throw new Error('Invalid bounded chunk count')
  const maxRpcCalls = MAX_RPC_CALLS * maxChunks
  let calls = 0
  const rpc = async (method, params) => {
    diskGuard(out, stat)
    if (++calls > maxRpcCalls) throw new Error('Watch RPC call cap reached')
    return rpcRead(method, params)
  }
  if (integer(await rpc('eth_chainId', [])) !== 1) throw new Error('Wrong chain')
  const finalized = header(await rpc('eth_getBlockByNumber', ['finalized', false]))
  let state = verify({ out, sources })
  const frontier = header(
    await rpc('eth_getBlockByNumber', [toHex(state.throughBlock), false]),
    state.throughBlock,
  )
  if (frontier.hash !== state.frontierHash) throw new Error('Previous frontier hash changed')
  for (let n = 0; n < maxChunks && state.throughBlock < finalized.number; n++) {
    const from = state.throughBlock + 1,
      to = Math.min(finalized.number, from + CHUNK_BLOCKS - 1)
    const fromHeader = header(await rpc('eth_getBlockByNumber', [toHex(from), false]), from)
    const toHeader = header(await rpc('eth_getBlockByNumber', [toHex(to), false]), to)
    if (fromHeader.parentHash !== state.frontierHash)
      throw new Error('New interval does not descend from prior frontier')
    if (fromHeader.number !== frontier.number + 1 && n === 0)
      throw new Error('Noncontiguous frontier')
    const events = [],
      scans = [],
      vaults = new Map(state.vaults)
    const fetched = []
    for (const kind of orderedKinds) {
      const response = await rpc('eth_getLogs', [
        {
          fromBlock: toHex(from),
          toBlock: toHex(to),
          topics: [TOPIC_BY_KIND[kind]],
          ...(kind === 'create' ? { address: FACTORY } : {}),
        },
      ])
      if (
        !Array.isArray(response) ||
        Buffer.byteLength(JSON.stringify(response)) > MAX_RESPONSE_BYTES
      )
        throw new Error('Malformed or oversized log response')
      scans.push({
        kind,
        topic: TOPIC_BY_KIND[kind],
        from,
        to,
        rawCount: response.length,
        eventCount: 0,
      })
      for (const log of response) fetched.push({ kind, raw: rawLog(log) })
    }
    fetched.sort((a, b) => a.raw.blockNumber - b.raw.blockNumber || a.raw.logIndex - b.raw.logIndex)
    const coords = new Set()
    for (const { kind, raw } of fetched) {
      if (
        raw.topics[0] !== TOPIC_BY_KIND[kind] ||
        raw.blockNumber < from ||
        raw.blockNumber > to ||
        (raw.blockNumber === from && raw.blockHash !== fromHeader.hash) ||
        (raw.blockNumber === to && raw.blockHash !== toHeader.hash)
      )
        throw new Error('Noncanonical or out-of-range log')
      const key = `${raw.transactionHash}:${raw.logIndex}`
      if (coords.has(key)) throw new Error('Duplicate log coordinate')
      coords.add(key)
      if (
        kind !== 'create' &&
        (!vaults.has(raw.address) || vaults.get(raw.address) > raw.blockNumber)
      )
        continue // Global topic scan includes non-factory contracts.
      if (
        kind === 'submit' &&
        raw.topics.length === 2 &&
        ![ABS_SELECTOR, REL_SELECTOR].includes(raw.topics[1].slice(0, 10))
      )
        continue // VaultV2 Submit also covers non-cap actions.
      const detail = decode(kind, raw)
      if (kind === 'create') {
        if (raw.address !== FACTORY.toLowerCase() || vaults.has(detail.vault))
          throw new Error('Duplicate or nonfactory vault creation')
        vaults.set(detail.vault, raw.blockNumber)
      } else if (!vaults.has(detail.vault) || vaults.get(detail.vault) > raw.blockNumber)
        throw new Error('Decoded vault does not match factory roster')
      events.push({ kind, raw, detail })
      scans.find((x) => x.kind === kind).eventCount++
    }
    const eventBlockHashes = new Map()
    for (const event of events) {
      const previous = eventBlockHashes.get(event.raw.blockNumber)
      if (previous && previous !== event.raw.blockHash)
        throw new Error('Conflicting event block hashes')
      eventBlockHashes.set(event.raw.blockNumber, event.raw.blockHash)
    }
    for (const [block, expectedHash] of eventBlockHashes) {
      if (block === from || block === to) continue
      const canonical = header(await rpc('eth_getBlockByNumber', [toHex(block), false]), block)
      if (canonical.hash !== expectedHash) throw new Error('Noncanonical interior event')
    }
    const recheck = header(
      await rpc('eth_getBlockByNumber', [toHex(state.throughBlock), false]),
      state.throughBlock,
    )
    const endRecheck = header(await rpc('eth_getBlockByNumber', [toHex(to), false]), to)
    if (recheck.hash !== state.frontierHash || endRecheck.hash !== toHeader.hash)
      throw new Error('Canonical hash changed before append')
    // Finish source/prefix validation before stamping a usable local observation.
    const fresh = verify({ out, sources })
    if (
      fresh.throughBlock !== state.throughBlock ||
      fresh.lastSegmentSha256 !== state.lastSegmentSha256
    )
      throw new Error('Concurrent watch append detected')
    const observed = now().toISOString()
    const firstObservedAt =
      observed > (state.firstObservedAt || '')
        ? observed
        : new Date(Date.parse(state.firstObservedAt) + 1).toISOString()
    for (const event of events) event.firstObservedAt = firstObservedAt
    const segment = seal({
      study: STUDY,
      schemaVersion: SCHEMA_VERSION,
      chainId: 1,
      factoryArtifactSha256: FACTORY_SHA,
      submitArtifactSha256: SUBMIT_SHA,
      previousSegmentSha256: state.lastSegmentSha256,
      previousFrontierHash: state.frontierHash,
      from,
      to,
      fromHash: fromHeader.hash,
      toHash: toHeader.hash,
      toTimestamp: toHeader.timestamp,
      finalizedAtPoll: finalized.number,
      firstObservedAt,
      scans,
      events,
      limitations: [
        'observed-on-finalized-poll',
        'cap-change-not-exit-impairment',
        'route-switch-is-immediate-context',
        'allocation-events-are-exposure-movement-not-cap-execution-or-exit-impairment',
        'allocation-abi-source-attested-not-every-vault-runtime-attested',
      ],
    })
    appendSegment(out, segment, stat)
    state = verify({ out, sources, requireExisting: true })
    onProgress({
      throughBlock: state.throughBlock,
      segmentCount: state.segmentCount,
      eventCount: events.length,
      firstObservedAt,
    })
  }
  return { ...state, rpcCalls: calls, finalizedAtPoll: finalized.number }
}

function options(args) {
  const out = { run: false, verify: false, maxChunks: 1 }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run') out.run = true
    else if (args[i] === '--verify') out.verify = true
    else if (['--out', '--factory', '--submit', '--rpc', '--max-chunks'].includes(args[i])) {
      const key = args[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      out[key] = args[++i]
    } else throw new Error('Unknown watch option')
  }
  out.maxChunks = Number(out.maxChunks)
  if (out.run && out.verify) throw new Error('Choose run or verify')
  return out
}
async function main() {
  try {
    const opts = options(process.argv.slice(2))
    const out = resolve(opts.out || defaultOut)
    const sources = readSources(
      resolve(opts.factory || sourcePaths.factory),
      resolve(opts.submit || sourcePaths.submit),
    )
    const state = verify({ out, sources, requireExisting: opts.verify })
    if (opts.verify) {
      process.stdout.write(
        JSON.stringify({
          verified: true,
          throughBlock: state.throughBlock,
          segmentCount: state.segmentCount,
          lastSegmentSha256: state.lastSegmentSha256,
        }) + '\n',
      )
    } else if (!opts.run) {
      process.stdout.write(
        JSON.stringify({
          dry: true,
          nextFrom: state.throughBlock + 1,
          maxChunks: opts.maxChunks,
          chunkBlocks: CHUNK_BLOCKS,
          currentVaults: state.vaults.size,
          frontierHash: state.frontierHash,
          kinds: orderedKinds,
          noRpcOrWrites: true,
        }) + '\n',
      )
    } else {
      const url = opts.rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
      if (!url) throw new Error('Missing RPC configuration')
      const client = makeClient(url)
      const result = await collect({
        rpcRead: (method, params) => client.request({ method, params }),
        sources,
        out,
        maxChunks: opts.maxChunks,
      })
      process.stdout.write(
        JSON.stringify({
          throughBlock: result.throughBlock,
          segmentCount: result.segmentCount,
          rpcCalls: result.rpcCalls,
        }) + '\n',
      )
    }
  } catch {
    // RPC exceptions may contain credential-bearing URLs. Never print their details.
    process.stderr.write(
      'Prospective Morpho watcher stopped: source, RPC, or integrity validation failed.\n',
    )
    process.exitCode = 1
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
