// Read-only capability comparison. An API match is not a borrower census.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readEnv } from '../lib/venue-reads.mjs'
import { DEFAULT_OUT, TOKEN, verify } from './usde-debt-mint-baseline.mjs'

export const MAX_PAGES = 4
export const MAX_RESPONSE_BYTES = 2_000_000
export const DEADLINE_MS = 20_000
const ZERO = `0x${'0'.repeat(40)}`
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const SEGMENT = /^\d{12}-\d{12}-[a-f0-9]{64}\.json$/
const PROBE_ERROR = Symbol('probeError')
const error = (code) =>
  Object.assign(new Error(`alchemy_mint_probe_${code}`), { [PROBE_ERROR]: true })
const hex = (number) => `0x${number.toString(16)}`

function numberFromHex(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw error('transfer_invalid')
  const number = Number(BigInt(value))
  if (!Number.isSafeInteger(number)) throw error('transfer_invalid')
  return number
}

function rawAmount(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw error('transfer_invalid')
  return BigInt(value).toString()
}

export function parseArgs(argv) {
  if (
    argv.length !== 3 ||
    argv[0] !== '--probe' ||
    argv[1] !== '--segment' ||
    !SEGMENT.test(argv[2])
  )
    throw error('cli_invalid')
  return { segmentName: argv[2] }
}

export function loadSealedSegment(name, { directory = DEFAULT_OUT, verifyIndex = verify } = {}) {
  if (!SEGMENT.test(name) || basename(name) !== name) throw error('segment_invalid')
  const index = verifyIndex({ out: directory })
  if (!Number.isInteger(index.segmentCount) || index.segmentCount < 1) throw error('index_invalid')
  const bytes = readFileSync(join(directory, name))
  if (bytes.length > 4_000_000) throw error('segment_size_cap')
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (!name.endsWith(`-${digest}.json`)) throw error('segment_hash_mismatch')
  let segment
  try {
    segment = JSON.parse(bytes)
  } catch {
    throw error('segment_invalid')
  }
  if (
    String(segment.fromBlock).padStart(12, '0') !== name.slice(0, 12) ||
    String(segment.toBlock).padStart(12, '0') !== name.slice(13, 25) ||
    segment.toBlock > index.throughBlock ||
    !Array.isArray(segment.logs) ||
    segment.logs.length > 1_000
  )
    throw error('segment_invalid')
  return segment
}

export function normalizeTransfer(transfer, fromBlock, toBlock) {
  const block = numberFromHex(transfer?.blockNum)
  const tx = String(transfer?.hash).toLowerCase()
  const owner = String(transfer?.to).toLowerCase()
  const source = String(transfer?.from).toLowerCase()
  const contract = String(transfer?.rawContract?.address).toLowerCase()
  if (
    block < fromBlock ||
    block > toBlock ||
    !HASH.test(tx) ||
    !ADDRESS.test(owner) ||
    owner === ZERO ||
    source !== ZERO ||
    contract !== TOKEN ||
    transfer?.category !== 'erc20'
  )
    throw error('transfer_invalid')
  return `${block}:${tx}:${owner}:${rawAmount(transfer.rawContract.value)}`
}

function multiset(rows) {
  const counts = new Map()
  for (const row of rows) counts.set(row, (counts.get(row) ?? 0) + 1)
  return counts
}

export function compareTransfers(segment, transfers) {
  const expected = multiset(
    segment.logs.map(
      (entry) => `${entry.blockNumber}:${entry.transactionHash}:${entry.owner}:${entry.valueRaw}`,
    ),
  )
  const actual = multiset(
    transfers.map((transfer) => normalizeTransfer(transfer, segment.fromBlock, segment.toBlock)),
  )
  let matched = 0
  for (const [key, count] of expected) matched += Math.min(count, actual.get(key) ?? 0)
  // The API response is not a canonical log receipt and does not bind logIndex.
  // Two identical tuples in one transaction cannot be distinguished here.
  const ambiguous = [...expected.values(), ...actual.values()].some((count) => count > 1)
  return {
    matched,
    saved: segment.logs.length,
    api: transfers.length,
    missing: segment.logs.length - matched,
    extra: transfers.length - matched,
    match: !ambiguous && matched === segment.logs.length && matched === transfers.length,
    ambiguous,
    comparisonScope: 'block_transaction_recipient_raw_amount_only',
    completenessClaim: false,
  }
}

