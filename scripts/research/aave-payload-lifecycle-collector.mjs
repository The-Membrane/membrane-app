// Pre-outcome Aave Ethereum payload lifecycle census. No RPC or writes without --run.
// The getter is a BLOCK-CLOSE snapshot: never treat it as state before an earlier log in that block.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, toEventSelector } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { GRID } from './multi-market-exit-prevalence.mjs'

export const CONTROLLER = '0xdabad81af85554e9ae636395611c58f7ec1aaec5'
export const END_BLOCK = GRID.last
export const MAX_CHUNK_BLOCKS = 2_000
export const MAX_LOGS = 100_000
export const MAX_PAYLOADS = 20_000
export const DISK_FLOOR_BYTES = 2.5 * 1024 ** 3
export const DEFAULT_OUT = resolve('data/research/venue-signals/aave-payload-lifecycle-v1.json')
const STUDY = 'aave-ethereum-payload-lifecycle-preoutcome-v1'
const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const BYTES = /^0x(?:[0-9a-f]{2})*$/
const UINT = /^(?:0|[1-9]\d*)$/
const EIP1967 = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const actionComponents = [
  { name: 'target', type: 'address' },
  { name: 'withDelegateCall', type: 'bool' },
  { name: 'accessLevel', type: 'uint8' },
  { name: 'value', type: 'uint256' },
  { name: 'signature', type: 'string' },
  { name: 'callData', type: 'bytes' },
]
const payloadComponents = [
  { name: 'creator', type: 'address' },
  { name: 'maximumAccessLevelRequired', type: 'uint8' },
  { name: 'state', type: 'uint8' },
  ...[
    'createdAt',
    'queuedAt',
    'executedAt',
    'cancelledAt',
    'expirationTime',
    'delay',
    'gracePeriod',
  ].map((name) => ({ name, type: 'uint40' })),
  { name: 'actions', type: 'tuple[]', components: actionComponents },
]
export const ABI = [
  {
    type: 'event',
    name: 'PayloadCreated',
    inputs: [
      { name: 'payloadId', type: 'uint40', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'actions', type: 'tuple[]', components: actionComponents, indexed: false },
      { name: 'maximumAccessLevelRequired', type: 'uint8', indexed: true },
    ],
  },
  ...['PayloadQueued', 'PayloadCancelled', 'PayloadExecuted'].map((name) => ({
    type: 'event',
    name,
    inputs: [{ name: 'payloadId', type: 'uint40', indexed: false }],
  })),
  {
    type: 'function',
    name: 'getPayloadById',
    stateMutability: 'view',
    inputs: [{ name: 'payloadId', type: 'uint40' }],
    outputs: [{ name: 'payload', type: 'tuple', components: payloadComponents }],
  },
  {
    type: 'function',
    name: 'getPayloadsCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'count', type: 'uint40' }],
  },
]
const EVENT_KINDS = Object.freeze([
  'PayloadCreated',
  'PayloadQueued',
  'PayloadCancelled',
  'PayloadExecuted',
])
export const TOPICS = Object.freeze(
  EVENT_KINDS.map((name) =>
    toEventSelector(ABI.find((item) => item.type === 'event' && item.name === name)).toLowerCase(),
  ),
)
const topicKind = new Map(TOPICS.map((topic, index) => [topic, EVENT_KINDS[index]]))
export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const codeDigest = (code) =>
  createHash('sha256')
    .update(Buffer.from(code.slice(2), 'hex'))
    .digest('hex')
const lower = (value) => String(value).toLowerCase()
const integer = (value) => {
  const result = Number(BigInt(value))
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Unsafe RPC integer')
  return result
}
const pin = (hash) => ({ blockHash: hash, requireCanonical: true })
const envelope = (payload) => ({ payload, sha256: digest(payload) })
const identity = () => ({
  study: STUDY,
  chainId: 1,
  controller: CONTROLLER,
  endBlock: END_BLOCK,
  topics: TOPICS,
})
const initial = () => ({
  ...identity(),
  status: 'partial',
  stopReason: null,
  endHash: null,
  endPayloadsCount: null,
  endTimestamp: null,
  search: { absentBelow: -1, presentAt: null, probes: [] },
  deploymentBlock: null,
  nextBlock: null,
  chunks: [],
  finalSnapshots: [],
})

