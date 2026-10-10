// Prospective gross ERC-4626 events for three frozen direct vault addresses.
// This is address-level event flow, not holder payout or implementation attribution.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync, gunzipSync } from 'node:zlib'
import { encodeFunctionData, parseAbi, parseAbiItem, toEventSelector } from 'viem'

import {
  FROZEN_ROUTES,
  MAX_RANGE_BLOCKS,
  TOPICS,
  compareOrigins,
  makeRpc,
  normalizeLogs,
  preflight,
  selectOrigins,
  verifyHeaderChain,
} from './carry-direct-vault-flow-preflight.mjs'
import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls } from './carry-public-direct-exit-issue.mjs'

export const OUT = resolve('data/research/venue-signals/local-direct-vault-gross-flow-v1')
export const MAX_RANGES_PER_TICK = 4
export const MAX_EVENT_BLOCK_PROOFS_PER_RANGE = 3
export const MAX_ARCHIVE_RANGES = 7_500
export const MAX_TICK_RPC_CALLS = 192
export const MAX_TICK_RPC_BYTES = 4 * 1024 * 1024
export const MAX_TICK_MS = 210_000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_DECOMPRESSED_BYTES = 4 * 1024 * 1024
const RESERVE = 2n * 1024n ** 3n
const SHA = /^[0-9a-f]{64}$/
const HASH = /^0x[0-9a-f]{64}$/
const UPGRADED_TOPIC = toEventSelector(
  parseAbiItem('event Upgraded(address indexed implementation)'),
)
const ASSET_DATA = encodeFunctionData({
  abi: parseAbi(['function asset() view returns (address)']),
  functionName: 'asset',
})
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const hash = (value) => createHash('sha256').update(value).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const fail = (code) => {
  throw Error(`direct_vault_flow_${code}`)
}
const assert = (condition, code) => {
  if (!condition) fail(code)
}
const name = (sequence) => `range-${String(sequence).padStart(8, '0')}.json`
const hex = (number) => `0x${number.toString(16)}`

