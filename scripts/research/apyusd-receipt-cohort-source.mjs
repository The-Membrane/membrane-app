// Frozen before outcome lookup: every ApyUSD receipt mint in B25800000–25920000.
import { createHash, randomUUID } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { keccak256, stringToHex } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'

export const OUT = resolve('data/research/venue-signals/apyusd-receipt-cohort-source-v1.json')
export const RECEIPT = '0x9bf51f33955ec70f87c4b5c49441815589043237'
export const FROM = 25_800_000
export const TO = 25_920_000
const STEP = 10_000
const EXPECTED_MINTS = 96
const PREDECLARED_MINTS_SHA256 = 'e04effeab6217d7f177dae417348c977b2cedad4a35e174c0d69fb4021bbc934'
const ZERO = `0x${'0'.repeat(64)}`
const TOPIC = keccak256(stringToHex('Transfer(address,address,uint256)'))
const SHA = /^[0-9a-f]{64}$/
const WORD = /^0x[0-9a-f]{64}$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const canonical = JSON.stringify
const hex = (n) => `0x${n.toString(16)}`
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

export function predeclaredMintsSha256(mints) {
  return sha(
    canonical(
      mints.map((mint) => ({
        block: mint.blockNumber,
        blockHash: mint.blockHash,
        transactionHash: mint.transactionHash,
        logIndex: mint.logIndex,
        topics: mint.topics,
        data: mint.data,
      })),
    ),
  )
}

function verifyPredeclaredMints(mints) {
  if (predeclaredMintsSha256(mints) !== PREDECLARED_MINTS_SHA256)
    throw Error('apyusd_cohort_predeclared_source_changed')
}

export async function writeExclusive(path, value) {
  const bytes = `${canonical(value)}\n`
  await mkdir(dirname(path), { recursive: true })
  const disk = statfsSync(dirname(path))
  if (Number(disk.bavail) * Number(disk.bsize) < 1_073_741_824 + Buffer.byteLength(bytes))
    throw Error('apyusd_cohort_disk_reserve')
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, bytes, { flag: 'wx', mode: 0o600 })
    await link(tmp, path)
  } finally {
    await rm(tmp, { force: true })
  }
}

function validateWindow(row, low, high) {
  if (
    row?.study !== 'apyusd_receipt_mint_window_v1' ||
    row.fromBlock !== low ||
    row.toBlock !== high ||
    canonical(row.origins) !== canonical(['rpc.ankr.com', 'mainnet.infura.io']) ||
    !Array.isArray(row.mints) ||
    !SHA.test(row.sha256 ?? '')
  )
    throw Error('apyusd_cohort_window_invalid')
  const { sha256: _seal, ...body } = row
  if (row.sha256 !== sha(canonical(body))) throw Error('apyusd_cohort_window_hash_invalid')
  for (const log of row.mints)
    if (
      canonical(
        normalizeMint(
          {
            ...log,
            address: RECEIPT,
            blockNumber: hex(log.blockNumber),
            logIndex: hex(log.logIndex),
          },
          low,
          high,
        ),
      ) !== canonical(log)
    )
      throw Error('apyusd_cohort_window_log_invalid')
  return row
}

async function readCheckpoint(path, low, high) {
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (bytes.length > 32_768) throw Error('apyusd_cohort_window_oversize')
  const row = JSON.parse(bytes.toString('utf8'))
  if (bytes.toString('utf8') !== `${canonical(row)}\n`)
    throw Error('apyusd_cohort_window_encoding_invalid')
  return validateWindow(row, low, high)
}

export async function requestWithRetries(origin, method, params) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await origin.request(method, params)
    } catch (error) {
      if (error.message !== 'public_rpc_unavailable' || attempt === 3) throw error
      await sleep(750 * 2 ** attempt)
    }
  }
  throw Error('apyusd_cohort_rpc_unavailable')
}