function diskOk(path) {
  let dir = dirname(resolve(path))
  while (!existsSync(dir)) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error('No output ancestor')
    dir = parent
  }
  const stat = statfsSync(dir)
  if (stat.bavail * stat.bsize < DISK_FLOOR_BYTES) throw new Error('Disk reserve below 2.5 GiB')
}
function save(path, payload, checkDisk) {
  checkDisk(path)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(envelope(payload)), { mode: 0o600 })
  renameSync(tmp, path)
}
async function header(client, block) {
  const item = await client.getBlock({ blockNumber: BigInt(block) })
  const hash = lower(item?.hash)
  if (integer(item?.number) !== block || !HASH.test(hash)) throw new Error('Invalid header')
  return { block, hash, timestamp: integer(item.timestamp) }
}
async function codeProbe(client, block, expectedHash) {
  const head = await header(client, block)
  if (expectedHash && head.hash !== expectedHash) throw new Error('Canonical code boundary changed')
  const code = lower(
    await client.request({ method: 'eth_getCode', params: [CONTROLLER, pin(head.hash)] }),
  )
  if (!BYTES.test(code)) throw new Error('Invalid controller code')
  return { block, hash: head.hash, hasCode: code !== '0x', codeSha256: codeDigest(code) }
}
function normalizeAction(action) {
  const value = {
    target: lower(action?.target),
    withDelegateCall: action?.withDelegateCall,
    accessLevel: integer(action?.accessLevel),
    value: BigInt(action?.value).toString(),
    signature: action?.signature,
    callData: lower(action?.callData),
  }
  if (
    !ADDRESS.test(value.target) ||
    typeof value.withDelegateCall !== 'boolean' ||
    value.accessLevel > 255 ||
    !UINT.test(value.value) ||
    typeof value.signature !== 'string' ||
    !BYTES.test(value.callData)
  )
    throw new Error('Invalid payload action')
  return value
}
export function decodeLifecycle(log, from, to, head) {
  const topic = lower(log?.topics?.[0])
  const kind = topicKind.get(topic)
  if (
    !kind ||
    lower(log.address) !== CONTROLLER ||
    log.removed === true ||
    !HASH.test(lower(log.blockHash)) ||
    !HASH.test(lower(log.transactionHash)) ||
    integer(log.blockNumber) < from ||
    integer(log.blockNumber) > to ||
    integer(log.blockNumber) !== head.block ||
    lower(log.blockHash) !== head.hash
  )
    throw new Error('Malformed lifecycle log')
  const event = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics, strict: true })
  if (event.eventName !== kind) throw new Error('Lifecycle ABI mismatch')
  const result = {
    kind,
    block: head.block,
    blockHash: head.hash,
    timestamp: head.timestamp,
    txHash: lower(log.transactionHash),
    txIndex: integer(log.transactionIndex),
    logIndex: integer(log.logIndex),
    payloadId: BigInt(event.args.payloadId).toString(),
  }
  if (kind === 'PayloadCreated') {
    result.creator = lower(event.args.creator)
    result.maximumAccessLevelRequired = integer(event.args.maximumAccessLevelRequired)
    result.actions = event.args.actions.map(normalizeAction)
    if (
      !ADDRESS.test(result.creator) ||
      result.maximumAccessLevelRequired > 255 ||
      !result.actions.length
    )
      throw new Error('Invalid created payload')
  }
  return result
}
function normalizeSnapshot(payload, id, head) {
  const result = {
    payloadId: id,
    block: head.block,
    blockHash: head.hash,
    timestamp: head.timestamp,
    status: 'ok',
    blockCloseOnly: true,
    capIntent: 'unknown',
    creator: lower(payload.creator),
    maximumAccessLevelRequired: integer(payload.maximumAccessLevelRequired),
    state: integer(payload.state),
    createdAt: integer(payload.createdAt),
    queuedAt: integer(payload.queuedAt),
    executedAt: integer(payload.executedAt),
    cancelledAt: integer(payload.cancelledAt),
    expirationTime: integer(payload.expirationTime),
    delay: integer(payload.delay),
    gracePeriod: integer(payload.gracePeriod),
    actions: payload.actions.map(normalizeAction),
  }
  if (
    !ADDRESS.test(result.creator) ||
    result.state > 5 ||
    result.maximumAccessLevelRequired > 255 ||
    !result.actions.length
  )
    throw new Error('Historical getter ABI mismatch')
  return result
}
async function snapshot(client, id, head) {
  try {
    const data = await client.request({
      method: 'eth_call',
      params: [
        {
          to: CONTROLLER,
          data: encodeFunctionData({
            abi: ABI,
            functionName: 'getPayloadById',
            args: [BigInt(id)],
          }),
        },
        pin(head.hash),
      ],
    })
    return normalizeSnapshot(
      decodeFunctionResult({ abi: ABI, functionName: 'getPayloadById', data }),
      id,
      head,
    )
  } catch (error) {
    if (error?.code === 'DISK_GUARD') throw error
    // Never persist provider errors: they can contain RPC credentials.
    return {
      payloadId: id,
      block: head.block,
      blockHash: head.hash,
      timestamp: head.timestamp,
      status: 'error',
      reason: 'pinned-getter-failed',
      blockCloseOnly: true,
      capIntent: 'unknown',
    }
  }
}
async function implementation(client, head) {
  try {
    const word = lower(
      await client.request({
        method: 'eth_getStorageAt',
        params: [CONTROLLER, EIP1967, pin(head.hash)],
      }),
    )
    if (!HASH.test(word)) throw new Error('Invalid proxy slot')
    const address = `0x${word.slice(-40)}`
    if (!ADDRESS.test(address) || /^0x0{40}$/.test(address))
      return { status: 'unresolved', reason: 'no-eip1967-implementation' }
    const code = lower(
      await client.request({ method: 'eth_getCode', params: [address, pin(head.hash)] }),
    )
    if (!BYTES.test(code) || code === '0x') throw new Error('Implementation code missing')
    return { status: 'unattested', address, codeSha256: codeDigest(code) }
  } catch (error) {
    if (error?.code === 'DISK_GUARD') throw error
    return { status: 'unresolved', reason: 'pinned-implementation-read-failed' }
  }
}

