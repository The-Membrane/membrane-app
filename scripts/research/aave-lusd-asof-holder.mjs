// Pre-outcome Aave LUSD holder census. This file never reads block B or simulates withdraw.
// Run bounded slices; freeze and verify this artifact before a separate outcome stage.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, parseAbi, toEventSelector } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { MARKETS, POOL } from './aave-stable-expansion.mjs'

const MARKET_CONFIG = Object.freeze({
  LUSD: { onset: 23_323_406, out: 'aave-lusd-asof-holder-v1.json' },
  RLUSD: { onset: 25_640_006, out: 'aave-rlusd-asof-holder-v1.json' },
  USDC: {
    onset: 24_912_806,
    out: 'aave-usdc-asof-holder-v1.json',
    market: {
      name: 'USDC',
      base: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      aToken: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
      decimals: 6,
    },
  },
})
const marketOptionIndex = process.argv.indexOf('--market')
const marketName = marketOptionIndex < 0 ? 'LUSD' : process.argv[marketOptionIndex + 1]
if (!MARKET_CONFIG[marketName]) throw new Error('Unsupported market')
export const STUDY = `aave-${marketName.toLowerCase()}-asof-holder-preoutcome-v1`
export const B = MARKET_CONFIG[marketName].onset
export const A = B - 1_800
export const MARKET = Object.freeze(
  MARKET_CONFIG[marketName].market ?? MARKETS.find((market) => market.name === marketName),
)
export const Q = 1_000_000n * 10n ** BigInt(MARKET.decimals)
export const MAX_CHUNK_BLOCKS = 2_000
export const MAX_LOGS = 100_000
export const MAX_ADDRESSES = 20_000
export const DISK_FLOOR_BYTES = 2.5 * 1024 ** 3
export const DEFAULT_OUT = resolve('data/research/venue-signals', MARKET_CONFIG[marketName].out)
const ZERO = `0x${'0'.repeat(40)}`
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const WORD = /^0x[0-9a-f]{64}$/
const RAW = /^\d+$/
const CODE = /^0x(?:[0-9a-f]{2})*$/
const TOPIC = toEventSelector('Transfer(address,address,uint256)').toLowerCase()
const BALANCE_ABI = parseAbi(['function balanceOf(address owner) view returns (uint256)'])
const RESERVE_ABI = [
  {
    type: 'function',
    name: 'getReserveData',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'configuration', type: 'tuple', components: [{ name: 'data', type: 'uint256' }] },
          ...[
            'liquidityIndex',
            'currentLiquidityRate',
            'variableBorrowIndex',
            'currentVariableBorrowRate',
            'currentStableBorrowRate',
          ].map((name) => ({ name, type: 'uint128' })),
          { name: 'lastUpdateTimestamp', type: 'uint40' },
          { name: 'id', type: 'uint16' },
          { name: 'aTokenAddress', type: 'address' },
          ...[
            'stableDebtTokenAddress',
            'variableDebtTokenAddress',
            'interestRateStrategyAddress',
          ].map((name) => ({ name, type: 'address' })),
          { name: 'accruedToTreasury', type: 'uint128' },
          { name: 'unbacked', type: 'uint128' },
          { name: 'isolationModeTotalDebt', type: 'uint128' },
        ],
      },
    ],
  },
]

