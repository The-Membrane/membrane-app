// Exact-finalized-block deployed runtime witness for the known share vaults.
// Identity only: this does not prove source equivalence, additive accounting,
// holder completeness, borrowed-proceeds attribution, or route TVL.
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
  rmdirSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbiItem } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { IMPLEMENTATION_SLOT, UNDERLYING } from './share-current-holder-certificate.mjs'
import { checkDisk, selectRpcUrls, TOKENS } from './share-transfer-source.mjs'

export const MAX_RPC_CALLS = 20
export const MAX_RUNTIME_BYTES = 50_000
export const MAX_RESPONSE_BYTES = 120_000
export const MAX_RECEIPT_BYTES = 250_000
export const MAX_ELAPSED_MS = 120_000
const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const CODE = /^0x(?:[0-9a-f]{2})+$/
const FILE = /^identity-([a-f0-9]{64})\.json$/
const ZERO = `0x${'0'.repeat(40)}`
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const hex = (n) => `0x${BigInt(n).toString(16)}`
const lower = (value) => String(value).toLowerCase()
const fail = (code) => {
  throw new Error(`share_identity_${code}`)
}
const abi = {
  asset: parseAbiItem('function asset() view returns (address)'),
  totalSupply: parseAbiItem('function totalSupply() view returns (uint256)'),
}

function integer(value) {
  try {
    const n = Number(BigInt(value))
    if (Number.isSafeInteger(n) && n >= 0) return n
  } catch {
    /* invalid */
  }
  fail('integer_invalid')
}

function header(raw, block, hash) {
  const result = {
    number: integer(raw?.number),
    hash: lower(raw?.hash),
    parentHash: lower(raw?.parentHash),
    timestamp: integer(raw?.timestamp),
  }
  if (
    result.number !== block ||
    result.hash !== hash ||
    !HASH.test(result.parentHash) ||
    result.timestamp <= 0
  )
    fail('header_mismatch')
  return result
}

function code(raw) {
  const value = lower(raw)
  if (!CODE.test(value) || (value.length - 2) / 2 > MAX_RUNTIME_BYTES) fail('runtime_invalid')
  return value
}

function identity(reading) {
  if (!reading || typeof reading !== 'object') fail('receipt_invalid')
  const vaultCode = code(reading.vaultCode)
  const slot = lower(reading.implementationSlotRaw)
  if (!HASH.test(slot)) fail('slot_invalid')
  const implementation = `0x${slot.slice(-40)}`
  const implementationCode = implementation === ZERO ? null : code(reading.implementationCode)
  if (implementation === ZERO && reading.implementationCode !== null) fail('dispatch_invalid')
  if (!ADDRESS.test(lower(reading.asset))) fail('asset_invalid')
  let supply
  try {
    supply = BigInt(reading.totalSupplyRaw)
  } catch {
    fail('supply_invalid')
  }
  if (supply <= 0n || supply > (1n << 256n) - 1n || supply.toString() !== reading.totalSupplyRaw)
    fail('supply_invalid')
  return {
    vaultCode,
    vaultCodeKeccak256: keccak256(vaultCode),
    implementationSlotRaw: slot,
    implementation,
    implementationCode,
    implementationCodeKeccak256: implementationCode ? keccak256(implementationCode) : null,
    dispatch:
      implementation === ZERO ? 'unknown_zero_eip1967_slot' : 'eip1967_slot_nonzero_unattested',
    asset: lower(reading.asset),
    totalSupplyRaw: supply.toString(),
  }
}

function validateConfig({ token, block, blockHash, hosts }) {
  if (
    !Object.hasOwn(TOKENS, token) ||
    !Number.isSafeInteger(block) ||
    block < 1 ||
    !HASH.test(blockHash) ||
    !Array.isArray(hosts) ||
    hosts.length !== 2 ||
    hosts[0] === hosts[1] ||
    hosts.some(
      (host) => typeof host !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host),
    )
  )
    fail('config_invalid')
}