export function summarize(saved) {
  const logs = saved.chunks.flatMap((chunk) => chunk.logs)
  const snapshots = saved.chunks.flatMap((chunk) => chunk.snapshots)
  const finalSnapshots = saved.finalSnapshots
  return {
    status: saved.status,
    deploymentBlock: saved.deploymentBlock,
    nextBlock: saved.nextBlock,
    endBlock: END_BLOCK,
    logCount: logs.length,
    payloadCount: new Set(logs.map((log) => log.payloadId)).size,
    eventCounts: Object.fromEntries(
      EVENT_KINDS.map((kind) => [kind, logs.filter((log) => log.kind === kind).length]),
    ),
    snapshotCount: snapshots.length,
    missingReads: snapshots.filter((item) => item.status === 'error').length,
    finalSnapshotCount: finalSnapshots.length,
    finalMissingReads: finalSnapshots.filter((item) => item.status === 'error').length,
    endPayloadsCount: saved.endPayloadsCount,
    unsupportedImplementationEras: [
      ...new Set(
        saved.chunks.flatMap((chunk) =>
          [chunk.fromImplementation, chunk.toImplementation]
            .filter(Boolean)
            .map((item) =>
              item.status === 'unattested' ? item.address + ':' + item.codeSha256 : item.reason,
            ),
        ),
      ),
    ],
    coverageCaveat: 'Single-provider eth_getLogs completeness is not independently corroborated',
    blockCloseCaveat:
      'Getter snapshots describe block close, never pre-log state within that block',
  }
}

