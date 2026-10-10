// Local-only, immutable historical Fluid fToken payout witness. It does not
// measure whether a present holder can exit, or predict a future exit.
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
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  decodeEventLog,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  toEventHash,
} from 'viem'
import { mainnet } from 'viem/chains'
import { readEnv } from '../lib/venue-reads.mjs'

// Native ticks and the local Next API both run from the repository root.
// Webpack cannot bundle a directory passed to new URL(..., import.meta.url).
const ROOT = resolve(process.cwd())
export const STORE = join(ROOT, 'data/research/venue-signals/local-fluid-ftoken-payout-v1')
const RESERVE_BYTES = 1024n ** 3n
const MAX_FILE_BYTES = 16 * 1024 * 1024
const SHA = /^[a-f0-9]{64}$/
const HASH = /^0x[a-f0-9]{64}$/
const ADDRESS = /^0x[a-f0-9]{40}$/
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const ZERO = `0x${'0'.repeat(40)}`
const LIQUIDITY = '0x52aa899454998be5b000ad077a46bbe360f4e497'
export const ROUTES = [
  {
    key: 'USDC → Fluid USD Coin [USDC]',
    vault: '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  },
  {
    key: 'USDT → fToken [USDT]',
    vault: '0x5c20b550819128074fd538edf79791733ccedd18',
    asset: '0xdac17f958d2ee523a2206206994597c13d831ec7',
  },
  {
    key: 'GHO → fToken [GHO]',
    vault: '0x6a29a46e21c730dca1d8b23d637c101cec605c5b',
    asset: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
  },
]
const viewAbi = parseAbi([
  'function asset() view returns (address)',
  'function getData() view returns (address liquidity,address factory,address rewards,address permit2,address rebalancer,bool rewardsActive,uint256 liquidityBalance,uint256 liquidityExchangePrice,uint256 tokenExchangePrice)',
])
const EVENTS = {
  withdraw: parseAbiItem(
    'event Withdraw(address indexed sender,address indexed receiver,address indexed owner,uint256 assets,uint256 shares)',
  ),
  operate: parseAbiItem(
    'event LogOperate(address indexed user,address indexed token,int256 supplyAmount,int256 borrowAmount,address withdrawTo,address borrowTo,uint256 totalAmounts,uint256 exchangePricesAndConfig)',
  ),
  transfer: parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)'),
}
const TOPICS = Object.fromEntries(
  Object.entries(EVENTS).map(([name, abi]) => [name, toEventHash(abi).toLowerCase()]),
)
const lower = (v) => String(v).toLowerCase()
const eq = (a, b) => lower(a) === lower(b)
const check = (ok, code) => {
  if (!ok) throw new Error(`fluid_payout_${code}`)
}
const sha = (value) => createHash('sha256').update(value).digest('hex')
const canonical = (value) => JSON.stringify(value)

export function origin(url) {
  const parsed = new URL(url)
  check(
    ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password,
    'origin_invalid',
  )
  return parsed.hostname.toLowerCase()
}

export function configuredClients() {
  const urls = (
    process.env.RECORDER_RPC_URLS ||
    process.env.RECORDER_RPC_URL ||
    readEnv().get('RECORDER_RPC_URLS') ||
    readEnv().get('RECORDER_RPC_URL') ||
    ''
  )
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  // Alchemy and Ankr can serve both historical headers and short raw-log ranges
  // on this host. Their distinct host fingerprints are sealed with the evidence.
  const selected = [
    urls.find((u) => origin(u).includes('alchemy.com')),
    urls.find((u) => origin(u).includes('ankr.com')),
  ]
  check(
    selected.every(Boolean) && origin(selected[0]) !== origin(selected[1]),
    'two_origins_missing',
  )
  return selected.map((url) => ({
    origin: origin(url),
    client: createPublicClient({ chain: mainnet, transport: http(url, { timeout: 20_000 }) }),
  }))
}

