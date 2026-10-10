// Bounded, dry-by-default Aave Core reserve-cash receipt collector. A successful
// eth_getLogs response is source evidence, not independent proof of completeness.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
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
import { pathToFileURL } from 'node:url'
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  padHex,
  parseAbi,
  toEventSelector,
} from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { ABI as PANEL_ABI, MARKETS, POOL } from './aave-core-forward-panel.mjs'
import { reconcileAaveCoreCash } from './aave-core-operation-reconcile.mjs'

export const STUDY = 'aave-core-operation-cash-receipt-v1'
export const OUT = resolve('data/research/venue-signals/aave-core-operation-receipts')
export const RESERVE_BYTES = 1_073_741_824
export const CHUNK_BLOCKS = 64
export const MAX_BLOCKS = 256
export const MAX_LOGS_PER_QUERY = 1000
const HASH = /^0x[0-9a-f]{64}$/
const HEX = /^0x(?:[0-9a-f]{2})*$/
const EVENTS = parseAbi([
  'event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)',
  'event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)',
  'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
  'event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])
const CALLS = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
  'function POOL() view returns (address)',
  'function decimals() view returns (uint8)',
])
const EVENT_TOPICS = Object.fromEntries(
  EVENTS.map((event) => [event.name, toEventSelector(event).toLowerCase()]),
)
const sha = (value) => createHash('sha256').update(value).digest('hex')
const seal = (value) => ({ ...value, sha256: sha(JSON.stringify(value)) })
const withoutSha = ({ sha256: _sha256, ...rest }) => rest
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : '')
const hexBlock = (number) => `0x${number.toString(16)}`

function requireValue(ok, message) {
  if (!ok) throw new Error(message)
}

function number(value, label) {
  const n = Number(BigInt(value))
  requireValue(Number.isSafeInteger(n) && n >= 0, `Invalid ${label}`)
  return n
}

function block(value) {
  requireValue(value && HASH.test(lower(value.hash)), 'Invalid canonical block hash')
  return {
    number: number(value.number, 'block number'),
    hash: lower(value.hash),
    timestamp: number(value.timestamp, 'block timestamp'),
  }
}

function diskGuard(out, stat = statfsSync, extra = 0) {
  let path = out
  while (!existsSync(path)) {
    const parent = dirname(path)
    requireValue(parent !== path, 'No output filesystem ancestor')
    path = parent
  }
  const fs = stat(path)
  requireValue(
    Number(fs.bavail) * Number(fs.bsize) - extra >= RESERVE_BYTES,
    'Disk reserve reached',
  )
}

function marketFor(name) {
  const market = MARKETS.find((row) => row.name === name)
  requireValue(market, 'Only configured Core USDC/USDT are supported')
  return market
}

function rawLog(log, label, fromBlock, toBlock) {
  requireValue(
    log && lower(log.removed) !== 'true' && log.removed !== true,
    `${label}: removed log`,
  )
  const blockNumber = number(log.blockNumber, `${label} blockNumber`)
  const transactionIndex = number(log.transactionIndex, `${label} transactionIndex`)
  const logIndex = number(log.logIndex, `${label} logIndex`)
  requireValue(blockNumber >= fromBlock && blockNumber <= toBlock, `${label}: log out of chunk`)
  requireValue(
    HASH.test(lower(log.blockHash)) && HASH.test(lower(log.transactionHash)),
    `${label}: missing hash`,
  )
  requireValue(/^0x[0-9a-f]{40}$/.test(lower(log.address)), `${label}: invalid emitter`)
  requireValue(
    Array.isArray(log.topics) && log.topics.every((topic) => HASH.test(lower(topic))),
    `${label}: invalid topics`,
  )
  requireValue(HEX.test(lower(log.data)), `${label}: invalid data`)
  return {
    address: lower(log.address),
    blockNumber,
    blockHash: lower(log.blockHash),
    transactionHash: lower(log.transactionHash),
    transactionIndex,
    logIndex,
    topics: log.topics.map(lower),
    data: lower(log.data),
  }
}

function coords(log) {
  return {
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
  }
}