export function validateCheckpoint(sealed) {
  if (!sealed || digest(sealed.payload) !== sealed.sha256)
    throw new Error('Checkpoint SHA mismatch')
  const saved = sealed.payload
  for (const [key, value] of Object.entries(identity()))
    if (JSON.stringify(saved[key]) !== JSON.stringify(value)) throw new Error('Identity mismatch')
  if (
    !['partial', 'complete', 'over-budget'].includes(saved.status) ||
    (saved.endHash !== null && !HASH.test(saved.endHash)) ||
    (saved.endPayloadsCount !== null &&
      (!Number.isSafeInteger(saved.endPayloadsCount) || saved.endPayloadsCount < 0)) ||
    (saved.endTimestamp !== null &&
      (!Number.isSafeInteger(saved.endTimestamp) || saved.endTimestamp < 0)) ||
    (saved.endPayloadsCount === null) !== (saved.endTimestamp === null) ||
    !saved.search ||
    !Number.isSafeInteger(saved.search.absentBelow) ||
    saved.search.absentBelow < -1 ||
    saved.search.absentBelow >= END_BLOCK ||
    (saved.search.presentAt !== null &&
      (!Number.isSafeInteger(saved.search.presentAt) ||
        saved.search.presentAt < 0 ||
        saved.search.presentAt > END_BLOCK)) ||
    !Array.isArray(saved.search.probes) ||
    !Array.isArray(saved.chunks) ||
    !Array.isArray(saved.finalSnapshots)
  )
    throw new Error('Checkpoint shape invalid')
  const probes = new Map()
  for (const probe of saved.search.probes) {
    if (
      !Number.isSafeInteger(probe.block) ||
      probe.block < 0 ||
      probe.block > END_BLOCK ||
      !HASH.test(probe.hash) ||
      typeof probe.hasCode !== 'boolean' ||
      !/^[0-9a-f]{64}$/.test(probe.codeSha256) ||
      probes.has(probe.block)
    )
      throw new Error('Invalid code probe')
    probes.set(probe.block, probe)
  }
  if (saved.endHash && probes.get(END_BLOCK)?.hash !== saved.endHash)
    throw new Error('End hash mismatch')
  if (saved.search.absentBelow >= 0 && probes.get(saved.search.absentBelow)?.hasCode !== false)
    throw new Error('Absent boundary missing')
  if (saved.search.presentAt !== null && probes.get(saved.search.presentAt)?.hasCode !== true)
    throw new Error('Present boundary missing')
  if (
    saved.deploymentBlock !== null &&
    (saved.deploymentBlock !== saved.search.presentAt ||
      saved.search.absentBelow !== saved.deploymentBlock - 1)
  )
    throw new Error('Deployment boundary invalid')
  let frontier = saved.deploymentBlock
  let count = 0
  const ids = new Set(),
    seen = new Set(),
    created = new Map()
  for (const chunk of saved.chunks) {
    if (
      frontier === null ||
      chunk.from !== frontier ||
      !Number.isSafeInteger(chunk.to) ||
      chunk.to < chunk.from ||
      chunk.to > END_BLOCK ||
      chunk.to - chunk.from + 1 > MAX_CHUNK_BLOCKS ||
      !HASH.test(chunk.fromHash) ||
      !HASH.test(chunk.toHash) ||
      !Array.isArray(chunk.logs) ||
      !Array.isArray(chunk.snapshots) ||
      digest(chunk.logs) !== chunk.logsSha256 ||
      digest(chunk.snapshots) !== chunk.snapshotsSha256
    )
      throw new Error('Chunk coverage/hash invalid')
    let previous = [-1, -1, -1]
    const touched = new Set()
    for (const log of chunk.logs) {
      if (
        !EVENT_KINDS.includes(log.kind) ||
        !Number.isSafeInteger(log.block) ||
        log.block < chunk.from ||
        log.block > chunk.to ||
        !HASH.test(log.blockHash) ||
        !Number.isSafeInteger(log.timestamp) ||
        log.timestamp < 0 ||
        !HASH.test(log.txHash) ||
        !Number.isSafeInteger(log.txIndex) ||
        !Number.isSafeInteger(log.logIndex) ||
        !UINT.test(log.payloadId) ||
        BigInt(log.payloadId) >= 2n ** 40n ||
        (log.block === chunk.from && log.blockHash !== chunk.fromHash) ||
        (log.block === chunk.to && log.blockHash !== chunk.toHash) ||
        log.block < previous[0] ||
        (log.block === previous[0] && (log.txIndex < previous[1] || log.logIndex <= previous[2]))
      )
        throw new Error('Stored lifecycle order/metadata invalid')
      const coord = `${log.blockHash}:${log.txHash}:${log.logIndex}`
      if (seen.has(coord)) throw new Error('Duplicate lifecycle log')
      seen.add(coord)
      if (log.kind === 'PayloadCreated') {
        if (
          created.has(log.payloadId) ||
          !ADDRESS.test(log.creator) ||
          !Array.isArray(log.actions) ||
          !log.actions.length ||
          !Number.isSafeInteger(log.maximumAccessLevelRequired)
        )
          throw new Error('Invalid creation')
        log.actions.forEach(normalizeAction)
        created.set(log.payloadId, log)
      } else if (!created.has(log.payloadId)) throw new Error('Lifecycle event before creation')
      ids.add(log.payloadId)
      touched.add(`${log.payloadId}:${log.block}`)
      previous = [log.block, log.txIndex, log.logIndex]
    }
    const snapKeys = new Set()
    for (const item of chunk.snapshots) {
      const key = `${item.payloadId}:${item.block}`
      if (
        !touched.has(key) ||
        snapKeys.has(key) ||
        !HASH.test(item.blockHash) ||
        !Number.isSafeInteger(item.timestamp) ||
        item.blockCloseOnly !== true ||
        item.capIntent !== 'unknown' ||
        !['ok', 'error'].includes(item.status)
      )
        throw new Error('Snapshot coverage invalid')
      const log = chunk.logs.find(
        (candidate) => candidate.payloadId === item.payloadId && candidate.block === item.block,
      )
      if (log.blockHash !== item.blockHash || log.timestamp !== item.timestamp)
        throw new Error('Snapshot block metadata mismatch')
      if (item.status === 'error' && item.reason !== 'pinned-getter-failed')
        throw new Error('Snapshot error invalid')
      if (item.status === 'ok') {
        if (
          !ADDRESS.test(item.creator) ||
          !Number.isSafeInteger(item.state) ||
          item.state > 5 ||
          !Array.isArray(item.actions) ||
          !item.actions.length ||
          ![
            'createdAt',
            'queuedAt',
            'executedAt',
            'cancelledAt',
            'expirationTime',
            'delay',
            'gracePeriod',
          ].every((field) => Number.isSafeInteger(item[field]) && item[field] >= 0)
        )
          throw new Error('Snapshot payload invalid')
        item.actions.forEach(normalizeAction)
        const creation = created.get(item.payloadId)
        if (
          item.creator !== creation.creator ||
          JSON.stringify(item.actions) !== JSON.stringify(creation.actions) ||
          item.createdAt !== creation.timestamp
        )
          throw new Error('Getter/event creation mismatch')
      }
      snapKeys.add(key)
    }
    if (snapKeys.size !== touched.size) throw new Error('Missing block-close snapshot')
    count += chunk.logs.length
    frontier = chunk.to + 1
  }
  if (
    count > MAX_LOGS ||
    ids.size > MAX_PAYLOADS ||
    (saved.deploymentBlock === null ? saved.nextBlock !== null : saved.nextBlock !== frontier) ||
    (saved.endPayloadsCount !== null &&
      (saved.nextBlock !== END_BLOCK + 1 || saved.endPayloadsCount > MAX_PAYLOADS)) ||
    (saved.status === 'complete' &&
      (saved.nextBlock !== END_BLOCK + 1 ||
        saved.endPayloadsCount !== created.size ||
        saved.finalSnapshots.length !== created.size ||
        saved.finalSnapshots.some((item) => item.status !== 'ok') ||
        saved.chunks.some((chunk) => chunk.snapshots.some((item) => item.status !== 'ok'))))
  )
    throw new Error('Frontier/resource/completion invalid')
  // createPayload increments a zero-based uint40 counter. Gaps mean the
  // single-provider log stream omitted a created-only payload.
  for (let id = 0; id < created.size; id++)
    if (!created.has(String(id))) throw new Error('Missing created payload ID')
  if (saved.endPayloadsCount !== null && saved.endPayloadsCount !== created.size)
    throw new Error('Pinned end payload count differs from created logs')
  // Reconstruct lifecycle solely from log order at or before each touched block.
  // Expiry emits no event: it is computed from the state machine's timestamp rule.
  const lifecycle = new Map()
  for (const chunk of saved.chunks) {
    const blocks = [...new Set(chunk.logs.map((log) => log.block))]
    for (const block of blocks) {
      const blockLogs = chunk.logs.filter((log) => log.block === block)
      for (const log of blockLogs) {
        const prior = lifecycle.get(log.payloadId)
        if (log.kind === 'PayloadCreated') {
          if (prior) throw new Error('Duplicate lifecycle creation')
          lifecycle.set(log.payloadId, {
            state: 1,
            createdAt: log.timestamp,
            queuedAt: 0,
            executedAt: 0,
            cancelledAt: 0,
          })
          continue
        }
        if (
          !prior ||
          (log.kind === 'PayloadQueued' && prior.state !== 1) ||
          (log.kind === 'PayloadExecuted' && prior.state !== 2) ||
          (log.kind === 'PayloadCancelled' && ![1, 2].includes(prior.state))
        )
          throw new Error('Invalid lifecycle transition')
        if (log.kind === 'PayloadQueued') {
          prior.state = 2
          prior.queuedAt = log.timestamp
        }
        if (log.kind === 'PayloadExecuted') {
          prior.state = 3
          prior.executedAt = log.timestamp
        }
        if (log.kind === 'PayloadCancelled') {
          prior.state = 4
          prior.cancelledAt = log.timestamp
        }
      }
      for (const item of chunk.snapshots.filter(
        (snap) => snap.block === block && snap.status === 'ok',
      )) {
        const expected = lifecycle.get(item.payloadId)
        if (!expected) throw new Error('Snapshot before lifecycle creation')
        let state = expected.state
        if (state === 1 && item.timestamp >= item.expirationTime) state = 5
        if (state === 2 && item.timestamp >= item.queuedAt + item.delay + item.gracePeriod)
          state = 5
        if (
          item.state !== state ||
          item.createdAt !== expected.createdAt ||
          item.queuedAt !== expected.queuedAt ||
          item.executedAt !== expected.executedAt ||
          item.cancelledAt !== expected.cancelledAt
        )
          throw new Error('Pinned getter/lifecycle state mismatch')
      }
    }
  }
  if (
    saved.finalSnapshots.length > created.size ||
    (saved.finalSnapshots.length && saved.endPayloadsCount === null)
  )
    throw new Error('Final snapshot frontier invalid')
  for (let index = 0; index < saved.finalSnapshots.length; index++) {
    const item = saved.finalSnapshots[index]
    const id = String(index)
    if (
      item.payloadId !== id ||
      item.block !== END_BLOCK ||
      item.blockHash !== saved.endHash ||
      item.timestamp !== saved.endTimestamp ||
      item.blockCloseOnly !== true ||
      item.capIntent !== 'unknown' ||
      !['ok', 'error'].includes(item.status)
    )
      throw new Error('Final snapshot metadata/frontier invalid')
    if (item.status === 'error') {
      if (item.reason !== 'pinned-getter-failed') throw new Error('Final read error invalid')
      continue
    }
    const creation = created.get(id)
    const expected = lifecycle.get(id)
    if (
      !creation ||
      !expected ||
      !ADDRESS.test(item.creator) ||
      !Number.isSafeInteger(item.state) ||
      item.state > 5 ||
      !Number.isSafeInteger(item.maximumAccessLevelRequired) ||
      !Array.isArray(item.actions) ||
      !item.actions.length ||
      ![
        'createdAt',
        'queuedAt',
        'executedAt',
        'cancelledAt',
        'expirationTime',
        'delay',
        'gracePeriod',
      ].every((field) => Number.isSafeInteger(item[field]) && item[field] >= 0)
    )
      throw new Error('Final getter payload invalid')
    item.actions.forEach(normalizeAction)
    let state = expected.state
    if (state === 1 && item.timestamp >= item.expirationTime) state = 5
    if (state === 2 && item.timestamp >= item.queuedAt + item.delay + item.gracePeriod) state = 5
    if (
      item.creator !== creation.creator ||
      item.maximumAccessLevelRequired !== creation.maximumAccessLevelRequired ||
      JSON.stringify(item.actions) !== JSON.stringify(creation.actions) ||
      item.state !== state ||
      item.createdAt !== expected.createdAt ||
      item.queuedAt !== expected.queuedAt ||
      item.executedAt !== expected.executedAt ||
      item.cancelledAt !== expected.cancelledAt
    )
      throw new Error('Final pinned getter/lifecycle mismatch')
  }
  if (saved.status === 'over-budget' && !['max-logs', 'max-payloads'].includes(saved.stopReason))
    throw new Error('Budget reason invalid')
  return saved
}
export function loadCheckpoint(path = DEFAULT_OUT) {
  return existsSync(path) ? validateCheckpoint(JSON.parse(readFileSync(path, 'utf8'))) : initial()
}

