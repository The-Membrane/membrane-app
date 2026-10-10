// Prospective, bounded ERC4626 gross events for the three frozen Fluid fTokens.
// Deposit is not cash replenishment; Withdraw is not final holder payout.
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  writeSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeEventLog, keccak256, parseAbi, parseAbiItem, toEventHash } from 'viem'
import {
  ROUTES,
  STORE as PROOF_STORE,
  configuredClients,
  validateProof,
} from './carry-fluid-ftoken-payout.mjs'

export const OUT = resolve('data/research/venue-signals/local-fluid-ftoken-gross-flow-v1')
export const MAX_BLOCKS = 8
const MAX_LOGS = 256
const MAX_RANGES_PER_TICK = 4
// At four 8-block ranges per 360-second native tick, this allows roughly
// 52 days of continuous capture. Each row remains subject to the 2 GiB reserve.
export const MAX_ARCHIVE_RANGES = 50_000
const MAX_RPC_CALLS_PER_TICK = 192
const MAX_RPC_BYTES_PER_TICK = 4 * 1024 * 1024
const MAX_TICK_MS = 240_000
const MAX_BYTES = 1024 * 1024
const RESERVE = 2n * 1024n ** 3n
const EVENT = [
  parseAbiItem(
    'event Deposit(address indexed sender,address indexed owner,uint256 assets,uint256 shares)',
  ),
  parseAbiItem(
    'event Withdraw(address indexed sender,address indexed receiver,address indexed owner,uint256 assets,uint256 shares)',
  ),
]
const TOPICS = EVENT.map((event) => toEventHash(event).toLowerCase())
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function getData() view returns (address liquidity,address factory,address rewards,address permit2,address rebalancer,bool rewardsActive,uint256 liquidityBalance,uint256 liquidityExchangePrice,uint256 tokenExchangePrice)',
])
const HASH = /^0x[a-f0-9]{64}$/
const RAW = /^(0|[1-9][0-9]*)$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const fail = (code) => {
  throw new Error(`fluid_flow_${code}`)
}
const assert = (condition, code) => {
  if (!condition) fail(code)
}
const lower = (value) => String(value).toLowerCase()
const number = (value) => {
  assert(typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value), 'quantity')
  const n = Number(BigInt(value))
  assert(Number.isSafeInteger(n) && n >= 0, 'quantity')
  return n
}
const hex = (value) => `0x${value.toString(16)}`
const sealed = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const unseal = (row) => {
  assert(row && /^[a-f0-9]{64}$/.test(row.sha256), 'sha')
  const { sha256, ...body } = row
  assert(sha(JSON.stringify(body)) === sha256, 'sha')
  return row
}
function read(path) {
  const bytes = readFileSync(path)
  assert(bytes.length <= MAX_BYTES && bytes.toString().endsWith('\n'), 'file_format')
  const row = unseal(JSON.parse(bytes.toString()))
  assert(bytes.equals(Buffer.from(`${JSON.stringify(row)}\n`)), 'file_format')
  return row
}
function write(path, body) {
  const row = sealed(body)
  const bytes = Buffer.from(`${JSON.stringify(row)}\n`)
  assert(bytes.length <= MAX_BYTES, 'size_cap')
  let ancestor = dirname(path)
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  const fs = statfsSync(ancestor, { bigint: true })
  assert(fs.bavail * fs.bsize - BigInt(bytes.length) >= RESERVE, 'disk_reserve')
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      let written = 0
      while (written < bytes.length) written += writeSync(fd, bytes, written)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    linkSync(tmp, path)
    const dirFd = openSync(dirname(path), 'r')
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp)
  }
  return row
}
function header(block) {
  const row = {
    number: Number(block.number),
    hash: lower(block.hash),
    parentHash: lower(block.parentHash),
    timestamp: Number(block.timestamp),
  }
  assert(
    Number.isSafeInteger(row.number) &&
      HASH.test(row.hash) &&
      HASH.test(row.parentHash) &&
      Number.isSafeInteger(row.timestamp) &&
      row.timestamp > 0,
    'header',
  )
  return row
}
function validateHeaders(headers, anchor) {
  assert(
    Array.isArray(headers) && headers.length >= 1 && headers.length <= MAX_BLOCKS + 1,
    'headers',
  )
  headers.forEach((h, i) => {
    assert(
      HASH.test(h.hash) && HASH.test(h.parentHash) && Number.isSafeInteger(h.timestamp),
      'header',
    )
    if (i)
      assert(
        h.number === headers[i - 1].number + 1 &&
          h.parentHash === headers[i - 1].hash &&
          h.timestamp >= headers[i - 1].timestamp,
        'header_chain',
      )
  })
  assert(same(headers[0], anchor), 'anchor')
}
async function identity(client, height, proof) {
  const result = []
  for (const [i, route] of ROUTES.entries()) {
    const [asset, data, code] = await Promise.all([
      client.readContract({
        address: route.vault,
        abi: ABI,
        functionName: 'asset',
        blockNumber: BigInt(height),
      }),
      client.readContract({
        address: route.vault,
        abi: ABI,
        functionName: 'getData',
        blockNumber: BigInt(height),
      }),
      client.getCode({ address: route.vault, blockNumber: BigInt(height) }),
    ])
    const row = {
      vault: route.vault,
      asset: lower(asset),
      liquidity: lower(data[0]),
      runtimeCodeHash: code ? keccak256(code) : null,
    }
    assert(
      row.asset === route.asset &&
        row.liquidity === proof.routes[i].liquidity &&
        row.runtimeCodeHash === proof.routes[i].codeHashes.implementation,
      'identity_changed',
    )
    result.push(row)
  }
  return result
}
function rawLog(raw, routeIndex, headers) {
  const topic = lower(raw.topics?.[0])
  const kind = TOPICS.indexOf(topic)
  assert(
    kind >= 0 &&
      lower(raw.address) === ROUTES[routeIndex].vault &&
      raw.topics.length === (kind === 0 ? 3 : 4) &&
      /^0x[a-fA-F0-9]{128}$/.test(raw.data),
    'log_shape',
  )
  const blockNumber = number(raw.blockNumber)
  const block = headers.find((h) => h.number === blockNumber)
  assert(
    block && block.hash === lower(raw.blockHash) && HASH.test(lower(raw.transactionHash)),
    'log_block',
  )
  const args = decodeEventLog({
    abi: [EVENT[kind]],
    topics: raw.topics,
    data: raw.data,
    strict: true,
  }).args
  const row = {
    routeIndex,
    kind: kind === 0 ? 'deposit' : 'withdraw',
    blockNumber,
    blockHash: block.hash,
    transactionHash: lower(raw.transactionHash),
    logIndex: number(raw.logIndex),
    sender: lower(args.sender),
    owner: lower(args.owner),
    ...(kind === 1 ? { receiver: lower(args.receiver) } : {}),
    assetsRaw: String(args.assets),
    sharesRaw: String(args.shares),
  }
  assert(RAW.test(row.assetsRaw) && RAW.test(row.sharesRaw), 'amount')
  return row
}
export function validateRange(row, plan, previous = null) {
  unseal(row)
  assert(
    (previous
      ? row.kind === 'fluid_ftoken_gross_range_v2'
      : row.kind === 'fluid_ftoken_gross_range_v1') &&
      row.planSha256 === plan.sha256 &&
      row.from === (previous?.to ?? plan.anchor.number) + 1 &&
      row.to >= row.from &&
      row.to - row.from + 1 <= MAX_BLOCKS &&
      row.to <= row.finalizedHead &&
      row.finalizedHeads?.length === 2 &&
      row.witnesses?.length === 2 &&
      row.witnesses[0].origin === plan.origins[0] &&
      row.witnesses[1].origin === plan.origins[1],
    'range',
  )
  const anchor = previous?.witnesses[0].headers.at(-1) ?? plan.anchor
  if (previous)
    assert(
      row.previousRangeSha256 === previous.sha256 &&
        row.previousEndpointHash === anchor.hash &&
        row.from === previous.to + 1,
      'previous_range',
    )
  if (previous)
    assert(
      row.endpointCanonicality?.length === 2 &&
        row.endpointCanonicality.every(
          (receipt, i) =>
            receipt.origin === plan.origins[i] &&
            receipt.origin === row.witnesses[i].origin &&
            receipt.blockNumber === row.to &&
            receipt.blockHash === row.witnesses[i].headers.at(-1).hash &&
            receipt.account === ROUTES[0].vault &&
            RAW.test(receipt.balanceRaw),
        ),
      'endpoint_canonicality',
    )
  if (previous)
    assert(
      row.endpointCanonicality[0].balanceRaw === row.endpointCanonicality[1].balanceRaw,
      'origin_disagreement',
    )
  for (const [i, receipt] of row.finalizedHeads.entries()) {
    assert(
      receipt.origin === plan.origins[i] &&
        receipt.origin === row.witnesses[i].origin &&
        Number.isSafeInteger(receipt.header?.number) &&
        HASH.test(receipt.header.hash) &&
        HASH.test(receipt.header.parentHash) &&
        Number.isSafeInteger(receipt.header.timestamp) &&
        receipt.header.number >= row.to &&
        (receipt.header.number !== row.to ||
          receipt.header.hash === row.witnesses[i].headers.at(-1).hash),
      'finalized_receipt',
    )
  }
  assert(
    row.finalizedHead === Math.min(...row.finalizedHeads.map((receipt) => receipt.header.number)),
    'finalized_head',
  )
  for (const witness of row.witnesses) {
    validateHeaders(witness.headers, anchor)
    assert(
      witness.headers.at(-1).number === row.to &&
        same(witness.identity, plan.identity) &&
        Array.isArray(witness.rawLogs) &&
        witness.rawLogs.length <= MAX_LOGS &&
        Array.isArray(witness.events) &&
        witness.events.length <= MAX_LOGS,
      'witness',
    )
    const replay = witness.rawLogs
      .map((log) => rawLog(log, log.routeIndex, witness.headers))
      .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
    assert(same(replay, witness.events), 'raw_replay')
    const keys = new Set()
    for (const event of witness.events) {
      assert(
        Number.isInteger(event.routeIndex) &&
          event.routeIndex >= 0 &&
          event.routeIndex < ROUTES.length &&
          ['deposit', 'withdraw'].includes(event.kind) &&
          RAW.test(event.assetsRaw) &&
          RAW.test(event.sharesRaw) &&
          Number.isSafeInteger(event.logIndex) &&
          event.logIndex >= 0 &&
          event.blockNumber >= row.from &&
          event.blockNumber <= row.to &&
          witness.headers.some(
            (h) => h.number === event.blockNumber && h.hash === event.blockHash,
          ) &&
          HASH.test(event.transactionHash),
        'event',
      )
      const key = `${event.blockNumber}:${event.logIndex}`
      assert(!keys.has(key), 'duplicate_log')
      keys.add(key)
    }
    const sorted = [...witness.events].sort(
      (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex,
    )
    assert(same(sorted, witness.events), 'order')
  }
  assert(
    same(row.witnesses[0].headers, row.witnesses[1].headers) &&
      same(row.witnesses[0].events, row.witnesses[1].events) &&
      same(row.witnesses[0].rawLogs, row.witnesses[1].rawLogs),
    'origin_disagreement',
  )
  const totals = ROUTES.map((route, routeIndex) => {
    const events = row.witnesses[0].events.filter((e) => e.routeIndex === routeIndex)
    return {
      vault: route.vault,
      depositAssetsRaw: String(
        events.filter((e) => e.kind === 'deposit').reduce((n, e) => n + BigInt(e.assetsRaw), 0n),
      ),
      withdrawAssetsRaw: String(
        events.filter((e) => e.kind === 'withdraw').reduce((n, e) => n + BigInt(e.assetsRaw), 0n),
      ),
      depositCount: events.filter((e) => e.kind === 'deposit').length,
      withdrawCount: events.filter((e) => e.kind === 'withdraw').length,
    }
  })
  assert(same(totals, row.grossTotals), 'totals')
  return row
}
export async function createPlan(origins, proof, out = OUT) {
  validateProof(proof)
  assert(origins.length === 2 && origins[0].origin !== origins[1].origin, 'origins')
  const finalized = await Promise.all(
    origins.map((o) => o.client.getBlock({ blockTag: 'finalized' })),
  )
  const height = Number(
    finalized.reduce((n, b) => (b.number < n ? b.number : n), finalized[0].number),
  )
  assert(height > proof.blockNumber, 'prospective_anchor')
  const observations = await Promise.all(
    origins.map(async (o) => ({
      anchor: header(await o.client.getBlock({ blockNumber: BigInt(height) })),
      identity: await identity(o.client, height, proof),
    })),
  )
  assert(same(observations[0], observations[1]), 'origin_disagreement')
  return write(join(out, 'plan.json'), {
    kind: 'fluid_ftoken_gross_plan_v1',
    chainId: 1,
    createdAt: new Date().toISOString(),
    proof,
    anchor: observations[0].anchor,
    identity: observations[0].identity,
    origins: origins.map((o) => o.origin),
    caveat:
      'Deposit and Withdraw are gross ERC4626 events; no cash-replenishment or final-holder-payout inference.',
  })
}
function readPlan(out) {
  if (!existsSync(join(out, 'plan.json'))) fail('plan_missing')
  const plan = read(join(out, 'plan.json'))
  validateProof(plan.proof)
  assert(
    plan.kind === 'fluid_ftoken_gross_plan_v1' &&
      plan.chainId === 1 &&
      plan.anchor.number > plan.proof.blockNumber &&
      plan.origins.length === 2 &&
      plan.origins[0] !== plan.origins[1] &&
      plan.identity.length === 3 &&
      plan.identity.every(
        (row, i) =>
          row.vault === ROUTES[i].vault &&
          row.asset === ROUTES[i].asset &&
          row.liquidity === plan.proof.routes[i].liquidity &&
          row.runtimeCodeHash === plan.proof.routes[i].codeHashes.implementation,
      ),
    'plan',
  )
  return plan
}
function rangeNames(out) {
  // A crash between publishing a hard link and removing its temporary name can
  // leave an orphan. It is never a range and must not block replay of the link.
  const temporary = /^(?:plan|range-\d+-\d+)\.json\.[0-9a-f-]{36}\.tmp$/
  const files = readdirSync(out).sort((a, b) => {
    if (a === 'plan.json') return -1
    if (b === 'plan.json') return 1
    return Number(a.match(/^range-(\d+)/)?.[1]) - Number(b.match(/^range-(\d+)/)?.[1])
  })
  assert(
    files.every((f) => f === 'plan.json' || /^range-\d+-\d+\.json$/.test(f) || temporary.test(f)) &&
      files.includes('plan.json'),
    'files',
  )
  const names = files.filter((f) => f !== 'plan.json' && !temporary.test(f))
  assert(names.length <= MAX_ARCHIVE_RANGES, 'archive_cap')
  return names
}
function totalsAdd(left, right) {
  return left.map((item, i) => ({
    vault: item.vault,
    depositAssetsRaw: String(BigInt(item.depositAssetsRaw) + BigInt(right[i].depositAssetsRaw)),
    withdrawAssetsRaw: String(BigInt(item.withdrawAssetsRaw) + BigInt(right[i].withdrawAssetsRaw)),
    depositCount: item.depositCount + right[i].depositCount,
    withdrawCount: item.withdrawCount + right[i].withdrawCount,
  }))
}
export function verify(out = OUT) {
  const plan = readPlan(out)
  const names = rangeNames(out)
  let previous = null
  let grossTotals = null
  for (const name of names) {
    const row = read(join(out, name))
    assert(name === `range-${row.from}-${row.to}.json`, 'filename')
    validateRange(row, plan, previous)
    previous = row
    grossTotals = grossTotals ? totalsAdd(grossTotals, row.grossTotals) : row.grossTotals
  }
  return {
    planSha256: plan.sha256,
    anchor: plan.anchor.number,
    ranges: names.length,
    through: previous?.to ?? null,
    tipSha256: previous?.sha256 ?? null,
    grossTotals,
    caveat: plan.caveat,
  }
}
function readTip(out, plan) {
  const names = rangeNames(out)
  if (!names.length) return null
  let expected = plan.anchor.number + 1
  for (const name of names) {
    const match = /^range-(\d+)-(\d+)\.json$/.exec(name)
    const from = Number(match[1])
    const to = Number(match[2])
    assert(
      Number.isSafeInteger(from) &&
        Number.isSafeInteger(to) &&
        from === expected &&
        to >= from &&
        to - from + 1 <= MAX_BLOCKS,
      'filename_chain',
    )
    expected = to + 1
  }
  const name = names.at(-1)
  const row = read(join(out, name))
  assert(name === `range-${row.from}-${row.to}.json`, 'filename')
  // The first range is v1. Each later range binds its predecessor; --verify audits the full archive.
  if (names.length === 1) validateRange(row, plan)
  else {
    const prior = read(join(out, names.at(-2)))
    validateRange(row, plan, prior)
  }
  return row
}
function budgetedOrigins(origins, budget) {
  return origins.map((origin) => ({
    origin: origin.origin,
    client: new Proxy(origin.client, {
      get(target, key) {
        const member = target[key]
        if (!['getBlock', 'getBalance', 'readContract', 'getCode', 'request'].includes(key))
          return typeof member === 'function' ? member.bind(target) : member
        return async (...args) => {
          assert(Date.now() < budget.deadline, 'time_budget')
          assert(++budget.calls <= MAX_RPC_CALLS_PER_TICK, 'rpc_call_budget')
          const remaining = budget.deadline - Date.now()
          let timer
          try {
            const value = await Promise.race([
              member.apply(target, args),
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('fluid_flow_time_budget')), remaining)
              }),
            ])
            budget.bytes += Buffer.byteLength(
              JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? String(item) : item)),
            )
            assert(budget.bytes <= MAX_RPC_BYTES_PER_TICK, 'rpc_byte_budget')
            assert(Date.now() < budget.deadline, 'time_budget')
            return value
          } finally {
            clearTimeout(timer)
          }
        }
      },
    }),
  }))
}
export async function capture(
  origins,
  out = OUT,
  budget = {
    calls: 0,
    bytes: 0,
    deadline: Date.now() + MAX_TICK_MS,
  },
) {
  const plan = readPlan(out)
  assert(rangeNames(out).length < MAX_ARCHIVE_RANGES, 'archive_cap')
  const previous = readTip(out, plan)
  assert(
    same(
      origins.map((o) => o.origin),
      plan.origins,
    ),
    'origins',
  )
  const clients = budgetedOrigins(origins, budget)
  const anchor = previous?.witnesses[0].headers.at(-1) ?? plan.anchor
  const finalizedHeads = await Promise.all(
    clients.map(async (o) => ({
      origin: o.origin,
      header: header(await o.client.getBlock({ blockTag: 'finalized' })),
    })),
  )
  const finalizedHead = Math.min(...finalizedHeads.map((receipt) => receipt.header.number))
  assert(finalizedHead > anchor.number, 'no_finalized_range')
  const to = Math.min(finalizedHead, anchor.number + MAX_BLOCKS)
  const witnesses = await Promise.all(
    clients.map(async (o) => {
      const headers = []
      for (let height = anchor.number; height <= to; height++)
        headers.push(header(await o.client.getBlock({ blockNumber: BigInt(height) })))
      validateHeaders(headers, anchor)
      const events = []
      const rawLogs = []
      for (const [routeIndex, route] of ROUTES.entries()) {
        const logs = await o.client.request({
          method: 'eth_getLogs',
          params: [
            {
              address: route.vault,
              fromBlock: hex(anchor.number + 1),
              toBlock: hex(to),
              topics: [TOPICS],
            },
          ],
        })
        assert(Array.isArray(logs) && logs.length + events.length <= MAX_LOGS, 'log_cap')
        for (const log of logs) {
          rawLogs.push({
            routeIndex,
            address: lower(log.address),
            topics: log.topics.map(lower),
            data: lower(log.data),
            blockNumber: log.blockNumber,
            blockHash: lower(log.blockHash),
            transactionHash: lower(log.transactionHash),
            logIndex: log.logIndex,
          })
          events.push(rawLog(log, routeIndex, headers))
        }
      }
      rawLogs.sort(
        (a, b) =>
          number(a.blockNumber) - number(b.blockNumber) || number(a.logIndex) - number(b.logIndex),
      )
      events.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
      return {
        origin: o.origin,
        headers,
        identity: await identity(o.client, to, plan.proof),
        rawLogs,
        events,
      }
    }),
  )
  const endpointCanonicality = previous
    ? await Promise.all(
        clients.map(async (origin, i) => ({
          origin: origin.origin,
          blockNumber: to,
          blockHash: witnesses[i].headers.at(-1).hash,
          account: ROUTES[0].vault,
          balanceRaw: String(
            await origin.client.getBalance({
              address: ROUTES[0].vault,
              blockHash: witnesses[i].headers.at(-1).hash,
              requireCanonical: true,
            }),
          ),
        })),
      )
    : null
  const preliminary = {
    kind: previous ? 'fluid_ftoken_gross_range_v2' : 'fluid_ftoken_gross_range_v1',
    planSha256: plan.sha256,
    ...(previous
      ? {
          previousRangeSha256: previous.sha256,
          previousEndpointHash: anchor.hash,
          endpointCanonicality,
        }
      : {}),
    from: anchor.number + 1,
    to,
    finalizedHead,
    finalizedHeads,
    witnesses,
    grossTotals: [],
  }
  const events = witnesses[0].events
  preliminary.grossTotals = ROUTES.map((route, routeIndex) => {
    const selected = events.filter((e) => e.routeIndex === routeIndex)
    return {
      vault: route.vault,
      depositAssetsRaw: String(
        selected.filter((e) => e.kind === 'deposit').reduce((n, e) => n + BigInt(e.assetsRaw), 0n),
      ),
      withdrawAssetsRaw: String(
        selected.filter((e) => e.kind === 'withdraw').reduce((n, e) => n + BigInt(e.assetsRaw), 0n),
      ),
      depositCount: selected.filter((e) => e.kind === 'deposit').length,
      withdrawCount: selected.filter((e) => e.kind === 'withdraw').length,
    }
  })
  validateRange(sealed(preliminary), plan, previous)
  assert(Date.now() < budget.deadline, 'time_budget')
  return write(join(out, `range-${preliminary.from}-${to}.json`), preliminary)
}
export async function captureNext(origins, out = OUT) {
  const budget = { calls: 0, bytes: 0, deadline: Date.now() + MAX_TICK_MS }
  // Audit the whole existing chain once before a tick can query or publish a successor.
  const startingStatus = verify(out)
  assert(startingStatus.ranges < MAX_ARCHIVE_RANGES, 'archive_cap')
  const rows = []
  for (let i = 0; i < MAX_RANGES_PER_TICK; i++) {
    if (startingStatus.ranges + rows.length >= MAX_ARCHIVE_RANGES) break
    try {
      rows.push(await capture(origins, out, budget))
    } catch (error) {
      if (error.message === 'fluid_flow_no_finalized_range') break
      throw error
    }
  }
  return {
    captured: rows.length,
    through: rows.at(-1)?.to ?? readTip(out, readPlan(out))?.to ?? null,
    rpcCalls: budget.calls,
    rpcBytes: budget.bytes,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2]
    if (mode === '--verify') console.log(JSON.stringify(verify()))
    else if (mode === '--plan') {
      const proofFiles = readdirSync(PROOF_STORE)
        .filter((name) => /^proof-\d+\.json$/.test(name))
        .sort()
      assert(proofFiles.length > 0, 'proof_missing')
      const proof = JSON.parse(readFileSync(join(PROOF_STORE, proofFiles.at(-1)), 'utf8'))
      console.log(
        JSON.stringify({ planSha256: (await createPlan(configuredClients(), proof)).sha256 }),
      )
    } else if (mode === '--capture-next') {
      console.log(JSON.stringify(await captureNext(configuredClients())))
    } else if (mode === '--capture') {
      const row = await capture(configuredClients())
      console.log(JSON.stringify({ from: row.from, to: row.to, grossTotals: row.grossTotals }))
    } else fail('usage')
  } catch (error) {
    console.error(
      error?.message?.startsWith('fluid_flow_') ? error.message : 'fluid_flow_external_error',
    )
    process.exitCode = 1
  }
}
