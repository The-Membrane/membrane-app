// Prospective first-page scrvUSD candidate cohort. No withdrawal outcomes here.
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi } from 'viem'
import {
  OUT as QUOTE_OUT,
  readValidatedCheckpoints,
  sourceIdentity,
} from './curve-prospective-quote.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'scrvusd-cohort-seed-v1'
export const OUT = resolve('data/research/venue-signals/scrvusd-cohort-seed')
export const PAGE_SIZE = 50
export const SIZES = Object.freeze(
  [1000n, 10000n, 100000n, 500000n].map((q) => (q * 10n ** 18n).toString()),
)
const MAX_AGE_MS = 30 * 60 * 1000
const MAX_CAPTURE_MS = 10 * 60 * 1000
const RESERVE_BYTES = 1_073_741_824
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const SHA = /^[0-9a-f]{64}$/
const UINT = /^(0|[1-9][0-9]*)$/
const CODE = /^0x(?:[0-9a-f]{2})*$/
const ZERO = '0x0000000000000000000000000000000000000000'
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
])
const CAVEAT =
  'One Blockscout first-page convenience sample. Listing is discovery metadata only; one RPC host attests pinned reads. No holder census, key-control proof, executable exit, independent validation, or population probability.'
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const unsigned = ({ sha256: _sha256, ...body }) => body
const lower = (v) => String(v ?? '').toLowerCase()
const blockTag = (n) => `0x${n.toString(16)}`
const uint = (v) => {
  const n = BigInt(v)
  if (n < 0n) throw new Error('Negative uint')
  return n.toString()
}
const keysAre = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...keys].sort())
const checkpointRef = (row) => ({
  filename: row.filename,
  logicalSha256: row.checkpoint.sha256,
  physicalSha256: row.physicalSha256,
  block: row.checkpoint.block,
})
export const seedName = (seed) =>
  `${String(seed.anchor.number).padStart(12, '0')}-${seed.anchor.hash.slice(2)}-${seed.captureEndMs}.json`

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
    throw new Error('Incomplete holder first page')
  const seen = new Set()
  let previous = null
  return body.items.map((item, i) => {
    const address = lower(item?.address?.hash)
    if (
      !ADDRESS.test(address) ||
      address === ZERO ||
      seen.has(address) ||
      typeof item?.value !== 'string' ||
      !UINT.test(item.value)
    )
      throw new Error('Malformed holder listing')
    const listed = BigInt(item.value)
    if (previous !== null && listed > previous) throw new Error('Nonmonotonic first page')
    seen.add(address)
    previous = listed
    return { listedRank: i + 1, address, listedSharesRaw: item.value }
  })
}

export function eligibleBySize(results) {
  if (!Array.isArray(results) || results.length !== PAGE_SIZE)
    throw new Error('Invalid candidate count')
  if (results.some((r) => r.readError !== null))
    return { status: 'unavailable', eligible: Object.fromEntries(SIZES.map((q) => [q, []])) }
  const eligible = Object.fromEntries(SIZES.map((q) => [q, []]))
  for (const row of results)
    for (const q of SIZES) {
      if (
        row.code === '0x' &&
        BigInt(row.balanceSharesRaw) > 0n &&
        BigInt(row.maxWithdrawAssetsRaw) >= BigInt(q) &&
        BigInt(row.previewSharesRaw[q]) > 0n &&
        BigInt(row.previewSharesRaw[q]) <= BigInt(row.balanceSharesRaw)
      )
        eligible[q].push(row.address)
    }
  for (const q of SIZES)
    eligible[q].sort((a, b) => {
      const ra = results.find((r) => r.address === a),
        rb = results.find((r) => r.address === b)
      const diff = BigInt(rb.maxWithdrawAssetsRaw) - BigInt(ra.maxWithdrawAssetsRaw)
      return diff > 0n ? 1 : diff < 0n ? -1 : a.localeCompare(b)
    })
  return { status: SIZES.some((q) => eligible[q].length) ? 'sampled' : 'no_eligible', eligible }
}