function normalizePool(log, market) {
  requireValue(
    log.address === lower(POOL) && Object.values(EVENT_TOPICS).slice(0, 4).includes(log.topics[0]),
    'Wrong Pool event emitter or topic',
  )
  requireValue(
    log.topics[1] === lower(padHex(market.base, { size: 32 })),
    'Wrong Pool reserve topic',
  )
  const decoded = decodeEventLog({ abi: EVENTS, data: log.data, topics: log.topics, strict: true })
  requireValue(
    ['Supply', 'Withdraw', 'Borrow', 'Repay'].includes(decoded.eventName) &&
      lower(decoded.args.reserve) === lower(market.base),
    'Wrong Pool event or reserve',
  )
  return {
    emitter: log.address,
    reserve: lower(decoded.args.reserve),
    kind: decoded.eventName,
    amountRaw: String(decoded.args.amount),
    ...coords(log),
  }
}

function normalizeTransfer(log, market) {
  requireValue(
    log.address === lower(market.base) && log.topics[0] === EVENT_TOPICS.Transfer,
    'Wrong Transfer emitter or topic',
  )
  const decoded = decodeEventLog({ abi: EVENTS, data: log.data, topics: log.topics, strict: true })
  requireValue(
    decoded.eventName === 'Transfer' &&
      [lower(decoded.args.from), lower(decoded.args.to)].includes(lower(market.aToken)),
    'Wrong underlying Transfer',
  )
  return {
    token: log.address,
    from: lower(decoded.args.from),
    to: lower(decoded.args.to),
    amountRaw: String(decoded.args.value),
    ...coords(log),
  }
}

function replayChunk(chunk, market) {
  const expectedQueries = chunk.kind === 'poolOperations' ? 1 : 2
  requireValue(
    Array.isArray(chunk.queries) && chunk.queries.length === expectedQueries,
    'Missing raw query response',
  )
  const all = chunk.queries.map((query, i) => {
    requireValue(
      Array.isArray(query.logs) && query.logs.length < MAX_LOGS_PER_QUERY,
      'Invalid raw log page',
    )
    const seen = new Set()
    return query.logs.map((log, j) => {
      const validated = rawLog(log, `sealed raw log ${i}:${j}`, chunk.fromBlock, chunk.toBlock)
      requireValue(JSON.stringify(validated) === JSON.stringify(log), 'Noncanonical raw log fields')
      const key = `${log.blockHash}:${log.logIndex}`
      requireValue(!seen.has(key), 'Duplicate raw log within one query')
      seen.add(key)
      if (log.blockNumber === chunk.fromBlock)
        requireValue(log.blockHash === chunk.firstHash, 'First boundary hash mismatch')
      if (log.blockNumber === chunk.toBlock)
        requireValue(log.blockHash === chunk.lastHash, 'Last boundary hash mismatch')
      return log
    })
  })
  if (chunk.kind === 'poolOperations') return all[0].map((log) => normalizePool(log, market))
  const fromTopic = lower(padHex(market.aToken, { size: 32 }))
  for (const log of all[0]) requireValue(log.topics[1] === fromTopic, 'Wrong from-aToken raw query')
  for (const log of all[1]) requireValue(log.topics[2] === fromTopic, 'Wrong to-aToken raw query')
  const merged = new Map()
  for (const log of [...all[0], ...all[1]]) {
    const key = `${log.blockHash}:${log.logIndex}`
    requireValue(
      !merged.has(key) || JSON.stringify(merged.get(key)) === JSON.stringify(log),
      'Conflicting raw Transfer duplicate',
    )
    merged.set(key, log)
  }
  return [...merged.values()]
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
    .map((log) => normalizeTransfer(log, market))
}

