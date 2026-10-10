// Prospective, current-page holder-exposure snapshot. The Blockscout list is
// only a candidate seed: every balance and code classification is reread at
// one finalized Ethereum block. This is not a holder census or intent signal.
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { keccak256 } from 'viem'
import { ABI, MARKETS, POOL, diskGuard } from './aave-core-forward-panel.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'aave-core-holder-exposure-v1'
export const OUTPUT_ROOT = resolve('data/research/venue-signals')
export const PAGE_SIZE = 50
export const MAX_FINALIZED_AGE_MS = 30 * 60 * 1000
export const MAX_CAPTURE_DURATION_MS = 10 * 60 * 1000
const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const ZERO = '0x0000000000000000000000000000000000000000'
const address = (x) => String(x || '').toLowerCase()
const validAddress = (x) => /^0x[0-9a-fA-F]{40}$/.test(String(x)) && address(x) !== ZERO
const validHash = (x) => /^0x[0-9a-fA-F]{64}$/.test(String(x))
const sha = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex')
const uint = (x, label) => {
  if (typeof x !== 'string' || !/^\d+$/.test(x)) throw new Error(`Invalid ${label}`)
  return BigInt(x)
}
const raw = (x, label) => {
  let n
  try {
    n = BigInt(x)
  } catch {
    throw new Error(`Invalid ${label}`)
  }
  if (n < 0n) throw new Error(`Negative ${label}`)
  return n
}
const codeHash = (code, label) => {
  if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code))
    throw new Error(`Missing deployed ${label} code`)
  return keccak256(code)
}
async function implementationAt(rpc, contract, blockHash, label) {
  const pinned = { blockHash, requireCanonical: true }
  const word = await rpc('request', {
    method: 'eth_getStorageAt',
    params: [contract, EIP1967_IMPLEMENTATION_SLOT, pinned],
  })
  if (typeof word !== 'string' || !/^0x0{24}[0-9a-fA-F]{40}$/.test(word))
    throw new Error(`${label} invalid implementation slot`)
  const implementation = `0x${word.slice(26)}`.toLowerCase()
  if (!validAddress(implementation)) throw new Error(`${label} zero implementation`)
  return {
    address: implementation,
    codeHash: codeHash(
      await rpc('request', { method: 'eth_getCode', params: [implementation, pinned] }),
      `${label} implementation`,
    ),
  }
}
const ratio = (numerator, denominator) =>
  denominator === 0n ? null : ((numerator * 1_000_000n) / denominator).toString()

export function outputPath(path) {
  if (!path) throw new Error('Explicit --out is required for --run')
  const out = resolve(path)
  if (!out.startsWith(`${OUTPUT_ROOT}/`) || !out.endsWith('.json'))
    throw new Error('Output must be a JSON file under data/research/venue-signals')
  return out
}

export function parseFirstPage(body) {
  if (
    !body ||
    !Array.isArray(body.items) ||
    body.items.length !== PAGE_SIZE ||
    !body.next_page_params ||
    typeof body.next_page_params !== 'object'
  )
    throw new Error('Holder first page missing or truncated')
  const seen = new Set()
  let previous = null
  return body.items.map((item, index) => {
    const holder = address(item?.address?.hash)
    if (!validAddress(holder) || seen.has(holder)) throw new Error('Malformed or duplicate holder')
    seen.add(holder)
    const listedRaw = uint(item?.value, 'listed value')
    if (previous !== null && listedRaw > previous) throw new Error('Nonmonotonic holder page')
    previous = listedRaw
    return { listedRank: index + 1, address: holder, listedRaw: listedRaw.toString() }
  })
}