export function validateReceipt(
  receipt,
  {
    identity = sourceIdentity(),
    checkpoints = readValidatedCheckpoints({ identity }),
    nowMs = Date.now(),
  } = {},
) {
  if (
    !receipt ||
    receipt.sha256 !== sha(JSON.stringify(unsigned(receipt))) ||
    !keysAre(receipt, [
      'study',
      'kind',
      'source',
      'checkpoint',
      'anchor',
      'page',
      'captureStartMs',
      'captureEndMs',
      'vaultCodeHash',
      'asset',
      'sizesRaw',
      'vaultPreviewSharesRaw',
      'results',
      'status',
      'eligible',
      'caveat',
      'sha256',
    ])
  )
    throw new Error('Cohort seed seal or schema mismatch')
  const { anchor, page } = receipt
  const ref = checkpoints.find(
    (r) => JSON.stringify(checkpointRef(r)) === JSON.stringify(receipt.checkpoint),
  )
  if (
    receipt.study !== STUDY ||
    receipt.kind !== 'blockscout-first-page' ||
    receipt.caveat !== CAVEAT ||
    JSON.stringify(receipt.source) !== JSON.stringify(identity) ||
    !ref ||
    JSON.stringify(anchor) !== JSON.stringify(ref.checkpoint.block) ||
    JSON.stringify(receipt.sizesRaw) !== JSON.stringify(SIZES) ||
    !keysAre(receipt.vaultPreviewSharesRaw, SIZES) ||
    SIZES.some((q) => !UINT.test(receipt.vaultPreviewSharesRaw[q])) ||
    receipt.asset !== identity.crvUsd ||
    !HASH.test(receipt.vaultCodeHash) ||
    !Number.isSafeInteger(anchor.number) ||
    !HASH.test(anchor.hash) ||
    !Number.isSafeInteger(anchor.timestamp) ||
    !Number.isSafeInteger(nowMs) ||
    !Number.isSafeInteger(receipt.captureStartMs) ||
    !Number.isSafeInteger(receipt.captureEndMs) ||
    receipt.captureStartMs <= 0 ||
    receipt.captureEndMs < receipt.captureStartMs ||
    receipt.captureEndMs > nowMs ||
    receipt.captureEndMs - receipt.captureStartMs > MAX_CAPTURE_MS ||
    anchor.timestamp * 1000 > receipt.captureStartMs ||
    receipt.captureEndMs - anchor.timestamp * 1000 > MAX_AGE_MS ||
    Date.parse(ref.checkpoint.captureEndUtc) > receipt.captureStartMs
  )
    throw new Error('Cohort source or clock mismatch')
  if (
    !keysAre(page, [
      'url',
      'httpStatus',
      'fetchedAtMs',
      'rawBody',
      'rawBodySha256',
      'rawItems',
      'rawNextPageParams',
      'rows',
    ]) ||
    page.url !== `https://eth.blockscout.com/api/v2/tokens/${identity.vault}/holders` ||
    page.httpStatus !== 200 ||
    !Number.isSafeInteger(page.fetchedAtMs) ||
    page.fetchedAtMs < receipt.captureStartMs ||
    page.fetchedAtMs > receipt.captureEndMs ||
    typeof page.rawBody !== 'string' ||
    Buffer.byteLength(page.rawBody) > 1_000_000 ||
    page.rawBodySha256 !== sha(page.rawBody) ||
    !Array.isArray(page.rawItems) ||
    !Array.isArray(page.rows) ||
    !Array.isArray(receipt.results)
  )
    throw new Error('Cohort page mismatch')
  const parsed = JSON.parse(page.rawBody)
  if (
    JSON.stringify(parsed.items) !== JSON.stringify(page.rawItems) ||
    JSON.stringify(parsed.next_page_params) !== JSON.stringify(page.rawNextPageParams) ||
    JSON.stringify(parseFirstPage(parsed)) !== JSON.stringify(page.rows)
  )
    throw new Error('Raw first page mismatch')
  if (receipt.results.length !== PAGE_SIZE) throw new Error('Incomplete pinned reads')
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
        'previewSharesRaw',
        'readError',
      ]) ||
      row.listedRank !== i + 1 ||
      row.address !== page.rows[i].address ||
      row.listedSharesRaw !== page.rows[i].listedSharesRaw
    )
      throw new Error('Candidate ordering mismatch')
    if (row.readError === 'rpc_unavailable') {
      if (
        row.code !== null ||
        row.codeHash !== null ||
        row.balanceSharesRaw !== null ||
        row.maxWithdrawAssetsRaw !== null ||
        row.previewSharesRaw !== null
      )
        throw new Error('Ambiguous read shape mismatch')
    } else if (
      row.readError !== null ||
      !CODE.test(row.code) ||
      row.codeHash !== (row.code === '0x' ? null : keccak256(row.code)) ||
      !UINT.test(row.balanceSharesRaw) ||
      !UINT.test(row.maxWithdrawAssetsRaw) ||
      !keysAre(row.previewSharesRaw, SIZES) ||
      SIZES.some((q) => !UINT.test(row.previewSharesRaw[q])) ||
      JSON.stringify(row.previewSharesRaw) !== JSON.stringify(receipt.vaultPreviewSharesRaw)
    )
      throw new Error('Pinned read shape mismatch')
  }
  const computed = eligibleBySize(receipt.results)
  if (
    receipt.status !== computed.status ||
    JSON.stringify(receipt.eligible) !== JSON.stringify(computed.eligible)
  )
    throw new Error('Cohort eligibility mismatch')
  return receipt
}

