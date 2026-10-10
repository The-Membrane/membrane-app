// Immutable per-venue range chain for route-aligned flow and inventory evidence.
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { projectRouteLog, routeFor, routeStreamIdentities, sha } from './routeFlow.mjs'

// V1 omitted raw logs; V2 omitted event-block headers. Neither can be
// upgraded without rewriting sealed evidence, so V3 re-reads from RPC.
export const ROUTE_FLOW_ROOT = resolve('data/research/venue-signals/local-route-flows-v3')
const FILE = /^(\d{12})\.json$/
const HASH = /^0x[0-9a-f]{64}$/
const RAW = /^(0|[1-9]\d*)$/
const RESERVE = 1024n * 1024n * 1024n
const nameFor = (index) => `${String(index).padStart(12, '0')}.json`
function requireValue(ok, message) {
  if (!ok) throw new Error(message)
}
function safe(path, kind) {
  if (existsSync(path))
    requireValue(
      kind === 'dir' ? lstatSync(path).isDirectory() : lstatSync(path).isFile(),
      'route_flow_unsafe_path',
    )
}

export function verifyRouteFlowRecord(record, venue, previous = null) {
  const { sha256, ...body } = record
  requireValue(
    sha(body) === sha256 &&
      record.study === 'venue-route-flow-v3' &&
      record.venue === venue.name &&
      record.chainId === 1 &&
      record.sequence === (previous?.sequence ?? 0) + 1 &&
      record.previousSha256 === (previous?.sha256 ?? null),
    'route_flow_record_identity_invalid',
  )
  const expected = routeFor(venue)
  requireValue(
    sha(expected) === record.routeHash && JSON.stringify(expected) === JSON.stringify(record.route),
    'route_flow_config_changed',
  )
  const from = BigInt(record.fromBlock)
  const to = BigInt(record.toBlock)
  requireValue(
    from > 0n &&
      to >= from &&
      BigInt(record.anchor?.number) === from - 1n &&
      BigInt(record.end?.number) === to &&
      BigInt(record.finalized?.number) >= to &&
      [record.anchor?.hash, record.end?.hash, record.finalized?.hash].every((hash) =>
        HASH.test(hash ?? ''),
      ),
    'route_flow_invalid_boundaries',
  )
  if (previous)
    requireValue(
      from === BigInt(previous.toBlock) + 1n &&
        JSON.stringify(record.anchor) === JSON.stringify(previous.end) &&
        JSON.stringify(record.before) === JSON.stringify(previous.after),
      'route_flow_gap_or_inventory_discontinuity',
    )
  requireValue(
    Array.isArray(record.before) &&
      Array.isArray(record.after) &&
      record.before.length === expected.length &&
      record.after.length === expected.length &&
      record.before.every(
        (row, i) =>
          row.address === expected[i].address &&
          RAW.test(row.inventoryRaw ?? '') &&
          row.outputToken ===
            (expected[i].kind === 'psm-buffer'
              ? expected[i].gem
              : expected[i].outputIndex === 0
                ? expected[i].token0
                : expected[i].token1) &&
          Number.isInteger(row.outputDecimals) &&
          row.outputDecimals >= 0 &&
          row.outputDecimals <= 36,
      ) &&
      record.after.every(
        (row, i) =>
          row.address === expected[i].address &&
          RAW.test(row.inventoryRaw ?? '') &&
          row.outputToken === record.before[i].outputToken &&
          row.outputDecimals === record.before[i].outputDecimals &&
          row.source === record.before[i].source,
      ),
    'route_flow_invalid_inventory',
  )
  const streamIdentities = routeStreamIdentities(expected)
  requireValue(
    Array.isArray(record.streams) &&
      record.streams.length === streamIdentities.length &&
      record.streams.every(
        (stream, i) =>
          stream.market === streamIdentities[i].market &&
          stream.topic0 === streamIdentities[i].topic0 &&
          stream.status === 'rpc_returned_not_independently_proven' &&
          Number.isSafeInteger(stream.count) &&
          stream.count >= 0,
      ),
    'route_flow_stream_missing',
  )
  requireValue(
    Array.isArray(record.events) &&
      record.eventSetHash === sha(record.events) &&
      record.events.length === record.streams.reduce((n, stream) => n + stream.count, 0),
    'route_flow_event_set_mismatch',
  )
  const eventBlockNumbers = [...new Set(record.events.map((event) => event.block))].sort((a, b) =>
    Number(BigInt(a) - BigInt(b)),
  )
  requireValue(
    Array.isArray(record.eventBlocks) &&
      record.eventBlocks.length === eventBlockNumbers.length &&
      record.eventBlocks.every(
        (header, i) =>
          header.number === eventBlockNumbers[i] &&
          BigInt(header.number) >= from &&
          BigInt(header.number) <= to &&
          HASH.test(header.hash ?? '') &&
          Number.isSafeInteger(header.timestamp) &&
          header.timestamp >= 0 &&
          (header.number !== record.end.number ||
            JSON.stringify(header) === JSON.stringify(record.end)) &&
          (header.number !== record.finalized.number ||
            JSON.stringify(header) === JSON.stringify(record.finalized)),
      ),
    'route_flow_event_headers_invalid',
  )
  const eventHeaders = new Map(record.eventBlocks.map((header) => [header.number, header]))
  const seen = new Set()
  const counts = new Map(streamIdentities.map((stream) => [`${stream.market}:${stream.topic0}`, 0]))
  for (const event of record.events) {
    const market = expected[event.marketIndex]
    const key = `${event.txHash}:${event.logIndex}`
    let decoded
    try {
      decoded = projectRouteLog(market, event.topics, event.data)
    } catch {
      throw new Error('route_flow_raw_event_decode_failed')
    }
    requireValue(
      market &&
        market.address === event.market &&
        BigInt(event.block) >= from &&
        BigInt(event.block) <= to &&
        HASH.test(event.blockHash ?? '') &&
        event.blockHash === eventHeaders.get(event.block)?.hash &&
        event.blockTime === eventHeaders.get(event.block)?.timestamp &&
        HASH.test(event.txHash ?? '') &&
        Number.isSafeInteger(event.logIndex) &&
        event.logIndex >= 0 &&
        event.topic0 === decoded.topic0 &&
        JSON.stringify(event.topics) === JSON.stringify(decoded.topics) &&
        event.data === decoded.data &&
        event.direction === decoded.direction &&
        event.outputRaw === decoded.outputRaw &&
        event.inputRaw === decoded.inputRaw &&
        event.scope === decoded.scope &&
        Number.isSafeInteger(event.blockTime) &&
        event.blockTime >= 0 &&
        event.outputToken === record.after[event.marketIndex].outputToken &&
        event.outputDecimals === record.after[event.marketIndex].outputDecimals &&
        counts.has(`${event.market}:${event.topic0}`) &&
        !seen.has(key),
      'route_flow_invalid_event',
    )
    seen.add(key)
    counts.set(`${event.market}:${event.topic0}`, counts.get(`${event.market}:${event.topic0}`) + 1)
  }
  requireValue(
    record.streams.every(
      (stream) => counts.get(`${stream.market}:${stream.topic0}`) === stream.count,
    ),
    'route_flow_stream_count_mismatch',
  )
  requireValue(
    record.limits?.futureFlow === 'unavailable' &&
      record.limits?.providerCompleteness === 'not_independently_proven' &&
      record.limits?.psmHolderAttribution === 'unavailable_shared_psm_leg',
    'route_flow_limits_missing',
  )
  return record
}