function pack(proof) {
  const json = JSON.stringify(proof)
  assert(Buffer.byteLength(json) <= MAX_DECOMPRESSED_BYTES, 'proof_oversize')
  return { sha256: hash(json), gzipBase64: gzipSync(json).toString('base64') }
}
function unpack(packed) {
  assert(SHA.test(packed?.sha256 ?? '') && typeof packed?.gzipBase64 === 'string', 'proof_pack')
  const compressed = Buffer.from(packed.gzipBase64, 'base64')
  assert(compressed.length <= MAX_FILE_BYTES, 'proof_pack')
  const json = gunzipSync(compressed, { maxOutputLength: MAX_DECOMPRESSED_BYTES }).toString('utf8')
  assert(hash(json) === packed.sha256, 'proof_sha')
  const proof = JSON.parse(json)
  assert(JSON.stringify(proof) === json, 'proof_canonical')
  return proof
}
function seal(body) {
  return { ...body, sha256: hash(JSON.stringify(body)) }
}
function read(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes
  try {
    const stats = fstatSync(fd, { bigint: true })
    assert(stats.isFile(), 'file_regular')
    assert(stats.size <= BigInt(MAX_FILE_BYTES), 'file_oversize')
    bytes = Buffer.alloc(Number(stats.size))
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null)
      assert(count > 0, 'file_changed')
      offset += count
    }
    const extra = Buffer.alloc(1)
    assert(readSync(fd, extra, 0, 1, null) === 0, 'file_oversize')
  } finally {
    closeSync(fd)
  }
  const raw = bytes.toString('utf8')
  const row = JSON.parse(raw)
  assert(raw === `${JSON.stringify(row)}\n`, 'file_canonical')
  const { sha256, ...body } = row
  assert(SHA.test(sha256 ?? '') && hash(JSON.stringify(body)) === sha256, 'file_sha')
  return row
}
function write(path, body) {
  const row = seal(body)
  const bytes = Buffer.from(`${JSON.stringify(row)}\n`)
  assert(bytes.length <= MAX_FILE_BYTES, 'file_oversize')
  let ancestor = dirname(path)
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  const space = statfsSync(ancestor, { bigint: true })
  assert(space.bavail * space.bsize - BigInt(bytes.length) >= RESERVE, 'disk_reserve')
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      let offset = 0
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    linkSync(temporary, path)
    const dir = openSync(dirname(path), 'r')
    try {
      fsyncSync(dir)
    } finally {
      closeSync(dir)
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
  return row
}

/** Offline replay of one preflight result, including raw two-origin event responses. */
export function validateProof(proof, expectedTo = null) {
  assert(proof?.schema === 'carry_direct_vault_flow_preflight_v1', 'proof_schema')
  const { from, to } = proof.range ?? {}
  assert(
    Number.isSafeInteger(from) &&
      Number.isSafeInteger(to) &&
      to - from + 1 === MAX_RANGE_BLOCKS &&
      (expectedTo === null || to === expectedTo),
    'proof_range',
  )
  assert(
    proof.headerChains?.length === 2 && proof.routes?.length === FROZEN_ROUTES.length,
    'proof_shape',
  )
  const left = verifyHeaderChain(proof.headerChains[0].headers, from, to)
  const right = verifyHeaderChain(proof.headerChains[1].headers, from, to)
  compareOrigins(left, right)
  assert(
    proof.headerChains[0].origin !== proof.headerChains[1].origin &&
      proof.range.fromHash === left[0].hash &&
      proof.range.toHash === left.at(-1).hash,
    'proof_boundary',
  )
  const raw = (origin, method, params) => {
    const found = proof.receipts?.filter(
      (receipt) =>
        receipt.origin === origin &&
        receipt.request?.method === method &&
        same(receipt.request?.params, params),
    )
    assert(
      found?.length === 1 && found[0].response?.error === undefined,
      'proof_raw_receipt_missing',
    )
    return found[0].response.result
  }
  for (let j = 0; j < 2; j++) {
    const origin = proof.headerChains[j].origin
    assert(raw(origin, 'eth_chainId', []) === '0x1', 'proof_chain')
    const finalized = raw(origin, 'eth_getBlockByNumber', ['finalized', false])
    assert(
      finalized?.hash?.toLowerCase() === proof.finalizedHeads?.[j]?.hash &&
        Number(BigInt(finalized.number)) === proof.finalizedHeads[j].number &&
        proof.finalizedHeads[j].number >= to,
      'proof_finality',
    )
    for (let number = from; number <= to; number++) {
      const block = raw(origin, 'eth_getBlockByNumber', [hex(number), false])
      const expected = left[number - from]
      assert(
        block?.number === hex(number) &&
          block.hash?.toLowerCase() === expected.hash &&
          block.parentHash?.toLowerCase() === expected.parentHash &&
          Number(BigInt(block.timestamp)) === expected.timestamp,
        'proof_raw_header',
      )
    }
  }
  const pin = { blockHash: left.at(-1).hash, requireCanonical: true }
  const address = (value) => {
    assert(typeof value === 'string' && /^0x0{24}[0-9a-fA-F]{40}$/.test(value), 'proof_raw_address')
    return `0x${value.slice(-40).toLowerCase()}`
  }
  for (let i = 0; i < FROZEN_ROUTES.length; i++) {
    const route = FROZEN_ROUTES[i]
    const observed = proof.routes[i]
    assert(
      observed?.routeKey === route.routeKey &&
        observed.vault === route.vault &&
        observed.asset === route.asset &&
        observed.witnesses?.length === 2,
      'proof_route',
    )
    for (let j = 0; j < 2; j++) {
      const witness = observed.witnesses[j]
      assert(
        witness.origin === proof.headerChains[j].origin &&
          witness.asset === route.asset &&
          witness.runtime?.bytes > 0 &&
          SHA.test(witness.runtime?.sha256 ?? '') &&
          witness.implementation === (route.implementation ?? null),
        'proof_identity',
      )
      const code = raw(witness.origin, 'eth_getCode', [route.vault, pin])
      assert(
        typeof code === 'string' &&
          /^0x(?:[0-9a-fA-F]{2})+$/.test(code) &&
          witness.runtime.bytes === (code.length - 2) / 2 &&
          witness.runtime.sha256 === hash(Buffer.from(code.slice(2), 'hex')),
        'proof_raw_runtime',
      )
      assert(
        address(raw(witness.origin, 'eth_call', [{ to: route.vault, data: ASSET_DATA }, pin])) ===
          route.asset,
        'proof_raw_asset',
      )
      if (route.implementation)
        assert(
          address(raw(witness.origin, 'eth_getStorageAt', [route.vault, IMPL_SLOT, pin])) ===
            route.implementation,
          'proof_raw_implementation',
        )
      const matching = proof.receipts?.filter(
        (receipt) =>
          receipt.origin === witness.origin &&
          receipt.request?.method === 'eth_getLogs' &&
          receipt.request.params?.[0]?.address === route.vault &&
          receipt.request.params?.[0]?.fromBlock === hex(from) &&
          receipt.request.params?.[0]?.toBlock === hex(to) &&
          same(receipt.request.params?.[0]?.topics, [[TOPICS.deposit, TOPICS.withdraw]]),
      )
      assert(matching?.length === 1, 'proof_raw_logs_missing')
      const replay = normalizeLogs(matching[0], route.vault, from, to, left).map((log) => ({
        ...log,
        identityAtPinnedBlock: log.blockNumber === to ? 'verified' : 'unverified_earlier_block',
      }))
      assert(same(replay, witness.logs), 'proof_log_replay')
    }
    compareOrigins(
      { ...observed.witnesses[0], origin: null },
      { ...observed.witnesses[1], origin: null },
    )
    const pinned = observed.witnesses[0].logs.filter((log) => log.blockNumber === to)
    const earlier = observed.witnesses[0].logs.length - pinned.length
    assert(
      observed.depositCount === pinned.filter((log) => log.eventName === 'Deposit').length &&
        observed.withdrawCount === pinned.filter((log) => log.eventName === 'Withdraw').length &&
        observed.earlierUnverifiedEventCount === earlier,
      'proof_counts',
    )
    const expectedStatus = pinned.length
      ? 'standard_events_observed'
      : earlier
        ? 'earlier_events_unverified_identity'
        : 'no_events_in_sampled_range'
    assert(observed.status === expectedStatus, 'proof_status')
  }
  return proof
}

function allEvents(proof) {
  return proof.routes
    .flatMap((route) =>
      route.witnesses[0].logs.map((log) => ({
        routeKey: route.routeKey,
        vault: route.vault,
        ...log,
      })),
    )
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
}
function totals(events) {
  return FROZEN_ROUTES.map((route) => {
    const rows = events.filter((event) => event.vault === route.vault)
    return {
      routeKey: route.routeKey,
      vault: route.vault,
      depositAssetsRaw: rows
        .filter((row) => row.eventName === 'Deposit')
        .reduce((sum, row) => sum + BigInt(row.assetsRaw), 0n)
        .toString(),
      withdrawAssetsRaw: rows
        .filter((row) => row.eventName === 'Withdraw')
        .reduce((sum, row) => sum + BigInt(row.assetsRaw), 0n)
        .toString(),
      depositCount: rows.filter((row) => row.eventName === 'Deposit').length,
      withdrawCount: rows.filter((row) => row.eventName === 'Withdraw').length,
    }
  })
}
const identity = (proof) =>
  proof.routes.map((route) => ({
    vault: route.vault,
    runtime: route.witnesses[0].runtime,
    asset: route.witnesses[0].asset,
    implementation: route.witnesses[0].implementation,
  }))

async function scanUpgrades(urls, from, to, fetchImpl) {
  const origins = selectOrigins(urls)
  const { rpc, budget } = makeRpc(fetchImpl)
  const filter = {
    address: FROZEN_ROUTES.map((route) => route.vault),
    fromBlock: hex(from),
    toBlock: hex(to),
    topics: [UPGRADED_TOPIC],
  }
  const receipts = []
  for (const origin of origins) {
    const receipt = await rpc(origin, 'eth_getLogs', [filter])
    assert(Array.isArray(receipt.response.result), 'upgrade_query_invalid')
    receipts.push(receipt)
  }
  compareOrigins(receipts[0].response.result, receipts[1].response.result)
  assert(receipts[0].response.result.length === 0, 'upgrade_observed')
  return { receipts, calls: budget().calls, bytes: budget().responseBytes }
}

function validateUpgradeReceipts(receipts, from, to, origins) {
  assert(receipts?.length === 2, 'upgrade_receipts')
  const filter = {
    address: FROZEN_ROUTES.map((route) => route.vault),
    fromBlock: hex(from),
    toBlock: hex(to),
    topics: [UPGRADED_TOPIC],
  }
  for (let i = 0; i < 2; i++)
    assert(
      receipts[i].origin === origins[i] &&
        receipts[i].request?.method === 'eth_getLogs' &&
        same(receipts[i].request?.params, [filter]) &&
        same(receipts[i].response?.result, []),
      'upgrade_receipts',
    )
}

function validateRow(row, prior) {
  assert(
    row.kind === 'direct_vault_gross_range_v1' &&
      row.sequence === (prior?.sequence ?? 0) + 1 &&
      row.previousSha256 === (prior?.sha256 ?? null) &&
      row.from === prior.to + 1 &&
      row.to === row.from + MAX_RANGE_BLOCKS - 1 &&
      row.fromParentHash === prior.toHash,
    'range_link',
  )
  const main = validateProof(unpack(row.mainProof), row.to)
  assert(
    main.range.from === row.from &&
      main.range.toHash === row.toHash &&
      main.headerChains[0].headers[0].parentHash === row.fromParentHash,
    'range_boundary',
  )
  const events = allEvents(main)
  assert(same(row.identity, identity(main)) && same(row.identity, prior.identity), 'identity_drift')
  validateUpgradeReceipts(
    row.upgradeReceipts,
    row.from,
    row.to,
    main.headerChains.map((chain) => chain.origin),
  )
  const earlierBlocks = [
    ...new Set(
      events.filter((event) => event.blockNumber < row.to).map((event) => event.blockNumber),
    ),
  ]
  assert(
    earlierBlocks.length <= MAX_EVENT_BLOCK_PROOFS_PER_RANGE &&
      row.eventBlockProofs?.length === earlierBlocks.length,
    'event_proof_count',
  )
  for (let i = 0; i < earlierBlocks.length; i++) {
    const eventBlock = earlierBlocks[i]
    const pinned = validateProof(unpack(row.eventBlockProofs[i]), eventBlock)
    assert(
      same(
        pinned.headerChains.map((chain) => chain.origin),
        main.headerChains.map((chain) => chain.origin),
      ),
      'event_proof_origins',
    )
    assert(
      pinned.range.toHash === main.headerChains[0].headers[eventBlock - row.from].hash,
      'event_proof_hash',
    )
    const pinnedEvents = allEvents(pinned).filter((event) => event.blockNumber === eventBlock)
    const sourceEvents = events.filter((event) => event.blockNumber === eventBlock)
    assert(
      same(
        pinnedEvents,
        sourceEvents.map((event) => ({ ...event, identityAtPinnedBlock: 'verified' })),
      ),
      'event_proof_replay',
    )
    for (let j = 0; j < FROZEN_ROUTES.length; j++)
      assert(
        same(pinned.routes[j].witnesses[0].runtime, main.routes[j].witnesses[0].runtime) &&
          pinned.routes[j].witnesses[0].asset === main.routes[j].witnesses[0].asset &&
          pinned.routes[j].witnesses[0].implementation ===
            main.routes[j].witnesses[0].implementation,
        'event_identity_drift',
      )
  }
  assert(same(totals(events), row.grossTotals), 'range_totals')
  assert(
    row.identityTiming === 'end_of_block_event_schema_at_tracked_address' &&
      row.holderPayout === 'not_measured',
    'range_claim',
  )
  return row
}

export function verify(out = OUT) {
  const planPath = join(out, 'plan.json')
  assert(existsSync(planPath), 'plan_missing')
  const plan = read(planPath)
  assert(
    plan.kind === 'direct_vault_gross_plan_v1' &&
      plan.chainId === 1 &&
      plan.origins?.length === 2 &&
      plan.origins[0] !== plan.origins[1],
    'plan',
  )
  const baseline = validateProof(unpack(plan.proof), plan.anchor.number)
  assert(
    baseline.range.toHash === plan.anchor.hash &&
      same(
        baseline.headerChains.map((chain) => chain.origin),
        plan.origins,
      ) &&
      same(plan.identity, identity(baseline)),
    'plan_anchor',
  )
  const files = readdirSync(out)
    .filter((file) => /^range-\d{8}\.json$/.test(file))
    .sort()
  assert(files.length <= MAX_ARCHIVE_RANGES, 'archive_cap')
  let prior = {
    sequence: 0,
    sha256: null,
    to: plan.anchor.number,
    toHash: plan.anchor.hash,
    identity: plan.identity,
  }
  for (const file of files) {
    assert(file === name(prior.sequence + 1), 'archive_gap')
    const row = read(join(out, file))
    validateRow(row, prior)
    prior = {
      sequence: row.sequence,
      sha256: row.sha256,
      to: row.to,
      toHash: row.toHash,
      identity: row.identity,
    }
  }
  return { ranges: files.length, through: prior.to, tipSha256: prior.sha256, origins: plan.origins }
}

function configuredUrls() {
  const override = process.env.DIRECT_VAULT_FLOW_RPC_URLS
  const urls = override
    ? override
        .split(',')
        .map((url) => url.trim())
        .filter(Boolean)
    : configuredPublicRpcUrls(readEnv())
  if (override) return selectOrigins(urls).map((origin) => origin.url)
  const preferred = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'].map((host) =>
    urls.find((url) => new URL(url).hostname === host),
  )
  return selectOrigins(preferred.every(Boolean) ? preferred : urls).map((origin) => origin.url)
}