function append(out, receipt, stat) {
  const bytes = `${JSON.stringify(receipt)}\n`
  diskGuard(out, stat, Buffer.byteLength(bytes))
  mkdirSync(out, { recursive: true })
  const target = join(
    out,
    `${receipt.market}-${String(receipt.from.blockNumber).padStart(12, '0')}-${String(receipt.to.blockNumber).padStart(12, '0')}-${receipt.to.blockHash.slice(2)}.json`,
  )
  const temp = `${target}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    const fileFd = openSync(temp, 'r')
    try {
      fsyncSync(fileFd)
    } finally {
      closeSync(fileFd)
    }
    linkSync(temp, target)
    const directoryFd = openSync(out, 'r')
    try {
      fsyncSync(directoryFd)
    } finally {
      closeSync(directoryFd)
    }
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
  return target
}

function receiptName(p) {
  return `${p.market}-${String(p.from.blockNumber).padStart(12, '0')}-${String(p.to.blockNumber).padStart(12, '0')}-${p.to.blockHash.slice(2)}.json`
}

export function verify({ out = OUT } = {}) {
  if (!existsSync(out)) return { count: 0 }
  const files = readdirSync(out)
    .filter((name) => name.endsWith('.json'))
    .sort()
  const keys = new Set()
  for (const file of files) {
    const saved = JSON.parse(readFileSync(join(out, file), 'utf8'))
    requireValue(saved.sha256 === sha(JSON.stringify(withoutSha(saved))), 'Receipt SHA mismatch')
    const p = withoutSha(saved)
    requireValue(
      p.study === STUDY && file === receiptName(p),
      'Receipt identity or filename mismatch',
    )
    const key = `${p.market}:${p.from.blockNumber}:${p.to.blockNumber}`
    requireValue(!keys.has(key), 'Duplicate market/window receipt')
    keys.add(key)
    const market = marketFor(p.market)
    requireValue(
      p.chainId === 1 &&
        p.pool === lower(POOL) &&
        p.underlying === lower(market.base) &&
        p.aToken === lower(market.aToken),
      'Wrong Core reserve identity',
    )
    requireValue(
      Number.isFinite(Date.parse(p.captureStartedAt)) &&
        Number.isFinite(Date.parse(p.captureEndedAt)) &&
        Date.parse(p.captureEndedAt) >= Date.parse(p.captureStartedAt),
      'Invalid local capture clock',
    )
    requireValue(
      p.finalized?.number >= p.to.blockNumber && HASH.test(p.finalized?.hash),
      'Invalid finalized source',
    )
    requireValue(
      Array.isArray(p.identities) &&
        p.identities.length === 2 &&
        [p.from, p.to].every(
          (end, i) =>
            p.identities[i]?.blockNumber === end.blockNumber &&
            p.identities[i]?.blockHash === end.blockHash &&
            ['poolCodeSha256', 'underlyingCodeSha256', 'aTokenCodeSha256'].every((key) =>
              /^[0-9a-f]{64}$/.test(p.identities[i][key]),
            ) &&
            p.identities[i].reserveAToken === p.aToken &&
            /^(0|[1-9][0-9]*)$/.test(p.identities[i].reserveConfigRaw),
        ),
      'Invalid pinned endpoint identities',
    )
    const coverage = { poolOperations: [], underlyingTransfers: [] }
    const operations = []
    const transfers = []
    for (const kind of ['poolOperations', 'underlyingTransfers']) {
      for (const chunk of p.chunks?.[kind] || []) {
        requireValue(chunk.sha256 === sha(JSON.stringify(withoutSha(chunk))), 'Chunk SHA mismatch')
        requireValue(
          chunk.kind === kind && chunk.status === 'rpc-returned-complete-not-independently-proven',
          'Invalid chunk status',
        )
        requireValue(
          HASH.test(chunk.firstHash) && HASH.test(chunk.lastHash),
          'Missing chunk boundary hash',
        )
        requireValue(
          JSON.stringify(replayChunk(chunk, market)) === JSON.stringify(chunk.normalized),
          'Raw log projection mismatch',
        )
        coverage[kind].push({
          fromBlock: chunk.fromBlock,
          toBlock: chunk.toBlock,
          complete: true,
          source: 'rpc:eth_getLogs',
          receiptSha256: chunk.sha256,
        })
        const normalized = kind === 'poolOperations' ? operations : transfers
        normalized.push(...chunk.normalized)
      }
    }
    requireValue(
      JSON.stringify(operations) === JSON.stringify(p.operations) &&
        JSON.stringify(transfers) === JSON.stringify(p.transfers),
      'Chunk/log projection mismatch',
    )
    const result = reconcileAaveCoreCash({
      chainId: 1,
      pool: p.pool,
      underlying: p.underlying,
      aToken: p.aToken,
      from: p.from,
      to: p.to,
      coverage,
      operations,
      transfers,
    })
    requireValue(
      JSON.stringify(result) === JSON.stringify(p.reconciliation),
      'Reconciliation mismatch',
    )
    requireValue(result.endpointReconciled, 'Endpoint cash residual is nonzero')
  }
  return { count: files.length }
}

export async function collect({
  client,
  marketName,
  fromBlock,
  toBlock,
  chunkBlocks = CHUNK_BLOCKS,
  out = OUT,
  stat = statfsSync,
  now = () => new Date(),
} = {}) {
  requireValue(client?.request, 'One RPC client required')
  requireValue(
    Number.isSafeInteger(chunkBlocks) && chunkBlocks >= 1 && chunkBlocks <= CHUNK_BLOCKS,
    'Invalid log chunk size',
  )
  const market = marketFor(marketName)
  requireValue(
    Number.isSafeInteger(fromBlock) &&
      Number.isSafeInteger(toBlock) &&
      fromBlock >= 0 &&
      toBlock > fromBlock &&
      toBlock - fromBlock <= MAX_BLOCKS,
    'Invalid or unbounded (A,B]',
  )
  diskGuard(out, stat)
  verify({ out })
  const captureStartedAt = now().toISOString()
  const request = (method, params) => client.request({ method, params })
  requireValue(number(await request('eth_chainId', []), 'chain ID') === 1, 'Wrong chain ID')
  const finalized = block(await request('eth_getBlockByNumber', ['finalized', false]))
  requireValue(toBlock <= finalized.number, 'B is not finalized')
  const getBlock = async (n) => {
    const value = block(await request('eth_getBlockByNumber', [hexBlock(n), false]))
    requireValue(value.number === n, 'Canonical block number mismatch')
    return value
  }
  const a = await getBlock(fromBlock)
  const b = await getBlock(toBlock)
  requireValue(
    toBlock !== finalized.number || b.hash === finalized.hash,
    'Finalized B hash mismatch',
  )
  const pin = (value) => ({ blockHash: value.hash, requireCanonical: true })
  const call = async (address, functionName, args, at) => {
    const data = encodeFunctionData({ abi: CALLS, functionName, args })
    const result = await request('eth_call', [{ to: address, data }, pin(at)])
    requireValue(
      typeof result === 'string' && /^0x[0-9a-fA-F]+$/.test(result),
      'Incomplete pinned call',
    )
    return decodeFunctionResult({ abi: CALLS, functionName, data: result })
  }
  const code = async (address, at) => {
    const result = lower(await request('eth_getCode', [address, pin(at)]))
    requireValue(/^0x(?:[0-9a-f]{2})+$/.test(result), 'Missing pinned runtime code')
    return sha(Buffer.from(result.slice(2), 'hex'))
  }
  const reserveData = async (at) => {
    const data = encodeFunctionData({
      abi: PANEL_ABI.reserve,
      functionName: 'getReserveData',
      args: [market.base],
    })
    const result = await request('eth_call', [{ to: POOL, data }, pin(at)])
    requireValue(
      typeof result === 'string' && /^0x[0-9a-fA-F]+$/.test(result),
      'Incomplete pinned reserve read',
    )
    const reserve = decodeFunctionResult({
      abi: PANEL_ABI.reserve,
      functionName: 'getReserveData',
      data: result,
    })
    requireValue(
      lower(reserve.aTokenAddress) === lower(market.aToken),
      'Pool reserve aToken mismatch',
    )
    return {
      reserveAToken: lower(reserve.aTokenAddress),
      reserveConfigRaw: String(reserve.configuration.data),
    }
  }
  const identities = []
  for (const at of [a, b]) {
    requireValue(
      lower(await call(market.aToken, 'UNDERLYING_ASSET_ADDRESS', [], at)) === lower(market.base),
      'aToken underlying mismatch',
    )
    requireValue(
      lower(await call(market.aToken, 'POOL', [], at)) === lower(POOL),
      'aToken Pool mismatch',
    )
    requireValue(
      Number(await call(market.base, 'decimals', [], at)) === market.decimals &&
        Number(await call(market.aToken, 'decimals', [], at)) === market.decimals,
      'Reserve decimals mismatch',
    )
    identities.push({
      blockNumber: at.number,
      blockHash: at.hash,
      ...(await reserveData(at)),
      poolCodeSha256: await code(POOL, at),
      underlyingCodeSha256: await code(market.base, at),
      aTokenCodeSha256: await code(market.aToken, at),
    })
  }
  const from = {
    blockNumber: a.number,
    blockHash: a.hash,
    cashRaw: String(await call(market.base, 'balanceOf', [market.aToken], a)),
  }
  const to = {
    blockNumber: b.number,
    blockHash: b.hash,
    cashRaw: String(await call(market.base, 'balanceOf', [market.aToken], b)),
  }
  const knownBlocks = new Map([
    [a.number, a.hash],
    [b.number, b.hash],
  ])
  const canonical = async (n) => {
    if (!knownBlocks.has(n)) knownBlocks.set(n, (await getBlock(n)).hash)
    return knownBlocks.get(n)
  }
  const poolTopics = [
    Object.values(EVENT_TOPICS).filter((topic) => topic !== EVENT_TOPICS.Transfer),
    padHex(market.base, { size: 32 }),
  ]
  const aTokenTopic = padHex(market.aToken, { size: 32 })
  const chunks = { poolOperations: [], underlyingTransfers: [] }
  const operations = []
  const transfers = []
  for (let first = fromBlock + 1; first <= toBlock; first += chunkBlocks) {
    const last = Math.min(first + chunkBlocks - 1, toBlock)
    const boundary = {
      fromBlock: first,
      toBlock: last,
      firstHash: await canonical(first),
      lastHash: await canonical(last),
    }
    const getLogs = async (address, topics, label) => {
      const result = await request('eth_getLogs', [
        { fromBlock: hexBlock(first), toBlock: hexBlock(last), address, topics },
      ])
      requireValue(
        Array.isArray(result) && result.length < MAX_LOGS_PER_QUERY,
        `${label}: missing, oversized, or potentially truncated log page`,
      )
      const seen = new Set()
      return result.map((log, i) => {
        const row = rawLog(log, `${label}[${i}]`, first, last)
        const key = `${row.blockHash}:${row.logIndex}`
        requireValue(!seen.has(key), `${label}: duplicate log within one query`)
        seen.add(key)
        return row
      })
    }
    const poolLogs = await getLogs(POOL, poolTopics, 'Pool operation')
    const poolNormalized = []
    for (const log of poolLogs) {
      requireValue(
        log.address === lower(POOL) && log.blockHash === (await canonical(log.blockNumber)),
        'Pool log emitter or block hash mismatch',
      )
      const decoded = decodeEventLog({
        abi: EVENTS,
        data: log.data,
        topics: log.topics,
        strict: true,
      })
      requireValue(
        ['Supply', 'Withdraw', 'Borrow', 'Repay'].includes(decoded.eventName) &&
          lower(decoded.args.reserve) === lower(market.base),
        'Pool log event or reserve mismatch',
      )
      poolNormalized.push({
        emitter: log.address,
        reserve: lower(decoded.args.reserve),
        kind: decoded.eventName,
        amountRaw: String(decoded.args.amount),
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        transactionIndex: log.transactionIndex,
        logIndex: log.logIndex,
      })
    }
    const poolChunk = seal({
      kind: 'poolOperations',
      status: 'rpc-returned-complete-not-independently-proven',
      ...boundary,
      queries: [{ filter: 'four Pool operation topics + reserve', logs: poolLogs }],
      normalized: poolNormalized,
    })
    requireValue(
      JSON.stringify(replayChunk(poolChunk, market)) === JSON.stringify(poolNormalized),
      'Pool raw log projection mismatch',
    )
    chunks.poolOperations.push(poolChunk)
    operations.push(...poolNormalized)
    const fromLogs = await getLogs(
      market.base,
      [EVENT_TOPICS.Transfer, aTokenTopic],
      'Transfer from aToken',
    )
    const toLogs = await getLogs(
      market.base,
      [EVENT_TOPICS.Transfer, null, aTokenTopic],
      'Transfer to aToken',
    )
    const merged = new Map()
    for (const log of [...fromLogs, ...toLogs]) {
      const key = `${log.blockHash}:${log.logIndex}`
      requireValue(
        !merged.has(key) || JSON.stringify(merged.get(key)) === JSON.stringify(log),
        'Conflicting duplicate Transfer log',
      )
      merged.set(key, log)
    }
    const transferNormalized = []
    for (const log of [...merged.values()].sort(
      (x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex,
    )) {
      requireValue(
        log.address === lower(market.base) && log.blockHash === (await canonical(log.blockNumber)),
        'Transfer emitter or block hash mismatch',
      )
      const decoded = decodeEventLog({
        abi: EVENTS,
        data: log.data,
        topics: log.topics,
        strict: true,
      })
      requireValue(
        decoded.eventName === 'Transfer' &&
          [lower(decoded.args.from), lower(decoded.args.to)].includes(lower(market.aToken)),
        'Wrong underlying Transfer',
      )
      transferNormalized.push({
        token: log.address,
        from: lower(decoded.args.from),
        to: lower(decoded.args.to),
        amountRaw: String(decoded.args.value),
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        transactionIndex: log.transactionIndex,
        logIndex: log.logIndex,
      })
    }
    const transferChunk = seal({
      kind: 'underlyingTransfers',
      status: 'rpc-returned-complete-not-independently-proven',
      ...boundary,
      queries: [
        { filter: 'from aToken', logs: fromLogs },
        { filter: 'to aToken', logs: toLogs },
      ],
      normalized: transferNormalized,
    })
    requireValue(
      JSON.stringify(replayChunk(transferChunk, market)) === JSON.stringify(transferNormalized),
      'Transfer raw log projection mismatch',
    )
    chunks.underlyingTransfers.push(transferChunk)
    transfers.push(...transferNormalized)
  }
  const coverage = Object.fromEntries(
    Object.entries(chunks).map(([kind, rows]) => [
      kind,
      rows.map((row) => ({
        fromBlock: row.fromBlock,
        toBlock: row.toBlock,
        complete: true,
        source: 'rpc:eth_getLogs',
        receiptSha256: row.sha256,
      })),
    ]),
  )
  const reconciliation = reconcileAaveCoreCash({
    chainId: 1,
    pool: POOL,
    underlying: market.base,
    aToken: market.aToken,
    from,
    to,
    coverage,
    operations,
    transfers,
  })
  // An operation mismatch is retained; a Transfer/endpoint mismatch cannot be
  // called a complete reserve-cash ledger and is not sealed as a success.
  requireValue(
    reconciliation.endpointReconciled,
    'Underlying Transfer and endpoint cash residual is nonzero',
  )
  for (const [n, expectedHash] of knownBlocks)
    requireValue((await getBlock(n)).hash === expectedHash, 'Canonical block hash drift')
  const receipt = seal({
    study: STUDY,
    market: market.name,
    chainId: 1,
    pool: lower(POOL),
    underlying: lower(market.base),
    aToken: lower(market.aToken),
    captureStartedAt,
    captureEndedAt: now().toISOString(),
    finalized: { number: finalized.number, hash: finalized.hash },
    from,
    to,
    identities,
    chunks,
    operations,
    transfers,
    reconciliation,
    caveat:
      'RPC-returned log ranges and pinned arithmetic only; not provider-independent completeness, causal intent, or executable exit capacity.',
  })
  const path = append(out, receipt, stat)
  return {
    status: 'recorded',
    path,
    market: market.name,
    fromBlock,
    toBlock,
    endpointResidualRaw: reconciliation.totals.endpointMinusTransfersRaw,
    operationGrossReconciled: reconciliation.operationGrossReconciled,
  }
}

function options(args) {
  const parsed = { run: false, verify: false, out: OUT }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--run' && !parsed.run) parsed.run = true
    else if (arg === '--verify' && !parsed.verify) parsed.verify = true
    else if (['--market', '--from', '--to', '--out', '--rpc'].includes(arg) && !parsed[arg])
      parsed[arg] = args[++i]
    else throw new Error('Unknown or duplicate option')
  }
  requireValue(!(parsed.run && parsed.verify), 'Incompatible modes')
  return parsed
}

async function main() {
  const parsed = options(process.argv.slice(2))
  if (parsed.verify) return console.log(JSON.stringify(verify({ out: parsed['--out'] || OUT })))
  if (!parsed.run)
    return console.log(
      JSON.stringify({
        mode: 'dry',
        study: STUDY,
        markets: MARKETS.map((m) => m.name),
        maxBlocks: MAX_BLOCKS,
      }),
    )
  const rpc =
    parsed['--rpc'] ||
    (process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL'))?.split(',')[0]?.trim()
  requireValue(rpc, 'One RPC host required')
  const result = await collect({
    client: makeClient(rpc),
    marketName: parsed['--market'],
    fromBlock: Number(parsed['--from']),
    toBlock: Number(parsed['--to']),
    out: parsed['--out'] || OUT,
  })
  console.log(JSON.stringify(result))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    console.error(JSON.stringify({ status: 'error', study: STUDY, reason: 'collector_failed' }))
    process.exitCode = 1
  })