export async function collect({ client, fetchPage, out, checkDisk = diskGuard, now = Date.now }) {
  const target = outputPath(out)
  if (existsSync(target)) throw new Error('Refusing to overwrite an existing exposure snapshot')
  const guard = () => checkDisk(target)
  const rpc = async (method, args = {}) => {
    guard()
    return client[method](args)
  }
  const chainId = Number(await rpc('getChainId'))
  if (chainId !== 1) throw new Error('Ethereum mainnet required')
  const lists = []
  let priorFetchedAtMs = 0
  for (const market of MARKETS) {
    const url = `https://eth.blockscout.com/api/v2/tokens/${market.aToken}/holders`
    guard()
    const response = await fetchPage(url)
    const fetchedAtMs = now()
    if (!Number.isSafeInteger(fetchedAtMs) || fetchedAtMs <= 0 || fetchedAtMs < priorFetchedAtMs)
      throw new Error('Invalid local holder-page clock')
    priorFetchedAtMs = fetchedAtMs
    if (response?.status !== 200 || response.url !== url || !response.body)
      throw new Error(`${market.name} holder page unavailable or redirected`)
    lists.push({
      name: market.name,
      url,
      httpStatus: response.status,
      fetchedAtMs,
      candidates: parseFirstPage(response.body),
      nextPageParamsPresent: true,
    })
  }
  const finalized = await rpc('getBlock', { blockTag: 'finalized' })
  const blockNumber = raw(finalized?.number, 'finalized block number')
  if (blockNumber > BigInt(Number.MAX_SAFE_INTEGER) || !validHash(finalized?.hash))
    throw new Error('Invalid finalized block')
  const block = Number(blockNumber)
  const blockTimestamp = Number(raw(finalized?.timestamp, 'block timestamp'))
  if (!Number.isSafeInteger(blockTimestamp)) throw new Error('Invalid block timestamp')
  const poolCodeHash = codeHash(await rpc('getCode', { address: POOL, blockNumber }), 'Pool')
  const poolImplementation = await implementationAt(rpc, POOL, finalized.hash, 'Pool')
  const markets = []
  for (const [i, market] of MARKETS.entries()) {
    const aTokenCodeHash = codeHash(
      await rpc('getCode', { address: market.aToken, blockNumber }),
      `${market.name} aToken`,
    )
    const aTokenImplementation = await implementationAt(
      rpc,
      market.aToken,
      finalized.hash,
      `${market.name} aToken`,
    )
    const underlyingCodeHash = codeHash(
      await rpc('getCode', { address: market.base, blockNumber }),
      `${market.name} underlying`,
    )
    const reserve = await rpc('readContract', {
      address: POOL,
      abi: ABI.reserve,
      functionName: 'getReserveData',
      args: [market.base],
      blockNumber,
    })
    if (address(reserve?.aTokenAddress) !== address(market.aToken))
      throw new Error(`${market.name} reserve aToken mismatch`)
    const configuredDecimals = Number(
      (raw(reserve?.configuration?.data, 'reserve config') >> 48n) & 255n,
    )
    const tokenDecimals = Number(
      await rpc('readContract', {
        address: market.base,
        abi: ABI.token,
        functionName: 'decimals',
        blockNumber,
      }),
    )
    const aTokenDecimals = Number(
      await rpc('readContract', {
        address: market.aToken,
        abi: ABI.token,
        functionName: 'decimals',
        blockNumber,
      }),
    )
    if ([configuredDecimals, tokenDecimals, aTokenDecimals].some((n) => n !== market.decimals))
      throw new Error(`${market.name} decimals mismatch`)
    const cashRaw = raw(
      await rpc('readContract', {
        address: market.base,
        abi: ABI.token,
        functionName: 'balanceOf',
        args: [market.aToken],
        blockNumber,
      }),
      'cash',
    )
    const supplyRaw = raw(
      await rpc('readContract', {
        address: market.aToken,
        abi: ABI.token,
        functionName: 'totalSupply',
        blockNumber,
      }),
      'supply',
    )
    if (cashRaw === 0n || supplyRaw === 0n) throw new Error(`${market.name} zero denominator`)
    const holders = []
    for (const candidate of lists[i].candidates) {
      const balanceRaw = raw(
        await rpc('readContract', {
          address: market.aToken,
          abi: ABI.token,
          functionName: 'balanceOf',
          args: [candidate.address],
          blockNumber,
        }),
        'holder balance',
      )
      // viem getCode maps raw 0x (no deployed code) to undefined. Use the exact raw,
      // block-hash-pinned response to distinguish empty code from missing data.
      const code = await rpc('request', {
        method: 'eth_getCode',
        params: [candidate.address, { blockHash: finalized.hash, requireCanonical: true }],
      })
      if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(code))
        throw new Error('Missing holder code')
      holders.push({
        ...candidate,
        balanceRaw: balanceRaw.toString(),
        codeKind: code === '0x' ? 'no-code' : 'contract',
        codeHash: code === '0x' ? null : keccak256(code),
        claimOverCashPpm: ratio(balanceRaw, cashRaw),
      })
    }
    holders.sort((a, b) => {
      const x = BigInt(a.balanceRaw),
        y = BigInt(b.balanceRaw)
      return x === y ? a.address.localeCompare(b.address) : x > y ? -1 : 1
    })
    holders.forEach((holder, j) => {
      holder.pinnedRankWithinSample = j + 1
    })
    const largest = BigInt(holders[0].balanceRaw)
    const shock50m = 50_000_000n * 10n ** BigInt(market.decimals)
    const shock1m = 1_000_000n * 10n ** BigInt(market.decimals)
    markets.push({
      name: market.name,
      base: market.base,
      aToken: market.aToken,
      decimals: market.decimals,
      aTokenCodeHash,
      aTokenImplementation: aTokenImplementation.address,
      aTokenImplementationCodeHash: aTokenImplementation.codeHash,
      underlyingCodeHash,
      cashRaw: cashRaw.toString(),
      supplyRaw: supplyRaw.toString(),
      largestSampledClaimRaw: largest.toString(),
      largestSampledClaimOverCashPpm: ratio(largest, cashRaw),
      hypotheticalCashShocks: [shock1m, shock50m].map((amount) => ({
        amountRaw: amount.toString(),
        amountOverCashPpm: ratio(amount, cashRaw),
        cashWouldCover: cashRaw >= amount,
        largestSampledClaimCovers: largest >= amount,
      })),
      holders,
      holderPage: lists[i],
    })
  }
  const recheck = await rpc('getBlock', { blockNumber })
  if (recheck?.hash !== finalized.hash)
    throw new Error('Finalized block reorg or provider mismatch')
  const capturedAtMs = now()
  const blockTimestampMs = blockTimestamp * 1000
  if (
    !Number.isSafeInteger(capturedAtMs) ||
    capturedAtMs <= 0 ||
    !Number.isSafeInteger(blockTimestampMs) ||
    capturedAtMs < blockTimestampMs ||
    capturedAtMs - blockTimestampMs > MAX_FINALIZED_AGE_MS ||
    capturedAtMs < priorFetchedAtMs ||
    capturedAtMs - lists[0].fetchedAtMs > MAX_CAPTURE_DURATION_MS
  )
    throw new Error('Invalid local capture clock')
  const payload = {
    study: STUDY,
    chainId,
    pool: POOL,
    poolCodeHash,
    poolImplementation: poolImplementation.address,
    poolImplementationCodeHash: poolImplementation.codeHash,
    block,
    blockHash: finalized.hash,
    blockTimestamp,
    capturedAtMs,
    firstKnownAtMs: capturedAtMs,
    markets,
    caveat:
      'Current Blockscout first-page candidate sample, pinned finalized balances and Pool/aToken proxy implementations. No-code means no deployed code at the anchor, not proven EOA or economic owner. Not full source equivalence, a population top-holder census, withdrawal intent, executable outcome, or validated alert. List may postdate the finalized block; first known is local capture time. Cash shocks and sampled claims are separate arithmetic bounds, not proof a sampled holder could execute a withdrawal; 2x is exploratory, not a threshold.',
  }
  return { payload, sha256: sha(payload) }
}