function diskReserve(path, size) {
  let ancestor = path
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  const s = statfsSync(ancestor, { bigint: true })
  check(s.bavail * s.bsize - BigInt(size) >= RESERVE_BYTES, 'disk_reserve')
}

export function sealedWrite(path, body) {
  const entry = { ...body, sha256: sha(canonical(body)) }
  const bytes = `${canonical(entry)}\n`
  check(Buffer.byteLength(bytes) <= MAX_FILE_BYTES, 'record_oversize')
  diskReserve(dirname(path), Buffer.byteLength(bytes))
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, bytes)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    linkSync(temporary, path)
    const dfd = openSync(dirname(path), 'r')
    try {
      fsyncSync(dfd)
    } finally {
      closeSync(dfd)
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
  return entry
}

function safeRead(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const s = fstatSync(fd)
    check(s.isFile() && s.size > 0 && s.size <= MAX_FILE_BYTES, 'file_invalid')
    const data = readFileSync(fd, 'utf8')
    const after = fstatSync(fd)
    check(
      Buffer.byteLength(data) === s.size &&
        after.isFile() &&
        after.size === s.size &&
        after.mtimeMs === s.mtimeMs,
      'file_changed',
    )
    const row = JSON.parse(data)
    const { sha256, ...body } = row
    check(SHA.test(sha256) && sha(canonical(body)) === sha256, 'digest_invalid')
    return row
  } finally {
    closeSync(fd)
  }
}

function normalizeLog(log) {
  return {
    address: lower(log.address),
    topics: log.topics.map(lower),
    data: lower(log.data),
    blockHash: lower(log.blockHash),
    transactionHash: lower(log.transactionHash),
    logIndex: Number(log.logIndex),
    blockNumber: Number(log.blockNumber),
  }
}
function ordered(logs) {
  return logs
    .map(normalizeLog)
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
}
function proofRouteValid(row, route) {
  return (
    row?.key === route.key &&
    eq(row.vault, route.vault) &&
    eq(row.asset, route.asset) &&
    eq(row.liquidity, LIQUIDITY) &&
    eq(row.implementation, route.vault) &&
    row.deploymentKind === 'direct_runtime_code_with_empty_eip1967_slots' &&
    HASH.test(row.codeHashes?.implementation) &&
    HASH.test(row.codeHashes?.liquidity)
  )
}

export function validateProof(row) {
  const { sha256, ...body } = row ?? {}
  check(
    SHA.test(sha256) &&
      sha(canonical(body)) === sha256 &&
      row.schemaVersion === 1 &&
      row.kind === 'fluid_ftoken_two_origin_identity' &&
      row.sourceAttestation === 'deployed_direct_runtime_and_liquidity_code_hashes_only' &&
      Number.isSafeInteger(row.blockNumber) &&
      row.blockNumber >= 0 &&
      HASH.test(row.blockHash) &&
      row.originWitnesses?.length === 2 &&
      row.originWitnesses[0].origin === 'eth-mainnet.g.alchemy.com' &&
      row.originWitnesses[1].origin === 'rpc.ankr.com' &&
      row.originWitnesses.every((w) => eq(w.blockHash, row.blockHash)) &&
      canonical(row.originWitnesses[0].routes) === canonical(row.originWitnesses[1].routes) &&
      canonical(row.routes) === canonical(row.originWitnesses[0].routes) &&
      row.routes.length === ROUTES.length &&
      row.routes.every((route, i) => proofRouteValid(route, ROUTES[i])),
    'proof_invalid',
  )
}