export function normalizeMint(log, low, high) {
  const blockNumber = Number(BigInt(log.blockNumber ?? '0x0'))
  const logIndex = Number(BigInt(log.logIndex ?? '0x0'))
  const topics = log.topics?.map((topic) => topic.toLowerCase())
  if (
    log.address?.toLowerCase() !== RECEIPT ||
    log.removed === true ||
    blockNumber < low ||
    blockNumber > high ||
    typeof log.logIndex !== 'string' ||
    !Number.isSafeInteger(logIndex) ||
    !WORD.test(log.blockHash ?? '') ||
    !WORD.test(log.transactionHash ?? '') ||
    topics?.length !== 4 ||
    topics[0] !== TOPIC ||
    topics[1] !== ZERO ||
    !WORD.test(topics[2]) ||
    !WORD.test(topics[3]) ||
    !/^0x[0-9a-f]*$/.test(log.data ?? '')
  )
    throw Error('apyusd_cohort_mint_log_invalid')
  return {
    blockNumber,
    blockHash: log.blockHash.toLowerCase(),
    transactionHash: log.transactionHash.toLowerCase(),
    logIndex,
    topics,
    data: log.data.toLowerCase(),
  }
}

export function validateSource(row) {
  if (
    row?.study !== 'apyusd_receipt_mint_cohort_v1' ||
    row.receipt !== RECEIPT ||
    row.fromBlock !== FROM ||
    row.toBlock !== TO ||
    !Array.isArray(row.origins) ||
    row.origins.length !== 2 ||
    row.origins[0] === row.origins[1] ||
    !Array.isArray(row.windows) ||
    row.windows.length !== Math.ceil((TO - FROM + 1) / STEP) ||
    !Array.isArray(row.mints) ||
    row.mints.length !== EXPECTED_MINTS ||
    !SHA.test(row.mintsSha256 ?? '') ||
    row.mintsSha256 !== sha(canonical(row.mints)) ||
    !SHA.test(row.sha256 ?? '')
  )
    throw Error('apyusd_cohort_source_invalid')
  const { sha256: _seal, ...body } = row
  if (row.sha256 !== sha(canonical(body))) throw Error('apyusd_cohort_source_hash_invalid')
  const seen = new Set()
  for (const [index, log] of row.mints.entries()) {
    if (
      canonical(
        normalizeMint(
          {
            ...log,
            address: RECEIPT,
            blockNumber: hex(log.blockNumber),
            logIndex: hex(log.logIndex),
          },
          FROM,
          TO,
        ),
      ) !== canonical(log)
    )
      throw Error('apyusd_cohort_mint_invalid')
    const token = BigInt(log.topics[3]).toString()
    if (seen.has(token)) throw Error('apyusd_cohort_token_repeated')
    seen.add(token)
    if (
      index > 0 &&
      (log.blockNumber < row.mints[index - 1].blockNumber ||
        (log.blockNumber === row.mints[index - 1].blockNumber &&
          log.logIndex <= row.mints[index - 1].logIndex))
    )
      throw Error('apyusd_cohort_order_invalid')
  }
  let cursor = FROM
  let total = 0
  for (const window of row.windows) {
    if (
      window.fromBlock !== cursor ||
      window.toBlock !== Math.min(TO, cursor + STEP - 1) ||
      !Number.isSafeInteger(window.mints) ||
      window.mints < 0 ||
      !SHA.test(window.sha256 ?? '')
    )
      throw Error('apyusd_cohort_windows_invalid')
    const slice = row.mints.filter(
      (mint) => mint.blockNumber >= window.fromBlock && mint.blockNumber <= window.toBlock,
    )
    if (window.mints !== slice.length || window.sha256 !== sha(canonical(slice)))
      throw Error('apyusd_cohort_window_hash_invalid')
    total += window.mints
    cursor = window.toBlock + 1
  }
  if (cursor !== TO + 1 || total !== EXPECTED_MINTS) throw Error('apyusd_cohort_source_incomplete')
  return row
}