export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const num = (value) => {
  const n = Number(BigInt(value))
  if (!Number.isSafeInteger(n)) throw new Error('Unsafe RPC integer')
  return n
}
const lower = (value) => String(value).toLowerCase()
const pin = (hash) => ({ blockHash: hash, requireCanonical: true })
const codeHash = (code) => createHash('sha256').update(code).digest('hex')
const envelope = (payload) => ({ payload, sha256: digest(payload) })
const identity = () => ({
  study: STUDY,
  chainId: 1,
  pool: lower(POOL),
  underlying: lower(MARKET.base),
  aToken: lower(MARKET.aToken),
  decimals: MARKET.decimals,
  qRaw: Q.toString(),
  onsetBlock: B,
  asofBlock: A,
  topic: TOPIC,
})
const initial = () => ({
  ...identity(),
  status: 'partial',
  asofHash: null,
  reserve: null,
  search: { absentBelow: -1, presentAt: null, probes: [] },
  deploymentBlock: null,
  nextBlock: null,
  chunks: [],
  reads: [],
  frozenSha256: null,
})
function diskOk(path) {
  let dir = dirname(resolve(path))
  while (!existsSync(dir)) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error('No existing output ancestor')
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
  const value = await client.getBlock({ blockNumber: BigInt(block) })
  const hash = lower(value?.hash)
  if (num(value?.number) !== block || !HASH.test(hash)) throw new Error('Pinned header invalid')
  return hash
}
async function pinnedCode(client, address, block, expectedHash) {
  const hash = await header(client, block)
  if (expectedHash && hash !== expectedHash) throw new Error('Canonical block changed')
  const code = lower(await client.request({ method: 'eth_getCode', params: [address, pin(hash)] }))
  if (!CODE.test(code)) throw new Error('Pinned code invalid')
  return { block, hash, hasCode: code !== '0x', codeSha256: codeHash(code) }
}
function topicAddress(topic) {
  const value = lower(topic)
  if (!WORD.test(value) || !/^0x0{24}/.test(value)) throw new Error('Malformed Transfer address')
  return `0x${value.slice(26)}`
}
export function decodeTransfer(log, from, to) {
  if (
    lower(log?.address) !== lower(MARKET.aToken) ||
    lower(log?.topics?.[0]) !== TOPIC ||
    log.topics?.length !== 3 ||
    !WORD.test(lower(log.data)) ||
    log.removed === true ||
    !HASH.test(lower(log.blockHash)) ||
    !HASH.test(lower(log.transactionHash))
  )
    throw new Error('Malformed aToken Transfer log')
  const block = num(log.blockNumber),
    index = num(log.logIndex)
  if (block < from || block > to || index < 0) throw new Error('Out-of-range Transfer log')
  return {
    block,
    blockHash: lower(log.blockHash),
    txHash: lower(log.transactionHash),
    index,
    from: topicAddress(log.topics[1]),
    to: topicAddress(log.topics[2]),
    amount: BigInt(log.data).toString(),
  }
}
export function candidates(chunks) {
  const addresses = new Set()
  for (const chunk of chunks)
    for (const log of chunk.logs) {
      if (log.from !== ZERO) addresses.add(log.from)
      if (log.to !== ZERO) addresses.add(log.to)
    }
  return [...addresses].sort()
}
export function selectHolder(reads) {
  return (
    reads
      .filter((read) => read.status === 'ok' && read.eoa && BigInt(read.balanceRaw) >= Q)
      .sort((x, y) => {
        const delta = BigInt(x.balanceRaw) - BigInt(y.balanceRaw)
        return delta === 0n ? x.address.localeCompare(y.address) : delta > 0n ? -1 : 1
      })[0] || null
  )
}
export function summary(saved) {
  const candidateCount = candidates(saved.chunks).length
  const logsComplete = saved.deploymentBlock !== null && saved.nextBlock === A + 1
  const readsComplete = logsComplete && saved.reads.length === candidateCount
  const failures = saved.reads.filter((read) => read.status === 'error').length
  const holder = readsComplete && !failures ? selectHolder(saved.reads) : null
  return {
    status:
      saved.status === 'over-budget'
        ? 'over-budget'
        : !logsComplete
          ? 'logs-pending'
          : !readsComplete
            ? 'reads-pending'
            : failures
              ? 'read-failure'
              : holder
                ? 'holder'
                : 'no-qualifying-eoa',
    deploymentBlock: saved.deploymentBlock,
    nextBlock: saved.nextBlock,
    logCount: saved.chunks.reduce((sum, chunk) => sum + chunk.logs.length, 0),
    candidateCount,
    readCount: saved.reads.length,
    readFailures: failures,
    holder: holder && { address: holder.address, balanceRaw: holder.balanceRaw },
    coverageCaveat: 'Single-provider eth_getLogs omissions are not independently corroborated',
  }
}
export function validateCheckpoint(sealed) {
  if (!sealed || digest(sealed.payload) !== sealed.sha256)
    throw new Error('Checkpoint SHA mismatch')
  const saved = sealed.payload
  for (const [key, value] of Object.entries(identity()))
    if (JSON.stringify(saved[key]) !== JSON.stringify(value))
      throw new Error('Checkpoint identity mismatch')
  if (
    !['partial', 'frozen', 'over-budget'].includes(saved.status) ||
    (saved.asofHash !== null && !HASH.test(saved.asofHash)) ||
    (saved.reserve !== null &&
      (saved.reserve.aToken !== lower(MARKET.aToken) ||
        saved.reserve.decimals !== MARKET.decimals)) ||
    !saved.search ||
    !Number.isSafeInteger(saved.search.absentBelow) ||
    saved.search.absentBelow < -1 ||
    saved.search.absentBelow >= A ||
    (saved.search.presentAt !== null &&
      (!Number.isSafeInteger(saved.search.presentAt) ||
        saved.search.presentAt < 0 ||
        saved.search.presentAt > A)) ||
    !Array.isArray(saved.search.probes) ||
    !Array.isArray(saved.chunks) ||
    !Array.isArray(saved.reads)
  )
    throw new Error('Checkpoint shape invalid')
  if (saved.reserve && !saved.asofHash) throw new Error('Reserve lacks A hash')
  const probed = new Map()
  for (const probe of saved.search.probes) {
    if (
      !Number.isSafeInteger(probe.block) ||
      probe.block < 0 ||
      probe.block > A ||
      !HASH.test(probe.hash) ||
      typeof probe.hasCode !== 'boolean' ||
      !/^[0-9a-f]{64}$/.test(probe.codeSha256) ||
      probed.has(probe.block)
    )
      throw new Error('Invalid code-search probe')
    probed.set(probe.block, probe)
  }
  if (probed.has(A) && probed.get(A).hash !== saved.asofHash)
    throw new Error('A code probe hash mismatch')
  if (saved.search.absentBelow >= 0 && probed.get(saved.search.absentBelow)?.hasCode !== false)
    throw new Error('Code lower boundary invalid')
  if (saved.search.presentAt !== null && probed.get(saved.search.presentAt)?.hasCode !== true)
    throw new Error('Code upper boundary invalid')
  if (
    saved.deploymentBlock !== null &&
    (saved.deploymentBlock !== saved.search.presentAt ||
      saved.search.absentBelow !== saved.deploymentBlock - 1 ||
      !saved.reserve)
  )
    throw new Error('Deployment boundary unverified')
  let frontier = saved.deploymentBlock,
    logCount = 0
  const seen = new Set()
  for (const chunk of saved.chunks) {
    if (
      frontier === null ||
      chunk.from !== frontier ||
      !Number.isSafeInteger(chunk.to) ||
      chunk.to < chunk.from ||
      chunk.to > A ||
      chunk.to - chunk.from + 1 > MAX_CHUNK_BLOCKS ||
      !HASH.test(chunk.fromHash) ||
      !HASH.test(chunk.toHash) ||
      !Array.isArray(chunk.logs) ||
      digest(chunk.logs) !== chunk.logsSha256
    )
      throw new Error('Chunk coverage/hash invalid')
    let last = [-1, -1]
    for (const log of chunk.logs) {
      if (
        !Number.isSafeInteger(log.block) ||
        log.block < chunk.from ||
        log.block > chunk.to ||
        !HASH.test(log.blockHash) ||
        !HASH.test(log.txHash) ||
        !Number.isSafeInteger(log.index) ||
        log.index < 0 ||
        !ADDRESS.test(log.from) ||
        !ADDRESS.test(log.to) ||
        !RAW.test(log.amount) ||
        (log.block === chunk.from && log.blockHash !== chunk.fromHash) ||
        (log.block === chunk.to && log.blockHash !== chunk.toHash) ||
        log.block < last[0] ||
        (log.block === last[0] && log.index <= last[1])
      )
        throw new Error('Invalid stored Transfer')
      const key = `${log.blockHash}:${log.txHash}:${log.index}`
      if (seen.has(key)) throw new Error('Duplicate Transfer')
      seen.add(key)
      last = [log.block, log.index]
    }
    logCount += chunk.logs.length
    frontier = chunk.to + 1
  }
  if (
    logCount > MAX_LOGS ||
    candidates(saved.chunks).length > MAX_ADDRESSES ||
    (saved.deploymentBlock === null ? saved.nextBlock !== null : saved.nextBlock !== frontier)
  )
    throw new Error('Frontier/resource guard invalid')
  const addresses = candidates(saved.chunks)
  if (saved.reads.length > addresses.length || (saved.reads.length && saved.nextBlock !== A + 1))
    throw new Error('Candidate reads before complete logs')
  for (let i = 0; i < saved.reads.length; i++) {
    const read = saved.reads[i]
    if (
      read.address !== addresses[i] ||
      !['ok', 'error'].includes(read.status) ||
      (read.status === 'ok' && (!RAW.test(read.balanceRaw) || typeof read.eoa !== 'boolean')) ||
      (read.status === 'error' && read.reason !== 'pinned-balance-or-code-read-failed')
    )
      throw new Error('Candidate read invalid')
  }
  const state = summary(saved).status
  if (
    saved.status === 'frozen' &&
    (!['holder', 'no-qualifying-eoa'].includes(state) ||
      saved.frozenSha256 !== digest({ chunks: saved.chunks, reads: saved.reads }))
  )
    throw new Error('Frozen selection incomplete')
  if (saved.status !== 'frozen' && saved.frozenSha256 !== null)
    throw new Error('Premature freeze hash')
  if (
    saved.status === 'over-budget' &&
    !['max-logs', 'max-addresses', 'disk-floor'].includes(saved.stopReason)
  )
    throw new Error('Over-budget reason invalid')
  return saved
}
export function loadCheckpoint(path = DEFAULT_OUT) {
  return existsSync(path) ? validateCheckpoint(JSON.parse(readFileSync(path, 'utf8'))) : initial()
}