async function pinnedIdentity(client, blockNumber, blockHash, routes = ROUTES) {
  const rows = []
  for (const route of routes) {
    const [asset, data, runtimeCode, beaconSlot, implementationSlot] = await Promise.all([
      client.readContract({
        address: route.vault,
        abi: viewAbi,
        functionName: 'asset',
        blockNumber,
      }),
      client.readContract({
        address: route.vault,
        abi: viewAbi,
        functionName: 'getData',
        blockNumber,
      }),
      client.getCode({ address: route.vault, blockNumber }),
      client.getStorageAt({ address: route.vault, slot: BEACON_SLOT, blockNumber }),
      client.getStorageAt({ address: route.vault, slot: IMPLEMENTATION_SLOT, blockNumber }),
    ])
    check(eq(asset, route.asset) && data && eq(data[0], LIQUIDITY), 'route_identity')
    check(
      runtimeCode && runtimeCode !== '0x' && beaconSlot && implementationSlot,
      'runtime_or_slot_missing',
    )
    check(
      `0x${beaconSlot.slice(-40)}`.toLowerCase() === ZERO &&
        `0x${implementationSlot.slice(-40)}`.toLowerCase() === ZERO,
      'unexpected_proxy_slot',
    )
    const liquidityCode = await client.getCode({ address: data[0], blockNumber })
    check(liquidityCode && liquidityCode !== '0x', 'liquidity_code_missing')
    rows.push({
      key: route.key,
      vault: route.vault,
      asset: route.asset,
      liquidity: lower(data[0]),
      factory: lower(data[1]),
      deploymentKind: 'direct_runtime_code_with_empty_eip1967_slots',
      implementation: route.vault,
      codeHashes: { implementation: keccak256(runtimeCode), liquidity: keccak256(liquidityCode) },
    })
  }
  const after = await client.getBlock({ blockNumber })
  check(after.number === blockNumber && eq(after.hash, blockHash), 'block_changed')
  return rows
}

export async function captureProof(origins, root = STORE) {
  diskReserve(root, 0)
  check(origins.length === 2 && origins[0].origin !== origins[1].origin, 'two_origins_required')
  const finalized = await Promise.all(
    origins.map((x) => x.client.getBlock({ blockTag: 'finalized' })),
  )
  const blockNumber = finalized.reduce((n, b) => (b.number < n ? b.number : n), finalized[0].number)
  const headers = await Promise.all(origins.map((x) => x.client.getBlock({ blockNumber })))
  check(
    headers.every((h) => h.number === blockNumber && eq(h.hash, headers[0].hash)),
    'block_disagreement',
  )
  const observed = await Promise.all(
    origins.map((x) => pinnedIdentity(x.client, blockNumber, headers[0].hash)),
  )
  check(canonical(observed[0]) === canonical(observed[1]), 'identity_disagreement')
  check(
    observed[0].every((row, i) => proofRouteValid(row, ROUTES[i])),
    'identity_invalid',
  )
  const body = {
    schemaVersion: 1,
    kind: 'fluid_ftoken_two_origin_identity',
    blockNumber: Number(blockNumber),
    blockHash: lower(headers[0].hash),
    originWitnesses: origins.map((x, i) => ({
      origin: x.origin,
      blockHash: lower(headers[i].hash),
      routes: observed[i],
    })),
    routes: observed[0],
    sourceAttestation: 'deployed_direct_runtime_and_liquidity_code_hashes_only',
  }
  return sealedWrite(join(root, `proof-${body.blockNumber}.json`), body)
}

function validateEventProof(row) {
  const { sha256, ...body } = row ?? {}
  check(
    SHA.test(sha256) &&
      sha(canonical(body)) === sha256 &&
      row.schemaVersion === 1 &&
      row.kind === 'fluid_ftoken_two_origin_event_identity' &&
      Number.isSafeInteger(row.routeIndex) &&
      row.routeIndex >= 0 &&
      row.routeIndex < ROUTES.length &&
      Number.isSafeInteger(row.blockNumber) &&
      row.blockNumber >= 0 &&
      HASH.test(row.blockHash) &&
      row.originWitnesses?.length === 2 &&
      row.originWitnesses[0].origin === 'eth-mainnet.g.alchemy.com' &&
      row.originWitnesses[1].origin === 'rpc.ankr.com' &&
      row.originWitnesses.every(
        (w) => eq(w.blockHash, row.blockHash) && canonical(w.identity) === canonical(row.identity),
      ) &&
      proofRouteValid(row.identity, ROUTES[row.routeIndex]),
    'event_proof_invalid',
  )
}

