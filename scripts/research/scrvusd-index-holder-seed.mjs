// Prospective Blockscout first-page candidate sample for a fixed 1,000 crvUSD
// holder-exit pilot. A listing is discovery metadata, never pinned chain truth.
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi } from 'viem'
import { sourceIdentity } from './curve-prospective-quote.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'scrvusd-index-holder-seed-v1'
export const OUT = resolve('data/research/venue-signals/scrvusd-index-holder-seed')
export const PAGE_SIZE = 50
export const MIN_ASSETS_RAW = 1000n * 10n ** 18n
const MAX_AGE_MS = 30 * 60 * 1000
const MAX_CAPTURE_MS = 10 * 60 * 1000
const RESERVE_BYTES = 1_073_741_824
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const UINT = /^(0|[1-9][0-9]*)$/
const CODE = /^0x(?:[0-9a-f]{2})*$/
const ZERO = '0x0000000000000000000000000000000000000000'
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
])
const CAVEAT =
  'Blockscout first-page discovery sample, not a holder census, key control, withdrawal intent, or executable outcome. Listed order and values are untrusted offchain metadata; eligibility uses one finalized Ethereum block and one RPC host.'
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const seal = (value) => ({ ...value, sha256: sha(value) })
const unsigned = ({ sha256: _sha256, ...rest }) => rest
const lower = (value) => String(value ?? '').toLowerCase()
const ms = (value) => Date.parse(value)
const positiveClock = (value) => Number.isSafeInteger(value) && value > 0
const blockTag = (number) => `0x${number.toString(16)}`
const asUint = (value) => {
  const number = BigInt(value)
  if (number < 0n) throw new Error('Negative RPC uint')
  return number.toString()
}
const keysAre = (value, names) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...names].sort())

export function parseFirstPage(body) {
  if (
    !body ||
    !Array.isArray(body.items) ||
    body.items.length !== PAGE_SIZE ||
    !body.next_page_params ||
    typeof body.next_page_params !== 'object' ||
    Array.isArray(body.next_page_params) ||
    Object.keys(body.next_page_params).length === 0
  )
    throw new Error('Holder first page missing or truncated')
  const seen = new Set()
  let previous = null
  const rows = body.items.map((item, index) => {
    const address = lower(item?.address?.hash)
    if (!ADDRESS.test(address) || address === ZERO || seen.has(address))
      throw new Error('Malformed or duplicate holder')
    seen.add(address)
    if (typeof item?.value !== 'string' || !UINT.test(item.value))
      throw new Error('Malformed listed value')
    const listedValue = BigInt(item.value)
    if (previous !== null && listedValue > previous) throw new Error('Nonmonotonic first page')
    previous = listedValue
    return { listedRank: index + 1, address, listedSharesRaw: item.value }
  })
  return rows
}

function classify(rows) {
  if (!Array.isArray(rows) || rows.length !== PAGE_SIZE) throw new Error('Invalid result length')
  const missing = rows.some((row) => row.readError !== null)
  const eligible = rows.filter(
    (row) =>
      row.readError === null &&
      row.code === '0x' &&
      BigInt(row.balanceSharesRaw) > 0n &&
      BigInt(row.maxWithdrawAssetsRaw) >= MIN_ASSETS_RAW,
  )
  eligible.sort((a, b) => {
    const difference = BigInt(b.maxWithdrawAssetsRaw) - BigInt(a.maxWithdrawAssetsRaw)
    return difference > 0n ? 1 : difference < 0n ? -1 : a.address.localeCompare(b.address)
  })
  return {
    status: missing ? 'unavailable' : 'sampled',
    candidates: missing ? [] : eligible.map((row) => row.address),
  }
}