async function ensureA(client, saved, out, checkDisk) {
  const hash = await header(client, A)
  if (saved.asofHash && saved.asofHash !== hash) throw new Error('A canonical hash changed')
  saved.asofHash = hash
  if (!saved.reserve) {
    const data = await client.request({
      method: 'eth_call',
      params: [
        {
          to: POOL,
          data: encodeFunctionData({
            abi: RESERVE_ABI,
            functionName: 'getReserveData',
            args: [MARKET.base],
          }),
        },
        pin(hash),
      ],
    })
    const reserve = decodeFunctionResult({ abi: RESERVE_ABI, functionName: 'getReserveData', data })
    const decimals = Number((BigInt(reserve.configuration.data) >> 48n) & 255n)
    if (lower(reserve.aTokenAddress) !== lower(MARKET.aToken) || decimals !== MARKET.decimals)
      throw new Error('Historical LUSD reserve identity mismatch')
    saved.reserve = { aToken: lower(reserve.aTokenAddress), decimals }
  }
  save(out, saved, checkDisk)
}
async function probe(client, saved, block, out, checkDisk) {
  const prior = saved.search.probes.find((entry) => entry.block === block)
  const result = await pinnedCode(client, lower(MARKET.aToken), block, prior?.hash)
  if (prior && (prior.hasCode !== result.hasCode || prior.codeSha256 !== result.codeSha256))
    throw new Error('Historical code changed')
  if (!prior) saved.search.probes.push(result)
  if (result.hasCode) saved.search.presentAt = Math.min(saved.search.presentAt ?? A, block)
  else saved.search.absentBelow = Math.max(saved.search.absentBelow, block)
  if (saved.search.presentAt !== null && saved.search.absentBelow >= saved.search.presentAt)
    throw new Error('Code-search boundary contradictory')
  save(out, saved, checkDisk)
  return result
}
async function discoverDeployment(client, saved, out, checkDisk, budget) {
  let used = 0
  if (saved.search.presentAt === null && used < budget) {
    const found = await probe(client, saved, A, out, checkDisk)
    used++
    if (!found.hasCode) throw new Error('aToken absent at A')
  }
  while (
    saved.search.presentAt !== null &&
    saved.search.presentAt - saved.search.absentBelow > 1 &&
    used < budget
  ) {
    const mid = Math.floor((saved.search.presentAt + saved.search.absentBelow) / 2)
    await probe(client, saved, mid, out, checkDisk)
    used++
  }
  if (
    saved.search.presentAt !== null &&
    saved.search.presentAt - saved.search.absentBelow === 1 &&
    saved.deploymentBlock === null &&
    used < budget
  ) {
    await probe(client, saved, saved.search.presentAt, out, checkDisk)
    used++
    if (saved.search.absentBelow >= 0 && used < budget) {
      await probe(client, saved, saved.search.absentBelow, out, checkDisk)
      used++
    }
    if (
      saved.search.absentBelow === -1 ||
      saved.search.probes.some((p) => p.block === saved.search.absentBelow && !p.hasCode)
    ) {
      saved.deploymentBlock = saved.search.presentAt
      saved.nextBlock = saved.deploymentBlock
      save(out, saved, checkDisk)
    }
  }
  return used
}
async function scanChunk(client, saved, out, checkDisk) {
  const from = saved.nextBlock,
    to = Math.min(A, from + MAX_CHUNK_BLOCKS - 1)
  const fromHash = await header(client, from),
    toHash = await header(client, to)
  const raw = await client.request({
    method: 'eth_getLogs',
    params: [
      {
        address: MARKET.aToken,
        topics: [TOPIC],
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
      },
    ],
  })
  if (!Array.isArray(raw)) throw new Error('Invalid log response')
  const priorLogCount = saved.chunks.reduce((sum, item) => sum + item.logs.length, 0)
  if (priorLogCount + raw.length > MAX_LOGS) {
    saved.status = 'over-budget'
    saved.stopReason = 'max-logs'
    save(out, saved, checkDisk)
    return false
  }
  const logs = raw
    .map((log) => decodeTransfer(log, from, to))
    .sort((x, y) => x.block - y.block || x.index - y.index)
  const hashesByBlock = new Map()
  for (const log of logs) {
    if (!hashesByBlock.has(log.block)) hashesByBlock.set(log.block, await header(client, log.block))
    if (hashesByBlock.get(log.block) !== log.blockHash)
      throw new Error('Transfer log canonical block hash mismatch')
  }
  if ((await header(client, from)) !== fromHash || (await header(client, to)) !== toHash)
    throw new Error('Chunk canonical boundary changed')
  const chunk = { from, to, fromHash, toHash, logs, logsSha256: digest(logs) }
  const proposed = [...saved.chunks, chunk]
  if (
    saved.chunks.reduce((sum, item) => sum + item.logs.length, 0) + logs.length > MAX_LOGS ||
    candidates(proposed).length > MAX_ADDRESSES
  ) {
    saved.status = 'over-budget'
    saved.stopReason = candidates(proposed).length > MAX_ADDRESSES ? 'max-addresses' : 'max-logs'
    save(out, saved, checkDisk)
    return false
  }
  saved.chunks.push(chunk)
  saved.nextBlock = to + 1
  save(out, saved, checkDisk)
  return true
}
async function readCandidate(client, saved, index, address, out, checkDisk) {
  let read
  try {
    const [balanceData, code] = await Promise.all([
      client.request({
        method: 'eth_call',
        params: [
          {
            to: MARKET.aToken,
            data: encodeFunctionData({
              abi: BALANCE_ABI,
              functionName: 'balanceOf',
              args: [address],
            }),
          },
          pin(saved.asofHash),
        ],
      }),
      client.request({ method: 'eth_getCode', params: [address, pin(saved.asofHash)] }),
    ])
    if (!CODE.test(lower(code))) throw new Error('Invalid EOA code')
    const balance = decodeFunctionResult({
      abi: BALANCE_ABI,
      functionName: 'balanceOf',
      data: balanceData,
    })
    read = { address, status: 'ok', balanceRaw: balance.toString(), eoa: lower(code) === '0x' }
  } catch {
    // Provider error text may contain RPC URLs, credentials, or response bodies.
    read = { address, status: 'error', reason: 'pinned-balance-or-code-read-failed' }
  }
  if (index === saved.reads.length) saved.reads.push(read)
  else saved.reads[index] = read
  save(out, saved, checkDisk)
}
export async function run({
  out = DEFAULT_OUT,
  client,
  maxCodeSteps = 0,
  maxNewChunks = 0,
  maxCandidates = 0,
  checkDisk = diskOk,
} = {}) {
  for (const [name, value] of Object.entries({ maxCodeSteps, maxNewChunks, maxCandidates }))
    if (!Number.isSafeInteger(value) || value < 0 || value > 500)
      throw new Error(`${name} must be 0..500`)
  const saved = loadCheckpoint(out)
  if (saved.status !== 'partial' || !(maxCodeSteps || maxNewChunks || maxCandidates))
    return summary(saved)
  if (!client) throw new Error('RPC client required')
  if (num(await client.request({ method: 'eth_chainId', params: [] })) !== 1)
    throw new Error('RPC chainId is not Ethereum mainnet')
  try {
    checkDisk(out)
    await ensureA(client, saved, out, checkDisk)
    if (saved.deploymentBlock === null && maxCodeSteps)
      await discoverDeployment(client, saved, out, checkDisk, maxCodeSteps)
    for (
      let i = 0;
      saved.deploymentBlock !== null && saved.nextBlock <= A && i < maxNewChunks;
      i++
    ) {
      checkDisk(out)
      if (!(await scanChunk(client, saved, out, checkDisk))) return summary(saved)
    }
    const addresses = saved.nextBlock === A + 1 ? candidates(saved.chunks) : []
    for (let i = 0; saved.nextBlock === A + 1 && i < maxCandidates; i++) {
      const next =
        saved.reads.length < addresses.length
          ? saved.reads.length
          : saved.reads.findIndex((read) => read.status === 'error')
      if (next < 0) break
      checkDisk(out)
      await readCandidate(client, saved, next, addresses[next], out, checkDisk)
    }
    if (
      saved.nextBlock === A + 1 &&
      saved.reads.length === addresses.length &&
      saved.reads.every((read) => read.status === 'ok')
    ) {
      saved.status = 'frozen'
      saved.frozenSha256 = digest({ chunks: saved.chunks, reads: saved.reads })
      save(out, saved, checkDisk)
    }
  } catch (error) {
    if (error.message === 'Disk reserve below 2.5 GiB') {
      saved.status = 'over-budget'
      saved.stopReason = 'disk-floor'
      // No write below the floor; the preceding checkpoint remains valid.
    }
    throw error
  }
  return summary(saved)
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
      !['--out', '--market', '--max-code-steps', '--max-new-chunks', '--max-candidates'].includes(
        argv[i],
      ) ||
      argv[i + 1] === undefined ||
      args[argv[i]] !== undefined
    )
      throw new Error('Invalid CLI option')
    args[argv[i]] = argv[i + 1]
  }
  if (mode !== '--run' && Object.keys(args).some((key) => !['--out', '--market'].includes(key)))
    throw new Error('Budgets are run-only')
  if (args['--market'] && !MARKET_CONFIG[args['--market']]) throw new Error('Unsupported market')
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
        study: saved.study,
        underlying: saved.underlying,
        aToken: saved.aToken,
        qRaw: saved.qRaw,
        onsetBlock: saved.onsetBlock,
        asofBlock: saved.asofBlock,
        ...summary(saved),
        checkpointSha256: existsSync(out) ? digest(saved) : null,
        frozenSha256: saved.frozenSha256,
      }),
    )
    return
  }
  const budgets = {
    maxCodeSteps: Number(args['--max-code-steps'] ?? 0),
    maxNewChunks: Number(args['--max-new-chunks'] ?? 0),
    maxCandidates: Number(args['--max-candidates'] ?? 0),
  }
  const client = Object.values(budgets).some(Boolean)
    ? makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL'))
    : null
  console.log(JSON.stringify(await run({ out, client, ...budgets })))
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error('Aave holder stage failed (details withheld to protect RPC credentials)')
    process.exitCode = 1
  })