export async function capture({
  client,
  fetchPage = defaultFetchPage,
  identity = sourceIdentity(),
  quoteOut = QUOTE_OUT,
  now = Date.now,
} = {}) {
  if (!client?.request) throw new Error('One RPC client required')
  const checkpoints = readValidatedCheckpoints({ out: quoteOut, identity }),
    latest = checkpoints.at(-1)
  if (!latest) throw new Error('Verified quote checkpoint required')
  const checkpoint = checkpointRef(latest),
    anchor = checkpoint.block,
    start = now()
  if (
    !Number.isSafeInteger(start) ||
    Date.parse(latest.checkpoint.captureEndUtc) > start ||
    anchor.timestamp * 1000 > start ||
    start - anchor.timestamp * 1000 > MAX_AGE_MS
  )
    throw new Error('Stale or future source')
  const url = `https://eth.blockscout.com/api/v2/tokens/${identity.vault}/holders`,
    response = await fetchPage(url),
    fetched = now()
  if (
    response?.status !== 200 ||
    response.url !== url ||
    typeof response.rawBody !== 'string' ||
    fetched < start
  )
    throw new Error('Holder first page unavailable')
  const parsed = JSON.parse(response.rawBody)
  if (JSON.stringify(parsed) !== JSON.stringify(response.body))
    throw new Error('Parsed page differs')
  const rows = parseFirstPage(parsed)
  const request = (method, params) => client.request({ method, params })
  const chain = async () => Number(BigInt(await request('eth_chainId', [])))
  const canonical = async () => {
    const b = await request('eth_getBlockByNumber', [blockTag(anchor.number), false])
    if (Number(BigInt(b?.number)) !== anchor.number || lower(b?.hash) !== anchor.hash)
      throw new Error('Anchor reorg')
  }
  if ((await chain()) !== identity.chainId) throw new Error('Wrong chain')
  await canonical()
  const pin = { blockHash: anchor.hash, requireCanonical: true }
  const call = async (name, args = []) =>
    decodeFunctionResult({
      abi: ABI,
      functionName: name,
      data: await request('eth_call', [
        { to: identity.vault, data: encodeFunctionData({ abi: ABI, functionName: name, args }) },
        pin,
      ]),
    })
  const vaultCode = lower(await request('eth_getCode', [identity.vault, pin]))
  if (!CODE.test(vaultCode) || vaultCode === '0x') throw new Error('Vault code unavailable')
  const asset = lower(await call('asset'))
  if (asset !== identity.crvUsd) throw new Error('Vault asset changed')
  const previews = {}
  for (const q of SIZES) previews[q] = uint(await call('previewWithdraw', [BigInt(q)]))
  const results = []
  for (const row of rows) {
    try {
      const code = lower(await request('eth_getCode', [row.address, pin]))
      if (!CODE.test(code)) throw new Error('Invalid holder code')
      const balanceSharesRaw = uint(await call('balanceOf', [row.address]))
      const maxWithdrawAssetsRaw = uint(await call('maxWithdraw', [row.address]))
      results.push({
        ...row,
        code,
        codeHash: code === '0x' ? null : keccak256(code),
        balanceSharesRaw,
        maxWithdrawAssetsRaw,
        previewSharesRaw: { ...previews },
        readError: null,
      })
    } catch {
      results.push({
        ...row,
        code: null,
        codeHash: null,
        balanceSharesRaw: null,
        maxWithdrawAssetsRaw: null,
        previewSharesRaw: null,
        readError: 'rpc_unavailable',
      })
    }
  }
  if ((await chain()) !== identity.chainId) throw new Error('Chain changed')
  const finalized = await request('eth_getBlockByNumber', ['finalized', false])
  if (Number(BigInt(finalized?.number)) < anchor.number) throw new Error('Finality regressed')
  await canonical()
  if (
    lower(await call('asset')) !== asset ||
    lower(await request('eth_getCode', [identity.vault, pin])) !== vaultCode
  )
    throw new Error('Vault changed')
  const end = now(),
    classified = eligibleBySize(results)
  return validateReceipt(
    seal({
      study: STUDY,
      kind: 'blockscout-first-page',
      source: identity,
      checkpoint,
      anchor,
      page: {
        url,
        httpStatus: 200,
        fetchedAtMs: fetched,
        rawBody: response.rawBody,
        rawBodySha256: sha(response.rawBody),
        rawItems: parsed.items,
        rawNextPageParams: parsed.next_page_params,
        rows,
      },
      captureStartMs: start,
      captureEndMs: end,
      vaultCodeHash: keccak256(vaultCode),
      asset,
      sizesRaw: [...SIZES],
      vaultPreviewSharesRaw: previews,
      results,
      status: classified.status,
      eligible: classified.eligible,
      caveat: CAVEAT,
    }),
    { identity, checkpoints, nowMs: end },
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
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > 1_000_000) throw new Error('Oversize page')
  const rawBody = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (!Buffer.from(rawBody, 'utf8').equals(bytes)) throw new Error('Non-preservable page')
  return { status: response.status, url: response.url, rawBody, body: JSON.parse(rawBody) }
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
    throw new Error('Cohort seed disk reserve')
}
export function save({
  receipt,
  out = OUT,
  identity = sourceIdentity(),
  checkpoints = readValidatedCheckpoints({ identity }),
  stat = statfsSync,
  nowMs = Date.now(),
} = {}) {
  validateReceipt(receipt, { identity, checkpoints, nowMs })
  const file = join(out, seedName(receipt)),
    bytes = `${JSON.stringify(receipt)}\n`
  guard(out, stat, Buffer.byteLength(bytes))
  mkdirSync(out, { recursive: true })
  if (readdirSync(out).some((name) => name.endsWith('.json')))
    throw new Error('Seed already exists')
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(tmp, file)
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp)
  }
  return file
}
async function collectionLock(out, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000)
    throw new Error('Invalid lock timeout')
  guard(out)
  mkdirSync(out, { recursive: true })
  const path = join(out, '.collection.lock'),
    deadline = Date.now() + timeoutMs
  while (true) {
    try {
      mkdirSync(path)
      return () => rmdirSync(path)
    } catch (e) {
      if (e?.code !== 'EEXIST' || Date.now() >= deadline) throw new Error('Seed collection locked')
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}
export async function collectSeed({
  out = OUT,
  client,
  fetchPage = defaultFetchPage,
  identity = sourceIdentity(),
  quoteOut = QUOTE_OUT,
  now = Date.now,
  stat = statfsSync,
  lockTimeoutMs = 30_000,
} = {}) {
  const release = await collectionLock(out, lockTimeoutMs)
  try {
    const checkpoints = readValidatedCheckpoints({ out: quoteOut, identity }),
      prior = verify({ out, identity, checkpoints })
    if (prior.count === 1) return { status: 'unchanged', anchorBlock: prior.latestBlock }
    const receipt = await capture({ client, fetchPage, identity, quoteOut, now })
    const file = save({ receipt, out, identity, checkpoints, stat })
    return { status: 'saved', file, anchorBlock: receipt.anchor.number, seedStatus: receipt.status }
  } finally {
    release()
  }
}
export function verify({
  out = OUT,
  identity = sourceIdentity(),
  checkpoints = readValidatedCheckpoints({ identity }),
  nowMs = Date.now(),
} = {}) {
  if (!existsSync(out)) return { count: 0, latestBlock: null }
  const names = readdirSync(out)
    .filter((n) => n.endsWith('.json'))
    .sort()
  if (names.length > 1) throw new Error('Multiple cohort seeds')
  for (const name of names) {
    const bytes = readFileSync(join(out, name)),
      receipt = validateReceipt(JSON.parse(bytes), { identity, checkpoints, nowMs })
    if (name !== seedName(receipt) || !bytes.equals(Buffer.from(`${JSON.stringify(receipt)}\n`)))
      throw new Error('Seed physical mismatch')
    return { count: 1, latestBlock: receipt.anchor.number, status: receipt.status }
  }
  return { count: 0, latestBlock: null }
}
export function parseCli(args) {
  if (!args.length || (args.length === 1 && args[0] === '--verify'))
    return { mode: '--verify', rpcIndex: 0 }
  if (
    args.length === 3 &&
    args[0] === '--run' &&
    args[1] === '--rpc-index' &&
    /^(0|[1-9][0-9]*)$/.test(args[2]) &&
    Number.isSafeInteger(Number(args[2]))
  )
    return { mode: '--run', rpcIndex: Number(args[2]) }
  throw new Error('Invalid cohort seed CLI')
}
export function selectConfiguredRpc(configured, index) {
  const urls = String(configured ?? '')
    .split(',')
    .map((s) => s.trim())
  if (!Number.isSafeInteger(index) || index < 0 || index >= urls.length || !urls[index])
    throw new Error('RPC index unavailable')
  const url = new URL(urls[index])
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname)
    throw new Error('Invalid RPC URL')
  return urls[index]
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { mode, rpcIndex } = parseCli(process.argv.slice(2))
    if (mode === '--verify') console.log(JSON.stringify(verify()))
    else {
      const configured = process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL') || ''
      console.log(
        JSON.stringify(
          await collectSeed({ client: makeClient(selectConfiguredRpc(configured, rpcIndex)) }),
        ),
      )
    }
  } catch {
    console.error('[scrvusd-cohort-seed] unavailable')
    process.exitCode = 1
  }
}