export function validateReceipt(receipt, { identity = sourceIdentity(), nowMs = Date.now() } = {}) {
  if (!receipt || receipt.sha256 !== sha(unsigned(receipt)))
    throw new Error('Index seed SHA mismatch')
  const source = receipt.source
  const anchor = receipt.anchor
  const page = receipt.page
  if (
    !keysAre(receipt, [
      'study',
      'kind',
      'source',
      'anchor',
      'page',
      'captureStartMs',
      'captureEndMs',
      'vaultCode',
      'vaultCodeHash',
      'asset',
      'results',
      'status',
      'candidates',
      'caveat',
      'sha256',
    ]) ||
    !keysAre(anchor, ['number', 'hash', 'timestamp']) ||
    !keysAre(page, [
      'url',
      'httpStatus',
      'fetchedAtMs',
      'nextPageParamsPresent',
      'rawItems',
      'rawNextPageParams',
      'rows',
    ]) ||
    receipt.study !== STUDY ||
    receipt.kind !== 'blockscout-first-page' ||
    receipt.caveat !== CAVEAT ||
    JSON.stringify(source) !== JSON.stringify(identity) ||
    !anchor ||
    !Number.isSafeInteger(anchor.number) ||
    anchor.number < 0 ||
    !HASH.test(anchor.hash) ||
    !Number.isSafeInteger(anchor.timestamp) ||
    !page ||
    page.url !== `https://eth.blockscout.com/api/v2/tokens/${identity.vault}/holders` ||
    page.httpStatus !== 200 ||
    page.nextPageParamsPresent !== true ||
    !page.rawNextPageParams ||
    typeof page.rawNextPageParams !== 'object' ||
    Array.isArray(page.rawNextPageParams) ||
    Object.keys(page.rawNextPageParams).length === 0 ||
    JSON.stringify(page.rawNextPageParams).length > 1_000_000 ||
    !positiveClock(page.fetchedAtMs) ||
    !positiveClock(receipt.captureStartMs) ||
    !positiveClock(receipt.captureEndMs) ||
    !positiveClock(nowMs) ||
    page.fetchedAtMs < receipt.captureStartMs ||
    receipt.captureEndMs < page.fetchedAtMs ||
    receipt.captureEndMs > nowMs ||
    receipt.captureEndMs - receipt.captureStartMs > MAX_CAPTURE_MS ||
    anchor.timestamp * 1000 > receipt.captureStartMs ||
    receipt.captureEndMs - anchor.timestamp * 1000 > MAX_AGE_MS ||
    !CODE.test(receipt.vaultCode) ||
    receipt.vaultCode === '0x' ||
    receipt.vaultCodeHash !== keccak256(receipt.vaultCode) ||
    receipt.asset !== identity.crvUsd ||
    !Array.isArray(page.rawItems) ||
    page.rawItems.length !== PAGE_SIZE ||
    JSON.stringify(page.rawItems).length > 1_000_000 ||
    !Array.isArray(page.rows) ||
    !Array.isArray(receipt.results) ||
    !Array.isArray(receipt.candidates)
  )
    throw new Error('Invalid index seed source, anchor, or clock')
  // The canonicalized list is preserved in page order. Its numeric values never
  // decide eligibility or ranking.
  const reconstructed = parseFirstPage({
    items: page.rawItems,
    next_page_params: page.rawNextPageParams,
  })
  if (JSON.stringify(reconstructed) !== JSON.stringify(page.rows))
    throw new Error('Listed page ordering mismatch')
  for (let i = 0; i < PAGE_SIZE; i++) {
    const row = receipt.results[i]
    if (
      !keysAre(row, [
        'listedRank',
        'address',
        'listedSharesRaw',
        'code',
        'codeHash',
        'balanceSharesRaw',
        'maxWithdrawAssetsRaw',
        'readError',
        'status',
      ]) ||
      !row ||
      row.address !== page.rows[i].address ||
      row.listedRank !== i + 1 ||
      row.listedSharesRaw !== page.rows[i].listedSharesRaw
    )
      throw new Error('Pinned result ordering mismatch')
    if (row.readError === 'rpc_unavailable') {
      if (
        row.code !== null ||
        row.codeHash !== null ||
        row.balanceSharesRaw !== null ||
        row.maxWithdrawAssetsRaw !== null ||
        row.status !== 'unavailable'
      )
        throw new Error('Invalid ambiguous read')
    } else {
      if (
        row.readError !== null ||
        !CODE.test(row.code) ||
        row.codeHash !== (row.code === '0x' ? null : keccak256(row.code)) ||
        !UINT.test(row.balanceSharesRaw) ||
        !UINT.test(row.maxWithdrawAssetsRaw)
      )
        throw new Error('Invalid pinned read')
      const expected =
        row.code !== '0x'
          ? 'contract'
          : BigInt(row.balanceSharesRaw) > 0n && BigInt(row.maxWithdrawAssetsRaw) >= MIN_ASSETS_RAW
            ? 'eligible'
            : 'dust_or_empty'
      if (row.status !== expected) throw new Error('Pinned status mismatch')
    }
  }
  const computed = classify(receipt.results)
  if (
    receipt.status !== computed.status ||
    JSON.stringify(receipt.candidates) !== JSON.stringify(computed.candidates)
  )
    throw new Error('Candidate ranking or availability mismatch')
  return receipt
}