export async function captureSource({ urls = configuredPublicRpcUrls(readEnv()), out = OUT } = {}) {
  const origins = publicRpcClients(urls)
  const ankr = origins.find((origin) => new URL(origin.url).hostname === 'rpc.ankr.com')
  const infura = origins.find((origin) => new URL(origin.url).hostname === 'mainnet.infura.io')
  if (!ankr || !infura) throw Error('apyusd_cohort_origins_unavailable')
  if (
    (await requestWithRetries(ankr, 'eth_chainId', [])) !== '0x1' ||
    (await requestWithRetries(infura, 'eth_chainId', [])) !== '0x1'
  )
    throw Error('apyusd_cohort_chain_invalid')
  const mints = []
  const windows = []
  for (let low = FROM; low <= TO; low += STEP) {
    const high = Math.min(TO, low + STEP - 1)
    const checkpointPath = `${out}.windows/${low}-${high}.json`
    const checkpoint = await readCheckpoint(checkpointPath, low, high)
    if (checkpoint) {
      windows.push({
        fromBlock: low,
        toBlock: high,
        mints: checkpoint.mints.length,
        sha256: sha(canonical(checkpoint.mints)),
      })
      mints.push(...checkpoint.mints)
      continue
    }
    const query = {
      address: RECEIPT,
      topics: [TOPIC, ZERO],
      fromBlock: hex(low),
      toBlock: hex(high),
    }
    const a = (await requestWithRetries(ankr, 'eth_getLogs', [query])).map((log) =>
      normalizeMint(log, low, high),
    )
    await sleep(250)
    const b = (await requestWithRetries(infura, 'eth_getLogs', [query])).map((log) =>
      normalizeMint(log, low, high),
    )
    if (canonical(a) !== canonical(b)) throw Error('apyusd_cohort_origins_disagree')
    const body = {
      study: 'apyusd_receipt_mint_window_v1',
      fromBlock: low,
      toBlock: high,
      origins: ['rpc.ankr.com', 'mainnet.infura.io'],
      mints: a,
    }
    await writeExclusive(
      checkpointPath,
      validateWindow({ ...body, sha256: sha(canonical(body)) }, low, high),
    )
    windows.push({ fromBlock: low, toBlock: high, mints: a.length, sha256: sha(canonical(a)) })
    mints.push(...a)
    console.error(`apyusd_cohort_window ${low}-${high} mints=${a.length}`)
  }
  const body = {
    study: 'apyusd_receipt_mint_cohort_v1',
    receipt: RECEIPT,
    fromBlock: FROM,
    toBlock: TO,
    origins: ['rpc.ankr.com', 'mainnet.infura.io'],
    windows,
    mints,
    mintsSha256: sha(canonical(mints)),
  }
  const row = validateSource({ ...body, sha256: sha(canonical(body)) })
  verifyPredeclaredMints(row.mints)
  await writeExclusive(out, row)
  return row
}

export async function verifySource(out = OUT) {
  const bytes = await readFile(out)
  if (bytes.length > 131_072) throw Error('apyusd_cohort_source_oversize')
  const row = JSON.parse(bytes.toString('utf8'))
  if (bytes.toString('utf8') !== `${canonical(row)}\n`)
    throw Error('apyusd_cohort_source_encoding_invalid')
  validateSource(row)
  verifyPredeclaredMints(row.mints)
  return row
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const verify = process.argv.includes('--verify')
  const row = verify ? await verifySource() : await captureSource()
  console.log(
    JSON.stringify({
      study: row.study,
      fromBlock: row.fromBlock,
      toBlock: row.toBlock,
      mints: row.mints.length,
      mintsSha256: row.mintsSha256,
      predeclaredMintsSha256: predeclaredMintsSha256(row.mints),
      sha256: row.sha256,
      origins: row.origins,
    }),
  )
}