export async function captureEventProof(origins, routeIndex, blockNumber, root = STORE) {
  diskReserve(root, 0)
  check(origins.length === 2 && origins[0].origin !== origins[1].origin, 'two_origins_required')
  check(
    Number.isSafeInteger(routeIndex) && routeIndex >= 0 && routeIndex < ROUTES.length,
    'route_invalid',
  )
  check(Number.isSafeInteger(blockNumber) && blockNumber >= 0, 'range_invalid')
  const finalized = await Promise.all(
    origins.map((x) => x.client.getBlock({ blockTag: 'finalized' })),
  )
  check(
    finalized.every((block) => block.number >= BigInt(blockNumber)),
    'range_not_finalized',
  )
  const headers = await Promise.all(
    origins.map((x) => x.client.getBlock({ blockNumber: BigInt(blockNumber) })),
  )
  check(
    headers.every(
      (block) => block.number === BigInt(blockNumber) && eq(block.hash, headers[0].hash),
    ),
    'block_disagreement',
  )
  const identities = await Promise.all(
    origins.map(
      async (x) =>
        (
          await pinnedIdentity(x.client, BigInt(blockNumber), headers[0].hash, [ROUTES[routeIndex]])
        )[0],
    ),
  )
  check(canonical(identities[0]) === canonical(identities[1]), 'identity_disagreement')
  const body = {
    schemaVersion: 1,
    kind: 'fluid_ftoken_two_origin_event_identity',
    routeIndex,
    blockNumber,
    blockHash: lower(headers[0].hash),
    originWitnesses: origins.map((x, index) => ({
      origin: x.origin,
      blockHash: lower(headers[index].hash),
      identity: identities[index],
    })),
    identity: identities[0],
  }
  const entry = sealedWrite(join(root, `event-proof-${routeIndex}-${blockNumber}.json`), body)
  validateEventProof(entry)
  return entry
}

