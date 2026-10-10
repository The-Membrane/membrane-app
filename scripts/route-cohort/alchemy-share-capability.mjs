// Read-only, bounded comparison of Alchemy's unfiltered ERC-20 Transfers API
// against one already-sealed, nonzero share Transfer-log segment. This is a
// provider capability probe, never a holder census or route-TVL certificate.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOKENS, verify } from './share-transfer-source.mjs'
import { readEnv } from '../lib/venue-reads.mjs'

export const MAX_PAGES = 4
export const MAX_RESPONSE_BYTES = 1_000_000
export const MAX_DURATION_MS = 20_000
const MAX_TRANSFERS = 4_000
const MAX_RECEIPT_BYTES = 2_000_000
const MIN_FREE_BYTES = 1_000_000_000
const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const SEGMENT_NAME = /^\d{12}-\d{12}-[a-f0-9]{64}\.json$/
const fail = (code) => {
  throw new Error(`alchemy_share_${code}`)
}
const hex = (n) => `0x${n.toString(16)}`
const lower = (s) => String(s).toLowerCase()
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

function checkReceiptDisk(out, stat = statfsSync, bytes = 0) {
  const space = stat(dirname(out))
  if (Number(space.bavail) * Number(space.bsize) - bytes < MIN_FREE_BYTES)
    fail('disk_reserve_reached')
}

function blockNumber(value) {
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value ?? '')) fail('transfer_invalid')
  const n = Number(BigInt(value))
  if (!Number.isSafeInteger(n)) fail('transfer_invalid')
  return n
}

function rawValue(value) {
  if (!/^0x[0-9a-f]+$/i.test(value ?? '')) fail('raw_value_unavailable')
  return BigInt(value).toString()
}

function tuple({ blockNumber: block, transactionHash, recipient, valueRaw }) {
  return `${block}:${transactionHash}:${recipient}:${valueRaw}`
}

export function loadNonzeroSegment({ source, name, config }) {
  if (!SEGMENT_NAME.test(name) || basename(name) !== name) fail('segment_name_invalid')
  const replay = verify({ out: source, config })
  if (!replay.segments.some((entry) => entry.name === name)) fail('segment_unverified')
  const segment = JSON.parse(readFileSync(join(source, name), 'utf8'))
  if (segment.logs.length === 0) fail('segment_zero_logs')
  return segment
}

export function requestParams(segment) {
  return {
    fromBlock: hex(segment.fromBlock),
    toBlock: hex(segment.toBlock),
    contractAddresses: [segment.config.address],
    category: ['erc20'],
    excludeZeroValue: false,
    maxCount: '0x3e8',
    order: 'asc',
    withMetadata: false,
  }
}

function normalizeTransfer(row, segment) {
  if (
    row?.category !== 'erc20' ||
    lower(row.rawContract?.address) !== segment.config.address ||
    !HASH.test(lower(row.hash)) ||
    !ADDRESS.test(lower(row.to))
  )
    fail('transfer_invalid')
  const block = blockNumber(row.blockNum)
  if (block < segment.fromBlock || block > segment.toBlock) fail('transfer_out_of_range')
  const id = row.uniqueId
  let logIndex = null
  if (id !== undefined && id !== null) {
    const match = typeof id === 'string' ? /^(0x[0-9a-f]{64}):log:(0|[1-9]\d*)$/i.exec(id) : null
    if (!match || lower(match[1]) !== lower(row.hash)) fail('transfer_id_invalid')
    logIndex = Number(match[2])
    if (!Number.isSafeInteger(logIndex)) fail('transfer_id_invalid')
  }
  return {
    blockNumber: block,
    transactionHash: lower(row.hash),
    recipient: lower(row.to),
    valueRaw: rawValue(row.rawContract.value),
    logIndex,
  }
}

