// Prospective research-only Aave Ethereum PayloadsController lifecycle watch.
// No RPC, writes, notifications, or inferred reserve intent without --run.
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statfsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeFunctionResult, encodeFunctionData } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { ABI, CONTROLLER, TOPICS, decodeLifecycle } from './aave-payload-lifecycle-collector.mjs'

export const DEFAULT_OUT = resolve('data/research/venue-signals/aave-queue-watch-v1.jsonl')
export const MAX_BLOCKS = 2_000
export const MAX_OPEN_RECHECKS = 128
export const DISK_FLOOR_BYTES = 2.5 * 1024 ** 3
export const SOURCE = Object.freeze({
  chainId: 1,
  controller: CONTROLLER,
  deploymentUrl: 'https://github.com/aave-dao/aave-governance-v3#deployed-addresses',
  interfaceUrl:
    'https://github.com/aave-dao/aave-governance-v3/blob/main/src/contracts/payloads/interfaces/IPayloadsControllerCore.sol',
  codeUrl:
    'https://github.com/aave-dao/aave-governance-v3/blob/main/src/contracts/payloads/PayloadsControllerCore.sol',
  abiSha256: createHash('sha256').update(JSON.stringify(ABI)).digest('hex'),
  topics: TOPICS,
})
const HASH = /^0x[0-9a-f]{64}$/
const BYTES = /^0x(?:[0-9a-f]{2})*$/
const EIP1967 = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const sha = (data) =>
  createHash('sha256')
    .update(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data))
    .digest('hex')
const hexBlock = (n) => `0x${n.toString(16)}`
const numeric = (value) => {
  const n = Number(BigInt(value))
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid RPC integer')
  return n
}
const lower = (value) => String(value).toLowerCase()
const blockPin = (hash) => ({ blockHash: hash, requireCanonical: true })
const validLocalClock = (value) =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value