function decode(log, event) {
  try {
    return decodeEventLog({
      abi: [EVENTS[event]],
      data: log.data,
      topics: log.topics,
      strict: true,
    }).args
  } catch {
    return null
  }
}
export function classifyReceipt(route, liquidity, receipt) {
  if (receipt.status !== 'success') return { status: 'ambiguous', reason: 'receipt_not_success' }
  const logs = ordered(receipt.logs)
  const withdrawals = logs
    .filter((l) => eq(l.address, route.vault) && eq(l.topics[0], TOPICS.withdraw))
    .map((l) => ({ log: l, args: decode(l, 'withdraw') }))
  if (withdrawals.length === 0) return { status: 'missing', reason: 'withdraw_log_absent' }
  const tupleCounts = new Map()
  for (const { args } of withdrawals) {
    if (!args || !ADDRESS.test(lower(args.receiver)) || args.assets <= 0n) continue
    const tuple = `${lower(args.receiver)}:${args.assets}`
    tupleCounts.set(tuple, (tupleCounts.get(tuple) || 0) + 1)
  }
  const results = []
  for (const { log, args } of withdrawals) {
    if (!args || !ADDRESS.test(lower(args.receiver)) || args.assets <= 0n) {
      results.push({ status: 'ambiguous', reason: 'withdraw_invalid' })
      continue
    }
    const amount = args.assets
    // A single Liquidity operation and token transfer cannot settle two
    // identical fToken Withdraw logs. Leave even legitimate batches ambiguous
    // until a one-to-one log allocation is demonstrated.
    if (tupleCounts.get(`${lower(args.receiver)}:${amount}`) > 1) {
      results.push({
        status: 'ambiguous',
        reason: 'duplicate_withdrawal_tuple',
        receiver: lower(args.receiver),
        owner: lower(args.owner),
        assetsRaw: amount.toString(),
        sharesRaw: args.shares.toString(),
        withdrawLogIndex: log.logIndex,
        operateLogIndex: null,
        transferLogIndex: null,
      })
      continue
    }
    const operations = logs
      .filter((l) => eq(l.address, liquidity) && eq(l.topics[0], TOPICS.operate))
      .map((l) => ({ log: l, args: decode(l, 'operate') }))
      .filter(
        (x) =>
          x.args &&
          eq(x.args.user, route.vault) &&
          eq(x.args.token, route.asset) &&
          x.args.supplyAmount === -amount &&
          x.args.borrowAmount === 0n &&
          eq(x.args.withdrawTo, args.receiver) &&
          eq(x.args.borrowTo, ZERO) &&
          x.log.logIndex < log.logIndex,
      )
    const transfers = logs
      .filter((l) => eq(l.address, route.asset) && eq(l.topics[0], TOPICS.transfer))
      .map((l) => ({ log: l, args: decode(l, 'transfer') }))
      .filter(
        (x) =>
          x.args &&
          eq(x.args.from, liquidity) &&
          eq(x.args.to, args.receiver) &&
          x.args.value === amount &&
          x.log.logIndex < log.logIndex,
      )
    const status =
      operations.length === 1 && transfers.length === 1
        ? 'reconciled'
        : operations.length === 0 || transfers.length === 0
          ? 'missing'
          : 'ambiguous'
    results.push({
      status,
      reason:
        status === 'reconciled'
          ? 'same_tx_logoperate_and_underlying_transfer'
          : `operations_${operations.length}_transfers_${transfers.length}`,
      receiver: lower(args.receiver),
      owner: lower(args.owner),
      assetsRaw: amount.toString(),
      sharesRaw: args.shares.toString(),
      withdrawLogIndex: log.logIndex,
      operateLogIndex: operations.length === 1 ? operations[0].log.logIndex : null,
      transferLogIndex: transfers.length === 1 ? transfers[0].log.logIndex : null,
    })
  }
  return {
    status: results.every((r) => r.status === 'reconciled')
      ? 'reconciled'
      : results.some((r) => r.status === 'ambiguous')
        ? 'ambiguous'
        : 'missing',
    withdrawals: results,
  }
}

function receiptWitness(receipt) {
  return {
    status: receipt.status,
    blockHash: lower(receipt.blockHash),
    blockNumber: Number(receipt.blockNumber),
    transactionHash: lower(receipt.transactionHash),
    logs: ordered(receipt.logs),
  }
}

function queriedWithdrawsMatchReceipt(rawLogs, receipt, route, transactionHash) {
  const queried = rawLogs.filter((log) => eq(log.transactionHash, transactionHash))
  const mined = receipt.logs.filter(
    (log) => eq(log.address, route.vault) && eq(log.topics[0], TOPICS.withdraw),
  )
  return (
    eq(receipt.transactionHash, transactionHash) &&
    queried.length > 0 &&
    queried.every(
      (log) => eq(log.blockHash, receipt.blockHash) && log.blockNumber === receipt.blockNumber,
    ) &&
    canonical(queried) === canonical(mined)
  )
}