function compareNormalized(segment, actual) {
  const canonical = segment.logs
  const counts = (list) => {
    const map = new Map()
    for (const item of list) {
      const key = tuple(item)
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return map
  }
  const expectedCounts = counts(canonical)
  const observedCounts = counts(actual)
  const sameMultiset =
    expectedCounts.size === observedCounts.size &&
    [...expectedCounts].every(([key, count]) => observedCounts.get(key) === count)
  const duplicateTuples =
    [...expectedCounts.values()].some((count) => count > 1) ||
    [...observedCounts.values()].some((count) => count > 1)
  const knownLogIndexes = actual.filter((row) => row.logIndex !== null).length
  const allLogIndexes = knownLogIndexes === actual.length
  const knownIndexContradiction = actual.some(
    (row) =>
      row.logIndex !== null &&
      !canonical.some((log) => tuple(log) === tuple(row) && log.logIndex === row.logIndex),
  )
  const exactLogIdentity =
    allLogIndexes &&
    sameMultiset &&
    new Set(actual.map((row) => `${tuple(row)}:${row.logIndex}`)).size === actual.length &&
    new Set(canonical.map((row) => `${tuple(row)}:${row.logIndex}`)).size === canonical.length &&
    actual.every((row) =>
      canonical.some((log) => tuple(log) === tuple(row) && log.logIndex === row.logIndex),
    )
  return {
    status:
      !sameMultiset || knownIndexContradiction
        ? 'mismatch'
        : (duplicateTuples && !allLogIndexes) || (knownLogIndexes > 0 && !allLogIndexes)
          ? 'ambiguous'
          : allLogIndexes && !exactLogIdentity
            ? 'mismatch'
            : 'matched',
    canonicalCount: canonical.length,
    apiCount: actual.length,
    duplicateTuples,
    apiLogIndexAvailable: allLogIndexes,
    knownLogIndexes,
    exactLogIdentity: Boolean(exactLogIdentity),
    claim: 'one_sealed_segment_comparison_only',
  }
}

export function compareTransfers(segment, rows) {
  return compareNormalized(
    segment,
    rows.map((row) => normalizeTransfer(row, segment)),
  )
}

function parseResponse(value) {
  if (value?.jsonrpc !== '2.0' || value.error || !Array.isArray(value.result?.transfers))
    fail('response_invalid')
  if (value.result.transfers.length > 1000) fail('page_overflow')
  const key = value.result.pageKey
  if (
    key !== undefined &&
    key !== null &&
    key !== '' &&
    (typeof key !== 'string' || key.length > 1024)
  )
    fail('page_key_invalid')
  return { rows: value.result.transfers, next: key || null }
}

export async function probe({
  segment,
  rpcRead,
  now = Date.now,
  maxPages = MAX_PAGES,
  onComplete,
}) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) fail('page_cap_invalid')
  const start = now()
  const rows = []
  const seen = new Set()
  let key = null
  for (let page = 0; page < maxPages; page++) {
    if (now() - start >= MAX_DURATION_MS) fail('deadline')
    const params = { ...requestParams(segment), ...(key ? { pageKey: key } : {}) }
    let value
    try {
      value = await rpcRead(params, MAX_DURATION_MS - (now() - start))
    } catch {
      fail('provider_failure')
    }
    const parsed = parseResponse(value)
    rows.push(...parsed.rows)
    if (rows.length > MAX_TRANSFERS) fail('transfer_cap')
    if (now() - start >= MAX_DURATION_MS) fail('deadline')
    if (!parsed.next) {
      const normalizedRows = rows.map((row) => normalizeTransfer(row, segment))
      const result = { ...compareNormalized(segment, normalizedRows), pages: page + 1 }
      if (onComplete) onComplete({ normalizedRows, result })
      return result
    }
    if (seen.has(parsed.next)) fail('page_key_repeated')
    seen.add(parsed.next)
    key = parsed.next
  }
  fail('pagination_incomplete')
}