export function saveSnapshot(out, snapshot, checkDisk = diskGuard) {
  const target = outputPath(out)
  checkDisk(target)
  if (existsSync(target)) throw new Error('Refusing to overwrite exposure snapshot')
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  let fd
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(snapshot))
    closeSync(fd)
    fd = undefined
    checkDisk(target)
    if (existsSync(target)) throw new Error('Refusing to overwrite exposure snapshot')
    renameSync(temp, target)
    const saved = JSON.parse(readFileSync(target, 'utf8'))
    if (!saved.payload || saved.sha256 !== sha(saved.payload)) throw new Error('Saved SHA mismatch')
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temp)) unlinkSync(temp)
    throw error
  }
}

export function plan(out) {
  return {
    status: 'dry-only',
    study: STUDY,
    output: out ? outputPath(out) : null,
    action:
      'Pass --run --out data/research/venue-signals/<unique>.json for a bounded live snapshot.',
  }
}

export async function run({
  out,
  client,
  fetchPage = defaultFetchPage,
  checkDisk = diskGuard,
  now = Date.now,
}) {
  const snapshot = await collect({ client, fetchPage, out, checkDisk, now })
  saveSnapshot(out, snapshot, checkDisk)
  return {
    status: 'saved',
    output: outputPath(out),
    block: snapshot.payload.block,
    firstKnownAtMs: snapshot.payload.firstKnownAtMs,
    sha256: snapshot.sha256,
  }
}

async function defaultFetchPage(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
    headers: { accept: 'application/json' },
  })
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > 1_000_000) throw new Error('Oversize holder page')
  const bodyText = await response.text()
  if (bodyText.length > 1_000_000) throw new Error('Oversize holder page')
  return { status: response.status, url: response.url, body: JSON.parse(bodyText) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const outIndex = args.indexOf('--out')
  const out = outIndex >= 0 ? args[outIndex + 1] : undefined
  if (!args.includes('--run')) {
    process.stdout.write(`${JSON.stringify(plan(out))}\n`)
  } else {
    try {
      const result = await run({
        out,
        client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')),
      })
      process.stdout.write(`${JSON.stringify(result)}\n`)
    } catch {
      // RPC errors can include endpoint URLs; keep credentials out of stderr.
      process.stderr.write(
        'Exposure capture failed; check the explicit output path before retry.\n',
      )
      process.exitCode = 1
    }
  }
}