export function readJournal(path = DEFAULT_OUT) {
  if (!existsSync(path)) return { entries: [], nextBlock: null, lastHash: null, lastBoundary: null }
  const raw = readFileSync(path, 'utf8')
  if (raw && !raw.endsWith('\n')) throw new Error('Incomplete journal tail')
  const entries = raw
    ? raw
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line))
    : []
  let previous = null,
    nextBlock = null,
    lastBoundary = null
  const seenLogs = new Set()
  for (const entry of entries) {
    const { sha256, ...record } = entry
    if (sha(record) !== sha256 || record.previousSha256 !== previous)
      throw new Error('Journal chain mismatch')
    if (JSON.stringify(record.source) !== JSON.stringify(SOURCE))
      throw new Error('Journal source identity mismatch')
    if (
      !['complete', 'provider_failure', 'canonical_conflict', 'coverage_limit'].includes(
        record.status,
      )
    )
      throw new Error('Journal status invalid')
    if (
      !Number.isSafeInteger(record.from) ||
      record.from < 0 ||
      !Number.isSafeInteger(record.to) ||
      record.to < record.from ||
      record.to - record.from + 1 > MAX_BLOCKS
    )
      throw new Error('Journal range invalid')
    if (nextBlock === null) nextBlock = record.from
    if (record.from !== nextBlock) throw new Error('Journal gap/overlap')
    if (record.status === 'complete') {
      // A legacy complete receipt cannot prove when all feature reads finished.
      // Refuse it rather than silently replacing that clock with firstObservedAt.
      if (
        record.receiptVersion !== 2 ||
        !validLocalClock(record.firstObservedAt) ||
        !validLocalClock(record.localFeatureAvailableAt) ||
        Date.parse(record.localFeatureAvailableAt) < Date.parse(record.firstObservedAt)
      )
        throw new Error('Complete receipt local feature clock invalid')
      if (
        !HASH.test(record.fromHash) ||
        !HASH.test(record.toHash) ||
        !/^[0-9a-f]{64}$/.test(record.fromCodeSha256) ||
        !/^[0-9a-f]{64}$/.test(record.toCodeSha256) ||
        !Number.isSafeInteger(record.fromPayloadsCount) ||
        !Number.isSafeInteger(record.toPayloadsCount) ||
        !Array.isArray(record.events) ||
        !Array.isArray(record.snapshots) ||
        !Array.isArray(record.frontierSnapshots) ||
        record.openSetCoverage !== 'observed_payloads_only' ||
        record.frontierSnapshots.length > MAX_OPEN_RECHECKS ||
        record.toPayloadsCount - record.fromPayloadsCount !==
          record.events.filter((event) => event.kind === 'PayloadCreated').length
      )
        throw new Error('Complete receipt invalid')
      for (const event of record.events) {
        const id = `${event.blockHash}:${event.txHash}:${event.logIndex}`
        if (
          seenLogs.has(id) ||
          event.block < record.from ||
          event.block > record.to ||
          !HASH.test(event.blockHash) ||
          !HASH.test(event.txHash) ||
          event.firstObservedAt !== record.firstObservedAt
        )
          throw new Error('Duplicate or invalid event coordinate')
        seenLogs.add(id)
      }
      const createdIds = record.events
        .filter((event) => event.kind === 'PayloadCreated')
        .map((event) => numeric(event.payloadId))
        .sort((a, b) => a - b)
      for (let i = 0; i < createdIds.length; i++)
        if (createdIds[i] !== record.fromPayloadsCount + i)
          throw new Error('Created payload ID sequence invalid')
      const eventBlocks = new Map()
      for (const event of record.events) {
        const key = `${numeric(event.payloadId)}:${event.block}`
        const prior = eventBlocks.get(key)
        if (prior && (prior.blockHash !== event.blockHash || prior.timestamp !== event.timestamp))
          throw new Error('Contradictory event block headers')
        eventBlocks.set(key, { blockHash: event.blockHash, timestamp: event.timestamp })
      }
      const matchedBlocks = new Set()
      for (const snapshot of record.snapshots) {
        const key = `${numeric(snapshot.payloadId)}:${snapshot.block}`
        const event = eventBlocks.get(key)
        if (
          !event ||
          matchedBlocks.has(key) ||
          snapshot.blockHash !== event.blockHash ||
          snapshot.timestamp !== event.timestamp ||
          snapshot.blockCloseOnly !== true
        )
          throw new Error('Event-block snapshot differs from pinned event')
        matchedBlocks.add(key)
      }
      if (matchedBlocks.size !== eventBlocks.size)
        throw new Error('Event lacks exact pinned snapshot')
      const frontierIds = new Set()
      for (const snapshot of record.frontierSnapshots) {
        if (
          snapshot.block !== record.to ||
          snapshot.blockHash !== record.toHash ||
          frontierIds.has(snapshot.payloadId) ||
          snapshot.blockCloseOnly !== true ||
          !['created', 'queued', 'executed', 'cancelled', 'expired'].includes(snapshot.lifecycle)
        )
          throw new Error('Invalid frontier snapshot')
        frontierIds.add(snapshot.payloadId)
      }
      nextBlock = record.to + 1
      lastBoundary = { block: record.to, hash: record.toHash }
    } else if (
      !validLocalClock(record.failedAt) ||
      record.events !== undefined ||
      record.snapshots !== undefined ||
      record.frontierSnapshots !== undefined ||
      record.firstObservedAt !== undefined ||
      record.localFeatureAvailableAt !== undefined
    ) {
      throw new Error('Failure receipt invalid or contains partial observations')
    }
    previous = sha256
  }
  return { entries, nextBlock, lastHash: previous, lastBoundary }
}