function alchemyUrl(raw) {
  const entries = String(raw ?? '')
    .split(',')
    .filter(Boolean)
  const matches = entries.filter((entry) => {
    try {
      const url = new URL(entry.trim())
      return (
        url.protocol === 'https:' &&
        url.hostname === 'eth-mainnet.g.alchemy.com' &&
        /^\/v2\/[^/]+$/.test(url.pathname)
      )
    } catch {
      return false
    }
  })
  if (matches.length !== 1) fail('alchemy_endpoint_required')
  return matches[0].trim()
}

function parseArgs(argv) {
  let mode = null
  const values = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--run' || arg === '--verify') {
      if (mode) fail('cli_invalid')
      mode = arg
    } else if (
      ['--source', '--segment', '--token', '--deployment-block', '--start-block', '--out'].includes(
        arg,
      )
    ) {
      if (values[arg] || !argv[i + 1]) fail('cli_invalid')
      values[arg] = argv[++i]
    } else fail('cli_invalid')
  }
  if (
    !values['--source'] ||
    !values['--segment'] ||
    !values['--token'] ||
    !values['--deployment-block']
  )
    fail('cli_invalid')
  const token = values['--token']
  const config = {
    chainId: 1,
    token,
    address: TOKENS[token],
    deploymentBlock: Number(values['--deployment-block']),
    startBlock: Number(values['--start-block'] ?? values['--deployment-block']),
  }
  if (!config.address) fail('token_invalid')
  if ((mode === '--verify' && !values['--out']) || (!mode && values['--out'])) fail('cli_invalid')
  return {
    mode,
    source: resolve(values['--source']),
    name: values['--segment'],
    config,
    out: values['--out'] ? resolve(values['--out']) : null,
  }
}

function sourceIdentity(options, segment) {
  return {
    path: options.source,
    segment: options.name,
    physicalSha256: sha(readFileSync(join(options.source, options.name))),
    config: segment.config,
    fromBlock: segment.fromBlock,
    toBlock: segment.toBlock,
  }
}

function validNormalizedRows(rows, segment) {
  if (!Array.isArray(rows) || rows.length > MAX_TRANSFERS) fail('receipt_invalid')
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row?.blockNumber) ||
      row.blockNumber < segment.fromBlock ||
      row.blockNumber > segment.toBlock ||
      !HASH.test(row.transactionHash) ||
      !ADDRESS.test(row.recipient) ||
      !/^(0|[1-9]\d*)$/.test(row.valueRaw) ||
      (row.logIndex !== null && (!Number.isSafeInteger(row.logIndex) || row.logIndex < 0))
    )
      fail('receipt_invalid')
  }
}

function sealReceipt(out, receipt, stat = statfsSync) {
  const bytes = Buffer.from(JSON.stringify(receipt))
  if (bytes.length > MAX_RECEIPT_BYTES) fail('receipt_size_cap')
  checkReceiptDisk(out, stat, bytes.length)
  try {
    mkdirSync(out, { mode: 0o700 })
  } catch {
    fail('target_exists_or_unavailable')
  }
  const name = `${sha(bytes)}.json`
  const temp = join(out, `${randomUUID()}.tmp`)
  let fd
  try {
    fd = openSync(temp, 'wx', 0o600)
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    linkSync(temp, join(out, name))
  } catch (error) {
    if (fd !== undefined && fd !== null) closeSync(fd)
    try {
      unlinkSync(temp)
    } catch {
      /* no temp was created */
    }
    try {
      rmdirSync(out)
    } catch {
      /* preserve nonempty output for operator inspection */
    }
    throw error
  }
  unlinkSync(temp)
  return { out, name, sha256: sha(bytes), result: receipt.result }
}

