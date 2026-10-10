// Fixed-anchor, independent $50m Pool.withdraw simulations for the sealed
// first-page holder sample. This is neither a cumulative bank run nor a forecast.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { encodeFunctionData, keccak256 } from 'viem'
import { MARKETS, POOL, diskGuard } from './aave-core-forward-panel.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'aave-core-holder-shock-v1'
export const SOURCE = resolve('data/research/venue-signals/aave-core-holder-exposure-pilot-v1.json')
export const SOURCE_SHA256 = '0e2814215115e5186f51df653939f3f6d2e36c311c1ea677181ecadefb4b8c7b'
export const SOURCE_BLOCK = 26_059_451
export const OUTPUT_ROOT = resolve('data/research/venue-signals')
export const SHOCK_RAW = 50_000_000n * 10n ** 6n
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const WITHDRAW = [
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
]
const lower = (value) => String(value || '').toLowerCase()
const sha = (value) => createHash('sha256').update(value).digest('hex')
const digest = (value) => sha(JSON.stringify(value))
const isHash = (value) => /^0x[0-9a-fA-F]{64}$/.test(String(value))
const isAddress = (value) => /^0x[0-9a-fA-F]{40}$/.test(String(value))
const pinned = (blockHash) => ({ blockHash, requireCanonical: true })
const defaultIo = {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
}

export function outputPath(path) {
  if (!path) throw new Error('Explicit --out required with --run')
  const target = resolve(path)
  if (!target.startsWith(`${OUTPUT_ROOT}/`) || !target.endsWith('.json') || target === SOURCE)
    throw new Error('Unique JSON output required under data/research/venue-signals')
  return target
}

export function frozenSample(saved) {
  if (!saved?.payload || saved.sha256 !== digest(saved.payload))
    throw new Error('Exposure payload seal mismatch')
  const data = saved.payload
  if (
    data.study !== 'aave-core-holder-exposure-v1' ||
    data.chainId !== 1 ||
    lower(data.pool) !== lower(POOL) ||
    data.block !== SOURCE_BLOCK ||
    !isHash(data.blockHash) ||
    !isHash(data.poolCodeHash) ||
    !isAddress(data.poolImplementation) ||
    !isHash(data.poolImplementationCodeHash) ||
    !Array.isArray(data.markets) ||
    data.markets.length !== MARKETS.length
  )
    throw new Error('Exposure anchor identity mismatch')
  const rows = data.markets.map((row, index) => {
    const market = MARKETS[index]
    if (
      row.name !== market.name ||
      lower(row.base) !== lower(market.base) ||
      lower(row.aToken) !== lower(market.aToken) ||
      row.decimals !== market.decimals ||
      !isHash(row.aTokenCodeHash) ||
      !isAddress(row.aTokenImplementation) ||
      !isHash(row.aTokenImplementationCodeHash) ||
      !Array.isArray(row.holders) ||
      row.holders.length !== 50
    )
      throw new Error('Exposure market identity mismatch')
    const seen = new Set()
    const holders = row.holders
      .filter((holder) => {
        if (
          !isAddress(holder.address) ||
          seen.has(lower(holder.address)) ||
          !/^[0-9]+$/.test(String(holder.balanceRaw)) ||
          !['no-code', 'contract'].includes(holder.codeKind)
        )
          throw new Error('Malformed or duplicate exposure holder')
        seen.add(lower(holder.address))
        return holder.codeKind === 'no-code' && BigInt(holder.balanceRaw) >= SHOCK_RAW
      })
      .map((holder) => ({ address: lower(holder.address), balanceRaw: holder.balanceRaw }))
    if (holders.length !== [4, 6][index]) throw new Error('Frozen holder count changed')
    return {
      name: market.name,
      base: lower(row.base),
      aToken: lower(row.aToken),
      aTokenCodeHash: lower(row.aTokenCodeHash),
      aTokenImplementation: lower(row.aTokenImplementation),
      aTokenImplementationCodeHash: lower(row.aTokenImplementationCodeHash),
      holders,
    }
  })
  return {
    sourcePayloadSha256: saved.sha256,
    block: data.block,
    blockHash: lower(data.blockHash),
    poolCodeHash: lower(data.poolCodeHash),
    poolImplementation: lower(data.poolImplementation),
    poolImplementationCodeHash: lower(data.poolImplementationCodeHash),
    rows,
  }
}

