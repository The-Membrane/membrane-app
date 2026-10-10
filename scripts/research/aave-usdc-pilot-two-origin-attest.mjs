// Independent public-RPC attestation of the existing Aave USDC cash-flow pilot.
// The pilot's receipts are immutable; each sidecar binds both fresh origins to
// its raw Pool operation and USDC cash-transfer log queries and endpoint cash.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { encodeFunctionData, padHex, parseAbiItem, toEventSelector } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { OUT as PILOT, verifyPilot } from './aave-usdc-24h-flow-pilot.mjs'

export const STUDY = 'aave-usdc-pilot-two-origin-attestation-v2'
export const OUT = resolve('data/research/venue-signals/aave-usdc-24h-flow-pilot-two-origin-v2')
export const MIN_FREE_BYTES = 1024 ** 3
export const MAX_ATTESTATION_BYTES = 2 * 1024 ** 2
export const ATTESTATION_ORIGINS = Object.freeze([
  'https://mainnet.infura.io',
  'https://rpc.ankr.com',
])
const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const HEX = /^0x(?:[0-9a-f]{2})*$/
const BALANCE = parseAbiItem('function balanceOf(address) view returns (uint256)')
const TOPICS = {
  supply: toEventSelector(
    parseAbiItem(
      'event Supply(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint16 indexed referralCode)',
    ),
  ).toLowerCase(),
  withdraw: toEventSelector(
    parseAbiItem(
      'event Withdraw(address indexed reserve,address indexed user,address indexed to,uint256 amount)',
    ),
  ).toLowerCase(),
  borrow: toEventSelector(
    parseAbiItem(
      'event Borrow(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint8 interestRateMode,uint256 borrowRate,uint16 indexed referralCode)',
    ),
  ).toLowerCase(),
  repay: toEventSelector(
    parseAbiItem(
      'event Repay(address indexed reserve,address indexed user,address indexed repayer,uint256 amount,bool useATokens)',
    ),
  ).toLowerCase(),
  transfer: toEventSelector(
    parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)'),
  ).toLowerCase(),
}
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : '')
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const EXPECTED_ORIGIN_FINGERPRINTS = ATTESTATION_ORIGINS.map((origin) => hash(origin))
const fail = (condition, code) => {
  if (!condition) throw new Error(code)
}
const blockHex = (number) => `0x${number.toString(16)}`
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function canonicalDirectory(path) {
  fail(
    resolve(path) === path && lstatSync(path).isDirectory() && realpathSync(path) === path,
    'invalid_attestation_directory',
  )
}