export function validatePilot(row, proof) {
  check(
    row.schemaVersion === 1 &&
      row.kind === 'fluid_ftoken_two_origin_payout_pilot' &&
      row.proofSha256 === proof?.sha256,
    'pilot_record_invalid',
  )
  check(
    proof &&
      Number.isSafeInteger(row.fromBlock) &&
      Number.isSafeInteger(row.toBlock) &&
      row.fromBlock <= row.toBlock &&
      row.toBlock - row.fromBlock <= 9 &&
      row.toBlock <= proof.blockNumber &&
      row.routeIndex >= 0 &&
      row.routeIndex < ROUTES.length &&
      row.routeKey === ROUTES[row.routeIndex].key,
    'pilot_proof_invalid',
  )
  check(
    eq(row.query?.address, ROUTES[row.routeIndex].vault) &&
      canonical(row.query?.topics) == canonical([TOPICS.withdraw]) &&
      row.query.fromBlock === `0x${row.fromBlock.toString(16)}` &&
      row.query.toBlock === `0x${row.toBlock.toString(16)}`,
    'pilot_query_invalid',
  )
  const w = row.sourceWitnesses
  check(
    w?.length === 2 &&
      w[0].origin === proof.originWitnesses[0].origin &&
      w[1].origin === proof.originWitnesses[1].origin &&
      canonical(w[0].logs) === canonical(w[1].logs) &&
      HASH.test(w[0].startHash) &&
      HASH.test(w[0].endHash) &&
      w[0].startHash === w[1].startHash &&
      w[0].endHash === w[1].endHash,
    'pilot_sources_invalid',
  )
  check(
    w[0].logs.every(
      (l) =>
        eq(l.address, ROUTES[row.routeIndex].vault) &&
        eq(l.topics[0], TOPICS.withdraw) &&
        l.blockNumber >= row.fromBlock &&
        l.blockNumber <= row.toBlock &&
        HASH.test(l.blockHash) &&
        HASH.test(l.transactionHash),
    ),
    'pilot_log_invalid',
  )
  const queriedHashes = [...new Set(w[0].logs.map((l) => l.transactionHash))]
  check(
    row.receipts.length === queriedHashes.length &&
      new Set(row.receipts.map((r) => r.transactionHash)).size === queriedHashes.length &&
      row.receipts.every((r) => queriedHashes.includes(r.transactionHash)),
    'pilot_receipt_count_invalid',
  )
  for (const receipt of row.receipts) {
    const p = receipt.originWitnesses
    check(
      p?.length === 2 &&
        p[0].origin === w[0].origin &&
        p[1].origin === w[1].origin &&
        canonical(p[0].receipt) === canonical(p[1].receipt),
      'pilot_receipt_sources_invalid',
    )
    check(
      p[0].receipt.blockNumber >= row.fromBlock &&
        p[0].receipt.blockNumber <= row.toBlock &&
        queriedWithdrawsMatchReceipt(
          w[0].logs,
          p[0].receipt,
          ROUTES[row.routeIndex],
          receipt.transactionHash,
        ),
      'pilot_receipt_log_invalid',
    )
    check(
      canonical(
        classifyReceipt(
          ROUTES[row.routeIndex],
          proof.routes[row.routeIndex].liquidity,
          p[0].receipt,
        ),
      ) === canonical(receipt.classification),
      'pilot_classification_invalid',
    )
  }
  check(
    row.summary.withdrawalTransactions === row.receipts.length &&
      row.summary.reconciled ===
        row.receipts.filter((r) => r.classification.status === 'reconciled').length &&
      row.summary.ambiguous ===
        row.receipts.filter((r) => r.classification.status === 'ambiguous').length &&
      row.summary.missing ===
        row.receipts.filter((r) => r.classification.status === 'missing').length &&
      row.summary.quiet === (row.receipts.length === 0),
    'pilot_summary_invalid',
  )
}