export function readSource(path = SOURCE) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== SOURCE_SHA256) throw new Error('Exposure physical SHA mismatch')
  return frozenSample(JSON.parse(bytes.toString('utf8')))
}

function codeHash(code, label) {
  if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code))
    throw new Error(`Missing ${label} code`)
  return lower(keccak256(code))
}

async function verifyProxy(
  rpc,
  contract,
  expectedCodeHash,
  expectedImplementation,
  expectedImplementationCodeHash,
  blockHash,
) {
  const block = pinned(blockHash)
  const runtime = await rpc('eth_getCode', [contract, block])
  if (codeHash(runtime, 'proxy') !== expectedCodeHash) throw new Error('Proxy code changed')
  const word = await rpc('eth_getStorageAt', [contract, SLOT, block])
  if (typeof word !== 'string' || !/^0x0{24}[0-9a-fA-F]{40}$/.test(word))
    throw new Error('Invalid implementation slot')
  const implementation = lower(`0x${word.slice(26)}`)
  if (implementation !== expectedImplementation) throw new Error('Proxy implementation changed')
  const code = await rpc('eth_getCode', [implementation, block])
  if (codeHash(code, 'implementation') !== expectedImplementationCodeHash)
    throw new Error('Implementation code changed')
}

function revertBytes(error) {
  const seen = new Set()
  let current = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const candidate = typeof current.data === 'string' ? current.data : current.data?.data
    if (typeof candidate === 'string' && /^0x(?:[0-9a-fA-F]{2}){4,2048}$/.test(candidate)) {
      const data = lower(candidate)
      return { data, selector: data.slice(0, 10) }
    }
    current = current.cause
  }
  return { data: null, selector: null }
}

function isRevert(error) {
  const seen = new Set()
  let current = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    if (
      ['ExecutionRevertedError', 'ContractFunctionRevertedError', 'RawContractError'].includes(
        current.name,
      )
    )
      return true
    if (current.code === 3 || current.code === '3') return true
    current = current.cause
  }
  return false
}