export async function capture({
  client,
  fetchPage = defaultFetchPage,
  identity = sourceIdentity(),
  now = Date.now,
} = {}) {
  if (!client?.request) throw new Error('One RPC client is required')
  const captureStartMs = now()
  if (!positiveClock(captureStartMs)) throw new Error('Invalid capture clock')
  const url = `https://eth.blockscout.com/api/v2/tokens/${identity.vault}/holders`
  const response = await fetchPage(url)
  const fetchedAtMs = now()
  if (
    !positiveClock(fetchedAtMs) ||
    fetchedAtMs < captureStartMs ||
    response?.status !== 200 ||
    response.url !== url
  )
    throw new Error('Holder page unavailable or redirected')
  const rows = parseFirstPage(response.body)
  const request = (method, params) => client.request({ method, params })
  const chain = async () => Number(BigInt(await request('eth_chainId', [])))
  if ((await chain()) !== identity.chainId) throw new Error('Wrong chain')
  const finalized = await request('eth_getBlockByNumber', ['finalized', false])
  const number = Number(BigInt(finalized?.number))
  const hash = lower(finalized?.hash)
  const timestamp = Number(BigInt(finalized?.timestamp))
  if (
    !Number.isSafeInteger(number) ||
    number < 0 ||
    !HASH.test(hash) ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0
  )
    throw new Error('Invalid finalized anchor')
  const anchor = { number, hash, timestamp }
  if (fetchedAtMs < timestamp * 1000 || fetchedAtMs - timestamp * 1000 > MAX_AGE_MS)
    throw new Error('Stale or future finalized anchor')
  const canonical = async () => {
    const current = await request('eth_getBlockByNumber', [blockTag(number), false])
    if (Number(BigInt(current?.number)) !== number || lower(current?.hash) !== hash)
      throw new Error('Canonical anchor changed')
  }
  const pin = { blockHash: hash, requireCanonical: true }
  const call = async (name, args = []) =>
    decodeFunctionResult({
      abi: ABI,
      functionName: name,
      data: await request('eth_call', [
        { to: identity.vault, data: encodeFunctionData({ abi: ABI, functionName: name, args }) },
        pin,
      ]),
    })
  await canonical()
  const vaultCode = lower(await request('eth_getCode', [identity.vault, pin]))
  if (!CODE.test(vaultCode) || vaultCode === '0x') throw new Error('Vault code missing')
  const asset = lower(await call('asset'))
  if (asset !== identity.crvUsd) throw new Error('Vault asset changed')
  const results = []
  for (const row of rows) {
    try {
      const code = lower(await request('eth_getCode', [row.address, pin]))
      if (!CODE.test(code)) throw new Error('Invalid holder code')
      const balanceSharesRaw = asUint(await call('balanceOf', [row.address]))
      const maxWithdrawAssetsRaw = asUint(await call('maxWithdraw', [row.address]))
      const status =
        code !== '0x'
          ? 'contract'
          : BigInt(balanceSharesRaw) > 0n && BigInt(maxWithdrawAssetsRaw) >= MIN_ASSETS_RAW
            ? 'eligible'
            : 'dust_or_empty'
      results.push({
        ...row,
        code,
        codeHash: code === '0x' ? null : keccak256(code),
        balanceSharesRaw,
        maxWithdrawAssetsRaw,
        readError: null,
        status,
      })
    } catch {
      results.push({
        ...row,
        code: null,
        codeHash: null,
        balanceSharesRaw: null,
        maxWithdrawAssetsRaw: null,
        readError: 'rpc_unavailable',
        status: 'unavailable',
      })
    }
  }
  if ((await chain()) !== identity.chainId) throw new Error('Chain changed')
  const finalizedAgain = await request('eth_getBlockByNumber', ['finalized', false])
  if (Number(BigInt(finalizedAgain?.number)) < number)
    throw new Error('Finality regressed during sample')
  await canonical()
  if (lower(await call('asset')) !== asset) throw new Error('Vault asset changed')
  if (lower(await request('eth_getCode', [identity.vault, pin])) !== vaultCode)
    throw new Error('Vault code changed')
  const captureEndMs = now()
  const { status, candidates } = classify(results)
  return validateReceipt(
    seal({
      study: STUDY,
      kind: 'blockscout-first-page',
      source: identity,
      anchor,
      page: {
        url,
        httpStatus: 200,
        fetchedAtMs,
        nextPageParamsPresent: true,
        rawItems: response.body.items,
        rawNextPageParams: response.body.next_page_params,
        rows,
      },
      captureStartMs,
      captureEndMs,
      vaultCode,
      vaultCodeHash: keccak256(vaultCode),
      asset,
      results,
      status,
      candidates,
      caveat: CAVEAT,
    }),
    { identity, nowMs: captureEndMs },
  )
}