export async function capturePilot(origins, proof, routeIndex, fromBlock, toBlock, root = STORE) {
  diskReserve(root, 0)
  validateProof(proof)
  check(
    origins?.length === 2 &&
      origins[0].origin === proof?.originWitnesses?.[0]?.origin &&
      origins[1].origin === proof?.originWitnesses?.[1]?.origin,
    'pilot_origins_invalid',
  )
  check(routeIndex >= 0 && routeIndex < ROUTES.length, 'route_invalid')
  check(
    Number.isSafeInteger(fromBlock) &&
      Number.isSafeInteger(toBlock) &&
      fromBlock <= toBlock &&
      toBlock - fromBlock <= 9 &&
      toBlock <= proof.blockNumber,
    'range_invalid',
  )
  const route = ROUTES[routeIndex]
  const identity = proof.routes[routeIndex]
  check(
    identity.key === route.key &&
      eq(identity.vault, route.vault) &&
      eq(identity.asset, route.asset),
    'proof_route_invalid',
  )
  const query = {
    address: route.vault,
    topics: [TOPICS.withdraw],
    fromBlock: `0x${fromBlock.toString(16)}`,
    toBlock: `0x${toBlock.toString(16)}`,
  }
  const fetched = await Promise.all(
    origins.map(async (x) => {
      const [a, b] = await Promise.all([
        x.client.getBlock({ blockNumber: BigInt(fromBlock) }),
        x.client.getBlock({ blockNumber: BigInt(toBlock) }),
      ])
      const raw = await x.client.request({ method: 'eth_getLogs', params: [query] })
      return {
        origin: x.origin,
        startHash: lower(a.hash),
        endHash: lower(b.hash),
        logs: ordered(raw),
      }
    }),
  )
  check(
    canonical(fetched[0].logs) === canonical(fetched[1].logs) &&
      fetched[0].startHash === fetched[1].startHash &&
      fetched[0].endHash === fetched[1].endHash,
    'log_disagreement',
  )
  const txs = [...new Set(fetched[0].logs.map((l) => l.transactionHash))]
  check(txs.length <= 12, 'too_many_receipts')
  const receipts = []
  for (const hash of txs) {
    const pair = await Promise.all(
      origins.map(async (x) => ({
        origin: x.origin,
        receipt: receiptWitness(await x.client.getTransactionReceipt({ hash })),
      })),
    )
    check(canonical(pair[0].receipt) === canonical(pair[1].receipt), 'receipt_disagreement')
    check(
      pair[0].receipt.blockNumber >= fromBlock &&
        pair[0].receipt.blockNumber <= toBlock &&
        queriedWithdrawsMatchReceipt(fetched[0].logs, pair[0].receipt, route, hash),
      'receipt_log_disagreement',
    )
    const classification = classifyReceipt(route, identity.liquidity, pair[0].receipt)
    receipts.push({ transactionHash: hash, originWitnesses: pair, classification })
  }
  const body = {
    schemaVersion: 1,
    kind: 'fluid_ftoken_two_origin_payout_pilot',
    proofSha256: proof.sha256,
    routeKey: route.key,
    routeIndex,
    fromBlock,
    toBlock,
    query,
    sourceWitnesses: fetched,
    receipts,
    summary: {
      withdrawalTransactions: txs.length,
      reconciled: receipts.filter((r) => r.classification.status === 'reconciled').length,
      ambiguous: receipts.filter((r) => r.classification.status === 'ambiguous').length,
      missing: receipts.filter((r) => r.classification.status === 'missing').length,
      quiet: txs.length === 0,
    },
  }
  validatePilot(body, proof)
  return sealedWrite(join(root, `pilot-${routeIndex}-${fromBlock}-${toBlock}.json`), body)
}