function diskOk(path) {
  let dir = dirname(resolve(path))
  while (!existsSync(dir)) dir = dirname(dir)
  const stat = statfsSync(dir)
  if (stat.bavail * stat.bsize < DISK_FLOOR_BYTES) throw new Error('Disk reserve below 2.5 GiB')
}
function append(path, record, previousSha256, checkDisk) {
  checkDisk(path)
  const value = { ...record, previousSha256 }
  const sealed = { ...value, sha256: sha(value) }
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(sealed)}\n`, { mode: 0o600 })
  return sealed
}
function failureClock(now) {
  const value = now()
  if (!validLocalClock(value)) throw new Error('Invalid local failure clock')
  return value
}
async function head(client, n) {
  const value = await client.getBlock({ blockNumber: BigInt(n) })
  const hash = lower(value?.hash)
  if (numeric(value?.number) !== n || !HASH.test(hash)) throw new Error('Invalid block header')
  return { block: n, hash, timestamp: numeric(value.timestamp) }
}
async function codeIdentity(client, h) {
  const code = lower(
    await client.request({ method: 'eth_getCode', params: [CONTROLLER, blockPin(h.hash)] }),
  )
  if (!BYTES.test(code) || code === '0x') throw new Error('Controller code unavailable')
  const word = lower(
    await client.request({
      method: 'eth_getStorageAt',
      params: [CONTROLLER, EIP1967, blockPin(h.hash)],
    }),
  )
  if (!HASH.test(word)) throw new Error('Proxy slot unavailable')
  const address = `0x${word.slice(-40)}`
  const implementation = /^0x0{40}$/.test(address)
    ? { status: 'no_eip1967_implementation' }
    : { status: 'eip1967', address }
  if (implementation.status === 'eip1967') {
    const implCode = lower(
      await client.request({ method: 'eth_getCode', params: [address, blockPin(h.hash)] }),
    )
    if (!BYTES.test(implCode) || implCode === '0x')
      throw new Error('Implementation code unavailable')
    implementation.codeSha256 = sha(Buffer.from(implCode.slice(2), 'hex'))
  }
  return { controllerCodeSha256: sha(Buffer.from(code.slice(2), 'hex')), implementation }
}
async function payloadCountAt(client, h) {
  const data = await client.request({
    method: 'eth_call',
    params: [
      { to: CONTROLLER, data: encodeFunctionData({ abi: ABI, functionName: 'getPayloadsCount' }) },
      blockPin(h.hash),
    ],
  })
  return numeric(decodeFunctionResult({ abi: ABI, functionName: 'getPayloadsCount', data }))
}
async function payloadAt(client, id, h) {
  const data = await client.request({
    method: 'eth_call',
    params: [
      {
        to: CONTROLLER,
        data: encodeFunctionData({ abi: ABI, functionName: 'getPayloadById', args: [BigInt(id)] }),
      },
      blockPin(h.hash),
    ],
  })
  const p = decodeFunctionResult({ abi: ABI, functionName: 'getPayloadById', data })
  const actions = p.actions.map((a) => ({
    target: lower(a.target),
    withDelegateCall: a.withDelegateCall,
    accessLevel: numeric(a.accessLevel),
    value: BigInt(a.value).toString(),
    signature: a.signature,
    callData: lower(a.callData),
  }))
  const snapshot = {
    payloadId: id,
    block: h.block,
    blockHash: h.hash,
    timestamp: h.timestamp,
    blockCloseOnly: true,
    creator: lower(p.creator),
    state: numeric(p.state),
    createdAt: numeric(p.createdAt),
    queuedAt: numeric(p.queuedAt),
    executedAt: numeric(p.executedAt),
    cancelledAt: numeric(p.cancelledAt),
    expirationTime: numeric(p.expirationTime),
    delay: numeric(p.delay),
    gracePeriod: numeric(p.gracePeriod),
    actions,
    capIntent: 'unknown',
    reserveImpact: 'unclassified',
  }
  if (snapshot.state > 5 || !actions.length) throw new Error('Unsupported payload snapshot')
  // executePayload requires block.timestamp > queuedAt + delay (strictly).
  snapshot.earliestExecutableAt = snapshot.queuedAt ? snapshot.queuedAt + snapshot.delay + 1 : null
  snapshot.earliestExecutableAtBasis = 'reference_code_unattested'
  snapshot.referenceThresholdPassed =
    snapshot.earliestExecutableAt !== null && h.timestamp >= snapshot.earliestExecutableAt
  snapshot.executionEligibility = 'unclassified_code_unattested'
  snapshot.lifecycle =
    snapshot.state === 1
      ? 'created'
      : snapshot.state === 2
        ? 'queued'
        : snapshot.state === 3
          ? 'executed'
          : snapshot.state === 4
            ? 'cancelled'
            : 'expired'
  return snapshot
}

export async function run({
  path = DEFAULT_OUT,
  client,
  fromBlock,
  maxBlocks = MAX_BLOCKS,
  now = () => new Date().toISOString(),
  checkDisk = diskOk,
} = {}) {
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > MAX_BLOCKS)
    throw new Error('maxBlocks must be 1..2000')
  const journal = readJournal(path)
  if (journal.nextBlock === null && (!Number.isSafeInteger(fromBlock) || fromBlock < 1))
    throw new Error('First run requires explicit --from-block')
  if (journal.nextBlock !== null && fromBlock !== undefined && fromBlock !== journal.nextBlock)
    throw new Error('fromBlock must match journal frontier')
  if (!client) throw new Error('RPC client required')
  checkDisk(path)
  const guardedClient = {
    getBlock: (...args) => {
      checkDisk(path)
      return client.getBlock(...args)
    },
    request: (...args) => {
      checkDisk(path)
      return client.request(...args)
    },
  }
  const from = journal.nextBlock ?? fromBlock
  const base = { source: SOURCE, from, to: from }
  let stage = 'chain_id'
  try {
    if (numeric(await guardedClient.request({ method: 'eth_chainId', params: [] })) !== 1)
      throw new Error('Wrong chain')
    stage = 'finalized_head'
    const finalized = await guardedClient.getBlock({ blockTag: 'finalized' })
    const finalNumber = numeric(finalized.number)
    if (!HASH.test(lower(finalized.hash)) || finalNumber < from)
      return { status: 'no_finalized_range', from, finalizedBlock: finalNumber }
    const to = Math.min(finalNumber, from + maxBlocks - 1)
    base.to = to
    stage = 'canonical_boundary'
    if (
      journal.lastBoundary &&
      (await head(guardedClient, journal.lastBoundary.block)).hash !== journal.lastBoundary.hash
    ) {
      stage = 'journal_append'
      return append(
        path,
        {
          ...base,
          status: 'canonical_conflict',
          reason: 'prior_finalized_hash_changed',
          failedAt: failureClock(now),
        },
        journal.lastHash,
        checkDisk,
      )
    }
    stage = 'range_headers'
    const previousHead = await head(guardedClient, from - 1)
    const first = await head(guardedClient, from),
      last = await head(guardedClient, to)
    stage = 'controller_code'
    const firstCode = await codeIdentity(guardedClient, first)
    const lastCode = to === from ? firstCode : await codeIdentity(guardedClient, last)
    stage = 'logs'
    const raw = await guardedClient.request({
      method: 'eth_getLogs',
      params: [
        { address: CONTROLLER, topics: [TOPICS], fromBlock: hexBlock(from), toBlock: hexBlock(to) },
      ],
    })
    if (!Array.isArray(raw)) throw new Error('Invalid logs response')
    const observedAt = now()
    if (!Number.isFinite(Date.parse(observedAt))) throw new Error('Invalid local observation clock')
    const headers = new Map([
      [from, first],
      [to, last],
    ])
    const events = []
    for (const log of raw) {
      const n = numeric(log.blockNumber)
      stage = 'log_header'
      if (n < from || n > to) throw new Error('Out-of-range log')
      if (!headers.has(n)) headers.set(n, await head(guardedClient, n))
      events.push(
        decodeLifecycle(log, from, to, {
          block: n,
          hash: headers.get(n).hash,
          timestamp: headers.get(n).timestamp,
        }),
      )
    }
    events.sort((a, b) => a.block - b.block || a.txIndex - b.txIndex || a.logIndex - b.logIndex)
    if (
      new Set(events.map((event) => `${event.blockHash}:${event.txHash}:${event.logIndex}`))
        .size !== events.length
    )
      throw new Error('Duplicate event coordinate')
    stage = 'creation_reconcile'
    const fromPayloadsCount = await payloadCountAt(guardedClient, previousHead)
    const toPayloadsCount = await payloadCountAt(guardedClient, last)
    if (
      toPayloadsCount < fromPayloadsCount ||
      toPayloadsCount - fromPayloadsCount !==
        events.filter((event) => event.kind === 'PayloadCreated').length
    )
      throw new Error('Created log count does not match pinned payload counter')
    const createdIds = events
      .filter((event) => event.kind === 'PayloadCreated')
      .map((event) => numeric(event.payloadId))
      .sort((a, b) => a - b)
    for (let i = 0; i < createdIds.length; i++)
      if (createdIds[i] !== fromPayloadsCount + i)
        throw new Error('Created payload ID sequence does not match pinned counter')
    stage = 'pinned_getter'
    const touched = new Map(
      events.map((e) => [
        `${e.payloadId}:${e.block}`,
        { id: e.payloadId, h: headers.get(e.block) },
      ]),
    )
    const snapshots = []
    for (const item of touched.values())
      snapshots.push(await payloadAt(guardedClient, item.id, item.h))
    stage = 'event_code'
    const codeByBlock = new Map([
      [from, firstCode],
      [to, lastCode],
    ])
    for (const item of touched.values()) {
      if (codeByBlock.has(item.h.block)) continue
      codeByBlock.set(item.h.block, await codeIdentity(guardedClient, item.h))
    }
    for (const snapshot of snapshots) Object.assign(snapshot, codeByBlock.get(snapshot.block))
    stage = 'open_payload_recheck'
    const priorComplete = journal.entries.findLast((entry) => entry.status === 'complete')
    const openIds = new Set(
      (priorComplete?.frontierSnapshots ?? [])
        .filter((snapshot) => snapshot.state === 1 || snapshot.state === 2)
        .map((snapshot) => snapshot.payloadId),
    )
    for (const snapshot of snapshots)
      if (snapshot.state === 1 || snapshot.state === 2) openIds.add(snapshot.payloadId)
    if (openIds.size > MAX_OPEN_RECHECKS) throw new Error('Open payload recheck bound exceeded')
    const frontierSnapshots = []
    for (const id of openIds) {
      const snapshot = await payloadAt(guardedClient, id, last)
      Object.assign(snapshot, codeByBlock.get(to))
      frontierSnapshots.push(snapshot)
    }
    stage = 'canonical_recheck'
    if (
      (await head(guardedClient, from)).hash !== first.hash ||
      (await head(guardedClient, to)).hash !== last.hash
    )
      throw new Error('Range boundary changed')
    stage = 'feature_availability_clock'
    // This is local availability after every successful read and canonical recheck,
    // not a chain-attested event or block timestamp.
    const localFeatureAvailableAt = now()
    if (
      !validLocalClock(observedAt) ||
      !validLocalClock(localFeatureAvailableAt) ||
      Date.parse(localFeatureAvailableAt) < Date.parse(observedAt)
    )
      throw new Error('Invalid local feature availability clock')
    stage = 'journal_append'
    return append(
      path,
      {
        ...base,
        status: 'complete',
        receiptVersion: 2,
        firstObservedAt: observedAt,
        localFeatureAvailableAt,
        finalizedBlock: finalNumber,
        finalizedHash: lower(finalized.hash),
        fromHash: first.hash,
        toHash: last.hash,
        fromCodeSha256: codeByBlock.get(from).controllerCodeSha256,
        toCodeSha256: codeByBlock.get(to).controllerCodeSha256,
        fromImplementation: codeByBlock.get(from).implementation,
        toImplementation: codeByBlock.get(to).implementation,
        fromPayloadsCount,
        toPayloadsCount,
        events: events.map((e) => ({ ...e, firstObservedAt: observedAt })),
        snapshots,
        frontierSnapshots,
        openSetCoverage: 'observed_payloads_only',
        sourceCaveat:
          'Single-provider non-Created log completeness is uncorroborated; execution threshold is reference-derived and code-unattested',
      },
      journal.lastHash,
      checkDisk,
    )
  } catch (error) {
    if (stage === 'journal_append' || String(error?.message).includes('Disk reserve')) throw error
    const bounded =
      stage === 'open_payload_recheck' && error?.message === 'Open payload recheck bound exceeded'
    return append(
      path,
      {
        ...base,
        status: bounded ? 'coverage_limit' : 'provider_failure',
        failedStage: stage,
        reason: bounded ? 'open_recheck_bound' : 'read_or_validation_failed',
        failedAt: failureClock(now),
      },
      journal.lastHash,
      checkDisk,
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const flag = (name) => {
    const i = args.indexOf(name)
    return i < 0 ? undefined : args[i + 1]
  }
  if (args.includes('--verify'))
    console.log(
      JSON.stringify({
        status: 'verified',
        ...readJournal(flag('--out') ?? DEFAULT_OUT),
        entries: readJournal(flag('--out') ?? DEFAULT_OUT).entries.length,
      }),
    )
  else if (args.includes('--run')) {
    const env = readEnv()
    const rpc = env.get('RECORDER_RPC_URLS') ?? env.get('RECORDER_RPC_URL')
    if (!rpc) throw new Error('Ethereum RPC URL unavailable')
    const result = await run({
      path: flag('--out') ?? DEFAULT_OUT,
      client: makeClient(rpc),
      fromBlock: flag('--from-block') === undefined ? undefined : Number(flag('--from-block')),
      maxBlocks: flag('--max-blocks') === undefined ? MAX_BLOCKS : Number(flag('--max-blocks')),
    })
    console.log(
      JSON.stringify({
        status: result.status,
        from: result.from,
        to: result.to,
        events: result.events?.length ?? 0,
      }),
    )
  } else console.log('Research-only. Use --run --from-block N or --verify; no notifications.')
}