async function probe(client, saved, block, out, checkDisk) {
  const prior = saved.search.probes.find((item) => item.block === block)
  const item = await codeProbe(client, block, prior?.hash)
  if (prior && (prior.hasCode !== item.hasCode || prior.codeSha256 !== item.codeSha256))
    throw new Error('Historical controller code changed')
  if (!prior) saved.search.probes.push(item)
  if (item.hasCode) saved.search.presentAt = Math.min(saved.search.presentAt ?? END_BLOCK, block)
  else saved.search.absentBelow = Math.max(saved.search.absentBelow, block)
  if (block === END_BLOCK) saved.endHash = item.hash
  if (saved.search.presentAt !== null && saved.search.absentBelow >= saved.search.presentAt)
    throw new Error('Code boundary contradiction')
  save(out, saved, checkDisk)
  return item
}
async function discover(client, saved, out, checkDisk, budget) {
  let used = 0
  if (saved.search.presentAt === null && used < budget) {
    const item = await probe(client, saved, END_BLOCK, out, checkDisk)
    used++
    if (!item.hasCode) throw new Error('Controller absent at frozen end')
  }
  while (
    saved.search.presentAt !== null &&
    saved.search.presentAt - saved.search.absentBelow > 1 &&
    used < budget
  ) {
    await probe(
      client,
      saved,
      Math.floor((saved.search.presentAt + saved.search.absentBelow) / 2),
      out,
      checkDisk,
    )
    used++
  }
  if (
    saved.search.presentAt !== null &&
    saved.search.presentAt - saved.search.absentBelow === 1 &&
    saved.deploymentBlock === null
  ) {
    if (
      saved.search.absentBelow === -1 ||
      saved.search.probes.some((item) => item.block === saved.search.absentBelow && !item.hasCode)
    ) {
      saved.deploymentBlock = saved.search.presentAt
      saved.nextBlock = saved.deploymentBlock
      save(out, saved, checkDisk)
    }
  }
}
async function scanChunk(client, saved, out, checkDisk) {
  const from = saved.nextBlock,
    to = Math.min(END_BLOCK, from + MAX_CHUNK_BLOCKS - 1)
  const fromHead = await header(client, from),
    toHead = await header(client, to)
  const raw = await client.request({
    method: 'eth_getLogs',
    params: [
      {
        address: CONTROLLER,
        topics: [TOPICS],
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
      },
    ],
  })
  if (!Array.isArray(raw)) throw new Error('Invalid lifecycle log response')
  const previousLogs = saved.chunks.reduce((sum, chunk) => sum + chunk.logs.length, 0)
  if (previousLogs + raw.length > MAX_LOGS) {
    saved.status = 'over-budget'
    saved.stopReason = 'max-logs'
    save(out, saved, checkDisk)
    return false
  }
  const heads = new Map([
    [from, fromHead],
    [to, toHead],
  ])
  const logs = []
  for (const item of raw) {
    const block = integer(item.blockNumber)
    if (block < from || block > to) throw new Error('Out-of-range lifecycle log')
    if (!heads.has(block)) heads.set(block, await header(client, block))
    logs.push(decodeLifecycle(item, from, to, heads.get(block)))
  }
  logs.sort((a, b) => a.block - b.block || a.txIndex - b.txIndex || a.logIndex - b.logIndex)
  const priorIds = new Set(saved.chunks.flatMap((chunk) => chunk.logs.map((log) => log.payloadId)))
  for (const log of logs) priorIds.add(log.payloadId)
  if (priorIds.size > MAX_PAYLOADS) {
    saved.status = 'over-budget'
    saved.stopReason = 'max-payloads'
    save(out, saved, checkDisk)
    return false
  }
  const touched = new Map()
  for (const log of logs)
    touched.set(`${log.payloadId}:${log.block}`, { id: log.payloadId, head: heads.get(log.block) })
  const snapshots = []
  for (const { id, head } of touched.values()) snapshots.push(await snapshot(client, id, head))
  const chunk = {
    from,
    to,
    fromHash: fromHead.hash,
    toHash: toHead.hash,
    fromImplementation: await implementation(client, fromHead),
    toImplementation: await implementation(client, toHead),
    logs,
    logsSha256: digest(logs),
    snapshots,
    snapshotsSha256: digest(snapshots),
  }
  if (
    (await header(client, from)).hash !== fromHead.hash ||
    (await header(client, to)).hash !== toHead.hash
  )
    throw new Error('Canonical chunk boundary changed')
  const proposed = { ...saved, chunks: [...saved.chunks, chunk], nextBlock: to + 1 }
  validateCheckpoint(envelope(proposed))
  saved.chunks.push(chunk)
  saved.nextBlock = to + 1
  save(out, saved, checkDisk)
  return true
}
async function retryMissing(client, saved, out, checkDisk, maxReads) {
  let used = 0
  for (const chunk of saved.chunks)
    for (let i = 0; i < chunk.snapshots.length && used < maxReads; i++) {
      const prior = chunk.snapshots[i]
      if (prior.status !== 'error') continue
      const head = await header(client, prior.block)
      if (head.hash !== prior.blockHash || head.timestamp !== prior.timestamp)
        throw new Error('Retry block changed')
      chunk.snapshots[i] = await snapshot(client, prior.payloadId, head)
      chunk.snapshotsSha256 = digest(chunk.snapshots)
      validateCheckpoint(envelope(saved))
      save(out, saved, checkDisk)
      used++
    }
}
async function pinnedPayloadCount(client, endHash) {
  const data = await client.request({
    method: 'eth_call',
    params: [
      {
        to: CONTROLLER,
        data: encodeFunctionData({ abi: ABI, functionName: 'getPayloadsCount' }),
      },
      pin(endHash),
    ],
  })
  return integer(decodeFunctionResult({ abi: ABI, functionName: 'getPayloadsCount', data }))
}
async function collectFinalSnapshots(client, saved, out, checkDisk, maxReads) {
  if (saved.nextBlock !== END_BLOCK + 1 || !maxReads) return
  const end = await header(client, END_BLOCK)
  if (end.hash !== saved.endHash || end.timestamp !== saved.endTimestamp)
    throw new Error('Final snapshot canonical end changed')
  let used = 0
  for (let index = 0; index < saved.endPayloadsCount && used < maxReads; index++) {
    if (saved.finalSnapshots[index]?.status === 'ok') continue
    // Sequential ID frontier; errors are retried in place before extending it.
    if (index > saved.finalSnapshots.length) throw new Error('Final read frontier gap')
    const item = await snapshot(client, String(index), end)
    if (index === saved.finalSnapshots.length) saved.finalSnapshots.push(item)
    else saved.finalSnapshots[index] = item
    used++
    if (used % 50 === 0) {
      validateCheckpoint(envelope(saved))
      save(out, saved, checkDisk)
    }
  }
  if (used % 50 !== 0) {
    validateCheckpoint(envelope(saved))
    save(out, saved, checkDisk)
  }
}
export async function run({
  out = DEFAULT_OUT,
  client,
  maxCodeSteps = 0,
  maxNewChunks = 0,
  maxRetries = 0,
  maxFinalReads = 0,
  checkDisk = diskOk,
} = {}) {
  for (const [name, value] of Object.entries({
    maxCodeSteps,
    maxNewChunks,
    maxRetries,
    maxFinalReads,
  }))
    if (!Number.isSafeInteger(value) || value < 0 || value > 500)
      throw new Error(`${name} must be 0..500`)
  const saved = loadCheckpoint(out)
  if (saved.status !== 'partial' || !(maxCodeSteps || maxNewChunks || maxRetries || maxFinalReads))
    return summarize(saved)
  // Guard before even the chain ID RPC. Do not write a disk-floor status below floor.
  checkDisk(out)
  if (!client) throw new Error('RPC client required')
  const beforeRpc = () => {
    try {
      checkDisk(out)
    } catch {
      const error = new Error('Disk reserve guard stopped RPC')
      error.code = 'DISK_GUARD'
      throw error
    }
  }
  const guardedClient = {
    getBlock: (...args) => {
      beforeRpc()
      return client.getBlock(...args)
    },
    request: (...args) => {
      beforeRpc()
      return client.request(...args)
    },
  }
  if (integer(await guardedClient.request({ method: 'eth_chainId', params: [] })) !== 1)
    throw new Error('RPC chainId is not Ethereum mainnet')
  if (saved.endHash && (await header(guardedClient, END_BLOCK)).hash !== saved.endHash)
    throw new Error('Frozen end canonical hash changed')
  if (saved.chunks.length) {
    const previous = saved.chunks.at(-1)
    if ((await header(guardedClient, previous.to)).hash !== previous.toHash)
      throw new Error('Resume canonical boundary changed')
  }
  if (saved.deploymentBlock === null && maxCodeSteps)
    await discover(guardedClient, saved, out, checkDisk, maxCodeSteps)
  if (maxRetries) await retryMissing(guardedClient, saved, out, checkDisk, maxRetries)
  for (
    let i = 0;
    saved.deploymentBlock !== null && saved.nextBlock <= END_BLOCK && i < maxNewChunks;
    i++
  ) {
    checkDisk(out)
    if (!(await scanChunk(guardedClient, saved, out, checkDisk))) return summarize(saved)
  }
  if (saved.nextBlock === END_BLOCK + 1) {
    if (saved.endPayloadsCount === null) {
      const end = await header(guardedClient, END_BLOCK)
      if (saved.endHash && end.hash !== saved.endHash)
        throw new Error('Frozen end canonical hash changed')
      const count = await pinnedPayloadCount(guardedClient, end.hash)
      if (count > MAX_PAYLOADS) {
        saved.status = 'over-budget'
        saved.stopReason = 'max-payloads'
        save(out, saved, checkDisk)
        return summarize(saved)
      }
      saved.endPayloadsCount = count
      saved.endTimestamp = end.timestamp
      validateCheckpoint(envelope(saved))
      save(out, saved, checkDisk)
    }
    if (maxFinalReads)
      await collectFinalSnapshots(guardedClient, saved, out, checkDisk, maxFinalReads)
    if (
      saved.finalSnapshots.length === saved.endPayloadsCount &&
      saved.finalSnapshots.every((item) => item.status === 'ok') &&
      saved.chunks.every((chunk) => chunk.snapshots.every((item) => item.status === 'ok'))
    ) {
      saved.status = 'complete'
      validateCheckpoint(envelope(saved))
      save(out, saved, checkDisk)
    }
  }
  return summarize(saved)
}
function options(argv) {
  const mode = argv[0]
  if (
    !['--plan', '--run', '--verify'].includes(mode) ||
    (mode === '--verify' && argv[1] !== 'offline')
  )
    throw new Error('Expected --plan, --run, or --verify offline')
  const args = {}
  for (let i = mode === '--verify' ? 2 : 1; i < argv.length; i += 2) {
    if (
      ![
        '--out',
        '--max-code-steps',
        '--max-new-chunks',
        '--max-retries',
        '--max-final-reads',
      ].includes(argv[i]) ||
      argv[i + 1] === undefined ||
      args[argv[i]] !== undefined
    )
      throw new Error('Invalid CLI option')
    args[argv[i]] = argv[i + 1]
  }
  if (mode !== '--run' && Object.keys(args).some((key) => key !== '--out'))
    throw new Error('Budgets are run-only')
  return { mode, args }
}
async function main() {
  const { mode, args } = options(process.argv.slice(2))
  const out = args['--out'] ? resolve(args['--out']) : DEFAULT_OUT
  if (mode === '--verify' && !existsSync(out)) throw new Error('No checkpoint to verify')
  if (mode !== '--run') {
    const saved = loadCheckpoint(out)
    console.log(
      JSON.stringify({
        valid: mode === '--verify' ? true : undefined,
        ...summarize(saved),
        checkpointSha256: existsSync(out) ? digest(saved) : null,
      }),
    )
    return
  }
  const budgets = {
    maxCodeSteps: Number(args['--max-code-steps'] ?? 0),
    maxNewChunks: Number(args['--max-new-chunks'] ?? 0),
    maxRetries: Number(args['--max-retries'] ?? 0),
    maxFinalReads: Number(args['--max-final-reads'] ?? 0),
  }
  const client = Object.values(budgets).some(Boolean)
    ? makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL'))
    : null
  console.log(JSON.stringify(await run({ out, client, ...budgets })))
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error('Aave payload stage failed (details withheld to protect RPC credentials)')
    process.exitCode = 1
  })