export function localRouteFlowStore({
  root = ROUTE_FLOW_ROOT,
  publish = linkSync,
  stat = statfsSync,
} = {}) {
  function directory(venue) {
    requireValue(/^(sUSDe|sUSDS|scrvUSD)$/.test(venue.name), 'route_flow_invalid_venue')
    safe(root, 'dir')
    return join(root, venue.name)
  }
  function replay(venue) {
    const records = []
    const dir = directory(venue)
    safe(dir, 'dir')
    if (!existsSync(dir)) return []
    const names = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
    requireValue(names.length <= 100_000, 'route_flow_range_limit')
    for (const [index, name] of names.entries()) {
      requireValue(FILE.test(name) && name === nameFor(index + 1), 'route_flow_sequence_gap')
      const path = join(dir, name)
      safe(path, 'file')
      const bytes = readFileSync(path, 'utf8')
      requireValue(Buffer.byteLength(bytes) <= 16 * 1024 * 1024, 'route_flow_file_too_large')
      let record
      try {
        record = JSON.parse(bytes)
      } catch {
        throw new Error('route_flow_invalid_json')
      }
      requireValue(bytes === `${JSON.stringify(record)}\n`, 'route_flow_noncanonical_bytes')
      records.push(verifyRouteFlowRecord(record, venue, records.at(-1) ?? null))
    }
    return records
  }
  return {
    read: replay,
    append(venue, range) {
      const prior = replay(venue).at(-1) ?? null
      const body = {
        ...range,
        sequence: (prior?.sequence ?? 0) + 1,
        previousSha256: prior?.sha256 ?? null,
      }
      const record = { ...body, sha256: sha(body) }
      verifyRouteFlowRecord(record, venue, prior)
      const bytes = `${JSON.stringify(record)}\n`
      requireValue(Buffer.byteLength(bytes) <= 16 * 1024 * 1024, 'route_flow_file_too_large')
      let ancestor = root
      while (!existsSync(ancestor)) {
        const parent = dirname(ancestor)
        requireValue(parent !== ancestor, 'route_flow_no_ancestor')
        ancestor = parent
      }
      const disk = stat(ancestor, { bigint: true })
      requireValue(
        disk.bavail * disk.bsize - BigInt(Buffer.byteLength(bytes)) >= RESERVE,
        'route_flow_disk_reserve_reached',
      )
      const dir = directory(venue)
      mkdirSync(dir, { recursive: true })
      const target = join(dir, nameFor(record.sequence))
      const temp = `${target}.${randomUUID()}.tmp`
      let fd
      try {
        fd = openSync(temp, 'wx', 0o600)
        writeFileSync(fd, bytes)
        fsyncSync(fd)
        closeSync(fd)
        fd = undefined
        publish(temp, target)
      } finally {
        if (fd !== undefined) closeSync(fd)
        if (existsSync(temp)) unlinkSync(temp)
      }
      return record
    },
  }
}