export async function capture({
  token,
  block,
  blockHash,
  hosts,
  rpcRead,
  peerRpcRead,
  now = () => Date.now(),
}) {
  validateConfig({ token, block, blockHash, hosts })
  if (typeof rpcRead !== 'function' || typeof peerRpcRead !== 'function') fail('config_invalid')
  const started = now()
  let calls = 0
  const read = async (reader, side, stage, method, params) => {
    if (++calls > MAX_RPC_CALLS || now() - started >= MAX_ELAPSED_MS) fail('budget_exceeded')
    let timer
    try {
      const raw = await Promise.race([
        reader(method, params),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), 20_000)
        }),
      ])
      if (Buffer.byteLength(JSON.stringify(raw)) > MAX_RESPONSE_BYTES) fail('response_size_cap')
      return raw
    } catch (error) {
      if (String(error?.message).startsWith('share_identity_response_size_cap')) throw error
      fail(`rpc_${side}_${stage}_failed`)
    } finally {
      clearTimeout(timer)
    }
  }
  const pin = { blockHash, requireCanonical: true }
  const one = async (reader, side) => {
    if (integer(await read(reader, side, 'chain', 'eth_chainId', [])) !== 1)
      fail(`${side}_chain_mismatch`)
    const head = await read(reader, side, 'finalized', 'eth_getBlockByNumber', ['finalized', false])
    const finalized = integer(head?.number)
    if (!HASH.test(lower(head?.hash)) || finalized < block) fail(`${side}_not_finalized`)
    const at = header(
      await read(reader, side, 'header', 'eth_getBlockByNumber', [hex(block), false]),
      block,
      blockHash,
    )
    const vaultCode = await read(reader, side, 'code', 'eth_getCode', [TOKENS[token], pin])
    const implementationSlotRaw = await read(reader, side, 'slot', 'eth_getStorageAt', [
      TOKENS[token],
      IMPLEMENTATION_SLOT,
      pin,
    ])
    if (!HASH.test(lower(implementationSlotRaw))) fail(`${side}_slot_invalid`)
    const implementation = `0x${lower(implementationSlotRaw).slice(-40)}`
    const implementationCode =
      implementation === ZERO
        ? null
        : await read(reader, side, 'implementation', 'eth_getCode', [implementation, pin])
    const call = async (key) => {
      const data = encodeFunctionData({ abi: [abi[key]], functionName: key })
      const raw = await read(reader, side, key, 'eth_call', [{ to: TOKENS[token], data }, pin])
      try {
        return decodeFunctionResult({ abi: [abi[key]], functionName: key, data: raw })
      } catch {
        fail(`${side}_${key}_decode_invalid`)
      }
    }
    const reading = identity({
      vaultCode,
      implementationSlotRaw,
      implementationCode,
      asset: await call('asset'),
      totalSupplyRaw: (await call('totalSupply')).toString(),
    })
    if (reading.asset !== UNDERLYING[token]) fail(`${side}_asset_mismatch`)
    const after = header(
      await read(reader, side, 'recheck', 'eth_getBlockByNumber', [hex(block), false]),
      block,
      blockHash,
    )
    if (JSON.stringify(at) !== JSON.stringify(after)) fail(`${side}_header_changed`)
    return { finalizedHead: finalized, header: at, ...reading }
  }
  const primary = await one(rpcRead, 'primary')
  const peer = await one(peerRpcRead, 'peer')
  if (JSON.stringify(primary.header) !== JSON.stringify(peer.header))
    fail('host_header_disagreement')
  const { finalizedHead: primaryHead, ...primaryComparable } = primary
  const { finalizedHead: peerHead, ...peerComparable } = peer
  if (JSON.stringify(primaryComparable) !== JSON.stringify(peerComparable))
    fail('host_identity_disagreement')
  return {
    schema: 1,
    kind: 'share_runtime_identity_only',
    config: { chainId: 1, token, vault: TOKENS[token], block, blockHash, hosts },
    capturedAt: new Date(now()).toISOString(),
    calls,
    agreement: 'two_hosts_same_exact_block_and_identity',
    primary: { finalizedHead: primaryHead, ...primaryComparable },
    peer: { finalizedHead: peerHead, ...peerComparable },
    limits: {
      maxRpcCalls: MAX_RPC_CALLS,
      maxRuntimeBytes: MAX_RUNTIME_BYTES,
      maxElapsedMs: MAX_ELAPSED_MS,
    },
  }
}

export function verifyRecord(record) {
  if (record?.schema !== 1 || record.kind !== 'share_runtime_identity_only') fail('receipt_invalid')
  validateConfig({
    token: record.config?.token,
    block: record.config?.block,
    blockHash: record.config?.blockHash,
    hosts: record.config?.hosts,
  })
  if (record.config.chainId !== 1 || record.config.vault !== TOKENS[record.config.token])
    fail('receipt_invalid')
  if (
    !Number.isFinite(Date.parse(record.capturedAt)) ||
    !Number.isInteger(record.calls) ||
    record.calls < 1 ||
    record.calls > MAX_RPC_CALLS
  )
    fail('receipt_invalid')
  if (record.agreement !== 'two_hosts_same_exact_block_and_identity') fail('receipt_invalid')
  const parsed = []
  for (const side of ['primary', 'peer']) {
    const row = record[side]
    if (!Number.isSafeInteger(row?.finalizedHead) || row.finalizedHead < record.config.block)
      fail('receipt_invalid')
    const h = header(row.header, record.config.block, record.config.blockHash)
    const rebuilt = identity(row)
    if (
      rebuilt.asset !== UNDERLYING[record.config.token] ||
      JSON.stringify(rebuilt) !==
        JSON.stringify({
          vaultCode: row.vaultCode,
          vaultCodeKeccak256: row.vaultCodeKeccak256,
          implementationSlotRaw: row.implementationSlotRaw,
          implementation: row.implementation,
          implementationCode: row.implementationCode,
          implementationCodeKeccak256: row.implementationCodeKeccak256,
          dispatch: row.dispatch,
          asset: row.asset,
          totalSupplyRaw: row.totalSupplyRaw,
        })
    )
      fail('identity_replay_mismatch')
    parsed.push({ header: h, ...rebuilt })
  }
  if (JSON.stringify(parsed[0]) !== JSON.stringify(parsed[1])) fail('host_identity_disagreement')
  return {
    token: record.config.token,
    block: record.config.block,
    blockHash: record.config.blockHash,
    dispatch: parsed[0].dispatch,
  }
}