export async function createPlan({
  urls = configuredUrls(),
  out = OUT,
  preflightImpl = preflight,
  fetchImpl = fetch,
} = {}) {
  assert(!existsSync(join(out, 'plan.json')), 'plan_exists')
  const origins = selectOrigins(urls)
  const proof = validateProof(await preflightImpl({ urls, fetchImpl }))
  assert(
    same(
      proof.headerChains.map((chain) => chain.origin),
      origins.map((origin) => origin.host),
    ),
    'plan_origins',
  )
  return write(join(out, 'plan.json'), {
    kind: 'direct_vault_gross_plan_v1',
    chainId: 1,
    createdAtUtc: new Date().toISOString(),
    origins: origins.map((origin) => origin.host),
    anchor: { number: proof.range.to, hash: proof.range.toHash },
    identity: identity(proof),
    proof: pack(proof),
    caveat:
      'Prospective ERC4626 event schema at tracked address. No holder payout, complete flow history, or implementation transaction-order proof.',
  })
}

export async function captureNext({
  urls = configuredUrls(),
  out = OUT,
  preflightImpl = preflight,
  fetchImpl = fetch,
} = {}) {
  const origins = selectOrigins(urls)
  const initial = verify(out) // stream/replay rows; never retain the archive in memory.
  assert(
    same(
      initial.origins,
      origins.map((origin) => origin.host),
    ),
    'origins_changed',
  )
  const deadline = Date.now() + MAX_TICK_MS
  const budget = { calls: 0, bytes: 0 }
  const countedFetch = (...args) => {
    if (++budget.calls > MAX_TICK_RPC_CALLS || Date.now() >= deadline) fail('tick_budget')
    return fetchImpl(...args)
  }
  const rows = []
  let prior = initial.ranges
    ? read(join(out, name(initial.ranges)))
    : {
        sequence: 0,
        sha256: null,
        to: initial.through,
        toHash: read(join(out, 'plan.json')).anchor.hash,
        identity: read(join(out, 'plan.json')).identity,
      }
  for (let iteration = 0; iteration < MAX_RANGES_PER_TICK; iteration++) {
    if (prior.sequence >= MAX_ARCHIVE_RANGES || Date.now() >= deadline) break
    if (
      budget.calls + 42 > MAX_TICK_RPC_CALLS ||
      budget.bytes + 2 * 1024 * 1024 > MAX_TICK_RPC_BYTES
    )
      break
    const target = prior.to + MAX_RANGE_BLOCKS
    let main
    try {
      main = validateProof(
        await preflightImpl({ urls, toBlock: target, fetchImpl: countedFetch }),
        target,
      )
    } catch (error) {
      if (error?.message === 'direct_flow_target_not_finalized') break
      throw error
    }
    budget.bytes += main.limits.actual.responseBytes
    assert(
      budget.calls + 2 <= MAX_TICK_RPC_CALLS &&
        budget.bytes + 2 * 1024 * 1024 <= MAX_TICK_RPC_BYTES,
      'tick_budget',
    )
    const upgradeScan = await scanUpgrades(urls, prior.to + 1, target, countedFetch)
    budget.bytes += upgradeScan.bytes
    assert(
      main.range.from === prior.to + 1 &&
        main.headerChains[0].headers[0].parentHash === prior.toHash,
      'capture_boundary',
    )
    const events = allEvents(main)
    const earlier = [
      ...new Set(
        events.filter((event) => event.blockNumber < target).map((event) => event.blockNumber),
      ),
    ]
    assert(earlier.length <= MAX_EVENT_BLOCK_PROOFS_PER_RANGE, 'busy_range_requires_review')
    const proofs = []
    for (const block of earlier) {
      assert(
        Date.now() < deadline &&
          budget.calls + 40 <= MAX_TICK_RPC_CALLS &&
          budget.bytes + 2 * 1024 * 1024 <= MAX_TICK_RPC_BYTES,
        'tick_budget',
      )
      const proof = validateProof(
        await preflightImpl({ urls, toBlock: block, fetchImpl: countedFetch }),
        block,
      )
      budget.bytes += proof.limits.actual.responseBytes
      proofs.push(pack(proof))
    }
    assert(
      budget.calls <= MAX_TICK_RPC_CALLS &&
        budget.bytes <= MAX_TICK_RPC_BYTES &&
        Date.now() < deadline,
      'tick_budget',
    )
    const body = {
      kind: 'direct_vault_gross_range_v1',
      sequence: prior.sequence + 1,
      previousSha256: prior.sha256,
      from: prior.to + 1,
      to: target,
      fromParentHash: prior.toHash,
      toHash: main.range.toHash,
      mainProof: pack(main),
      identity: identity(main),
      eventBlockProofs: proofs,
      upgradeReceipts: upgradeScan.receipts,
      grossTotals: totals(events),
      identityTiming: 'end_of_block_event_schema_at_tracked_address',
      holderPayout: 'not_measured',
    }
    // Reject an unproved earlier-block event before the append-only cursor moves.
    validateRow(seal(body), prior)
    prior = write(join(out, name(body.sequence)), body)
    rows.push({ from: prior.from, to: prior.to, grossTotals: prior.grossTotals })
  }
  return {
    captured: rows.length,
    through: prior.to,
    rpcCalls: budget.calls,
    rpcBytes: budget.bytes,
    ranges: rows,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--verify') console.log(JSON.stringify(verify()))
    else if (process.argv[2] === '--plan')
      console.log(JSON.stringify({ planSha256: (await createPlan()).sha256 }))
    else if (process.argv[2] === '--capture-next') console.log(JSON.stringify(await captureNext()))
    else fail('usage')
  } catch (error) {
    console.error(
      error?.message?.startsWith('direct_vault_flow_') ||
        error?.message === 'direct_flow_target_not_finalized'
        ? error.message
        : 'direct_vault_flow_external_error',
    )
    process.exitCode = 1
  }
}