export function readSealedJson(path, maxBytes = MAX_ATTESTATION_BYTES) {
  fail(
    resolve(path) === path && Number.isSafeInteger(maxBytes) && maxBytes > 0,
    'invalid_attestation_read',
  )
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const initial = fstatSync(fd)
    fail(
      initial.isFile() && initial.size > 0 && initial.size <= maxBytes,
      'invalid_attestation_file',
    )
    const bytes = Buffer.alloc(initial.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null)
      fail(count > 0, 'short_attestation_read')
      offset += count
    }
    fail(fstatSync(fd).size === initial.size, 'changed_attestation_file')
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    if (error?.code === 'ELOOP' || error?.code === 'EISDIR')
      throw new Error('invalid_attestation_file')
    throw error
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function hasSealedFile(path) {
  try {
    fail(lstatSync(path).isFile(), 'invalid_attestation_file')
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

export function attestationFiles(expectedCount, directory = OUT) {
  fail(
    Number.isSafeInteger(expectedCount) && expectedCount >= 1 && expectedCount <= 256,
    'invalid_attestation_count',
  )
  canonicalDirectory(directory)
  const names = readdirSync(directory)
  fail(names.length <= expectedCount + 64, 'unbounded_attestation_directory')
  for (const name of names) {
    fail(
      (/^receipt-\d{2}\.json$/.test(name) && Number(name.slice(8, 10)) < expectedCount) ||
        /^\.aave-usdc-attest-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(
          name,
        ),
      'unexpected_attestation_file',
    )
    fail(lstatSync(join(directory, name)).isFile(), 'invalid_attestation_file')
  }
  return names
}

function integer(value, code) {
  fail(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, code)
  return value
}

function normalizedLog(value) {
  fail(
    value &&
      value.removed !== true &&
      lower(value.removed) !== 'true' &&
      ADDRESS.test(lower(value.address)) &&
      HASH.test(lower(value.blockHash)) &&
      HASH.test(lower(value.transactionHash)) &&
      Array.isArray(value.topics) &&
      value.topics.every((topic) => HASH.test(lower(topic))) &&
      HEX.test(lower(value.data)),
    'invalid_attestation_log',
  )
  const field = (name) => {
    const number = Number(BigInt(value[name]))
    return integer(number, 'invalid_attestation_log_coordinate')
  }
  return {
    address: lower(value.address),
    blockNumber: field('blockNumber'),
    blockHash: lower(value.blockHash),
    transactionHash: lower(value.transactionHash),
    transactionIndex: field('transactionIndex'),
    logIndex: field('logIndex'),
    topics: value.topics.map(lower),
    data: lower(value.data),
  }
}

function sourceReceipts() {
  canonicalDirectory(PILOT)
  const names = readdirSync(PILOT)
  fail(names.length <= 64, 'unbounded_attestation_source')
  for (const name of names) {
    fail(
      ['pilot.plan', 'pilot.summary', 'event-headers.headers'].includes(name) ||
        /^USDC-\d+-\d+-[0-9a-f]{64}\.json$/.test(name),
      'unexpected_attestation_source',
    )
    const stat = lstatSync(join(PILOT, name))
    fail(
      stat.isFile() && stat.size > 0 && stat.size <= MAX_ATTESTATION_BYTES,
      'invalid_attestation_source',
    )
  }
  verifyPilot({ out: PILOT })
  return names
    .filter((name) => /^USDC-\d+-\d+-[0-9a-f]{64}\.json$/.test(name))
    .sort()
    .map((name) => readSealedJson(join(PILOT, name)))
}

function querySpecs(source) {
  const reserve = padHex(source.underlying, { size: 32 }).toLowerCase()
  const custody = padHex(source.aToken, { size: 32 }).toLowerCase()
  const byKey = new Map()
  for (const chunk of source.chunks.poolOperations) {
    byKey.set(`pool:${chunk.fromBlock}:${chunk.toBlock}`, {
      kind: 'pool',
      fromBlock: chunk.fromBlock,
      toBlock: chunk.toBlock,
      address: source.pool,
      topics: [[TOPICS.supply, TOPICS.withdraw, TOPICS.borrow, TOPICS.repay], reserve],
      expected: chunk.queries[0].logs,
    })
  }
  for (const chunk of source.chunks.underlyingTransfers) {
    for (const [index, kind, topics] of [
      [0, 'cashOut', [TOPICS.transfer, custody]],
      [1, 'cashIn', [TOPICS.transfer, null, custody]],
    ]) {
      byKey.set(`${kind}:${chunk.fromBlock}:${chunk.toBlock}`, {
        kind,
        fromBlock: chunk.fromBlock,
        toBlock: chunk.toBlock,
        address: source.underlying,
        topics,
        expected: chunk.queries[index].logs,
      })
    }
  }
  return [...byKey.values()].sort(
    (a, b) => a.fromBlock - b.fromBlock || a.kind.localeCompare(b.kind),
  )
}

function originPair(rpcUrls) {
  const byHost = new Map()
  for (const url of String(rpcUrls || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)) {
    const parsed = new URL(url)
    fail(['http:', 'https:'].includes(parsed.protocol), 'invalid_rpc_url')
    if (!byHost.has(parsed.origin)) byHost.set(parsed.origin, url)
  }
  // These independent providers were live-probed for historical USDC logs.
  const selected = ATTESTATION_ORIGINS.map((origin) => [origin, byHost.get(origin)])
  fail(
    selected.every(([, url]) => url),
    'two_attestation_origins_required',
  )
  return selected.map(([origin, url]) => ({ origin, client: makeClient(url) }))
}

async function observe(client, source, specs) {
  const request = async (method, params) => {
    // The shared free-tier origin throttles bursts. Valid disagreement never retries.
    for (let attempt = 0; attempt < 3; attempt++) {
      await pause(500)
      try {
        return await client.request({ method, params })
      } catch (error) {
        const rateLimited = error?.status === 429 || error?.cause?.status === 429
        if (!rateLimited || attempt === 2) throw new Error('attestation_origin_unavailable')
        await pause((attempt + 1) * 2000)
      }
    }
    throw new Error('attestation_origin_unavailable')
  }
  fail(Number(BigInt(await request('eth_chainId', []))) === 1, 'wrong_attestation_chain')
  const finalized = await request('eth_getBlockByNumber', ['finalized', false])
  fail(Number(BigInt(finalized.number)) >= source.to.blockNumber, 'attestation_range_unfinalized')
  const ends = []
  const callData = encodeFunctionData({
    abi: [BALANCE],
    functionName: 'balanceOf',
    args: [source.aToken],
  })
  for (const expected of [source.from, source.to]) {
    const header = await request('eth_getBlockByNumber', [blockHex(expected.blockNumber), false])
    fail(lower(header?.hash) === expected.blockHash, 'attestation_endpoint_hash_disagreement')
    const raw = await request('eth_call', [
      { to: source.underlying, data: callData },
      { blockHash: expected.blockHash, requireCanonical: true },
    ])
    fail(
      HEX.test(lower(raw)) && BigInt(raw).toString() === expected.cashRaw,
      'attestation_endpoint_cash_disagreement',
    )
    ends.push({ number: expected.blockNumber, hash: expected.blockHash, cashRaw: expected.cashRaw })
  }
  const rows = []
  for (const spec of specs) {
    const raw = await request('eth_getLogs', [
      {
        address: spec.address,
        topics: spec.topics,
        fromBlock: blockHex(spec.fromBlock),
        toBlock: blockHex(spec.toBlock),
      },
    ])
    fail(Array.isArray(raw) && raw.length < 1000, 'attestation_log_page_unbounded')
    const logs = raw.map(normalizedLog)
    fail(
      logs.every((item) => item.blockNumber >= spec.fromBlock && item.blockNumber <= spec.toBlock),
      'attestation_log_range_mismatch',
    )
    fail(
      JSON.stringify(logs) === JSON.stringify(spec.expected),
      'attestation_source_log_disagreement',
    )
    rows.push(logs)
  }
  return { endpoints: ends, logs: rows }
}

export function documentFor(source, index, origins, observations, specs) {
  fail(
    JSON.stringify(origins.map((item) => item.origin)) === JSON.stringify(ATTESTATION_ORIGINS),
    'wrong_attestation_origins',
  )
  fail(
    JSON.stringify(observations[0]) === JSON.stringify(observations[1]),
    'attestation_origin_disagreement',
  )
  const body = {
    study: STUDY,
    index,
    sourceReceiptSha256: source.sha256,
    originFingerprints: origins.map((item) => hash(item.origin)),
    fromBlock: source.from.blockNumber,
    toBlock: source.to.blockNumber,
    observations: observations.map((observation) => ({
      endpoints: observation.endpoints,
      queries: specs.map((spec, i) => ({
        kind: spec.kind,
        fromBlock: spec.fromBlock,
        toBlock: spec.toBlock,
        logs: observation.logs[i],
      })),
    })),
  }
  return { ...body, sha256: hash(body) }
}

export function verifyOne(document, source, index) {
  const { sha256, ...body } = document
  fail(
    hash(body) === sha256 &&
      body.study === STUDY &&
      body.index === index &&
      body.sourceReceiptSha256 === source.sha256 &&
      JSON.stringify(body.originFingerprints) === JSON.stringify(EXPECTED_ORIGIN_FINGERPRINTS) &&
      body.fromBlock === source.from.blockNumber &&
      body.toBlock === source.to.blockNumber,
    'invalid_attestation_document',
  )
  fail(
    Array.isArray(body.observations) &&
      body.observations.length === 2 &&
      JSON.stringify(body.observations[0]) === JSON.stringify(body.observations[1]),
    'attestation_origin_disagreement',
  )
  const specs = querySpecs(source)
  for (const observation of body.observations) {
    fail(
      JSON.stringify(observation.endpoints) ===
        JSON.stringify([
          {
            number: source.from.blockNumber,
            hash: source.from.blockHash,
            cashRaw: source.from.cashRaw,
          },
          { number: source.to.blockNumber, hash: source.to.blockHash, cashRaw: source.to.cashRaw },
        ]),
      'attestation_endpoint_mismatch',
    )
    fail(
      Array.isArray(observation.queries) && observation.queries.length === specs.length,
      'attestation_query_gap',
    )
    for (const [i, spec] of specs.entries()) {
      const query = observation.queries[i]
      fail(
        query.kind === spec.kind &&
          query.fromBlock === spec.fromBlock &&
          query.toBlock === spec.toBlock &&
          JSON.stringify(query.logs) === JSON.stringify(spec.expected),
        'attestation_query_mismatch',
      )
    }
  }
  return document
}

function publish(path, document) {
  const stage = join(OUT, `.aave-usdc-attest-${randomUUID()}.tmp`)
  let fd
  try {
    fd = openSync(
      stage,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o444,
    )
    writeFileSync(fd, `${JSON.stringify(document)}\n`)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    linkSync(stage, path)
    const dir = openSync(OUT, constants.O_RDONLY)
    try {
      fsyncSync(dir)
    } finally {
      closeSync(dir)
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(stage)) unlinkSync(stage)
  }
}

export function verifyAttestations({ complete = false } = {}) {
  const sources = sourceReceipts()
  const names = attestationFiles(sources.length)
  let count = 0
  for (const [index, source] of sources.entries()) {
    const path = join(OUT, `receipt-${String(index).padStart(2, '0')}.json`)
    if (!hasSealedFile(path)) {
      fail(!complete, 'attestation_incomplete')
      continue
    }
    verifyOne(readSealedJson(path), source, index)
    count++
  }
  fail(
    names.filter((name) => /^receipt-\d{2}\.json$/.test(name)).length === count,
    'unexpected_attestation_receipt',
  )
  return {
    study: STUDY,
    verifiedReceipts: count,
    expectedReceipts: sources.length,
    complete: count === sources.length,
    sourceStatus: 'two_public_origins_agree_not_absolute_completeness',
  }
}

export async function run({ rpcUrls, maxReceipts = 1 } = {}) {
  fail(
    Number.isSafeInteger(maxReceipts) && maxReceipts >= 1 && maxReceipts <= 4,
    'invalid_attestation_budget',
  )
  mkdirSync(OUT, { recursive: true })
  const sources = sourceReceipts()
  attestationFiles(sources.length)
  const origins = originPair(rpcUrls)
  let added = 0
  for (const [index, source] of sources.entries()) {
    const path = join(OUT, `receipt-${String(index).padStart(2, '0')}.json`)
    if (hasSealedFile(path)) {
      verifyOne(readSealedJson(path), source, index)
      continue
    }
    if (added >= maxReceipts) break
    const free = statfsSync(OUT)
    fail(Number(free.bavail) * Number(free.bsize) >= MIN_FREE_BYTES, 'attestation_disk_reserve')
    const specs = querySpecs(source)
    const observations = await Promise.all(
      origins.map((origin) => observe(origin.client, source, specs)),
    )
    const document = documentFor(source, index, origins, observations, specs)
    verifyOne(document, source, index)
    const bytes = Buffer.byteLength(`${JSON.stringify(document)}\n`)
    const after = statfsSync(OUT)
    fail(
      Number(after.bavail) * Number(after.bsize) - bytes >= MIN_FREE_BYTES,
      'attestation_disk_reserve',
    )
    publish(path, document)
    added++
  }
  return { ...verifyAttestations(), added }
}

async function main(args) {
  fail(args.length === 1 && ['--run', '--verify', '--verify-complete'].includes(args[0]), 'usage')
  if (args[0] === '--verify' || args[0] === '--verify-complete')
    return process.stdout.write(
      `${JSON.stringify(verifyAttestations({ complete: args[0] === '--verify-complete' }))}\n`,
    )
  const env = readEnv()
  const rpcUrls =
    process.env.RECORDER_RPC_URLS ||
    process.env.RECORDER_RPC_URL ||
    env.get('RECORDER_RPC_URLS') ||
    env.get('RECORDER_RPC_URL')
  process.stdout.write(`${JSON.stringify(await run({ rpcUrls }))}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('aave_usdc_attestation_failed\n')
    process.exitCode = 1
  })