export function verify(root = STORE) {
  const names = readdirSync(root).sort()
  check(
    names.every((n) => /^(?:proof-\d+|pilot-[012]-\d+-\d+|event-proof-[012]-\d+)\.json$/.test(n)),
    'unexpected_file',
  )
  const proofs = new Map()
  const eventProofs = new Map()
  const pilots = []
  for (const name of names) {
    const row = safeRead(join(root, name))
    if (row.kind === 'fluid_ftoken_two_origin_identity') {
      validateProof(row)
      check(name === `proof-${row.blockNumber}.json`, 'proof_filename_invalid')
      proofs.set(row.sha256, row)
    } else if (row.kind === 'fluid_ftoken_two_origin_event_identity') {
      validateEventProof(row)
      const expected = `event-proof-${row.routeIndex}-${row.blockNumber}.json`
      check(name === expected, 'event_proof_filename_invalid')
      eventProofs.set(`${row.routeIndex}:${row.blockNumber}`, row)
    } else if (row.kind === 'fluid_ftoken_two_origin_payout_pilot') {
      check(
        name === `pilot-${row.routeIndex}-${row.fromBlock}-${row.toBlock}.json`,
        'pilot_filename_invalid',
      )
      pilots.push(row)
    } else check(false, 'kind_invalid')
  }
  const seenTransactions = new Set()
  for (const row of pilots) {
    validatePilot(row, proofs.get(row.proofSha256))
    for (const receipt of row.receipts) {
      const key = `${row.routeIndex}:${receipt.transactionHash}`
      check(!seenTransactions.has(key), 'duplicate_payout_transaction')
      seenTransactions.add(key)
    }
  }
  const eventIdentityVerified = (pilot, receipt) => {
    const witnessed = receipt.originWitnesses[0].receipt
    const eventProof = eventProofs.get(`${pilot.routeIndex}:${witnessed.blockNumber}`)
    return (
      eventProof &&
      eq(eventProof.blockHash, witnessed.blockHash) &&
      eq(
        eventProof.identity.liquidity,
        proofs.get(pilot.proofSha256).routes[pilot.routeIndex].liquidity,
      )
    )
  }
  return {
    proofs: proofs.size,
    eventProofs: eventProofs.size,
    pilots: pilots.length,
    byRoute: ROUTES.map((r, i) => ({
      route: r.key,
      pilots: pilots.filter((p) => p.routeIndex === i).length,
      reconciled: pilots
        .filter((p) => p.routeIndex === i)
        .reduce((n, p) => n + p.summary.reconciled, 0),
      eventIdentityReconciled: pilots
        .filter((p) => p.routeIndex === i)
        .reduce(
          (n, p) =>
            n +
            p.receipts.filter(
              (receipt) =>
                receipt.classification.status === 'reconciled' && eventIdentityVerified(p, receipt),
            ).length,
          0,
        ),
      quiet: pilots.filter((p) => p.routeIndex === i).filter((p) => p.summary.quiet).length,
    })),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2]
    if (mode === 'verify') console.log(JSON.stringify(verify()))
    else if (mode === 'proof') {
      const row = await captureProof(configuredClients())
      console.log(
        JSON.stringify({
          blockNumber: row.blockNumber,
          proofSha256: row.sha256,
          routes: row.routes.map((r) => ({
            key: r.key,
            implementation: r.implementation,
            liquidity: r.liquidity,
          })),
        }),
      )
    } else if (mode === 'event-proof') {
      const routeIndex = Number(process.argv[3])
      const blockNumber = Number(process.argv[4])
      const row = await captureEventProof(configuredClients(), routeIndex, blockNumber)
      console.log(
        JSON.stringify({
          routeKey: ROUTES[row.routeIndex].key,
          blockNumber: row.blockNumber,
          sha256: row.sha256,
        }),
      )
    } else if (mode === 'pilot') {
      const index = Number(process.argv[3])
      const from = Number(process.argv[4])
      const to = Number(process.argv[5])
      const proofs = readdirSync(STORE)
        .filter((n) => /^proof-\d+\.json$/.test(n))
        .sort((a, b) => Number(b.slice(6, -5)) - Number(a.slice(6, -5)))
      check(proofs.length > 0, 'proof_missing')
      const row = await capturePilot(
        configuredClients(),
        safeRead(join(STORE, proofs[0])),
        index,
        from,
        to,
      )
      console.log(
        JSON.stringify({
          routeKey: row.routeKey,
          fromBlock: row.fromBlock,
          toBlock: row.toBlock,
          summary: row.summary,
          sha256: row.sha256,
        }),
      )
    } else check(false, 'mode_invalid')
  } catch (error) {
    console.error(
      error instanceof Error && error.message.startsWith('fluid_payout_')
        ? error.message
        : 'fluid_payout_external_error',
    )
    process.exitCode = 1
  }
}