async function defaultFetchPage(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
    headers: { accept: 'application/json' },
  })
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > 1_000_000) throw new Error('Oversize page')
  const body = await response.text()
  if (body.length > 1_000_000) throw new Error('Oversize page')
  return { status: response.status, url: response.url, body: JSON.parse(body) }
}

function guard(path, stat = statfsSync, extra = 0) {
  let ancestor = path
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new Error('No output ancestor')
    ancestor = parent
  }
  const fs = stat(ancestor)
  if (Number(fs.bavail) * Number(fs.bsize) - extra < RESERVE_BYTES)
    throw new Error('Index seed disk reserve reached')
}

export function save({ receipt, out = OUT, identity = sourceIdentity(), stat = statfsSync } = {}) {
  validateReceipt(receipt, { identity })
  const file = join(
    out,
    `${String(receipt.anchor.number).padStart(12, '0')}-${receipt.anchor.hash.slice(2)}-${receipt.captureEndMs}.json`,
  )
  if (existsSync(file)) throw new Error('Refusing to overwrite index seed')
  const bytes = `${JSON.stringify(receipt)}\n`
  guard(out, stat, Buffer.byteLength(bytes))
  mkdirSync(out, { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temporary, file)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
  return file
}

export function verify({ out = OUT, identity = sourceIdentity(), nowMs = Date.now() } = {}) {
  if (!existsSync(out)) return { count: 0, latestBlock: null }
  const names = readdirSync(out)
    .filter((name) => name.endsWith('.json'))
    .sort()
  let latestBlock = null
  for (const name of names) {
    const receipt = JSON.parse(readFileSync(join(out, name), 'utf8'))
    validateReceipt(receipt, { identity, nowMs })
    if (
      name !==
      `${String(receipt.anchor.number).padStart(12, '0')}-${receipt.anchor.hash.slice(2)}-${receipt.captureEndMs}.json`
    )
      throw new Error('Index seed filename mismatch')
    latestBlock = receipt.anchor.number
  }
  return { count: names.length, latestBlock }
}

export function selectConfiguredRpc(configured, index) {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid RPC index')
  const urls = String(configured ?? '')
    .split(',')
    .map((url) => url.trim())
  if (index >= urls.length || !urls[index]) throw new Error('Configured RPC index unavailable')
  const selected = urls[index]
  const parsed = new URL(selected)
  if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname)
    throw new Error('Invalid selected RPC URL')
  return selected
}

export function parseCli(args) {
  if (args.length === 0 || (args[0] === '--verify' && args.length === 1))
    return { mode: '--verify', rpcIndex: 0 }
  if (
    args[0] === '--run' &&
    args.length === 3 &&
    args[1] === '--rpc-index' &&
    /^(0|[1-9][0-9]*)$/.test(args[2]) &&
    Number.isSafeInteger(Number(args[2]))
  )
    return { mode: '--run', rpcIndex: Number(args[2]) }
  throw new Error('Invalid index seed CLI arguments')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { mode, rpcIndex } = parseCli(process.argv.slice(2))
    if (mode === '--verify') console.log(JSON.stringify(verify()))
    else {
      verify()
      const configured = process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL') || ''
      const receipt = await capture({
        client: makeClient(selectConfiguredRpc(configured, rpcIndex)),
      })
      console.log(
        JSON.stringify({
          file: save({ receipt }),
          status: receipt.status,
          candidateCount: receipt.candidates.length,
          anchorBlock: receipt.anchor.number,
        }),
      )
    }
  } catch {
    // Never print raw RPC or HTTP errors: they may include credential-bearing URLs.
    console.error('[scrvusd-index-holder-seed] unavailable')
    process.exitCode = 1
  }
}