export function configuredAlchemyUrl(raw) {
  for (const candidate of String(raw ?? '')
    .split(',')
    .map((part) => part.trim())) {
    try {
      const url = new URL(candidate)
      if (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        (url.hostname === 'alchemy.com' || url.hostname.endsWith('.alchemy.com'))
      )
        return candidate
    } catch {
      /* Invalid configured URL is skipped without disclosure. */
    }
  }
  throw error('alchemy_url_unavailable')
}

async function boundedJson(response) {
  if (!response?.ok || !response.body?.getReader) throw error('request_failed')
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_RESPONSE_BYTES) throw error('response_size_cap')
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw error('response_invalid')
  }
}

export async function probeTransfers(
  segment,
  { url, fetchImpl = fetch, deadlineMs = DEADLINE_MS } = {},
) {
  if (!url || !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > DEADLINE_MS)
    throw error('probe_invalid')
  const controller = new AbortController()
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(error('deadline'))
    }, deadlineMs)
  })
  const transfers = []
  const keys = new Set()
  let pageKey
  let pages = 0
  try {
    return await Promise.race([
      (async () => {
        do {
          if (controller.signal.aborted) throw error('deadline')
          if (++pages > MAX_PAGES) throw error('page_cap')
          const params = {
            fromBlock: hex(segment.fromBlock),
            toBlock: hex(segment.toBlock),
            fromAddress: ZERO,
            contractAddresses: [TOKEN],
            category: ['erc20'],
            excludeZeroValue: false,
            maxCount: hex(1000),
          }
          if (pageKey) params.pageKey = pageKey
          const response = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'alchemy_getAssetTransfers',
              params: [params],
            }),
            signal: controller.signal,
          })
          if (controller.signal.aborted) throw error('deadline')
          const body = await boundedJson(response)
          if (controller.signal.aborted) throw error('deadline')
          if (
            body?.jsonrpc !== '2.0' ||
            body?.id !== 1 ||
            body?.error ||
            !Array.isArray(body?.result?.transfers) ||
            body.result.transfers.length > 1000
          )
            throw error('response_invalid')
          transfers.push(...body.result.transfers)
          const next = body.result.pageKey
          if (next !== undefined && next !== null && next !== '') {
            if (typeof next !== 'string' || next.length > 1024 || keys.has(next))
              throw error('page_loop')
            keys.add(next)
            pageKey = next
          } else pageKey = undefined
        } while (pageKey)
        return { ...compareTransfers(segment, transfers), pages }
      })(),
      deadline,
    ])
  } catch (cause) {
    if (cause?.[PROBE_ERROR]) throw cause
    throw error(controller.signal.aborted ? 'deadline' : 'request_failed')
  } finally {
    clearTimeout(timer)
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const { segmentName } = parseArgs(argv)
  const segment = loadSealedSegment(segmentName)
  let env = dependencies.env
  if (!env) {
    try {
      env = readEnv()
    } catch {
      env = { get: () => undefined }
    }
  }
  const raw = [
    dependencies.rpcUrls,
    process.env.RECORDER_RPC_URLS,
    process.env.RECORDER_RPC_URL,
    env.get('RECORDER_RPC_URLS'),
    env.get('RECORDER_RPC_URL'),
  ]
    .filter(Boolean)
    .join(',')
  return probeTransfers(segment, {
    url: configuredAlchemyUrl(raw),
    fetchImpl: dependencies.fetchImpl ?? fetch,
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`)
    })
    .catch((cause) => {
      const code = cause?.[PROBE_ERROR] ? cause.message : 'alchemy_mint_probe_failed'
      process.stderr.write(`${code}\n`)
      process.exitCode = 1
    })
}