function verifyReceipt(options, segment) {
  const names = readdirSync(options.out)
  if (names.length !== 1 || !/^[a-f0-9]{64}\.json$/.test(names[0])) fail('receipt_invalid')
  const path = join(options.out, names[0])
  if (statSync(path).size > MAX_RECEIPT_BYTES) fail('receipt_size_cap')
  const bytes = readFileSync(path)
  if (bytes.length > MAX_RECEIPT_BYTES || `${sha(bytes)}.json` !== names[0]) fail('receipt_invalid')
  let receipt
  try {
    receipt = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('receipt_invalid')
  }
  if (
    receipt?.schemaVersion !== 1 ||
    JSON.stringify(receipt.source) !== JSON.stringify(sourceIdentity(options, segment)) ||
    !Number.isInteger(receipt.pages) ||
    receipt.pages < 1 ||
    receipt.pages > MAX_PAGES ||
    typeof receipt.capturedAt !== 'string' ||
    !Number.isFinite(Date.parse(receipt.capturedAt))
  )
    fail('receipt_invalid')
  validNormalizedRows(receipt.normalizedRows, segment)
  const replay = {
    ...compareNormalized(segment, receipt.normalizedRows),
    pages: receipt.pages,
  }
  if (JSON.stringify(replay) !== JSON.stringify(receipt.result)) fail('receipt_replay_mismatch')
  return { status: 'verified', name: names[0], sha256: sha(bytes), result: replay }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv)
  const segment = loadNonzeroSegment(options)
  if (options.mode === '--verify') return verifyReceipt(options, segment)
  if (options.mode !== '--run')
    return {
      status: 'dry_run',
      fromBlock: segment.fromBlock,
      toBlock: segment.toBlock,
      canonicalCount: segment.logs.length,
      request: requestParams(segment),
      claim: 'no_api_request_made',
    }
  if (options.out) {
    const sourceRoot = realpathSync(options.source)
    const target = join(realpathSync(dirname(options.out)), basename(options.out))
    const inside = relative(sourceRoot, target)
    if (inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)))
      fail('out_inside_source')
    checkReceiptDisk(options.out, dependencies.stat ?? statfsSync)
    // A duplicate target must fail before a paid API call. The final mkdir remains exclusive.
    try {
      readdirSync(options.out)
      fail('target_exists_or_unavailable')
    } catch (error) {
      if (error.message === 'alchemy_share_target_exists_or_unavailable') throw error
      if (error.code !== 'ENOENT') fail('target_exists_or_unavailable')
    }
  }
  const env = dependencies.env ?? readEnv()
  const raw = dependencies.rpcUrls ?? env.get('RECORDER_RPC_URLS') ?? env.get('RECORDER_RPC_URL')
  const url = alchemyUrl(raw)
  const fetcher = dependencies.fetcher ?? fetch
  const rpcRead = async (params, ms) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1, ms))
    try {
      const response = await fetcher(url, {
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
      if (!response.ok) fail('provider_failure')
      if (Number(response.headers?.get('content-length') ?? 0) > MAX_RESPONSE_BYTES)
        fail('response_size_cap')
      const reader = response.body?.getReader()
      if (!reader) fail('response_invalid')
      const chunks = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel()
          fail('response_size_cap')
        }
        chunks.push(value)
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } finally {
      clearTimeout(timer)
    }
  }
  let completed
  const result = await probe({
    segment,
    rpcRead: dependencies.rpcRead ?? rpcRead,
    now: dependencies.now,
    onComplete: (value) => {
      completed = value
    },
  })
  if (!options.out) return result
  const receipt = {
    schemaVersion: 1,
    source: sourceIdentity(options, segment),
    capturedAt: (dependencies.captureNow?.() ?? new Date()).toISOString(),
    pages: result.pages,
    normalizedRows: completed.normalizedRows,
    result,
  }
  return sealReceipt(options.out, receipt, dependencies.stat ?? statfsSync)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(
        `${String(error.message).startsWith('alchemy_share_') ? error.message : 'alchemy_share_failure'}\n`,
      )
      process.exitCode = 1
    },
  )
}