export async function collect({
  client,
  out,
  checkDisk = diskGuard,
  now = Date.now,
  source = readSource,
}) {
  const target = outputPath(out)
  if (existsSync(target)) throw new Error('Refusing to overwrite shock output')
  checkDisk(target)
  const baseline = source()
  const rpc = async (method, params) => {
    checkDisk(target)
    return client.request({ method, params })
  }
  checkDisk(target)
  if (Number(await client.getChainId()) !== 1) throw new Error('Ethereum mainnet required')
  checkDisk(target)
  const block = await client.getBlock({ blockNumber: BigInt(baseline.block) })
  if (lower(block?.hash) !== baseline.blockHash) throw new Error('Anchor block hash mismatch')
  await verifyProxy(
    rpc,
    POOL,
    baseline.poolCodeHash,
    baseline.poolImplementation,
    baseline.poolImplementationCodeHash,
    baseline.blockHash,
  )
  for (const row of baseline.rows)
    await verifyProxy(
      rpc,
      row.aToken,
      row.aTokenCodeHash,
      row.aTokenImplementation,
      row.aTokenImplementationCodeHash,
      baseline.blockHash,
    )
  const markets = []
  for (const row of baseline.rows) {
    const holders = []
    for (const holder of row.holders) {
      const tx = {
        from: holder.address,
        to: POOL,
        data: encodeFunctionData({
          abi: WITHDRAW,
          functionName: 'withdraw',
          args: [row.base, SHOCK_RAW, holder.address],
        }),
      }
      let call = 'rpc-error',
        returnedRaw = null,
        revertData = null,
        revertSelector = null
      try {
        const result = await rpc('eth_call', [tx, pinned(baseline.blockHash)])
        if (typeof result === 'string' && /^0x[0-9a-fA-F]{64}$/.test(result)) {
          returnedRaw = BigInt(result).toString()
          call = BigInt(result) === SHOCK_RAW ? 'success' : 'unexpected-return'
        } else call = 'malformed-return'
      } catch (error) {
        // The disk floor is fatal, even when a provider call also fails.
        checkDisk(target)
        if (isRevert(error)) {
          call = 'revert'
          const bytes = revertBytes(error)
          revertData = bytes.data
          revertSelector = bytes.selector
        }
      }
      holders.push({
        address: holder.address,
        balanceRaw: holder.balanceRaw,
        call,
        returnedRaw,
        revertData,
        revertSelector,
      })
    }
    markets.push({ name: row.name, base: row.base, aToken: row.aToken, holders })
  }
  const observedAtMs = now()
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs <= 0)
    throw new Error('Invalid local observation clock')
  const payload = {
    study: STUDY,
    chainId: 1,
    sourceSha256: SOURCE_SHA256,
    sourcePayloadSha256: baseline.sourcePayloadSha256,
    pool: POOL,
    block: baseline.block,
    blockHash: baseline.blockHash,
    observedAtMs,
    shockRaw: SHOCK_RAW.toString(),
    markets,
    caveat:
      'Independent same-anchor eth_call simulations, one fixed $50m Pool.withdraw per frozen no-code sampled holder. Not cumulative withdrawals, intent, live liquidity, cause attribution, prediction, or an alert. RPC errors and malformed returns are unresolved.',
  }
  return { payload, sha256: digest(payload) }
}

export function save(out, snapshot, checkDisk = diskGuard, io = defaultIo) {
  const target = outputPath(out)
  checkDisk(target)
  if (io.existsSync(target)) throw new Error('Refusing to overwrite shock output')
  io.mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
  let fd
  let published = false
  try {
    fd = io.openSync(temp, 'wx', 0o600)
    io.writeFileSync(fd, JSON.stringify(snapshot))
    io.closeSync(fd)
    fd = undefined
    checkDisk(target)
    // No-clobber publication: a racing writer's target can never be replaced.
    io.linkSync(temp, target)
    published = true
    const saved = JSON.parse(io.readFileSync(target, 'utf8'))
    if (
      !saved.payload ||
      saved.sha256 !== digest(saved.payload) ||
      saved.sha256 !== snapshot.sha256
    )
      throw new Error('Saved shock seal mismatch')
  } catch (error) {
    if (fd !== undefined) io.closeSync(fd)
    if (published) io.unlinkSync(target)
    throw error
  } finally {
    if (io.existsSync(temp)) io.unlinkSync(temp)
  }
}

export function plan(out) {
  return {
    status: 'dry-only',
    study: STUDY,
    source: SOURCE,
    output: out ? outputPath(out) : null,
    action:
      'Pass --run --out data/research/venue-signals/<unique>.json for ten independent same-anchor calls.',
  }
}

export async function run({ out, client, checkDisk = diskGuard, now = Date.now }) {
  const snapshot = await collect({ out, client, checkDisk, now })
  save(out, snapshot, checkDisk)
  return {
    status: 'saved',
    output: outputPath(out),
    block: snapshot.payload.block,
    sha256: snapshot.sha256,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const outIndex = args.indexOf('--out')
  const out = outIndex >= 0 ? args[outIndex + 1] : undefined
  if (!args.includes('--run')) process.stdout.write(`${JSON.stringify(plan(out))}\n`)
  else {
    try {
      const result = await run({
        out,
        client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')),
      })
      process.stdout.write(`${JSON.stringify(result)}\n`)
    } catch {
      // Provider errors can contain credentials. Never print their messages.
      process.stderr.write('Shock simulation failed; no final output saved.\n')
      process.exitCode = 1
    }
  }
}