export function seal(out, record, stat = statfsSync, link = linkSync) {
  verifyRecord(record)
  const bytes = Buffer.from(JSON.stringify(record))
  if (bytes.length > MAX_RECEIPT_BYTES) fail('receipt_size_cap')
  if (existsSync(out)) fail('output_exists')
  checkDisk(out, stat, bytes.length)
  // The exact new directory is an exclusive reservation. No existing saved data is touched.
  try {
    mkdirSync(out, { recursive: false, mode: 0o700 })
  } catch {
    fail('output_unavailable')
  }
  const name = `identity-${sha(bytes)}.json`
  const path = join(out, name)
  const temp = `${path}.${randomUUID()}.tmp`
  let fd
  let failed = false
  try {
    fd = openSync(temp, 'wx', 0o600)
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    link(temp, path)
  } catch {
    failed = true
    fail('seal_failed')
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        failed = true
      }
    }
    if (existsSync(temp)) {
      try {
        unlinkSync(temp)
      } catch {
        failed = true
      }
    }
    // Only undo our own reservation if there is provably no artifact in it.
    if (failed && existsSync(out)) {
      try {
        if (readdirSync(out).length === 0) rmdirSync(out)
      } catch {
        // An uncertain or nonempty output is deliberately left in place.
      }
    }
  }
  return { name, sha256: sha(bytes) }
}

export function verify(out) {
  const names = readdirSync(out)
  if (names.length !== 1 || !FILE.test(names[0])) fail('output_invalid')
  if (statSync(join(out, names[0])).size > MAX_RECEIPT_BYTES) fail('receipt_size_cap')
  const bytes = readFileSync(join(out, names[0]))
  if (bytes.length > MAX_RECEIPT_BYTES || sha(bytes) !== FILE.exec(names[0])[1])
    fail('receipt_hash_mismatch')
  let record
  try {
    record = JSON.parse(bytes)
  } catch {
    fail('receipt_json_invalid')
  }
  return { ...verifyRecord(record), name: names[0], sha256: sha(bytes) }
}

function options(argv) {
  const result = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (['--run', '--verify'].includes(key)) {
      if (result[key]) fail('cli_invalid')
      result[key] = true
    } else if (['--token', '--block', '--hash', '--rpc-hosts', '--out'].includes(key)) {
      if (result[key] !== undefined || !argv[i + 1]) fail('cli_invalid')
      result[key] = argv[++i]
    } else fail('cli_invalid')
  }
  if (!result['--out'] || (result['--run'] && result['--verify'])) fail('cli_invalid')
  if (
    result['--verify'] &&
    ['--token', '--block', '--hash', '--rpc-hosts'].some((key) => result[key] !== undefined)
  )
    fail('cli_invalid')
  return result
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const opts = options(argv)
  if (opts['--verify']) return verify(opts['--out'])
  const token = opts['--token']
  const block = integer(opts['--block'])
  const blockHash = lower(opts['--hash'])
  const hosts = String(opts['--rpc-hosts'] ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
  validateConfig({ token, block, blockHash, hosts })
  if (existsSync(opts['--out'])) fail('output_exists')
  checkDisk(opts['--out'], dependencies.stat ?? statfsSync)
  if (!opts['--run']) return { dryRun: true, token, block, blockHash, hosts, out: opts['--out'] }
  let readers = [dependencies.rpcRead, dependencies.peerRpcRead]
  if (readers.some((reader) => typeof reader !== 'function')) {
    const env = dependencies.env ?? readEnv()
    const raw =
      dependencies.rpcUrls ??
      process.env.RECORDER_RPC_URLS ??
      env.get('RECORDER_RPC_URLS') ??
      process.env.RECORDER_RPC_URL ??
      env.get('RECORDER_RPC_URL')
    let urls
    try {
      urls = selectRpcUrls(raw, hosts.join(','))
    } catch {
      fail('rpc_config_invalid')
    }
    const factory = dependencies.makeClient ?? makeClient
    readers = urls.map((url) => {
      try {
        const client = factory(url)
        return (method, params) => client.request({ method, params })
      } catch {
        fail('rpc_config_invalid')
      }
    })
  }
  const record = await capture({
    token,
    block,
    blockHash,
    hosts,
    rpcRead: readers[0],
    peerRpcRead: readers[1],
    now: dependencies.now,
  })
  return {
    ...seal(opts['--out'], record, dependencies.stat ?? statfsSync),
    ...verify(opts['--out']),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(
        `${String(error?.message).startsWith('share_identity_') ? error.message : 'share_identity_failure'}\n`,
      )
      process.exitCode = 1
    },
  )
}
